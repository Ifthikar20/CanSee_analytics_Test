"""Deferred fixes applied at the merge gate: writer availability on
status/, the run_agent and research wording, the fallback chat title, the
agent_call base_version, a stream that ends when its run's row ended
without a terminal event, Stop reaching in-flight crawls, public engine
errors for answers that are not measurements, and the nginx connection
cap on the agent routes."""
import asyncio
import json
import re
from types import SimpleNamespace

import pytest
from django.conf import settings as django_settings

from apps.agent.api.v1 import stream as stream_module
from apps.agent.models import AgentArtifact, AgentChat, AgentMessage, AgentRun
from apps.agent.prompts import orchestrator
from apps.agent.runtime.emitter import RunEmitter
from apps.agent.runtime.events import get_event_store
from apps.agent.runtime.title import fallback_title
from apps.agent.services.catalog import status_for, writers
from apps.agent.subagents.base import MIN_WRITER_TOKENS, OUTPUT_PRICE_PER_TOKEN
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import event_types, make_prompt, run_events, send
from apps.agent.tools import research
from apps.agent.tools.context import ToolContext
from apps.agent.tools.schemas import DEFINITIONS, CheckAiEnginesInput

PAGE = ("<!DOCTYPE html><html lang=\"en\"><head><title>CRM</title></head><body>"
        "<h1>CRM for dentists</h1><section><h2>FAQ</h2></section></body></html>")


@pytest.fixture
def allowance(monkeypatch):
    """A $1 monthly cap with a settable month-to-date spend."""
    state = {"cap": 1.0, "spent": 0.0}
    monkeypatch.setattr("core.ai_tracking.effective_ai_cap", lambda user: state["cap"])
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda user: state["spent"])
    return state


def _frames(body: str) -> list[dict]:
    out = []
    for block in body.split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.split("\n")
                      if line and not line.startswith(":") and ": " in line)
        if "data" in fields:
            out.append({**fields, "data": json.loads(fields["data"])})
    return out


# ── status/: which writers the allowance can start (fe-be-contract-1) ────


@pytest.mark.django_db
def test_status_says_which_writers_the_allowance_can_start(user, allowance):
    # The least a writer needs (16,000 tokens, or its own smaller limit) and
    # the most one new draft's writer request costs (wave 2, contract 12b).
    limits = {"landing_page": (64000, "1.41"), "aeo_article": (32000, "0.77"),
              "ad_campaign": (16000, "0.45"), "page_optimizer": (24000, "0.61"),
              "llms_txt": (8000, "0.29"), "comparison_page": (24000, "0.61"),
              "social_posts": (8000, "0.29"), "pr_writer": (16000, "0.45"),
              "messaging_brief": (16000, "0.45")}
    assert writers(user) == {
        key: {"available": True,
              "needs_usd": float(OUTPUT_PRICE_PER_TOKEN * min(limit, MIN_WRITER_TOKENS)),
              "max_usd": most}
        for key, (limit, most) in limits.items()
    }
    assert status_for(user)["writers"] == writers(user)

    # $0.10 left pays for 5,000 output tokens, below the writers' minimum.
    allowance["spent"] = 0.9
    assert {k: v["available"] for k, v in writers(user).items()} == dict.fromkeys(limits, False)

    # No cap: every writer can start.
    allowance["cap"] = 0.0
    assert all(v["available"] for v in writers(user).values())


# ── What the model is told (be-honesty-7, requirements-1, be-honesty-9) ──


def test_run_agent_asks_for_facts_from_tools_or_the_user_only():
    schema = DEFINITIONS["run_agent"]["input_schema"]["properties"]
    assert "never from your own knowledge" in schema["facts"]["description"]
    assert "get_brand_context" in schema["facts"]["description"]
    assert "each from a tool result in this chat or the user's words" in (
        schema["brief"]["description"])


def test_the_research_workflow_matches_the_tools():
    prompt = orchestrator.SYSTEM_PROMPT
    assert "google_search once per prompt with its prompt_id and pages=2" in prompt
    assert "rank_note" in prompt and "pages_left_today" in prompt
    assert "never guess or build a URL" in prompt
    assert "it refuses prompts the user has not seen in this chat" in prompt
    assert "It asks every configured AI engine" not in prompt
    assert 'report them as "not selected", never "not named"' in prompt
    assert '"not selected" or "not measured"' in prompt


# ── The first turn sends the fallback title (fe-be-contract-9) ────────────


@pytest.mark.django_db
@pytest.mark.usefixtures("no_title")
def test_the_first_turn_sends_the_title_the_chat_already_has(fake_anthropic, chat):
    question = "How does Northwind rank on Google and in AI answers for best crm for startups"
    fake_anthropic.queue(message(text("Here is how.")), message(text("And for dentists.")))

    first = send(chat, question)
    events = run_events(first.run)
    assert [e["type"] for e in events[:2]] == ["run.started", "chat.updated"]
    assert (events[1]["chat_id"], events[1]["title"]) == (str(chat.id), fallback_title(question))
    assert AgentChat.objects.get(id=chat.id).title == fallback_title(question)

    # A follow-up turn has nothing new to say about the title.
    second = send(chat, "And for best crm for dentists?")
    assert "chat.updated" not in event_types(second.run)


@pytest.mark.django_db
@pytest.mark.usefixtures("no_title")
def test_a_title_the_user_set_is_not_sent_again(fake_anthropic, chat):
    AgentChat.objects.filter(id=chat.id).update(title="My research", title_source="user")
    fake_anthropic.queue(message(text("Hello.")))
    started = send(chat, "Hi")
    assert "chat.updated" not in event_types(started.run)


# ── agent_call carries base_version (fe-be-contract-4) ────────────────────


@pytest.mark.django_db
@pytest.mark.usefixtures("no_title")
def test_agent_call_part_says_whether_the_artifact_was_saved_before(fake_anthropic, chat,
                                                                   allowance):
    def run_agent(args, id):
        return message(text("Starting the writer."), tool_use("run_agent", args, id=id),
                       stop_reason="tool_use")

    args = {"agent": "landing_page", "title": "CRM page", "brief": "For dental practices."}
    fake_anthropic.queue(run_agent(args, "toolu_1"), message(text(PAGE)), message(text("Saved.")))
    first = send(chat, "Draft a landing page for best crm for dentists")
    artifact = AgentArtifact.objects.get()
    call = next(p for p in AgentMessage.objects.get(id=first.assistant_message.id).parts
                if p["type"] == "agent_call")
    assert (call["base_version"], call["version"]) == (0, 1)

    fake_anthropic.queue(run_agent({**args, "artifact_id": str(artifact.id)}, "toolu_2"),
                         message(text(PAGE.replace("dentists", "clinics"))),
                         message(text("Updated.")))
    second = send(chat, "Make it about clinics")
    call = next(p for p in AgentMessage.objects.get(id=second.assistant_message.id).parts
                if p["type"] == "agent_call")
    assert (call["base_version"], call["version"]) == (1, 2)


# ── A stream ends when the run's row ended without its terminal event ─────
#    (be-runtime-3)


def _ended_without_event(chat, status="interrupted"):
    question = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    reply = AgentMessage.objects.create(chat=chat, parent=question, role="assistant",
                                        status="streaming")
    run = AgentRun.objects.create(chat=chat, user=chat.user, website=chat.website,
                                  user_message=question, assistant_message=reply,
                                  status=status)
    rid = str(run.id)
    store = get_event_store()
    store.open(rid)
    store.append(rid, {"type": "run.started", "run_id": rid})
    return store, rid


@pytest.mark.django_db
def test_a_stream_ends_when_its_run_ended_without_a_terminal_event(chat, monkeypatch):
    monkeypatch.setattr(stream_module, "PING_SECONDS", 0.05)
    monkeypatch.setattr(stream_module, "SETTLE_GRACE_SECONDS", 0.05)
    store, rid = _ended_without_event(chat)

    frames = _frames("".join(stream_module.sync_events(store, rid, "m", 1, max_seconds=30)))

    assert [(f["event"], f["data"]["reason"]) for f in frames] == [("resync", "run_ended")]


@pytest.mark.django_db
def test_a_stream_of_an_active_run_keeps_pinging(chat, monkeypatch):
    monkeypatch.setattr(stream_module, "PING_SECONDS", 0.05)
    store, rid = _ended_without_event(chat, status="running")

    body = "".join(stream_module.sync_events(store, rid, "m", 1, max_seconds=0.3))

    assert ": ping\n\n" in body and body.endswith("event: reconnect\ndata: {}\n\n")


@pytest.mark.django_db
def test_the_async_stream_ends_the_same_way(chat, monkeypatch):
    monkeypatch.setattr(stream_module, "PING_SECONDS", 0.05)
    monkeypatch.setattr(stream_module, "SETTLE_GRACE_SECONDS", 0.05)
    # The check reads the row in a worker thread, outside this test's
    # transaction; what it would read is stood in for here.
    monkeypatch.setattr(stream_module, "run_settled", lambda run_id: True)
    store, rid = _ended_without_event(chat)

    async def collect():
        return "".join([c async for c in stream_module.async_events(store, rid, "m", 1,
                                                                     max_seconds=30)])

    frames = _frames(asyncio.run(collect()))
    assert [(f["event"], f["data"]["reason"]) for f in frames] == [("resync", "run_ended")]


@pytest.mark.django_db
def test_run_settled_reads_the_row(chat):
    _, rid = _ended_without_event(chat, status="completed")
    assert stream_module.run_settled(rid) is True
    AgentRun.objects.filter(id=rid).update(status="running")
    assert stream_module.run_settled(rid) is False


# ── Stop reaches crawls already running (requirements-8) ──────────────────


class _Provider:
    model = "fake-model"


@pytest.fixture
def crawler(monkeypatch):
    """crawl_prompt with two configured engines, each answer a transient
    failure (no extraction call), recording which engines were asked."""
    from apps.prompt_library.services import prompt_crawler

    asked = []
    monkeypatch.setattr(prompt_crawler, "_llm_fanout", lambda *a, **k: [])
    monkeypatch.setattr(prompt_crawler, "list_model_variants", lambda: [
        {"provider": "claude", "configured": True},
        {"provider": "perplexity", "configured": True},
    ])
    monkeypatch.setattr(prompt_crawler, "PROVIDERS", {"claude": _Provider,
                                                      "perplexity": _Provider})

    def query(instance, prompt_text, **kwargs):
        asked.append(prompt_text)
        return SimpleNamespace(succeeded=False, text="", error="busy", citations=None)

    monkeypatch.setattr(prompt_crawler, "_query_with_retry", query)
    return SimpleNamespace(module=prompt_crawler, asked=asked)


@pytest.mark.django_db
def test_a_crawl_asks_no_further_engine_once_stopped(crawler, website):
    from apps.llm_ranking.models import LLMRankingResult
    from apps.prompt_library.models import PromptCrawlRun

    bp = make_prompt(website, "best crm for startups")
    outcome = crawler.module.crawl_prompt(website, bp.prompt,
                                          should_stop=lambda: len(crawler.asked) >= 1)

    assert len(crawler.asked) == 1 and outcome.stopped is True
    assert LLMRankingResult.objects.filter(source_prompt=bp.prompt).count() == 1
    run = PromptCrawlRun.objects.get(prompt=bp.prompt)
    assert run.error.endswith("stopped before every model was asked")

    crawler.asked.clear()
    stopped = crawler.module.crawl_prompt(website, bp.prompt, should_stop=lambda: True)
    assert crawler.asked == [] and stopped.stopped is True and stopped.responses == 0

    crawler.asked.clear()
    full = crawler.module.crawl_prompt(website, bp.prompt)
    assert len(crawler.asked) == 2 and full.stopped is False


@pytest.mark.django_db
def test_engines_a_stopped_crawl_did_not_ask_are_reported_stopped(chat, website, monkeypatch,
                                                                  settings):
    from apps.prompt_library.services.prompt_crawler import CrawlOutcome

    settings.ANTHROPIC_API_KEY = "test-key"
    settings.PERPLEXITY_API_KEY = "pplx-test"
    settings.OPENAI_API_KEY = ""
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    bp = make_prompt(website, "best crm for startups")
    active = SimpleNamespace(cancelled=False)
    seen = {}

    def crawl(website, prompt, *, only_missing=False, acting_user=None, should_stop=None):
        active.cancelled = True  # Stop while the crawl runs.
        seen["should_stop"] = should_stop()
        return CrawlOutcome(fanouts=[], responses=0, errors=[], stopped=True)

    monkeypatch.setattr("apps.prompt_library.services.prompt_crawler.crawl_prompt", crawl)
    question = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    reply = AgentMessage.objects.create(chat=chat, parent=question, role="assistant",
                                        status="streaming", depth=1)
    run = AgentRun.objects.create(chat=chat, user=chat.user, website=website,
                                  user_message=question, assistant_message=reply,
                                  status="running")
    emitter = RunEmitter(run, reply)
    ctx = ToolContext(run=run, chat=chat, website=website, user=chat.user, emitter=emitter,
                      active=active, request=1, inline=True)

    result = research.check_ai_engines(ctx, CheckAiEnginesInput(prompt_ids=[bp.prompt_id]))

    assert seen["should_stop"] is True
    checks = {p["engine"]: p for p in emitter.parts() if p["type"] == "engine_check"}
    assert {checks[k]["error"] for k in ("claude", "perplexity")} == {"Stopped"}
    engines = json.loads(result.content)["prompts"][0]["engines"]
    assert engines["claude"]["error"] == "Stopped"


# ── Answers that are not measurements, in public words (be-claude-api-3) ──


@pytest.mark.parametrize("raw, public", [
    (" refusal: Claude declined to answer", "The engine declined to answer this prompt."),
    ("max_tokens: the answer was cut off at the 4096-token limit",
     "The engine's answer was cut off before it finished."),
    (" pause_turn: the web search paused the turn before an answer was written",
     "The engine's answer was cut off before it finished."),
    ("empty_answer: Claude returned no answer text", "The engine returned no answer."),
])
def test_engine_answers_that_are_not_measurements_are_named(raw, public):
    assert research.public_engine_error(raw) == public
    outcome = SimpleNamespace(errors=[f"claude:{raw}"])
    by_provider, other = research._engine_errors(outcome, {"claude", "perplexity"})
    assert by_provider == {"claude": public} and other is None


# ── nginx: connections per client on the agent routes (be-security-6) ────


def _conf(name):
    return (django_settings.BASE_DIR / "docker" / "nginx" / name).read_text(encoding="utf-8")


def _block(text, start):
    depth = 0
    for i in range(text.index("{", start), len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise AssertionError("unbalanced block")


@pytest.mark.parametrize("name", ["nginx.prod.conf", "nginx.http.conf"])
def test_the_agent_routes_cap_connections_per_client(name):
    text = _conf(name)
    # Behind Cloudflare the client is CF-Connecting-IP, not the edge address.
    agent_client = _block(text, text.index("map $http_cf_connecting_ip $agent_client"))
    assert '""      $binary_remote_addr;' in agent_client
    assert "default $http_cf_connecting_ip;" in agent_client
    assert "limit_conn_zone $agent_client zone=agent_live:10m;" in text

    live = _block(text, text.index("location ^~ /api/v1/agent/live/"))
    assert "limit_conn agent_live 20;" in live
    # Not the default 503, which this location answers as maintenance.
    assert "limit_conn_status 429;" in live and "error_page 429 = @agent_busy;" in live

    busy = _block(text, text.index("location @agent_busy"))
    assert "default_type application/json;" in busy
    body = json.loads(re.search(r"return 429 '(.+)';", busy).group(1))
    assert body["success"] is False and body["error"]["code"] == "too_many_streams"
