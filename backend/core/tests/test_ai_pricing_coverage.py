"""Every model the product picks on its own has its own price row.

A model without a row is billed at PRICING["default"] ($3 / $15 per 1M
tokens, no per-call fee): several times too high for Gemini 2.5 Flash, and
too low for pricier variants and for Sonar's per-request search fee, so
spend caps and usage pages were wrong.
"""
import pytest
from django.conf import settings

from apps.llm_ranking.providers import MODEL_VARIANTS, PROVIDERS, TOOLING_PROVIDERS
from core.ai_tracking import MODEL_PROVIDER, PRICING, _estimate_cost
from core.llm.utility import DEFAULT_CLAUDE_MODEL

M = 1_000_000

VARIANT_IDS = sorted({model_id for rows in MODEL_VARIANTS.values() for _, model_id, _ in rows})
PROVIDER_DEFAULTS = sorted(
    {cls.model for cls in {**PROVIDERS, **TOOLING_PROVIDERS}.values()}
    | {getattr(cls, "DEFAULT_MODEL", cls.model) for cls in PROVIDERS.values()}
    | {DEFAULT_CLAUDE_MODEL, settings.AGENT_MODEL, settings.AGENT_WORKER_MODEL}
)


@pytest.mark.parametrize("model_id", VARIANT_IDS + PROVIDER_DEFAULTS)
def test_model_has_explicit_price_row(model_id):
    assert model_id in PRICING, f"{model_id} would be billed at the default rate"
    assert model_id in MODEL_PROVIDER


@pytest.mark.parametrize("model_id", VARIANT_IDS)
def test_variant_provider_matches_its_registry_group(model_id):
    labels = {"claude": "anthropic", "gpt4": "openai", "gemini": "google",
              "perplexity": "perplexity", "grok": "xai", "deepseek": "deepseek"}
    group = next(key for key, rows in MODEL_VARIANTS.items()
                 if any(mid == model_id for _, mid, _ in rows))
    assert MODEL_PROVIDER[model_id] == labels[group]


def test_gemini_default_is_not_billed_at_the_fallback_rate():
    assert _estimate_cost("gemini-2.5-flash", M, M) == pytest.approx(0.30 + 2.50)
    assert _estimate_cost("gemini-2.5-flash", M, M) < _estimate_cost("default", M, M)


@pytest.mark.parametrize("model_id", ["sonar", "sonar-pro", "sonar-reasoning-pro"])
def test_every_sonar_variant_carries_its_search_fee(model_id):
    assert PRICING[model_id]["per_call"] > 0
    assert _estimate_cost(model_id, 0, 0) == PRICING[model_id]["per_call"]


def test_pricier_variants_are_not_understated():
    # These cost more than the fallback per output token; the fallback
    # would have let real spend pass the margin cap unnoticed.
    for model_id in ("gpt-5.5", "gpt-5.6-sol", "claude-fable-5"):
        assert _estimate_cost(model_id, 0, M) > PRICING["default"]["output"]
