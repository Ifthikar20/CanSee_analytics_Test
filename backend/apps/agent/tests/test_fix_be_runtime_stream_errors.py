"""A connection that breaks while a response streams is retried in the run.

The SDK wraps transport errors in APIConnectionError only while it sends
the request; once the SSE body is being read, httpx2's own errors
(RemoteProtocolError, ReadError, ReadTimeout) come through as they are.
They must be classified as an unreachable upstream (retried with
turn.reset and run.retrying), not as an internal error that ends the run.
"""

import httpx2
import pytest

from apps.agent.llm.errors import INTERNAL, UNREACHABLE, classify
from apps.agent.models import AgentMessage, AgentRun
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events, send

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


class DroppedStream:
    """A scripted response whose connection breaks after ``frames`` SSE frames."""

    def __init__(self, scripted, *, frames: int):
        self.scripted = scripted
        self.request_id = scripted.request_id
        self.frames = frames

    def sse_bytes(self):
        frames = [f for f in self.scripted.sse_bytes().split(b"\n\n") if f]

        def body():
            for frame in frames[:self.frames]:
                yield frame + b"\n\n"
            raise httpx2.RemoteProtocolError(
                "peer closed connection without sending complete message body")

        return body()


def test_transport_errors_are_an_unreachable_upstream():
    request = httpx2.Request("POST", "http://anthropic.test/v1/messages")
    for exc in (httpx2.RemoteProtocolError("peer closed", request=request),
                httpx2.ReadError("connection reset by peer", request=request),
                httpx2.ReadTimeout("timed out", request=request)):
        assert classify(exc) is UNREACHABLE
    assert UNREACHABLE.retry_in_run
    assert classify(ValueError("unrelated")) is INTERNAL


@pytest.mark.usefixtures("fast_retries")
def test_a_dropped_stream_is_retried_and_the_reply_finishes(fake_anthropic, chat):
    dropped = DroppedStream(message(text("Half a sent", chunks=4)), frames=4)
    fake_anthropic.queue(lambda request: dropped, message(text("Recovered.")))

    started = send(chat)

    run = AgentRun.objects.get(id=started.run.id)
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    assert run.status == "completed" and msg.status == "complete"
    events = run_events(run)
    retrying = [e for e in events if e["type"] == "run.retrying"]
    assert retrying and retrying[0]["reason"] == "upstream_unreachable"
    reset_at = next(e["seq"] for e in events if e["type"] == "turn.reset")
    assert reset_at < retrying[0]["seq"]
    assert [p["text"] for p in msg.parts if p["type"] == "text"] == ["Recovered."]
    assert len(fake_anthropic.requests) == 2


@pytest.mark.usefixtures("fast_retries")
def test_a_stream_that_keeps_dropping_fails_as_unreachable(fake_anthropic, chat):
    fake_anthropic.queue(*[(lambda request: DroppedStream(message(text("x")), frames=3))
                           for _ in range(3)])

    started = send(chat)

    run = AgentRun.objects.get(id=started.run.id)
    assert run.status == "failed" and run.error_code == "upstream_unreachable"
    assert run_events(run)[-1]["error"]["retryable"] is True
    assert len(fake_anthropic.requests) == 3


def test_a_dropped_writer_stream_says_the_service_was_unreachable(fake_anthropic, chat, settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0
    call = tool_use("run_agent", {"agent": "landing_page", "title": "Page", "brief": "x"},
                    id="toolu_writer")
    fake_anthropic.queue(
        message(text("Starting the writer."), call, stop_reason="tool_use"),
        lambda request: DroppedStream(message(text("<!DOCTYPE html><html>", chunks=3)), frames=4),
        message(text("The writer could not finish.")),
    )

    started = send(chat, "Write a page")

    failed = next(e for e in run_events(started.run) if e["type"] == "artifact.failed")
    assert failed["error"] == {"code": "upstream_unreachable",
                               "message": "The AI service could not be reached. Please try again."}
