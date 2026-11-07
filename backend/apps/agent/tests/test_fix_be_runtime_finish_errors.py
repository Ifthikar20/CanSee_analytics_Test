"""A run always ends with one terminal event, also when the database fails.

execute() used to guard only the loop: when _finish raised (a dropped
connection, a Postgres restart) no terminal event was ever appended, the
row stayed running and open streams waited until their deadline. A
runner that could not even start left a registered, heart-beaten run
that held the chat. Now _finish is retried once on a new connection, a
terminal event goes out whatever happens, and a run that cannot start is
failed.
"""

import pytest
from django.db import OperationalError
from django.db.models.query import QuerySet

from apps.agent.api.v1.stream import sync_events
from apps.agent.constants import TERMINAL_EVENT_TYPES
from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime.events import get_event_store
from apps.agent.runtime.registry import get_registry
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events, send

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]

DROPPED = "server closed the connection unexpectedly"


def _failing_update(monkeypatch, model, *, when: str, times: int | None):
    """QuerySet.update raises OperationalError for ``model`` updates that set
    ``when``, ``times`` times (None: always)."""
    real = QuerySet.update
    state = {"left": times}

    def update(self, **kwargs):
        if self.model is model and when in kwargs and state["left"] != 0:
            if state["left"] is not None:
                state["left"] -= 1
            raise OperationalError(DROPPED)
        return real(self, **kwargs)

    monkeypatch.setattr(QuerySet, "update", update)


def _terminal_events(run):
    return [e for e in run_events(run) if e["type"] in TERMINAL_EVENT_TYPES]


def test_finish_is_retried_once_when_saving_the_reply_fails(fake_anthropic, chat, monkeypatch):
    # The status compare-and-set went through, then the message update failed.
    _failing_update(monkeypatch, AgentMessage, when="finished_at", times=1)
    fake_anthropic.queue(message(text("Here is the answer.")))

    started = send(chat)

    run = AgentRun.objects.get(id=started.run.id)
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    assert run.status == "completed" and msg.status == "complete"
    assert [e["type"] for e in _terminal_events(run)] == ["run.completed"]
    assert run.last_seq == run_events(run)[-1]["seq"]


def test_a_database_that_stays_down_still_ends_the_stream(fake_anthropic, chat, monkeypatch):
    _failing_update(monkeypatch, AgentRun, when="finished_at", times=None)
    fake_anthropic.queue(message(text("Here is the answer.")))

    started = send(chat)

    run = AgentRun.objects.get(id=started.run.id)
    terminal = _terminal_events(run)
    assert [e["type"] for e in terminal] == ["run.failed"]
    assert terminal[0]["error"]["code"] == "internal_error"
    assert get_registry().get(run.id) is None
    # An open stream ends on that event instead of waiting for its deadline.
    frames = list(sync_events(get_event_store(), str(run.id), str(started.assistant_message.id),
                              0, 1))
    assert frames[-1].startswith(f"id: {terminal[0]['seq']}\nevent: run.failed")


def test_a_runner_that_cannot_start_fails_the_run(fake_anthropic, chat, monkeypatch):
    def broken(self, run, active):
        raise OperationalError(DROPPED)

    monkeypatch.setattr("apps.agent.runtime.runner.TurnRunner.__init__", broken)

    started = send(chat)

    run = AgentRun.objects.get(id=started.run.id)
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    assert run.status == "failed" and run.error_code == "internal_error"
    assert msg.status == "failed"
    assert [e["type"] for e in _terminal_events(run)] == ["run.failed"]
    assert get_registry().get(run.id) is None
    assert fake_anthropic.requests == []
