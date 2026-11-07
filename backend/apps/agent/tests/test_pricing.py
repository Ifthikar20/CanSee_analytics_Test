"""Opus pricing rows, cache-aware cost, and record_usage compatibility."""

from decimal import Decimal

import pytest

from apps.accounts.models import AITokenUsage
from core.ai_tracking import (
    PRICING,
    WEB_SEARCH_COST_PER_REQUEST_USD,
    _estimate_cost,
    estimate_cost,
    record_usage,
)

M = 1_000_000


def test_opus_5_5_rates():
    assert PRICING["claude-opus-5-5"] == {
        "input": 4.00, "output": 20.00,
        "cache_write_5m": 5.00, "cache_write_1h": 8.00, "cache_read": 0.20,
    }
    assert _estimate_cost("claude-opus-5-5", M, M) == 24.0
    assert _estimate_cost(
        "claude-opus-5-5", 0, 0, cache_write_5m=M, cache_write_1h=M, cache_read=M,
    ) == pytest.approx(5.0 + 8.0 + 0.2)


@pytest.mark.parametrize("model", ["claude-opus-5", "claude-opus-4-8"])
def test_opus_5_and_4_8_rates(model):
    assert _estimate_cost(model, M, M) == 30.0
    assert _estimate_cost(model, 0, 0, cache_write_5m=M) == 6.25
    assert _estimate_cost(model, 0, 0, cache_write_1h=M) == 10.0
    assert _estimate_cost(model, 0, 0, cache_read=M) == 0.5


def test_a_typical_cached_agent_request():
    # 1.2k fresh input, 4k written to the 1h cache, 50k read, 800 out, 2 searches.
    cost = _estimate_cost(
        "claude-opus-5-5", 1_200, 800,
        cache_write_1h=4_000, cache_read=50_000, web_search_requests=2,
    )
    expected = (1_200 * 4 + 4_000 * 8 + 50_000 * 0.2 + 800 * 20) / M + 2 * 0.01
    assert cost == round(expected, 6)


def test_web_search_is_a_cent_per_request():
    assert WEB_SEARCH_COST_PER_REQUEST_USD == 0.01
    assert _estimate_cost("claude-opus-5-5", 0, 0, web_search_requests=7) == 0.07


def test_rows_without_cache_rates_use_standard_multipliers():
    # claude-sonnet-4-6 lists only input 3.00 / output 15.00.
    assert _estimate_cost("claude-sonnet-4-6", 0, 0, cache_write_5m=M) == 3.75
    assert _estimate_cost("claude-sonnet-4-6", 0, 0, cache_write_1h=M) == 6.0
    assert _estimate_cost("claude-sonnet-4-6", 0, 0, cache_read=M) == 0.3


def test_existing_positional_callers_are_unchanged():
    # The formula every pre-agent caller relies on (input + output + per_call).
    assert _estimate_cost("claude-haiku-4-5", 1_000, 500) == round(
        1_000 / M * 1.00 + 500 / M * 5.00, 6
    )
    assert _estimate_cost("sonar", 0, 0) == 0.008
    assert _estimate_cost("unknown-model", M, 0) == 3.0
    assert estimate_cost("claude-opus-5-5", M, 0, cache_read=M) == _estimate_cost(
        "claude-opus-5-5", M, 0, cache_read=M,
    )


@pytest.mark.django_db
def test_record_usage_old_call_shape_is_unchanged(user):
    record_usage(
        module="llm_ranking", model_name="claude-haiku-4-5",
        input_tokens=1_000, output_tokens=500, user=user,
        metadata={"role": "upstream"}, idempotency_key="old-shape",
    )

    row = AITokenUsage.objects.get(idempotency_key="old-shape")
    assert row.total_tokens == 1_500
    assert row.estimated_cost_usd == Decimal(str(_estimate_cost("claude-haiku-4-5", 1_000, 500)))
    assert row.metadata == {"role": "upstream"}
    assert row.provider == "anthropic"


@pytest.mark.django_db
def test_record_usage_prices_cache_tiers_and_searches(user, website):
    metadata = {"role": "orchestrator", "run_id": "r1"}
    record_usage(
        module="agent", model_name="claude-opus-5-5",
        input_tokens=1_200, output_tokens=800, user=user, website=website,
        metadata=metadata, idempotency_key="agent:r1:0:0",
        cache_write_5m=0, cache_write_1h=4_000, cache_read=50_000, web_search_requests=2,
    )

    row = AITokenUsage.objects.get(idempotency_key="agent:r1:0:0")
    assert row.module == "agent"
    assert row.get_module_display() == "Agent workspace"
    assert row.provider == "anthropic"
    assert row.total_tokens == 2_000
    assert row.estimated_cost_usd == Decimal(str(_estimate_cost(
        "claude-opus-5-5", 1_200, 800,
        cache_write_1h=4_000, cache_read=50_000, web_search_requests=2,
    )))
    assert row.metadata == {
        "role": "orchestrator", "run_id": "r1",
        "cache_write_1h_tokens": 4_000, "cache_read_tokens": 50_000,
        "web_search_requests": 2,
    }
    # The caller's dict is not mutated.
    assert metadata == {"role": "orchestrator", "run_id": "r1"}


@pytest.mark.django_db
def test_record_usage_replay_is_suppressed(user):
    for _ in range(2):
        record_usage(
            module="agent", model_name="claude-opus-5-5", input_tokens=10,
            output_tokens=10, user=user, idempotency_key="agent:r2:1:0", cache_read=100,
        )
    assert AITokenUsage.objects.filter(idempotency_key="agent:r2:1:0").count() == 1
