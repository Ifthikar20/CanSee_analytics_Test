"""Thread mode: the run executes on the process executor after commit,
and a stop from the API closes its live stream."""

import json
import threading

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime.events import get_event_store
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.usefixtures("no_title")]


class SlowStream:
    """A scripted response that pauses after ``pause_after`` SSE frames
    until ``release`` is set (or ``timeout`` passes)."""

    def __init__(self, scripted, *, pause_after: int, timeout: float = 5.0):
        self.scripted = scripted
        self.request_id = scripted.request_id
        self.pause_after = pause_after
        self.timeout = timeout
        self.reached = threading.Event()
        self.release = threading.Event()

    def sse_bytes(self):
        frames = [f for f in self.scripted.sse_bytes().split(b"\n\n") if f]

        def body():
            for i, frame in enumerate(frames):
                if i == self.pause_after:
                    self.reached.set()
                    self.release.wait(self.timeout)
                yield frame + b"\n\n"

        return body()


def _wait_terminal(run_id, timeout=15):
    store = get_event_store()
    after = 0
    for _ in range(100):
        result = store.read(str(run_id), after)
        if result.events:
            after = result.events[-1]["seq"]
            if result.terminal:
                return result.events[-1]
        store.wait(str(run_id), after, timeout / 100)
    raise AssertionError("the run did not finish")


@pytest.fixture
def thread_mode(settings):
    settings.AGENT_RUN_MODE = "thread"


@pytest.mark.usefixtures("thread_mode")
def test_send_returns_before_the_run_and_the_run_finishes_in_the_background(
    fake_anthropic, user, website,
):
    chat = make_chat(user, website)
    slow = SlowStream(message(text("Background reply.")), pause_after=3)
    fake_anthropic.queue(lambda request: slow)
    api = APIClient()
    api.force_authenticate(user)

    resp = api.post(reverse("agent-live-send", kwargs={"website_id": website.id,
                                                       "chat_id": chat.id}),
                    {"text": "Hi"}, format="json")

    assert resp.status_code == 202
    assert resp.json()["data"]["run"]["status"] in ("queued", "running")
    assert slow.reached.wait(5)
    slow.release.set()
    run_id = resp.json()["data"]["run"]["id"]
    assert _wait_terminal(run_id)["type"] == "run.completed"
    run = AgentRun.objects.get(id=run_id)
    assert run.status == "completed" and run.executor_id
    assert AgentMessage.objects.get(id=run.assistant_message_id).parts[0]["text"] == (
        "Background reply.")


@pytest.mark.usefixtures("thread_mode")
def test_cancel_from_the_api_stops_a_streaming_run(fake_anthropic, user, website):
    chat = make_chat(user, website)
    # Frames: start, ping, first block (start, 2 deltas, stop), then a pause
    # before the second block starts.
    slow = SlowStream(message(text("First block."), text("Second block.")),
                      pause_after=6, timeout=3)
    fake_anthropic.queue(lambda request: slow)
    api = APIClient()
    api.force_authenticate(user)
    sent = api.post(reverse("agent-live-send", kwargs={"website_id": website.id,
                                                       "chat_id": chat.id}),
                    {"text": "Hi"}, format="json").json()["data"]
    assert slow.reached.wait(5)

    resp = api.post(reverse("agent-live-cancel", kwargs={"run_id": sent["run"]["id"]}))
    assert resp.json()["data"]["status"] == "running"
    slow.release.set()

    assert _wait_terminal(sent["run"]["id"])["type"] == "run.cancelled"
    run = AgentRun.objects.get(id=sent["run"]["id"])
    msg = AgentMessage.objects.get(id=run.assistant_message_id)
    assert run.status == "cancelled" and msg.status == "cancelled"
    assert json.loads(msg.wire) == [{"role": "assistant", "content": [
        {"type": "text", "text": "First block."}]}]
