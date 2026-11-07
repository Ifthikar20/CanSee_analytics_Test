"""research.recorded names the swarm task that took the capture (pages
contract 7a): the reporter passes its task id, a capture recorded outside
a task carries null, and the event keeps the payload the contract pins."""
import threading
import time

import pytest

from apps.agent.runtime.emitter import RunEmitter
from apps.agent.runtime.events import get_event_store
from apps.agent.runtime.swarm import workers
from apps.agent.runtime.swarm.context import SwarmRun, TaskJob
from apps.agent.runtime.swarm.plan import PlanOptions, initial_task
from apps.agent.runtime.swarm.reporter import TaskReporter
from apps.agent.tests.contract_support import EVENT_PAYLOADS, assert_event
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events
from apps.agent.tests.swarm_support import *  # noqa: F403
from apps.agent.tests.swarm_support import (
    fake_serp,
    make_run,
    make_swarm,
    plan_prompts,
    serp_payload,
    tool_context,
)

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("swarm_limits")]

YOURS = "https://www.northwind.example/crm"
REVIEWS = "https://reviews.example/best-crm"


def _job(ctx, swarm, swarm_run, task_id: str) -> TaskJob:
    spec = next(t for t in swarm.tasks if t["id"] == task_id)
    reporter = TaskReporter(ctx.emitter, "p9", initial_task(spec), threading.Lock())
    reporter.started(workers.first_step(spec, swarm_run))
    return TaskJob(spec=spec, run=swarm_run, reporter=reporter, started=time.monotonic(),
                   deadline=time.monotonic() + 60)


def test_the_payload_pin_includes_the_task_id():
    assert EVENT_PAYLOADS["research.recorded"] == {"kind", "capture_id", "capture", "task_id"}


def test_each_google_page_capture_names_its_task(chat, monkeypatch):
    run = make_run(chat)
    prompts = plan_prompts(chat.website, 1)
    swarm, version = make_swarm(chat, run, prompts,
                                options=PlanOptions(title="Research", google_pages=2))
    ctx = tool_context(run)
    swarm_run = SwarmRun(ctx, swarm, version, deadline=time.monotonic() + 60, carried={})
    fake_serp(monkeypatch, {1: serp_payload([(REVIEWS, "Best CRMs")]),
                            2: serp_payload([(YOURS, "Northwind CRM")], start=10)})

    panes = {}
    for task_id in ("google.p1.page1", "google.p1.page2"):
        job = _job(ctx, swarm, swarm_run, task_id)
        output = workers.WORKERS[job.spec["worker"]](job)
        assert output.status == "done"
        assert job.reporter.finished(output.status, result=output.result, pane=output.pane)
        panes[task_id] = output.pane["tab_id"].split(":", 1)[1]

    events = run_events(run)
    recorded = [e for e in events if e["type"] == "research.recorded"]
    assert [(e["kind"], e["capture_id"], e["task_id"]) for e in recorded] == [
        ("serp", panes["google.p1.page1"], "google.p1.page1"),
        ("serp", panes["google.p1.page2"], "google.p1.page2"),
    ]
    for event in recorded:
        assert_event(event)
    # The capture is still announced before its task finishes.
    for event in recorded:
        recorded_at = events.index(event)
        finished_at = next(i for i, e in enumerate(events) if e["type"] == "task.finished"
                           and e["task_id"] == event["task_id"])
        assert recorded_at < finished_at


def test_a_capture_recorded_after_its_task_finished_is_dropped(chat):
    run = make_run(chat)
    prompts = plan_prompts(chat.website, 1)
    swarm, version = make_swarm(chat, run, prompts)
    ctx = tool_context(run)
    swarm_run = SwarmRun(ctx, swarm, version, deadline=time.monotonic() + 60, carried={})
    job = _job(ctx, swarm, swarm_run, "google.p1.page1")

    assert job.reporter.finished("failed", error={"code": "upstream_error", "message": "x"})
    assert not job.reporter.record_capture("serp", "late00000000", {"capture_id": "late00000000"})

    assert not [e for e in run_events(run) if e["type"] == "research.recorded"]


def test_a_capture_without_a_task_carries_a_null_task_id(chat):
    run = make_run(chat)
    get_event_store().open(str(run.id))
    emitter = RunEmitter(run, run.assistant_message)

    emitter.record_capture("serp", "abc123abc123", {"capture_id": "abc123abc123", "query": "crm"})
    emitter.record_capture("page", "def456def456", {"capture_id": "def456def456",
                                                    "reader": {"blocks": []}},
                           task_id="sources.p1.page1")

    serp, page = (e for e in run_events(run) if e["type"] == "research.recorded")
    assert "task_id" in serp and serp["task_id"] is None
    assert page["task_id"] == "sources.p1.page1"
    assert "reader" not in page["capture"]
    assert emitter.research["serp"]["abc123abc123"] == {"capture_id": "abc123abc123",
                                                        "query": "crm"}
