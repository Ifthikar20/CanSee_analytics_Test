"""AGENT_WEB_TOOLS_ENABLED and the web max_uses reach chats started earlier.

Each chat pins the tool definitions of its snapshot, so turning web tools
off (to stop paid searches or close the fetch surface) used to change
only new chats while status/ already reported them off. The request now
withholds them (or lowers max_uses), and asks the API to drop thinking
blocks bound to the old tool list instead of rejecting the request.
"""

import json

import pytest

from apps.agent.llm.request import THINKING_BINDING_BETA
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import send

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


def _web_tools(request_json: dict) -> dict:
    return {t["name"]: t for t in request_json["tools"] if str(t.get("type", "")).startswith("web_")}


def test_unchanged_settings_replay_the_snapshot_exactly(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Answer.")))

    send(chat)

    request = fake_anthropic.last_request
    assert set(_web_tools(request.json)) == {"web_search", "web_fetch"}
    assert "block_binding" not in request.json["thinking"]
    assert THINKING_BINDING_BETA not in request.betas


def test_turning_web_tools_off_reaches_an_existing_chat(fake_anthropic, chat, settings):
    pinned = {"tools": json.loads(chat.snapshot.tools_json)}
    assert set(_web_tools(pinned)) == {"web_search", "web_fetch"}
    settings.AGENT_WEB_TOOLS_ENABLED = False
    fake_anthropic.queue(message(text("Answer.")))

    send(chat)

    request = fake_anthropic.last_request
    assert _web_tools(request.json) == {}
    assert {t["name"] for t in request.json["tools"]} >= {"get_prompt_gap", "run_agent"}
    assert request.json["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}
    assert THINKING_BINDING_BETA in request.betas


def test_a_lower_max_uses_reaches_an_existing_chat(fake_anthropic, chat, settings):
    settings.AGENT_WEB_SEARCH_MAX_USES = 2
    fake_anthropic.queue(message(text("Answer.")))

    send(chat)

    tools = _web_tools(fake_anthropic.last_request.json)
    assert tools["web_search"]["max_uses"] == 2
    assert tools["web_fetch"]["max_uses"] == 5
