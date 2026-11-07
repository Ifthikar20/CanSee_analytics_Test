"""Every request on a branch replays the earlier ones byte for byte.

Across sends, regenerate, edit, continue and a stop, each request's
system, tools and messages extend the previous request on the same branch
(plus what the model returned), so cached prefixes and thinking blocks
stay valid.
"""

import json

import pytest

from apps.agent.models import AgentMessage
from apps.agent.runtime import wire
from apps.agent.runtime.events import MemoryEventStore, set_event_store
from apps.agent.services.runs import start_continue, start_edit, start_regenerate
from apps.agent.tests.fakes import message, refusal, text, thinking, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import send
from apps.agent.tests.test_runtime_loop import CancelOn

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


def _blocks(role, blocks):
    return [(role, json.dumps(b, sort_keys=True, ensure_ascii=False)) for b in blocks]


def assert_extends(later: dict, earlier: dict, *appended):
    """``later`` starts with ``earlier``'s messages plus ``appended`` pairs."""
    assert later["system"] == earlier["system"]
    assert later["tools"] == earlier["tools"]
    assert later["model"] == earlier["model"]
    expected = wire.flatten(earlier["messages"])
    for chunk in appended:
        expected += chunk
    got = wire.flatten(later["messages"])
    assert got[: len(expected)] == expected


def test_prefix_holds_across_regenerate_edit_continue_and_stop(fake_anthropic, chat, user,
                                                               website):
    m1 = message(thinking("Reading the project.", signature="sig-1"), text("Answer one."))
    fake_anthropic.queue(m1)
    send(chat, "first")
    req = lambda i: fake_anthropic.requests[i].json  # noqa: E731

    call = tool_use("list_artifacts", {}, id="toolu_x")
    m2a = message(text("Checking."), call, stop_reason="tool_use")
    m2b = message(text("Answer two."))
    fake_anthropic.queue(m2a, m2b)
    second = send(chat, "second")
    assert_extends(req(1), req(0), _blocks("assistant", m1.content))
    results = [b for b in req(2)["messages"][-1]["content"] if b["type"] == "tool_result"]
    assert_extends(req(2), req(1), _blocks("assistant", m2a.content), _blocks("user", results))

    # Regenerate: the same history up to the user message, exactly.
    fake_anthropic.queue(message(text("Answer two, again.")))
    regen = start_regenerate(user=user, website=website,
                             message_id=second.assistant_message.id)
    assert req(3)["messages"] == req(1)["messages"]
    assert regen.assistant_message.parent_id == second.user_message.id

    # Edit: the history before the edited message, then the new text.
    fake_anthropic.queue(message(text("Edited answer.")))
    edited = start_edit(user=user, website=website, message_id=second.user_message.id,
                        text="second, edited")
    assert edited.user_message.parent_id == second.user_message.parent_id
    first_turn = _blocks("assistant", m1.content)
    assert_extends(req(4), req(0), first_turn)
    assert wire.flatten(req(4)["messages"])[len(wire.flatten(req(0)["messages"])) + 2] == (
        "user", json.dumps({"type": "text", "text": "second, edited"}, sort_keys=True))

    # Continue a truncated reply: the cut text, then a "Continue" user message.
    cut = message(text("A long answer that stops"), stop_reason="max_tokens")
    fake_anthropic.queue(cut)
    third = send(chat, "third")
    assert third.user_message.parent_id == edited.assistant_message.id
    fake_anthropic.queue(message(text(" and now it ends.")))
    start_continue(user=user, website=website, message_id=third.assistant_message.id)
    assert_extends(req(6), req(5), _blocks("assistant", cut.content),
                   _blocks("user", [{"type": "text", "text": "Continue"}]))

    # A stop keeps the safe blocks and answers the open call.
    set_event_store(CancelOn(lambda e: e["type"] == "part.added"
                             and e["part"]["type"] == "text"
                             and e["part"]["text"].startswith("Next")))
    stopped_call = tool_use("list_artifacts", {}, id="toolu_stop")
    fake_anthropic.queue(message(text("Partial answer."), stopped_call, text("Next words")))
    fourth = send(chat, "fourth")
    kept = json.loads(AgentMessage.objects.get(id=fourth.assistant_message.id).wire)
    assert kept[-1]["content"][0]["content"] == wire.STOPPED_RESULT
    set_event_store(MemoryEventStore())
    fake_anthropic.queue(message(text("Fine.")))
    send(chat, "fifth")
    assert_extends(req(8), req(7), _blocks("assistant", kept[0]["content"]),
                   _blocks("user", kept[1]["content"]))
    assert not fake_anthropic.overflow


def test_a_refused_first_turn_keeps_later_requests_valid(fake_anthropic, chat):
    fake_anthropic.queue(refusal())
    send(chat, "first")
    fake_anthropic.queue(message(text("Hello.")), message(text("Again.")))
    send(chat, "second")
    send(chat, "third")

    second = fake_anthropic.requests[1].json["messages"]
    assert [m["role"] for m in second] == ["user", "system"]
    assert [b["text"] for b in second[0]["content"]] == ["first", "second"]
    third = fake_anthropic.requests[2].json
    assert_extends(third, fake_anthropic.requests[1].json,
                   _blocks("assistant", [{"type": "text", "text": "Hello."}]))


def test_the_project_context_is_sent_once_and_the_date_only_when_it_changes(fake_anthropic,
                                                                            chat):
    fake_anthropic.queue(message(text("One.")), message(text("Two.")))
    send(chat, "first")
    send(chat, "second")

    second = fake_anthropic.requests[1].json["messages"]
    systems = [m for m in second if m["role"] == "system"]
    assert len(systems) == 1
    assert "Project: Northwind" in systems[0]["content"][0]["text"]
    assert "\n- Brand context: not set\n" in systems[0]["content"][0]["text"]
    assert second[-1]["role"] == "user"
