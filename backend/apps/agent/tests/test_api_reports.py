"""Saving a research reply to Reports."""
import pytest
from django.utils import timezone

from apps.agent.models import AgentArtifact, AgentArtifactVersion, AgentMessage
from apps.agent.services.reports import report_title
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

SERP_P1 = {
    "capture_id": "cap1", "query": "best e-bike battery", "page": 1, "start": 0,
    "location": "us", "captured_at": "2026-11-02T10:00:00Z",
    "brand": {"name": "Northwind", "domain": "northwind.example"}, "brand_positions": [],
    "results": [{"position": 1, "title": "Top batteries", "url": "https://a.example/",
                 "display_url": "a.example", "domain": "a.example", "snippet": "...",
                 "is_yours": False, "is_competitor": True, "competitor_name": "Alpha"}],
    "ai_overview": None, "people_also_ask": [], "error": None,
}
SERP_P2 = {**SERP_P1, "capture_id": "cap2", "page": 2, "start": 10,
           "captured_at": "2026-11-02T10:00:05Z", "brand_positions": [14]}
SERP_EARLIER = {**SERP_P1, "capture_id": "cap0", "query": "northwind battery",
                "captured_at": "2026-11-02T09:59:00Z"}
PAGE = {
    "capture_id": "pg1", "url": "https://a.example/", "final_url": "https://a.example/",
    "captured_at": "2026-11-02T10:01:00Z", "frameable": True, "status_code": 200,
    "seo": {"title": "Top batteries"}, "reader": {"title": "x", "blocks": [], "links": []},
    "error": None,
}
ENGINE_PARTS = [
    {"id": "e1", "type": "engine_check", "request": 2, "prompt_id": "p1",
     "prompt_text": "best e-bike battery", "engine": "claude", "engine_label": "Claude",
     "status": "done", "mentioned": True, "rank": 3, "sentiment": "positive", "error": None},
    {"id": "e2", "type": "engine_check", "request": 2, "prompt_id": "p1",
     "prompt_text": "best e-bike battery", "engine": "grok", "engine_label": "Grok",
     "status": "unavailable", "mentioned": None, "rank": None, "sentiment": None,
     "error": "XAI_API_KEY is not set"},
]
GAPS = [{"prompt_id": "p1", "gap": {"class": "ai_ahead", "value": 71}}]


@pytest.fixture
def reply(user, website, snapshot):
    chat = make_chat(user, website, snapshot, title="Research Northwind")
    question = add_message(chat, text="Research Northwind")
    parts = [
        {"id": "t0", "type": "thinking", "request": 0, "text": "Planning"},
        {"id": "s1", "type": "serp", "request": 1, "query": "best e-bike battery", "page": 2,
         "status": "done", "tab_id": "serp:cap2"},
        {"id": "s2", "type": "serp", "request": 1, "query": "best e-bike battery", "page": 1,
         "status": "done", "tab_id": "serp:cap1"},
        {"id": "x1", "type": "page_inspect", "request": 1, "url": "https://a.example/",
         "status": "done", "tab_id": "page:pg1"},
        *ENGINE_PARTS,
        {"id": "t1", "type": "text", "request": 3,
         "text": "# Northwind: Google vs AI engines\n\nSummary here.", "citations": []},
        {"id": "c1", "type": "chart", "request": 3, "spec": {"type": "bar"}},
        {"id": "t2", "type": "text", "request": 3, "text": "## Fixes\n\n- Do this", "citations": []},
    ]
    message = add_message(
        chat, parent=question, role="assistant", parts=parts, status="complete",
        research={"serp": {"cap1": SERP_P1, "cap2": SERP_P2, "cap0": SERP_EARLIER},
                  "pages": {"pg1": PAGE}, "gaps": GAPS},
        cost_usd="0.123400",
    )
    add_run(chat, question, message, status="completed")
    return message


def save(api, website, payload):
    return api.post(f"{BASE}/websites/{website.id}/reports/", payload, format="json")


def test_saving_creates_a_report_with_the_research_snapshot(user, website, reply):
    api = client_for(user)
    resp = save(api, website, {"message_id": str(reply.id)})
    assert resp.status_code == 201
    body = data(resp)
    assert body["kind"] == "report" and body["agent_key"] == "gap_analyst"
    assert body["title"] == "Northwind: Google vs AI engines"
    assert body["content_type"] == "text/markdown"
    assert body["content"] == (
        "# Northwind: Google vs AI engines\n\nSummary here.\n\n## Fixes\n\n- Do this"
    )
    assert body["version"] == 1 and body["source_chat_id"] == str(reply.chat_id)
    snapshot = body["data"]
    # Part order first (page 2 was read before page 1), then the unreferenced capture.
    assert [c["capture_id"] for c in snapshot["serp"]] == ["cap2", "cap1", "cap0"]
    assert snapshot["pages"] == [{k: v for k, v in PAGE.items() if k != "reader"}]
    assert snapshot["engines"] == ENGINE_PARTS
    assert snapshot["gaps"] == GAPS
    assert body["summary"] == (
        "3 Google results pages, 1 page inspected, 2 AI engine checks, 1 section"
    )

    reply.refresh_from_db()
    assert str(reply.saved_report_id) == body["id"]
    version = AgentArtifactVersion.objects.get(artifact_id=body["id"])
    assert version.run == reply.run and version.created_by == user
    assert str(version.cost_usd) == "0.123400"

    chat = data(api.get(f"{BASE}/websites/{website.id}/chats/{reply.chat_id}/"))
    assert chat["messages"][-1]["saved_report_id"] == body["id"]
    reports = data(api.get(f"{BASE}/websites/{website.id}/artifacts/", {"kind": "report"}))
    assert [r["id"] for r in reports] == [body["id"]]


def test_a_second_save_is_409_with_the_report_id(user, website, reply):
    api = client_for(user)
    first = data(save(api, website, {"message_id": str(reply.id)}))
    again = save(api, website, {"message_id": str(reply.id), "title": "Another"})
    assert again.status_code == 409
    assert error(again)["code"] == "already_saved"
    assert error(again)["details"] == {"artifact_id": first["id"]}
    assert AgentArtifact.objects.filter(kind="report").count() == 1


def test_deleting_the_report_frees_the_reply_to_be_saved_again(user, website, reply):
    api = client_for(user)
    first = data(save(api, website, {"message_id": str(reply.id)}))
    assert api.delete(f"{BASE}/websites/{website.id}/artifacts/{first['id']}/").status_code == 204
    reply.refresh_from_db()
    assert reply.saved_report_id is None
    second = save(api, website, {"message_id": str(reply.id)})
    assert second.status_code == 201
    assert data(second)["id"] != first["id"]


def test_given_title_wins_and_the_default_is_dated(user, website, reply):
    body = data(save(client_for(user), website,
                     {"message_id": str(reply.id), "title": "  Q4  visibility  "}))
    assert body["title"] == "Q4 visibility"
    today = timezone.localdate()
    assert report_title("", "No heading here.\n\n```\n# not a heading\n```", website) == (
        f"SEO and GEO report · Northwind · {today:%b} {today.day}, {today.year}"
    )
    assert report_title("", "intro\n\n## **Bold** `heading` ##\n", website) == "Bold heading"


@pytest.mark.parametrize("change, expected_status", [
    ({"status": "streaming"}, 400),
    ({"status": "failed"}, 400),
    ({"role": "user"}, 400),
    ({"parts": [{"id": "t", "type": "text", "request": 0, "text": "   "}]}, 400),
])
def test_only_finished_replies_with_text_can_be_saved(user, website, reply, change,
                                                       expected_status):
    AgentMessage.objects.filter(pk=reply.pk).update(**change)
    resp = save(client_for(user), website, {"message_id": str(reply.id)})
    assert resp.status_code == expected_status
    assert error(resp)["code"] == "invalid"
    assert not AgentArtifact.objects.filter(kind="report").exists()


def test_a_truncated_reply_can_be_saved(user, website, reply):
    AgentMessage.objects.filter(pk=reply.pk).update(status="truncated")
    assert save(client_for(user), website, {"message_id": str(reply.id)}).status_code == 201


def test_reports_are_saved_from_your_own_chats_and_shared_with_the_team(
    user, website, reply, django_user_model,
):
    teammate = make_user(django_user_model, "teammate@example.com", "Team Mate")
    viewer = make_user(django_user_model, "viewer@example.com")
    join_org(website, user, {teammate: "member", viewer: "viewer"})

    assert save(client_for(teammate), website, {"message_id": str(reply.id)}).status_code == 404
    assert save(client_for(viewer), website, {"message_id": str(reply.id)}).status_code == 403

    report = data(save(client_for(user), website, {"message_id": str(reply.id)}))
    for member in (teammate, viewer):
        listed = data(client_for(member).get(
            f"{BASE}/websites/{website.id}/artifacts/", {"kind": "report"},
        ))
        assert [r["id"] for r in listed] == [report["id"]]
        assert listed[0]["source_chat_id"] is None


def test_unknown_message_is_404(user, website):
    resp = save(client_for(user), website,
                {"message_id": "00000000-0000-0000-0000-000000000000"})
    assert resp.status_code == 404
    assert save(client_for(user), website, {}).status_code == 400
