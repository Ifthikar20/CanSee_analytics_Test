"""The Claude engine check: thinking budgets, unusable answers, search fees
and price rows (findings be-claude-api-3, -4 and -5)."""
from decimal import Decimal

import pytest
from django.core.cache import cache

from apps.accounts.models import AITokenUsage
from apps.agent.tests.fakes import FakeAnthropic, message, refusal, server_web_search, text
from apps.llm_ranking.providers import MODEL_VARIANTS, ClaudeProvider, get_provider_for_variant
from core.ai_tracking import MODEL_PROVIDER, PRICING, _estimate_cost

pytestmark = pytest.mark.django_db

LIST_ANSWER = "1. Acme CRM - pipelines.\n2. Northwind - small teams."


@pytest.fixture
def fake_sdk(monkeypatch, settings):
    # The shared llm:claude rate bucket and breaker live in the cache.
    cache.clear()
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.LLM_WEBSEARCH_ENABLED = False
    return FakeAnthropic().patch_sdk(monkeypatch)


def _ask(variant, user, **kwargs):
    provider = get_provider_for_variant(variant)
    return provider.query("Best CRM for a small team?", user=user, module="prompt_library",
                          **kwargs)


def _usage(user):
    return AITokenUsage.objects.get(user=user)


# ── request shape ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("model", ["claude-sonnet-5", "claude-opus-5", "claude-fable-5"])
def test_thinking_variants_get_room_to_think_and_low_effort(fake_sdk, user, model):
    fake_sdk.queue(message(text(LIST_ANSWER), model=model))

    result = _ask(f"claude:{model}", user)

    assert result.succeeded, result.error
    sent = fake_sdk.last_request.json
    assert sent["model"] == model
    assert sent["max_tokens"] == ClaudeProvider.THINKING_MAX_TOKENS > 1024
    assert sent["output_config"] == {"effort": "low"}
    assert "thinking" not in sent


def test_haiku_keeps_the_plain_answer_budget(fake_sdk, user):
    fake_sdk.queue(message(text(LIST_ANSWER), model="claude-haiku-4-5"))

    assert _ask("claude:claude-haiku-4-5", user).succeeded
    sent = fake_sdk.last_request.json
    assert sent["max_tokens"] == ClaudeProvider.ANSWER_MAX_TOKENS == 4096
    assert "output_config" not in sent


# ── answers that are not measurements ────────────────────────────────────


def test_an_answer_cut_off_at_max_tokens_is_a_billed_failure(fake_sdk, user):
    fake_sdk.queue(message(text("1. Acme CRM - pipelines.\n2. "), model="claude-opus-5",
                           stop_reason="max_tokens", input_tokens=40, output_tokens=8000))

    result = _ask("claude:claude-opus-5", user)

    assert not result.succeeded
    assert result.error.startswith("max_tokens:")
    assert result.text == ""
    row = _usage(user)
    assert (row.model_name, row.input_tokens, row.output_tokens) == ("claude-opus-5", 40, 8000)
    assert row.estimated_cost_usd == Decimal(str(_estimate_cost("claude-opus-5", 40, 8000)))


def test_a_refusal_is_a_billed_failure_that_keeps_the_breaker_closed(fake_sdk, user):
    for _ in range(6):
        fake_sdk.queue(refusal(model="claude-fable-5", input_tokens=30, output_tokens=0))

    results = [_ask("claude:claude-fable-5", user) for _ in range(6)]

    assert all(not r.succeeded and r.error == "refusal: Claude declined to answer (cyber)"
               for r in results)
    assert AITokenUsage.objects.filter(user=user).count() == 6
    provider = get_provider_for_variant("claude:claude-fable-5")
    assert provider._breaker().allow()
    assert cache.get("cb:llm:claude:failures") is None


def test_a_paused_web_search_turn_is_not_a_measurement(fake_sdk, user, settings):
    settings.LLM_WEBSEARCH_ENABLED = True
    fake_sdk.queue(message(server_web_search("best crm", [{"title": "A", "url": "https://a.test/"}]),
                           model="claude-sonnet-5", stop_reason="pause_turn",
                           web_search_requests=1))

    result = _ask("claude:claude-sonnet-5", user)

    assert not result.succeeded and result.error.startswith("pause_turn:")
    assert result.web_search_requests == 1


def test_an_empty_answer_is_not_a_measurement(fake_sdk, user):
    fake_sdk.queue(message(model="claude-haiku-4-5"))

    result = _ask("claude:claude-haiku-4-5", user)

    assert not result.succeeded and result.error.startswith("empty_answer:")


def test_the_crawler_does_not_ask_again_after_a_refusal(fake_sdk, user, website):
    from apps.prompt_library.services.prompt_crawler import _query_with_retry

    fake_sdk.queue(refusal(model="claude-opus-5"), message(text(LIST_ANSWER), model="claude-opus-5"))

    result = _query_with_retry(get_provider_for_variant("claude:claude-opus-5"),
                               "Best CRM?", user=user, website=website)

    assert result.error.startswith("refusal:")
    assert len(fake_sdk.requests) == 1


def test_the_crawler_still_retries_a_cut_off_answer_once(fake_sdk, user, website):
    from apps.prompt_library.services.prompt_crawler import _query_with_retry

    fake_sdk.queue(message(text("1. Acme"), model="claude-opus-5", stop_reason="max_tokens"),
                   message(text(LIST_ANSWER), model="claude-opus-5"))

    result = _query_with_retry(get_provider_for_variant("claude:claude-opus-5"),
                               "Best CRM?", user=user, website=website)

    assert result.succeeded and result.text == LIST_ANSWER
    assert len(fake_sdk.requests) == 2


@pytest.mark.parametrize("raw, shown", [
    ("refusal: Claude declined to answer (cyber)", "The model declined to answer this prompt."),
    ("max_tokens: the answer was cut off at the 8000-token limit",
     "The model's answer was cut off before it finished."),
    ("pause_turn: the web search paused the turn before an answer was written",
     "The model's answer was cut off before it finished."),
    ("empty_answer: Claude returned no answer text", "The model returned no answer."),
    ("Connection reset by peer", "This model did not respond on this scan."),
])
def test_the_prompt_library_names_an_unusable_answer_plainly(raw, shown):
    from apps.prompt_library.api.v1.views import _public_model_error

    assert _public_model_error(raw) == shown


# ── web search fees ───────────────────────────────────────────────────────


def test_server_web_searches_are_priced_into_the_recorded_cost(fake_sdk, user, settings):
    settings.LLM_WEBSEARCH_ENABLED = True
    fake_sdk.queue(message(
        server_web_search("best crm", [{"title": "Acme", "url": "https://acme.test/"}]),
        text(LIST_ANSWER), model="claude-haiku-4-5",
        input_tokens=2_000, output_tokens=500, web_search_requests=3,
    ))

    result = _ask("claude:claude-haiku-4-5", user)

    assert result.succeeded and result.web_search_requests == 3
    assert fake_sdk.last_request.json["tools"][0]["name"] == "web_search"
    row = _usage(user)
    assert row.metadata["web_search_requests"] == 3
    assert row.estimated_cost_usd == Decimal(str(
        _estimate_cost("claude-haiku-4-5", 2_000, 500, web_search_requests=3)
    ))
    assert row.estimated_cost_usd > Decimal(str(_estimate_cost("claude-haiku-4-5", 2_000, 500)))


# ── price rows ────────────────────────────────────────────────────────────


def test_every_selectable_claude_model_has_its_own_price_row():
    from core.llm.utility import DEFAULT_CLAUDE_MODEL

    models = {model_id for _label, model_id, _default in MODEL_VARIANTS["claude"]}
    models |= {ClaudeProvider.DEFAULT_MODEL, DEFAULT_CLAUDE_MODEL}
    for model in sorted(models):
        assert model in PRICING, model
        assert MODEL_PROVIDER[model] == "anthropic", model


def test_fable_5_and_sonnet_5_are_priced_at_their_own_rates():
    # 2,000 input and 1,000 output tokens.
    assert _estimate_cost("claude-fable-5", 2_000, 1_000) == 0.07
    assert _estimate_cost("claude-sonnet-5", 2_000, 1_000) == 0.014
    assert _estimate_cost("claude-fable-5", 0, 0, cache_read=1_000_000) == 1.0
    assert _estimate_cost("claude-fable-5", 0, 0, cache_write_1h=1_000_000) == 20.0
