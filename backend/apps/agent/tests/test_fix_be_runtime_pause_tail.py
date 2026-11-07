"""A run that ends after pause_turn never stores an unpaired server_tool_use.

A paused response ends with a server tool call whose result only comes
with the resumed response. When the run ends before that (a gate stop,
an error, a stop, a cut-off), the stored wire must not keep the call:
the next turn would send it followed by a user message, which the API
rejects, and every later turn on that branch with it.
"""

import json
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime import wire
from apps.agent.runtime.events import set_event_store
from apps.agent.runtime.sweeper import sweep_stale_runs
from apps.agent.tests.fakes import http_error, message, server_web_search, text, thinking
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events, send
from apps.agent.tests.test_runtime_loop import CancelOn

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]

RESULTS = [{"title": "Review", "url": "https://reviews.example/northwind"}]


def _paused(call_id="srvtoolu_paused"):
    use, _ = server_web_search("northwind reviews", RESULTS, id=call_id)
    return message(text("Searching the web."), use, stop_reason="pause_turn",
                   web_search_requests=1)


def unpaired_server_calls(messages: list[dict]) -> list[str]:
    """server_tool_use ids without their result in the same assistant message."""
    missing = []
    for m in messages:
        if m.get("role") != "assistant" or not isinstance(m.get("content"), list):
            continue
        results = {b.get("tool_use_id") for b in m["content"]
                   if str(b.get("type", "")).endswith("_tool_result")}
        missing += [b["id"] for b in m["content"]
                    if b.get("type") == "server_tool_use" and b["id"] not in results]
    return missing


def _stored(started):
    run = AgentRun.objects.get(id=started.run.id)
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    return run, msg, json.loads(msg.wire)


SEARCHING = [{"role": "assistant", "content": [{"type": "text", "text": "Searching the web."}]}]


def test_request_limit_after_a_pause_keeps_the_next_turn_valid(fake_anthropic, chat, settings):
    settings.AGENT_MAX_REQUESTS_PER_RUN = 1
    fake_anthropic.queue(_paused())

    run, _, stored = _stored(send(chat, "What do reviews say?"))

    assert run.status == "failed" and run.error_code == "request_limit"
    assert stored == SEARCHING

    settings.AGENT_MAX_REQUESTS_PER_RUN = 24
    fake_anthropic.queue(message(text("Next answer.")))
    run2, _, _ = _stored(send(chat, "And now?"))

    assert run2.status == "completed"
    request = fake_anthropic.requests[-1].json
    assert request["messages"][-1]["role"] == "user"
    assert unpaired_server_calls(request["messages"]) == []


def test_an_error_on_the_resumed_request_drops_the_paused_call(fake_anthropic, chat):
    fake_anthropic.queue(_paused(), http_error(400, "invalid_request_error", "bad request"))

    run, msg, stored = _stored(send(chat))

    assert run.status == "failed" and run.error_code == "bad_request"
    assert msg.status == "failed"
    assert stored == SEARCHING


def test_a_stop_before_the_resume_drops_the_paused_call(fake_anthropic, chat):
    set_event_store(CancelOn(lambda e: e["type"] == "run.usage"))
    fake_anthropic.queue(_paused())

    run, _, stored = _stored(send(chat))

    assert run.status == "cancelled"
    assert stored == SEARCHING
    assert len(fake_anthropic.requests) == 1
    assert run_events(run)[-1]["type"] == "run.cancelled"


def test_a_reply_cut_off_inside_a_server_call_drops_it(fake_anthropic, chat):
    use, _ = server_web_search("northwind pricing", RESULTS, id="srvtoolu_cut")
    fake_anthropic.queue(message(text("Let me check."), use, stop_reason="max_tokens"))

    run, msg, stored = _stored(send(chat))

    assert msg.status == "truncated"
    assert stored == [{"role": "assistant", "content": [{"type": "text", "text": "Let me check."}]}]


def test_a_resumed_turn_keeps_its_paired_call(fake_anthropic, chat):
    use, result = server_web_search("northwind reviews", RESULTS, id="srvtoolu_ok")
    paused = message(text("Searching the web."), use, stop_reason="pause_turn")
    fake_anthropic.queue(paused, message(result, text("Reviews mention you.")))

    run, _, stored = _stored(send(chat))

    assert run.status == "completed"
    # Unchanged: the paused response and its resumption, as received.
    assert [m["role"] for m in stored] == ["assistant", "assistant"]
    assert stored[0]["content"] == paused.content
    assert unpaired_server_calls(wire.render(stored)) == []


def test_the_sweeper_drops_a_paused_call_too(chat):
    user_msg = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    use, _ = server_web_search("northwind reviews", RESULTS, id="srvtoolu_swept")
    reply = AgentMessage.objects.create(
        chat=chat, parent=user_msg, role="assistant", status="streaming",
        wire=wire.dumps([wire.assistant_message([{"type": "text", "text": "Searching."},
                                                 use.final])]),
    )
    AgentRun.objects.create(
        chat=chat, user=chat.user, website=chat.website, user_message=user_msg,
        assistant_message=reply, status="running", executor_id="host:1:1",
        heartbeat_at=timezone.now() - timedelta(seconds=3600),
    )

    assert sweep_stale_runs() == 1

    reply.refresh_from_db()
    assert json.loads(reply.wire) == [
        {"role": "assistant", "content": [{"type": "text", "text": "Searching."}]}]


# ── wire.close_turn ─────────────────────────────────────────────────────

USE = {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {"query": "q"}}
RESULT = {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": []}
SAY = {"type": "text", "text": "Searching."}
MORE = {"type": "text", "text": "More."}
CALL = {"type": "tool_use", "id": "toolu_1", "name": "list_artifacts", "input": {}}


def test_close_turn_keeps_a_safe_turn_as_it_is():
    done = [wire.assistant_message([SAY, USE, RESULT, MORE])]
    assert wire.close_turn(done) == done
    resumed = [wire.assistant_message([SAY, USE]), wire.assistant_message([RESULT, MORE])]
    assert wire.close_turn(resumed) == resumed
    answered = [wire.assistant_message([CALL]),
                {"role": "user", "content": [wire.tool_result("toolu_1", "ok")]}]
    assert wire.close_turn(answered) == answered
    assert wire.close_turn([]) == []


def test_close_turn_cuts_a_paused_call_across_the_trailing_messages():
    assert wire.close_turn([wire.assistant_message([SAY, USE])]) == [
        wire.assistant_message([SAY])]
    # The resumed part arrived without the result: both are cut together.
    assert wire.close_turn([wire.assistant_message([SAY, USE]),
                            wire.assistant_message([MORE])]) == [wire.assistant_message([SAY])]
    # Nothing worth keeping: a signed thinking block alone is dropped too.
    signed = thinking("Plan.", signature="sig-1").final
    assert wire.close_turn([wire.assistant_message([signed, USE])]) == []


def test_close_turn_answers_tool_calls_left_open():
    closed = wire.close_turn([wire.assistant_message([SAY, CALL])])
    assert closed == [wire.assistant_message([SAY, CALL]), wire.stopped_results(["toolu_1"])]
    assert wire.close_turn(closed) == closed
