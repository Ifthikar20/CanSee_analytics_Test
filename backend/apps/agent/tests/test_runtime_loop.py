"""The run loop against scripted streams: stop reasons, tools, retries, stops."""

import json

import pytest

from apps.accounts.models import AITokenUsage
from apps.agent.models import AgentArtifact, AgentMessage, AgentRun
from apps.agent.runtime.events import MemoryEventStore, set_event_store
from apps.agent.runtime.parts import replay
from apps.agent.runtime.registry import get_registry
from apps.agent.tests.fakes import (
    FALLBACK_MODEL,
    MODEL,
    error_event,
    fallback,
    iteration,
    malformed_tool_json,
    message,
    refusal,
    server_web_search,
    text,
    thinking,
    tool_use,
)
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import event_types, run_events, send, tool_results_of

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


def _refresh(started):
    run = AgentRun.objects.get(id=started.run.id)
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    return run, msg


def test_basic_turn_streams_parts_and_stores_exact_wire(fake_anthropic, chat):
    scripted = message(
        thinking("Checking the tracked prompts.", signature="sig-1"),
        text("Hello \x00world. You rank #3."),
        input_tokens=1200, output_tokens=80, cache_write_1h=3000,
    )
    fake_anthropic.queue(scripted)

    started = send(chat, "Hi there")
    run, msg = _refresh(started)

    assert run.status == "completed"
    assert msg.status == "complete" and msg.stop_reason == "end_turn"
    # The wire is the response exactly, NUL included.
    assert json.loads(msg.wire) == [{"role": "assistant", "content": scripted.content}]
    assert "\x00" in json.loads(msg.wire)[0]["content"][1]["text"]
    kinds = [(p["type"], p.get("text")) for p in msg.parts]
    assert kinds == [("thinking", "Checking the tracked prompts."),
                     ("text", "Hello world. You rank #3.")]
    assert msg.parts[0]["ended_at"] and msg.parts[0]["request"] == 1

    events = run_events(run)
    types = [e["type"] for e in events]
    assert types[0] == "run.started" and types[-1] == "run.completed"
    assert "run.usage" in types
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert all(e["v"] == 1 and e["run_id"] == str(run.id) for e in events)
    completed = events[-1]
    assert completed["status"] == "complete" and completed["parts_seq"] == msg.parts_seq
    assert msg.parts_seq == events[-2]["seq"]
    # Replaying the events reproduces the stored parts.
    assert replay(events) == msg.parts

    sent = fake_anthropic.requests[0].json
    assert sent["model"] == MODEL
    assert sent["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert sent["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert sent["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert sent["output_config"] == {"effort": "medium"}
    assert sent["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in fake_anthropic.requests[0].betas
    names = [t["name"] for t in sent["tools"]]
    assert names == sorted(names)
    assert all(t.get("eager_input_streaming") for t in sent["tools"] if "input_schema" in t)
    roles = [m["role"] for m in sent["messages"]]
    assert roles == ["user", "system"]
    assert sent["messages"][0]["content"][0]["text"] == "Hi there"
    assert "Project: Northwind" in sent["messages"][1]["content"][0]["text"]
    assert "temperature" not in sent

    rows = AITokenUsage.objects.filter(module="agent")
    assert rows.count() == 1
    row = rows.get()
    assert row.idempotency_key == f"agent:{run.id}:1:0"
    assert row.metadata["role"] == "orchestrator"
    assert row.metadata["cache_write_1h_tokens"] == 3000
    assert run.requests == 1 and run.input_tokens == 1200 and run.cache_write_tokens == 3000
    assert run.cost_usd > 0
    assert not fake_anthropic.overflow


def test_parallel_tools_answer_in_one_message_with_errors_for_bad_calls(
    fake_anthropic, chat, user, website, django_user_model,
):
    from apps.websites.models import Website

    AgentArtifact.objects.create(website=website, kind="page", title="Ours", agent_key="x")
    other_user = django_user_model.objects.create_user(email="other@example.com", password="x" * 16)
    other_site = Website.objects.create(user=other_user, url="https://other.example", name="Other")
    AgentArtifact.objects.create(website=other_site, kind="page", title="Theirs", agent_key="x")

    good = tool_use("list_artifacts", {}, id="toolu_good")
    invalid = tool_use("list_artifacts", {"kind": "poster"}, id="toolu_invalid")
    unknown = tool_use("delete_everything", {}, id="toolu_unknown")
    fake_anthropic.queue(
        message(text("Looking."), good, invalid, unknown, stop_reason="tool_use"),
        message(text("Done.")),
    )

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "completed"
    results = tool_results_of(fake_anthropic.requests[1].json)
    assert [r["tool_use_id"] for r in results] == ["toolu_good", "toolu_invalid", "toolu_unknown"]
    listed = json.loads(results[0]["content"])
    assert [a["title"] for a in listed["artifacts"]] == ["Ours"]
    assert not results[0].get("is_error")
    assert results[1]["is_error"] is True
    assert json.loads(json.loads(results[1]["content"])["INVALID_JSON"]) == {"kind": "poster"}
    assert results[2]["is_error"] is True and "Unknown tool" in results[2]["content"]
    wire = json.loads(msg.wire)
    assert [m["role"] for m in wire] == ["assistant", "user", "assistant"]
    assert len(wire[1]["content"]) == 3
    tool_parts = [p for p in msg.parts if p["type"] == "tool"]
    assert [p["status"] for p in tool_parts] == ["done", "error", "error"]
    assert replay(run_events(run)) == msg.parts


def test_invalid_streamed_tool_json_is_retried(fake_anthropic, chat):
    fake_anthropic.queue(
        message(text("Let me check."), malformed_tool_json(), stop_reason="tool_use"),
        message(text("Here is the answer.")),
    )

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "completed"
    assert len(fake_anthropic.requests) == 2
    resets = [e for e in run_events(run) if e["type"] == "turn.reset"]
    assert [e["request"] for e in resets] == [1]
    assert [p["text"] for p in msg.parts if p["type"] == "text"] == ["Here is the answer."]
    assert all(p["request"] == 2 for p in msg.parts)
    assert replay(run_events(run)) == msg.parts


def test_pause_turn_resends_the_paused_content_without_a_user_message(fake_anthropic, chat):
    use, result = server_web_search("northwind reviews", [
        {"title": "Review", "url": "https://reviews.example/northwind"},
    ], id="srvtoolu_1")
    paused = message(text("Searching the web."), use, stop_reason="pause_turn",
                     web_search_requests=1)
    fake_anthropic.queue(paused, message(result, text("Reviews mention you."),
                                         web_search_requests=1))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "completed"
    second = fake_anthropic.requests[1].json["messages"]
    assert second[-1]["role"] == "assistant"
    assert second[-1]["content"] == paused.content
    wire = json.loads(msg.wire)
    assert [m["role"] for m in wire] == ["assistant", "assistant"]
    search = next(p for p in msg.parts if p["type"] == "web_search")
    assert search["status"] == "done" and search["query"] == "northwind reviews"
    assert search["results"] == [{"title": "Review", "url": "https://reviews.example/northwind"}]
    assert run.web_search_requests == 2


def test_max_tokens_with_a_tool_call_retries_wider_and_never_runs_it(fake_anthropic, chat):
    fake_anthropic.queue(
        message(text("Drafting."), tool_use("list_artifacts", {}), stop_reason="max_tokens"),
        message(text("Short answer.")),
    )

    started = send(chat)
    run, msg = _refresh(started)

    first, second = (r.json for r in fake_anthropic.requests)
    assert second["max_tokens"] == 2 * first["max_tokens"]
    assert not any(m["role"] == "user" and tool_results_of({"messages": [m]})
                   for m in second["messages"])
    assert "turn.reset" in event_types(run)
    assert run.status == "completed"
    assert [p["type"] for p in msg.parts] == ["text"]
    assert json.loads(msg.wire) == [{"role": "assistant", "content": [
        {"type": "text", "text": "Short answer."}]}]


def test_max_tokens_text_only_ends_truncated(fake_anthropic, chat):
    fake_anthropic.queue(message(text("A long report that stops mid"), stop_reason="max_tokens"))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "completed"
    assert msg.status == "truncated" and msg.stop_reason == "max_tokens"
    assert run_events(run)[-1]["status"] == "truncated"
    assert json.loads(msg.wire)[0]["content"][0]["text"] == "A long report that stops mid"


def test_refusal_discards_the_response_and_runs_no_tool(fake_anthropic, chat):
    fake_anthropic.queue(refusal(text("I can"), tool_use("list_artifacts", {})))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "completed" and msg.status == "refused"
    assert json.loads(msg.wire) == []
    assert [(p["type"], p.get("code")) for p in msg.parts] == [("notice", "refusal")]
    assert run_events(run)[-1]["status"] == "refused"
    assert len(fake_anthropic.requests) == 1


def test_fallback_keeps_text_drops_pre_boundary_calls_and_bills_each_iteration(
    fake_anthropic, chat,
):
    before = tool_use("list_artifacts", {}, id="toolu_before")
    after = tool_use("list_artifacts", {}, id="toolu_after")
    fake_anthropic.queue(
        message(
            thinking("Thinking first.", signature="sig-a"), text("Partial."), before,
            fallback(), text("Continuing."), after,
            stop_reason="tool_use",
            iterations=[
                iteration(type="message", model=MODEL, input_tokens=900, output_tokens=40),
                iteration(type="fallback_message", model=FALLBACK_MODEL, input_tokens=950,
                          output_tokens=200, cache_read=100),
            ],
        ),
        message(text("All set.")),
    )

    started = send(chat)
    run, msg = _refresh(started)

    wire = json.loads(msg.wire)
    kinds = [b["type"] for b in wire[0]["content"]]
    assert kinds == ["text", "fallback", "text", "tool_use"]
    assert wire[0]["content"][-1]["id"] == "toolu_after"
    results = tool_results_of(fake_anthropic.requests[1].json)
    assert [r["tool_use_id"] for r in results] == ["toolu_after"]
    skipped = [p for p in msg.parts if p["type"] == "tool" and p["status"] == "error"]
    assert len(skipped) == 1
    assert any(p["type"] == "notice" and p["code"] == "model_fallback" for p in msg.parts)
    assert replay(run_events(run)) == msg.parts

    rows = AITokenUsage.objects.filter(module="agent").order_by("idempotency_key")
    by_key = {r.idempotency_key: r for r in rows}
    first = by_key[f"agent:{run.id}:1:0"]
    second = by_key[f"agent:{run.id}:1:1"]
    assert (first.model_name, first.input_tokens) == (MODEL, 900)
    assert (second.model_name, second.input_tokens) == (FALLBACK_MODEL, 950)
    assert second.metadata["iteration"] == "fallback_message"
    assert f"agent:{run.id}:2:0" in by_key
    assert rows.count() == 3
    assert run.input_tokens == 900 + 950 + 100


@pytest.mark.usefixtures("fast_retries")
def test_mid_stream_overload_is_retried_with_reset_and_retrying(fake_anthropic, chat):
    fake_anthropic.queue(error_event(text("Half a sent")), message(text("Recovered.")))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "completed"
    events = run_events(run)
    retrying = [e for e in events if e["type"] == "run.retrying"]
    assert retrying and retrying[0]["attempt"] == 1 and retrying[0]["reason"] == "upstream_overloaded"
    reset_at = next(e["seq"] for e in events if e["type"] == "turn.reset")
    assert reset_at < retrying[0]["seq"]
    assert [p["text"] for p in msg.parts if p["type"] == "text"] == ["Recovered."]
    # The failed attempt had started, so it is billed as an estimate.
    assert run.usage_estimated is True
    assert run.requests == 2


@pytest.mark.usefixtures("fast_retries")
def test_repeated_overload_fails_the_run(fake_anthropic, chat):
    fake_anthropic.queue(error_event(), error_event(), error_event())

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "failed" and msg.status == "failed"
    assert run.error_code == "upstream_overloaded"
    failed = run_events(run)[-1]
    assert failed["type"] == "run.failed" and failed["error"]["retryable"] is True
    assert len(fake_anthropic.requests) == 3


class CancelOn(MemoryEventStore):
    """Requests a stop when an event matches ``predicate``."""

    def __init__(self, predicate):
        super().__init__()
        self.predicate = predicate
        self.fired = False

    def append(self, run_id, event):
        full = super().append(run_id, event)
        if not self.fired and self.predicate(full):
            self.fired = True
            get_registry().cancel_local(run_id)
        return full


def test_stop_mid_stream_keeps_safe_blocks_and_answers_open_calls(fake_anthropic, chat):
    def second_text_started(event):
        return (event["type"] == "part.added" and event["part"]["type"] == "text"
                and event["part"]["text"].startswith("Next"))

    set_event_store(CancelOn(second_text_started))
    call = tool_use("list_artifacts", {}, id="toolu_open")
    fake_anthropic.queue(message(
        thinking("Plan.", signature="sig-z"), text("First part."), call,
        text("Next part that never finishes", chunks=4), stop_reason="tool_use",
    ))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "cancelled" and msg.status == "cancelled"
    wire = json.loads(msg.wire)
    assert [m["role"] for m in wire] == ["assistant", "user"]
    kept = [b["type"] for b in wire[0]["content"]]
    assert kept == ["thinking", "text", "tool_use", "text"]
    assert wire[1]["content"] == [{"type": "tool_result", "tool_use_id": "toolu_open",
                                   "content": "Stopped before this ran.", "is_error": True}]
    assert run_events(run)[-1]["type"] == "run.cancelled"
    tool_part = next(p for p in msg.parts if p["type"] == "tool")
    assert tool_part["status"] == "error"
    assert run.usage_estimated is True
    assert replay(run_events(run)) == msg.parts


def test_stop_after_only_thinking_keeps_nothing(fake_anthropic, chat):
    set_event_store(CancelOn(lambda e: e["type"] == "part.added"
                             and e["part"]["type"] == "thinking"))
    fake_anthropic.queue(message(thinking("Long reasoning that is cut", chunks=3),
                                 text("never")))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "cancelled"
    assert json.loads(msg.wire) == []


def test_stop_between_tool_calls_answers_the_rest_as_stopped(fake_anthropic, chat, monkeypatch):
    from apps.agent.tools import registry
    from apps.agent.tools.context import ToolResult

    def stopping(ctx, args):
        get_registry().cancel_local(ctx.run.id)
        return ToolResult.ok({"artifacts": []})

    monkeypatch.setitem(registry.TOOLS, "list_artifacts",
                        registry.ToolSpec("list_artifacts", stopping, "Artifacts"))
    fake_anthropic.queue(message(
        tool_use("list_artifacts", {}, id="toolu_1"),
        tool_use("list_artifacts", {}, id="toolu_2"), stop_reason="tool_use",
    ))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "cancelled"
    results = json.loads(msg.wire)[-1]["content"]
    assert [(r["tool_use_id"], r.get("is_error", False)) for r in results] == [
        ("toolu_1", False), ("toolu_2", True)]
    assert results[1]["content"] == "Stopped before this ran."
    assert len(fake_anthropic.requests) == 1


def test_mid_run_allowance_denial_fails_before_the_next_request(fake_anthropic, chat, monkeypatch):
    calls = {"n": 0}

    def denial(user):
        calls["n"] += 1
        return "monthly_ai_allowance_exceeded" if calls["n"] > 1 else None

    monkeypatch.setattr("apps.agent.llm.gate.allowance_denial", denial)
    fake_anthropic.queue(message(tool_use("list_artifacts", {}), stop_reason="tool_use"))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "failed" and run.error_code == "allowance_exceeded"
    assert len(fake_anthropic.requests) == 1 and not fake_anthropic.overflow
    # The tool round is kept; the next turn continues from it.
    assert [m["role"] for m in json.loads(msg.wire)] == ["assistant", "user"]


def test_run_cost_ceiling_stops_the_loop(fake_anthropic, chat, settings):
    settings.AGENT_RUN_MAX_COST_USD = 0.0001
    fake_anthropic.queue(message(tool_use("list_artifacts", {}), stop_reason="tool_use",
                                 input_tokens=5000, output_tokens=500))

    started = send(chat)
    run, _ = _refresh(started)

    assert run.status == "failed" and run.error_code == "run_cost_limit"
    assert len(fake_anthropic.requests) == 1


def test_request_cap_stops_the_loop(fake_anthropic, chat, settings):
    settings.AGENT_MAX_REQUESTS_PER_RUN = 1
    fake_anthropic.queue(message(tool_use("list_artifacts", {}), stop_reason="tool_use"))

    started = send(chat)
    run, _ = _refresh(started)

    assert run.status == "failed" and run.error_code == "request_limit"
    assert len(fake_anthropic.requests) == 1


def test_non_retryable_api_error_fails_with_a_readable_message(fake_anthropic, chat):
    from apps.agent.tests.fakes import http_error

    fake_anthropic.queue(http_error(400, "invalid_request_error", "prompt is too long: 1 > 0"))

    started = send(chat)
    run, msg = _refresh(started)

    assert run.status == "failed" and run.error_code == "context_too_long"
    assert "too long" in msg.error_message
    assert "1 > 0" not in msg.error_message
