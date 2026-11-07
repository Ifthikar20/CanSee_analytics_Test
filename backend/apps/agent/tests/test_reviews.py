"""Approvals (design/p2_contract.md 13): every transition and who may make
it, effective state after a new version, revisions, events, inbox items,
email (sent, failed and off) and the Reviews page's boxes."""
import pytest
from django.core import mail
from django.utils import timezone

from apps.agent.models import AgentArtifact, AgentArtifactReview, AgentReviewEvent
from apps.agent.services.artifacts import add_version
from apps.agent.tests.api_support import (
    client_for,
    data,
    error,
    join_org,
    make_user,
    stand_in_missing_live_modules,
)

pytestmark = pytest.mark.django_db
stand_in_missing_live_modules()

BASE = "/api/v1/agent"


@pytest.fixture
def team(user, website, django_user_model):
    """The owner, a member (the reviewer), an org admin and a viewer."""
    ana = make_user(django_user_model, "ana@example.com", "Ana Lopez")
    admin = make_user(django_user_model, "admin@example.com", "Org Admin")
    viewer = make_user(django_user_model, "viewer@example.com", "View Only")
    join_org(website, user, {ana: "member", admin: "admin", viewer: "viewer"})
    return {"owner": user, "ana": ana, "admin": admin, "viewer": viewer}


@pytest.fixture
def artifact(website, user):
    item = AgentArtifact.objects.create(website=website, kind="document",
                                        agent_key="aeo_article", title="Battery guide",
                                        created_by=user)
    add_version(item, content="# Guide v1", created_by=user)
    return item


def review_url(website, artifact, tail=""):
    return f"{BASE}/websites/{website.id}/artifacts/{artifact.id}/review/{tail}"


def act(who, website, artifact, action, **body):
    resp = client_for(who).post(review_url(website, artifact),
                                {"action": action, **body}, format="json")
    return resp


def current(who, website, artifact) -> dict:
    return data(client_for(who).get(review_url(website, artifact)))


def test_request_approve_and_a_new_version(team, website, artifact,
                                           django_capture_on_commit_callbacks):
    owner, ana = team["owner"], team["ana"]
    fresh = current(owner, website, artifact)
    assert (fresh["state"], fresh["effective_state"], fresh["revision"], fresh["version"]) == (
        "draft", "draft", 0, None)
    assert fresh["can"] == {"request": True, "approve": False, "request_changes": False,
                            "withdraw": False, "reopen": False, "comment": True}

    with django_capture_on_commit_callbacks(execute=True):
        resp = act(owner, website, artifact, "request", revision=0, reviewer_id=str(ana.id),
                   note="Check the prices.")
    review = data(resp)
    assert (review["state"], review["version"], review["revision"]) == ("in_review", 1, 1)
    assert review["reviewer"] == {"id": str(ana.id), "name": "Ana Lopez"}
    assert review["requested_by"]["name"] == "Site Owner"
    assert review["events"][-1]["kind"] == "requested"
    assert review["events"][-1]["reviewer_name"] == "Ana Lopez"
    assert review["events"][-1]["email"] == "" or review["events"][-1]["email"] == "sent"
    assert AgentReviewEvent.objects.get().email == "sent"
    assert [m.to for m in mail.outbox] == [["ana@example.com"]]
    assert mail.outbox[0].subject == 'Site Owner asked you to review "Battery guide"'
    assert (f"/projects/{website.id}/agent/artifacts/{artifact.id}"
            in mail.outbox[0].alternatives[0][0])
    assert "Check the prices." in mail.outbox[0].body and "Guide v1" not in mail.outbox[0].body

    # A new version keeps the request open and says so.
    add_version(artifact, content="# Guide v2")
    mine = current(ana, website, artifact)
    assert (mine["state"], mine["updated_since_request"], mine["latest_version"]) == (
        "in_review", True, 2)
    assert mine["can"]["approve"] and mine["can"]["request_changes"]

    with django_capture_on_commit_callbacks(execute=True):
        approved = data(act(ana, website, artifact, "approve", revision=1))
    assert (approved["state"], approved["version"], approved["decided_by"]["name"]) == (
        "approved", 2, "Ana Lopez")
    assert mail.outbox[-1].to == ["owner@example.com"]
    assert mail.outbox[-1].subject == 'Ana Lopez approved "Battery guide"'

    # Version 3 is not approved: the effective state is draft again.
    add_version(artifact, content="# Guide v3")
    after = current(owner, website, artifact)
    assert (after["state"], after["effective_state"], after["version"]) == (
        "approved", "draft", 2)
    listed = data(client_for(owner).get(f"{BASE}/websites/{website.id}/artifacts/"))
    assert listed[0]["review"] == {"state": "approved", "effective_state": "draft",
                                   "version": 2, "reviewer_name": "Ana Lopez",
                                   "updated_at": listed[0]["review"]["updated_at"]}
    assert after["can"]["request"] and not after["can"]["reopen"]


def test_changes_requested_withdraw_reopen_and_comments(team, website, artifact,
                                                        django_capture_on_commit_callbacks):
    owner, ana = team["owner"], team["ana"]
    act(owner, website, artifact, "request", revision=0, reviewer_id=str(ana.id))
    no_note = act(ana, website, artifact, "request_changes", revision=1)
    assert no_note.status_code == 400
    assert error(no_note)["message"] == "Say what should change."
    with django_capture_on_commit_callbacks(execute=True):
        changed = data(act(ana, website, artifact, "request_changes", revision=1,
                           note="Cite the warranty page."))
    assert changed["state"] == "changes_requested"
    assert mail.outbox[-1].subject == 'Ana Lopez asked for changes to "Battery guide"'
    assert changed["can"]["reopen"] and changed["can"]["request"]

    comment = client_for(owner).post(review_url(website, artifact, "comments/"),
                                     {"body": "Fixed in the next version."}, format="json")
    assert comment.status_code == 201
    assert data(comment)["kind"] == "comment" and data(comment)["email"] == ""
    assert current(owner, website, artifact)["revision"] == 2

    again = data(act(owner, website, artifact, "request", revision=2, reviewer_id=str(ana.id)))
    assert again["state"] == "in_review"
    withdrawn = data(act(owner, website, artifact, "withdraw", revision=3))
    assert (withdrawn["state"], withdrawn["reviewer"]) == ("draft", None)
    act(owner, website, artifact, "request", revision=4, reviewer_id=str(ana.id))
    act(ana, website, artifact, "approve", revision=5)
    reopened = data(act(team["ana"], website, artifact, "reopen", revision=6))
    assert reopened["state"] == "draft"
    kinds = [e["kind"] for e in reopened["events"]]
    assert kinds == ["requested", "changes_requested", "comment", "requested", "withdrawn",
                     "requested", "approved", "reopened"]


def test_conflicts_wrong_states_and_bad_requests(team, website, artifact):
    owner, ana, viewer = team["owner"], team["ana"], team["viewer"]
    act(owner, website, artifact, "request", revision=0, reviewer_id=str(ana.id))
    stale = act(ana, website, artifact, "approve", revision=0)
    assert stale.status_code == 409
    assert error(stale) | {} == {**error(stale), "code": "revision_conflict",
                                 "message": "Someone else changed this review. Reload to see it."}
    twice = act(owner, website, artifact, "request", revision=1, reviewer_id=str(ana.id))
    assert twice.status_code == 409 and error(twice)["code"] == "review_state"
    assert error(twice)["message"] == "This draft is in review now. Reload to see the latest."
    reopen = act(owner, website, artifact, "reopen", revision=1)
    assert error(reopen)["message"] == "This draft is in review now. Reload to see the latest."
    act(owner, website, artifact, "withdraw", revision=1)
    withdraw = act(owner, website, artifact, "withdraw", revision=2)
    assert error(withdraw)["message"] == (
        "This draft isn't under review now. Reload to see the latest.")
    for reviewer in (owner, viewer):
        bad = act(owner, website, artifact, "request", revision=2, reviewer_id=str(reviewer.id))
        assert bad.status_code == 400
        assert error(bad)["message"] == "Choose a teammate who can edit this project."
    unknown = client_for(owner).post(review_url(website, artifact), {"action": "publish",
                                                                     "revision": 2},
                                     format="json")
    assert unknown.status_code == 400

    empty = AgentArtifact.objects.create(website=website, kind="document", title="Empty")
    no_version = act(owner, website, empty, "request", revision=0, reviewer_id=str(ana.id))
    assert no_version.status_code == 400 and error(no_version)["code"] == "no_version"


def test_who_decides(team, website, artifact, django_user_model):
    owner, ana, admin = team["owner"], team["ana"], team["admin"]
    other_admin = make_user(django_user_model, "outsider@example.com", "Other Admin")
    from apps.accounts.models import Organization, OrganizationMember

    elsewhere = Organization.objects.create(name="Elsewhere", slug="elsewhere", owner=other_admin)
    OrganizationMember.objects.create(organization=elsewhere, user=other_admin, role="admin")

    act(admin, website, artifact, "request", revision=0, reviewer_id=str(ana.id))
    # The requester is a decider here only as an org admin; the owner decides too.
    assert data(act(owner, website, artifact, "approve", revision=1))["state"] == "approved"
    act(owner, website, artifact, "reopen", revision=2)
    act(owner, website, artifact, "request", revision=3, reviewer_id=str(admin.id))
    outsider = act(other_admin, website, artifact, "approve", revision=4)
    assert outsider.status_code == 404

    # A reviewer who left the team no longer decides; the org admin still does.
    act(owner, website, artifact, "withdraw", revision=4)
    act(owner, website, artifact, "request", revision=5, reviewer_id=str(ana.id))
    OrganizationMember.objects.filter(user=ana).update(role="viewer")
    refused = act(ana, website, artifact, "approve", revision=6)
    assert refused.status_code == 403
    OrganizationMember.objects.filter(user=ana).update(role="member")
    member_only = make_user(django_user_model, "member2@example.com", "Second Member")
    OrganizationMember.objects.create(organization=website.organization, user=member_only,
                                      role="member")
    not_decider = act(member_only, website, artifact, "approve", revision=6)
    assert not_decider.status_code == 403
    assert error(not_decider)["message"] == (
        "Only Ana Lopez, the project's owner or an organization admin can decide this review.")
    assert data(act(admin, website, artifact, "approve", revision=6))["state"] == "approved"


def test_the_only_member_approves_their_own_draft(user, website, artifact):
    review = current(user, website, artifact)
    assert review["sole_writer"] is True and review["can"]["approve"] is True
    no_one = act(user, website, artifact, "request", revision=0, reviewer_id=str(user.id))
    assert no_one.status_code == 400 and error(no_one)["code"] == "no_reviewers"
    assert error(no_one)["message"] == "Add a teammate to this project to ask for a review."
    approved = data(act(user, website, artifact, "approve", revision=0))
    assert (approved["state"], approved["version"], approved["decided_by"]["name"]) == (
        "approved", 1, "Site Owner")
    assert AgentReviewEvent.objects.get().recipient is None
    assert len(mail.outbox) == 0


def test_viewers_read_reviews_but_cannot_act_or_see_the_team(team, website, artifact):
    viewer = team["viewer"]
    review = current(viewer, website, artifact)
    assert not any(review["can"].values())
    assert act(viewer, website, artifact, "request", revision=0,
               reviewer_id=str(team["ana"].id)).status_code == 403
    comment = client_for(viewer).post(review_url(website, artifact, "comments/"), {"body": "Hi"},
                                      format="json")
    assert comment.status_code == 403
    assert client_for(viewer).get(f"{BASE}/websites/{website.id}/team/").status_code == 403
    members = data(client_for(team["owner"]).get(f"{BASE}/websites/{website.id}/team/"))
    assert [(m["name"], m["role"], m["is_you"]) for m in members] == [
        ("Site Owner", "owner", True), ("Ana Lopez", "member", False),
        ("Org Admin", "admin", False)]
    assert members[1]["email"] == "ana@example.com"


def test_inbox_items_reach_the_reviewer_and_the_requester_only(team, website, artifact):
    owner, ana, admin = team["owner"], team["ana"], team["admin"]
    act(owner, website, artifact, "request", revision=0, reviewer_id=str(ana.id), note="Please")
    client_for(admin).post(review_url(website, artifact, "comments/"),
                           {"body": "A comment from a third person."}, format="json")
    act(ana, website, artifact, "request_changes", revision=1, note="x" * 200)

    def inbox(who):
        items = data(client_for(who).get(f"{BASE}/websites/{website.id}/activity/"))
        return [i for i in items if i["type"].startswith("review_")]

    for_ana = inbox(ana)
    assert [i["type"] for i in for_ana] == ["review_comment", "review_requested"]
    assert for_ana[1] == {"type": "review_requested", "at": for_ana[1]["at"],
                          "artifact_id": str(artifact.id), "title": "Battery guide",
                          "kind": "document", "version": 1, "actor_name": "Site Owner"}
    for_owner = inbox(owner)
    assert [i["type"] for i in for_owner] == ["review_changes_requested", "review_comment"]
    assert len(for_owner[0]["excerpt"]) == 140
    assert inbox(admin) == []

    artifact.deleted_at = timezone.now()
    artifact.save(update_fields=["deleted_at"])
    assert inbox(ana) == [] and inbox(owner) == []


def test_review_boxes(team, website, artifact, user):
    owner, ana = team["owner"], team["ana"]
    second = AgentArtifact.objects.create(website=website, kind="page", agent_key="landing_page",
                                          title="Landing")
    add_version(second, content="<!DOCTYPE html>")
    act(owner, website, artifact, "request", revision=0, reviewer_id=str(ana.id))
    act(owner, website, second, "request", revision=0, reviewer_id=str(ana.id))
    act(ana, website, second, "approve", revision=1)

    def box(who, name):
        return [a["title"] for a in data(client_for(who).get(
            f"{BASE}/websites/{website.id}/reviews/", {"box": name}))]

    assert box(ana, "waiting") == ["Battery guide"]
    assert box(owner, "mine") == ["Battery guide"]
    assert box(owner, "approved") == ["Landing"]
    assert box(owner, "waiting") == []
    listed = data(client_for(ana).get(f"{BASE}/websites/{website.id}/reviews/",
                                      {"box": "waiting"}))
    assert listed[0]["review"]["state"] == "in_review"
    assert client_for(ana).get(f"{BASE}/websites/{website.id}/reviews/",
                               {"box": "everything"}).status_code == 400
    add_version(second, content="<!DOCTYPE html><p>v2</p>")
    assert box(owner, "approved") == []
    # An approval older than 90 days leaves the box too.
    act(owner, website, second, "request", revision=2, reviewer_id=str(ana.id))
    act(ana, website, second, "approve", revision=3)
    assert box(owner, "approved") == ["Landing"]
    AgentArtifactReview.objects.filter(artifact=second).update(
        decided_at=timezone.now() - timezone.timedelta(days=91))
    assert box(owner, "approved") == []


def test_emails_off_failed_and_escaped(team, website, artifact, settings, monkeypatch,
                                       django_capture_on_commit_callbacks):
    owner, ana = team["owner"], team["ana"]
    settings.AGENT_REVIEW_EMAILS = False
    act(owner, website, artifact, "request", revision=0, reviewer_id=str(ana.id))
    assert AgentReviewEvent.objects.get().email == "off"
    act(owner, website, artifact, "withdraw", revision=1)

    settings.AGENT_REVIEW_EMAILS = True
    settings.EMAIL_BACKEND = "django.core.mail.backends.dummy.EmailBackend"
    act(owner, website, artifact, "request", revision=2, reviewer_id=str(ana.id))
    assert AgentReviewEvent.objects.filter(kind="requested").latest("created_at").email == "off"
    act(owner, website, artifact, "withdraw", revision=3)

    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    monkeypatch.setattr("apps.notifications.services.email_service.EmailService.send_email",
                        staticmethod(lambda **kwargs: False))
    with django_capture_on_commit_callbacks(execute=True):
        act(owner, website, artifact, "request", revision=4, reviewer_id=str(ana.id))
    assert AgentReviewEvent.objects.filter(kind="requested").latest("created_at").email == "failed"
    act(owner, website, artifact, "withdraw", revision=5)

    monkeypatch.undo()
    artifact.title = 'Guide <script>alert(1)</script> & "more"'
    artifact.save(update_fields=["title"])
    with django_capture_on_commit_callbacks(execute=True):
        act(owner, website, artifact, "request", revision=6, reviewer_id=str(ana.id),
            note="<b>bold</b> request")
    sent = mail.outbox[-1]
    html = sent.alternatives[0][0]
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "&lt;b&gt;bold&lt;/b&gt; request" in html
    assert sent.subject == 'Site Owner asked you to review "Guide <script>alert(1)</script> & ' \
                           '"more""'
