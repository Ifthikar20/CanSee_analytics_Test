"""The agent and the free plan's prompt runs: a research or an engine check
that needs more runs than are left is refused before any engine is asked,
and the engines chosen at onboarding limit the first research's run."""
from __future__ import annotations

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.agent.models import AgentRun, AgentSwarm
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, send
from apps.agent.tests.test_swarm_tool import (
    PROMPT,
    StandIn,
    assert_refused,
    plan_input,
    tool_context,
)
from apps.agent.tools import research
from apps.agent.tools import swarm as swarm_tool
from apps.agent.tools.context import ToolError
from apps.agent.tools.schemas import CheckAiEnginesInput
from apps.metering.tests.prompt_run_support import make_paid, use_runs

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


@pytest.fixture
def executor(monkeypatch):
    stand_in = StandIn()
    monkeypatch.setattr("apps.agent.runtime.swarm.executor.execute_version", stand_in)
    return stand_in


@pytest.fixture
def configured(settings, website):
    """Google results, ChatGPT and Claude configured; a roomy allowance."""
    settings.SERPAPI_KEY = "serp-test"
    settings.OPENAI_API_KEY = "sk-test"
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.PERPLEXITY_API_KEY = ""
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0
    website.competitors = [{"name": "HubSpot", "domain": "hubspot.com"}]
    website.save(update_fields=["competitors"])
    return make_prompt(website, PROMPT, location="us")


@pytest.fixture
def api(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


def _send_url(chat):
    return reverse("agent-live-send", kwargs={"website_id": chat.website_id, "chat_id": chat.id})


# -- the research agents -------------------------------------------------------------------


def test_a_research_needing_more_runs_than_are_left_is_refused(chat, configured, executor):
    bp = configured
    by_id = plan_input(prompts=[{"prompt_id": str(bp.prompt_id)}])
    # ChatGPT and Claude are configured: two engine-answer agents.
    use_runs(chat.user, 19, chat.website)
    assert_refused(tool_context(chat), by_id, "insufficient_prompt_runs",
                   "This needs 2 free prompt runs and 1 of your 20 are left this month. "
                   "Choose fewer prompts or engines.")
    use_runs(chat.user, 20, chat.website)
    with pytest.raises(ToolError) as refused:
        swarm_tool.research_swarm(tool_context(chat), by_id)
    assert refused.value.message.startswith("You have used this month's 20 free prompt runs.")
    assert not AgentSwarm.objects.exists() and executor.calls == []


def test_a_research_that_asks_no_engine_needs_no_run(chat, configured, executor):
    bp = configured
    use_runs(chat.user, 20, chat.website)
    by_id = plan_input(prompts=[{"prompt_id": str(bp.prompt_id)}], engines=["gemini"])
    # Gemini has no key: the plan asks Google only, so it runs.
    swarm_tool.research_swarm(tool_context(chat), by_id)
    swarm = AgentSwarm.objects.get()
    assert not any(t["worker"] == "engine_answer" for t in swarm.tasks)


def test_paid_accounts_are_never_refused_for_runs(chat, configured, executor):
    make_paid(chat.user)
    bp = configured
    swarm_tool.research_swarm(tool_context(chat), plan_input(
        prompts=[{"prompt_id": str(bp.prompt_id)}]))
    assert AgentSwarm.objects.count() == 1


def test_a_rerun_needing_more_runs_than_are_left_is_refused(api, chat, configured, executor):
    bp = configured
    swarm_tool.research_swarm(tool_context(chat), plan_input(
        prompts=[{"prompt_id": str(bp.prompt_id)}]))
    swarm = AgentSwarm.objects.get()
    AgentRun.objects.filter(chat=chat).update(status="completed")
    use_runs(chat.user, 20, chat.website)
    url = reverse("agent-live-swarm-rerun",
                  kwargs={"website_id": chat.website_id, "swarm_id": swarm.id})
    resp = api.post(url, {"scope": "all"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "prompt_runs_exhausted"
    engine_task = api.post(url, {"scope": "task", "task_id": "engines.p1.claude"}, format="json")
    assert engine_task.status_code == 403
    # One Google page asks no engine, so the runs do not refuse it.
    one = api.post(url, {"scope": "task", "task_id": "google.p1.page1"}, format="json")
    assert one.json().get("error", {}).get("code") != "prompt_runs_exhausted"


# -- the engines chosen at onboarding ---------------------------------------------------------


def test_send_stores_the_chosen_engines_on_the_run(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Hello.")))
    run = send(chat, "Research us", engines=["claude", "chatgpt", "claude"]).run
    run.refresh_from_db()
    assert run.constraints == {"engines": ["claude", "chatgpt"]}


def test_a_send_without_engines_sets_no_limit(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Hello.")))
    run = send(chat, "Research us").run
    run.refresh_from_db()
    assert run.constraints == {}


def test_the_send_endpoint_takes_engines_and_refuses_unknown_ones(api, fake_anthropic, chat):
    bad = api.post(_send_url(chat), {"text": "Hi", "engines": ["chatgpt", "deepthought"]},
                   format="json")
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "invalid"
    assert not AgentRun.objects.exists()
    not_a_list = api.post(_send_url(chat), {"text": "Hi", "engines": "chatgpt"}, format="json")
    assert not_a_list.status_code == 400

    fake_anthropic.queue(message(text("Hello.")))
    ok = api.post(_send_url(chat), {"text": "Hi", "engines": ["gemini"]}, format="json")
    assert ok.status_code == 202
    assert AgentRun.objects.get().constraints == {"engines": ["gemini"]}


def test_the_research_asks_only_the_chosen_engines(chat, configured, executor):
    bp = configured
    ctx = tool_context(chat)
    AgentRun.objects.filter(id=ctx.run.id).update(constraints={"engines": ["claude"]})
    ctx.run.refresh_from_db()
    swarm_tool.research_swarm(ctx, plan_input(prompts=[{"prompt_id": str(bp.prompt_id)}]))
    swarm = AgentSwarm.objects.get()
    assert swarm.plan["engines_asked"] == ["claude"]


def test_the_chosen_engines_narrow_what_the_model_asks(chat, configured, executor):
    bp = configured
    ctx = tool_context(chat)
    AgentRun.objects.filter(id=ctx.run.id).update(
        constraints={"engines": ["claude", "gemini"]})
    ctx.run.refresh_from_db()
    swarm_tool.research_swarm(ctx, plan_input(prompts=[{"prompt_id": str(bp.prompt_id)}],
                                              engines=["chatgpt", "claude"]))
    assert AgentSwarm.objects.get().plan["engines_asked"] == ["claude"]


def test_when_the_model_asks_none_of_the_chosen_engines_the_choice_wins():
    from types import SimpleNamespace

    run = SimpleNamespace(constraints={"engines": ["claude"]})
    args = SimpleNamespace(engines=["chatgpt"])
    assert swarm_tool._engines_for(args, run) == ("claude",)
    assert swarm_tool._engines_for(SimpleNamespace(engines=None), None) is None
    assert swarm_tool.run_engines(SimpleNamespace(constraints={"engines": ["bogus"]})) is None


# -- check_ai_engines --------------------------------------------------------------------------


@pytest.fixture
def crawls(monkeypatch):
    calls = []

    def fake_crawl(website, prompt, user, *, close_db, should_stop=None, providers=None):
        calls.append(providers)
        return None

    monkeypatch.setattr(research, "_crawl", fake_crawl)
    return calls


def test_an_engine_check_needing_more_runs_than_are_left_is_refused(chat, configured, crawls):
    bp = configured
    use_runs(chat.user, 19, chat.website)
    ctx = tool_context(chat, planning=False)
    with pytest.raises(ToolError) as refused:
        research.check_ai_engines(ctx, CheckAiEnginesInput(prompt_ids=[bp.prompt_id]))
    assert refused.value.message == ("This needs 2 free prompt runs and 1 of your 20 are left "
                                     "this month. Choose fewer prompts or engines.")
    assert crawls == []
    # Refused before any engine part was added.
    assert not [p for p in ctx.emitter.snapshot()[0] if p["type"] == "engine_check"]


def test_an_engine_check_asks_only_the_chosen_engines(chat, configured, crawls, website):
    bp = configured
    ctx = tool_context(chat, planning=False)
    AgentRun.objects.filter(id=ctx.run.id).update(constraints={"engines": ["claude"]})
    ctx.run.refresh_from_db()
    research.check_ai_engines(ctx, CheckAiEnginesInput(prompt_ids=[bp.prompt_id]))
    assert crawls == [{"claude"}]
    parts = [p for p in ctx.emitter.snapshot()[0] if p["type"] == "engine_check"]
    chatgpt = next(p for p in parts if p["engine"] == "chatgpt")
    assert (chatgpt["status"], chatgpt["error"]) == (
        "unavailable", "Not one of the engines chosen for this research")


def test_a_check_with_a_run_left_for_each_engine_goes_ahead(chat, configured, crawls):
    bp = configured
    use_runs(chat.user, 18, chat.website)
    research.check_ai_engines(tool_context(chat, planning=False),
                              CheckAiEnginesInput(prompt_ids=[bp.prompt_id]))
    assert crawls == [None]
