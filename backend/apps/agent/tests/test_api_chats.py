"""Agent API: status, catalog, chats, branches, feedback and access rules."""
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone

from apps.agent.api.v1.serializers import MessageSerializer, RunSerializer
from apps.agent.models import AgentArtifact, AgentChat, AgentMessage
from apps.agent.services import chats as chat_service
from apps.agent.tests.api_support import (
    add_message,
    add_run,
    client_for,
    data,
    error,
    join_org,
    make_chat,
    make_user,
    stand_in_missing_live_modules,
)

pytestmark = pytest.mark.django_db
stand_in_missing_live_modules()

BASE = "/api/v1/agent"


def chats_url(website, chat=None):
    url = f"{BASE}/websites/{website.id}/chats/"
    return f"{url}{chat.id}/" if chat else url


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def api(user):
    return client_for(user)


@pytest.fixture
def tree(user, website, snapshot):
    """u1 -> a1 -> u2 -> a2, and u1 -> a1b (a regenerated reply, newest)."""
    chat = make_chat(user, website, snapshot, title="Research Northwind")
    u1 = add_message(chat, text="Research Northwind", age_minutes=50)
    a1 = add_message(chat, parent=u1, role="assistant", text="First answer", age_minutes=40)
    u2 = add_message(chat, parent=a1, text="Go deeper", age_minutes=30)
    a2 = add_message(chat, parent=u2, role="assistant", text="Deeper answer", age_minutes=20)
    a1b = add_message(chat, parent=u1, role="assistant", text="Second answer", age_minutes=10)
    chat.current_leaf = a1b
    chat.last_message_at = timezone.now()
    chat.save()
    return {"chat": chat, "u1": u1, "a1": a1, "u2": u2, "a2": a2, "a1b": a1b}


# ── status and catalog ────────────────────────────────────────────────────


@override_settings(
    AGENT_ENABLED=False, ANTHROPIC_API_KEY="", OPENAI_API_KEY="sk-test", GEMINI_API_KEY="",
    PERPLEXITY_API_KEY="", XAI_API_KEY="", SERPAPI_KEY="",
)
def test_status_answers_while_disabled_and_reports_configuration(api):
    resp = api.get(f"{BASE}/status/")
    assert resp.status_code == 200
    body = data(resp)
    assert body["enabled"] is False
    assert body["configured"] is False
    assert body["live_available"] is True
    assert body["model"] == "claude-opus-5-5"
    assert body["serp_configured"] is False
    assert body["web_tools_enabled"] is True
    assert [(e["key"], e["label"], e["configured"]) for e in body["engines"]] == [
        ("chatgpt", "ChatGPT", True),
        ("claude", "Claude", False),
        ("gemini", "Gemini", False),
        ("grok", "Grok", False),
        ("perplexity", "Perplexity", False),
    ]
    assert body["allowance"] == {
        "cap_usd": 1.0, "spent_usd": 0.0, "exceeded": False, "warning": False,
        # A free account counts prompt runs; its dollar cap is not shown.
        "show_usd": False,
    }


@override_settings(ANTHROPIC_API_KEY="sk-test", SERPAPI_KEY="serp-test")
def test_status_reports_keys_that_are_set(api):
    body = data(api.get(f"{BASE}/status/"))
    assert body["configured"] is True
    assert body["serp_configured"] is True
    assert next(e for e in body["engines"] if e["key"] == "claude")["configured"] is True


@override_settings(AGENT_PROCESS=False)
def test_status_live_available_follows_the_agent_heartbeat(api):
    assert data(api.get(f"{BASE}/status/"))["live_available"] is False
    cache.set("agent:live:heartbeat", 1, 30)
    assert data(api.get(f"{BASE}/status/"))["live_available"] is True


def test_status_needs_a_signed_in_user(client):
    assert client.get(f"{BASE}/status/").status_code == 401


def test_catalog_lists_the_ten_agents(api):
    resp = api.get(f"{BASE}/agents/")
    assert resp.status_code == 200
    agents = data(resp)
    assert [(a["key"], a["output_kind"]) for a in agents] == [
        ("gap_analyst", "report"), ("page_optimizer", "document"),
        ("aeo_article", "document"), ("llms_txt", "document"),
        ("comparison_page", "document"), ("landing_page", "page"),
        ("ad_campaign", "sheet"), ("social_posts", "document"),
        ("pr_writer", "document"), ("messaging_brief", "document"),
    ]
    assert all(a["name"] and a["description"] and a["starter"] for a in agents)
    assert [t["key"] for t in agents[4]["teams"]] == ["product_marketing", "content", "growth"]


@override_settings(AGENT_ENABLED=False)
def test_everything_but_status_is_off_while_disabled(api, website):
    for url in (f"{BASE}/agents/", chats_url(website), f"{BASE}/websites/{website.id}/artifacts/"):
        resp = api.get(url)
        assert resp.status_code == 503
        assert error(resp)["code"] == "agent_disabled"
    assert api.get(f"{BASE}/status/").status_code == 200


# ── creating and listing chats ────────────────────────────────────────────


@override_settings(ANTHROPIC_API_KEY="sk-test")
def test_create_chat_returns_an_empty_chat(api, user, website, snapshot, monkeypatch):
    monkeypatch.setattr(chat_service, "_orchestrator_snapshot", lambda: snapshot)
    resp = api.post(chats_url(website), {"entry_agent": "landing_page"}, format="json")
    assert resp.status_code == 201
    body = data(resp)
    assert body["messages"] == [] and body["active_run"] is None
    assert body["current_leaf_id"] is None
    assert body["title"] == "" and body["title_source"] == "auto"
    assert body["entry_agent"] == "landing_page"
    chat = AgentChat.objects.get(pk=body["id"])
    assert (chat.user, chat.website, chat.snapshot) == (user, website, snapshot)


@override_settings(ANTHROPIC_API_KEY="")
def test_create_chat_without_an_api_key_is_not_configured(api, website):
    resp = api.post(chats_url(website), {}, format="json")
    assert resp.status_code == 503
    assert error(resp)["code"] == "agent_not_configured"
    assert not AgentChat.objects.exists()


@override_settings(ANTHROPIC_API_KEY="sk-test")
def test_create_chat_rejects_an_unknown_agent(api, website):
    resp = api.post(chats_url(website), {"entry_agent": "seo_wizard"}, format="json")
    assert resp.status_code == 400
    assert error(resp)["code"] == "invalid"
    assert "entry_agent" in error(resp)["details"]["fields"]


def test_list_is_newest_activity_first_with_cursor_and_search(
    api, user, website, snapshot, django_user_model,
):
    now = timezone.now()
    for i in range(32):
        chat = make_chat(
            user, website, snapshot, title=f"Chat {i:02d}", preview=f"preview {i:02d}",
            last_message_at=now - timedelta(minutes=i),
        )
        add_message(chat, text=f"question {i}")
    make_chat(user, website, snapshot, title="Never sent")  # no message: not listed
    stranger = make_user(django_user_model, "stranger@example.com")
    other_chat = make_chat(stranger, website, snapshot, title="Not yours")
    add_message(other_chat, text="hidden")

    resp = api.get(chats_url(website))
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"success", "data"}
    page = body["data"]
    assert [c["title"] for c in page["results"]] == [f"Chat {i:02d}" for i in range(30)]
    assert page["next_cursor"]
    assert set(page["results"][0]) == {
        "id", "title", "preview", "created_at", "last_message_at", "active_run_id",
    }

    rest = data(api.get(chats_url(website), {"cursor": page["next_cursor"]}))
    assert [c["title"] for c in rest["results"]] == ["Chat 30", "Chat 31"]
    assert rest["next_cursor"] is None

    found = data(api.get(chats_url(website), {"q": "PREVIEW 07"}))
    assert [c["title"] for c in found["results"]] == ["Chat 07"]


@pytest.mark.parametrize("raw", [
    b"not json", b"[1, 2]", b'{"a": 1, "b": 2}', b'["2026-11-02T10:00:00", "x"]',
    b'["2026-11-02T10:00:00+00:00", 7]', b'["2026-11-02T10:00:00+00:00"]',
])
def test_list_rejects_a_bad_cursor(api, website, raw):
    import base64

    for cursor in ("not-a-cursor!", base64.urlsafe_b64encode(raw).decode().rstrip("=")):
        resp = api.get(chats_url(website), {"cursor": cursor})
        assert resp.status_code == 400
        assert error(resp)["code"] == "invalid"


def test_list_shows_the_active_run(api, user, website, snapshot):
    chat = make_chat(user, website, snapshot, title="Busy")
    question = add_message(chat, text="hi")
    reply = add_message(chat, parent=question, role="assistant", status="streaming", parts=[])
    run = add_run(chat, question, reply, status="running", heartbeat_at=timezone.now())
    listed = data(api.get(chats_url(website)))["results"]
    assert listed[0]["active_run_id"] == str(run.id)


# ── chat detail and branches ──────────────────────────────────────────────


def test_detail_returns_the_visible_branch_with_siblings_runs_and_research(api, website, tree):
    reply = tree["a1b"]
    reply.status = "complete"
    reply.model = "claude-opus-5-5"
    reply.started_at = timezone.now() - timedelta(seconds=12)
    reply.finished_at = reply.started_at + timedelta(seconds=7, milliseconds=250)
    reply.research = {
        "serp": {"c1": {"capture_id": "c1", "query": "northwind", "page": 1}},
        "pages": {},
    }
    reply.feedback = 1
    reply.save()
    run = add_run(tree["chat"], tree["u1"], reply, status="completed", last_seq=42)

    resp = api.get(chats_url(website, tree["chat"]))
    assert resp.status_code == 200
    body = data(resp)
    assert body["current_leaf_id"] == str(reply.id)
    assert [m["id"] for m in body["messages"]] == [str(tree["u1"].id), str(reply.id)]
    user_msg, assistant = body["messages"]
    assert user_msg["sibling_ids"] == [str(tree["u1"].id)]
    assert user_msg["run_id"] is None and user_msg["parent_id"] is None
    assert user_msg["parts"][0]["text"] == "Research Northwind"
    assert assistant["sibling_ids"] == [str(tree["a1"].id), str(reply.id)]
    assert assistant["run_id"] == str(run.id)
    assert assistant["duration_ms"] == 7250
    assert assistant["research"]["serp"]["c1"]["query"] == "northwind"
    assert assistant["feedback"] == 1
    assert assistant["saved_report_id"] is None
    assert assistant["error_code"] is None
    assert set(assistant) >= {
        "id", "chat_id", "parent_id", "role", "status", "parts", "parts_seq", "created_at",
        "started_at", "finished_at", "duration_ms", "model", "error_code", "error_message",
        "feedback", "sibling_ids", "run_id", "saved_report_id", "research",
    }
    assert body["active_run"] is None


def test_detail_reports_the_active_run(api, website, tree):
    reply = add_message(tree["chat"], parent=tree["a1b"], role="assistant", status="streaming",
                        parts=[])
    run = add_run(tree["chat"], tree["u1"], reply, status="running", last_seq=5,
                  heartbeat_at=timezone.now())
    body = data(api.get(chats_url(website, tree["chat"])))
    assert body["active_run"] == {
        "id": str(run.id), "status": "running", "message_id": str(reply.id), "last_seq": 5,
        "queue": None,
    }


def test_detail_without_a_current_leaf_shows_the_newest_branch(api, website, tree):
    AgentChat.objects.filter(pk=tree["chat"].pk).update(current_leaf=None)
    body = data(api.get(chats_url(website, tree["chat"])))
    assert body["current_leaf_id"] == str(tree["a1b"].id)


def test_switching_branch_descends_to_the_newest_leaf(api, website, tree):
    resp = api.patch(chats_url(website, tree["chat"]),
                     {"current_leaf_id": str(tree["a1"].id)}, format="json")
    assert resp.status_code == 200
    body = data(resp)
    assert body["current_leaf_id"] == str(tree["a2"].id)
    assert [m["id"] for m in body["messages"]] == [
        str(tree[k].id) for k in ("u1", "a1", "u2", "a2")
    ]
    tree["chat"].refresh_from_db()
    assert tree["chat"].current_leaf_id == tree["a2"].id

    body = data(api.patch(chats_url(website, tree["chat"]),
                          {"current_leaf_id": str(tree["u1"].id)}, format="json"))
    assert body["current_leaf_id"] == str(tree["a1b"].id)


def test_switching_branch_is_refused_while_a_reply_is_running(api, website, tree):
    reply = add_message(tree["chat"], parent=tree["a1b"], role="assistant", status="streaming",
                        parts=[])
    run = add_run(tree["chat"], tree["u1"], reply, status="running", heartbeat_at=timezone.now())
    resp = api.patch(chats_url(website, tree["chat"]),
                     {"current_leaf_id": str(tree["a1"].id)}, format="json")
    assert resp.status_code == 409
    assert error(resp)["code"] == "run_in_progress"
    assert error(resp)["details"] == {"run_id": str(run.id)}


def test_switching_to_a_message_of_another_chat_is_404(api, user, website, snapshot, tree):
    other = make_chat(user, website, snapshot)
    stray = add_message(other, text="elsewhere")
    resp = api.patch(chats_url(website, tree["chat"]),
                     {"current_leaf_id": str(stray.id)}, format="json")
    assert resp.status_code == 404


def test_rename_sets_a_user_title(api, website, tree):
    body = data(api.patch(chats_url(website, tree["chat"]), {"title": "  Q4 plan  "},
                          format="json"))
    assert (body["title"], body["title_source"]) == ("Q4 plan", "user")


def test_patch_needs_a_title_or_a_leaf(api, website, tree):
    resp = api.patch(chats_url(website, tree["chat"]), {}, format="json")
    assert resp.status_code == 400
    assert error(resp)["code"] == "invalid"


def test_delete_removes_the_chat_but_keeps_its_artifacts(api, website, tree):
    artifact = AgentArtifact.objects.create(
        website=website, kind="page", title="Landing", source_chat=tree["chat"],
        source_message=tree["a1b"], latest_version=1,
    )
    resp = api.delete(chats_url(website, tree["chat"]))
    assert resp.status_code == 204
    assert not AgentChat.objects.filter(pk=tree["chat"].pk).exists()
    assert not AgentMessage.objects.filter(chat_id=tree["chat"].pk).exists()
    artifact.refresh_from_db()
    assert artifact.source_chat_id is None and artifact.source_message_id is None


def test_delete_is_refused_while_a_reply_is_running(api, website, tree):
    reply = add_message(tree["chat"], parent=tree["a1b"], role="assistant", status="streaming",
                        parts=[])
    add_run(tree["chat"], tree["u1"], reply, status="queued")
    resp = api.delete(chats_url(website, tree["chat"]))
    assert resp.status_code == 409
    assert AgentChat.objects.filter(pk=tree["chat"].pk).exists()


def test_reading_a_chat_ends_a_run_whose_process_went_silent(api, website, tree):
    reply = add_message(tree["chat"], parent=tree["a1b"], role="assistant", status="streaming",
                        parts=[])
    run = add_run(tree["chat"], tree["u1"], reply, status="running",
                  heartbeat_at=timezone.now() - timedelta(minutes=10))
    tree["chat"].current_leaf = reply
    tree["chat"].save()
    body = data(api.get(chats_url(website, tree["chat"])))
    assert body["active_run"] is None
    run.refresh_from_db()
    assert run.status == "interrupted"
    assert body["messages"][-1]["status"] == "interrupted"


def test_reading_a_chat_leaves_a_live_run_alone(api, website, tree):
    reply = add_message(tree["chat"], parent=tree["a1b"], role="assistant", status="streaming",
                        parts=[])
    run = add_run(tree["chat"], tree["u1"], reply, status="running", heartbeat_at=timezone.now())
    tree["chat"].current_leaf = reply
    tree["chat"].save()
    body = data(api.get(chats_url(website, tree["chat"])))
    assert body["active_run"]["id"] == str(run.id)
    assert body["messages"][-1]["status"] == "streaming"


# ── feedback ──────────────────────────────────────────────────────────────


def test_feedback_is_stored_and_cleared(api, website, tree):
    url = f"{BASE}/websites/{website.id}/messages/{tree['a1b'].id}/feedback/"
    resp = api.post(url, {"value": -1, "reason": "inaccurate", "comment": "Wrong rank"},
                    format="json")
    assert resp.status_code == 200
    assert data(resp) == {"value": -1}
    reply = AgentMessage.objects.get(pk=tree["a1b"].pk)
    assert (reply.feedback, reply.feedback_reason, reply.feedback_comment) == (
        -1, "inaccurate", "Wrong rank",
    )
    assert reply.feedback_at is not None

    assert data(api.post(url, {"value": 0}, format="json")) == {"value": 0}
    reply.refresh_from_db()
    assert (reply.feedback, reply.feedback_reason, reply.feedback_at) == (None, "", None)


def test_feedback_validation(api, website, tree):
    url = f"{BASE}/websites/{website.id}/messages/"
    resp = api.post(f"{url}{tree['a1b'].id}/feedback/", {"value": 5}, format="json")
    assert resp.status_code == 400 and error(resp)["code"] == "invalid"
    resp = api.post(f"{url}{tree['u1'].id}/feedback/", {"value": 1}, format="json")
    assert resp.status_code == 400 and error(resp)["code"] == "invalid"


# ── access rules ──────────────────────────────────────────────────────────


def test_chats_are_private_even_inside_one_project(
    user, website, tree, django_user_model, monkeypatch, snapshot,
):
    teammate = make_user(django_user_model, "teammate@example.com", "Team Mate")
    join_org(website, user, {teammate: "admin"})
    api = client_for(teammate)
    chat_url = chats_url(website, tree["chat"])
    assert data(api.get(chats_url(website)))["results"] == []
    assert api.get(chat_url).status_code == 404
    assert api.patch(chat_url, {"title": "mine now"}, format="json").status_code == 404
    assert api.delete(chat_url).status_code == 404
    feedback = f"{BASE}/websites/{website.id}/messages/{tree['a1b'].id}/feedback/"
    assert api.post(feedback, {"value": 1}, format="json").status_code == 404
    tree["chat"].refresh_from_db()
    assert tree["chat"].title == "Research Northwind"


@override_settings(ANTHROPIC_API_KEY="sk-test")
def test_viewers_are_read_only(user, website, tree, django_user_model, monkeypatch, snapshot):
    viewer = make_user(django_user_model, "viewer@example.com")
    join_org(website, user, {viewer: "viewer"})
    monkeypatch.setattr(chat_service, "_orchestrator_snapshot", lambda: snapshot)
    api = client_for(viewer)
    assert api.get(chats_url(website)).status_code == 200
    resp = api.post(chats_url(website), {}, format="json")
    assert resp.status_code == 403
    assert error(resp)["code"] == "permission_denied"
    assert not AgentChat.objects.filter(user=viewer).exists()


def test_people_outside_the_project_get_404(website, django_user_model):
    outsider = client_for(make_user(django_user_model, "outsider@example.com"))
    assert outsider.get(chats_url(website)).status_code == 404
    assert outsider.get(f"{BASE}/websites/{website.id}/artifacts/").status_code == 404


# ── serializers used by the live views ────────────────────────────────────


def test_message_serializer_alone_finds_siblings(tree):
    body = MessageSerializer(AgentMessage.objects.get(pk=tree["a1"].pk)).data
    assert body["sibling_ids"] == [str(tree["a1"].id), str(tree["a1b"].id)]
    assert body["run_id"] is None
    assert isinstance(body["created_at"], str)


def test_run_serializer_matches_the_contract(tree):
    run = add_run(tree["chat"], tree["u1"], tree["a1b"], status="queued", last_seq=3)
    assert RunSerializer(run).data == {
        "id": str(run.id), "chat_id": str(tree["chat"].id),
        "message_id": str(tree["a1b"].id), "status": "queued", "last_seq": 3,
        "queue": None,
    }
