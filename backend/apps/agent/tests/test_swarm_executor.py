"""One execution of a research swarm (design section 7): inline order,
the thread pool's limits, timeouts, Stop, the time limit, carried
results, usage, database connections and the Google rank checks."""
import threading
import time
from decimal import Decimal

import pytest

from apps.agent.conf import agent_conf
from apps.agent.constants import WorkerType
from apps.agent.llm.usage import UsageTotals
from apps.agent.models import AgentMessage, AgentSwarmVersion
from apps.agent.runtime.parts import replay
from apps.agent.runtime.swarm import executor, workers
from apps.agent.runtime.swarm.context import TaskStopped, WorkerOutput
from apps.agent.runtime.swarm.executor import execute_version
from apps.agent.runtime.swarm.plan import PlanOptions
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events
from apps.agent.tests.swarm_support import *  # noqa: F403
from apps.agent.tests.swarm_support import (
    UsageLog,
    fake_serp,
    make_run,
    make_swarm,
    plan_prompts,
    serp_payload,
    tool_context,
    wait_for_swarm_threads,
)
from apps.search_gap.models import GoogleRankCheck

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("swarm_limits")]

ALL_WORKERS = (WorkerType.SERP_PAGE, WorkerType.ENGINE_ANSWER, WorkerType.PAGE_INSPECT,
               WorkerType.CONTENT_GAP, WorkerType.CITATIONS)
SMALL = PlanOptions(title="Research", content_gaps=False, citations=False, competitor_pages=0)


def _use(monkeypatch, worker, **by_type):
    table = {kind: by_type.get(kind, worker) for kind in ALL_WORKERS}
    monkeypatch.setattr(workers, "WORKERS", table)


def _done(job):
    return WorkerOutput(status="done", result=f"Finished {job.task_id}")


def _task_events(run, task_id):
    return [e for e in run_events(run) if e.get("task_id") == task_id]


def _part(run, part_id):
    message = AgentMessage.objects.get(id=run.assistant_message_id)
    return next(p for p in message.parts if p["id"] == part_id), message


def test_inline_mode_runs_the_tasks_in_task_order_and_saves_the_version(chat, monkeypatch):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 2))
    order = []

    def worker(job):
        order.append(job.task_id)
        job.reporter.step("Half way there")
        return WorkerOutput(status="done", result=f"Finished {job.task_id}", tone="good",
                            detail={"n": len(order)})

    _use(monkeypatch, worker)
    outcome = execute_version(tool_context(run), swarm, version)

    ids = [t["id"] for t in swarm.tasks]
    assert order == ids
    assert (outcome.status, outcome.cancelled, outcome.request) == ("done", False, 1)
    assert sorted(outcome.results) == sorted(ids)
    assert outcome.carried == {}
    version.refresh_from_db()
    assert version.status == "done"
    assert version.counts == {"total": len(ids), "done": len(ids), "failed": 0, "skipped": 0,
                              "stopped": 0}
    assert version.started_at is not None and version.finished_at is not None
    assert version.results["site.p1.gaps"]["result"] == "Finished site.p1.gaps"

    events = run_events(run)
    added = events[0]
    assert added["type"] == "part.added" and added["part"]["type"] == "swarm"
    part = added["part"]
    assert part["id"] == outcome.part_id
    assert (part["status"], part["version"], part["scope"], part["scope_label"]) == (
        "running", 1, "all", "All agents")
    assert part["limits"] == {"max_tasks": 50, "workers": 8}
    assert [t["status"] for t in part["tasks"]] == ["queued"] * len(ids)
    first = _task_events(run, "google.p1.page1")
    assert [(e["type"], e["rev"]) for e in first] == [
        ("task.started", 2), ("task.progress", 3), ("task.finished", 4)]
    assert first[0]["patch"]["step"] == "Fetching Google page 1"
    assert first[0]["patch"]["attempt"] == 1
    assert first[2]["patch"]["status"] == "done"
    assert first[2]["patch"]["tone"] == "good"
    last = events[-1]
    assert last["type"] == "part.updated"
    assert set(last["patch"]) == {"status", "ended_at", "duration_ms"}
    assert last["patch"]["status"] == "done"

    stored, message = _part(run, outcome.part_id)
    assert stored["status"] == "done"
    assert all(t["status"] == "done" for t in stored["tasks"])
    assert replay(events) == message.parts


def test_threads_respect_dependencies_and_the_swarm_worker_cap(chat, monkeypatch, settings):
    settings.AGENT_SWARM_WORKERS = 2
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 2))
    lock = threading.Lock()
    running, peak, started, finished = set(), [0], {}, {}

    def worker(job):
        with lock:
            started[job.task_id] = time.monotonic()
            running.add(job.task_id)
            peak[0] = max(peak[0], len(running))
        time.sleep(0.03)
        with lock:
            running.discard(job.task_id)
            finished[job.task_id] = time.monotonic()
        return _done(job)

    _use(monkeypatch, worker)
    outcome = execute_version(tool_context(run, inline=False), swarm, version)

    assert outcome.status == "done"
    assert peak[0] == 2
    for task in swarm.tasks:
        for dep in task["depends_on"]:
            assert finished[dep] <= started[task["id"]], (dep, task["id"])


def test_a_primary_resource_limit_holds_across_tasks(chat, monkeypatch, settings):
    settings.AGENT_SWARM_SERP_CONCURRENCY = 1
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 3), options=SMALL)
    lock = threading.Lock()
    serp_now, serp_peak, overlapped = [0], [0], []
    # Two Google tasks running at once would meet at this barrier.
    gate = threading.Barrier(2, timeout=0.1)

    def serp(job):
        with lock:
            serp_now[0] += 1
            serp_peak[0] = max(serp_peak[0], serp_now[0])
        try:
            gate.wait()
            overlapped.append(job.task_id)
        except threading.BrokenBarrierError:
            gate.reset()
        with lock:
            serp_now[0] -= 1
        return _done(job)

    _use(monkeypatch, _done, serp_page=serp)
    outcome = execute_version(tool_context(run, inline=False), swarm, version)

    assert outcome.status == "done"
    assert serp_peak[0] == 1
    assert overlapped == []


def test_a_task_past_its_limit_fails_and_its_late_output_is_dropped(chat, monkeypatch, settings,
                                                                     swarm_limits):
    settings.AGENT_SWARM_SERP_CONCURRENCY = 1
    monkeypatch.setattr(executor, "TASK_TIMEOUT", {**executor.TASK_TIMEOUT,
                                                   WorkerType.SERP_PAGE: 0.3})
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1),
                                task_ids=["google.p1.page1"])
    release = threading.Event()

    def stuck(job):
        release.wait(5)
        job.reporter.step("Too late")
        job.reporter.record_capture("serp", "latecapture1", {"capture_id": "latecapture1"})
        return WorkerOutput(status="done", result="Too late")

    _use(monkeypatch, _done, serp_page=stuck)
    ctx = tool_context(run, inline=False)
    outcome = execute_version(ctx, swarm, version)
    release.set()
    wait_for_swarm_threads()

    task = outcome.results["google.p1.page1"]
    assert task["status"] == "failed"
    assert task["error"] == {"code": "timeout", "message": "Timed out after 0.3 seconds."}
    events = _task_events(run, "google.p1.page1")
    assert events[-1]["type"] == "task.finished"
    assert "latecapture1" not in (ctx.emitter.research.get("serp") or {})
    assert not any(e["type"] == "research.recorded" for e in run_events(run))
    assert outcome.status == "partial"
    # The Google slot came back when the stuck call returned.
    assert swarm_limits.try_acquire("serp")
    swarm_limits.release("serp")


def test_stop_ends_running_and_waiting_tasks_within_a_second(chat, monkeypatch, settings):
    settings.AGENT_SWARM_WORKERS = 1
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL)

    def wait_for_stop(job):
        while not job.stopped():
            time.sleep(0.01)
        raise TaskStopped()

    _use(monkeypatch, wait_for_stop)
    ctx = tool_context(run, inline=False)
    pressed = []

    def press():
        pressed.append(time.monotonic())
        ctx.active.cancel()

    timer = threading.Timer(0.3, press)
    timer.start()
    outcome = execute_version(ctx, swarm, version)
    returned = time.monotonic()
    timer.join()
    wait_for_swarm_threads()

    assert returned - pressed[0] < 1.0
    assert (outcome.status, outcome.cancelled) == ("cancelled", True)
    first, *rest = (outcome.results[t["id"]] for t in swarm.tasks)
    assert (first["status"], first["error"]) == (
        "stopped", {"code": "stopped", "message": "Stopped"})
    assert rest and all(t["status"] == "stopped" and t["error"]["message"] ==
                        "Stopped before it started" and t["started_at"] is None for t in rest)
    version.refresh_from_db()
    assert version.status == "cancelled"
    stored, _ = _part(run, outcome.part_id)
    assert stored["status"] == "cancelled"


def test_the_research_time_limit_fails_running_tasks_and_skips_the_rest(chat, monkeypatch,
                                                                         settings):
    settings.AGENT_SWARM_WORKERS = 1
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL)

    def wait_for_stop(job):
        while not job.stopped():
            time.sleep(0.01)
        raise TaskStopped()

    _use(monkeypatch, wait_for_stop)
    conf = agent_conf()
    run_started = time.monotonic() - conf.run_max_seconds + executor.RUN_DEADLINE_MARGIN_SECONDS
    outcome = execute_version(tool_context(run, inline=False, run_started=run_started + 0.4),
                              swarm, version)
    wait_for_swarm_threads()

    first, *rest = (outcome.results[t["id"]] for t in swarm.tasks)
    assert first["status"] == "failed"
    assert first["error"] == {"code": "deadline",
                              "message": "Stopped at the research's time limit."}
    assert all(t["status"] == "skipped" and t["error"] == {
        "code": "deadline", "message": "Not started: the research reached its time limit."}
        for t in rest)
    assert (outcome.status, outcome.cancelled) == ("partial", False)


def test_carried_results_feed_the_tasks_of_a_scoped_rerun(chat, monkeypatch):
    first_run = make_run(chat, status="completed")
    swarm, first = make_swarm(chat, first_run, plan_prompts(chat.website, 1),
                              version_status="done")
    earlier = {t["id"]: {"id": t["id"], "status": "done", "result": f"v1 {t['id']}",
                         "rev": 4} for t in swarm.tasks}
    AgentSwarmVersion.objects.filter(id=first.id).update(results=earlier)
    run = make_run(chat, parent=first_run.assistant_message)
    site = [t["id"] for t in swarm.tasks if t["category"] == "site"]
    version = AgentSwarmVersion.objects.create(
        swarm=swarm, version=2, scope="category", scope_key="site", task_ids=site,
        status="queued", run=run, message=run.assistant_message)
    seen = {}

    def page(job):
        seen[job.task_id] = job.run.result("google.p1.page1")
        return _done(job)

    _use(monkeypatch, _done, page_inspect=page)
    outcome = execute_version(tool_context(run, inline=False), swarm, version)

    assert outcome.status == "done"
    assert sorted(outcome.results) == sorted(site)
    assert seen["site.p1.page"]["result"] == "v1 google.p1.page1"
    assert outcome.carried["engines.p1.claude"] == {
        "version": 1, "message_id": str(first_run.assistant_message_id),
        "task": earlier["engines.p1.claude"]}
    assert set(outcome.carried) == {t["id"] for t in swarm.tasks} - set(site)
    stored, _ = _part(run, outcome.part_id)
    assert [c["key"] for c in stored["categories"]] == ["site"]
    assert stored["scope_label"] == "Your site and content gaps"
    assert stored["categories"][0]["notes"][-1]["code"] == "carried"
    assert [t["id"] for t in stored["tasks"]] == site


def test_usage_is_handed_to_the_run_on_its_own_thread_without_requests(chat, monkeypatch):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL)

    def analyse(job):
        job.run.add_usage(UsageTotals(requests=1, input_tokens=100, output_tokens=10,
                                      cost_usd=Decimal("0.002")), requests=1)
        return _done(job)

    _use(monkeypatch, analyse)
    usage = UsageLog()
    outcome = execute_version(tool_context(run, inline=False, usage=usage), swarm, version)

    tasks = len(swarm.tasks)
    here = threading.current_thread().name
    assert usage.calls and all(thread == here for thread, _ in usage.calls)
    assert all(totals.requests == 0 for _, totals in usage.calls)
    assert usage.cost == Decimal("0.002") * tasks
    assert (outcome.worker_requests, outcome.cost_usd) == (tasks, Decimal("0.002") * tasks)
    version.refresh_from_db()
    assert (version.worker_requests, version.cost_usd) == (tasks, Decimal("0.002") * tasks)


def test_each_task_thread_closes_its_database_connections(chat, monkeypatch):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL)
    closed = []

    class Connections:
        def close_all(self):
            closed.append(threading.current_thread().name)

    monkeypatch.setattr(executor, "connections", Connections())
    _use(monkeypatch, _done)
    execute_version(tool_context(run, inline=False), swarm, version)
    wait_for_swarm_threads()

    assert sorted(closed) == sorted(f"agent-swarm-{t['id']}" for t in swarm.tasks)


def test_worker_errors_fail_only_their_task(chat, monkeypatch):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL)

    def broken(job):
        raise RuntimeError("secret page text")

    _use(monkeypatch, _done, engine_answer=broken, serp_page=lambda job: "not an output")
    outcome = execute_version(tool_context(run), swarm, version)

    error = {"code": "internal_error", "message": "This agent failed with an internal error."}
    assert outcome.results["engines.p1.claude"]["error"] == error
    assert outcome.results["google.p1.page1"]["error"] == error
    assert outcome.status == "partial"


def test_a_version_with_no_known_task_ends_in_error(chat):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), task_ids=["x.p1.y"])

    outcome = execute_version(tool_context(run), swarm, version)

    assert outcome.status == "error"
    assert outcome.error == {"code": "internal_error",
                             "message": "This research has no agents to run."}
    version.refresh_from_db()
    assert (version.status, version.error_code) == ("error", "internal_error")
    stored, _ = _part(run, outcome.part_id)
    assert stored["status"] == "error" and stored["tasks"] == []


def _serp_only(monkeypatch):
    from apps.agent.runtime.swarm.workers import serp_page

    _use(monkeypatch, _done, serp_page=serp_page.run)


def test_a_definite_google_answer_is_recorded_as_the_prompts_rank(chat, monkeypatch):
    run = make_run(chat)
    prompts = plan_prompts(chat.website, 2)
    swarm, version = make_swarm(chat, run, prompts, options=SMALL)
    fake_serp(monkeypatch, lambda query, page: serp_payload(
        [("https://www.northwind.example/crm", "Northwind CRM")] if query.endswith("1")
        else [("https://hubspot.com/crm", "HubSpot CRM")]))
    _serp_only(monkeypatch)

    outcome = execute_version(tool_context(run), swarm, version)

    # p1 found at #1; p2 not in the top 10 of a deeper search, which says nothing.
    assert outcome.rank_checks == {"p1": True, "p2": False}
    check = GoogleRankCheck.objects.get()
    assert (check.position, check.location, check.pages_fetched) == (1, "us", 1)
    assert check.brand_prompt_id == prompts[0].brand_prompt_id or str(check.brand_prompt_id) == \
        prompts[0].brand_prompt_id


def test_no_rank_check_when_a_google_page_failed(chat, monkeypatch):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=SMALL)
    fake_serp(monkeypatch, {1: serp_payload(error="decode")})
    _serp_only(monkeypatch)

    outcome = execute_version(tool_context(run), swarm, version)

    assert outcome.rank_checks == {"p1": False}
    assert not GoogleRankCheck.objects.exists()
