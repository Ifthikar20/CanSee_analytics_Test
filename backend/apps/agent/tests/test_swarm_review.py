"""Defects found in the review of the research agents' backend, one test
each, written to fail on the code as it was before the fix:

- the cited sources of a prompt whose engines all failed were reported as
  a measured "None cited" (0 sources) instead of an agent that could not run;
- a Google cell and finding claimed "Not in top 10" when only page 2 was
  read (page 1 failed or was skipped);
- a re-run whose run could not start left its version queued, and every
  later research_swarm rerun_of of that research was refused as busy;
- the analysis usage of two researches in one turn shared ledger keys, so
  the ledger dropped the second one's rows as replays (and a long task id
  made a key too long to store);
- an analysis that waited for a free analysis slot went out after Stop, or
  after the allowance ran out during the wait (both were checked only
  before the wait);
- after Stop the research call's one tool_result said "Stopped before this
  ran." although a table of what finished was made, so a later turn had no
  swarm_id for rerun_of.
"""
from __future__ import annotations

import json
import threading
import time

import pytest
from django.urls import reverse

from apps.accounts.models import AITokenUsage
from apps.agent.llm.worker import LEDGER_KEY_CHARS, ask_haiku
from apps.agent.models import AgentMessage, AgentRun, AgentSwarm, AgentSwarmVersion
from apps.agent.runtime import wire
from apps.agent.runtime.registry import ActiveRun
from apps.agent.runtime.swarm import limits
from apps.agent.runtime.swarm.context import SwarmRun
from apps.agent.runtime.swarm.executor import execute_version
from apps.agent.runtime.swarm.plan import PlanOptions
from apps.agent.runtime.swarm.prompts import ENGINE_SCHEMA, ENGINE_SYSTEM, EngineAnalysis
from apps.agent.runtime.swarm.workers.citations import NO_ANSWER
from apps.agent.services.swarm_tables import finalize_version
from apps.agent.tests.api_support import client_for, data
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, send
from apps.agent.tests.swarm_support import *  # noqa: F403
from apps.agent.tests.swarm_support import (
    engine_answer,
    fake_engine_scan,
    fake_serp,
    make_run,
    make_swarm,
    plan_prompts,
    serp_payload,
    tool_context,
)
from apps.agent.tests.test_swarm_api import store_swarm
from apps.agent.tests.test_swarm_tables import (
    PROMPT,
    brief,
    build_table,
    cell,
    expand,
    failure,
    fake_swarm,
    fake_version,
    finished,
    outcome_for,
    resolved,
    row_of,
    serp,
    serp_row,
    spec_of,
)
from apps.agent.tests.test_swarm_tool import StandIn
from apps.agent.tools.context import ToolError
from apps.agent.tools.swarm import _rerun_target

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("swarm_limits")]

ANALYSIS = {"summary": "It recommends HubSpot.", "reasons": ["Free tier"], "opportunity": ""}
CONTENT = [{"type": "text", "text": "<answer>\nHubSpot is the best CRM.\n</answer>"}]


# ── Cited sources when no engine answered ─────────────────────────────────


def test_cited_sources_of_a_prompt_no_engine_answered_are_not_a_measured_zero(
        chat, monkeypatch, settings, routed_anthropic):
    settings.OPENAI_API_KEY = "sk-test"
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=PlanOptions(
        title="Research", competitor_pages=0, content_gaps=False))
    fake_serp(monkeypatch, {1: serp_payload([("https://www.hubspot.com/crm", "HubSpot CRM")])})
    fake_engine_scan(monkeypatch, {
        "gpt4": engine_answer(error="openai: 429 rate limit"),
        "claude": engine_answer(error="claude: overloaded"),
    })
    ctx = tool_context(run)

    outcome = execute_version(ctx, swarm, version)

    assert [outcome.results[t]["status"] for t in ("engines.p1.chatgpt", "engines.p1.claude")] \
        == ["failed", "failed"]
    cited = outcome.results["sources.p1.cited"]
    assert (cited["status"], cited["error"]) == (
        "skipped", {"code": "dependency_failed", "message": NO_ANSWER})

    finalized = finalize_version(ctx, swarm, version, outcome)
    assert brief(cell(finalized.table, "cited")) == (
        "Skipped", None, "skipped", "muted", NO_ANSWER)
    sources = finalized.tool_result["prompts"][0]["sources"]
    assert sources == {"state": "skipped", "error": NO_ANSWER}


def test_an_engine_that_answered_without_citations_is_a_measured_none(chat, monkeypatch,
                                                                       routed_anthropic):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=PlanOptions(
        title="Research", competitor_pages=0, content_gaps=False))
    fake_serp(monkeypatch, {1: serp_payload([("https://www.hubspot.com/crm", "HubSpot CRM")])})
    # Claude answers without citing anything; ChatGPT has no key here.
    fake_engine_scan(monkeypatch, {"claude": engine_answer(brands=[("HubSpot", 1)])})
    ctx = tool_context(run)

    outcome = execute_version(ctx, swarm, version)

    assert outcome.results["engines.p1.claude"]["status"] == "done"
    cited = outcome.results["sources.p1.cited"]
    assert (cited["status"], cited["error"]["code"]) == ("skipped", "nothing_to_analyze")
    finalized = finalize_version(ctx, swarm, version, outcome)
    assert brief(cell(finalized.table, "cited")) == ("None cited", 0, "ok", None, None)


# ── Google absence when page 1 was not read ──────────────────────────────


@pytest.mark.parametrize("page1", [
    ("failed", failure("upstream_error", "The Google results could not be fetched.")),
    ("skipped", failure("daily_limit", "This project used its daily Google search allowance.")),
])
def test_google_absence_names_the_pages_read_when_page_one_was_not(page1):
    expansion = expand([resolved(1, PROMPT)], google_pages=2)
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    status, error = page1
    page2, pane2 = serp(2, top=[serp_row(11, "evernote.com", competitor="Evernote")],
                        capture="222222222222")
    results = {
        "google.p1.page1": finished(spec_of(swarm, "google.p1.page1"), status, error=error),
        "google.p1.page2": finished(spec_of(swarm, "google.p1.page2"), detail=page2,
                                    pane=pane2),
    }

    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)

    assert brief(cell(table, "google")) == (
        "Not on page 2", 1000, "not_found", "warn", "1 of 2 pages searched")
    finding = row_of(table, "prompts", "p1")["finding"]
    assert finding["title"] == f"Not on Google page 2 for “{PROMPT}”"
    assert "top 10" not in finding["detail"]
    # Nobody on page 2 is known to rank ahead of a brand page 1 may list.
    assert brief(cell(table, "ahead")) == (
        "Not measured", None, "not_measured", "muted", None)


def test_google_absence_over_the_pages_from_page_one_keeps_the_top_n_text():
    expansion = expand([resolved(1, PROMPT)], google_pages=2)
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    page1, pane1 = serp(1, top=[serp_row(1, "evernote.com", competitor="Evernote")])
    results = {
        "google.p1.page1": finished(spec_of(swarm, "google.p1.page1"), detail=page1,
                                    pane=pane1),
        "google.p1.page2": finished(spec_of(swarm, "google.p1.page2"), "failed",
                                    error=failure("upstream_error", "Google failed.")),
    }

    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)

    assert brief(cell(table, "google")) == (
        "Not in top 10", 1000, "not_found", "warn", "1 of 2 pages searched")
    assert row_of(table, "prompts", "p1")["finding"]["title"] == (
        f"Not in Google's top 10 for “{PROMPT}”")
    assert cell(table, "ahead")["text"] == "Evernote (Google #1)"


# ── A re-run whose run never started ──────────────────────────────────────


def test_a_rerun_that_could_not_start_does_not_leave_its_version_queued(user, chat,
                                                                         monkeypatch, settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0
    swarm = store_swarm(chat)

    def cannot_start(self, run, active):
        raise RuntimeError("the runner could not start")

    monkeypatch.setattr("apps.agent.runtime.runner.TurnRunner.__init__", cannot_start)
    resp = client_for(user).post(
        reverse("agent-live-swarm-rerun", kwargs={"website_id": swarm.website_id,
                                                  "swarm_id": swarm.id}),
        {"scope": "all"}, format="json")
    assert resp.status_code == 202
    run = AgentRun.objects.get(id=data(resp)["run"]["id"])
    assert run.status == "failed"

    version = AgentSwarmVersion.objects.get(swarm=swarm, version=2)
    assert (version.status, version.error_code) == ("error", "internal_error")
    assert version.finished_at is not None

    # The next turn's research_swarm(rerun_of=...) is not refused as busy.
    later = make_run(chat)
    assert _rerun_target(tool_context(later), swarm.id).id == swarm.id


def test_a_version_row_its_ended_run_left_does_not_make_the_research_busy(chat):
    swarm = store_swarm(chat)
    ended = make_run(chat, trigger="rerun", status="failed")
    AgentSwarmVersion.objects.create(swarm=swarm, version=2, scope="all",
                                     task_ids=[t["id"] for t in swarm.tasks],
                                     status="queued", run=ended)
    # (The context's run row is left completed: a chat has one active run.)
    ctx = tool_context(make_run(chat, status="completed"))
    assert _rerun_target(ctx, swarm.id).id == swarm.id

    # A version whose run is still going makes it busy.
    AgentRun.objects.filter(id=ended.id).update(status="running")
    with pytest.raises(ToolError) as refused:
        _rerun_target(ctx, swarm.id)
    assert refused.value.message == "That research is running now; wait for it to finish."


# ── The research call's tool_result after Stop ────────────────────────────


@pytest.mark.usefixtures("no_title")
def test_stop_answers_the_research_call_with_what_finished(fake_anthropic, chat, website,
                                                           settings, monkeypatch):
    settings.SERPAPI_KEY = "serp-test"
    settings.OPENAI_API_KEY = "sk-test"
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0
    bp = make_prompt(website, "best crm for startups", location="us")
    monkeypatch.setattr("apps.agent.runtime.swarm.executor.execute_version",
                        StandIn(status="cancelled"))
    fake_anthropic.queue(message(
        text("Starting the research agents."),
        tool_use("research_swarm", {"prompts": [{"prompt_id": str(bp.prompt_id)}]},
                 id="toolu_swarm"),
        stop_reason="tool_use"))

    run = send(chat, "Research Northwind").run

    run.refresh_from_db()
    assert run.status == "cancelled"
    reply = AgentMessage.objects.get(id=run.assistant_message_id)
    [result] = [block for m in wire.loads(reply.wire) for block in m["content"]
                if block.get("type") == "tool_result"]
    assert result["tool_use_id"] == "toolu_swarm"
    assert result.get("is_error") is None
    body = json.loads(result["content"])
    swarm = AgentSwarm.objects.get()
    assert (body["swarm_id"], body["version"], body["status"]) == (str(swarm.id), 1,
                                                                    "cancelled")
    assert body["table_shown"] is True
    # Stop still ends the turn: no report request follows.
    assert len(fake_anthropic.requests) == 1


# ── Analysis usage of two researches in one turn ──────────────────────────


def _analysis(swarm_run, task_id: str = "engines.p1.chatgpt"):
    return ask_haiku(run=swarm_run, task_id=task_id, worker="engine_answer",
                     purpose="engine_answer", system=ENGINE_SYSTEM, content=CONTENT,
                     schema=ENGINE_SCHEMA, output_model=EngineAnalysis, timeout=30.0)


def test_two_researches_in_one_turn_each_record_their_analysis_usage(chat, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: ANALYSIS
    run = make_run(chat)
    prompts = plan_prompts(chat.website, 1)
    first = make_swarm(chat, run, prompts)
    second = make_swarm(chat, run, prompts)

    for swarm, version in (first, second):
        swarm_run = SwarmRun(tool_context(run), swarm, version,
                             deadline=time.monotonic() + 60, carried={})
        assert _analysis(swarm_run).ok

    rows = list(AITokenUsage.objects.filter(metadata__task_id="engines.p1.chatgpt"))
    assert len(rows) == 2
    assert {row.metadata["swarm_id"] for row in rows} == {str(first[0].id), str(second[0].id)}
    assert len({row.idempotency_key for row in rows}) == 2


def _wait_for_a_slot(chat, monkeypatch, settings, *, denial):
    """An engine agent's analysis (thread mode) waiting for the only
    analysis slot, which another research holds. Returns (active run,
    thread, results); the slot is still held."""
    settings.AGENT_SWARM_HAIKU_CONCURRENCY = 1
    monkeypatch.setattr("apps.agent.llm.worker.allowance_denial", denial)
    waiting = threading.Event()
    acquire = limits.acquire

    def acquire_and_tell(name, timeout):
        waiting.set()
        return acquire(name, timeout)

    monkeypatch.setattr(limits, "acquire", acquire_and_tell)
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1))
    active = ActiveRun(run.id)
    swarm_run = SwarmRun(tool_context(run, inline=False, active=active), swarm, version,
                         deadline=time.monotonic() + 60, carried={})
    assert limits.try_acquire("haiku")
    results = []
    thread = threading.Thread(target=lambda: results.append(_analysis(swarm_run)),
                              name="agent-swarm-review-wait", daemon=True)
    thread.start()
    assert waiting.wait(5)
    return active, thread, results


def test_an_analysis_that_waited_for_a_slot_through_stop_sends_nothing(
        chat, monkeypatch, settings, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: ANALYSIS
    active, thread, results = _wait_for_a_slot(chat, monkeypatch, settings,
                                               denial=lambda user: None)

    active.cancel()
    limits.release("haiku")
    thread.join(10)

    assert (results[0].ok, results[0].code) == (False, "cancelled")
    assert routed_anthropic.haiku_requests == []
    # The slot it took after the wait was given back.
    assert limits.try_acquire("haiku")
    limits.release("haiku")


def test_an_analysis_whose_allowance_ran_out_during_the_wait_sends_nothing(
        chat, monkeypatch, settings, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: ANALYSIS
    checks = []

    def denial(user):
        checks.append(user)
        return None if len(checks) == 1 else "monthly_ai_allowance_exceeded"

    _, thread, results = _wait_for_a_slot(chat, monkeypatch, settings, denial=denial)

    limits.release("haiku")
    thread.join(10)

    assert (results[0].ok, results[0].code) == (False, "allowance_exceeded")
    assert routed_anthropic.haiku_requests == []
    assert len(checks) == 2


def test_a_long_task_id_still_fits_the_ledger_key(chat, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: ANALYSIS
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), version=12)
    swarm_run = SwarmRun(tool_context(run), swarm, version, deadline=time.monotonic() + 60,
                         carried={})
    task_id = "engines.p1." + "x" * 69

    assert _analysis(swarm_run, task_id).ok

    row = AITokenUsage.objects.get(metadata__task_id=task_id)
    assert len(row.idempotency_key) <= LEDGER_KEY_CHARS
    assert row.idempotency_key.startswith(f"agent:{run.id}:w")
