"""How many agents run: the research agents' ceiling is one setting
(AGENT_SWARM_MAX_TASKS, default 50) that the tool, the orchestrator's
prompt and the tool description all follow, and the concurrency defaults
are raised through env settings."""
from __future__ import annotations

import json

import pytest

from apps.agent.prompts import orchestrator
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat
from apps.agent.tools import registry

pytestmark = pytest.mark.usefixtures("no_title")


def _research_line(prompt: str) -> str:
    start = prompt.index("A research has at most")
    return prompt[start:prompt.index("call it once more.", start)]


def test_the_defaults_allow_more_agents_at_once(settings):
    from config.settings import base

    assert base.AGENT_SWARM_MAX_TASKS == 50
    assert base.AGENT_MAX_CONCURRENT_RUNS == 6
    assert base.AGENT_USER_ACTIVE_RUNS == 2
    assert base.AGENT_SWARM_WORKERS == 8
    assert base.AGENT_SWARM_PROCESS_WORKERS == 16
    # The per-provider limits stay within the providers' plans.
    assert (base.AGENT_SWARM_SERP_CONCURRENCY, base.AGENT_SWARM_ENGINE_CONCURRENCY) == (5, 3)


@pytest.mark.parametrize(("max_tasks", "agents", "prompts"), [
    (50, "at most 50 agents", "use at most 5 prompts."),
    (30, "at most 30 agents", "use at most 3 prompts."),
    # Never more prompts than the tool takes (5), never fewer than 1.
    (200, "at most 200 agents", "use at most 5 prompts."),
    (12, "at most 12 agents", "use at most 1 prompt."),
])
def test_the_prompt_states_the_ceiling_it_is_built_with(max_tasks, agents, prompts):
    line = _research_line(orchestrator.system_prompt(max_tasks))
    assert agents in line and prompts in line
    assert "{max_" not in orchestrator.system_prompt(max_tasks)


def test_the_prompt_follows_the_setting(settings):
    settings.AGENT_SWARM_MAX_TASKS = 20
    line = _research_line(orchestrator.SYSTEM_PROMPT)
    assert "at most 20 agents" in line and "use at most 2 prompts." in line
    assert orchestrator.SYSTEM_PROMPT == orchestrator.system_prompt(20)


def test_the_tool_description_follows_the_setting(settings):
    settings.AGENT_SWARM_MAX_TASKS = 40
    description = {t["name"]: t for t in registry.client_tool_definitions()}[
        "research_swarm"]["description"]
    assert "a team of up to 40 agents" in description
    assert "at most 40 in total" in description
    assert "30" not in description and "{max_agents}" not in description


@pytest.mark.django_db
def test_a_new_ceiling_pins_a_new_snapshot_and_old_chats_keep_theirs(settings):
    from apps.agent.llm.snapshot import get_or_create_snapshot

    default = get_or_create_snapshot()
    assert "at most 50 agents" in default.system_text
    assert "up to 50 agents" in json.dumps(json.loads(default.tools_json))

    settings.AGENT_SWARM_MAX_TASKS = 25
    smaller = get_or_create_snapshot()
    assert smaller.id != default.id
    assert "at most 25 agents" in smaller.system_text
    assert "up to 25 agents" in json.dumps(json.loads(smaller.tools_json))
    default.refresh_from_db()
    assert "at most 50 agents" in default.system_text


@pytest.mark.django_db
def test_a_user_runs_two_replies_at_once_by_default(fake_anthropic, user, website):
    """AGENT_USER_ACTIVE_RUNS=2: a second chat starts while the first one
    still runs; a third waits (429 agent_busy)."""
    from django.urls import reverse
    from rest_framework.test import APIClient

    from apps.agent.models import AgentMessage, AgentRun

    def busy(chat):
        question = AgentMessage.objects.create(chat=chat, role="user", depth=0, parts=[])
        reply = AgentMessage.objects.create(chat=chat, parent=question, role="assistant",
                                            depth=1, status="streaming")
        return AgentRun.objects.create(chat=chat, user=user, website=website,
                                       user_message=question, assistant_message=reply,
                                       status="running")

    def send_url(chat):
        return reverse("agent-live-send", kwargs={"website_id": website.id, "chat_id": chat.id})

    api_client = APIClient()
    api_client.force_authenticate(user)
    busy(make_chat(user, website))
    fake_anthropic.queue(message(text("Hello.")))
    second = api_client.post(send_url(make_chat(user, website)), {"text": "Hi"}, format="json")
    assert second.status_code == 202

    busy(make_chat(user, website))
    third = api_client.post(send_url(make_chat(user, website)), {"text": "Hi"}, format="json")
    assert third.status_code == 429 and third.json()["error"]["code"] == "agent_busy"
