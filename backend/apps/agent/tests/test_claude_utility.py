"""The utility Claude path on SDK 2.x: no sampling parameters, current models."""

import json
from pathlib import Path

import pytest
from django.conf import settings as django_settings

from apps.agent.tests.fakes import FakeAnthropic, message, text
from core.llm import ClaudeUtility, configured_claude_model

pytestmark = pytest.mark.django_db

SAMPLING = ("temperature", "top_p", "top_k")


@pytest.fixture
def fake_sdk(monkeypatch, settings):
    from django.core.cache import cache

    # The shared llm:claude rate bucket and breaker live in the cache.
    cache.clear()
    settings.ANTHROPIC_API_KEY = "test-key"
    return FakeAnthropic().patch_sdk(monkeypatch)


def test_claude_utility_sends_no_sampling_parameters(fake_sdk):
    fake_sdk.queue(message(text("Northwind is a CRM."), input_tokens=40, output_tokens=8))

    result = ClaudeUtility(model="claude-haiku-4-5", max_tokens=256).query(
        "What is Northwind?", system_prompt="Answer in one sentence.",
        module="llm_ranking", role="test",
    )

    assert result.succeeded, result.error
    assert result.text == "Northwind is a CRM."
    assert (result.input_tokens, result.output_tokens) == (40, 8)
    sent = fake_sdk.last_request
    assert sent.path == "/v1/messages"
    assert not any(key in sent.json for key in SAMPLING)
    assert sent.json == {
        "model": "claude-haiku-4-5",
        "max_tokens": 256,
        "messages": [{"role": "user", "content": "What is Northwind?"}],
        "system": "Answer in one sentence.",
    }
    assert sent.headers["anthropic-version"] == "2026-10-21"
    assert sent.headers["authorization"] == "Bearer test-key"


def test_claude_utility_no_longer_accepts_temperature():
    with pytest.raises(TypeError):
        ClaudeUtility(model="claude-haiku-4-5", temperature=0.1)


def test_benchmark_extraction_sends_no_temperature(fake_sdk, website):
    from apps.prompt_library.services.benchmark_extractor import _ask_claude_for_claims

    claims = {"claims": [{"category": "product", "text": "Northwind sells a CRM."}]}
    fake_sdk.queue(message(text(json.dumps(claims))))

    assert _ask_claude_for_claims("Northwind sells a CRM.", website=website) == claims["claims"]
    sent = fake_sdk.last_request.json
    assert not any(key in sent for key in SAMPLING)
    assert sent["model"] == "claude-haiku-4-5-20251001"
    assert sent["max_tokens"] == 1500


def test_configured_claude_model(settings):
    settings.LLM_CLAUDE_MODEL = ""
    assert configured_claude_model() == "claude-haiku-4-5"
    settings.LLM_CLAUDE_MODEL = "claude-sonnet-4-6"
    assert configured_claude_model() == "claude-sonnet-4-6"


def test_fact_extraction_uses_the_configured_model(fake_sdk, website, settings):
    from apps.brand_vault.services.fact_extractor import _call_llm

    settings.LLM_CLAUDE_MODEL = "claude-sonnet-4-6"
    fake_sdk.queue(message(text("[]")))

    assert _call_llm("Northwind sells a CRM.", website=website) == []
    assert fake_sdk.last_request.json["model"] == "claude-sonnet-4-6"


def test_no_deprecated_sonnet_4_id_left_in_the_call_sites():
    root = Path(django_settings.BASE_DIR)
    for rel in (
        "apps/brand_vault/services/fact_extractor.py",
        "apps/llm_ranking/services/ranking_service.py",
    ):
        assert "claude-sonnet-4-20250514" not in (root / rel).read_text(encoding="utf-8"), rel
