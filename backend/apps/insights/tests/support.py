"""Fixtures and builders for the insights tests (BE-insights).

Every AI request goes to a FakeAnthropic (the agent tests' scripted SDK
backend) or is refused; no test reaches a model, Google or a website.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, time, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.agent.llm.client import set_client_factory
from apps.agent.runtime.swarm import limits
from apps.agent.tests.fakes import FakeAnthropic, message, refusing_client, text
from apps.citations.models import Citation, SourceClass
from apps.citations.services.url_normalizer import normalize_url
from apps.insights.services import runs
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services._hash import text_hash
from apps.websites.models import Website

SITE = "https://www.notes-fixture.example"
BRAND = "Fixture Notes"
COMPETITORS = [
    {"name": "Alpha Notes", "domain": "alpha-notes.example"},
    {"name": "Beta Notes", "domain": "beta-notes.example"},
]
HAIKU = "claude-haiku-5-5"
# The fixtures test modules take with a star import.
__all__ = ["_no_real_anthropic", "cache_clear", "client", "engines", "fake_anthropic", "stranger", "user", "website"]


def today() -> date:
    return timezone.now().date()


def at(days_ago: int, hour: int = 12) -> datetime:
    """Noon UTC ``days_ago`` days before today."""
    return datetime.combine(today() - timedelta(days=days_ago), time(hour), tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_real_anthropic():
    """A test that reaches get_client() without a fake gets an error, never
    the network; the process-wide analysis slots start fresh."""
    set_client_factory(refusing_client)
    limits.reset_limits()
    yield
    set_client_factory(None)
    limits.reset_limits()


@pytest.fixture
def fake_anthropic():
    fake = FakeAnthropic().install()
    yield fake
    set_client_factory(None)


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Fixture Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url=SITE, name=BRAND, competitors=COMPETITORS)


@pytest.fixture
def client(user):
    api = APIClient()
    api.force_authenticate(user)
    return api


@pytest.fixture
def stranger():
    return get_user_model().objects.create_user(
        email="stranger@example.com", password="x" * 16, full_name="Someone Else",
        is_email_verified=True,
    )


@pytest.fixture
def engines(settings):
    """ChatGPT and Claude configured; the other engines are not."""
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.PERPLEXITY_API_KEY = ""
    return settings


@pytest.fixture
def cache_clear():
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


def track(website, prompt_text: str, *, location: str = "us", archived: bool = False) -> BrandPrompt:
    industry, _ = Industry.objects.get_or_create(
        slug="fixture-notes", defaults={"name": "Notes (fixture)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=prompt_text, template_text=prompt_text,
        text_hash=text_hash(prompt_text), intent_bucket="category", style="question",
        source=PromptSource.MANUAL,
    )
    return BrandPrompt.objects.create(
        website=website, prompt=prompt, location=location, is_archived=archived,
    )


def answer(bp, engine: str, when: datetime, *, mentioned: bool = True, rank=None,
           sentiment=None, response: str = "An answer.", brands=(), succeeded: bool = True,
           search_queries=None, web_searches=None) -> LLMRankingResult:
    """One engine answer to ``bp`` given at ``when`` (``engine`` is the
    provider key: gpt4, claude, gemini, grok, perplexity)."""
    website = bp.website
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=website.user, status=LLMRankingAudit.STATUS_COMPLETED,
        prompts=[bp.prompt.text], business_name=website.name, providers_queried=[engine],
    )
    fields = {}
    if search_queries is not None:
        fields["search_queries"] = search_queries
    if web_searches is not None:
        fields["web_searches"] = web_searches
    result = LLMRankingResult.objects.create(
        audit=audit, provider=engine, prompt=bp.prompt.text, response_text=response,
        is_mentioned=mentioned, mention_rank=rank,
        sentiment=sentiment or ("positive" if mentioned else "not_mentioned"),
        competitors_mentioned=[
            {"name": name, "position": i, "linked": False} if isinstance(name, str) else name
            for i, name in enumerate(brands, 1)
        ],
        query_succeeded=succeeded, source_prompt=bp.prompt, **fields,
    )
    LLMRankingResult.objects.filter(id=result.id).update(created_at=when)
    result.created_at = when
    return result


def cite(result, url: str, *, references: int = 1, source_class: str = SourceClass.OTHER,
         target: bool = False, competitor: bool = False) -> Citation:
    normalized, host, apex = normalize_url(url)
    return Citation.objects.create(
        result=result, audit=result.audit, url=url, normalized_url=normalized, domain=host,
        apex_domain=apex, source_class=source_class, position=1, is_target=target,
        is_competitor=competitor, reference_count=references,
    )


def analyzed(result, bp, *, status: str = "done", claims=(), themes=()):
    """An answer analysis of ``result`` with its claims ``(text, topic,
    verdict, quote, evidence dict)`` and themes ``(label, tone, quote)``."""
    from apps.citations.services.url_analytics import model_key
    from apps.insights.models import AnswerAnalysis, AnswerClaim, AnswerTheme
    from apps.insights.services.text import claim_key, label_key

    engine = model_key(result.provider)
    analysis = AnswerAnalysis.objects.create(
        website=bp.website, result=result, version="1", status=status, engine=engine,
        prompt=bp.prompt, answered_at=result.created_at, claims_count=len(claims),
        themes_count=len(themes), verified=True,
    )
    shared = {"analysis": analysis, "website": bp.website, "engine": engine,
              "prompt": bp.prompt, "answered_at": result.created_at}
    for text_, topic, verdict, quote, ev in claims:
        ev = ev or {}
        AnswerClaim.objects.create(
            text=text_, text_key=claim_key(text_), topic=topic, verdict=verdict, quote=quote,
            evidence_kind=ev.get("kind", ""), evidence_url=ev.get("url", ""),
            evidence_fact=ev.get("fact"), evidence_quote=ev.get("quote", ""),
            note=ev.get("note", ""), **shared,
        )
    for label, tone, quote in themes:
        AnswerTheme.objects.create(label=label, label_key=label_key(label), tone=tone,
                                   quote=quote, **shared)
    return analysis


def haiku(payload: dict, **kwargs):
    """A scripted Claude Haiku 5.5 response carrying ``payload`` as JSON."""
    return message(text(json.dumps(payload)), model=HAIKU, **kwargs)


def fake_kind(key: str = "fake_kind", *, label: str = "Fake kind", units: int = 3,
              calls: int = 0, usd: str = "0", pages: int = 0, item=None,
              validate=None, blockers=None, warnings=None, plan_items=None) -> runs.Kind:
    """A run kind whose items are ``units`` calls of ``item(ctx, index)``
    (default: done)."""

    def _validate(website, params):
        if validate is not None:
            return validate(website, params)
        return {"units": units}

    def _estimate(website, user, plan):
        return {
            "summary": f"{plan['units']} fake units",
            "units": {"items": plan["units"]},
            "ai": {"calls_max": calls, "usd_max": usd, "model_label": "Claude Haiku 5.5"},
            "google": {"pages_max": pages},
            "fetches": {"pages_max": 0},
            "warnings": list(warnings or []),
            "blockers": list(blockers or []),
        }

    def _choices(website, user):
        return {"fake": True}

    def _plan_items(run, plan):
        if plan_items is not None:
            return plan_items(run, plan)
        return plan["units"]

    def _execute(ctx):
        def one(index):
            if ctx.cancelled():
                ctx.end_item("cancelled", started=False)
                return
            ctx.start_item()
            status = item(ctx, index) if item is not None else "done"
            if status is None:
                return
            if isinstance(status, tuple):
                ctx.end_item(status[0], error=status[1])
            else:
                ctx.end_item(status)

        with ctx.pool(2) as pool:
            pool.map(one, range(ctx.run.units_total))

    return runs.Kind(
        key=key, label=label, queue="ai", validate=_validate, estimate=_estimate,
        choices=_choices, plan_items=_plan_items, execute=_execute,
    )
