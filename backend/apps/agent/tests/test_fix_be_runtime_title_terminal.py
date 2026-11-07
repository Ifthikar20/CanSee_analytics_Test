"""A slow title neither delays the reply's end nor comes after it.

The runner used to wait up to 5 s for the title thread before finishing,
so a first turn (and a Stop on it) ended late; a title slower than that
emitted chat.updated after the terminal event, and a read of a batch
like [run.completed, chat.updated] did not count as terminal, so SSE
kept the stream open until its deadline.
"""

import threading
import time

import pytest

from apps.agent.constants import TERMINAL_EVENT_TYPES
from apps.agent.models import AgentChat
from apps.agent.runtime.emitter import RunEmitter
from apps.agent.runtime.events import MemoryEventStore, get_event_store
from apps.agent.runtime.title import fallback_title
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat, send


def _ev(kind, **payload):
    return {"type": kind, "run_id": "r", "message_id": "m", "ts": "t", **payload}


def test_a_batch_stops_at_the_terminal_event():
    store = MemoryEventStore()
    for kind in ("run.started", "run.completed", "chat.updated"):
        store.append("r", _ev(kind))

    first = store.read("r", 0)
    assert [e["type"] for e in first.events] == ["run.started", "run.completed"]
    assert first.terminal is True
    assert store.read("r", 1).terminal is True


def test_the_emitter_takes_no_event_after_the_terminal_one():
    class Row:
        id = "r"
        parts = []
        research = {}
        parts_seq = 0

    store = MemoryEventStore()
    emitter = RunEmitter(Row(), Row(), store=store)
    assert emitter.emit_before_end("chat.updated", title="Early") is not None
    emitter.emit("run.completed")
    assert emitter.ended is True
    assert emitter.emit_before_end("chat.updated", title="Late") is None
    assert [e["type"] for e in store.read("r", 0).events] == ["chat.updated", "run.completed"]


def _wait(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


@pytest.mark.django_db(transaction=True)
def test_a_slow_title_does_not_hold_up_the_end_of_the_reply(fake_anthropic, user, website,
                                                            settings):
    settings.AGENT_RUN_MODE = "thread"
    chat = make_chat(user, website)
    title_asked = threading.Event()
    release = threading.Event()

    def respond(request):
        if request.streamed:
            return message(text("Quick answer."))
        title_asked.set()
        release.wait(10)
        return message(text('{"title": "Northwind on Google"}'))

    fake_anthropic.queue(respond, respond)
    question = "How does Northwind rank on Google for best crm?"
    try:
        started = send(chat, question)
        run_id = str(started.run.id)
        store = get_event_store()

        def ended():
            return any(e["type"] in TERMINAL_EVENT_TYPES for e in store.read(run_id, 0).events)

        assert title_asked.wait(10)
        asked_at = time.monotonic()
        assert _wait(ended)
        # Ended while the title request was still open, and without waiting for it.
        assert not release.is_set()
        assert time.monotonic() - asked_at < 4.0
    finally:
        release.set()

    assert _wait(lambda: AgentChat.objects.get(id=chat.id).title_source == "model")
    assert AgentChat.objects.get(id=chat.id).title == "Northwind on Google"
    events = store.read(run_id, 0, limit=1000).events
    assert events[-1]["type"] == "run.completed"
    # Only the title the chat had at the start was sent; the late model
    # title was stored without an event after the terminal one.
    assert [e["title"] for e in events if e["type"] == "chat.updated"] == [
        fallback_title(question)]
