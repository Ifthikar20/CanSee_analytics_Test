"""The research agents' analysis requests (Claude Haiku 5.5, design 10):
the exact request, the allowance gate, the usage ledger, the failure
codes, the process limit and the pricing row."""
import json
import time
from decimal import Decimal

import pytest

from apps.accounts.models import AITokenUsage
from apps.agent.conf import check_agent_settings
from apps.agent.llm.worker import ask_haiku
from apps.agent.runtime.swarm.context import SwarmRun
from apps.agent.runtime.swarm.prompts import (
    ENGINE_SCHEMA,
    ENGINE_SYSTEM,
    GAP_SCHEMA,
    GAP_SYSTEM,
    EngineAnalysis,
    GapAnalysis,
)
from apps.agent.tests.fakes import http_error, message, refusal, text, thinking
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.swarm_support import *  # noqa: F403
from apps.agent.tests.swarm_support import (
    HAIKU,
    UsageLog,
    make_run,
    make_swarm,
    plan_prompts,
    tool_context,
)
from core.ai_tracking import MODEL_PROVIDER, estimate_cost

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("swarm_limits")]

CONTENT = [{"type": "text", "text": "<answer>\nHubSpot is the best CRM.\n</answer>"}]
ANALYSIS = {"summary": "It recommends HubSpot.", "reasons": ["Free tier"], "opportunity": ""}


@pytest.fixture
def swarm_run(chat):
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1))
    usage = UsageLog()
    swarm_run = SwarmRun(tool_context(run, usage=usage), swarm, version,
                         deadline=time.monotonic() + 60, carried={})
    swarm_run.usage_log = usage
    return swarm_run


def _ask(swarm_run, *, worker="engine_answer", purpose="engine_answer", timeout=30.0,
         system=ENGINE_SYSTEM, schema=ENGINE_SCHEMA, model=EngineAnalysis):
    return ask_haiku(run=swarm_run, task_id="engines.p1.chatgpt", worker=worker, purpose=purpose,
                     system=system, content=CONTENT, schema=schema, output_model=model,
                     timeout=timeout)


def test_the_request_is_exactly_what_the_model_accepts(swarm_run, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: ANALYSIS

    result = _ask(swarm_run)

    assert result.ok and result.data.summary == "It recommends HubSpot."
    [request] = routed_anthropic.haiku_requests
    body = request.json
    assert body == {
        "model": "claude-haiku-5-5",
        "max_tokens": 2048,
        "system": [{"type": "text", "text": ENGINE_SYSTEM}],
        "thinking": {"type": "disabled"},
        "output_config": {"effort": "low",
                          "format": {"type": "json_schema", "schema": ENGINE_SCHEMA}},
        "messages": [{"role": "user", "content": CONTENT}],
    }
    for name in ("temperature", "top_p", "top_k", "fallbacks", "tools", "stream"):
        assert name not in body
    assert "cache_control" not in json.dumps(body)
    assert "anthropic-beta" not in request.headers
    assert body["messages"][-1]["role"] == "user"
    assert routed_anthropic.requests == []


def test_a_spent_allowance_sends_nothing(swarm_run, routed_anthropic, monkeypatch):
    monkeypatch.setattr("apps.agent.llm.worker.allowance_denial",
                        lambda user: "monthly_ai_allowance_exceeded")

    result = _ask(swarm_run)

    assert (result.ok, result.code, result.message) == (
        False, "allowance_exceeded", "The monthly AI allowance is used up.")
    assert result.error == {"code": "allowance_exceeded",
                            "message": "The monthly AI allowance is used up."}
    assert routed_anthropic.haiku_requests == []
    assert not AITokenUsage.objects.exists()


def test_usage_is_recorded_for_the_agent_and_added_to_the_research(swarm_run, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: ANALYSIS

    _ask(swarm_run)

    row = AITokenUsage.objects.get()
    run = swarm_run.ctx.run
    assert (row.module, row.provider, row.model_name) == ("agent", "anthropic", HAIKU)
    assert (row.input_tokens, row.output_tokens) == (1000, 200)
    swarm8 = str(swarm_run.swarm.id).replace("-", "")[:8]
    assert row.idempotency_key == (
        f"agent:{run.id}:w{swarm8}.1:engines.p1.chatgpt:engine_answer:0")
    assert row.metadata["role"] == "worker"
    assert {k: row.metadata[k] for k in ("swarm_id", "version", "task_id", "worker",
                                         "purpose")} == {
        "swarm_id": str(swarm_run.swarm.id), "version": 1, "task_id": "engines.p1.chatgpt",
        "worker": "engine_answer", "purpose": "engine_answer"}
    cost = Decimal("0.0002")
    assert (swarm_run.cost_usd, swarm_run.worker_requests) == (cost, 1)
    [(_, totals)] = swarm_run.usage_log.calls
    assert (totals.requests, totals.cost_usd, totals.input_tokens) == (0, cost, 1000)


@pytest.mark.parametrize("answer,code,message_", [
    (lambda: refusal(text(""), model=HAIKU), "refused", "The analysis model declined this input."),
    (lambda: message(text('{"summary": "cut'), model=HAIKU, stop_reason="max_tokens"),
     "invalid_output", "The analysis came back unreadable."),
    (lambda: "this is not JSON", "invalid_output", "The analysis came back unreadable."),
    (lambda: {"summary": "No reasons"}, "invalid_output", "The analysis came back unreadable."),
])
def test_unusable_answers_have_their_own_codes(swarm_run, routed_anthropic, answer, code,
                                               message_):
    routed_anthropic.haiku = lambda purpose: answer()

    result = _ask(swarm_run)

    assert (result.ok, result.code, result.message) == (False, code, message_)
    # The request was answered and billed, so it is still recorded.
    assert AITokenUsage.objects.count() == 1


@pytest.mark.parametrize("status,error_type,code", [
    (429, "rate_limit_error", "rate_limited"),
    (529, "overloaded_error", "rate_limited"),
    (500, "api_error", "upstream_error"),
    (400, "invalid_request_error", "upstream_error"),
])
def test_api_errors_in_public_words(swarm_run, routed_anthropic, status, error_type, code):
    routed_anthropic.haiku = lambda purpose: http_error(status, error_type, "upstream says no")

    result = _ask(swarm_run)

    assert (result.ok, result.code) == (False, code)
    assert "upstream says no" not in result.message
    assert not AITokenUsage.objects.exists()


def test_a_thinking_block_is_skipped_by_type(swarm_run, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: message(thinking(""), text(json.dumps(ANALYSIS)),
                                                     model=HAIKU)

    result = _ask(swarm_run)

    assert result.ok and result.data.reasons == ["Free tier"]


def test_output_models_clip_and_slice_instead_of_failing(swarm_run, routed_anthropic):
    routed_anthropic.haiku = lambda purpose: {
        "headline": "x" * 500,
        "gaps": [{"issue": f"Issue {i}", "evidence": "e" * 300, "fix": "f", "target": "",
                  "severity": "low"} for i in range(6)],
    }

    result = _ask(swarm_run, worker="content_gap", purpose="content_gap", system=GAP_SYSTEM,
                  schema=GAP_SCHEMA, model=GapAnalysis)

    assert result.ok
    assert len(result.data.headline) == 160
    assert len(result.data.gaps) == 4
    assert len(result.data.gaps[0].evidence) == 200


def test_stop_and_an_exhausted_time_limit_send_nothing(swarm_run, routed_anthropic):
    assert _ask(swarm_run, timeout=0).code == "cancelled"
    swarm_run.ctx.active.cancel()
    assert _ask(swarm_run).code == "cancelled"
    assert routed_anthropic.haiku_requests == []


def test_thread_mode_waits_for_a_haiku_slot_unless_the_task_holds_one(
        chat, routed_anthropic, settings, swarm_limits):
    settings.AGENT_SWARM_HAIKU_CONCURRENCY = 1
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1))
    threaded = SwarmRun(tool_context(run, inline=False), swarm, version,
                        deadline=time.monotonic() + 60, carried={})
    routed_anthropic.haiku = lambda purpose: {"headline": "Nothing missing.", "gaps": []}
    assert swarm_limits.acquire("haiku", 1)
    try:
        waited = _ask(threaded, timeout=0.2)
        held = _ask(threaded, worker="content_gap", purpose="content_gap", system=GAP_SYSTEM,
                    schema=GAP_SCHEMA, model=GapAnalysis)
    finally:
        swarm_limits.release("haiku")

    assert waited.code == "cancelled"
    assert held.ok
    assert len(routed_anthropic.haiku_requests) == 1
    assert routed_anthropic.haiku_requests[0].json["system"][0]["text"] == GAP_SYSTEM


def test_the_pricing_row_for_claude_haiku_5_5():
    assert estimate_cost("claude-haiku-5-5", 10_000, 1_000) == pytest.approx(0.0015)
    assert estimate_cost("claude-haiku-5-5", 0, 0, cache_read=1_000_000) == pytest.approx(0.01)
    assert MODEL_PROVIDER["claude-haiku-5-5"] == "anthropic"


def test_the_worker_settings_are_checked(settings):
    settings.AGENT_WORKER_EFFORT = "max"
    settings.AGENT_WORKER_MODEL = ""
    settings.AGENT_SWARM_WORKERS = 0

    ids = {(e.id, e.msg.split(":")[0]) for e in check_agent_settings()}

    assert ("agent.E002", "AGENT_WORKER_EFFORT") in ids
    assert ("agent.E008", "AGENT_WORKER_MODEL") in ids
    assert ("agent.E004", "AGENT_SWARM_WORKERS") in ids
