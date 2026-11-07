"""Findings (contract 6a, 6d, 6f): created from a results table or by hand,
listed with filters and counts, changed and deleted; shared with the
website's members, with the source chat visible only to its owner."""
from __future__ import annotations

import hashlib
from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.agent.models import AgentFinding, AgentSwarmVersion
from apps.agent.tests import contract_support as contract
from apps.agent.tests.api_support import client_for, data, error, join_org, make_user
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.test_swarm_api import store_swarm
from apps.agent.tests.test_swarm_tables import PROMPT

pytestmark = pytest.mark.django_db


@pytest.fixture
def swarm(chat):
    return store_swarm(chat)


def list_url(website_id):
    return reverse("agent-findings", kwargs={"website_id": website_id})


def detail_url(website_id, finding_id):
    return reverse("agent-finding-detail", kwargs={"website_id": website_id,
                                                    "finding_id": finding_id})


def from_swarm(swarm, sheet="prompts", row_keys=("p1",), version=1):
    return {"from_swarm": {"swarm_id": str(swarm.id), "version": version, "sheet": sheet,
                           "row_keys": list(row_keys)}}


def manual(**fields):
    return {"title": "Add pricing to the CRM page", "category": "site", "severity": "low",
            **fields}


def table_row(swarm, sheet: str, key: str) -> dict:
    table = AgentSwarmVersion.objects.get(swarm=swarm, version=1).table
    found = next(s for s in table["sheets"] if s["key"] == sheet)
    return next(r for r in found["rows"] if r["key"] == key)


# ── Creating ──────────────────────────────────────────────────────────────


def test_findings_from_a_table_copy_the_drafts(user, website, swarm):
    api = client_for(user)
    resp = api.post(list_url(website.id), from_swarm(swarm, row_keys=["p1"]), format="json")
    assert resp.status_code == 201
    body = data(resp)
    assert body["duplicates"] == [] and len(body["created"]) == 1
    finding = body["created"][0]
    assert not contract.missing(contract.FINDING, finding)
    draft = table_row(swarm, "prompts", "p1")["finding"]
    assert {k: finding[k] for k in ("title", "detail", "category", "severity", "prompt_text",
                                    "evidence")} == draft
    assert (finding["status"], finding["category_label"]) == ("open", "AI engines (GEO)")
    assert finding["created_by_name"] == "Site Owner"
    assert finding["status_changed_at"] is None and finding["status_changed_by_name"] is None
    assert not contract.missing(contract.FINDING_SOURCE, finding["source"])
    assert finding["source"] == {
        "swarm_id": str(swarm.id), "swarm_title": "Research Notion", "version": 1,
        "sheet": "prompts", "row_key": "p1",
        "task_ids": table_row(swarm, "prompts", "p1")["task_ids"],
        "chat_id": str(swarm.chat_id), "message_id": str(swarm.message_id),
    }
    stored = AgentFinding.objects.get()
    assert stored.dedupe_key == hashlib.sha1(f"{swarm.id}:prompts:p1".encode()).hexdigest()
    assert stored.source_chat_id == swarm.chat_id and stored.created_by == user

    again = api.post(list_url(website.id), from_swarm(swarm, sheet="gaps",
                                                      row_keys=["p1.g1"]), format="json")
    assert [f["category"] for f in data(again)["created"]] == ["site"]
    twice = api.post(list_url(website.id), from_swarm(swarm, row_keys=["p1"]), format="json")
    assert twice.status_code == 201
    assert data(twice)["created"] == []
    assert [f["id"] for f in data(twice)["duplicates"]] == [finding["id"]]
    assert AgentFinding.objects.count() == 2


def test_rows_without_a_draft_create_nothing(user, website, swarm):
    api = client_for(user)
    keys = [r["key"] for r in data(api.get(
        reverse("agent-swarm-version", kwargs={"website_id": website.id, "swarm_id": swarm.id,
                                               "number": 1})))["table"]["sheets"][2]["rows"]]
    assert keys == ["g2.com", "zapier.com"]
    resp = api.post(list_url(website.id), from_swarm(swarm, sheet="sources",
                                                     row_keys=["g2.com", "zapier.com"]),
                    format="json")
    assert resp.status_code == 400
    assert error(resp)["code"] == "no_finding"
    assert error(resp)["details"] == {"row_keys": ["zapier.com"]}
    assert not AgentFinding.objects.exists()

    unknown = api.post(list_url(website.id), from_swarm(swarm, row_keys=["p9"]), format="json")
    assert unknown.status_code == 400 and error(unknown)["code"] == "invalid"
    missing = api.post(list_url(website.id), from_swarm(swarm, version=2), format="json")
    assert missing.status_code == 404
    for rows in ([], [f"p{n}" for n in range(51)]):
        resp = api.post(list_url(website.id), from_swarm(swarm, row_keys=rows), format="json")
        assert resp.status_code == 400 and error(resp)["code"] == "invalid"


def test_another_users_research_is_not_found(user, website, swarm, django_user_model):
    member = make_user(django_user_model, "member@example.com", "Member")
    join_org(website, user, {member: "member"})
    resp = client_for(member).post(list_url(website.id), from_swarm(swarm), format="json")
    assert resp.status_code == 404
    assert not AgentFinding.objects.exists()


def test_manual_findings(user, website):
    api = client_for(user)
    resp = api.post(list_url(website.id), manual(detail="  The page has no prices.  ",
                                                 prompt_text="crm pricing"), format="json")
    assert resp.status_code == 201
    created = data(resp)["created"][0]
    assert (created["title"], created["detail"], created["category"], created["severity"],
            created["prompt_text"], created["source"], created["evidence"]) == (
        "Add pricing to the CRM page", "The page has no prices.", "site", "low", "crm pricing",
        None, [])
    assert AgentFinding.objects.get().dedupe_key == ""
    # Two manual findings never collide on the dedupe key.
    assert api.post(list_url(website.id), manual(), format="json").status_code == 201

    both = {**manual(), "from_swarm": {"swarm_id": contract.SID, "version": 1,
                                       "sheet": "prompts", "row_keys": ["p1"]}}
    for body in ({"category": "site", "severity": "low"}, manual(category="seo"),
                 manual(severity="urgent"), manual(title="x" * 201), manual(detail="d" * 2001),
                 both):
        resp = api.post(list_url(website.id), body, format="json")
        assert resp.status_code == 400 and error(resp)["code"] == "invalid", body
    assert error(api.post(list_url(website.id), both, format="json"))["message"] == (
        "Send from_swarm or a finding's fields, not both.")


# ── Listing ───────────────────────────────────────────────────────────────


def _findings(website, user, count, **fields):
    rows = []
    start = timezone.now() - timedelta(hours=1)
    for n in range(count):
        finding = AgentFinding.objects.create(
            website=website, title=fields.get("title", f"Finding {n}"),
            category=fields.get("category", "engines"), severity=fields.get("severity", "medium"),
            status=fields.get("status", "open"), detail=fields.get("detail", ""),
            prompt_text=fields.get("prompt_text", ""), created_by=user,
        )
        AgentFinding.objects.filter(id=finding.id).update(
            created_at=start + timedelta(seconds=n))
        rows.append(finding)
    return rows


def test_list_filters_counts_and_cursor(user, website, swarm):
    api = client_for(user)
    open_rows = _findings(website, user, 52)
    _findings(website, user, 2, status="done", category="google", title="Rank on Google")
    _findings(website, user, 1, status="dismissed", severity="low",
              prompt_text="crm for dentists")
    api.post(list_url(website.id), from_swarm(swarm), format="json")

    first = data(api.get(list_url(website.id)))
    assert set(first) == contract.FINDINGS_LIST
    assert first["counts"] == {"open": 53, "done": 2, "dismissed": 1}
    assert first["can_edit"] is True
    assert len(first["results"]) == 50 and first["next_cursor"]
    # Newest first: the table's finding, then the hand-made ones newest first.
    assert first["results"][0]["source"]["swarm_id"] == str(swarm.id)
    assert first["results"][1]["id"] == str(open_rows[-1].id)
    second = data(api.get(list_url(website.id), {"cursor": first["next_cursor"]}))
    assert len(second["results"]) == 3 and second["next_cursor"] is None
    assert {f["id"] for f in first["results"]}.isdisjoint({f["id"] for f in second["results"]})

    every = data(api.get(list_url(website.id), {"status": "all", "cursor": ""}))
    assert len(every["results"]) == 50 and every["counts"] == first["counts"]
    done = data(api.get(list_url(website.id), {"status": "done", "category": "google"}))
    assert [f["title"] for f in done["results"]] == ["Rank on Google", "Rank on Google"]
    assert done["counts"] == first["counts"]
    low = data(api.get(list_url(website.id), {"status": "all", "severity": "low"}))
    assert [f["status"] for f in low["results"]] == ["dismissed"]
    found = data(api.get(list_url(website.id), {"status": "all", "q": "DENTISTS"}))
    assert len(found["results"]) == 1
    by_swarm = data(api.get(list_url(website.id), {"swarm_id": str(swarm.id)}))
    assert len(by_swarm["results"]) == 1
    blank = data(api.get(list_url(website.id), {"status": "", "category": "", "severity": "",
                                                "swarm_id": "", "q": ""}))
    assert len(blank["results"]) == 50

    for params in ({"status": "closed"}, {"category": "seo"}, {"severity": "urgent"},
                   {"swarm_id": "nope"}, {"cursor": "not-a-cursor"}):
        resp = api.get(list_url(website.id), params)
        assert resp.status_code == 400 and error(resp)["code"] == "invalid", params


# ── Changing ──────────────────────────────────────────────────────────────


def test_patch_and_delete(user, website):
    api = client_for(user)
    finding = data(api.post(list_url(website.id), manual(), format="json"))["created"][0]
    url = detail_url(website.id, finding["id"])

    resp = api.patch(url, {"status": "done", "severity": "high"}, format="json")
    assert resp.status_code == 200
    body = data(resp)
    assert (body["status"], body["severity"], body["status_changed_by_name"]) == (
        "done", "high", "Site Owner")
    assert body["status_changed_at"]
    changed_at = body["status_changed_at"]
    body = data(api.patch(url, {"title": "  New title ", "detail": "More."}, format="json"))
    assert (body["title"], body["detail"], body["status_changed_at"]) == (
        "New title", "More.", changed_at)

    for bad in ({}, {"status": "closed"}, {"severity": "urgent"}, {"title": ""}):
        resp = api.patch(url, bad, format="json")
        assert resp.status_code == 400 and error(resp)["code"] == "invalid", bad

    assert api.delete(url).status_code == 204
    assert not AgentFinding.objects.exists()
    assert api.delete(url).status_code == 404


def test_viewers_read_and_members_share(user, website, swarm, django_user_model):
    viewer = make_user(django_user_model, "viewer@example.com", "Viewer")
    member = make_user(django_user_model, "member@example.com", "Member")
    join_org(website, user, {viewer: "viewer", member: "member"})
    owner_api = client_for(user)
    finding = data(owner_api.post(list_url(website.id), from_swarm(swarm),
                                  format="json"))["created"][0]

    listing = data(client_for(viewer).get(list_url(website.id)))
    assert listing["can_edit"] is False
    seen = listing["results"][0]
    # The research stays private: its id and title only, never the chat.
    assert (seen["source"]["swarm_id"], seen["source"]["chat_id"],
            seen["source"]["message_id"]) == (str(swarm.id), None, None)
    for call in (
        lambda c: c.post(list_url(website.id), manual(), format="json"),
        lambda c: c.patch(detail_url(website.id, finding["id"]), {"status": "done"},
                          format="json"),
        lambda c: c.delete(detail_url(website.id, finding["id"])),
    ):
        resp = call(client_for(viewer))
        assert resp.status_code == 403 and error(resp)["code"] == "permission_denied"

    member_api = client_for(member)
    assert data(member_api.get(list_url(website.id)))["can_edit"] is True
    body = data(member_api.patch(detail_url(website.id, finding["id"]), {"status": "dismissed"},
                                 format="json"))
    assert body["status_changed_by_name"] == "Member" and body["source"]["chat_id"] is None


def test_another_project_is_not_found(user, website, django_user_model):
    from apps.websites.models import Website

    finding = data(client_for(user).post(list_url(website.id), manual(),
                                         format="json"))["created"][0]
    stranger = make_user(django_user_model, "stranger@example.com")
    other = Website.objects.create(user=stranger, url="https://other.example", name="Other")
    api = client_for(stranger)
    assert api.get(list_url(website.id)).status_code == 404
    assert api.patch(detail_url(other.id, finding["id"]), {"status": "done"},
                     format="json").status_code == 404
    assert api.delete(detail_url(website.id, finding["id"])).status_code == 404
    assert data(api.get(list_url(other.id)))["results"] == []


def test_a_deleted_chat_leaves_its_findings(user, website, chat, swarm):
    api = client_for(user)
    api.post(list_url(website.id), from_swarm(swarm), format="json")
    chat.delete()
    finding = data(api.get(list_url(website.id)))["results"][0]
    assert finding["source"] == {"swarm_id": None, "swarm_title": None, "version": 1,
                                 "sheet": "prompts", "row_key": "p1",
                                 "task_ids": finding["source"]["task_ids"], "chat_id": None,
                                 "message_id": None}
    assert finding["title"] == f"Not named by ChatGPT for “{PROMPT}”"
