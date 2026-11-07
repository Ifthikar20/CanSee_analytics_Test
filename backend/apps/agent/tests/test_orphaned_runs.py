"""A run an earlier agent process left behind (a deploy, a crash) ends as
soon as a reader asks the new process for it, so the reader's resync
settles on the interrupted reply instead of retrying until the sweeper
finds the heartbeat stale."""
import json

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework_simplejwt.tokens import AccessToken

from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime import wire
from apps.agent.runtime.registry import get_registry
from apps.agent.tests.api_support import client_for
from apps.agent.tests.runtime_support import *  # noqa: F403

pytestmark = pytest.mark.django_db

GONE = "old-container:7:1700000000"


def _running(chat, *, executor_id: str, status: str = "running") -> AgentRun:
    """A run mid-tool-call, as its process left it (fresh heartbeat)."""
    question = AgentMessage.objects.create(
        chat=chat, role="user", parts=[{"id": "p1", "type": "text", "text": "Research us"}],
        wire=wire.dumps([wire.user_message("Research us")]),
    )
    reply = AgentMessage.objects.create(
        chat=chat, parent=question, role="assistant", status="streaming", depth=1,
        parts=[{"id": "p1", "type": "serp", "request": 1, "query": "best crm", "page": 1,
                "location": "", "status": "running", "tab_id": "serp:abc",
                "brand_positions": [], "result_count": 0, "ai_overview_shown": False,
                "error": None}],
        wire=wire.dumps([wire.assistant_message([
            {"type": "tool_use", "id": "toolu_1", "name": "google_search",
             "input": {"query": "best crm"}},
        ])]),
    )
    return AgentRun.objects.create(
        chat=chat, user=chat.user, website=chat.website, user_message=question,
        assistant_message=reply, status=status, executor_id=executor_id,
        heartbeat_at=timezone.now(),
    )


def _sse(client, run, user) -> str:
    url = reverse("agent-live-stream", kwargs={"run_id": run.id})
    resp = client.get(url, HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(user)}")
    assert resp.status_code == 200
    return b"".join(resp.streaming_content).decode()


def test_stream_ends_a_run_another_process_left_behind(chat, user, client):
    run = _running(chat, executor_id=GONE)

    body = _sse(client, run, user)

    assert "event: resync" in body
    run.refresh_from_db()
    reply = AgentMessage.objects.get(id=run.assistant_message_id)
    assert (run.status, reply.status, reply.error_code) == (
        "interrupted", "interrupted", "interrupted")
    assert reply.parts[0]["status"] == "error"
    assert reply.parts[0]["error"]["code"] == "interrupted"
    # The stored turn stays valid for the next request: the open tool call
    # is answered.
    turn = wire.loads(reply.wire)
    assert turn[-1]["role"] == "user"
    assert turn[-1]["content"][0]["tool_use_id"] == "toolu_1"
    assert turn[-1]["content"][0]["is_error"] is True


def test_long_poll_ends_a_run_another_process_left_behind(chat, user):
    run = _running(chat, executor_id=GONE)
    url = reverse("agent-live-events", kwargs={"run_id": run.id})

    body = client_for(user).get(url, {"after": 3, "wait": 0}).json()

    assert body["run_status"] == "interrupted" and body["terminal"] is False
    assert [(e["type"], e["seq"], e["reason"]) for e in body["events"]] == [
        ("resync", 4, "buffer_missing")]


@pytest.mark.parametrize("owner", ["this process", ""])
def test_runs_of_this_process_or_not_yet_dispatched_are_left_alone(chat, user, owner):
    executor_id = get_registry().executor_id if owner else ""
    run = _running(chat, executor_id=executor_id, status="running" if owner else "queued")
    url = reverse("agent-live-events", kwargs={"run_id": run.id})

    body = client_for(user).get(url, {"after": 0, "wait": 0}).json()

    assert body["events"][0]["type"] == "resync"
    run.refresh_from_db()
    assert run.status == ("running" if owner else "queued")
    assert json.loads(AgentMessage.objects.get(id=run.assistant_message_id).wire)[-1][
        "role"] == "assistant"
