"""The in-process event buffers behind SSE and long-poll."""

import asyncio
import threading
import time

from apps.agent.runtime import events as events_module
from apps.agent.runtime.events import MemoryEventStore, resync_event
from apps.agent.runtime.parts import PartsState, replay, strip_nul


def _ev(kind="part.added", **payload):
    return {"type": kind, "run_id": "r", "message_id": "m", "ts": "t", **payload}


def test_append_assigns_seq_and_reads_after():
    store = MemoryEventStore()
    store.open("r")
    first = store.append("r", _ev())
    second = store.append("r", _ev("run.completed"))
    assert (first["v"], first["seq"], second["seq"]) == (1, 1, 2)
    assert [e["seq"] for e in store.read("r", 0).events] == [1, 2]
    after_one = store.read("r", 1)
    assert [e["seq"] for e in after_one.events] == [2] and after_one.terminal
    assert store.read("r", 2).events == [] and not store.read("r", 2).terminal
    assert store.last_seq("r") == 2
    assert store.read("r", 0, limit=1).events == [first]


def test_resync_when_behind_or_missing():
    store = MemoryEventStore(maxlen=3)
    for _ in range(5):
        store.append("r", _ev())
    assert store.read("r", 0).resync == "behind_buffer"
    assert [e["seq"] for e in store.read("r", 2).events] == [3, 4, 5]
    assert store.read("other", 0).resync == "buffer_missing"
    control = resync_event("r", "m", after=4, reason="behind_buffer")
    assert (control["type"], control["seq"], control["reason"]) == ("resync", 5, "behind_buffer")


def test_wait_wakes_on_append_and_times_out():
    store = MemoryEventStore()
    store.open("r")
    assert store.wait("r", 0, 0.05) is False
    threading.Timer(0.05, lambda: store.append("r", _ev())).start()
    started = time.monotonic()
    assert store.wait("r", 0, 5) is True
    assert time.monotonic() - started < 2
    assert store.wait("missing", 0, 0.01) is False


def test_async_wait_is_woken_from_another_thread():
    store = MemoryEventStore()
    store.open("r")

    async def scenario():
        threading.Timer(0.05, lambda: store.append("r", _ev())).start()
        woke = await store.wait_async("r", 0, 5)
        timed_out = await store.wait_async("r", 1, 0.05)
        return woke, timed_out

    assert asyncio.run(scenario()) == (True, False)


def test_finished_buffers_are_dropped_after_retention(monkeypatch):
    store = MemoryEventStore()
    store.append("old", _ev("run.completed"))
    monkeypatch.setattr(events_module, "RETAIN_AFTER_TERMINAL_SECONDS", -1)
    store.open("new")
    assert not store.has("old") and store.has("new")


def test_parts_reducer_rules():
    events = [
        _ev("part.added", part={"id": "p1", "type": "text", "request": 1, "text": "Hel"}),
        _ev("part.delta", part_id="p1", field="text", append="lo"),
        _ev("part.added", part={"id": "p2", "type": "tool", "request": 2, "status": "running"}),
        _ev("part.updated", part_id="p2", patch={"status": "done", "summary": "3 prompts"}),
        _ev("part.added", part={"id": "p3", "type": "text", "request": 2, "text": "x"}),
        _ev("turn.reset", request=2),
        _ev("run.usage", requests=1),
    ]
    assert replay(events) == [{"id": "p1", "type": "text", "request": 1, "text": "Hello"}]
    state = PartsState([{"id": "p1", "type": "text", "text": "a"}])
    state.apply(_ev("part.delta", part_id="missing", append="x"))
    assert state.snapshot() == [{"id": "p1", "type": "text", "text": "a"}]
    assert strip_nul({"a\x00": ["b\x00c", 1]}) == {"a": ["bc", 1]}
