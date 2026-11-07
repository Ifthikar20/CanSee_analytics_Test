"""Scripted Anthropic backend for the agent tests.

Every request goes through the real SDK (client.beta.messages.stream,
client.messages.create, ...). An httpx2.MockTransport answers it with the
next scripted response: SSE bytes for a streaming request, a JSON message
otherwise, or an HTTP error. The SDK's SSE decoder and message accumulator
therefore run exactly as they do against the API.

    fake = FakeAnthropic().install()      # or the fake_anthropic fixture
    fake.queue(message(thinking("Checking"), text("Hello"), stop_reason="end_turn"))
    ...run code that calls get_client()...
    fake.requests[0].json["model"]

Builders: text(), thinking(), tool_use(name, input, chunks),
malformed_tool_json(), server_web_search(), fallback(), message(),
error_event(), http_error(). Code that builds its own anthropic.Anthropic
(ClaudeUtility, the llm_ranking provider) is routed here with
FakeAnthropic.patch_sdk(monkeypatch).
"""
from __future__ import annotations

import itertools
import json
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import anthropic
import httpx2

from apps.agent.llm.client import set_client_factory

BASE_URL = "http://anthropic.test"
MODEL = "claude-opus-5-5"
FALLBACK_MODEL = "claude-opus-5"

# The class as imported, before any test patches anthropic.Anthropic.
_REAL_ANTHROPIC = anthropic.Anthropic

_ids = itertools.count(1)


def _uid(prefix: str) -> str:
    return f"{prefix}_test{next(_ids):08d}"


def _split(value: str, chunks: int) -> list[str]:
    """``value`` cut into at most ``chunks`` consecutive, non-empty pieces."""
    if not value:
        return []
    chunks = max(1, min(chunks, len(value)))
    size = -(-len(value) // chunks)
    return [value[i:i + size] for i in range(0, len(value), size)]


# ── Content blocks ───────────────────────────────────────────────────────


@dataclass
class ScriptedBlock:
    """One content block: its content_block_start payload, its deltas, and
    the block as the accumulated message holds it (``final``)."""

    start: dict
    deltas: list[dict] = field(default_factory=list)
    final: dict | None = None


def text(value: str, *, chunks: int = 2, citations: list[dict] | None = None) -> ScriptedBlock:
    """A text block streamed as ``chunks`` text_delta events, then one
    citations_delta per citation."""
    deltas = [{"type": "text_delta", "text": piece} for piece in _split(value, chunks)]
    final: dict[str, Any] = {"type": "text", "text": value}
    if citations:
        deltas += [{"type": "citations_delta", "citation": c} for c in citations]
        final["citations"] = list(citations)
    return ScriptedBlock(start={"type": "text", "text": ""}, deltas=deltas, final=final)


def web_citation(url: str, title: str, cited_text: str) -> dict:
    """A web_search_result_location citation for text(citations=...)."""
    return {
        "type": "web_search_result_location",
        "url": url,
        "title": title,
        "cited_text": cited_text,
        "encrypted_index": _uid("idx"),
    }


def thinking(value: str = "", *, signature: str | None = None, chunks: int = 2) -> ScriptedBlock:
    """A thinking block: thinking_delta pieces, then its signature_delta.
    An empty ``value`` is the display-omitted shape (signature only)."""
    signature = signature or _uid("sig")
    deltas = [{"type": "thinking_delta", "thinking": piece} for piece in _split(value, chunks)]
    deltas.append({"type": "signature_delta", "signature": signature})
    return ScriptedBlock(
        start={"type": "thinking", "thinking": "", "signature": ""},
        deltas=deltas,
        final={"type": "thinking", "thinking": value, "signature": signature},
    )


def tool_use(
    name: str,
    input: dict,
    chunks: int | list[str] = 3,
    *,
    id: str | None = None,
) -> ScriptedBlock:
    """A client tool call whose input streams as input_json_delta fragments.

    ``chunks`` is a fragment count, or the exact fragments (their join must
    be the JSON of ``input``).
    """
    tool_id = id or _uid("toolu")
    if isinstance(chunks, list):
        fragments = list(chunks)
        joined = "".join(fragments)
        if json.loads(joined) != input:
            raise ValueError("tool_use fragments do not join to the given input")
    else:
        fragments = _split(json.dumps(input, ensure_ascii=False), chunks)
    return ScriptedBlock(
        start={"type": "tool_use", "id": tool_id, "name": name, "input": {}},
        deltas=[{"type": "input_json_delta", "partial_json": f} for f in fragments],
        final={"type": "tool_use", "id": tool_id, "name": name, "input": input},
    )


def malformed_tool_json(
    name: str = "list_tracked_prompts",
    *,
    fragments: list[str] | None = None,
    id: str | None = None,
) -> ScriptedBlock:
    """A tool call whose streamed input is not JSON at all: the SDK raises
    ValueError from the stream iterator when it reaches the bad fragment."""
    fragments = fragments or ['{"gap_class": ', '"ai_ahead", ', "limit: 5}"]
    tool_id = id or _uid("toolu")
    return ScriptedBlock(
        start={"type": "tool_use", "id": tool_id, "name": name, "input": {}},
        deltas=[{"type": "input_json_delta", "partial_json": f} for f in fragments],
        final=None,
    )


def server_web_search(
    query: str,
    results: list[dict] | None = None,
    *,
    id: str | None = None,
    error_code: str | None = None,
) -> list[ScriptedBlock]:
    """Anthropic's server web_search: a server_tool_use block (input
    streamed) and its web_search_tool_result, which arrives whole at
    content_block_start. ``results`` items: {title, url, page_age?}.
    ``error_code`` scripts the in-band error object instead."""
    use_id = id or _uid("srvtoolu")
    use = ScriptedBlock(
        start={"type": "server_tool_use", "id": use_id, "name": "web_search", "input": {}},
        deltas=[
            {"type": "input_json_delta", "partial_json": f}
            for f in _split(json.dumps({"query": query}), 2)
        ],
        final={"type": "server_tool_use", "id": use_id, "name": "web_search",
               "input": {"query": query}},
    )
    if error_code:
        content: Any = {"type": "web_search_tool_result_error", "error_code": error_code}
    else:
        content = []
        for r in results or []:
            item = {
                "type": "web_search_result",
                "title": r["title"],
                "url": r["url"],
                "encrypted_content": r.get("encrypted_content") or _uid("enc"),
            }
            if r.get("page_age"):
                item["page_age"] = r["page_age"]
            content.append(item)
    block = {"type": "web_search_tool_result", "tool_use_id": use_id, "content": content}
    return [use, ScriptedBlock(start=block, final=block)]


def fallback(
    from_model: str = MODEL,
    to_model: str = FALLBACK_MODEL,
    *,
    category: str | None = "cyber",
) -> ScriptedBlock:
    """A server-side refusal-fallback boundary (content_block_start/stop only)."""
    block = {
        "type": "fallback",
        "from": {"model": from_model},
        "to": {"model": to_model},
        "trigger": {"type": "refusal", "category": category},
    }
    return ScriptedBlock(start=block, final=block)


def iteration(
    *,
    type: str = "message",
    model: str = MODEL,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read: int = 0,
    cache_write: int = 0,
) -> dict:
    """One usage.iterations entry ("message" or "fallback_message")."""
    return {
        "type": type,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
    }


# ── Responses ────────────────────────────────────────────────────────────


def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


@dataclass
class ScriptedMessage:
    """A model response. Streamed as SSE, or returned as JSON when the
    request did not ask to stream. ``error`` ends the stream with an
    ``event: error`` after the blocks instead of message_delta/stop."""

    blocks: list[ScriptedBlock]
    stop_reason: str | None = "end_turn"
    model: str = MODEL
    id: str = field(default_factory=lambda: _uid("msg"))
    request_id: str = field(default_factory=lambda: _uid("req"))
    usage: dict = field(default_factory=dict)
    stop_details: dict | None = None
    error: dict | None = None

    @property
    def content(self) -> list[dict]:
        """The final content blocks, as get_final_message() should hold them."""
        return [b.final for b in self.blocks]

    def _start_usage(self) -> dict:
        start = {
            k: v for k, v in self.usage.items()
            if k in ("input_tokens", "cache_creation_input_tokens",
                     "cache_read_input_tokens", "cache_creation")
        }
        start["output_tokens"] = 1
        return start

    def sse_bytes(self) -> bytes:
        out = [
            _sse("message_start", {
                "type": "message_start",
                "message": {
                    "id": self.id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": self._start_usage(),
                },
            }),
            _sse("ping", {"type": "ping"}),
        ]
        for index, block in enumerate(self.blocks):
            out.append(_sse("content_block_start", {
                "type": "content_block_start", "index": index, "content_block": block.start,
            }))
            for delta in block.deltas:
                out.append(_sse("content_block_delta", {
                    "type": "content_block_delta", "index": index, "delta": delta,
                }))
            out.append(_sse("content_block_stop", {"type": "content_block_stop", "index": index}))
        if self.error is not None:
            out.append(_sse("error", {"type": "error", "error": self.error}))
            return b"".join(out)
        delta: dict[str, Any] = {"stop_reason": self.stop_reason, "stop_sequence": None}
        if self.stop_details is not None:
            delta["stop_details"] = self.stop_details
        # Cumulative counts; the per-TTL cache_creation split only comes
        # with message_start.
        delta_usage = {k: v for k, v in self.usage.items() if k != "cache_creation"}
        out.append(_sse("message_delta", {
            "type": "message_delta", "delta": delta, "usage": delta_usage,
        }))
        out.append(_sse("message_stop", {"type": "message_stop"}))
        return b"".join(out)

    def as_json(self) -> dict:
        body: dict[str, Any] = {
            "id": self.id,
            "type": "message",
            "role": "assistant",
            "model": self.model,
            "content": self.content,
            "stop_reason": self.stop_reason,
            "stop_sequence": None,
            "usage": dict(self.usage),
        }
        if self.stop_details is not None:
            body["stop_details"] = self.stop_details
        return body


def _flatten(blocks) -> list[ScriptedBlock]:
    flat: list[ScriptedBlock] = []
    for b in blocks:
        if isinstance(b, list | tuple):
            flat.extend(b)
        else:
            flat.append(b)
    return flat


def message(
    *blocks,
    stop_reason: str | None = "end_turn",
    model: str = MODEL,
    id: str | None = None,
    input_tokens: int = 100,
    output_tokens: int = 50,
    cache_read: int = 0,
    cache_write_5m: int = 0,
    cache_write_1h: int = 0,
    web_search_requests: int = 0,
    web_fetch_requests: int = 0,
    iterations: list[dict] | None = None,
    stop_details: dict | None = None,
) -> ScriptedMessage:
    """A complete response with these blocks (server_web_search() lists are
    flattened) and usage."""
    usage: dict[str, Any] = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_creation_input_tokens": cache_write_5m + cache_write_1h,
        "cache_read_input_tokens": cache_read,
        "cache_creation": {
            "ephemeral_5m_input_tokens": cache_write_5m,
            "ephemeral_1h_input_tokens": cache_write_1h,
        },
    }
    if web_search_requests or web_fetch_requests:
        usage["server_tool_use"] = {
            "web_search_requests": web_search_requests,
            "web_fetch_requests": web_fetch_requests,
        }
    if iterations is not None:
        usage["iterations"] = iterations
    scripted = ScriptedMessage(
        blocks=_flatten(blocks),
        stop_reason=stop_reason,
        model=model,
        usage=usage,
        stop_details=stop_details,
    )
    if id:
        scripted.id = id
    return scripted


def refusal(*blocks, category: str | None = "cyber", **kwargs) -> ScriptedMessage:
    """stop_reason "refusal" with its stop_details."""
    return message(
        *blocks,
        stop_reason="refusal",
        stop_details={"type": "refusal", "category": category, "explanation": None},
        **kwargs,
    )


def error_event(
    *blocks,
    error_type: str = "overloaded_error",
    error_message: str = "Overloaded",
    model: str = MODEL,
) -> ScriptedMessage:
    """A stream that sends these blocks and then an SSE ``error`` event:
    the SDK raises APIStatusError with HTTP 200 and ``.type`` set."""
    scripted = message(*blocks, model=model)
    scripted.error = {"type": error_type, "message": error_message}
    return scripted


@dataclass
class ScriptedHTTPError:
    status: int
    error_type: str
    message: str
    headers: dict = field(default_factory=dict)
    request_id: str = field(default_factory=lambda: _uid("req"))


def http_error(
    status: int = 529,
    error_type: str = "overloaded_error",
    message: str = "Overloaded",
    *,
    headers: dict | None = None,
) -> ScriptedHTTPError:
    """An HTTP error response (the SDK maps it to its typed exception)."""
    return ScriptedHTTPError(status, error_type, message, dict(headers or {}))


# ── Transport ────────────────────────────────────────────────────────────


@dataclass
class RecordedRequest:
    method: str
    path: str
    query: str
    headers: dict[str, str]
    json: dict

    @property
    def betas(self) -> list[str]:
        raw = self.headers.get("anthropic-beta", "")
        return [b.strip() for b in raw.split(",") if b.strip()]

    @property
    def streamed(self) -> bool:
        return bool(self.json.get("stream"))


Scripted = ScriptedMessage | ScriptedHTTPError | Callable[[RecordedRequest], Any]


class FakeAnthropic:
    """Answers SDK requests with scripted responses, in queue order, and
    records each request (JSON body and lower-cased headers)."""

    def __init__(self, *responses: Scripted):
        self._lock = threading.Lock()
        self._responses: list[Scripted] = list(responses)
        self.requests: list[RecordedRequest] = []
        # Set when a request arrived with nothing left to answer it.
        self.overflow = False

    def queue(self, *responses: Scripted) -> FakeAnthropic:
        with self._lock:
            self._responses.extend(responses)
        return self

    @property
    def pending(self) -> int:
        return len(self._responses)

    @property
    def last_request(self) -> RecordedRequest:
        return self.requests[-1]

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        request.read()
        body = json.loads(request.content) if request.content else {}
        recorded = RecordedRequest(
            method=request.method,
            path=request.url.path,
            query=request.url.query.decode() if isinstance(request.url.query, bytes)
            else str(request.url.query),
            headers={k.lower(): v for k, v in request.headers.items()},
            json=body,
        )
        with self._lock:
            self.requests.append(recorded)
            item = self._responses.pop(0) if self._responses else None
            if item is None:
                self.overflow = True
        if item is None:
            return httpx2.Response(500, json={
                "type": "error",
                "error": {"type": "api_error",
                          "message": "FakeAnthropic: no scripted response left"},
            })
        if callable(item) and not isinstance(item, ScriptedMessage | ScriptedHTTPError):
            item = item(recorded)
        if isinstance(item, ScriptedHTTPError):
            return httpx2.Response(
                item.status,
                headers={"request-id": item.request_id, **item.headers},
                json={"type": "error",
                      "error": {"type": item.error_type, "message": item.message},
                      "request_id": item.request_id},
            )
        if recorded.streamed:
            return httpx2.Response(
                200,
                headers={"content-type": "text/event-stream", "request-id": item.request_id},
                content=item.sse_bytes(),
            )
        return httpx2.Response(
            200,
            headers={"request-id": item.request_id},
            json=item.as_json(),
        )

    def client(self) -> anthropic.Anthropic:
        """A real SDK client wired to this fake (a client factory)."""
        return _REAL_ANTHROPIC(
            api_key="test",
            base_url=BASE_URL,
            max_retries=0,
            http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(self.handler)),
        )

    def install(self) -> FakeAnthropic:
        """Route apps.agent.llm.client.get_client() here."""
        set_client_factory(self.client)
        return self

    def patch_sdk(self, monkeypatch) -> FakeAnthropic:
        """Route code that constructs anthropic.Anthropic itself here."""
        handler = self.handler

        def build(*args, **kwargs):
            kwargs["base_url"] = BASE_URL
            kwargs["max_retries"] = 0
            kwargs["http_client"] = anthropic.DefaultHttpxClient(
                transport=httpx2.MockTransport(handler)
            )
            return _REAL_ANTHROPIC(*args, **kwargs)

        monkeypatch.setattr(anthropic, "Anthropic", build)
        return self


def refusing_client() -> anthropic.Anthropic:
    """The default factory in the agent tests: any request fails loudly
    instead of reaching the network."""

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(418, json={
            "type": "error",
            "error": {"type": "invalid_request_error",
                      "message": "No fake Anthropic installed for this test "
                                 "(use the fake_anthropic fixture)."},
        })

    return _REAL_ANTHROPIC(
        api_key="test",
        base_url=BASE_URL,
        max_retries=0,
        http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(handler)),
    )
