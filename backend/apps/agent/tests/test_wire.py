"""Wire rendering and the response filters (pure functions)."""

from apps.agent.runtime import wire


def _u(text):
    return wire.user_message(text)


def _s(text):
    return wire.system_message(text)


def _a(*blocks):
    return wire.assistant_message(list(blocks))


TXT = {"type": "text", "text": "ok"}


def test_render_keeps_a_normal_history_unchanged():
    history = [_u("hi"), _s("ctx"), _a(TXT), _u("next")]
    assert wire.render(history) == history


def test_render_moves_a_system_message_past_a_turn_that_produced_nothing():
    # The first turn failed before any output: user, system, then the next user.
    history = [_u("first"), _s("ctx Today (UTC): 2026-11-01"), _u("second"), _s("date")]
    rendered = wire.render(history)
    assert [m["role"] for m in rendered] == ["user", "system"]
    assert [b["text"] for b in rendered[0]["content"]] == ["first", "second"]
    assert [b["text"] for b in rendered[1]["content"]] == ["ctx Today (UTC): 2026-11-01", "date"]


def test_render_answers_tool_calls_left_open_and_merges_same_roles():
    call = {"type": "tool_use", "id": "toolu_1", "name": "list_artifacts", "input": {}}
    history = [_u("go"), _a(TXT), _a(call), _u("what happened?")]
    rendered = wire.render(history)
    assert [m["role"] for m in rendered] == ["user", "assistant", "user"]
    assert rendered[1]["content"] == [TXT, call]
    first, second = rendered[2]["content"]
    assert first == {"type": "tool_result", "tool_use_id": "toolu_1",
                     "content": wire.STOPPED_RESULT, "is_error": True}
    assert second["text"] == "what happened?"


def test_render_is_stable_when_history_grows():
    turn1 = [_u("first"), _s("ctx")]
    sent1 = wire.render(turn1)
    grown = turn1 + [_a(TXT), _u("second")]
    flat1, flat2 = wire.flatten(sent1), wire.flatten(wire.render(grown))
    assert flat2[: len(flat1)] == flat1


def test_safe_prefix_rules():
    blocks = [
        {"type": "thinking", "thinking": "a", "signature": "s1"},
        {"type": "text", "text": "kept"},
        {"type": "server_tool_use", "id": "srv_1", "name": "web_search", "input": {}},
        {"type": "web_search_tool_result", "tool_use_id": "srv_1", "content": []},
        {"type": "tool_use", "id": "toolu_1", "name": "x", "input": {}},
        {"type": "thinking", "thinking": "unsigned", "signature": ""},
    ]
    # Everything complete except the last thinking block.
    kept = wire.safe_prefix(blocks, completed={0, 1, 2, 3, 4})
    assert [b["type"] for b in kept] == [
        "thinking", "text", "server_tool_use", "web_search_tool_result", "tool_use"]
    # A cut-off tool call stops the prefix; text before it stays.
    assert [b["type"] for b in wire.safe_prefix(blocks, completed={0, 1, 2, 3})] == [
        "thinking", "text", "server_tool_use", "web_search_tool_result"]
    # A server call without its result is not kept.
    unpaired = [{"type": "text", "text": "t"},
                {"type": "server_tool_use", "id": "srv_9", "name": "web_search", "input": {}}]
    assert wire.safe_prefix(unpaired, completed={0, 1}) == [unpaired[0]]
    # A partial text block is kept; an empty one is not; trailing thinking goes.
    partial = [{"type": "thinking", "thinking": "x", "signature": "s"},
               {"type": "text", "text": "half a sen"}]
    assert wire.safe_prefix(partial, completed={0}) == partial
    assert wire.safe_prefix([{"type": "thinking", "thinking": "x", "signature": "s"},
                             {"type": "text", "text": "  "}], completed={0}) == []


def test_fallback_filter_drops_what_the_next_model_cannot_use():
    blocks = [
        {"type": "thinking", "thinking": "t", "signature": "s"},
        {"type": "redacted_thinking", "data": "r"},
        {"type": "text", "text": "before"},
        {"type": "tool_use", "id": "toolu_a", "name": "x", "input": {}},
        {"type": "server_tool_use", "id": "srv_a", "name": "web_search", "input": {}},
        {"type": "server_tool_use", "id": "srv_b", "name": "web_search", "input": {}},
        {"type": "web_search_tool_result", "tool_use_id": "srv_b", "content": []},
        {"type": "fallback", "from": {"model": "a"}, "to": {"model": "b"}, "trigger": {}},
        {"type": "thinking", "thinking": "after", "signature": "s2"},
        {"type": "tool_use", "id": "toolu_b", "name": "x", "input": {}},
    ]
    kept, dropped = wire.fallback_filter(blocks)
    assert [b.get("id") or b["type"] for b in kept] == [
        "text", "srv_b", "web_search_tool_result", "fallback", "thinking", "toolu_b"]
    assert dropped == ["toolu_a"]
    assert wire.fallback_filter(blocks[:3]) == (blocks[:3], [])


def test_last_context_date_reads_system_messages_only():
    history = [_u("Today (UTC): 1999-01-01"), _s("x\nToday (UTC): 2026-11-01"), _a(TXT),
               _s("Date update. Today (UTC): 2026-11-02")]
    assert wire.last_context_date(history) == "2026-11-02"
    assert wire.last_context_date([_u("hi")]) is None


def test_nul_survives_storage():
    messages = [_a({"type": "text", "text": "a\x00b"})]
    text = wire.dumps(messages)
    assert "\x00" not in text
    assert wire.loads(text) == messages
