"""The event stream under ASGI, the way uvicorn serves it: the async
generator path through the full middleware stack, woken by events that a
runner thread appends while the stream waits."""
import json
import threading

import pytest
from django.test import AsyncClient
from django.urls import reverse
from rest_framework_simplejwt.tokens import AccessToken

from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime.events import get_event_store, now_iso
from apps.agent.tests.runtime_support import *  # noqa: F403

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


@pytest.fixture
def running(chat):
    question = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    reply = AgentMessage.objects.create(chat=chat, parent=question, role="assistant",
                                        status="streaming", depth=1)
    return AgentRun.objects.create(chat=chat, user=chat.user, website=chat.website,
                                   user_message=question, assistant_message=reply,
                                   status="running")


def _event(run, type, **payload):
    return {"type": type, "run_id": str(run.id), "message_id": str(run.assistant_message_id),
            "ts": now_iso(), **payload}


async def test_sse_under_asgi_streams_live_events_until_the_terminal_one(running, user):
    rid = str(running.id)
    store = get_event_store()
    store.open(rid)
    store.append(rid, _event(running, "run.started", chat_id=str(running.chat_id),
                             user_message_id=str(running.user_message_id),
                             model="claude-opus-5-5"))

    def runner_thread():
        store.append(rid, _event(running, "part.added", part={
            "id": "p1", "type": "text", "request": 1, "text": "Hello", "citations": []}))
        store.append(rid, _event(running, "run.completed", status="complete",
                                 stop_reason="end_turn", parts_seq=2, duration_ms=10))

    threading.Timer(0.3, runner_thread).start()
    url = reverse("agent-live-stream", kwargs={"run_id": rid})
    response = await AsyncClient().get(
        url, headers={"Authorization": f"Bearer {AccessToken.for_user(user)}"},
    )

    assert response.status_code == 200
    # The async generator: one event loop serves every open stream.
    assert response.is_async is True
    assert response["Content-Type"] == "text/event-stream; charset=utf-8"
    assert "no-transform" in response["Cache-Control"]
    assert response["X-Accel-Buffering"] == "no"
    body = b"".join([chunk async for chunk in response.streaming_content]).decode()
    assert body.startswith("retry: 3000\n")
    frames = []
    for block in body.split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.split("\n")
                      if line and not line.startswith(":") and ": " in line)
        if "data" in fields:
            frames.append((int(fields["id"]), fields["event"], json.loads(fields["data"])))
    assert [(seq, kind) for seq, kind, _ in frames] == [
        (1, "run.started"), (2, "part.added"), (3, "run.completed")]
    assert frames[1][2]["part"]["text"] == "Hello"
