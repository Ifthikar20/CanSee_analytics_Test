"""The AI engines' answers a reply asks for (ChatGPT, Claude, Gemini, Grok,
Perplexity) count toward the reply's cost: the shown cost includes them,
and the per-reply cost ceiling and deadline are checked between engine
calls, not only before the agent's own model requests."""
from __future__ import annotations

import json
import threading
import time
from decimal import Decimal

import pytest

from apps.agent.constants import WorkerType
from apps.agent.llm.gate import GateStop
from apps.agent.llm.usage import UsageTotals
from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime.swarm import executor, workers
from apps.agent.runtime.swarm.context import WorkerOutput
from apps.agent.runtime.swarm.executor import execute_version
from apps.agent.runtime.swarm.plan import PlanOptions
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, send, tool_results_of
from apps.agent.tests.swarm_support import *  # noqa: F403
from apps.agent.tests.swarm_support import (
    UsageLog,
    engine_answer,
    fake_engine_scan,
    make_run,
    make_swarm,
    plan_prompts,
    tool_context,
)
from apps.agent.tools import research
from apps.agent.tools.schemas import CheckAiEnginesInput
from core import ai_tracking

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title", "engines",
                                                             "swarm_limits")]

SMALL = PlanOptions(title="Research", content_gaps=False, citations=False, competitor_pages=0)


@pytest.fixture
def engines(settings):
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.OPENAI_API_KEY = "sk-test"
    settings.PERPLEXITY_API_KEY = ""
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""


def _answer(user, website, *, tokens: int = 100_000):
    """What one engine answer records in the ledger (gpt-4o-mini)."""
    ai_tracking.record_usage(module="prompt_library", model_name="gpt-4o-mini",
                             input_tokens=tokens, output_tokens=tokens, user=user,
                             website=website, provider="openai")


def _row_cost(tokens: int = 100_000) -> Decimal:
    return Decimal(str(ai_tracking._estimate_cost("gpt-4o-mini", tokens, tokens)))


def _crawl(monkeypatch, *, answers_per_prompt: int = 1, on_answer=None):
    """A crawl_prompt that records ``answers_per_prompt`` engine answers,
    asking should_stop before each one as the real crawl does."""
    from apps.prompt_library.services.prompt_crawler import CrawlOutcome

    calls = []

    def crawl(website, prompt, *, only_missing=False, acting_user=None, should_stop=None,
              **_kwargs):
        calls.append({"prompt": prompt.id, "stopped_at": None})
        for n in range(answers_per_prompt):
            if should_stop is not None and should_stop():
                calls[-1]["stopped_at"] = n
                return CrawlOutcome(fanouts=[], responses=n, errors=[], stopped=True)
            (on_answer or _answer)(acting_user, website)
        return CrawlOutcome(fanouts=[], responses=answers_per_prompt, errors=[])

    monkeypatch.setattr("apps.prompt_library.services.prompt_crawler.crawl_prompt", crawl)
    return calls


# ── The capture ──────────────────────────────────────────────────────────


def test_a_capture_sees_only_the_rows_its_block_records(user, website):
    _answer(user, website)
    with ai_tracking.capture_usage() as outer:
        _answer(user, website)
        with ai_tracking.capture_usage() as inner:
            _answer(user, website)
    _answer(user, website)

    assert (outer.rows, inner.rows) == (2, 1)
    assert outer.cost_usd == 2 * _row_cost() and inner.cost_usd == _row_cost()
    assert outer.input_tokens == 200_000


def test_a_suppressed_duplicate_is_not_captured(user, website):
    with ai_tracking.capture_usage() as captured:
        for _ in range(2):
            ai_tracking.record_usage(module="prompt_library", model_name="gpt-4o-mini",
                                     input_tokens=10, output_tokens=10, user=user,
                                     idempotency_key="same-call")
    assert captured.rows == 1


# ── check_ai_engines ─────────────────────────────────────────────────────


def test_engine_answers_count_toward_the_replys_cost(fake_anthropic, chat, website, monkeypatch):
    bp = make_prompt(website, "best crm for startups")
    _crawl(monkeypatch, answers_per_prompt=2)
    fake_anthropic.queue(message(tool_use("check_ai_engines", {"prompt_ids": [str(bp.prompt_id)]},
                                          id="toolu_e"), stop_reason="tool_use"),
                         message(text("Done.")))

    started = send(chat, "Check the engines")

    from apps.accounts.models import AITokenUsage

    run = AgentRun.objects.get(id=started.run.id)
    reply = AgentMessage.objects.get(id=started.assistant_message.id)
    agent_cost = sum(r.estimated_cost_usd for r in AITokenUsage.objects.filter(module="agent"))
    engine_cost = 2 * _row_cost()
    assert run.cost_usd == pytest.approx(Decimal(str(agent_cost)) + engine_cost, abs=1e-6)
    assert reply.cost_usd == run.cost_usd
    # Engine answers are no model request of the reply.
    assert run.requests == 2
    usage = [e for e in run_events(run) if e["type"] == "run.usage"]
    assert usage[-1]["cost_usd"] == pytest.approx(float(run.cost_usd), abs=1e-6)


def _ctx_with_ceiling(run, ceiling: Decimal, *, inline: bool = True):
    """A tool context whose run stops once its cost (what add_usage got,
    plus what a tool has seen but not added) reaches ``ceiling``."""
    usage = UsageLog()
    ctx = tool_context(run, inline=inline, usage=usage)

    def budget_stop(extra_usd=None):
        if usage.cost + Decimal(str(extra_usd or 0)) >= ceiling:
            return GateStop("run_cost_limit",
                            "This reply reached the $0.01 cost limit for one reply.")
        return None

    ctx.budget_stop = budget_stop
    return ctx, usage


def test_the_cost_ceiling_stops_the_check_before_the_next_prompt(chat, website, monkeypatch):
    first = make_prompt(website, "best crm for startups")
    second = make_prompt(website, "best crm for dentists")
    calls = _crawl(monkeypatch)
    run = make_run(chat)
    ctx, usage = _ctx_with_ceiling(run, _row_cost())

    with pytest.raises(GateStop) as stopped:
        research.check_ai_engines(ctx, CheckAiEnginesInput(
            prompt_ids=[first.prompt_id, second.prompt_id]))

    assert stopped.value.code == "run_cost_limit"
    assert len(calls) == 1
    asked = first if calls[0]["prompt"] == first.prompt.id else second
    not_asked = second if asked is first else first
    assert usage.cost == _row_cost()
    assert all(totals.requests == 0 for _, totals in usage.calls)
    # The run answers the call with what was measured.
    partial = json.loads(stopped.value.tool_result.content)
    assert [p["prompt_id"] for p in partial["prompts"]] == [str(asked.prompt_id)]
    parts = [p for p in ctx.emitter.parts() if p["type"] == "engine_check"
             and p["prompt_id"] == str(not_asked.prompt_id) and p["status"] != "unavailable"]
    assert parts and {p["status"] for p in parts} == {"error"}


def test_no_further_engine_is_asked_once_the_ceiling_is_reached(chat, website, monkeypatch):
    bp = make_prompt(website, "best crm for startups")
    calls = _crawl(monkeypatch, answers_per_prompt=3)
    run = make_run(chat)
    # Two answers reach the ceiling; the crawl's third engine is not asked.
    ctx, usage = _ctx_with_ceiling(run, 2 * _row_cost())

    research.check_ai_engines(ctx, CheckAiEnginesInput(prompt_ids=[bp.prompt_id]))

    assert calls[0]["stopped_at"] == 2
    assert usage.cost == 2 * _row_cost()


def test_the_runs_deadline_stops_the_check(chat, website, monkeypatch):
    first = make_prompt(website, "best crm for startups")
    second = make_prompt(website, "best crm for dentists")
    calls = _crawl(monkeypatch)
    run = make_run(chat)
    ctx = tool_context(run)
    timed_out = GateStop("run_timeout", "This reply took too long and was stopped.",
                         retryable=True)
    ctx.budget_stop = lambda extra_usd=None: timed_out if calls else None

    with pytest.raises(GateStop) as stopped:
        research.check_ai_engines(ctx, CheckAiEnginesInput(
            prompt_ids=[first.prompt_id, second.prompt_id]))

    assert stopped.value.code == "run_timeout"
    assert len(calls) == 1


@pytest.mark.django_db(transaction=True)
def test_thread_mode_adds_engine_cost_on_the_runs_thread(chat, website, monkeypatch):
    prompts = [make_prompt(website, f"best crm for team {n}") for n in range(3)]

    def answer(user, website):
        # What record_usage does for a new ledger row, without the database
        # (the crawl runs on its own connection in thread mode).
        ai_tracking._note_captured(100_000, 100_000, _row_cost())

    calls = _crawl(monkeypatch, on_answer=answer)
    monkeypatch.setattr(research, "ENGINE_WORKERS", 1)
    run = make_run(chat)
    ctx, usage = _ctx_with_ceiling(run, 2 * _row_cost(), inline=False)

    with pytest.raises(GateStop):
        research.check_ai_engines(ctx, CheckAiEnginesInput(
            prompt_ids=[p.prompt_id for p in prompts]))

    here = threading.current_thread().name
    assert usage.calls and all(thread == here for thread, _ in usage.calls)
    assert usage.cost == 2 * _row_cost()
    # Two prompts were answered; a crawl started after that asked no engine.
    assert [c["stopped_at"] for c in calls[:2]] == [None, None]
    assert all(c["stopped_at"] == 0 for c in calls[2:])


# ── Research agents ──────────────────────────────────────────────────────


def test_a_research_agents_engine_answer_counts_toward_the_run(chat, website, monkeypatch,
                                                               routed_anthropic):
    from apps.agent.runtime.swarm.context import SwarmRun, TaskJob
    from apps.agent.runtime.swarm.plan import initial_task
    from apps.agent.runtime.swarm.reporter import TaskReporter

    def paid_answer(provider, variant, should_stop, on_step):
        _answer(chat.user, website)
        return engine_answer(mentioned=True, rank=1)

    fake_engine_scan(monkeypatch, {"gpt4": paid_answer})
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(website, 1), options=SMALL)
    usage = UsageLog()
    ctx = tool_context(run, usage=usage)
    swarm_run = SwarmRun(ctx, swarm, version, deadline=time.monotonic() + 60, carried={})
    spec = next(t for t in swarm.tasks if t["id"] == "engines.p1.chatgpt")
    reporter = TaskReporter(ctx.emitter, "p9", initial_task(spec), threading.Lock())
    reporter.started(workers.first_step(spec, swarm_run))
    job = TaskJob(spec=spec, run=swarm_run, reporter=reporter, started=time.monotonic(),
                  deadline=time.monotonic() + 60)

    output = workers.WORKERS[WorkerType.ENGINE_ANSWER](job)

    assert output.status == "done"
    engine = [t for _, t in usage.calls if t.cost_usd == _row_cost()]
    assert len(engine) == 1 and engine[0].requests == 0
    # Only the analysis is a worker request; the engine answer is not.
    assert swarm_run.worker_requests == 1
    assert swarm_run.cost_usd == usage.cost


def _paid(cost: Decimal):
    def worker(job):
        job.run.add_usage(UsageTotals(cost_usd=cost), requests=0)
        return WorkerOutput(status="done", result=f"Finished {job.task_id}")
    return worker


def _use(monkeypatch, worker):
    monkeypatch.setattr(workers, "WORKERS", {kind: worker for kind in (
        WorkerType.SERP_PAGE, WorkerType.ENGINE_ANSWER, WorkerType.PAGE_INSPECT,
        WorkerType.CONTENT_GAP, WorkerType.CITATIONS)})


@pytest.mark.parametrize("inline", [True, False])
def test_the_cost_ceiling_ends_a_research_early(chat, website, monkeypatch, settings, inline):
    settings.AGENT_SWARM_WORKERS = 1
    _use(monkeypatch, _paid(Decimal("0.01")))
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(website, 2), options=SMALL)
    ctx, usage = _ctx_with_ceiling(run, Decimal("0.01"), inline=inline)

    outcome = execute_version(ctx, swarm, version)

    statuses = [outcome.results[t["id"]]["status"] for t in swarm.tasks]
    assert statuses[0] == "done"
    assert "skipped" in statuses and statuses.count("done") < len(statuses)
    skipped = [outcome.results[t["id"]] for t in swarm.tasks
               if outcome.results[t["id"]]["status"] == "skipped"]
    assert {t["error"]["code"] for t in skipped} == {"cost_limit"}
    assert skipped[0]["error"]["message"] == "Not started: this reply reached its cost limit."
    assert outcome.status == "partial" and not outcome.cancelled
    assert usage.cost == Decimal("0.01") * statuses.count("done")
    assert executor.COST_PENDING["code"] == "cost_limit"


def test_tool_results_reach_the_model_after_an_engine_check(fake_anthropic, chat, website,
                                                           monkeypatch):
    """The check still answers normally when the ceiling is not reached."""
    bp = make_prompt(website, "best crm for startups")
    _crawl(monkeypatch)
    fake_anthropic.queue(message(tool_use("check_ai_engines", {"prompt_ids": [str(bp.prompt_id)]},
                                          id="toolu_e"), stop_reason="tool_use"),
                         message(text("Done.")))
    send(chat, "Check the engines")
    [result] = tool_results_of(fake_anthropic.requests[-1].json)
    assert result.get("is_error") is not True
