"""check_ai_engines: engines outside a prompt's model selection are "not
selected", not failed; crawl errors reach the chat in public words only;
Stop ends the check without waiting for crawls already running."""
import json
import threading
import time
from types import SimpleNamespace

import pytest

from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime.emitter import RunEmitter
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, send, tool_results_of
from apps.agent.tools import research
from apps.agent.tools.context import ToolContext, ToolError
from apps.agent.tools.schemas import CheckAiEnginesInput

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title", "engines")]

LEAKY = ("Error code: 401 - {'error': {'message': 'Incorrect API key provided: "
         "sk-ant-api03-SECRETKEY. See https://console.anthropic.com/settings/keys'}}")


@pytest.fixture
def engines(settings):
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.PERPLEXITY_API_KEY = "pplx-test"
    settings.OPENAI_API_KEY = ""
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""


def _crawl(monkeypatch, rows, errors=()):
    """A crawl_prompt that stores these answers: {provider: (mentioned, rank)}."""
    from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
    from apps.prompt_library.services.prompt_crawler import CrawlOutcome

    calls = []

    def crawl(website, prompt, *, only_missing=False, acting_user=None,
              should_stop=None):
        calls.append(prompt.id)
        audit = LLMRankingAudit.objects.create(website=website, created_by=website.user,
                                               prompts=[prompt.text])
        for provider, (mentioned, rank) in rows.items():
            LLMRankingResult.objects.create(
                audit=audit, provider=provider, prompt=prompt.text, source_prompt=prompt,
                response_text="answer", query_succeeded=True, is_mentioned=mentioned,
                mention_rank=rank, sentiment="positive" if mentioned else "not_mentioned",
            )
        return CrawlOutcome(fanouts=[], responses=len(rows), errors=list(errors))

    monkeypatch.setattr("apps.prompt_library.services.prompt_crawler.crawl_prompt", crawl)
    return calls


def _check(fake_anthropic, chat, bp):
    fake_anthropic.queue(message(tool_use("check_ai_engines", {"prompt_ids": [str(bp.prompt_id)]},
                                          id="toolu_e"), stop_reason="tool_use"),
                         message(text("Done.")))
    started = send(chat, "Check the engines")
    reply = AgentMessage.objects.get(id=started.assistant_message.id)
    parts = {p["engine"]: p for p in reply.parts if p["type"] == "engine_check"}
    return parts, tool_results_of(fake_anthropic.requests[-1].json)[0]


def test_an_engine_outside_the_prompts_model_selection_is_not_selected(
    fake_anthropic, chat, website, monkeypatch,
):
    bp = make_prompt(website, "best crm for startups")
    bp.model_variants = ["claude:claude-haiku-4-5"]
    bp.save(update_fields=["model_variants"])
    _crawl(monkeypatch, {"claude": (True, 2)})

    parts, result = _check(fake_anthropic, chat, bp)

    assert (parts["claude"]["status"], parts["claude"]["rank"]) == ("done", 2)
    assert parts["perplexity"]["status"] == "unavailable"
    assert parts["perplexity"]["error"] == "Not in this prompt's model selection"
    assert parts["chatgpt"]["error"] == "OPENAI_API_KEY is not set"
    engines = json.loads(result["content"])["prompts"][0]["engines"]
    assert engines["perplexity"] == {"configured": True, "selected": False, "mentioned": None,
                                     "rank": None, "sentiment": None}
    assert "error" not in engines["perplexity"]


def test_a_selection_without_a_configured_engine_is_reported_without_a_crawl(
    fake_anthropic, chat, website, monkeypatch,
):
    bp = make_prompt(website, "best crm for startups")
    bp.model_variants = ["gemini:gemini-2.5-flash"]
    bp.save(update_fields=["model_variants"])
    calls = _crawl(monkeypatch, {})

    parts, result = _check(fake_anthropic, chat, bp)

    assert calls == []
    assert {p["status"] for p in parts.values()} == {"unavailable"}
    prompt = json.loads(result["content"])["prompts"][0]
    assert prompt["error"] == "No configured AI engine is in this prompt's model selection."


def test_a_crawl_error_that_names_no_engine_reaches_the_report(fake_anthropic, chat, website,
                                                              monkeypatch):
    bp = make_prompt(website, "best crm for startups")
    _crawl(monkeypatch, {}, errors=["model registry unavailable: ConnectionError('db down')"])

    parts, result = _check(fake_anthropic, chat, bp)

    message_ = "The scan could not ask the AI engines."
    assert (parts["claude"]["status"], parts["claude"]["error"]) == ("error", message_)
    assert parts["perplexity"]["error"] == message_
    prompt = json.loads(result["content"])["prompts"][0]
    assert prompt["error"] == message_
    assert "db down" not in result["content"]


def test_raw_provider_errors_stay_out_of_the_chat_and_reports(fake_anthropic, chat, website,
                                                             monkeypatch):
    bp = make_prompt(website, "best crm for startups")
    _crawl(monkeypatch, {}, errors=[
        f"claude: {LEAKY}",
        "perplexity: monthly_ai_allowance_exceeded: the account has used its $1.00 monthly "
        "AI allowance",
    ])

    parts, result = _check(fake_anthropic, chat, bp)

    assert parts["claude"]["error"] == "The engine returned an error."
    assert parts["perplexity"]["error"] == "The monthly AI allowance is used up."
    reply = json.dumps([p for p in parts.values()]) + result["content"]
    for secret in ("sk-ant", "SECRETKEY", "console.anthropic.com", "Incorrect API key"):
        assert secret not in reply


@pytest.mark.parametrize(("raw", "public"), [
    ("rate limited", "The engine was busy or rate limited."),
    ("Error code: 429 - overloaded", "The engine was busy or rate limited."),
    ("Claude circuit open (recent failures); skipping", "The engine was busy or rate limited."),
    ("Request timed out.", "The engine did not respond in time."),
    ("service_unavailable: Claude provider not enabled", "The engine is not configured."),
    ("ai_allowance_check_failed: could not verify AI allowance",
     "The AI allowance could not be checked, so the engine was not asked."),
    (LEAKY, "The engine returned an error."),
])
def test_public_engine_errors(raw, public):
    assert research.public_engine_error(raw) == public


# ── Stop while crawls run in worker threads ──────────────────────────────


def test_stop_ends_the_check_without_waiting_for_running_crawls(chat, website, monkeypatch):
    bp = make_prompt(website, "best crm for startups")
    release, finished = threading.Event(), threading.Event()

    def slow_crawl(website, prompt, *, only_missing=False, acting_user=None,
                   should_stop=None):
        release.wait(10)
        finished.set()

    monkeypatch.setattr("apps.prompt_library.services.prompt_crawler.crawl_prompt", slow_crawl)
    question = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    reply = AgentMessage.objects.create(chat=chat, parent=question, role="assistant",
                                        status="streaming", depth=1)
    run = AgentRun.objects.create(chat=chat, user=chat.user, website=website,
                                  user_message=question, assistant_message=reply,
                                  status="running")
    emitter = RunEmitter(run, reply)
    active = SimpleNamespace(cancelled=False)
    ctx = ToolContext(run=run, chat=chat, website=website, user=chat.user, emitter=emitter,
                      active=active, request=1, inline=False)
    threading.Timer(0.3, lambda: setattr(active, "cancelled", True)).start()

    started = time.monotonic()
    try:
        with pytest.raises(ToolError, match="Stopped"):
            research.check_ai_engines(ctx, CheckAiEnginesInput(prompt_ids=[bp.prompt_id]))
        assert time.monotonic() - started < 3
        assert not finished.is_set()
        checks = {p["engine"]: p for p in emitter.parts() if p["type"] == "engine_check"}
        assert {checks[k]["status"] for k in ("claude", "perplexity")} == {"error"}
        assert {checks[k]["error"] for k in ("claude", "perplexity")} == {"Stopped"}
        seq = emitter.last_seq
    finally:
        release.set()
    assert finished.wait(5)
    time.sleep(0.1)
    # The crawl that ended afterwards wrote nothing into the finished check.
    assert emitter.last_seq == seq
