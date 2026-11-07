"""The research flow end to end, as the frontend drives it.

One send runs the orchestrator through google_search (two Google pages
as browser tabs; SerpAPI mocked), inspect_page (the real browse service;
HTTP mocked, DNS pinned), check_ai_engines (crawl_prompt patched; engines
without a key reported unavailable), get_prompt_gap and the written
report. The reply is read back the three ways the frontend reads it
(chat detail, SSE, long-poll) and saved to Reports.

A second flow has no SerpAPI key and no engine answers: every missing
piece is reported as missing, nothing is filled in, and the report can
still be saved with exactly that.
"""
import ipaddress
import json
from urllib.parse import parse_qs, urlsplit

import pytest
import responses
from django.urls import reverse
from rest_framework_simplejwt.tokens import AccessToken

from apps.accounts.models import AITokenUsage
from apps.agent.models import AgentArtifact, AgentMessage, AgentRun
from apps.agent.runtime.parts import replay
from apps.agent.tests import contract_support as contract
from apps.agent.tests.api_support import client_for, data, error
from apps.agent.tests.fakes import message, text, thinking, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, run_events, tool_results_of
from apps.search_gap.models import GoogleRankCheck

pytestmark = pytest.mark.django_db

SERP = "https://serpapi.com/search.json"
PROMPT = "best crm for startups"
PAGE_URL = "https://northwind.example/crm"
MODEL_TITLE = "Northwind visibility for best crm"
REPORT = """# Northwind on Google and in AI answers

Google lists Northwind at #12, on page 2. Claude names it second; Perplexity does not name it.
HubSpot leads on Google and in the AI Overview.

| Prompt | Google | ChatGPT | Claude | Gemini | Grok | Perplexity | Gap |
|---|---|---|---|---|---|---|---|
| best crm for startups | #12 | not configured | #2 | not configured | not configured | not named | see below |

## best crm for startups

Fix the CRM page title and add an FAQ.

## Method

Captured from Google (US, 2 pages) and the configured engines.
"""
PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<title>Northwind CRM for startups</title>
<meta name="description" content="One inbox for every customer conversation.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication"}</script>
</head>
<body>
<nav><a href="/">Home</a></nav>
<main>
<h1>CRM for startups</h1>
<p>Northwind keeps every customer conversation in one place.</p>
<h2>Pricing</h2>
<p>Free for three users.</p>
</main>
</body>
</html>
"""


# ── Mocked outside world ──────────────────────────────────────────────────


def _organic(start, rows):
    return [
        {"position": start + i + 1, "link": url, "title": title, "snippet": f"About {title}"}
        for i, (url, title) in enumerate(rows)
    ]


def _serp_page(params):
    if params.get("start") == "10":
        return {"organic_results": _organic(10, [
            ("https://blog.example/crm", "CRM guide"),
            (PAGE_URL, "Northwind CRM"),
        ])}
    return {
        "organic_results": _organic(0, [
            ("https://www.hubspot.com/products/crm", "HubSpot CRM"),
            ("https://reviews.example/best-crm", "Best CRMs"),
        ]),
        "ai_overview": {
            "text_blocks": [{"snippet": "Popular picks include HubSpot and Northwind."}],
            "references": [{"link": "https://reviews.example/best-crm", "title": "Best CRMs"}],
        },
        "related_questions": [{"question": "What is the best CRM for startups?"}],
    }


@pytest.fixture
def web(monkeypatch):
    """SerpAPI and the inspected page, mocked; hostnames resolve publicly."""
    monkeypatch.setattr("core.validators.url_safety._resolve_addresses",
                        lambda host: [ipaddress.ip_address("93.184.216.34")])
    searches = []

    def serp(request):
        params = {k: v[0] for k, v in parse_qs(urlsplit(request.url).query).items()}
        searches.append(params)
        return 200, {"Content-Type": "application/json"}, json.dumps(_serp_page(params))

    with responses.RequestsMock(assert_all_requests_are_fired=False) as mock:
        mock.add_callback(responses.GET, SERP, callback=serp)
        mock.add(responses.GET, PAGE_URL, body=PAGE_HTML, status=200,
                 content_type="text/html; charset=utf-8",
                 headers={"X-Frame-Options": "SAMEORIGIN"})
        mock.searches = searches
        yield mock


def _crawl(rows, errors=()):
    """crawl_prompt storing these answers: {provider: (mentioned, rank, sentiment)}."""
    from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
    from apps.prompt_library.services.prompt_crawler import CrawlOutcome

    calls = []

    def crawl(website, prompt, *, only_missing=False, acting_user=None,
              should_stop=None):
        calls.append((str(prompt.id), only_missing, acting_user))
        if rows:
            audit = LLMRankingAudit.objects.create(website=website, created_by=website.user,
                                                   prompts=[prompt.text])
            for provider, (mentioned, rank, sentiment) in rows.items():
                LLMRankingResult.objects.create(
                    audit=audit, provider=provider, prompt=prompt.text, source_prompt=prompt,
                    response_text=f"{provider} answer", query_succeeded=True,
                    is_mentioned=mentioned, mention_rank=rank, sentiment=sentiment,
                    mention_context="Northwind is a good pick for startups." if mentioned else "",
                    competitors_mentioned=[{"name": "HubSpot", "position": 1}],
                )
        return CrawlOutcome(fanouts=[], responses=len(rows), errors=list(errors))

    crawl.calls = calls
    return crawl


@pytest.fixture
def setup(website, settings):
    settings.SERPAPI_KEY = "serp-test"
    settings.PERPLEXITY_API_KEY = "pplx-test"
    settings.OPENAI_API_KEY = ""
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    website.competitors = [{"name": "HubSpot", "domain": "hubspot.com"}]
    website.save(update_fields=["competitors"])
    return make_prompt(website, PROMPT, location="us")


def _research_script(fake, prompt_id: str):
    fake.queue(
        message(thinking("Google first, then the AI engines, then the gap."),
                text("I'll check Google first."),
                tool_use("google_search", {"query": PROMPT, "pages": 2, "location": "US"},
                         id="toolu_google"),
                stop_reason="tool_use"),
        message(tool_use("inspect_page", {"url": PAGE_URL}, id="toolu_page"),
                stop_reason="tool_use"),
        message(tool_use("check_ai_engines", {"prompt_ids": [prompt_id]}, id="toolu_engines"),
                stop_reason="tool_use"),
        message(tool_use("get_prompt_gap", {"prompt_id": prompt_id}, id="toolu_gap"),
                stop_reason="tool_use"),
        message(text(REPORT, chunks=6), output_tokens=1200),
        # The chat title (inline mode asks for it after the reply).
        message(text(json.dumps({"title": MODEL_TITLE}))),
    )


def _tool_result(fake, index: int) -> dict:
    """The JSON tool result request ``index`` sent back to the model."""
    result = tool_results_of(fake.requests[index].json)[0]
    assert result.get("is_error") is not True, result
    return json.loads(result["content"])


def _sse_frames(client, run_id, user) -> list[dict]:
    url = reverse("agent-live-stream", kwargs={"run_id": run_id})
    resp = client.get(url, HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(user)}")
    assert resp.status_code == 200
    assert resp["Content-Type"].startswith("text/event-stream")
    body = b"".join(resp.streaming_content).decode()
    frames = []
    for block in body.split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.split("\n")
                      if line and not line.startswith(":") and ": " in line)
        if "data" in fields:
            frames.append({**fields, "data": json.loads(fields["data"])})
    return frames


# ── The flow ──────────────────────────────────────────────────────────────


def test_research_flow_from_send_to_saved_report(fake_anthropic, chat, user, website, setup,
                                                 web, monkeypatch, client):
    crawl = _crawl({"claude": (True, 2, "positive"),
                    "perplexity": (False, None, "not_mentioned")})
    monkeypatch.setattr("apps.prompt_library.services.prompt_crawler.crawl_prompt", crawl)
    prompt_id = str(setup.prompt_id)
    _research_script(fake_anthropic, prompt_id)
    api = client_for(user)

    # 1. Send: the run executes inline and the 202 describes it.
    resp = api.post(
        reverse("agent-live-send", kwargs={"website_id": website.id, "chat_id": chat.id}),
        {"text": f"Research how Northwind ranks for \"{PROMPT}\""}, format="json",
        HTTP_IDEMPOTENCY_KEY="research-1",
    )
    assert resp.status_code == 202
    started = data(resp)
    assert set(started) == {"user_message", "assistant_message", "run"}
    assert not contract.missing(contract.RUN, started["run"])
    assert started["run"]["status"] == "completed"
    run = AgentRun.objects.get(id=started["run"]["id"])
    reply = AgentMessage.objects.get(id=started["assistant_message"]["id"])
    assert reply.status == "complete" and fake_anthropic.pending == 0
    assert len(fake_anthropic.requests) == 6

    # 2. SEO, visible: two Google pages, the brand on page 2, a rank check
    #    for the tracked prompt.
    assert [(s.get("start"), s["gl"], s["hl"], s["q"]) for s in web.searches] == [
        (None, "us", "en", PROMPT), ("10", "us", "en", PROMPT)]
    google = _tool_result(fake_anthropic, 1)
    assert (google["brand_best_position"], google["pages_searched"]) == (12, 2)
    assert google["tracked_prompt_id"] == prompt_id and google["rank_check_recorded"] is True
    assert google["ai_overview"] == {"shown": True, "content_captured": True,
                                     "mentions_you": True, "cites_you": False}
    assert google["people_also_ask"] == ["What is the best CRM for startups?"]
    assert google["pages"][0]["top"][0]["is_competitor"] is True
    check = GoogleRankCheck.objects.get()
    assert (check.position, check.depth, check.pages_fetched) == (12, 20, 2)

    # The inspected page went through the real browse service.
    page = _tool_result(fake_anthropic, 2)
    assert (page["final_url"], page["status_code"], page["frameable"]) == (PAGE_URL, 200, False)
    assert page["page_text"]["untrusted"] is True
    assert "H1: CRM for startups" in page["page_text"]["text"]
    assert "Structured data: SoftwareApplication" in page["page_text"]["text"]
    assert page["excerpt"]["untrusted"] is True
    assert "Northwind keeps every customer conversation" in page["excerpt"]["text"]

    # 3. GEO, background: configured engines asked, the rest unavailable.
    assert crawl.calls == [(prompt_id, False, user)]
    engines = _tool_result(fake_anthropic, 3)
    answers = engines["prompts"][0]["engines"]
    assert answers["claude"] == {"configured": True, "mentioned": True, "rank": 2,
                                 "sentiment": "positive"}
    assert answers["perplexity"]["mentioned"] is False
    assert answers["chatgpt"] == {"configured": False, "mentioned": None, "rank": None,
                                  "sentiment": None}
    assert set(engines["engines_not_configured"]) == {"ChatGPT", "Gemini", "Grok"}

    # 4. Compare: the gap reads the rank check and the fresh answers.
    gap = _tool_result(fake_anthropic, 4)
    assert gap["prompt"]["id"] == prompt_id
    assert (gap["google"]["status"], gap["google"]["position"], gap["google"]["page"]) == (
        "ok", 12, 2)
    assert gap["google"]["top_results"][0]["is_competitor"] is True
    assert gap["google"]["ai_overview"]["shown"] is True
    by_key = {e["key"]: e for e in gap["engines"]}
    assert (by_key["claude"]["mentioned"], by_key["claude"]["rank"]) == (True, 2)
    assert by_key["perplexity"]["brands_above"] == [{"name": "HubSpot", "position": 1}]
    # Google #12 scores 55; Claude #2 scores 100 and Perplexity 0, mean 50.
    assert gap["gap"] == {"class": "even", "value": -5, "ai_score": 50, "search_score": 55}
    assert engines["prompts"][0]["gap"] == {"class": "even", "value": -5}

    # Every request kept the pinned system prompt and tools (one cache prefix).
    orchestrator = fake_anthropic.requests[:5]
    assert len({json.dumps(r.json["system"]) for r in orchestrator}) == 1
    assert len({json.dumps(r.json["tools"]) for r in orchestrator}) == 1
    assert fake_anthropic.requests[5].streamed is False

    # 5. The events: contract envelopes and payloads, in order, and the
    #    pane only ever hears about Google pages and the inspected page.
    events = run_events(run)
    for event in events:
        contract.assert_event(event)
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert events[0]["type"] == "run.started" and events[-1]["type"] == "run.completed"
    assert events[-1]["status"] == "complete" and events[-1]["parts_seq"] == len(events) - 1
    # The title the chat has at the start (the first message), then the model's.
    assert [(e["chat_id"], e["title"]) for e in events if e["type"] == "chat.updated"] == [
        (str(chat.id), f"Research how Northwind ranks for \"{PROMPT}\""),
        (str(chat.id), MODEL_TITLE)]
    assert not [e for e in events if e["type"] in ("turn.reset", "run.retrying")]
    opens = [e for e in events if e["type"] == "browser.open"]
    updates = [e for e in events if e["type"] == "browser.update"]
    assert [(o["tab"]["kind"], o["activate"]) for o in opens] == [
        ("serp", True), ("serp", False), ("page", True)]
    assert [u["tab_id"] for u in updates] == [o["tab"]["id"] for o in opens]
    assert [u["status"] for u in updates] == ["ready", "ready", "ready"]
    first_check = next(i for i, e in enumerate(events) if e["type"] == "part.added"
                       and e["part"]["type"] == "engine_check")
    assert all(not e["type"].startswith("browser.") for e in events[first_check:])

    # 6. What was stored: contract parts, equal to replaying the events.
    reply.refresh_from_db()
    for part in reply.parts:
        contract.assert_part(part)
    assert replay(events) == reply.parts
    assert [p["type"] for p in reply.parts] == [
        "thinking", "text", "serp", "serp", "page_inspect",
        *["engine_check"] * 5, "tool", "text"]
    serp_parts = [p for p in reply.parts if p["type"] == "serp"]
    assert [(p["page"], p["status"], p["brand_positions"]) for p in serp_parts] == [
        (1, "done", []), (2, "done", [12])]
    checks = {p["engine"]: p for p in reply.parts if p["type"] == "engine_check"}
    assert {k: p["status"] for k, p in checks.items()} == {
        "chatgpt": "unavailable", "claude": "done", "gemini": "unavailable",
        "grok": "unavailable", "perplexity": "done"}
    assert checks["chatgpt"]["error"] == "OPENAI_API_KEY is not set"
    assert sorted(reply.research["serp"]) == sorted(p["tab_id"][5:] for p in serp_parts)
    stored_page = next(iter(reply.research["pages"].values()))
    assert "reader" not in stored_page and stored_page["seo"]["h1"] == ["CRM for startups"]
    assert reply.research["gaps"] == [gap]

    # 7. Read back as the frontend does: chat detail, SSE, long-poll.
    chat_url = reverse("agent-chat-detail", kwargs={"website_id": website.id, "chat_id": chat.id})
    detail = data(api.get(chat_url))
    assert not contract.missing(contract.CHAT_DETAIL, detail)
    assert (detail["title"], detail["title_source"], detail["active_run"]) == (
        MODEL_TITLE, "model", None)
    question, answer = detail["messages"]
    assert not contract.missing(contract.MESSAGE, answer)
    assert answer["parts"] == reply.parts and answer["parts_seq"] == reply.parts_seq
    assert answer["run_id"] == str(run.id) and answer["research"] == reply.research
    assert question["parts"][0]["text"].startswith("Research how Northwind ranks")

    frames = _sse_frames(client, run.id, user)
    assert [f["data"] for f in frames] == events
    assert [int(f["id"]) for f in frames] == [e["seq"] for e in events]
    assert [f["event"] for f in frames] == [e["type"] for e in events]

    events_url = reverse("agent-live-events", kwargs={"run_id": run.id})
    polled = api.get(events_url, {"after": 0, "wait": 0}).json()
    assert polled["events"] == events
    assert (polled["terminal"], polled["run_status"], polled["next_after"]) == (
        True, "completed", events[-1]["seq"])

    # 8. Save to Reports: the reply's Markdown plus the research behind it.
    reports_url = reverse("agent-reports", kwargs={"website_id": website.id})
    saved = api.post(reports_url, {"message_id": str(reply.id)}, format="json")
    assert saved.status_code == 201
    report = data(saved)
    assert not contract.missing(contract.ARTIFACT_DETAIL, report)
    assert (report["kind"], report["agent_key"], report["content_type"], report["version"]) == (
        "report", "gap_analyst", "text/markdown", 1)
    assert report["title"] == "Northwind on Google and in AI answers"
    assert report["content"] == "I'll check Google first.\n\n" + REPORT.strip()
    assert report["source_chat_id"] == str(chat.id)
    snapshot = report["data"]
    assert set(snapshot) == contract.REPORT_DATA
    assert [c["page"] for c in snapshot["serp"]] == [1, 2]
    assert snapshot["serp"] == [reply.research["serp"][p["tab_id"][5:]] for p in serp_parts]
    assert all(not contract.missing(contract.SERP_CAPTURE, c) for c in snapshot["serp"])
    assert [c["final_url"] for c in snapshot["pages"]] == [PAGE_URL]
    assert "reader" not in snapshot["pages"][0]
    assert snapshot["engines"] == [p for p in reply.parts if p["type"] == "engine_check"]
    assert snapshot["gaps"] == [gap]
    assert report["summary"] == (
        "2 Google results pages, 1 page inspected, 5 AI engine checks, 2 sections")

    again = api.post(reports_url, {"message_id": str(reply.id)}, format="json")
    assert again.status_code == 409
    assert error(again)["code"] == "already_saved"
    assert error(again)["details"] == {"artifact_id": report["id"]}

    artifact = AgentArtifact.objects.get(kind="report")
    assert str(artifact.id) == report["id"] and artifact.source_message_id == reply.id
    detail = data(api.get(chat_url))
    assert detail["messages"][1]["saved_report_id"] == report["id"]
    listed = data(api.get(reverse("agent-artifacts", kwargs={"website_id": website.id}),
                          {"kind": "report"}))
    assert [a["id"] for a in listed] == [report["id"]]
    assert all(not contract.missing(contract.ARTIFACT_SUMMARY, a) for a in listed)
    versions = data(api.get(reverse("agent-artifact-versions", kwargs={
        "website_id": website.id, "artifact_id": artifact.id})))
    assert [(v["version"], v["source"]) for v in versions] == [(1, "agent")]

    # 9. Spend: one usage row per model request, totals on the run.
    roles = sorted(AITokenUsage.objects.filter(module="agent")
                   .values_list("metadata__role", flat=True))
    assert roles == ["orchestrator"] * 5 + ["title"]
    run.refresh_from_db()
    assert run.requests == 5 and run.cost_usd > 0 and run.status == "completed"


def test_research_flow_without_keys_reports_what_is_missing(fake_anthropic, chat, user, website,
                                                            settings, monkeypatch, web):
    settings.SERPAPI_KEY = ""
    for key in ("PERPLEXITY_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"):
        setattr(settings, key, "")
    bp = make_prompt(website, PROMPT)
    prompt_id = str(bp.prompt_id)
    # Claude shares the agent's key, so it is asked; its answer fails.
    crawl = _crawl({}, errors=["claude: The provider rejected the request."])
    monkeypatch.setattr("apps.prompt_library.services.prompt_crawler.crawl_prompt", crawl)
    fake_anthropic.queue(
        message(tool_use("google_search", {"query": PROMPT}, id="toolu_google"),
                stop_reason="tool_use"),
        message(tool_use("check_ai_engines", {"prompt_ids": [prompt_id]}, id="toolu_engines"),
                stop_reason="tool_use"),
        message(tool_use("get_prompt_gap", {"prompt_id": prompt_id}, id="toolu_gap"),
                stop_reason="tool_use"),
        message(text("# Northwind: not measured yet\n\nGoogle and the AI engines could not be "
                     "checked.")),
        message(text(json.dumps({"title": "Northwind not measured"}))),
    )
    api = client_for(user)

    resp = api.post(
        reverse("agent-live-send", kwargs={"website_id": website.id, "chat_id": chat.id}),
        {"text": "Research Northwind"}, format="json",
    )
    assert resp.status_code == 202
    reply = AgentMessage.objects.get(id=data(resp)["assistant_message"]["id"])
    assert reply.status == "complete"

    # No SerpAPI key: an honest error, no request, no tab, no rank check.
    google = tool_results_of(fake_anthropic.requests[1].json)[0]
    assert google["is_error"] is True
    assert google["content"] == "Google search isn't available: no Google results key (SERPAPI_KEY or SCRAPERAPI_KEY) is set."
    assert web.searches == [] and GoogleRankCheck.objects.count() == 0
    events = run_events(AgentRun.objects.get(id=data(resp)["run"]["id"]))
    for event in events:
        contract.assert_event(event)
    assert not [e for e in events if e["type"].startswith("browser.")]
    serp = next(p for p in reply.parts if p["type"] == "serp")
    assert (serp["status"], serp["error"]["code"], serp["tab_id"]) == (
        "error", "serp_not_configured", None)

    # Engines: unconfigured ones unavailable with the missing key named, the
    # failed one an error with its reason; never "not mentioned".
    engines = json.loads(tool_results_of(fake_anthropic.requests[2].json)[0]["content"])
    answers = engines["prompts"][0]["engines"]
    assert answers["claude"]["error"] == "The engine returned an error."
    assert answers["claude"]["mentioned"] is None
    assert set(engines["engines_not_configured"]) == {"ChatGPT", "Gemini", "Grok", "Perplexity"}
    checks = {p["engine"]: p for p in reply.parts if p["type"] == "engine_check"}
    assert (checks["claude"]["status"], checks["claude"]["mentioned"]) == ("error", None)
    assert {k: (p["status"], p["error"]) for k, p in checks.items() if k != "claude"} == {
        "chatgpt": ("unavailable", "OPENAI_API_KEY is not set"),
        "gemini": ("unavailable", "GEMINI_API_KEY is not set"),
        "grok": ("unavailable", "XAI_API_KEY is not set"),
        "perplexity": ("unavailable", "PERPLEXITY_API_KEY is not set"),
    }

    # The gap says nothing was measured.
    gap = json.loads(tool_results_of(fake_anthropic.requests[3].json)[0]["content"])
    assert gap["google"]["status"] == "not_checked" and gap["google"]["position"] is None
    assert gap["gap"]["class"] == "no_data"
    assert all(e["mentioned"] is None for e in gap["engines"])

    # Saved as it is: no Google pages, the engine states as they were.
    saved = api.post(reverse("agent-reports", kwargs={"website_id": website.id}),
                     {"message_id": str(reply.id)}, format="json")
    assert saved.status_code == 201
    snapshot = data(saved)["data"]
    assert snapshot["serp"] == [] and snapshot["pages"] == []
    assert {p["status"] for p in snapshot["engines"]} == {"error", "unavailable"}
    assert snapshot["gaps"][0]["gap"]["class"] == "no_data"
    assert data(saved)["summary"] == "5 AI engine checks"
