"""The live endpoints: starting and stopping runs, SSE and long-poll."""

import asyncio
import json
import threading
import time

import pytest
from django.urls import reverse
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.accounts.models import AITokenUsage, Organization, OrganizationMember
from apps.agent.api.v1.stream import async_events, frame
from apps.agent.models import AgentChat, AgentMessage, AgentRun
from apps.agent.runtime.events import MemoryEventStore, get_event_store, set_event_store
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat, send

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


@pytest.fixture
def api(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


def _send_url(chat):
    return reverse("agent-live-send", kwargs={"website_id": chat.website_id, "chat_id": chat.id})


def _msg_url(name, chat, message_id):
    return reverse(name, kwargs={"website_id": chat.website_id, "message_id": message_id})


def _queued_run(chat):
    user_msg = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    reply = AgentMessage.objects.create(chat=chat, parent=user_msg, role="assistant",
                                        status="streaming")
    return AgentRun.objects.create(chat=chat, user=chat.user, website=chat.website,
                                   user_message=user_msg, assistant_message=reply)


# ── Starting runs ───────────────────────────────────────────────────────


def test_send_returns_202_with_messages_and_run(api, fake_anthropic, chat):
    fake_anthropic.queue(message(text("Hello.")))

    resp = api.post(_send_url(chat), {"text": "Hi"}, format="json")

    assert resp.status_code == 202
    data = resp.json()["data"]
    assert data["user_message"]["parts"] == [{"id": "p1", "type": "text", "text": "Hi"}]
    assert data["user_message"]["role"] == "user"
    assert data["assistant_message"]["parent_id"] == data["user_message"]["id"]
    assert data["run"]["message_id"] == data["assistant_message"]["id"]
    assert data["run"]["status"] == "completed"
    chat.refresh_from_db()
    assert str(chat.current_leaf_id) == data["assistant_message"]["id"]
    assert chat.title == "Hi" and chat.title_source == "auto" and chat.preview == "Hi"


def test_idempotency_key_replays_the_first_request(api, fake_anthropic, chat):
    fake_anthropic.queue(message(text("Once.")))
    first = api.post(_send_url(chat), {"text": "Hi"}, format="json", HTTP_IDEMPOTENCY_KEY="k-1")
    second = api.post(_send_url(chat), {"text": "Hi"}, format="json", HTTP_IDEMPOTENCY_KEY="k-1")

    assert first.status_code == second.status_code == 202
    assert first.json()["data"]["run"]["id"] == second.json()["data"]["run"]["id"]
    assert AgentRun.objects.count() == 1
    assert len(fake_anthropic.requests) == 1


@pytest.mark.parametrize(("setting", "value", "status", "code"), [
    ("ANTHROPIC_API_KEY", "", 503, "agent_not_configured"),
    ("AGENT_ENABLED", False, 503, "agent_disabled"),
    ("AGENT_PROCESS", False, 503, "agent_unavailable"),
])
def test_denied_sends_never_reach_the_model(api, fake_anthropic, chat, settings, setting, value,
                                            status, code):
    setattr(settings, setting, value)

    resp = api.post(_send_url(chat), {"text": "Hi"}, format="json")

    assert resp.status_code == status
    assert resp.json()["error"]["code"] == code
    assert fake_anthropic.requests == []
    assert not AgentMessage.objects.exists()


def test_spent_allowance_is_a_403_before_any_request(api, fake_anthropic, chat, user, settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    AITokenUsage.objects.create(user=user, module="agent", provider="anthropic",
                                model_name="claude-opus-5-5", input_tokens=1, output_tokens=1,
                                total_tokens=2, estimated_cost_usd=1.5)

    resp = api.post(_send_url(chat), {"text": "Hi"}, format="json")

    assert resp.status_code == 403
    error = resp.json()["error"]
    assert error["code"] == "allowance_exceeded"
    assert error["details"] == {"cap_usd": 1.0, "spent_usd": 1.5}
    assert fake_anthropic.requests == []


def test_concurrency_limits(api, fake_anthropic, chat, user, website):
    busy = _queued_run(chat)
    resp = api.post(_send_url(chat), {"text": "Hi"}, format="json")
    assert resp.status_code == 409
    assert resp.json()["error"] == {"code": "run_in_progress",
                                    "message": "This chat already has a reply in progress.",
                                    "details": {"run_id": str(busy.id)}}

    other_chat = make_chat(user, website)
    resp = api.post(_send_url(other_chat), {"text": "Hi"}, format="json")
    assert resp.status_code == 429 and resp.json()["error"]["code"] == "agent_busy"
    assert fake_anthropic.requests == []


def test_validation_and_tenancy(api, fake_anthropic, chat, django_user_model):
    from apps.websites.models import Website

    assert api.post(_send_url(chat), {"text": "  "}, format="json").json()["error"]["code"] == (
        "invalid")
    assert api.post(_send_url(chat), {"text": "x", "agent": "bogus"},
                    format="json").status_code == 400
    assert api.post(_send_url(chat), {"text": "x", "parent_id": "nope"},
                    format="json").status_code == 400

    stranger = django_user_model.objects.create_user(email="s@example.com", password="x" * 16)
    site = Website.objects.create(user=stranger, url="https://s.example", name="S")
    their_chat = make_chat(stranger, site)
    assert api.post(_send_url(their_chat), {"text": "x"}, format="json").status_code == 404
    assert fake_anthropic.requests == []


def test_org_viewer_cannot_start_runs(fake_anthropic, chat, website, user, django_user_model):
    org = Organization.objects.create(name="Acme", slug="acme", owner=user)
    website.organization = org
    website.save(update_fields=["organization"])
    viewer = django_user_model.objects.create_user(email="v@example.com", password="x" * 16)
    OrganizationMember.objects.create(organization=org, user=viewer, role="viewer")
    own_chat = AgentChat.objects.create(website=website, user=viewer, snapshot=chat.snapshot)
    client = APIClient()
    client.force_authenticate(viewer)

    # Viewers can see the project, so a refused write is 403 (as on the
    # gunicorn endpoints), not a 404 that pretends the project is gone.
    resp = client.post(_send_url(own_chat), {"text": "x"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"
    assert fake_anthropic.requests == []


def test_regenerate_edit_and_continue_endpoints(api, fake_anthropic, chat):
    fake_anthropic.queue(message(text("A long answer that stops"), stop_reason="max_tokens"))
    first = api.post(_send_url(chat), {"text": "Hi"}, format="json").json()["data"]
    assistant_id = first["assistant_message"]["id"]
    user_id = first["user_message"]["id"]

    fake_anthropic.queue(message(text(" and ends.")))
    cont = api.post(_msg_url("agent-live-continue", chat, assistant_id))
    assert cont.status_code == 202
    assert cont.json()["data"]["user_message"]["parts"][0]["text"] == "Continue"
    not_cut = cont.json()["data"]["assistant_message"]["id"]
    assert api.post(_msg_url("agent-live-continue", chat, not_cut)).status_code == 400

    fake_anthropic.queue(message(text("Another take.")))
    regen = api.post(_msg_url("agent-live-regenerate", chat, assistant_id))
    assert regen.status_code == 202
    body = regen.json()["data"]
    assert set(body) == {"assistant_message", "run"}
    assert body["assistant_message"]["parent_id"] == user_id
    assert body["assistant_message"]["sibling_ids"] == [assistant_id, body["assistant_message"]["id"]]

    fake_anthropic.queue(message(text("Edited.")))
    edit = api.post(_msg_url("agent-live-edit", chat, user_id), {"text": "Hello"}, format="json")
    assert edit.status_code == 202
    assert edit.json()["data"]["user_message"]["sibling_ids"] == [
        user_id, edit.json()["data"]["user_message"]["id"]]
    # Regenerate takes an assistant message, edit a user message.
    assert api.post(_msg_url("agent-live-regenerate", chat, user_id)).status_code == 404
    assert api.post(_msg_url("agent-live-edit", chat, assistant_id),
                    {"text": "x"}, format="json").status_code == 404


def test_cancel_is_idempotent(api, fake_anthropic, chat):
    queued = _queued_run(chat)
    url = reverse("agent-live-cancel", kwargs={"run_id": queued.id})
    get_event_store().open(str(queued.id))

    assert api.post(url).json()["data"] == {"status": "cancelled"}
    assert api.post(url).json()["data"] == {"status": "cancelled"}
    queued.refresh_from_db()
    assert queued.status == "cancelled" and queued.cancel_requested_at is not None
    assert AgentMessage.objects.get(id=queued.assistant_message_id).status == "cancelled"
    assert get_event_store().read(str(queued.id), 0).events[-1]["type"] == "run.cancelled"

    fake_anthropic.queue(message(text("Done.")))
    done = send(chat, "Hi").run
    resp = api.post(reverse("agent-live-cancel", kwargs={"run_id": done.id}))
    assert resp.json()["data"] == {"status": "completed"}


# ── SSE ────────────────────────────────────────────────────────────────


def _stream(client, run_id, query="", **headers):
    url = reverse("agent-live-stream", kwargs={"run_id": run_id}) + query
    resp = client.get(url, **headers)
    body = b"".join(resp.streaming_content).decode() if resp.streaming else resp.content.decode()
    return resp, body


def _frames(body: str) -> list[dict]:
    out = []
    for block in body.split("\n\n"):
        fields = {}
        for line in block.split("\n"):
            if line.startswith(":") or not line:
                continue
            key, _, value = line.partition(": ")
            fields[key] = value
        if "data" in fields:
            fields["data"] = json.loads(fields["data"])
            out.append(fields)
    return out


@pytest.fixture
def jwt(user):
    return {"HTTP_AUTHORIZATION": f"Bearer {AccessToken.for_user(user)}"}


def test_sse_streams_every_event_then_stops(fake_anthropic, chat, jwt, client):
    fake_anthropic.queue(message(text("Hello there.")))
    run = send(chat, "Hi").run

    resp, body = _stream(client, run.id, **jwt)

    assert resp.status_code == 200
    assert resp["Content-Type"] == "text/event-stream; charset=utf-8"
    assert "no-transform" in resp["Cache-Control"] and "no-store" in resp["Cache-Control"]
    assert resp["X-Accel-Buffering"] == "no"
    assert body.startswith("retry: 3000\n")
    frames = _frames(body)
    assert [f["data"]["seq"] for f in frames] == list(range(1, len(frames) + 1))
    assert [f["id"] for f in frames] == [str(f["data"]["seq"]) for f in frames]
    assert frames[-1]["event"] == "run.completed"
    assert all(f["event"] == f["data"]["type"] for f in frames)


def test_sse_resumes_after_last_event_id(fake_anthropic, chat, jwt, client):
    fake_anthropic.queue(message(text("Hello there.")))
    run = send(chat, "Hi").run
    total = len(get_event_store().read(str(run.id), 0).events)

    _, body = _stream(client, run.id, HTTP_LAST_EVENT_ID="3", **jwt)
    assert [f["data"]["seq"] for f in _frames(body)] == list(range(4, total + 1))
    _, body = _stream(client, run.id, "?after=2", **jwt)
    assert _frames(body)[0]["data"]["seq"] == 3


def test_sse_resync_when_the_buffer_is_gone_or_behind(fake_anthropic, chat, jwt, client):
    fake_anthropic.queue(message(text("Hello there.")))
    run = send(chat, "Hi").run

    set_event_store(MemoryEventStore())
    _, body = _stream(client, run.id, HTTP_LAST_EVENT_ID="4", **jwt)
    frames = _frames(body)
    assert len(frames) == 1 and frames[0]["event"] == "resync"
    assert "id" not in frames[0]
    assert frames[0]["data"]["reason"] == "buffer_missing" and frames[0]["data"]["seq"] == 5

    small = MemoryEventStore(maxlen=2)
    for _ in range(5):
        small.append(str(run.id), {"type": "run.usage", "run_id": str(run.id)})
    set_event_store(small)
    _, body = _stream(client, run.id, **jwt)
    assert _frames(body)[0]["data"]["reason"] == "behind_buffer"


def test_sse_requires_the_owner(chat, client, django_user_model, jwt):
    run = _queued_run(chat)
    url = reverse("agent-live-stream", kwargs={"run_id": run.id})
    assert client.get(url).status_code == 401
    other = django_user_model.objects.create_user(email="x@example.com", password="x" * 16)
    resp = client.get(url, HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(other)}")
    assert resp.status_code == 404


def test_sse_pings_and_asks_to_reconnect(chat, settings, monkeypatch):
    from apps.agent.api.v1 import stream as stream_module

    monkeypatch.setattr(stream_module, "PING_SECONDS", 0.05)
    run = _queued_run(chat)
    store = get_event_store()
    store.open(str(run.id))
    body = "".join(stream_module.sync_events(store, str(run.id), "m", 0, max_seconds=0.2))
    assert ": ping\n\n" in body
    assert body.endswith("event: reconnect\ndata: {}\n\n")


def test_async_stream_wakes_on_events_from_other_threads(chat):
    run = _queued_run(chat)
    store = get_event_store()
    rid = str(run.id)
    store.open(rid)

    def later():
        time.sleep(0.1)
        store.append(rid, {"type": "part.added", "run_id": rid, "part": {"id": "p1"}})
        store.append(rid, {"type": "run.completed", "run_id": rid})

    async def collect():
        threading.Thread(target=later).start()
        return [chunk async for chunk in async_events(store, rid, "m", 0, max_seconds=5)]

    chunks = asyncio.run(collect())
    assert chunks[0].startswith("retry: 3000")
    assert [json.loads(c.split("data: ", 1)[1])["type"] for c in chunks[1:]] == [
        "part.added", "run.completed"]


def test_frame_format():
    event = {"v": 1, "seq": 7, "type": "part.delta", "append": "a\nb"}
    assert frame(event) == ('id: 7\nevent: part.delta\n'
                            'data: {"v":1,"seq":7,"type":"part.delta","append":"a\\nb"}\n\n')


# ── Long-poll ──────────────────────────────────────────────────────────


def _events_url(run_id, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return reverse("agent-live-events", kwargs={"run_id": run_id}) + (f"?{query}" if query else "")


def test_long_poll_returns_events_unenveloped(api, fake_anthropic, chat):
    fake_anthropic.queue(message(text("Hello.")))
    run = send(chat, "Hi").run

    body = api.get(_events_url(run.id, after=0, wait=0)).json()
    assert set(body) == {"events", "next_after", "terminal", "run_status"}
    assert body["terminal"] is True and body["run_status"] == "completed"
    assert body["next_after"] == body["events"][-1]["seq"]

    rest = api.get(_events_url(run.id, after=body["next_after"], wait=0)).json()
    assert rest == {"events": [], "next_after": body["next_after"], "terminal": True,
                    "run_status": "completed"}


def test_long_poll_waits_for_the_next_event(api, chat):
    run = _queued_run(chat)
    rid = str(run.id)
    store = get_event_store()
    store.open(rid)
    threading.Timer(0.2, lambda: store.append(rid, {"type": "run.started", "run_id": rid})).start()

    started = time.monotonic()
    body = api.get(_events_url(run.id, after=0, wait=5)).json()

    assert [e["type"] for e in body["events"]] == ["run.started"]
    assert time.monotonic() - started < 4
    assert body["terminal"] is False and body["run_status"] == "queued"


def test_long_poll_resync_and_ownership(api, chat, django_user_model, fake_anthropic):
    fake_anthropic.queue(message(text("Hello.")))
    run = send(chat, "Hi").run
    set_event_store(MemoryEventStore())

    body = api.get(_events_url(run.id, after=3, wait=0)).json()
    assert [e["type"] for e in body["events"]] == ["resync"]
    assert body["next_after"] == 3 and body["run_status"] == "completed"

    other = django_user_model.objects.create_user(email="z@example.com", password="x" * 16)
    client = APIClient()
    client.force_authenticate(other)
    assert client.get(_events_url(run.id)).status_code == 404


def test_tool_call_reply_is_visible_through_the_feed(api, fake_anthropic, chat):
    fake_anthropic.queue(message(tool_use("list_artifacts", {}), stop_reason="tool_use"),
                         message(text("No artifacts yet.")))
    run = send(chat, "What did we make?").run
    body = api.get(_events_url(run.id, wait=0)).json()
    added = [e["part"]["type"] for e in body["events"] if e["type"] == "part.added"]
    assert added == ["tool", "text"]
