"""Swarm reads (gunicorn) and the live re-run endpoint (contract 6a, 6b, 6c
status, 6f errors).

A re-run's run is dispatched like any run; here the dispatch is held back
so the queued run, its messages and its version row can be read as the
endpoint left them (the re-run turn itself is the runtime's).
"""
from __future__ import annotations

import pytest
from django.urls import reverse

from apps.accounts.models import AITokenUsage
from apps.agent.models import AgentChat, AgentRun, AgentSwarm, AgentSwarmVersion
from apps.agent.tests import contract_support as contract
from apps.agent.tests.api_support import (
    add_message,
    add_run,
    client_for,
    data,
    error,
    join_org,
    make_user,
)
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat
from apps.agent.tests.test_swarm_tables import (
    GAP,
    PROMPT,
    build_table,
    contract_research,
    expand,
    outcome_for,
    resolved,
)

pytestmark = pytest.mark.django_db


def store_swarm(chat, *, serp: bool = True, versions: int = 1) -> AgentSwarm:
    """The contract research as a stored swarm whose first ``versions``
    executions have tables, planned by a finished reply in ``chat``."""
    question = add_message(chat, role="user", text="Research Notion")
    reply = add_message(chat, parent=question, role="assistant", text="Done.",
                        status="complete")
    run = add_run(chat, question, reply, status="completed")
    AgentChat.objects.filter(id=chat.id).update(current_leaf=reply)
    if serp:
        shape, _, results = contract_research()
        expansion_plan = shape.plan
        categories, tasks = shape.categories, shape.tasks
    else:
        expansion = expand([resolved(1, PROMPT)], serp=False)
        expansion_plan, categories, tasks = expansion.plan, expansion.categories, expansion.tasks
        results = {}
    swarm = AgentSwarm.objects.create(
        website=chat.website, chat=chat, user=chat.user, message=reply, run=run,
        title="Research Notion", plan=expansion_plan, categories=categories, tasks=tasks,
        latest_version=versions,
    )
    for number in range(1, versions + 1):
        version = AgentSwarmVersion.objects.create(
            swarm=swarm, version=number, scope="all", task_ids=[t["id"] for t in tasks],
            status="partial", run=run, message=reply, results=results,
            counts={"total": 7, "done": 6, "failed": 1, "skipped": 0, "stopped": 0},
            duration_ms=134201,
        )
        version.table = build_table(swarm, version, outcome_for(version, results),
                                    gaps={"p1": {"gap": GAP}}, previous=None)
        version.save(update_fields=["table"])
    return swarm


@pytest.fixture
def swarm(chat):
    return store_swarm(chat)


@pytest.fixture
def held(monkeypatch):
    """Runs are created but not dispatched."""
    started = []
    monkeypatch.setattr("apps.agent.services.runs.dispatch_run", started.append)
    return started


@pytest.fixture
def allowance(settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0


def detail_url(swarm, website_id=None):
    return reverse("agent-swarm-detail", kwargs={"website_id": website_id or swarm.website_id,
                                                  "swarm_id": swarm.id})


def version_url(swarm, number):
    return reverse("agent-swarm-version", kwargs={"website_id": swarm.website_id,
                                                   "swarm_id": swarm.id, "number": number})


def rerun_url(swarm, website_id=None):
    return reverse("agent-live-swarm-rerun",
                   kwargs={"website_id": website_id or swarm.website_id, "swarm_id": swarm.id})


def spend(user, usd: float) -> None:
    AITokenUsage.objects.create(user=user, module="agent", provider="anthropic",
                                model_name="claude-opus-5-5", estimated_cost_usd=usd)


# ── Reads ─────────────────────────────────────────────────────────────────


def test_swarm_detail_for_its_owner(user, chat):
    swarm = store_swarm(chat, versions=2)
    AgentSwarmVersion.objects.create(swarm=swarm, version=3, scope="category",
                                     scope_key="google", task_ids=["google.p1.page1"],
                                     status="queued")
    body = data(client_for(user).get(detail_url(swarm)))
    assert not contract.missing(contract.SWARM_DETAIL, body)
    assert (body["id"], body["chat_id"], body["message_id"], body["latest_version"]) == (
        str(swarm.id), str(chat.id), str(swarm.message_id), 2)
    assert body["prompts"] == [{"key": "p1", "prompt_id": swarm.plan["prompts"][0]["prompt_id"],
                                "text": PROMPT, "location": "us"}]
    assert body["categories"][0] == {"key": "google", "label": "Google (SEO)",
                                     "task_ids": ["google.p1.page1"]}
    assert body["tasks"][1] == {"id": "engines.p1.chatgpt", "category": "engines",
                                "subcategory": "p1", "worker": "engine_answer",
                                "label": "ChatGPT"}
    versions = body["versions"]
    assert [v["version"] for v in versions] == [3, 2, 1]
    for v in versions:
        assert not contract.missing(contract.SWARM_DETAIL_VERSION, v)
    assert (versions[0]["scope_label"], versions[0]["status"], versions[0]["has_table"]) == (
        "Google (SEO)", "queued", False)
    assert versions[0]["counts"] == {"total": 1, "done": 0, "failed": 0, "skipped": 0,
                                     "stopped": 0}
    assert (versions[2]["scope_label"], versions[2]["has_table"], versions[2]["duration_ms"]) == (
        "All agents", True, 134201)
    assert versions[2]["counts"]["done"] == 6


def test_swarm_version_with_its_table(user, swarm):
    api = client_for(user)
    body = data(api.get(version_url(swarm, 1)))
    assert not contract.missing(contract.SWARM_VERSION, body)
    assert (body["swarm_id"], body["version"], body["scope"], body["scope_label"]) == (
        str(swarm.id), 1, "all", "All agents")
    contract.assert_table(body["table"])
    assert api.get(version_url(swarm, 9)).status_code == 404


def test_swarms_are_private_to_their_chat_user(user, website, swarm, django_user_model):
    from apps.websites.models import Website

    member = make_user(django_user_model, "member@example.com", "Member")
    join_org(website, user, {member: "member"})
    for url in (detail_url(swarm), version_url(swarm, 1)):
        resp = client_for(member).get(url)
        assert resp.status_code == 404 and error(resp)["code"] == "not_found"
    other_site = Website.objects.create(user=user, url="https://other.example", name="Other")
    assert client_for(user).get(detail_url(swarm, other_site.id)).status_code == 404
    stranger = make_user(django_user_model, "stranger@example.com")
    assert client_for(stranger).get(detail_url(swarm)).status_code == 404


def test_status_reports_the_research_agents(user, settings):
    api = client_for(user)
    status = data(api.get(reverse("agent-status")))
    assert not contract.missing(contract.STATUS, status)
    assert status["swarm"] == {"enabled": True, "max_agents": 30,
                               "worker_model": "claude-haiku-5-5"}
    settings.AGENT_SWARM_ENABLED = False
    settings.AGENT_SWARM_MAX_TASKS = 12
    assert data(api.get(reverse("agent-status")))["swarm"] == {
        "enabled": False, "max_agents": 12, "worker_model": "claude-haiku-5-5"}


# ── Re-run ────────────────────────────────────────────────────────────────


@pytest.mark.usefixtures("allowance")
def test_rerun_starts_a_turn_with_a_queued_version(user, chat, swarm, held):
    api = client_for(user)
    leaf = AgentChat.objects.get(id=chat.id).current_leaf_id
    resp = api.post(rerun_url(swarm), {"scope": "category", "category": "google"}, format="json",
                    HTTP_IDEMPOTENCY_KEY="rerun-1")
    assert resp.status_code == 202
    body = data(resp)
    assert set(body) == contract.RERUN_RESPONSE
    assert body["swarm_version"] == {"swarm_id": str(swarm.id), "version": 2,
                                     "scope": "category", "scope_key": "google",
                                     "task_ids": ["google.p1.page1"]}
    user_message, reply, run = body["user_message"], body["assistant_message"], body["run"]
    assert user_message["parts"] == [{"id": "p1", "type": "text",
                                      "text": "Re-run the Google (SEO) agents"}]
    assert user_message["parent_id"] == str(leaf)
    assert reply["parent_id"] == user_message["id"] and reply["status"] == "streaming"
    assert run["message_id"] == reply["id"] and run["status"] == "queued"
    assert held == [AgentRun.objects.get(id=run["id"]).id]
    stored = AgentRun.objects.get(id=run["id"])
    assert stored.trigger == "rerun" and stored.idempotency_key == "rerun-1"
    version = AgentSwarmVersion.objects.get(swarm=swarm, version=2)
    assert (version.status, version.run_id, str(version.message_id)) == (
        "queued", stored.id, reply["id"])
    assert (version.scope, version.scope_key, version.task_ids) == (
        "category", "google", ["google.p1.page1"])
    assert str(AgentChat.objects.get(id=chat.id).current_leaf_id) == reply["id"]

    again = api.post(rerun_url(swarm), {"scope": "category", "category": "google"},
                     format="json", HTTP_IDEMPOTENCY_KEY="rerun-1")
    assert again.status_code == 202
    assert data(again)["run"]["id"] == run["id"]
    assert data(again)["swarm_version"] == body["swarm_version"]
    assert AgentSwarmVersion.objects.filter(swarm=swarm).count() == 2

    busy = api.post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert busy.status_code == 409 and error(busy)["code"] == "run_in_progress"


@pytest.mark.usefixtures("allowance")
@pytest.mark.parametrize(("body", "text", "task_ids"), [
    ({"scope": "all"}, "Re-run all 7 research agents", None),
    ({"scope": "task", "task_id": "engines.p1.claude"},
     f"Re-run the Claude agent for “{PROMPT}”", ["engines.p1.claude"]),
])
def test_rerun_texts(user, swarm, held, body, text, task_ids):
    resp = client_for(user).post(rerun_url(swarm), body, format="json")
    assert resp.status_code == 202
    assert data(resp)["user_message"]["parts"][0]["text"] == text
    expected = task_ids or [t["id"] for t in swarm.tasks]
    assert data(resp)["swarm_version"]["task_ids"] == expected


@pytest.mark.usefixtures("allowance")
@pytest.mark.parametrize(("body", "field"), [
    ({"scope": "everything"}, "scope"),
    ({}, "scope"),
    ({"scope": "category"}, "category"),
    ({"scope": "category", "category": "nope"}, "category"),
    ({"scope": "task"}, "task_id"),
])
def test_rerun_input_is_validated(user, swarm, held, body, field):
    resp = client_for(user).post(rerun_url(swarm), body, format="json")
    assert resp.status_code == 400
    assert error(resp)["code"] == "invalid" and field in error(resp)["details"]["fields"]
    assert held == []


@pytest.mark.usefixtures("allowance")
def test_rerun_scope_must_exist_in_the_research(user, chat, held):
    swarm = store_swarm(chat, serp=False)
    api = client_for(user)
    resp = api.post(rerun_url(swarm), {"scope": "category", "category": "google"}, format="json")
    assert resp.status_code == 400
    assert error(resp) == {"code": "invalid",
                           "message": "This research has no agents in that category."}
    resp = api.post(rerun_url(swarm), {"scope": "task", "task_id": "google.p1.page1"},
                    format="json")
    assert resp.status_code == 400 and error(resp)["message"] == "This research has no such agent."
    assert held == []


@pytest.mark.usefixtures("allowance")
def test_rerun_refusals(user, chat, swarm, held, settings, website):
    api = client_for(user)

    settings.AGENT_SWARM_ENABLED = False
    resp = api.post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 503 and error(resp) == {
        "code": "swarm_disabled", "message": "The research agents are turned off on this server."}
    settings.AGENT_SWARM_ENABLED = True

    settings.AI_FREE_MONTHLY_CAP_USD = 0.10
    spend(user, 0.05)
    resp = api.post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 403
    assert error(resp) == {
        "code": "insufficient_allowance",
        "message": "Not enough AI allowance: this re-run needs up to $0.06 and $0.05 of the "
                   "$0.10 monthly allowance is left.",
        "details": {"need_usd": 0.06, "left_usd": 0.05, "cap_usd": 0.1},
    }
    # A single Google page costs no AI allowance.
    one_page = api.post(rerun_url(swarm), {"scope": "task", "task_id": "google.p1.page1"},
                        format="json")
    assert one_page.status_code == 202
    AgentRun.objects.filter(chat=chat).update(status="completed")

    spend(user, 0.10)
    resp = api.post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 403 and error(resp)["code"] == "allowance_exceeded"
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0

    AgentSwarmVersion.objects.bulk_create([
        AgentSwarmVersion(swarm=swarm, version=n, scope="all", task_ids=[], status="done")
        for n in range(3, 51)
    ])
    resp = api.post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 400 and error(resp) == {
        "code": "version_limit",
        "message": "This research already has 50 versions; start a new research."}

    other_chat = make_chat(user, website)
    other_question = add_message(other_chat, role="user", text="Hi")
    other_reply = add_message(other_chat, parent=other_question, role="assistant", text="...")
    add_run(other_chat, other_question, other_reply, status="running")
    AgentSwarmVersion.objects.filter(swarm=swarm, version__gt=2).delete()
    resp = api.post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 429 and error(resp)["code"] == "agent_busy"
    assert len(held) == 1


@pytest.mark.usefixtures("allowance")
def test_rerun_needs_a_reply_to_follow(user, chat, swarm, held):
    question = add_message(chat, role="user", text="Unanswered")
    AgentChat.objects.filter(id=chat.id).update(current_leaf=question)
    resp = client_for(user).post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 400
    assert error(resp) == {"code": "invalid", "message": "Send a message first."}
    assert not AgentSwarmVersion.objects.filter(swarm=swarm, version=2).exists()


@pytest.mark.usefixtures("allowance")
def test_rerun_access(user, website, swarm, held, django_user_model, settings):
    viewer = make_user(django_user_model, "viewer@example.com")
    member = make_user(django_user_model, "member@example.com")
    join_org(website, user, {viewer: "viewer", member: "member"})
    resp = client_for(viewer).post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 403 and error(resp)["code"] == "permission_denied"
    resp = client_for(member).post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 404
    settings.AGENT_PROCESS = False
    resp = client_for(user).post(rerun_url(swarm), {"scope": "all"}, format="json")
    assert resp.status_code == 503 and error(resp)["code"] == "agent_unavailable"
    assert held == []
