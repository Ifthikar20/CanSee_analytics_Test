"""The Context API (design/p2_contract.md 11b): entries, references,
documents, suggestions, limits, revisions and who may write."""
import pytest
from django.utils import timezone

from apps.agent.models import AgentContextDocument, AgentContextEntry, AgentContextReference
from apps.agent.services import context
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
def api(user):
    return client_for(user)


@pytest.fixture
def tracked(website):
    website.competitors = [{"name": "Evernote", "domain": "evernote.com"},
                           {"name": "Obsidian", "domain": "obsidian.md"}]
    website.save(update_fields=["competitors"])
    return website


def url(website, path):
    return f"{BASE}/websites/{website.id}/{path}"


def make_fact(website, status="approved", **fields):
    from apps.brand_vault.models import BrandFact

    return BrandFact.objects.create(website=website, subject="Northwind", predicate="offers",
                                    object=fields.pop("object", "a free plan for 3 users"),
                                    status=status, **fields)


def make_document(website, user, text="Northwind is the CRM for small fleets. Founded 2013."):
    return context.create_document(website, user, title="Positioning notes", text=text)


def test_create_an_entry_with_a_source_of_every_kind(api, user, tracked):
    fact = make_fact(tracked)
    document = make_document(tracked, user)
    resp = api.post(url(tracked, "context/entries/"), {
        "section": "company", "title": "Founded in 2013", "body": "Northwind started in 2013.",
        "references": [
            {"kind": "page", "url": "https://www.northwind.example/about", "quote": "Since 2013"},
            {"kind": "fact", "fact_id": str(fact.id)},
            {"kind": "document", "document_id": str(document.id), "quote": "founded   2013"},
            {"kind": "competitor", "competitor_domain": "https://www.Evernote.com/"},
        ],
    }, format="json")
    assert resp.status_code == 201
    entry = data(resp)
    assert (entry["section"], entry["status"], entry["origin"], entry["position"],
            entry["revision"], entry["updated_by_name"]) == (
        "company", "active", "user", 0, 1, "Site Owner")
    refs = {r["kind"]: r for r in entry["references"]}
    assert refs["page"]["label"] == "/about" and refs["page"]["state"] == "unchecked"
    assert refs["page"]["url"] == "https://www.northwind.example/about"
    assert refs["fact"]["label"] == "Northwind offers a free plan for 3 users"
    assert refs["fact"]["state"] == "ok" and refs["fact"]["url"] == ""
    assert refs["document"]["label"] == "Positioning notes" and refs["document"]["state"] == "ok"
    assert refs["competitor"]["label"] == "Evernote"
    assert refs["competitor"]["competitor_domain"] == "evernote.com"

    second = data(api.post(url(tracked, "context/entries/"),
                           {"section": "company", "body": "Fleets of 5 to 500."}, format="json"))
    assert second["position"] == 1 and second["title"] == ""

    overview = data(api.get(url(tracked, "context/")))
    company = next(s for s in overview["sections"] if s["key"] == "company")
    assert (company["entries"], company["suggested"], company["references"]) == (2, 0, 4)
    assert overview["totals"] == {"entries": 2, "suggested": 0, "references": 4}
    assert overview["documents"][0]["cited_by"] == 1
    assert overview["facts"] == {"approved": 1, "pending": 0}
    assert overview["competitors"] == [{"name": "Evernote", "domain": "evernote.com"},
                                       {"name": "Obsidian", "domain": "obsidian.md"}]


@pytest.mark.parametrize(("ref", "field", "message"), [
    ({"kind": "page", "url": "https://elsewhere.example/about"}, "url",
     "Use pages of northwind.example only."),
    ({"kind": "page", "url": "ftp://northwind.example/about"}, "url",
     "Enter a full http(s) address."),
    ({"kind": "competitor", "competitor_domain": "notion.so"}, "competitor_domain",
     "Choose a competitor this project tracks."),
    ({"kind": "document", "document_id": "6f1c1f1e-35b1-4a3e-9d3e-1c2b3a4d5e6f"},
     "document_id", "Choose a document of this project."),
])
def test_references_follow_the_rules_of_their_kind(api, tracked, ref, field, message):
    resp = api.post(url(tracked, "context/entries/"),
                    {"section": "company", "title": "x", "references": [ref]}, format="json")
    assert resp.status_code == 400
    assert error(resp)["code"] == "invalid"
    assert error(resp)["message"] == message
    assert field in error(resp)["details"]["fields"]
    assert not AgentContextEntry.objects.exists()


def test_facts_must_be_current_approved_facts_of_this_project(api, user, tracked,
                                                              django_user_model):
    other = tracked.__class__.objects.create(user=make_user(django_user_model, "o@example.com"),
                                             url="https://other.example", name="Other")
    entry = context.create_entry(tracked, user, section="offerings", title="Plans")
    refs = url(tracked, f"context/entries/{entry.id}/references/")
    for fact in (make_fact(other), make_fact(tracked, status="pending"),
                 make_fact(tracked, version_to=timezone.now())):
        resp = api.post(refs, {"kind": "fact", "fact_id": str(fact.id)}, format="json")
        assert resp.status_code == 400
        assert error(resp)["message"] == "Choose an approved brand fact of this project."
    auto = make_fact(tracked, status="auto")
    assert api.post(refs, {"kind": "fact", "fact_id": str(auto.id)},
                    format="json").status_code == 201


def test_a_document_quote_must_be_in_the_document(api, user, tracked):
    document = make_document(tracked, user)
    entry = context.create_entry(tracked, user, section="strategy", title="Small fleets")
    resp = api.post(url(tracked, f"context/entries/{entry.id}/references/"),
                    {"kind": "document", "document_id": str(document.id),
                     "quote": "the CRM for large fleets"}, format="json")
    assert resp.status_code == 400
    assert error(resp)["message"] == "These words aren't in the document."


def test_limits(api, user, tracked):
    for i in range(context.MAX_ENTRIES_PER_SECTION):
        AgentContextEntry.objects.create(website=tracked, section="audience", title=f"e{i}",
                                         status="suggested" if i % 2 else "active")
    resp = api.post(url(tracked, "context/entries/"), {"section": "audience", "title": "One more"},
                    format="json")
    assert resp.status_code == 400
    assert error(resp) == {"code": "too_many",
                           "message": "This section has 40 entries, the limit."} | {
        k: v for k, v in error(resp).items() if k not in ("code", "message")}

    entry = context.create_entry(tracked, user, section="company", title="Sources")
    refs = url(tracked, f"context/entries/{entry.id}/references/")
    for i in range(context.MAX_REFERENCES_PER_ENTRY):
        assert api.post(refs, {"kind": "page", "url": f"https://northwind.example/p{i}"},
                        format="json").status_code == 201
    eleventh = api.post(refs, {"kind": "page", "url": "https://northwind.example/p10"},
                        format="json")
    assert eleventh.status_code == 400 and error(eleventh)["code"] == "too_many"

    too_long = api.post(url(tracked, "context/entries/"),
                        {"section": "company", "body": "x" * 4001}, format="json")
    assert too_long.status_code == 400 and error(too_long)["code"] == "invalid"
    empty = api.post(url(tracked, "context/entries/"), {"section": "company"}, format="json")
    assert empty.status_code == 400
    unknown = api.post(url(tracked, "context/entries/"), {"section": "pricing", "title": "x"},
                       format="json")
    assert unknown.status_code == 400


def test_edits_and_deletes_need_the_current_revision(api, user, tracked, django_user_model):
    entry = context.create_entry(tracked, user, section="audience", title="Fleet managers")
    path = url(tracked, f"context/entries/{entry.id}/")
    teammate = make_user(django_user_model, "teammate@example.com", "Team Mate")
    join_org(tracked, user, {teammate: "member"})

    body = data(client_for(teammate).patch(path, {"revision": 1, "body": "Buy for 5-500 vans."},
                                           format="json"))
    assert (body["revision"], body["body"], body["updated_by_name"]) == (
        2, "Buy for 5-500 vans.", "Team Mate")
    stale = api.patch(path, {"revision": 1, "title": "Mine"}, format="json")
    assert stale.status_code == 409
    assert error(stale)["code"] == "revision_conflict"
    assert error(stale)["details"] == {"revision": 2}

    moved = data(api.patch(path, {"revision": 2, "section": "strategy"}, format="json"))
    assert (moved["section"], moved["revision"]) == ("strategy", 3)

    assert api.delete(f"{path}?revision=2").status_code == 409
    assert api.delete(path).status_code == 400
    assert api.delete(f"{path}?revision=3").status_code == 204
    assert not AgentContextEntry.objects.exists()
    assert api.patch(path, {"revision": 3}, format="json").status_code == 404


def test_viewers_read_the_context_but_cannot_change_it(user, tracked, django_user_model):
    viewer = make_user(django_user_model, "viewer@example.com")
    join_org(tracked, user, {viewer: "viewer"})
    entry = context.create_entry(tracked, user, section="audience", title="Fleet managers")
    document = make_document(tracked, user)
    api = client_for(viewer)
    overview = api.get(url(tracked, "context/"))
    assert overview.status_code == 200 and data(overview)["can_edit"] is False
    assert api.get(url(tracked, f"context/documents/{document.id}/")).status_code == 200
    attempts = [
        api.post(url(tracked, "context/entries/"), {"section": "audience", "title": "x"},
                 format="json"),
        api.patch(url(tracked, f"context/entries/{entry.id}/"), {"revision": 1, "title": "x"},
                  format="json"),
        api.delete(url(tracked, f"context/entries/{entry.id}/?revision=1")),
        api.post(url(tracked, "context/entries/review/"), {"accept": [str(entry.id)]},
                 format="json"),
        api.post(url(tracked, "context/documents/"), {"title": "x", "text": "y"}, format="json"),
        api.delete(url(tracked, f"context/documents/{document.id}/")),
    ]
    for resp in attempts:
        assert resp.status_code == 403
        assert error(resp)["message"] == (
            "Viewers can see this project's agent work but not change it.")


def test_another_projects_entries_are_not_found(api, user, django_user_model):
    from apps.websites.models import Website

    owner = make_user(django_user_model, "stranger@example.com")
    theirs = Website.objects.create(user=owner, url="https://theirs.example", name="Theirs")
    entry = context.create_entry(theirs, owner, section="audience", title="Secret")
    assert api.get(url(theirs, "context/")).status_code == 404
    mine = Website.objects.create(user=user, url="https://mine.example", name="Mine")
    resp = api.patch(url(mine, f"context/entries/{entry.id}/"), {"revision": 1, "title": "x"},
                     format="json")
    assert resp.status_code == 404


def test_reviewing_suggestions(api, user, tracked):
    active = context.create_entry(tracked, user, section="company", title="Founded in 2013")
    keep = AgentContextEntry.objects.create(website=tracked, section="company", title="Award",
                                            status="suggested", origin="built", position=0)
    drop = AgentContextEntry.objects.create(website=tracked, section="audience", title="Vans",
                                            status="suggested", origin="built", position=1)
    resp = api.post(url(tracked, "context/entries/review/"),
                    {"accept": [str(keep.id), str(active.id)], "dismiss": [str(drop.id)]},
                    format="json")
    assert data(resp) == {"accepted": 1, "dismissed": 1}
    keep.refresh_from_db()
    assert (keep.status, keep.position, keep.revision) == ("active", active.position + 1, 2)
    assert not AgentContextEntry.objects.filter(pk=drop.pk).exists()
    both = api.post(url(tracked, "context/entries/review/"),
                    {"accept": [str(keep.id)], "dismiss": [str(keep.id)]}, format="json")
    assert both.status_code == 400


def test_documents_crud_and_deleting_one_drops_its_references(api, user, tracked):
    created = api.post(url(tracked, "context/documents/"),
                       {"title": "Style guide", "text": "Write plainly. Never say synergy."},
                       format="json")
    assert created.status_code == 201
    document = data(created)
    assert (document["chars"], document["cited_by"]) == (33, 0)
    entry = context.create_entry(tracked, user, section="execution", title="Plain words",
                                 references=[{"kind": "document", "document_id": document["id"],
                                              "quote": "Write plainly."}])
    one = data(api.get(url(tracked, f"context/documents/{document['id']}/")))
    assert one["text"] == "Write plainly. Never say synergy." and one["cited_by"] == 1

    edited = data(api.patch(url(tracked, f"context/documents/{document['id']}/"),
                            {"text": "Write simply. Never say synergy."}, format="json"))
    assert edited["text"].startswith("Write simply")
    reference = AgentContextReference.objects.get(entry=entry)
    assert reference.state == "changed"

    assert api.delete(url(tracked, f"context/documents/{document['id']}/")).status_code == 204
    assert not AgentContextReference.objects.filter(entry=entry).exists()
    assert AgentContextEntry.objects.filter(pk=entry.pk).exists()

    for i in range(context.MAX_DOCUMENTS):
        AgentContextDocument.objects.create(website=tracked, title=f"d{i}", text="x", chars=1)
    full = api.post(url(tracked, "context/documents/"), {"title": "One more", "text": "x"},
                    format="json")
    assert full.status_code == 400 and error(full)["code"] == "too_many"


def test_reference_states_are_computed_for_facts_and_competitors(api, user, tracked):
    fact = make_fact(tracked)
    entry = context.create_entry(tracked, user, section="competitors", title="Versus Evernote",
                                 references=[{"kind": "fact", "fact_id": str(fact.id)},
                                             {"kind": "competitor",
                                              "competitor_domain": "evernote.com"}])
    fact.version_to = timezone.now()
    fact.save(update_fields=["version_to"])
    tracked.competitors = [{"name": "Obsidian", "domain": "obsidian.md"}]
    tracked.save(update_fields=["competitors"])

    shown = next(e for e in data(api.get(url(tracked, "context/")))["entries"]
                 if e["id"] == str(entry.id))
    assert {r["kind"]: r["state"] for r in shown["references"]} == {
        "fact": "retired", "competitor": "untracked"}
    # The agents get neither of them.
    assert context.agent_context(tracked)["competitors"][0]["references"] == []
    assert set(AgentContextReference.objects.values_list("state", flat=True)) == {"ok"}


def test_deleting_a_reference(api, user, tracked):
    entry = context.create_entry(tracked, user, section="offerings", title="Plans",
                                 references=[{"kind": "page",
                                              "url": "https://northwind.example/pricing"}])
    reference = entry.references.get()
    assert api.delete(url(tracked, f"context/references/{reference.id}/")).status_code == 204
    assert not entry.references.exists()
