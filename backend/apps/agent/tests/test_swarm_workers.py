"""The five research agents (design section 8): result lines, tones,
details, panes and failure modes, with Google, page fetches, the engines
and the analysis model faked."""
import json
import threading
import time
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.agent.runtime.swarm import workers
from apps.agent.runtime.swarm.context import SwarmRun, TaskJob, TaskStopped
from apps.agent.runtime.swarm.plan import PlanOptions, initial_task
from apps.agent.runtime.swarm.reporter import TaskReporter
from apps.agent.runtime.swarm.workers import serp_page
from apps.agent.tests.fakes import refusal, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat, run_events
from apps.agent.tests.swarm_support import *  # noqa: F403
from apps.agent.tests.swarm_support import (
    browse_result,
    engine_answer,
    fake_engine_scan,
    fake_fetch,
    fake_serp,
    make_run,
    make_swarm,
    plan_prompts,
    serp_payload,
    tool_context,
)
from apps.agent.tools.research import build_serp_capture

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("swarm_limits")]

YOURS = "https://www.northwind.example/crm"
HUBSPOT = "https://www.hubspot.com/products/crm"
REVIEWS = "https://reviews.example/best-crm"
ATLASSIAN = "https://www.atlassian.com/software/crm"


@pytest.fixture(autouse=True)
def competitors(website):
    website.competitors = [{"name": "HubSpot", "domain": "hubspot.com"}]
    website.save(update_fields=["competitors"])
    return website


@pytest.fixture
def engines_on(settings):
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"


class Setup:
    """One SwarmRun of a fresh swarm (in a chat of its own unless
    ``same_chat``), and jobs for its tasks."""

    def __init__(self, chat, *, prompts=1, options=None, serp=True, version=1, location="us",
                 same_chat=False, texts=None):
        chat = chat if same_chat else make_chat(chat.user, chat.website)
        self.run = make_run(chat)
        self.prompts = plan_prompts(chat.website, prompts, texts=texts, location=location)
        self.swarm, self.version = make_swarm(chat, self.run, self.prompts, options=options,
                                              serp_configured=serp, version=version)
        self.ctx = tool_context(self.run)
        self.swarm_run = SwarmRun(self.ctx, self.swarm, self.version,
                                  deadline=time.monotonic() + 60, carried={})

    def job(self, task_id: str) -> TaskJob:
        spec = next(t for t in self.swarm.tasks if t["id"] == task_id)
        reporter = TaskReporter(self.ctx.emitter, "p9", initial_task(spec), threading.Lock())
        reporter.started(workers.first_step(spec, self.swarm_run))
        return TaskJob(spec=spec, run=self.swarm_run, reporter=reporter, started=time.monotonic(),
                       deadline=time.monotonic() + 60)

    def run_task(self, task_id: str):
        job = self.job(task_id)
        output = workers.WORKERS[job.spec["worker"]](job)
        return output, job

    def steps(self, task_id: str) -> list[str]:
        return [e["patch"]["step"] for e in run_events(self.run)
                if e.get("task_id") == task_id and e["type"].startswith("task.")
                and e["patch"].get("step")]

    def done(self, task_id: str, detail: dict, *, pane=None) -> None:
        self.swarm_run.set_result(task_id, {"id": task_id, "status": "done", "detail": detail,
                                            "pane": pane, "rev": 4})

    def capture(self, rows, *, page: int = 1, overview=None, capture_id="c0ffee000001") -> dict:
        capture = build_serp_capture(serp_payload(rows, start=(page - 1) * 10, overview=overview),
                                     website=self.swarm.website, query=self.prompts[0].text,
                                     page=page, location="us", capture_id=capture_id)
        self.ctx.emitter.record_capture("serp", capture_id, capture)
        self.swarm_run.set_capture("p1", page, capture)
        self.done(f"google.p1.page{page}", {"reused": False},
                  pane={"kind": "serp", "tab_id": f"serp:{capture_id}"})
        return capture


# ── serp_page ────────────────────────────────────────────────────────────


def test_a_google_page_with_you_on_it(chat, monkeypatch):
    setup = Setup(chat)
    calls = fake_serp(monkeypatch, {1: serp_payload(
        [(HUBSPOT, "HubSpot CRM"), (YOURS, "Northwind CRM")],
        overview={"text": "Northwind and HubSpot are popular.",
                  "references": [{"url": "https://g2.com/crm", "domain": "g2.com",
                                  "title": "G2"}]},
        questions=["Which CRM is cheapest?"])})

    output, job = setup.run_task("google.p1.page1")

    assert calls == [{"query": "best crm for team 1", "page": 1, "gl": "us", "hl": "en"}]
    assert (output.status, output.result, output.tone) == (
        "done", "You're #2 · AI Overview names you", "good")
    capture_id = output.pane["tab_id"].split(":", 1)[1]
    assert output.pane == {"kind": "serp", "tab_id": f"serp:{capture_id}"}
    detail = output.detail
    assert (detail["query"], detail["page"], detail["location"], detail["provider"]) == (
        "best crm for team 1", 1, "us", "serpapi")
    assert (detail["reused"], detail["result_count"], detail["brand_positions"]) == (
        False, 2, [2])
    assert detail["top"][0] == {"position": 1, "title": "HubSpot CRM", "url": HUBSPOT,
                                "domain": "hubspot.com", "is_yours": False,
                                "is_competitor": True, "competitor_name": "HubSpot"}
    assert detail["ai_overview"] == {
        "shown": True, "content_captured": True, "mentions_you": True, "cites_you": False,
        "references": [{"domain": "g2.com", "url": "https://g2.com/crm"}]}
    assert detail["people_also_ask"] == ["Which CRM is cheapest?"]
    assert capture_id in setup.ctx.emitter.research["serp"]
    assert setup.swarm_run.captures["p1"][1]["capture_id"] == capture_id
    recorded = [e for e in run_events(setup.run) if e["type"] == "research.recorded"]
    assert [(e["kind"], e["capture_id"]) for e in recorded] == [("serp", capture_id)]
    assert setup.steps("google.p1.page1") == ["Fetching Google page 1", "Reading the results"]


def test_a_google_page_without_you_names_the_best_competitor(chat, monkeypatch):
    setup = Setup(chat)
    fake_serp(monkeypatch, {1: serp_payload([(REVIEWS, "Best CRMs"), (HUBSPOT, "HubSpot CRM")],
                                            overview={"text": "Many tools exist."})})

    output, _ = setup.run_task("google.p1.page1")

    assert (output.result, output.tone) == ("Not on page 1 · HubSpot #2 · AI Overview shown",
                                            "warn")


def test_version_one_shows_a_page_captured_within_the_hour_again(chat, monkeypatch):
    earlier = build_serp_capture(serp_payload([(YOURS, "Northwind CRM")]),
                                 website=chat.website, query="best crm for team 1", page=1,
                                 location="us", capture_id="0123456789ab")
    earlier["captured_at"] = (timezone.now() - timedelta(minutes=12)).isoformat()
    previous = make_run(chat, status="completed")
    previous.assistant_message.research = {"serp": {"0123456789ab": earlier}}
    previous.assistant_message.finished_at = timezone.now()
    previous.assistant_message.save(update_fields=["research", "finished_at"])
    calls = fake_serp(monkeypatch, {})
    setup = Setup(chat, same_chat=True)

    output, _ = setup.run_task("google.p1.page1")

    assert calls == []
    assert output.result == "You're #1 · captured 12 minutes ago"
    assert output.detail["reused"] is True
    # An ad-hoc search's page is shown again as this tracked prompt's own capture.
    capture_id = output.pane["tab_id"].split(":", 1)[1]
    assert output.pane["kind"] == "serp" and capture_id != "0123456789ab"
    assert set(setup.ctx.emitter.research["serp"]) == {capture_id}
    assert setup.ctx.emitter.research["serp"][capture_id]["results"] == earlier["results"]
    assert setup.swarm_run.notes == [{
        "category": "google", "level": "info", "code": "reused_captures",
        "text": serp_page.REUSED_NOTE}]

    rerun = Setup(chat, version=2)
    fake_serp(monkeypatch, {1: serp_payload([(YOURS, "Northwind CRM")])})
    again, _ = rerun.run_task("google.p1.page1")
    assert again.detail["reused"] is False


STAMP_KEYS = ("prompt_key", "prompt_id", "brand_prompt_id")


def _stamp(prompt) -> dict:
    return {"prompt_key": prompt.key, "prompt_id": prompt.prompt_id,
            "brand_prompt_id": prompt.brand_prompt_id}


def _stamped(capture: dict) -> dict:
    return {k: capture.get(k) for k in STAMP_KEYS}


def test_a_google_page_capture_names_its_tracked_prompt(chat, monkeypatch):
    setup = Setup(chat)
    fake_serp(monkeypatch, {1: serp_payload([(YOURS, "Northwind CRM")])})

    output, _ = setup.run_task("google.p1.page1")

    capture_id = output.pane["tab_id"].split(":", 1)[1]
    want = _stamp(setup.prompts[0])
    assert want["prompt_id"] and want["brand_prompt_id"]
    assert _stamped(setup.ctx.emitter.research["serp"][capture_id]) == want
    assert _stamped(setup.swarm_run.captures["p1"][1]) == want
    (recorded,) = [e for e in run_events(setup.run) if e["type"] == "research.recorded"]
    assert _stamped(recorded["capture"]) == want
    # The task detail is pinned and size-capped; the stamp stays out of it.
    assert not set(STAMP_KEYS) & set(output.detail)


def _earlier_capture(chat, stamp=None) -> dict:
    """A page of "best crm for team 1" an earlier reply of this chat captured
    12 minutes ago (stamped for a tracked prompt when ``stamp`` is given)."""
    earlier = build_serp_capture(serp_payload([(YOURS, "Northwind CRM")]),
                                 website=chat.website, query="best crm for team 1", page=1,
                                 location="us", capture_id="0123456789ab")
    earlier["captured_at"] = (timezone.now() - timedelta(minutes=12)).isoformat()
    earlier.update(stamp or {})
    previous = make_run(chat, status="completed")
    previous.assistant_message.research = {"serp": {"0123456789ab": earlier}}
    previous.assistant_message.finished_at = timezone.now()
    previous.assistant_message.save(update_fields=["research", "finished_at"])
    return previous.assistant_message


def test_a_reused_google_page_is_stamped_on_a_copy(chat, monkeypatch):
    earlier = _earlier_capture(chat)  # an ad-hoc search: no stamp
    calls = fake_serp(monkeypatch, {})
    setup = Setup(chat, same_chat=True)

    output, _ = setup.run_task("google.p1.page1")

    assert calls == [] and output.detail["reused"] is True
    capture_id = output.pane["tab_id"].split(":", 1)[1]
    assert capture_id != "0123456789ab"
    want = _stamp(setup.prompts[0])
    assert _stamped(setup.ctx.emitter.research["serp"][capture_id]) == want
    assert _stamped(setup.swarm_run.captures["p1"][1]) == want
    # The earlier message keeps its own capture as it was.
    earlier.refresh_from_db()
    assert _stamped(earlier.research["serp"]["0123456789ab"]) == dict.fromkeys(STAMP_KEYS)


def test_a_reused_page_of_the_same_tracked_prompt_keeps_its_capture(chat, monkeypatch):
    fake_serp(monkeypatch, {})
    setup = Setup(chat, same_chat=True)
    # An earlier swarm searched the same tracked prompt under another key.
    _earlier_capture(chat, {**_stamp(setup.prompts[0]), "prompt_key": "p7"})

    output, _ = setup.run_task("google.p1.page1")

    assert output.pane == {"kind": "serp", "tab_id": "serp:0123456789ab"}
    assert _stamped(setup.ctx.emitter.research["serp"]["0123456789ab"]) == _stamp(
        setup.prompts[0])


def test_a_page_stamped_for_another_tracked_prompt_is_reused_as_a_capture_of_its_own(
        chat, monkeypatch):
    # Stamped by an earlier swarm for another tracked prompt that made the
    # same search.
    other = {"prompt_key": "p1", "prompt_id": "other-prompt", "brand_prompt_id": "other-brand"}
    earlier = _earlier_capture(chat, other)
    calls = fake_serp(monkeypatch, {})
    setup = Setup(chat, same_chat=True)

    output, _ = setup.run_task("google.p1.page1")

    assert calls == [] and output.detail["reused"] is True
    assert output.result == "You're #1 · captured 12 minutes ago"
    capture_id = output.pane["tab_id"].split(":", 1)[1]
    assert capture_id != "0123456789ab"
    store = setup.ctx.emitter.research["serp"]
    assert set(store) == {capture_id}
    assert _stamped(store[capture_id]) == _stamp(setup.prompts[0])
    assert store[capture_id]["results"] == earlier.research["serp"]["0123456789ab"]["results"]
    assert setup.swarm_run.captures["p1"][1]["capture_id"] == capture_id
    earlier.refresh_from_db()
    assert _stamped(earlier.research["serp"]["0123456789ab"]) == other


def test_prompts_reusing_one_unstamped_page_at_once_each_get_their_own(chat, monkeypatch):
    # Two tasks that run at the same time both read the store before either
    # records: both see the ad-hoc page unstamped.
    from apps.agent.tools import research

    earlier = _earlier_capture(chat)
    page = earlier.research["serp"]["0123456789ab"]
    monkeypatch.setattr(research, "_recent_captures", lambda ctx, query, location: {1: dict(page)})
    calls = fake_serp(monkeypatch, {})
    setup = Setup(chat, prompts=2, same_chat=True,
                  texts=["best crm for team 1", "Best CRM, for team 1?"])

    first, _ = setup.run_task("google.p1.page1")
    second, _ = setup.run_task("google.p2.page1")

    assert calls == []
    ids = [o.pane["tab_id"].split(":", 1)[1] for o in (first, second)]
    assert len({*ids, "0123456789ab"}) == 3
    store = setup.ctx.emitter.research["serp"]
    assert _stamped(store[ids[0]]) == _stamp(setup.prompts[0])
    assert _stamped(store[ids[1]]) == _stamp(setup.prompts[1])


def test_two_tracked_prompts_making_the_same_search_each_keep_their_page(chat, monkeypatch):
    # Distinct tracked prompts whose texts are the same search (query_key).
    setup = Setup(chat, prompts=2, texts=["best crm for team 1", "Best CRM, for team 1?"])
    calls = fake_serp(monkeypatch, {1: serp_payload([(YOURS, "Northwind CRM")])})

    first, _ = setup.run_task("google.p1.page1")
    second, _ = setup.run_task("google.p2.page1")

    assert len(calls) == 1 and second.detail["reused"] is True
    first_id = first.pane["tab_id"].split(":", 1)[1]
    second_id = second.pane["tab_id"].split(":", 1)[1]
    assert first_id != second_id
    store = setup.ctx.emitter.research["serp"]
    assert _stamped(store[first_id]) == _stamp(setup.prompts[0])
    assert _stamped(store[second_id]) == _stamp(setup.prompts[1])
    recorded = {e["capture_id"]: _stamped(e["capture"])
                for e in run_events(setup.run) if e["type"] == "research.recorded"}
    assert recorded == {first_id: _stamp(setup.prompts[0]), second_id: _stamp(setup.prompts[1])}


def test_google_not_configured_or_out_of_allowance_skips(chat, monkeypatch):
    setup = Setup(chat)
    output, _ = setup.run_task("google.p1.page1")
    assert (output.status, output.error) == ("skipped", {
        "code": "not_configured", "message": "Google results are not configured."})

    fake_serp(monkeypatch, {})

    class Spent:
        def consume(self, key):
            return False

    monkeypatch.setattr("apps.agent.tools.research._serp_quota", lambda: Spent())
    output, _ = setup.run_task("google.p1.page1")
    assert (output.status, output.error) == ("skipped", {
        "code": "daily_limit", "message": "This project used its daily Google search allowance."})


def test_a_scraperapi_page_two_is_not_searched(chat, monkeypatch):
    # A plan made before the cap (a re-run) may hold page 2; ScraperAPI's page
    # two answers another query (serp_google.max_reliable_pages).
    from apps.citations.services import serp_google

    setup = Setup(chat, options=PlanOptions(title="Research", google_pages=2))
    calls = fake_serp(monkeypatch, {})
    monkeypatch.setattr(serp_google, "provider", lambda: "scraperapi")

    output, _ = setup.run_task("google.p1.page2")

    assert calls == []
    assert (output.status, output.error) == ("skipped", {
        "code": "not_configured",
        "message": "Google results past page 1 are not reliable through ScraperAPI, so this "
                   "page was not searched."})


def test_a_busy_provider_is_retried_once(chat, monkeypatch):
    monkeypatch.setattr(serp_page, "RETRY_SECONDS", 0)
    calls = fake_serp(monkeypatch, {1: [serp_payload(error="http_503"),
                                        serp_payload([(YOURS, "Northwind CRM")])]})

    output, job = Setup(chat).run_task("google.p1.page1")

    assert len(calls) == 2
    assert output.status == "done"
    assert job.reporter.task["attempt"] == 2

    calls = fake_serp(monkeypatch, {1: [serp_payload(error="http_503"),
                                        serp_payload(error="http_503")]})
    output, _ = Setup(chat).run_task("google.p1.page1")
    assert len(calls) == 2
    assert (output.status, output.error) == ("failed", {
        "code": "upstream_error", "message": "Google search failed (HTTP 503)."})

    calls = fake_serp(monkeypatch, {1: serp_payload(error="decode")})
    output, _ = Setup(chat).run_task("google.p1.page1")
    assert len(calls) == 1
    assert output.error["message"] == "Google search returned an unreadable response."


# ── engine_answer ────────────────────────────────────────────────────────


def test_an_engine_that_names_you(chat, monkeypatch, routed_anthropic, engines_on):
    setup = Setup(chat)
    record = fake_engine_scan(monkeypatch, {"gpt4": engine_answer(
        mentioned=True, rank=2, sentiment="positive", context="Northwind is a solid pick.",
        brands=[("HubSpot", 1), ("Northwind", 2), ("Pipedrive", 4)],
        citations=["https://g2.com/best-crm", "https://www.northwind.example/pricing"])})

    output, _ = setup.run_task("engines.p1.chatgpt")

    assert record["asked"] == [("best crm for team 1", "gpt4", None)]
    assert (output.status, output.result, output.tone) == ("done", "Named #2 · positive", "good")
    detail = output.detail
    assert (detail["engine"], detail["engine_label"], detail["variant"], detail["model_id"]) == (
        "chatgpt", "ChatGPT", None, "gpt-4o-mini")
    assert (detail["mentioned"], detail["rank"], detail["sentiment"]) == (True, 2, "positive")
    assert detail["brands"] == [{"name": "HubSpot", "position": 1},
                                {"name": "Pipedrive", "position": 4}]
    assert detail["brands_above"] == [{"name": "HubSpot", "position": 1}]
    assert detail["snippet"] == "Northwind is a solid pick."
    assert detail["citations"] == [
        {"url": "https://g2.com/best-crm", "domain": "g2.com", "is_yours": False},
        {"url": "https://www.northwind.example/pricing", "domain": "northwind.example",
         "is_yours": True}]
    assert detail["analysis"] == {"summary": "The answer recommends HubSpot and does not name "
                                             "Northwind.",
                                  "reasons": ["Free tier", "Large app marketplace"],
                                  "opportunity": "Publish a page that compares free tiers."}
    assert detail["analysis_error"] is None
    assert detail["result_id"] == "result-1"
    assert output.pane is None
    assert setup.steps("engines.p1.chatgpt") == [
        "Asking ChatGPT", "Reading ChatGPT's answer", "Analyzing the answer"]
    [request] = routed_anthropic.haiku_requests
    blocks = request.json["messages"][0]["content"]
    assert [b["text"].split(">", 1)[0] for b in blocks] == [
        "<brand", "<question", "<measurement", "<answer"]


def test_an_engine_that_does_not_name_you(chat, monkeypatch, routed_anthropic, engines_on):
    setup = Setup(chat)
    fake_engine_scan(monkeypatch, {"gpt4": engine_answer(
        brands=[("HubSpot", 1), ("Salesforce", 2), ("Pipedrive", 3)], context="ignored")})

    output, _ = setup.run_task("engines.p1.chatgpt")

    assert (output.result, output.tone) == ("Not named · lists HubSpot, Salesforce", "warn")
    assert output.detail["snippet"] == ""
    assert (output.detail["rank"], output.detail["sentiment"]) == (None, None)
    assert [b["name"] for b in output.detail["brands_above"]] == ["HubSpot", "Salesforce",
                                                                  "Pipedrive"]


def test_a_failed_analysis_keeps_the_engine_task_done(chat, monkeypatch, routed_anthropic,
                                                      engines_on):
    routed_anthropic.haiku = lambda purpose: refusal(text(""), model="claude-haiku-5-5")
    setup = Setup(chat)
    fake_engine_scan(monkeypatch, {"gpt4": engine_answer()})
    output, _ = setup.run_task("engines.p1.chatgpt")

    assert output.status == "done"
    assert output.detail["analysis"] is None
    assert output.detail["analysis_error"] == {
        "code": "refused", "message": "The analysis model declined this input."}


@pytest.mark.parametrize("raw,status,code,message", [
    ("refusal: the model declined", "failed", "refused",
     "The engine declined to answer this prompt."),
    ("gpt4 rate limit exceeded; try again shortly", "failed", "rate_limited",
     "The engine was busy or rate limited."),
    ("Request timed out.", "failed", "timeout", "The engine did not respond in time."),
    ("monthly_ai_allowance_exceeded: the account has used its $1.00 monthly AI allowance",
     "skipped", "allowance_exceeded", "The monthly AI allowance is used up."),
    ("Error code: 401 - Incorrect API key provided: sk-SECRET", "failed", "upstream_error",
     "The engine returned an error."),
])
def test_engine_failures_in_public_words(chat, monkeypatch, engines_on, raw, status, code,
                                         message):
    setup = Setup(chat)
    fake_engine_scan(monkeypatch, {"gpt4": engine_answer(error=raw, succeeded=False)})

    output, _ = setup.run_task("engines.p1.chatgpt")

    assert (output.status, output.error) == (status, {"code": code, "message": message})
    assert "SECRET" not in json.dumps(output.error)


def test_an_engine_without_its_key_or_prompt_is_skipped(chat, monkeypatch, settings):
    settings.OPENAI_API_KEY = ""
    setup = Setup(chat)
    record = fake_engine_scan(monkeypatch, {})

    output, _ = setup.run_task("engines.p1.chatgpt")
    assert (output.status, output.error) == ("skipped", {
        "code": "not_configured", "message": "OPENAI_API_KEY is not set."})
    assert record["asked"] == []

    settings.OPENAI_API_KEY = "sk-test"
    gone = Setup(chat)
    from apps.prompt_library.models import BrandPrompt

    BrandPrompt.objects.filter(id=gone.prompts[0].brand_prompt_id).delete()
    output, _ = gone.run_task("engines.p1.chatgpt")
    assert (output.status, output.error["code"]) == ("skipped", "prompt_missing")


def test_an_engine_answer_stopped_before_the_question_stops_the_task(chat, monkeypatch,
                                                                    engines_on):
    setup = Setup(chat)
    fake_engine_scan(monkeypatch, {"gpt4": engine_answer(stopped=True, succeeded=False)})

    with pytest.raises(TaskStopped):
        setup.run_task("engines.p1.chatgpt")


# ── page_inspect ─────────────────────────────────────────────────────────


def test_your_page_is_your_best_ranking_result(chat, monkeypatch):
    setup = Setup(chat)
    setup.capture([(REVIEWS, "Best CRMs"), (YOURS, "Northwind CRM"),
                   ("https://www.northwind.example/other", "Other")])
    calls = fake_fetch(monkeypatch, {YOURS: browse_result(YOURS, title="Northwind CRM",
                                                          words=900, schema=["Organization"],
                                                          text_blocks=["We sell a CRM."])})

    output, _ = setup.run_task("site.p1.page")

    assert calls == [YOURS]
    assert (output.status, output.result, output.tone) == (
        "done", "Northwind CRM · 900 words · 1 schema type", None)
    assert output.target == "northwind.example/crm"
    capture_id = output.pane["tab_id"].split(":", 1)[1]
    assert output.pane == {"kind": "page", "tab_id": f"page:{capture_id}"}
    detail = output.detail
    assert (detail["role"], detail["position"], detail["chosen_because"]) == (
        "own", 2, "Ranks #2 on Google for this prompt")
    assert (detail["domain"], detail["status_code"], detail["reused_from"]) == (
        "northwind.example", 200, None)
    assert detail["seo"]["word_count"] == 900
    assert detail["seo"]["structured_data"] == ["Organization"]
    assert detail["seo"]["links"] == {"internal": 10, "external": 2}
    assert detail["excerpt"] == "We sell a CRM."
    stored = setup.ctx.emitter.research["pages"][capture_id]
    assert "reader" not in stored and stored["final_url"] == YOURS
    assert setup.swarm_run.page_texts["site.p1.page"]["text"] == "We sell a CRM."
    assert setup.steps("site.p1.page") == [
        "Choosing the page", "Reading northwind.example", "Reading SEO facts"]


def test_your_homepage_is_read_without_google_results(chat, monkeypatch):
    setup = Setup(chat, serp=False)
    fake_fetch(monkeypatch, {"https://northwind.example": browse_result(
        "https://northwind.example", title="Northwind")})

    output, _ = setup.run_task("site.p1.page")

    assert output.status == "done"
    assert output.detail["chosen_because"] == "Your homepage: Google results are not available"
    assert output.detail["position"] is None


def test_competitor_pages_prefer_named_then_tracked_competitors(chat, monkeypatch):
    setup = Setup(chat, options=PlanOptions(title="R", competitor_pages=2,
                                            competitors=("atlassian.com",)))
    setup.capture([(REVIEWS, "Best CRMs"), (HUBSPOT, "HubSpot CRM"), (ATLASSIAN, "Atlassian"),
                   ("https://www.hubspot.com/other", "HubSpot again"), (YOURS, "Northwind")])
    fake_fetch(monkeypatch, {url: browse_result(url, title=title) for url, title in (
        (ATLASSIAN, "Atlassian"), (HUBSPOT, "HubSpot CRM"))})

    first, _ = setup.run_task("competitors.p1.c1")
    second, _ = setup.run_task("competitors.p1.c2")

    assert (first.detail["url"], first.detail["chosen_because"]) == (
        ATLASSIAN, "Ranks #3 on Google for this prompt; a competitor you named")
    assert (second.detail["url"], second.detail["competitor_name"]) == (HUBSPOT, "HubSpot")
    assert second.detail["chosen_because"] == (
        "Ranks #2 on Google for this prompt; a tracked competitor")
    assert first.detail["role"] == "competitor"


def test_no_other_site_or_no_google_results_skip_the_competitor_page(chat, monkeypatch):
    setup = Setup(chat, options=PlanOptions(title="R", competitor_pages=2))
    output, _ = setup.run_task("competitors.p1.c1")
    assert (output.status, output.error) == ("skipped", {
        "code": "dependency_failed",
        "message": "The Google results for this prompt could not be read."})

    setup.capture([(YOURS, "Northwind"), (REVIEWS, "Best CRMs")])
    output, _ = setup.run_task("competitors.p1.c2")
    assert output.error == {"code": "nothing_to_analyze",
                            "message": "Google listed only 1 other site for this prompt."}


def test_a_page_two_tasks_want_is_fetched_once(chat, monkeypatch):
    setup = Setup(chat, prompts=1)
    setup.capture([(HUBSPOT, "HubSpot CRM")])
    calls = fake_fetch(monkeypatch, {HUBSPOT: browse_result(HUBSPOT, title="HubSpot CRM")})
    # The same page for another task of this execution (here: the first
    # competitor slot run twice under two task ids).
    first, _ = setup.run_task("competitors.p1.c1")
    job = setup.job("competitors.p1.c1")
    job.spec = {**job.spec, "id": "competitors.p2.c1", "label": "Competitor page 1"}
    second = workers.WORKERS["page_inspect"](job)

    assert calls == [HUBSPOT]
    assert second.detail["reused_from"] == "competitors.p1.c1"
    assert second.pane == first.pane
    assert "Same page as Competitor page 1" in setup.steps("competitors.p1.c1")
    pages = [e for e in run_events(setup.run)
             if e["type"] == "research.recorded" and e["kind"] == "page"]
    assert len(pages) == 1


def test_a_page_whose_reader_stopped_is_recorded_by_the_task_that_reuses_it(chat, monkeypatch):
    setup = Setup(chat)
    setup.capture([(HUBSPOT, "HubSpot CRM")])
    fake_fetch(monkeypatch, {HUBSPOT: browse_result(HUBSPOT, title="HubSpot CRM")})
    owner = setup.job("competitors.p1.c1")
    # The owner's time ran out while its fetch was in flight.
    owner.reporter.finished("failed", error={"code": "timeout", "message": "Timed out."})
    with pytest.raises(TaskStopped):
        workers.WORKERS["page_inspect"](owner)

    waiter = setup.job("competitors.p1.c1")
    waiter.spec = {**waiter.spec, "id": "competitors.p2.c1"}
    reused = workers.WORKERS["page_inspect"](waiter)

    capture_id = reused.pane["tab_id"].split(":", 1)[1]
    assert reused.status == "done" and reused.detail["reused_from"] == "competitors.p1.c1"
    assert capture_id in setup.ctx.emitter.research["pages"]


def test_page_fetch_failures_and_limits(chat, monkeypatch):
    setup = Setup(chat)
    setup.capture([(HUBSPOT, "HubSpot CRM")])
    fake_fetch(monkeypatch, {HUBSPOT: browse_result(HUBSPOT, error={
        "code": "timeout", "message": "The page took longer than 12 seconds to load."})})
    output, _ = setup.run_task("competitors.p1.c1")
    assert (output.status, output.error) == ("failed", {
        "code": "timeout", "message": "The page took longer than 12 seconds to load."})
    assert output.pane is None

    other = Setup(chat)
    other.capture([(HUBSPOT, "HubSpot CRM")])

    class Spent:
        def consume(self, key):
            return False

    monkeypatch.setattr("apps.agent.tools.research._browse_quota", lambda: Spent())
    output, _ = other.run_task("competitors.p1.c1")
    assert (output.status, output.error["code"]) == ("skipped", "browse_limit")

    blocked = Setup(chat)
    blocked.capture([(HUBSPOT, "HubSpot CRM")])
    monkeypatch.setattr("apps.agent.tools.research._may_fetch", lambda ctx, url: False)
    output, _ = blocked.run_task("competitors.p1.c1")
    assert (output.status, output.error["code"]) == ("skipped", "blocked_url")


@pytest.mark.parametrize("code,message", [
    ("too_large", "The page is larger than 2 MB."),
    ("not_html", "This address is not a web page."),
    ("too_complex", "The page has more than 60,000 HTML tags, too many to read here."),
    ("busy", "Too many pages are being read right now. Try again in a moment."),
])
def test_page_reasons_outside_the_task_codes_are_fetch_failed(chat, monkeypatch, code, message):
    """Contract 5c names the task error codes; a page that could not be read
    for another reason is fetch_failed, and its message keeps the reason."""
    setup = Setup(chat)
    setup.capture([(HUBSPOT, "HubSpot CRM")])
    fake_fetch(monkeypatch, {HUBSPOT: browse_result(HUBSPOT, error={"code": code,
                                                                     "message": message})})
    output, _ = setup.run_task("competitors.p1.c1")
    assert (output.status, output.error) == ("failed", {"code": "fetch_failed",
                                                         "message": message})


def test_an_analysis_that_never_started_is_a_timeout(chat, monkeypatch, engines_on):
    """The analysis model got no slot and no time while the task itself ran
    on: the measurement stays done and the analysis error uses a contract
    code (an engine answer and the cited sources keep their task done; the
    content gaps, an analysis only, fail)."""
    from apps.agent.llm.worker import HaikuResult

    monkeypatch.setattr("apps.agent.llm.worker.ask_haiku", lambda **kwargs: HaikuResult(
        ok=False, code="cancelled", message="Stopped before the analysis ran."))
    late = {"code": "timeout",
            "message": "The analysis did not start before this agent's time ran out."}
    setup = Setup(chat)
    fake_engine_scan(monkeypatch, {"gpt4": engine_answer(citations=["https://g2.com/a"])})
    output, _ = setup.run_task("engines.p1.chatgpt")
    assert (output.status, output.detail["analysis"], output.detail["analysis_error"]) == (
        "done", None, late)

    setup.done("engines.p1.chatgpt", output.detail)
    output, _ = setup.run_task("sources.p1.cited")
    assert (output.status, output.detail["analysis_error"]) == ("done", late)

    setup.done("site.p1.page", _page_detail(YOURS, "Northwind CRM") | {"role": "own"})
    setup.done("competitors.p1.c1", _page_detail(HUBSPOT, "HubSpot CRM"))
    output, _ = setup.run_task("site.p1.gaps")
    assert (output.status, output.error) == ("failed", late)


# ── content_gap ──────────────────────────────────────────────────────────


def _page_detail(url: str, title: str, *, excerpt: str = "", position=None) -> dict:
    from apps.agent.tools.shaping import host_of

    return {"role": "competitor", "url": url, "final_url": url, "domain": host_of(url),
            "title": title, "position": position, "excerpt": excerpt,
            "seo": {"title": title, "h1": [title], "h2": [], "word_count": 500,
                    "structured_data": [], "meta_description": None, "canonical": url}}


def test_content_gaps_keep_only_grounded_gaps(chat, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: {"headline": "HubSpot answers the question.", "gaps": [
        {"issue": "No comparison", "evidence": "HubSpot H2 'Compare'", "fix": "Add one.",
         "target": HUBSPOT, "severity": "high"},
        {"issue": "No pricing", "evidence": "HubSpot lists prices", "fix": "Show prices.",
         "target": "https://elsewhere.example/", "severity": "medium"},
        {"issue": "Thin page", "evidence": " ", "fix": "Write more.", "target": "",
         "severity": "low"}]}
    setup = Setup(chat)
    setup.done("site.p1.page", {**_page_detail(YOURS, "Northwind CRM"), "role": "own"})
    setup.done("competitors.p1.c1", _page_detail(HUBSPOT, "HubSpot CRM"))
    setup.swarm_run.page_texts.update({"site.p1.page": {"seo": {}, "text": "Our CRM."},
                                       "competitors.p1.c1": {"seo": {}, "text": "Their CRM."}})

    output, _ = setup.run_task("site.p1.gaps")

    assert (output.status, output.tone) == ("done", "warn")
    assert output.result == "2 gaps · HubSpot answers the question."
    assert [(g["issue"], g["target"]) for g in output.detail["gaps"]] == [
        ("No comparison", HUBSPOT), ("No pricing", "")]
    assert output.detail["compared"] == [
        {"role": "own", "url": YOURS, "title": "Northwind CRM"},
        {"role": "competitor", "url": HUBSPOT, "title": "HubSpot CRM"}]
    assert output.detail["note"] is None
    assert setup.steps("site.p1.gaps") == ["Comparing your page with hubspot.com",
                                           "Analyzing the gaps"]
    [request] = routed_anthropic.haiku_requests
    texts = [b["text"] for b in request.json["messages"][0]["content"]]
    assert any(t.startswith(f'<page role="own" url="{YOURS}">') and "Our CRM." in t
               for t in texts)
    assert sum(len(t) for t in texts) <= 24000


def test_content_gaps_from_saved_page_summaries(chat, routed_anthropic):
    setup = Setup(chat)
    setup.done("site.p1.page", {**_page_detail(YOURS, "Northwind", excerpt="Saved own text"),
                                "role": "own"})
    setup.done("competitors.p1.c1", _page_detail(HUBSPOT, "HubSpot", excerpt="Saved text"))

    output, _ = setup.run_task("site.p1.gaps")

    assert output.detail["note"] == "Compared with the page summaries an earlier version saved."
    texts = [b["text"] for b in routed_anthropic.haiku_requests[0].json["messages"][0]["content"]]
    assert any("Saved own text" in t for t in texts)


def test_content_gaps_need_both_pages(chat, routed_anthropic):
    setup = Setup(chat)
    output, _ = setup.run_task("site.p1.gaps")
    assert output.error == {"code": "nothing_to_analyze", "message": "Your page could not be read."}

    setup.done("site.p1.page", _page_detail(YOURS, "Northwind"))
    output, _ = setup.run_task("site.p1.gaps")
    assert output.error == {"code": "nothing_to_analyze",
                            "message": "No competitor page to compare with."}
    assert routed_anthropic.haiku_requests == []


def test_content_gap_analysis_failures(chat, routed_anthropic, monkeypatch):
    routed_anthropic.haiku = lambda purpose: refusal(text(""), model="claude-haiku-5-5")
    setup = Setup(chat)
    setup.done("site.p1.page", _page_detail(YOURS, "Northwind"))
    setup.done("competitors.p1.c1", _page_detail(HUBSPOT, "HubSpot"))

    output, _ = setup.run_task("site.p1.gaps")
    assert (output.status, output.error["code"]) == ("failed", "refused")

    monkeypatch.setattr("apps.agent.llm.worker.allowance_denial", lambda user: "spent")
    output, _ = setup.run_task("site.p1.gaps")
    assert (output.status, output.error) == ("skipped", {
        "code": "allowance_exceeded", "message": "The monthly AI allowance is used up."})


# ── citations ────────────────────────────────────────────────────────────


def _engine_detail(engine: str, urls: list[str]) -> dict:
    return {"engine": engine, "citations": [{"url": u} for u in urls]}


def test_cited_sources_are_counted_per_site(chat, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: {"headline": "Review sites lead.", "opportunities": [
        {"domain": "g2.com", "why": "Cited three times", "action": "Claim the listing."},
        {"domain": "unknown.example", "why": "Not listed", "action": "Nothing."}]}
    setup = Setup(chat)
    setup.done("engines.p1.chatgpt", _engine_detail("chatgpt", [
        "https://www.g2.com/a", "https://g2.com/b", "https://www.northwind.example/x"]))
    setup.done("engines.p1.claude", _engine_detail("claude", [
        "https://g2.com/c", "https://www.hubspot.com/y"]))
    setup.done("google.p1.page1", {"ai_overview": {"references": [
        {"url": "https://capterra.com/z", "domain": "capterra.com"},
        {"url": "https://g2.com/d", "domain": "g2.com"}]}})

    output, _ = setup.run_task("sources.p1.cited")

    detail = output.detail
    assert [(s["domain"], s["citations"], s["engines"]) for s in detail["sources"]] == [
        ("g2.com", 4, ["chatgpt", "claude", "ai_overview"]),
        ("capterra.com", 1, ["ai_overview"]),
        ("hubspot.com", 1, ["claude"]),
        ("northwind.example", 1, ["chatgpt"]),
    ]
    hubspot = detail["sources"][2]
    assert (hubspot["is_competitor"], hubspot["competitor_name"]) == (True, "HubSpot")
    assert detail["sources"][3]["is_yours"] is True
    assert detail["sources"][0]["example_url"] == "https://www.g2.com/a"
    assert (detail["total_citations"], detail["you_cited"], detail["overview_references"]) == (
        7, True, 2)
    assert detail["analysis"] == {"headline": "Review sites lead.", "opportunities": [
        {"domain": "g2.com", "why": "Cited three times", "action": "Claim the listing."}]}
    assert (output.result, output.tone) == (
        "4 sources · you're cited · g2.com cited 4 times", "good")


def test_no_citation_skips_and_a_failed_analysis_keeps_the_count(chat, routed_anthropic):
    setup = Setup(chat)
    # An engine answered and cited nothing: a measured "none cited".
    setup.done("engines.p1.chatgpt", _engine_detail("chatgpt", []))
    output, _ = setup.run_task("sources.p1.cited")
    assert (output.status, output.error) == ("skipped", {
        "code": "nothing_to_analyze", "message": "No engine cited a source for this prompt."})

    routed_anthropic.haiku = lambda purpose: "not json"
    setup.done("engines.p1.claude", _engine_detail("claude", ["https://g2.com/a"]))
    output, _ = setup.run_task("sources.p1.cited")
    assert output.status == "done"
    assert output.detail["analysis"] is None
    assert output.detail["analysis_error"] == {
        "code": "invalid_output", "message": "The analysis came back unreadable."}
    assert (output.result, output.tone) == (
        "1 source · you're not cited · g2.com cited 1 time", "warn")
