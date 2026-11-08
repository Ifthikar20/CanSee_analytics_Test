"""A run and its reply always end together, and a run past its deadline is
ended even when a tool hangs.

- The runner writes the run's terminal status and its message's in one
  transaction: when the message write fails twice, the run stays running
  (the sweeper ends both) instead of a finished run whose reply shows
  "Working" forever with Retry disabled.
- The sweeps settle a reply still "streaming" whose run has ended.
- The heartbeat stops a run still going a minute past its deadline; the
  runner ends it as failed with run_timeout, and the heartbeat no longer
  refreshes it, so a thread that never answers leaves a stale row.
"""
from __future__ import annotations

import json
from datetime import timedelta

import pytest
from django.db import OperationalError
from django.db.models.query import QuerySet
from django.utils import timezone

from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime import wire
from apps.agent.runtime.registry import OVERDUE_GRACE_SECONDS, ActiveRun, get_registry
from apps.agent.runtime.sweeper import (
    STRANDED_GRACE_SECONDS,
    settle_stranded_messages,
    sweep_chat,
    sweep_stale_runs,
)
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat, run_events, send

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]

OPEN_CALL = {"type": "tool_use", "id": "toolu_open", "name": "list_artifacts", "input": {}}


def _ended_run(chat, *, status: str, ended_ago: int, error_code="", error_message=""):
    """A run in ``status`` whose reply was left "streaming", with an open
    tool call and open parts."""
    question = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    reply = AgentMessage.objects.create(
        chat=chat, parent=question, role="assistant", status="streaming",
        wire=wire.dumps([wire.assistant_message([{"type": "text", "text": "Looking"},
                                                 OPEN_CALL])]),
        parts=[{"id": "p1", "type": "tool", "request": 1, "status": "running", "name": "x"}],
    )
    return AgentRun.objects.create(
        chat=chat, user=chat.user, website=chat.website, user_message=question,
        assistant_message=reply, status=status, error_code=error_code,
        error_message=error_message,
        finished_at=timezone.now() - timedelta(seconds=ended_ago),
    )


# ── One transaction ──────────────────────────────────────────────────────


def test_a_reply_that_cannot_be_saved_leaves_its_run_running(fake_anthropic, chat, monkeypatch):
    real = QuerySet.update

    def update(self, **kwargs):
        if self.model is AgentMessage and "finished_at" in kwargs:
            raise OperationalError("server closed the connection unexpectedly")
        return real(self, **kwargs)

    monkeypatch.setattr(QuerySet, "update", update)
    fake_anthropic.queue(message(text("Here is the answer.")))

    started = send(chat)

    run = AgentRun.objects.get(id=started.run.id)
    reply = AgentMessage.objects.get(id=started.assistant_message.id)
    # Never "completed" next to a reply that still says streaming.
    assert (run.status, reply.status) == ("running", "streaming")
    # The stream still ends, so no reader waits.
    assert run_events(run)[-1]["type"] == "run.failed"

    monkeypatch.setattr(QuerySet, "update", real)
    AgentRun.objects.filter(id=run.id).update(
        heartbeat_at=timezone.now() - timedelta(hours=1))
    assert sweep_stale_runs() == 1
    run.refresh_from_db()
    reply.refresh_from_db()
    assert (run.status, reply.status) == ("interrupted", "interrupted")


# ── Settling stranded replies ────────────────────────────────────────────


@pytest.mark.parametrize(("status", "error", "expected"), [
    ("completed", ("", ""), ("interrupted", "interrupted", "This reply was not saved completely.")),
    ("failed", ("run_cost_limit", "This reply reached the $3.00 cost limit for one reply."),
     ("failed", "run_cost_limit", "This reply reached the $3.00 cost limit for one reply.")),
    ("cancelled", ("", ""), ("cancelled", "", "")),
    ("interrupted", ("interrupted", "The agent process stopped before this reply finished."),
     ("interrupted", "interrupted", "The agent process stopped before this reply finished.")),
])
def test_a_streaming_reply_of_an_ended_run_ends_as_its_run(chat, status, error, expected):
    run = _ended_run(chat, status=status, ended_ago=STRANDED_GRACE_SECONDS + 5,
                     error_code=error[0], error_message=error[1])

    assert settle_stranded_messages() == 1

    reply = AgentMessage.objects.get(id=run.assistant_message_id)
    assert (reply.status, reply.error_code, reply.error_message) == expected
    assert reply.finished_at == run.finished_at
    assert reply.parts[0]["status"] == "error"
    assert json.loads(reply.wire)[-1] == wire.stopped_results(["toolu_open"])
    assert settle_stranded_messages() == 0


def test_a_run_that_just_ended_is_left_alone(chat):
    run = _ended_run(chat, status="completed", ended_ago=1)
    assert settle_stranded_messages() == 0
    assert AgentMessage.objects.get(id=run.assistant_message_id).status == "streaming"


def test_the_sweeps_settle_stranded_replies(chat, user, website):
    here = _ended_run(chat, status="failed", ended_ago=600, error_code="internal_error",
                      error_message="Something went wrong.")
    elsewhere = _ended_run(make_chat(user, website), status="cancelled", ended_ago=600)

    sweep_chat(chat.id)
    assert AgentMessage.objects.get(id=here.assistant_message_id).status == "failed"
    assert AgentMessage.objects.get(id=elsewhere.assistant_message_id).status == "streaming"

    sweep_stale_runs()
    assert AgentMessage.objects.get(id=elsewhere.assistant_message_id).status == "cancelled"


def test_an_active_runs_reply_is_never_settled(chat):
    run = _ended_run(chat, status="running", ended_ago=600)
    AgentRun.objects.filter(id=run.id).update(finished_at=None,
                                              created_at=timezone.now() - timedelta(hours=1))
    assert settle_stranded_messages() == 0


# ── The deadline watchdog ────────────────────────────────────────────────


def _live_run(chat, *, started_ago: int | None, status="running"):
    registry = get_registry()
    question = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    reply = AgentMessage.objects.create(chat=chat, parent=question, role="assistant",
                                        status="streaming")
    started = timezone.now() - timedelta(seconds=started_ago) if started_ago is not None else None
    run = AgentRun.objects.create(
        chat=chat, user=chat.user, website=chat.website, user_message=question,
        assistant_message=reply, status=status, executor_id=registry.executor_id,
        started_at=started, heartbeat_at=timezone.now() - timedelta(seconds=30),
    )
    return run, registry.register(run.id)


def test_the_heartbeat_stops_a_run_past_its_deadline(chat, user, website, settings):
    settings.AGENT_RUN_MAX_SECONDS = 600
    overdue_by = settings.AGENT_RUN_MAX_SECONDS + OVERDUE_GRACE_SECONDS + 5
    overdue, overdue_handle = _live_run(chat, started_ago=overdue_by)
    on_time, on_time_handle = _live_run(make_chat(user, website), started_ago=60)
    waiting, waiting_handle = _live_run(make_chat(user, website), started_ago=None,
                                        status="queued")
    before = AgentRun.objects.get(id=overdue.id).heartbeat_at

    get_registry().beat()

    assert overdue_handle.cancelled and overdue_handle.timed_out
    assert not on_time_handle.cancelled and not waiting_handle.cancelled
    # No more heartbeats for it: a thread that never answers goes stale.
    assert AgentRun.objects.get(id=overdue.id).heartbeat_at == before
    for run in (on_time, waiting):
        assert (timezone.now() - AgentRun.objects.get(id=run.id).heartbeat_at).seconds < 5
    for run in (overdue, on_time, waiting):
        get_registry().unregister(run.id)


def test_a_run_stopped_for_its_deadline_fails_with_run_timeout(fake_anthropic, chat,
                                                               monkeypatch):
    registry = get_registry()
    real_register = registry.register

    def register(run_id):
        active = real_register(run_id)
        if not isinstance(active, ActiveRun):
            return active
        active.timed_out = True
        active.cancel()
        return active

    monkeypatch.setattr(registry, "register", register)
    fake_anthropic.queue(message(text("Never sent.")))

    started = send(chat)

    run = AgentRun.objects.get(id=started.run.id)
    reply = AgentMessage.objects.get(id=started.assistant_message.id)
    assert (run.status, run.error_code) == ("failed", "run_timeout")
    assert (reply.status, reply.error_code) == ("failed", "run_timeout")
    failed = run_events(run)[-1]
    assert failed["type"] == "run.failed" and failed["error"] == {
        "code": "run_timeout", "message": "This reply took too long and was stopped.",
        "retryable": True}
    assert fake_anthropic.requests == []
