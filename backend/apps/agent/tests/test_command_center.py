"""The usage dashboard (design/p2_contract.md 14): scopes, every count from
runs, swarm versions, artifact versions and ledger rows, the previous
window, buckets and top users."""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.accounts.models import AITokenUsage, OrganizationMember
from apps.agent.models import AgentArtifact, AgentRun, AgentSwarm, AgentSwarmVersion
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

URL = "/api/v1/agent/command-center/"


def _ago(days: int):
    return timezone.now() - timedelta(days=days)


def run(chat, user, *, status="completed", days=0):
    question = add_message(chat, text="go")
    reply = add_message(chat, parent=question, role="assistant", text="done")
    item = add_run(chat, question, reply, status=status)
    AgentRun.objects.filter(pk=item.pk).update(user=user, created_at=_ago(days))
    item.refresh_from_db()
    return item


def ledger(user, website, usd, *, module="agent", role="orchestrator", run_id=None, days=0):
    row = AITokenUsage.objects.create(
        user=user, website=website, module=module, model_name="claude-opus-5-5",
        input_tokens=10, output_tokens=5, estimated_cost_usd=Decimal(usd),
        metadata={"role": role, **({"run_id": str(run_id)} if run_id else {})},
    )
    AITokenUsage.objects.filter(pk=row.pk).update(created_at=_ago(days))
    return row


@pytest.fixture
def org(user, website, snapshot, django_user_model):
    teammate = make_user(django_user_model, "teammate@example.com", "Team Mate")
    former = make_user(django_user_model, "former@example.com", "Left Person")
    members = join_org(website, user, {teammate: "member", former: "member"})
    mine, theirs = make_chat(user, website, snapshot), make_chat(teammate, website, snapshot)
    gone = make_chat(former, website, snapshot)

    a = run(mine, user)
    ledger(user, website, "0.1000", run_id=a.id)
    ledger(user, website, "0.5000", role="subagent:page_optimizer", run_id=a.id)
    page = AgentArtifact.objects.create(website=website, kind="document",
                                        agent_key="page_optimizer", title="Pricing")
    add_version(page, content="# Pricing", run=a)

    b = run(theirs, teammate, status="failed", days=2)
    ledger(teammate, website, "0.0500", role="subagent:social_posts", run_id=b.id, days=2)

    c = run(mine, user, days=1)
    swarm = AgentSwarm.objects.create(website=website, chat=mine, user=user, title="Research")
    AgentSwarmVersion.objects.create(swarm=swarm, version=1, run=c, status="done")
    ledger(user, website, "0.0200", role="worker", run_id=c.id, days=1)
    report = AgentArtifact.objects.create(website=website, kind="report", agent_key="gap_analyst",
                                          title="Report")
    add_version(report, content="# Report", run=c)

    run(mine, user, status="running")
    run(gone, former, status="cancelled", days=3)
    members[former].delete()
    run(mine, user, days=10)

    ledger(user, website, "0.0400", module="llm_ranking", role=None)
    ledger(user, website, "0.0100", module="insights", role="answer_analysis")
    ledger(user, website, "0.0030", role="context_build")
    ledger(user, website, "0.0010", role="title")
    ledger(user, website, "0.0200", module="content_studio", role=None)
    ledger(user, None, "0.3000", module="rag", role=None)
    ledger(user, website, "0.5000", days=10)

    stranger = make_user(django_user_model, "stranger@example.com")
    elsewhere = website.__class__.objects.create(user=stranger, url="https://else.example",
                                                 name="Else")
    run(make_chat(stranger, elsewhere, snapshot), stranger)
    ledger(stranger, elsewhere, "9.0000")
    return {"teammate": teammate, "former": former, "elsewhere": elsewhere}


def test_the_organization_scope(user, website, org):
    body = data(client_for(user).get(URL, {"period": "7d"}))
    assert body["scope"] == "org"
    assert body["scopes"] == [{"key": "me", "label": "Your activity"},
                              {"key": "org", "label": "Northwind Team"}]
    assert body["window"]["interval"] == "day" and len(body["window"]["buckets"]) == 7
    assert body["websites"] == [{"id": str(website.id), "name": "Northwind"}]
    assert body["empty_reason"] is None
    assert body["totals"] == {
        "runs": 5, "runs_prev": 1, "completed": 2, "failed": 1, "cancelled": 1,
        "interrupted": 0, "in_progress": 1, "chats": 3, "drafts_saved": 2, "active_users": 3,
        "active_users_prev": 1, "ai_usd": "0.7440", "ai_usd_prev": "0.5000",
    }
    assert body["runs_series"] == {"completed": [0, 0, 0, 0, 0, 1, 1],
                                   "failed": [0, 0, 0, 0, 1, 0, 0],
                                   "cancelled": [0, 0, 0, 1, 0, 0, 0],
                                   "interrupted": [0] * 7}
    assert body["active_users_series"] == [0, 0, 0, 1, 1, 1, 1]
    assert body["spend_series"]["writers"][-1] == "0.5000"
    assert body["spend_series"]["writers"][4] == "0.0500"
    assert {c["key"]: (c["usd"], c["requests"]) for c in body["spend_by_category"]} == {
        "agent_replies": ("0.1010", 2), "writers": ("0.5500", 2), "research": ("0.0200", 1),
        "context": ("0.0030", 1), "engines": ("0.0400", 1), "insights": ("0.0100", 1),
        "other": ("0.0200", 1),
    }
    assert [c["label"] for c in body["spend_by_category"]] == [
        "Agent replies", "Writing agents", "Research agents", "Context builds",
        "AI engine answers", "Insights runs", "Other"]
    assert body["by_agent"] == [
        {"key": "page_optimizer", "label": "Page Optimizer", "team": "aeo_seo", "runs": 1,
         "drafts_saved": 1, "ai_usd": "0.5000"},
        {"key": "social_posts", "label": "Social Posts Agent", "team": "social", "runs": 1,
         "drafts_saved": 0, "ai_usd": "0.0500"},
        {"key": "research_agents", "label": "Research agents", "team": "aeo_seo", "runs": 1,
         "drafts_saved": 1, "ai_usd": "0.0200"},
        {"key": "agent_only", "label": "Agent only", "team": None, "runs": 2,
         "drafts_saved": 0, "ai_usd": "0.0000"},
    ]
    assert {t["key"]: t["runs"] for t in body["by_team"]} == {
        "aeo_seo": 2, "content": 0, "social": 1, "growth": 0, "pr": 0, "product_marketing": 0,
        "brand": 0}
    top = body["top_users"]
    assert [(u["name"], u["role"], u["runs"], u["active_days"], u["ai_usd"]) for u in top] == [
        ("Site Owner", "owner", 3, 2, "0.6940"),
        ("Team Mate", "member", 1, 1, "0.0500"),
        ("Left Person (former member)", None, 1, 1, "0.0000"),
    ]
    assert top[0]["email"] == "owner@example.com" and top[0]["last_active_at"]


def test_my_own_scope(user, website, org):
    body = data(client_for(user).get(URL, {"scope": "me", "period": "7d"}))
    assert body["scope"] == "me" and body["top_users"] is None
    totals = body["totals"]
    assert (totals["runs"], totals["runs_prev"], totals["active_users"]) == (3, 1, 1)
    # The ledger row without a project counts here only.
    assert totals["ai_usd"] == "0.9940"
    assert {c["key"]: c["usd"] for c in body["spend_by_category"]}["other"] == "0.3200"


def test_scopes_and_filters(user, website, org, settings, django_user_model):
    teammate = org["teammate"]
    mine = data(client_for(teammate).get(URL))
    assert mine["scope"] == "me" and [s["key"] for s in mine["scopes"]] == ["me"]
    refused = client_for(teammate).get(URL, {"scope": "org"})
    assert refused.status_code == 403
    assert error(refused)["message"] == (
        "Only organization owners and admins can see the whole organization.")

    outside = client_for(user).get(URL, {"website_id": str(org["elsewhere"].id)})
    assert outside.status_code == 404
    assert client_for(user).get(URL, {"website_id": "nope"}).status_code == 400
    assert client_for(user).get(URL, {"period": "1y"}).status_code == 400
    assert client_for(user).get(URL, {"scope": "team"}).status_code == 400
    one = data(client_for(user).get(URL, {"website_id": str(website.id), "period": "7d"}))
    assert one["filters"] == {"website_id": str(website.id)} and one["totals"]["runs"] == 5
    weekly = data(client_for(user).get(URL, {"period": "90d"}))
    assert weekly["window"]["interval"] == "week"

    settings.ORG_FEATURES_ENABLED = False
    off = data(client_for(user).get(URL))
    assert off["scope"] == "me" and [s["key"] for s in off["scopes"]] == ["me"]
    OrganizationMember.objects.filter(user=user).update(role="member")
    settings.ORG_FEATURES_ENABLED = True
    assert client_for(user).get(URL, {"scope": "org"}).status_code == 403


def test_nothing_recorded_is_an_empty_dashboard_not_zeros_pretending(django_user_model,
                                                                   settings):
    settings.AGENT_ENABLED = False
    newcomer = make_user(django_user_model, "new@example.com", "New Person")
    body = data(client_for(newcomer).get(URL))
    assert body["empty_reason"] == "no_activity"
    assert body["totals"]["runs"] == 0 and body["totals"]["ai_usd"] == "0.0000"
    assert body["by_agent"] == [] and body["websites"] == []
