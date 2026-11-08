"""A reply that waits for a free run thread says so: its place in line is
on the run (``queue``) and in run.queued events, instead of a silent
"Starting" while AGENT_MAX_CONCURRENT_RUNS other replies run."""
from __future__ import annotations

import threading
import time

import pytest

from apps.agent.runtime import dispatch
from apps.agent.runtime.events import get_event_store
from apps.agent.tests import contract_support as contract
from apps.agent.tests.runtime_support import *  # noqa: F403


@pytest.fixture
def blocking(monkeypatch):
    """Run threads that hold each run until its event is set, and a
    RunThreads factory whose lines are emptied when the test ends (so no
    run left waiting reaches a later test's threads)."""
    gates: dict[str, threading.Event] = {}
    taken: list[str] = []
    pools: list[dispatch.RunThreads] = []

    def run_in_thread(run_id):
        taken.append(run_id)
        gates.setdefault(run_id, threading.Event()).wait(5)

    def make_pool(size):
        pool = dispatch.RunThreads(size)
        pools.append(pool)
        return pool

    monkeypatch.setattr(dispatch, "_run_in_thread", run_in_thread)
    yield gates, taken, make_pool
    for pool in pools:
        with pool._cond:
            pool._waiting.clear()
    for gate in list(gates.values()):
        gate.set()


def _wait_for(predicate, timeout: float = 2.0) -> None:
    end = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < end, "timed out"
        time.sleep(0.01)


def _queued(run_id: str) -> list[dict]:
    return [e for e in get_event_store().read(run_id, 0).events if e["type"] == "run.queued"]


def _open(*run_ids):
    for run_id in run_ids:
        get_event_store().open(run_id)


def test_runs_past_the_free_threads_wait_with_their_place_in_line(blocking):
    gates, taken, make_pool = blocking
    _open("r1", "r2", "r3")
    pool = make_pool(1)

    pool.submit("r1", "m1")
    _wait_for(lambda: taken == ["r1"])
    pool.submit("r2", "m2")
    pool.submit("r3", "m3")

    assert pool.queue_state("r1") is None
    assert pool.queue_state("r2") == {"position": 1, "ahead": 0, "slots": 1}
    assert pool.queue_state("r3") == {"position": 2, "ahead": 1, "slots": 1}
    assert _queued("r1") == []
    [event] = _queued("r2")
    assert set(event) == contract.EVENT_ENVELOPE | contract.EVENT_PAYLOADS["run.queued"]
    assert (event["run_id"], event["message_id"], event["position"]) == ("r2", "m2", 1)
    assert [e["position"] for e in _queued("r3")] == [2]

    gates.setdefault("r1", threading.Event()).set()
    _wait_for(lambda: taken == ["r1", "r2"])
    # r3 moved up: one new event, and r2 (now running) gets none.
    assert [e["position"] for e in _queued("r3")] == [2, 1]
    assert pool.queue_state("r3") == {"position": 1, "ahead": 0, "slots": 1}
    assert pool.queue_state("r2") is None and len(_queued("r2")) == 1


def test_a_run_a_free_thread_takes_never_reports_waiting(blocking):
    _gates, taken, make_pool = blocking
    _open("a", "b")
    pool = make_pool(2)
    pool.submit("a")
    pool.submit("b")
    _wait_for(lambda: sorted(taken) == ["a", "b"])
    assert _queued("a") == [] and _queued("b") == []
    assert pool.queue_state("a") is None


def test_a_run_stopped_while_waiting_leaves_the_line(blocking):
    _gates, taken, make_pool = blocking
    _open("x1", "x2", "x3")
    pool = make_pool(1)
    pool.submit("x1")
    _wait_for(lambda: taken == ["x1"])
    pool.submit("x2")
    pool.submit("x3")

    assert pool.withdraw("x2") is True
    assert pool.queue_state("x2") is None
    assert pool.queue_state("x3") == {"position": 1, "ahead": 0, "slots": 1}
    assert [e["position"] for e in _queued("x3")] == [2, 1]
    assert pool.withdraw("x2") is False


def test_queue_status_is_none_without_a_pool(monkeypatch):
    monkeypatch.setattr(dispatch, "_pool", None)
    assert dispatch.queue_status("anything") is None
    dispatch.withdraw("anything")  # no pool, nothing to do


# ── The run's payloads ───────────────────────────────────────────────────


@pytest.fixture
def waiting(monkeypatch):
    """queue_status reports these run ids as waiting."""
    waiting_ids: dict[str, dict] = {}
    monkeypatch.setattr(dispatch, "queue_status", lambda run_id: waiting_ids.get(str(run_id)))
    return waiting_ids


@pytest.mark.django_db
def test_the_run_payloads_carry_the_queue_while_the_run_waits(waiting, user, website):
    from rest_framework.test import APIClient

    from apps.agent.api.v1.serializers import RunSerializer
    from apps.agent.tests.runtime_support import make_chat
    from apps.agent.tests.swarm_support import make_run

    chat = make_chat(user, website)
    run = make_run(chat, status="queued")
    state = {"position": 3, "ahead": 2, "slots": 6}
    waiting[str(run.id)] = state

    assert RunSerializer(run).data["queue"] == state
    api = APIClient()
    api.force_authenticate(user)
    detail = api.get(f"/api/v1/agent/websites/{website.id}/chats/{chat.id}/").json()
    detail = detail.get("data", detail)
    assert detail["active_run"]["queue"] == state
    assert set(detail["active_run"]) == contract.ACTIVE_RUN
    assert set(state) == contract.RUN_QUEUE

    get_event_store().open(str(run.id))
    poll = api.get(f"/api/v1/agent/live/runs/{run.id}/events/", {"after": 0, "wait": 0}).json()
    assert poll["queue"] == state and poll["run_status"] == "queued"

    # A run that has a thread reports no queue, whatever the pool says.
    run.status = "running"
    run.save(update_fields=["status"])
    assert RunSerializer(run).data["queue"] is None
    poll = api.get(f"/api/v1/agent/live/runs/{run.id}/events/", {"after": 0, "wait": 0}).json()
    assert poll["queue"] is None


@pytest.mark.django_db
def test_stopping_a_queued_run_takes_it_out_of_the_line(monkeypatch, user, website):
    from apps.agent.runtime.cancel import request_cancel
    from apps.agent.tests.runtime_support import make_chat
    from apps.agent.tests.swarm_support import make_run

    withdrawn = []
    monkeypatch.setattr(dispatch, "withdraw", withdrawn.append)
    run = make_run(make_chat(user, website), status="queued")

    assert request_cancel(run) == "cancelled"
    assert withdrawn == [run.id]
    run.assistant_message.refresh_from_db()
    assert run.assistant_message.status == "cancelled"
