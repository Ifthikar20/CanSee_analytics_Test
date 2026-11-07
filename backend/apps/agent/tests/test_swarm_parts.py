"""Swarm parts and task events: the reducer (contract 4c), the
translator's planning part, the task reporter, the emitter's captures,
and how the runner, the sweeper and Stop close an open research."""
import json
import threading
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.utils import timezone

from apps.agent.constants import MessageStatus
from apps.agent.models import AgentMessage, AgentSwarmVersion
from apps.agent.runtime.cancel import request_cancel
from apps.agent.runtime.emitter import RunEmitter
from apps.agent.runtime.events import get_event_store
from apps.agent.runtime.parts import PartsState, replay
from apps.agent.runtime.registry import ActiveRun
from apps.agent.runtime.runner import Ending, TurnRunner
from apps.agent.runtime.swarm.plan import initial_task
from apps.agent.runtime.swarm.reporter import (
    DETAIL_MAX_CHARS,
    TaskReporter,
    add_swarm_part,
    fit_detail,
    planning_part_fields,
)
from apps.agent.runtime.sweeper import interrupt_runs
from apps.agent.runtime.translate import StreamTranslator
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events
from apps.agent.tests.swarm_support import make_run, make_swarm, plan_prompts

pytestmark = pytest.mark.django_db


def _task(task_id: str, status: str = "queued", rev: int = 1, **extra) -> dict:
    return {**initial_task({"id": task_id, "category": "google", "subcategory": "p1",
                            "worker": "serp_page", "label": "Google page 1", "target": "crm",
                            "depends_on": []}), "status": status, "rev": rev, **extra}


def _swarm_part(part_id: str = "p4", tasks=None, status: str = "running") -> dict:
    return {"id": part_id, "type": "swarm", "request": 1, **planning_part_fields(),
            "status": status, "swarm_id": "s1", "version": 1, "started_at": "2026-11-04T10:00:00Z",
            "tasks": tasks if tasks is not None else [_task("google.p1.page1")]}


def _event(kind: str, *, rev: int, patch: dict, part_id: str = "p4",
           task_id: str = "google.p1.page1") -> dict:
    return {"type": kind, "part_id": part_id, "task_id": task_id, "rev": rev, "patch": patch}


# ── Reducer ──────────────────────────────────────────────────────────────


def test_task_events_apply_in_rev_order_and_never_change_ids():
    state = PartsState([_swarm_part()])

    state.apply(_event("task.started", rev=2, patch={"status": "running", "step": "Fetching"}))
    state.apply(_event("task.progress", rev=3, patch={"step": "Reading", "id": "x", "rev": 99}))
    state.apply(_event("task.progress", rev=3, patch={"step": "Replayed"}))
    state.apply(_event("task.progress", rev=2, patch={"step": "Older"}))

    task = state.get("p4")["tasks"][0]
    assert (task["id"], task["status"], task["step"], task["rev"]) == (
        "google.p1.page1", "running", "Reading", 3)


def test_task_events_for_unknown_parts_or_tasks_change_nothing():
    other = {"id": "p5", "type": "tool", "request": 1, "status": "running",
             "tasks": [_task("google.p1.page1")]}
    state = PartsState([_swarm_part(), other])
    before = state.snapshot()

    state.apply(_event("task.finished", rev=2, patch={"status": "done"}, part_id="p9"))
    state.apply(_event("task.finished", rev=2, patch={"status": "done"}, task_id="nope"))
    state.apply(_event("task.finished", rev=2, patch={"status": "done"}, part_id="p5"))
    state.apply(_event("task.finished", rev="2", patch={"status": "done"}))

    assert state.snapshot() == before


def test_the_emitter_persists_what_the_events_replay(chat):
    run = make_run(chat)
    get_event_store().open(str(run.id))
    emitter = RunEmitter(run, run.assistant_message)
    swarm = SimpleNamespace(id="s1", title="Research")
    version = SimpleNamespace(version=1)
    tasks = [_task("google.p1.page1"), _task("engines.p1.claude")]
    part_id = add_swarm_part(emitter, part_id=None, request=1, swarm=swarm, version=version,
                             categories=[], tasks=tasks, scope="all", scope_label="All agents",
                             limits={"max_tasks": 30, "workers": 6}, started_at="x")
    lock = threading.Lock()
    first = TaskReporter(emitter, part_id, tasks[0], lock)
    second = TaskReporter(emitter, part_id, tasks[1], threading.Lock())

    first.started("Fetching Google page 1")
    first.step("Fetching Google page 1")
    first.retry()
    first.step("Fetching Google page 1")
    first.record_capture("serp", "abc123abc123", {"capture_id": "abc123abc123",
                                                   "query": "c\x00rm"})
    assert first.finished("done", result="You're #4", tone="good",
                          pane={"kind": "serp", "tab_id": "serp:abc123abc123"})
    assert not first.finished("failed")
    first.step("Late")
    first.record_capture("serp", "late00000000", {"capture_id": "late00000000"})
    second.finished("skipped", error={"code": "not_configured", "message": "Not set."})
    emitter.checkpoint(force=True)

    events = run_events(run)
    revs = [(e["type"], e["rev"], e.get("patch")) for e in events
            if e.get("task_id") == "google.p1.page1" and e["type"].startswith("task.")]
    assert [(kind, rev) for kind, rev, _ in revs] == [
        ("task.started", 2), ("task.progress", 3), ("task.finished", 4)]
    assert revs[1][2] == {"attempt": 2}
    assert revs[2][2]["duration_ms"] >= 0 and revs[2][2]["step"] == ""
    recorded = [e for e in events if e["type"] == "research.recorded"]
    assert [(e["kind"], e["capture_id"], e["capture"]["query"]) for e in recorded] == [
        ("serp", "abc123abc123", "crm")]
    message = AgentMessage.objects.get(id=run.assistant_message_id)
    assert replay(events) == message.parts
    stored = message.parts[0]["tasks"]
    assert (stored[0]["status"], stored[0]["attempt"], stored[0]["rev"]) == ("done", 2, 4)
    assert (stored[1]["status"], stored[1]["duration_ms"], stored[1]["started_at"]) == (
        "skipped", 0, None)
    assert message.research["serp"] == {"abc123abc123": {"capture_id": "abc123abc123",
                                                         "query": "crm"}}
    assert first.task == stored[0]


def test_page_captures_are_stored_without_their_reader(chat):
    run = make_run(chat)
    get_event_store().open(str(run.id))
    emitter = RunEmitter(run, run.assistant_message)

    emitter.record_capture("page", "def456def456", {"capture_id": "def456def456",
                                                    "reader": {"blocks": []}, "seo": {}})

    assert emitter.research["pages"]["def456def456"] == {"capture_id": "def456def456",
                                                         "seo": {}}
    [event] = run_events(run)
    assert "reader" not in event["capture"] and event["kind"] == "page"


def test_detail_is_trimmed_to_its_limit():
    detail = {"top": [{"title": "t" * 400} for _ in range(30)], "query": "crm"}

    fitted = fit_detail(detail)

    assert len(json.dumps(fitted)) <= DETAIL_MAX_CHARS
    assert fitted["query"] == "crm" and 0 < len(fitted["top"]) < 30
    huge = {"text": "x" * 20000}
    assert len(json.dumps(fit_detail(huge))) <= DETAIL_MAX_CHARS
    assert fit_detail(None) is None


# ── Translator ───────────────────────────────────────────────────────────


def test_the_translator_adds_the_planning_part_and_its_title(chat):
    run = make_run(chat)
    get_event_store().open(str(run.id))
    emitter = RunEmitter(run, run.assistant_message)
    translator = StreamTranslator(emitter, 1)
    block = {"type": "tool_use", "id": "toolu_s", "name": "research_swarm", "input": {}}

    translator.handle(SimpleNamespace(type="content_block_start", index=0, content_block=block))
    translator.handle(SimpleNamespace(
        type="content_block_stop", index=0,
        content_block={**block, "input": {"title": "  Research Northwind  ", "prompts": []}}))

    [added, updated] = run_events(run)
    assert added["type"] == "part.added"
    assert added["part"] == {"id": "p1", "type": "swarm", "request": 1, **planning_part_fields()}
    assert updated["patch"] == {"title": "Research Northwind"}
    assert translator.tool_parts == {"toolu_s": "p1"}


# ── Closing an open research ─────────────────────────────────────────────


def _runner_with_open_swarm(chat):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1))
    get_event_store().open(str(run.id))
    runner = TurnRunner(run, ActiveRun(run.id))
    tasks = [_task("google.p1.page1", "done", 4),
             _task("engines.p1.claude", "running", 2, started_at="2026-11-04T10:00:00Z"),
             _task("site.p1.page", "queued")]
    runner.emitter.emit("part.added", part={**_swarm_part("p1", tasks), "request": 1})
    return run, runner, version


@pytest.mark.parametrize("ending,code,message,part_status,version_status", [
    (Ending(MessageStatus.CANCELLED), "stopped", "Stopped", "cancelled", "cancelled"),
    (Ending(MessageStatus.FAILED, error={"code": "run_timeout", "message": "Too long."}),
     "internal_error", "Not finished", "error", "error"),
])
def test_the_runner_closes_an_open_swarm_part_when_the_run_ends(chat, ending, code, message,
                                                                part_status, version_status):
    run, runner, version = _runner_with_open_swarm(chat)

    runner._finish(ending)

    stored = AgentMessage.objects.get(id=run.assistant_message_id).parts[0]
    assert stored["status"] == part_status and stored["ended_at"]
    done, running, queued = stored["tasks"]
    assert (done["status"], done["rev"]) == ("done", 4)
    for task, rev in ((running, 3), (queued, 2)):
        assert (task["status"], task["error"], task["rev"], task["step"]) == (
            "stopped", {"code": code, "message": message}, rev, "")
    assert queued["duration_ms"] == 0
    version.refresh_from_db()
    assert version.status == version_status and version.finished_at is not None
    if version_status == "error":
        assert (version.error_code, version.error_message) == ("run_timeout", "Too long.")
    types = [e["type"] for e in run_events(run)]
    assert types.index("part.updated") < types.index(
        "run.cancelled" if part_status == "cancelled" else "run.failed")


def test_the_sweeper_interrupts_an_open_swarm_and_its_version(chat):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1))
    tasks = [_task("google.p1.page1", "done", 4),
             _task("engines.p1.claude", "running", 3, started_at="2026-11-04T10:00:00Z"),
             _task("site.p1.page", "queued")]
    table = {"id": "p2", "type": "swarm_table", "request": 1, "status": "partial"}
    finished = _swarm_part("p3", [_task("x.p1.y", "done", 4)], status="partial")
    AgentMessage.objects.filter(id=run.assistant_message_id).update(
        parts=[_swarm_part("p1", tasks), table, finished])

    assert interrupt_runs([run.id], reason="stale") == 1

    parts = AgentMessage.objects.get(id=run.assistant_message_id).parts
    swarm_part = parts[0]
    assert swarm_part["status"] == "interrupted" and swarm_part["ended_at"]
    assert swarm_part["duration_ms"] >= 0
    done, running, queued = swarm_part["tasks"]
    assert done == tasks[0]
    for task, rev in ((running, 4), (queued, 2)):
        assert (task["status"], task["step"], task["error"], task["rev"]) == (
            "stopped", "", {"code": "interrupted", "message": "Interrupted"}, rev)
    assert parts[1] == table and parts[2] == finished
    version.refresh_from_db()
    assert (version.status, version.error_code) == ("interrupted", "interrupted")
    assert version.error_message == "The agent process stopped before this research finished."


def test_stopping_a_queued_rerun_cancels_its_version(chat):
    run = make_run(chat, trigger="rerun", status="queued")
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1),
                                version_status="queued")

    assert request_cancel(run) == "cancelled"

    version.refresh_from_db()
    assert version.status == "cancelled" and version.finished_at is not None
    assert AgentSwarmVersion.objects.filter(status="queued").count() == 0


def test_a_stale_run_without_a_heartbeat_is_swept_with_its_version(chat):
    from apps.agent.models import AgentRun
    from apps.agent.runtime.sweeper import sweep_chat

    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1))
    AgentRun.objects.filter(id=run.id).update(
        heartbeat_at=timezone.now() - timedelta(hours=1))

    assert sweep_chat(chat.id) == 1
    version.refresh_from_db()
    assert version.status == "interrupted"
