"""Fixtures and helpers shared by the country check suites (tests only).

Import what a module needs: ``from apps.search_gap.tests.country_support
import *``. Nothing here leaves the process: Google results come from
``FakeSerp`` (installed as serp_google.search), every engine is a
``FakeEngine`` registered in PROVIDERS, and the structured extraction is
``fake_extract``. The provider tests use ``responses`` and SDK stubs.
"""
from __future__ import annotations

import re
from datetime import timedelta
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.citations.services import serp_google
from apps.llm_ranking.providers import PROVIDERS
from apps.llm_ranking.services.extraction_service import HaikuExtractionService
from apps.prompt_library.models import BrandPrompt, Industry, Prompt
from apps.prompt_library.services._hash import text_hash
from apps.search_gap.models import CountryCheckResult, CountryCheckRun
from apps.search_gap.services import country_checks
from apps.websites.models import Website
from core.llm.base import LLMProvider, ProviderResult

__all__ = [
    "country_env", "user", "website", "api", "scraperapi", "serpapi", "engines", "extraction",
    "fake_serp", "SITE", "BRAND", "COMPETITORS", "KEY_SETTINGS", "make_prompt", "answer",
    "failure", "organic_page", "serp_error", "FakeSerp", "FakeEngines", "fake_extract",
    "make_run", "make_cell", "data", "body_for", "start_queued",
]

SITE = "https://www.northwind-crm.example"
BRAND = "Northwind CRM"
COMPETITORS = [{"name": "Acme CRM", "domain": "acme-crm.example"}]
KEY_SETTINGS = {
    "gpt4": "OPENAI_API_KEY", "claude": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY",
    "grok": "XAI_API_KEY", "perplexity": "PERPLEXITY_API_KEY",
}
OTHER_SITES = [f"result-{i}.example" for i in range(1, 21)]


@pytest.fixture(autouse=True)
def country_env(settings, monkeypatch):
    """Deterministic settings, no provider keys, a clean cache (quotas,
    rate buckets, breakers) and no waiting."""
    cache.clear()
    settings.COUNTRY_CHECKS_ENABLED = True
    settings.COUNTRY_CHECK_RUN_MODE = "inline"
    settings.COUNTRY_CHECK_MAX_COUNTRIES = 5
    settings.COUNTRY_CHECK_MAX_PROMPTS = 10
    settings.COUNTRY_CHECK_MAX_PAGES = 2
    settings.COUNTRY_CHECK_MAX_GOOGLE_PAGES = 50
    settings.COUNTRY_CHECK_MAX_ENGINE_ANSWERS = 100
    settings.COUNTRY_CHECK_DAILY_GOOGLE_PAGES = 100
    settings.COUNTRY_CHECK_STALE_MINUTES = 20
    settings.SCRAPERAPI_GEO_COUNTRIES = "us"
    settings.SCRAPERAPI_CREDITS_PER_SEARCH = 25
    settings.SCRAPERAPI_COST_PER_SEARCH_USD = 0.0
    settings.SERPAPI_COST_PER_SEARCH_USD = 0.015
    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = ""
    settings.SERP_PROVIDER = ""
    settings.LLM_WEBSEARCH_ENABLED = False
    for setting in KEY_SETTINGS.values():
        setattr(settings, setting, "")
    monkeypatch.setattr(country_checks, "CANCEL_POLL_SECONDS", 0.0)
    monkeypatch.setattr(country_checks, "RETRY_SECONDS", 0.0)
    yield
    cache.clear()


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Site Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(
        user=user, url=SITE, name=BRAND, industry="CRM software",
        topics=["crm"], competitors=COMPETITORS,
    )


@pytest.fixture
def api(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def scraperapi(settings):
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    return settings


@pytest.fixture
def serpapi(settings):
    settings.SERPAPI_KEY = "serp-test-key"
    return settings


def make_prompt(website, text: str, *, location: str = "", archived: bool = False) -> BrandPrompt:
    industry, _ = Industry.objects.get_or_create(
        slug="crm-countries", defaults={"name": "CRM (countries)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, intent_bucket="category",
        source="manual", text_hash=text_hash(text),
    )
    return BrandPrompt.objects.create(
        website=website, prompt=prompt, location=location, is_archived=archived,
    )


def data(resp):
    body = resp.json()
    assert body.get("success") is True, body
    return body["data"]


# -- Google ------------------------------------------------------------------


def organic_page(start: int, domains: list[str], *, deferred: bool = False,
                 provider: str = "scraperapi") -> dict:
    """A serp_google.search payload listing ``domains`` from ``start + 1``."""
    payload = serp_google._empty(provider=provider)
    payload["organic"] = [
        {"rank": i + 1, "position": start + i + 1, "url": f"https://www.{d}/page", "domain": d,
         "site_only": False, "breadcrumb": "", "title": f"Result {start + i + 1}",
         "snippet": "", "date": ""}
        for i, d in enumerate(domains)
    ]
    payload["ai_overview_deferred"] = deferred
    return payload


def serp_error(code: str) -> dict:
    return serp_google._empty(code, provider="scraperapi")


class FakeSerp:
    """serp_google.search for the runner: payloads by (country, start), in
    order when a list is given; any other page lists ten other sites."""

    def __init__(self):
        self.calls: list[dict] = []
        self.pages: dict = {}
        self.on_call = None

    def page(self, country: str, start: int, *payloads) -> FakeSerp:
        self.pages[(country, start)] = list(payloads)
        return self

    def __call__(self, query, *, max_results=10, timeout=None, start=0, gl="", hl="", country=None):
        self.calls.append({"query": query, "start": start, "country": country, "gl": gl})
        if self.on_call is not None:
            self.on_call(self.calls[-1])
        queued = self.pages.get((country, start))
        if queued:
            return queued.pop(0) if len(queued) > 1 else queued[0]
        return organic_page(start, OTHER_SITES[start % 20: start % 20 + 10])


@pytest.fixture
def fake_serp(monkeypatch, scraperapi):
    fake = FakeSerp()
    monkeypatch.setattr(serp_google, "search", fake)
    return fake


# -- engines -----------------------------------------------------------------


def answer(text: str, *, searched: bool = False, citations=None) -> ProviderResult:
    return ProviderResult(
        succeeded=True, text=text, input_tokens=120, output_tokens=60,
        citations=list(citations or []), searched=searched,
    )


def failure(error: str, *, billed: bool = False) -> ProviderResult:
    tokens = {"input_tokens": 50, "output_tokens": 10} if billed else {}
    return ProviderResult(succeeded=False, error=error, **tokens)


DEFAULT_ANSWER = "1. Acme CRM - pipelines.\n2. Contoso CRM - small teams."


class FakeEngines:
    """LLMProvider subclasses behind PROVIDERS: the real query() (spend wall,
    usage ledger) around a scripted ``_call``."""

    def __init__(self, monkeypatch, settings):
        self.monkeypatch = monkeypatch
        self.settings = settings
        self.calls: list[dict] = []
        self.scripts: dict[str, list] = {}

    def enable(self, *engines: str) -> FakeEngines:
        for engine in engines:
            key = "gpt4" if engine == "chatgpt" else engine
            setattr(self.settings, KEY_SETTINGS[key], f"{key}-test-key")
            self.monkeypatch.setitem(PROVIDERS, key, self._provider(key))
        return self

    def script(self, engine: str, *results) -> FakeEngines:
        key = "gpt4" if engine == "chatgpt" else engine
        self.scripts.setdefault(key, []).extend(results)
        return self

    def _provider(self, key: str):
        fakes = self

        class FakeEngine(LLMProvider):
            name = key
            model = f"fake-{key}"
            api_key_setting = KEY_SETTINGS[key]

            def _call(self, *, prompt, system_prompt, region=""):
                call = {"provider": key, "prompt": prompt, "system_prompt": system_prompt,
                        "region": region}
                fakes.calls.append(call)
                queued = fakes.scripts.get(key)
                item = queued.pop(0) if queued else answer(DEFAULT_ANSWER)
                if callable(item):
                    item = item(call)
                if isinstance(item, Exception):
                    raise item
                return item

        return FakeEngine


@pytest.fixture
def engines(monkeypatch, settings):
    return FakeEngines(monkeypatch, settings)


def fake_extract(*, response_text, brand_name, keywords, user=None, website=None,
                 audit_id=None, idempotency_key=None):
    """The extraction's shape from a numbered list: where ``brand_name`` is
    listed, and every other name as a competitor."""
    names = [
        m.group(1).split(" - ")[0].strip()
        for m in (re.match(r"^\s*\d+\.\s*(.+)$", line) for line in response_text.splitlines()) if m
    ]
    fold = brand_name.casefold()
    rank = next((i for i, n in enumerate(names, start=1) if n.casefold() == fold), None)
    mentioned = rank is not None or fold in response_text.casefold()
    return {
        "is_mentioned": mentioned,
        "mention_rank": rank,
        "sentiment": "positive" if mentioned else "not_mentioned",
        "mention_context": "",
        "is_linked": False,
        "competitors_mentioned": [
            {"name": n, "position": i, "linked": False, "sentiment": "neutral", "domain": "",
             "kind": "brand"}
            for i, n in enumerate(names, start=1) if n.casefold() != fold
        ],
        "primary_recommendation": "",
        "citations": [],
        "confidence_score": None,
        "extraction_model": "claude-haiku-4-5",
        "extraction_version": "v4",
    }


@pytest.fixture
def extraction(monkeypatch):
    """Replaces HaikuExtractionService.extract; ``calls`` keeps the kwargs."""
    calls: list[dict] = []
    state = {"fn": fake_extract}

    def extract(**kwargs):
        calls.append(kwargs)
        return state["fn"](**kwargs)

    monkeypatch.setattr(HaikuExtractionService, "extract", staticmethod(extract))
    extract.calls = calls
    extract.state = state
    return extract


# -- rows ----------------------------------------------------------------------


def body_for(prompts, countries=("gb",), engines=("chatgpt",), **extra) -> dict:
    body = {
        "countries": list(countries),
        "prompt_ids": [str(bp.prompt_id) for bp in prompts],
        "engines": list(engines),
    }
    body.update(extra)
    return body


def start_queued(website, user, body: dict, settings) -> CountryCheckRun:
    """A created check that nothing has run yet (its dispatch is registered
    on commit, which never comes inside a test transaction)."""
    mode = settings.COUNTRY_CHECK_RUN_MODE
    settings.COUNTRY_CHECK_RUN_MODE = "thread"
    try:
        plan = country_checks.validate_request(website, body)
        est = country_checks.estimate(website, user, plan)
        return country_checks.create_run(website, user, plan, {
            "google_pages": est["confirm"]["google_pages"],
            "engine_answers": est["confirm"]["engine_answers"],
            "ai_usd_max": Decimal(est["confirm"]["ai_usd_max"]),
        })
    finally:
        settings.COUNTRY_CHECK_RUN_MODE = mode


def make_run(website, user=None, *, status="done", countries=("gb",), engines=("chatgpt",),
             prompts=(), provider="scraperapi", **fields) -> CountryCheckRun:
    now = timezone.now()
    defaults = {
        "website": website, "created_by": user, "status": status, "countries": list(countries),
        "prompt_ids": [str(bp.prompt_id) for bp in prompts],
        "brand_prompt_ids": [str(bp.id) for bp in prompts], "engines": list(engines),
        "include_google": bool(provider), "google_pages": 1, "provider": provider,
        "country_status": {c: "done" for c in countries},
        "started_at": now, "finished_at": now if status in CountryCheckRun.TERMINAL_STATUSES else None,
        "heartbeat_at": now,
    }
    defaults.update(fields)
    return CountryCheckRun.objects.create(**defaults)


def make_cell(run, bp, country, engine, *, status="done", age_days: float = 0, **fields):
    finished = timezone.now() - timedelta(days=age_days)
    defaults = {
        "run": run, "website": run.website, "brand_prompt": bp, "country": country,
        "engine": engine, "status": status,
        "finished_at": finished if status not in ("queued", "running") else None,
    }
    if engine == "google":
        defaults.update(method="google_setting", provider="scraperapi", proxy_country="us")
    elif status == "done":
        defaults.update(method="asked", provider="gpt4" if engine == "chatgpt" else engine)
    defaults.update(fields)
    return CountryCheckResult.objects.create(**defaults)
