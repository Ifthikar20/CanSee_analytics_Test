"""Event readers of a run that has ended get an answer at once instead of
being held open, and one user cannot hold more than a few readers."""
import asyncio
import gc
import json
import time

import pytest
from django.urls import reverse
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.agent.api.v1 import stream as stream_module
from apps.agent.api.v1.stream import async_events, open_reads, sync_events
from apps.agent.runtime.events import get_event_store
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import send

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


@pytest.fixture(autouse=True)
def _free_reads():
    open_reads._open.clear()
    yield
    open_reads._open.clear()


@pytest.fixture
def finished(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Hello.")))
    run = send(chat, "Hi").run
    return run, get_event_store().last_seq(str(run.id))


def _frames(body: str) -> list[dict]:
    out = []
    for block in body.split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.split("\n")
                      if line and not line.startswith(":") and ": " in line)
        if "data" in fields:
            out.append({**fields, "data": json.loads(fields["data"])})
    return out


def test_a_reader_past_the_terminal_event_gets_a_resync_at_once(finished):
    run, last = finished
    store = get_event_store()

    started = time.monotonic()
    body = "".join(sync_events(store, str(run.id), "m", last, max_seconds=300))
    frames = _frames(body)

    assert time.monotonic() - started < 2
    assert [(f["event"], f["data"]["reason"]) for f in frames] == [("resync", "run_ended")]

    async def collect():
        return "".join([c async for c in async_events(store, str(run.id), "m", last,
                                                      max_seconds=300)])

    assert _frames(asyncio.run(collect()))[0]["data"]["reason"] == "run_ended"


def test_reconnecting_to_a_finished_run_over_http_ends_at_once(finished, client, user):
    run, last = finished
    url = reverse("agent-live-stream", kwargs={"run_id": run.id})

    started = time.monotonic()
    resp = client.get(url, HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(user)}",
                      HTTP_LAST_EVENT_ID=str(last))
    body = b"".join(resp.streaming_content).decode()

    assert time.monotonic() - started < 2
    assert [f["data"]["reason"] for f in _frames(body)] == ["run_ended"]
    assert open_reads.held(user.id) == 0


def test_a_long_poll_on_a_finished_run_answers_without_waiting(finished, user):
    run, last = finished
    api = APIClient()
    api.force_authenticate(user)
    url = reverse("agent-live-events", kwargs={"run_id": run.id})

    started = time.monotonic()
    body = api.get(url, {"after": last, "wait": 25}).json()

    assert time.monotonic() - started < 2
    assert body == {"events": [], "next_after": last, "terminal": True,
                    "run_status": "completed"}
    assert open_reads.held(user.id) == 0


def test_one_user_holds_a_bounded_number_of_readers(finished, client, user):
    run, last = finished
    url = reverse("agent-live-stream", kwargs={"run_id": run.id})
    auth = {"HTTP_AUTHORIZATION": f"Bearer {AccessToken.for_user(user)}"}

    held = [client.get(url, **auth) for _ in range(stream_module.MAX_OPEN_READS_PER_USER)]
    assert all(r.status_code == 200 for r in held)

    refused = client.get(url, **auth)
    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "too_many_streams"
    assert refused["Retry-After"] == "3"
    api = APIClient()
    api.force_authenticate(user)
    poll = api.get(reverse("agent-live-events", kwargs={"run_id": run.id}), {"wait": 0})
    assert poll.status_code == 429 and poll.json()["error"]["code"] == "too_many_streams"

    # A stream read to its end gives its slot back.
    b"".join(held.pop().streaming_content)
    assert client.get(url, **auth).status_code == 200


def test_a_stream_that_is_never_read_gives_its_slot_back(finished, client, user):
    run, _ = finished
    url = reverse("agent-live-stream", kwargs={"run_id": run.id})
    resp = client.get(url, HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(user)}")
    assert open_reads.held(user.id) == 1

    del resp
    gc.collect()

    assert open_reads.held(user.id) == 0
