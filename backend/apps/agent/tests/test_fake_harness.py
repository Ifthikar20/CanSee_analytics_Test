"""The fake Anthropic backend drives the real SDK stream parser."""

import anthropic
import pytest
from django.test import override_settings

from apps.agent.exceptions import AgentNotConfigured
from apps.agent.llm import client as client_module
from apps.agent.llm.client import CLIENT_TIMEOUT, get_client, set_client_factory
from apps.agent.tests.fakes import (
    FALLBACK_MODEL,
    MODEL,
    FakeAnthropic,
    error_event,
    fallback,
    http_error,
    iteration,
    malformed_tool_json,
    message,
    refusal,
    server_web_search,
    text,
    thinking,
    tool_use,
    web_citation,
)

REQUEST = {
    "model": MODEL,
    "max_tokens": 2000,
    "messages": [{"role": "user", "content": "How do we rank for best crm?"}],
}


def _stream(client, **extra):
    """Consume a beta stream; return (event types, final message)."""
    seen = []
    with client.beta.messages.stream(**REQUEST, **extra) as stream:
        for event in stream:
            seen.append(event.type)
        final = stream.get_final_message()
    return seen, final


def test_text_thinking_and_tool_use_round_trip(fake_anthropic):
    scripted = message(
        thinking("Looking at the tracked prompts first.", signature="sig-abc"),
        text("I will compare Google and the AI engines."),
        tool_use("get_prompt_gap", {"prompt_id": 7, "note": "naïve – ok"}, chunks=4),
        stop_reason="tool_use",
        input_tokens=1200,
        output_tokens=300,
        cache_read=50_000,
        cache_write_1h=4_000,
    )
    fake_anthropic.queue(scripted)

    seen, final = _stream(
        get_client(),
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        thinking={"type": "adaptive", "display": "summarized"},
        output_config={"effort": "medium"},
    )

    assert [b.to_dict() for b in final.content] == scripted.content
    assert final.stop_reason == "tool_use"
    assert final.id == scripted.id
    assert final.usage.input_tokens == 1200
    assert final.usage.output_tokens == 300
    assert final.usage.cache_read_input_tokens == 50_000
    assert final.usage.cache_creation_input_tokens == 4_000
    assert final.usage.cache_creation.ephemeral_1h_input_tokens == 4_000
    assert final.content[2].input == {"prompt_id": 7, "note": "naïve – ok"}
    # The helper events the runtime translates into parts.
    for kind in ("thinking", "signature", "text", "input_json", "content_block_stop"):
        assert kind in seen
    assert seen[0] == "message_start" and seen[-1] == "message_stop"

    sent = fake_anthropic.last_request
    assert sent.path == "/v1/messages"
    assert sent.streamed
    assert sent.json["model"] == MODEL
    assert sent.json["fallbacks"] == "default"
    assert sent.json["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert "server-side-fallback-2026-07-01" in sent.betas
    assert sent.headers["anthropic-version"] == "2026-10-21"
    assert "temperature" not in sent.json
    assert not fake_anthropic.overflow


def test_server_web_search_and_citations(fake_anthropic):
    scripted = message(
        server_web_search("best crm for small business", [
            {"title": "Best CRMs of 2026", "url": "https://reviews.example/crm"},
            {"title": "CRM buyer guide", "url": "https://guide.example/crm", "page_age": "2 days"},
        ]),
        text("Two sources list it.", citations=[
            web_citation("https://reviews.example/crm", "Best CRMs of 2026", "Northwind ranks second"),
        ]),
        web_search_requests=1,
    )
    fake_anthropic.queue(scripted)

    seen, final = _stream(get_client())

    assert [b.to_dict() for b in final.content] == scripted.content
    assert final.content[0].type == "server_tool_use"
    assert final.content[0].input == {"query": "best crm for small business"}
    assert final.content[1].type == "web_search_tool_result"
    assert [r.url for r in final.content[1].content] == [
        "https://reviews.example/crm", "https://guide.example/crm",
    ]
    assert final.content[2].citations[0].url == "https://reviews.example/crm"
    assert final.usage.server_tool_use.web_search_requests == 1
    assert "citation" in seen


def test_web_search_error_arrives_in_band(fake_anthropic):
    fake_anthropic.queue(message(server_web_search("q", error_code="max_uses_exceeded")))

    _, final = _stream(get_client())

    result = final.content[1]
    assert result.type == "web_search_tool_result"
    assert result.content.error_code == "max_uses_exceeded"


def test_fallback_block_and_usage_iterations(fake_anthropic):
    scripted = message(
        text("Partial answer from the first model."),
        fallback(category="cyber"),
        text("The rest of the answer."),
        model=MODEL,
        iterations=[
            iteration(type="message", model=MODEL, input_tokens=900, output_tokens=40),
            iteration(type="fallback_message", model=FALLBACK_MODEL,
                      input_tokens=950, output_tokens=200, cache_read=100),
        ],
    )
    fake_anthropic.queue(scripted)

    _, final = _stream(get_client())

    assert [b.to_dict() for b in final.content] == scripted.content
    assert final.content[1].type == "fallback"
    assert final.content[1].from_.model == MODEL
    assert final.content[1].to.model == FALLBACK_MODEL
    # The SDK relabels the message with the model that served the rest.
    assert final.model == FALLBACK_MODEL
    kinds = [(i.type, i.model) for i in final.usage.iterations]
    assert kinds == [("message", MODEL), ("fallback_message", FALLBACK_MODEL)]
    assert final.usage.iterations[1].cache_read_input_tokens == 100


def test_refusal_carries_stop_details(fake_anthropic):
    fake_anthropic.queue(refusal(text("I can"), category="cyber"))

    _, final = _stream(get_client())

    assert final.stop_reason == "refusal"
    assert final.stop_details.category == "cyber"


def test_empty_thinking_keeps_its_signature(fake_anthropic):
    fake_anthropic.queue(message(thinking("", signature="sig-only"), text("Done.")))

    _, final = _stream(get_client())

    assert final.content[0].thinking == ""
    assert final.content[0].signature == "sig-only"


def test_malformed_tool_json_raises_value_error_from_the_iterator(fake_anthropic):
    fake_anthropic.queue(message(malformed_tool_json(), stop_reason="tool_use"))

    events = []
    with pytest.raises(ValueError, match="Unable to parse tool parameter JSON"):
        with get_client().beta.messages.stream(**REQUEST) as stream:
            for event in stream:
                events.append(event.type)
    # It fails mid-block, before any tool_use id could be answered.
    assert "content_block_stop" not in events


def test_mid_stream_error_event_is_an_http_200_status_error(fake_anthropic):
    fake_anthropic.queue(error_event(text("Half a sent"), error_type="overloaded_error"))

    with pytest.raises(anthropic.APIStatusError) as raised:
        _stream(get_client())

    assert raised.value.status_code == 200
    assert raised.value.type == "overloaded_error"
    assert raised.value.body["error"]["type"] == "overloaded_error"


@pytest.mark.parametrize(
    ("status", "error_type", "exc"),
    [
        (529, "overloaded_error", anthropic.OverloadedError),
        (429, "rate_limit_error", anthropic.RateLimitError),
        (400, "invalid_request_error", anthropic.BadRequestError),
        (500, "api_error", anthropic.InternalServerError),
    ],
)
def test_http_errors_map_to_sdk_exceptions(fake_anthropic, status, error_type, exc):
    fake_anthropic.queue(http_error(status, error_type, "scripted", headers={"retry-after": "3"}))

    with pytest.raises(exc) as raised:
        _stream(get_client())

    assert raised.value.status_code == status
    assert raised.value.type == error_type
    assert raised.value.response.headers["retry-after"] == "3"


def test_non_streaming_create_gets_a_json_message(fake_anthropic):
    fake_anthropic.queue(message(text('{"title": "Northwind vs HubSpot"}'), output_tokens=12))

    result = get_client().messages.create(**REQUEST)

    assert result.content[0].text == '{"title": "Northwind vs HubSpot"}'
    assert result.usage.output_tokens == 12
    assert not fake_anthropic.last_request.streamed


def test_dynamic_response_sees_the_request(fake_anthropic):
    fake_anthropic.queue(lambda req: message(text(f"echo {req.json['max_tokens']}")))

    result = get_client().messages.create(**REQUEST)

    assert result.content[0].text == "echo 2000"


def test_unscripted_request_is_flagged(fake_anthropic):
    with pytest.raises(anthropic.InternalServerError):
        get_client().messages.create(**REQUEST)

    assert fake_anthropic.overflow
    assert len(fake_anthropic.requests) == 1


def test_default_factory_in_tests_never_reaches_the_network():
    with pytest.raises(anthropic.APIStatusError) as raised:
        get_client().messages.create(**REQUEST)

    assert raised.value.status_code == 418
    assert "No fake Anthropic installed" in str(raised.value)


def test_patch_sdk_routes_self_built_clients(monkeypatch):
    fake = FakeAnthropic(message(text("patched")))
    fake.patch_sdk(monkeypatch)

    result = anthropic.Anthropic(api_key="k").messages.create(**REQUEST)

    assert result.content[0].text == "patched"
    assert fake.last_request.headers["authorization"] == "Bearer k"


def test_get_client_without_a_key_raises_not_configured():
    set_client_factory(None)
    with override_settings(ANTHROPIC_API_KEY=""):
        with pytest.raises(AgentNotConfigured) as raised:
            get_client()

    assert raised.value.code == "agent_not_configured"
    assert raised.value.status_code == 503


def test_get_client_builds_one_configured_client_per_key():
    set_client_factory(None)
    with override_settings(ANTHROPIC_API_KEY="key-one"):
        first = get_client()
        assert get_client() is first
        assert first.max_retries == client_module.CLIENT_MAX_RETRIES == 2
        assert first.timeout == CLIENT_TIMEOUT
        assert (CLIENT_TIMEOUT.connect, CLIENT_TIMEOUT.read) == (10.0, 300.0)
        assert (CLIENT_TIMEOUT.write, CLIENT_TIMEOUT.pool) == (30.0, 10.0)
    with override_settings(ANTHROPIC_API_KEY="key-two"):
        second = get_client()
        assert second is not first
        assert second.api_key == "key-two"
