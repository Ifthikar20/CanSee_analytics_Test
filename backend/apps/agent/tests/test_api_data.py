"""Agent API: artifacts, brand context, suggestions and activity."""
import hashlib
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.agent.models import AgentArtifact, AgentArtifactVersion, AgentBrandContext
from apps.agent.services.artifacts import add_version
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


@pytest.fixture
def api(user):
    return client_for(user)


def site_url(website, path):
    return f"{BASE}/websites/{website.id}/{path}"


def make_artifact(website, kind="page", title="Landing", *, versions=1, by=None, chat=None,
                  **fields):
    artifact = AgentArtifact.objects.create(
        website=website, kind=kind, title=title, agent_key=fields.pop("agent_key", "landing_page"),
        created_by=by, source_chat=chat, **fields,
    )
    for n in range(1, versions + 1):
        add_version(artifact, content=f"<!DOCTYPE html><p>v{n}</p>", summary=f"Version {n}",
                    warnings=[{"path": "h1", "message": "two h1"}] if n == versions else [],
                    created_by=by)
    return artifact


# ── artifacts ─────────────────────────────────────────────────────────────


def test_list_filters_by_kind_and_title_newest_first(api, user, website, django_user_model):
    page = make_artifact(website, "page", "Battery landing page", by=user)
    doc = make_artifact(website, "document", "What is a battery warranty?", by=user)
    make_artifact(website, "sheet", "Spring campaign", by=user)
    make_artifact(website, "page", "Never finished", versions=0)
    gone = make_artifact(website, "page", "Deleted page")
    gone.deleted_at = timezone.now()
    gone.save()
    other_site = website.__class__.objects.create(
        user=make_user(django_user_model, "other@example.com"),
        url="https://other.example", name="Other",
    )
    make_artifact(other_site, "page", "Someone else's page")

    listed = data(api.get(site_url(website, "artifacts/")))
    assert [a["title"] for a in listed] == [
        "Spring campaign", "What is a battery warranty?", "Battery landing page",
    ]
    assert set(listed[0]) == {
        "id", "kind", "title", "agent_key", "latest_version", "created_at", "updated_at",
        "created_by_name", "source_chat_id", "review",
    }
    assert listed[0]["review"] == {"state": "draft", "effective_state": "draft", "version": None,
                                   "reviewer_name": None, "updated_at": None}
    pages_docs = data(api.get(site_url(website, "artifacts/"), {"kind": "page,document"}))
    assert {a["id"] for a in pages_docs} == {str(page.id), str(doc.id)}
    found = data(api.get(site_url(website, "artifacts/"), {"q": "WARRANTY"}))
    assert [a["id"] for a in found] == [str(doc.id)]

    resp = api.get(site_url(website, "artifacts/"), {"kind": "page,video"})
    assert resp.status_code == 400 and error(resp)["code"] == "invalid"


def test_detail_carries_the_latest_version(api, user, website):
    artifact = make_artifact(website, "page", "Battery landing page", versions=2, by=user)
    body = data(api.get(site_url(website, f"artifacts/{artifact.id}/")))
    assert body["version"] == 2 and body["latest_version"] == 2
    assert body["content"] == "<!DOCTYPE html><p>v2</p>"
    assert body["content_type"] == "text/html"
    assert body["summary"] == "Version 2"
    assert body["warnings"] == [{"path": "h1", "message": "two h1"}]
    assert body["data"] is None
    assert body["created_by_name"] == "Site Owner"


def test_versions_list_and_one_version(api, user, website):
    artifact = make_artifact(website, "document", "Guide", versions=2, by=user,
                             agent_key="aeo_article")
    versions = data(api.get(site_url(website, f"artifacts/{artifact.id}/versions/")))
    assert [v["version"] for v in versions] == [2, 1]
    assert set(versions[0]) == {"version", "created_at", "summary", "source", "size_bytes"}
    assert versions[1]["size_bytes"] == len(b"<!DOCTYPE html><p>v1</p>")
    first = data(api.get(site_url(website, f"artifacts/{artifact.id}/versions/1/")))
    assert first["version"] == 1 and first["content"] == "<!DOCTYPE html><p>v1</p>"
    assert first["content_type"] == "text/markdown"
    assert api.get(site_url(website, f"artifacts/{artifact.id}/versions/9/")).status_code == 404


def test_rename_and_soft_delete(api, user, website):
    artifact = make_artifact(website, by=user)
    url = site_url(website, f"artifacts/{artifact.id}/")
    body = data(api.patch(url, {"title": "Battery page v2"}, format="json"))
    assert body["title"] == "Battery page v2"
    assert api.patch(url, {"title": ""}, format="json").status_code == 400
    assert api.delete(url).status_code == 204
    assert api.get(url).status_code == 404
    artifact.refresh_from_db()
    assert artifact.deleted_at is not None
    assert AgentArtifactVersion.objects.filter(artifact=artifact).count() == 1


def test_artifacts_are_shared_but_the_chat_link_is_the_owners(
    user, website, snapshot, django_user_model,
):
    teammate = make_user(django_user_model, "teammate@example.com", "Team Mate")
    join_org(website, user, {teammate: "member"})
    chat = make_chat(user, website, snapshot)
    artifact = make_artifact(website, by=user, chat=chat)

    mine = data(client_for(user).get(site_url(website, f"artifacts/{artifact.id}/")))
    assert mine["source_chat_id"] == str(chat.id)
    theirs = client_for(teammate).get(site_url(website, f"artifacts/{artifact.id}/"))
    assert theirs.status_code == 200
    assert data(theirs)["source_chat_id"] is None
    renamed = client_for(teammate).patch(
        site_url(website, f"artifacts/{artifact.id}/"), {"title": "Team edit"}, format="json",
    )
    assert renamed.status_code == 200


def test_viewers_read_artifacts_but_cannot_change_them(user, website, django_user_model):
    viewer = make_user(django_user_model, "viewer@example.com")
    join_org(website, user, {viewer: "viewer"})
    artifact = make_artifact(website, by=user)
    api = client_for(viewer)
    url = site_url(website, f"artifacts/{artifact.id}/")
    assert api.get(site_url(website, "artifacts/")).status_code == 200
    assert api.get(url).status_code == 200
    assert api.get(f"{url}versions/").status_code == 200
    assert api.patch(url, {"title": "x"}, format="json").status_code == 403
    assert api.delete(url).status_code == 403
    created = api.post(site_url(website, "context/entries/"),
                       {"section": "audience", "title": "x"}, format="json")
    assert created.status_code == 403
    artifact.refresh_from_db()
    assert artifact.title == "Landing" and artifact.deleted_at is None


def test_add_version_numbers_hashes_and_strips_nul(website):
    artifact = AgentArtifact.objects.create(website=website, kind="document", title="Doc")
    first = add_version(artifact, content="# One\x00", data={"k\x00": ["v\x00"]})
    second = add_version(artifact, content="# Two")
    assert (first.version, second.version) == (1, 2)
    assert first.content == "# One" and first.data == {"k": ["v"]}
    assert first.content_type == "text/markdown"
    assert first.sha256 == hashlib.sha256(b"# One").hexdigest()
    assert first.size_bytes == 5
    artifact.refresh_from_db()
    assert artifact.latest_version == 2


# ── context (design/p2_contract.md 11b; the CRUD is in test_context_api) ──


def test_context_starts_empty_and_put_is_gone(api, website):
    body = data(api.get(site_url(website, "context/")))
    assert [s["key"] for s in body["sections"]] == [
        "company", "audience", "competitors", "offerings", "strategy", "execution"]
    assert all(s["entries"] == 0 and s["suggested"] == 0 and s["references"] == 0
               for s in body["sections"])
    assert body["entries"] == [] and body["documents"] == []
    assert body["totals"] == {"entries": 0, "suggested": 0, "references": 0}
    assert body["facts"] == {"approved": 0, "pending": 0}
    assert body["can_edit"] is True
    put = api.put(site_url(website, "context/"), {"revision": 0, "audience": "x"}, format="json")
    assert put.status_code == 405
    assert not AgentBrandContext.objects.exists()


# ── suggestions ───────────────────────────────────────────────────────────


def test_suggestions_are_empty_without_tracked_prompts(api, website):
    resp = api.get(site_url(website, "suggestions/"))
    assert resp.status_code == 200
    assert data(resp) == []


def _tracked_prompt(website, user, text, google_position, engine_rank):
    """A tracked prompt with a Google check and one answer from every engine."""
    from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
    from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
    from apps.prompt_library.services._hash import text_hash
    from apps.search_gap.models import GoogleRankCheck

    industry, _ = Industry.objects.get_or_create(
        slug="agent-tests", defaults={"name": "Agent tests", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, text_hash=text_hash(text),
        intent_bucket="category", style="question", source=PromptSource.MANUAL,
    )
    brand_prompt = BrandPrompt.objects.create(website=website, prompt=prompt, location="us")
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=user, status=LLMRankingAudit.STATUS_COMPLETED,
        prompts=[text], business_name=website.name,
        providers_queried=["gpt4", "claude", "gemini", "grok", "perplexity"],
        completed_at=timezone.now(),
    )
    LLMRankingResult.objects.bulk_create([
        LLMRankingResult(
            audit=audit, provider=engine, prompt=text, response_text="answer",
            is_mentioned=engine_rank is not None, mention_rank=engine_rank,
            source_prompt=prompt,
        )
        for engine in ("gpt4", "claude", "gemini", "grok", "perplexity")
    ])
    GoogleRankCheck.objects.create(
        website=website, brand_prompt=brand_prompt, query=text, location="us", depth=100,
        position=google_position, checked_at=timezone.now() - timedelta(hours=1),
    )


def test_suggestions_come_from_tracked_prompts_and_their_gap(api, user, website):
    _tracked_prompt(website, user, "best battery for e-bikes", 94, 2)       # AI ahead
    _tracked_prompt(website, user, "lithium vs lead acid", 4, None)         # Google ahead
    _tracked_prompt(website, user, "how long do batteries last", None, None)  # invisible
    _tracked_prompt(website, user, "northwind battery reviews", 2, 1)       # strong in both

    suggestions = data(api.get(site_url(website, "suggestions/")))
    by_agent = {s["agent"]: s for s in suggestions}
    assert len(suggestions) == 3
    assert by_agent["gap_analyst"] == {
        "label": 'Research "best battery for e-bikes"',
        "prompt": 'Research how we rank for "best battery for e-bikes" on Google and AI engines',
        "agent": "gap_analyst",
    }
    assert by_agent["aeo_article"]["label"] == (
        'Write an article to get cited for "lithium vs lead acid"'
    )
    assert by_agent["landing_page"]["label"] == 'Draft a landing page for "how long do batteries last"'
    # Biggest gap first: +85 (AI ahead) before -80 (Google ahead) before 0.
    assert [s["agent"] for s in suggestions] == ["gap_analyst", "aeo_article", "landing_page"]


def test_suggestions_stop_at_six(api, user, website):
    for i in range(8):
        _tracked_prompt(website, user, f"battery question {i}", 94, 2)
    assert len(data(api.get(site_url(website, "suggestions/")))) == 6


# ── activity ──────────────────────────────────────────────────────────────


def test_activity_lists_my_runs_and_the_projects_artifacts(
    api, user, website, snapshot, django_user_model,
):
    teammate = make_user(django_user_model, "teammate@example.com", "Team Mate")
    join_org(website, user, {teammate: "member"})
    now = timezone.now()

    chat = make_chat(user, website, snapshot, title="Battery research")
    question = add_message(chat, text="research")
    reply = add_message(chat, parent=question, role="assistant", text="done")
    add_run(chat, question, reply, status="completed", finished_at=now - timedelta(minutes=5))
    failed_reply = add_message(chat, parent=question, role="assistant", text="")
    add_run(chat, question, failed_reply, status="failed", finished_at=now)

    their_chat = make_chat(teammate, website, snapshot, title="Their private chat")
    their_q = add_message(their_chat, text="secret")
    their_reply = add_message(their_chat, parent=their_q, role="assistant", text="x")
    add_run(their_chat, their_q, their_reply, status="completed", finished_at=now)

    mine = make_artifact(website, "page", "My page", by=user, chat=chat)
    theirs = make_artifact(website, "document", "Their doc", by=teammate, chat=their_chat)
    gone = make_artifact(website, "sheet", "Deleted sheet", by=user)
    gone.deleted_at = now
    gone.save()

    items = data(api.get(site_url(website, "activity/")))
    assert [i["type"] for i in items] == ["artifact_version", "artifact_version", "run_completed"]
    assert [i.get("title") for i in items] == ["Their doc", "My page", "Battery research"]
    their_item, my_item, run_item = items
    assert their_item["chat_id"] is None
    assert (their_item["artifact_id"], their_item["kind"], their_item["version"]) == (
        str(theirs.id), "document", 1,
    )
    assert my_item["chat_id"] == str(chat.id) and my_item["artifact_id"] == str(mine.id)
    assert run_item["chat_id"] == str(chat.id)
    assert set(run_item) == {"type", "at", "chat_id", "title"}


def test_activity_keeps_the_last_twenty(api, user, website):
    artifact = make_artifact(website, "document", "Doc", versions=25, by=user)
    items = data(api.get(site_url(website, "activity/")))
    assert len(items) == 20
    assert items[0]["version"] == 25 and items[0]["artifact_id"] == str(artifact.id)
