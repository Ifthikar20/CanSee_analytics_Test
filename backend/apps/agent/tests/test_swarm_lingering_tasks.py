"""A research agent that timed out is finished without its thread, but the
thread keeps its process slot until it returns (so the process never runs
more than AGENT_SWARM_PROCESS_WORKERS task threads), and usage it reports
after the research ended still reaches the run."""
from __future__ import annotations

import threading
import time
from decimal import Decimal

import pytest

from apps.agent.constants import WorkerType
from apps.agent.llm.usage import UsageTotals
from apps.agent.runtime.swarm import executor, workers
from apps.agent.runtime.swarm.context import SwarmRun, WorkerOutput
from apps.agent.runtime.swarm.executor import execute_version
from apps.agent.runtime.swarm.plan import PlanOptions
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.swarm_support import *  # noqa: F403
from apps.agent.tests.swarm_support import (
    UsageLog,
    make_run,
    make_swarm,
    plan_prompts,
    tool_context,
    wait_for_swarm_threads,
)

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("swarm_limits")]

SMALL = PlanOptions(title="Research", content_gaps=False, citations=False, competitor_pages=0)


def _use(monkeypatch, worker, **by_type):
    monkeypatch.setattr(workers, "WORKERS", {kind: by_type.get(kind, worker) for kind in (
        WorkerType.SERP_PAGE, WorkerType.ENGINE_ANSWER, WorkerType.PAGE_INSPECT,
        WorkerType.CONTENT_GAP, WorkerType.CITATIONS)})


def _done(job):
    return WorkerOutput(status="done", result=f"Finished {job.task_id}")


def test_a_timed_out_task_keeps_its_process_slot_until_its_thread_returns(
    chat, monkeypatch, settings, swarm_limits,
):
    settings.AGENT_SWARM_PROCESS_WORKERS = 1
    monkeypatch.setattr(executor, "TASK_TIMEOUT", {**executor.TASK_TIMEOUT,
                                                   WorkerType.SERP_PAGE: 0.2})
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL)
    release = threading.Event()
    lock = threading.Lock()
    live, peak = [0], [0]

    def counted(inner):
        def worker(job):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            try:
                return inner(job)
            finally:
                with lock:
                    live[0] -= 1
        return worker

    def stuck(job):
        release.wait(1.0)
        return _done(job)

    _use(monkeypatch, counted(_done), serp_page=counted(stuck))
    outcome = execute_version(tool_context(run, inline=False), swarm, version)
    release.set()
    wait_for_swarm_threads()

    assert outcome.results["google.p1.page1"]["error"]["code"] == "timeout"
    # One process slot: no second task thread ran next to the stuck one.
    assert peak[0] == 1
    # The engine tasks ran after the stuck thread returned, or were not
    # started before the research's time limit; none ran beside it.
    assert {outcome.results[t["id"]]["status"] for t in swarm.tasks
            if t["worker"] == WorkerType.ENGINE_ANSWER} <= {"done", "skipped"}
    # Every slot came back.
    assert swarm_limits.try_acquire("task")
    swarm_limits.release("task")


def test_usage_reported_after_the_research_ended_reaches_the_run(chat):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL)
    usage = UsageLog()
    swarm_run = SwarmRun(tool_context(run, inline=False, usage=usage), swarm, version,
                         deadline=time.monotonic() + 60, carried={})

    swarm_run.add_usage(UsageTotals(cost_usd=Decimal("0.002")))
    assert usage.calls == []  # queued for the run's own thread
    swarm_run.close_usage()
    assert usage.cost == Decimal("0.002")

    late = threading.Thread(target=swarm_run.add_usage,
                            args=(UsageTotals(cost_usd=Decimal("0.003")),))
    late.start()
    late.join()
    assert usage.cost == Decimal("0.005")
    assert all(totals.requests == 0 for _, totals in usage.calls)
    assert swarm_run.cost_usd == Decimal("0.005")


def test_a_late_analysis_of_a_timed_out_task_is_added_to_the_run(chat, monkeypatch, settings):
    monkeypatch.setattr(executor, "TASK_TIMEOUT", {**executor.TASK_TIMEOUT,
                                                   WorkerType.SERP_PAGE: 0.2})
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL,
                                task_ids=["google.p1.page1"])
    done = threading.Event()

    def slow_analysis(job):
        time.sleep(0.6)
        job.run.add_usage(UsageTotals(cost_usd=Decimal("0.004")), requests=1)
        done.set()
        return _done(job)

    _use(monkeypatch, _done, serp_page=slow_analysis)
    usage = UsageLog()
    outcome = execute_version(tool_context(run, inline=False, usage=usage), swarm, version)
    assert outcome.results["google.p1.page1"]["error"]["code"] == "timeout"
    assert usage.cost == 0

    assert done.wait(3)
    wait_for_swarm_threads()
    assert usage.cost == Decimal("0.004")
