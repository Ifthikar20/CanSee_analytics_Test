"""Fixtures and helpers shared by the Ask AI suites (tests only).

Import what a module needs: ``from apps.prompt_box.tests.support import *``.
Nothing here leaves the process: every engine is a ``FakeEngine`` registered
in PROVIDERS (the real LLMProvider.query around a scripted ``_call``, so the
spend wall and the usage ledger run for real) and the structured extraction
is ``fake_extract``.
"""
from __future__ import annotations

import itertools
import re
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.models import AITokenUsage, Organization, OrganizationMember
from apps.llm_ranking.providers import PROVIDERS
from apps.llm_ranking.services.extraction_service import HaikuExtractionService
from apps.prompt_box.services import runs
from apps.prompt_library.models import BrandPrompt, Industry, Prompt
from apps.prompt_library.services._hash import text_hash
from apps.websites.models import Website
from core.llm.base import LLMProvider, ProviderResult

__all__ = [
    "box_env", "user", "website", "api", "client_for", "data", "error", "engines",
    "extraction", "SITE", "BRAND", "QUESTION", "answer", "failure", "named", "unnamed",
    "FakeEngines", "fake_extract", "make_prompt", "member_clients", "body", "confirm_of",
    "ledger_rows",
]

SITE = "https://www.northwind-crm.example"
BRAND = "Northwind CRM"
QUESTION = "best crm for a small plumbing business"
KEY_SETTINGS = {
    "gpt4": "OPENAI_API_KEY", "claude": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY",
    "grok": "XAI_API_KEY", "perplexity": "PERPLEXITY_API_KEY",
}
_counter = itertools.count(1)


@pytest.fixture(autouse=True)
def box_env(settings, monkeypatch):
    """Deterministic settings, no provider keys, a clean cache (the daily
    quota, rate buckets, breakers) and no waiting."""
    cache.clear()
    settings.PROMPT_BOX_RUN_MODE = "inline"
    settings.PROMPT_BOX_MAX_SAMPLES = 10
    settings.PROMPT_BOX_DAILY_ANSWERS = 100
    settings.PROMPT_BOX_CONCURRENCY = 3
    settings.PROMPT_BOX_STALE_MINUTES = 10
    settings.LLM_WEBSEARCH_ENABLED = False
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    settings.PAYWALL_ENABLED = False
    for setting in KEY_SETTINGS.values():
        setattr(settings, setting, "")
    monkeypatch.setattr(runs, "CANCEL_POLL_SECONDS", 0.0)
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
        topics=["crm"], competitors=[{"name": "Acme CRM", "domain": "acme-crm.example"}],
    )


def client_for(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def api(user):
    return client_for(user)


def data(resp):
    body = resp.json()
    assert body.get("success") is True, body
    return body["data"]


def error(resp) -> dict:
    body = resp.json()
    assert body.get("success") is False, body
    return body["error"]


@pytest.fixture
def member_clients(user, website):
    """``{role: client}`` for an org member, a viewer and a stranger, with the
    website moved into the owner's organization."""
    org = Organization.objects.create(
        name="Northwind", slug=f"northwind-{next(_counter)}", owner=user,
    )
    OrganizationMember.objects.create(organization=org, user=user, role="owner")
    website.organization = org
    website.save(update_fields=["organization"])
    out = {}
    for role in ("member", "viewer", "stranger"):
        person = get_user_model().objects.create_user(
            email=f"{role}{next(_counter)}@example.com", password="x" * 16,
        )
        if role != "stranger":
            OrganizationMember.objects.create(organization=org, user=person, role=role)
        out[role] = client_for(person)
    return out


def make_prompt(website, text: str, *, archived: bool = False) -> BrandPrompt:
    industry, _ = Industry.objects.get_or_create(
        slug="crm-prompt-box", defaults={"name": "CRM (prompt box)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, intent_bucket="category",
        source="manual", text_hash=text_hash(text),
    )
    return BrandPrompt.objects.create(website=website, prompt=prompt, is_archived=archived)


def body(text: str = QUESTION, samples: int = 3, engines=None, **extra) -> dict:
    out = {"text": text, "samples": samples}
    if engines is not None:
        out["engines"] = list(engines)
    out.update(extra)
    return out


def confirm_of(estimate: dict) -> dict:
    return dict(estimate["confirm"])


def ledger_rows(run):
    return AITokenUsage.objects.filter(metadata__audit_id=run.audit_id)


# -- engines ------------------------------------------------------------------------


def answer(text: str, *, citations=None, queries=None) -> ProviderResult:
    return ProviderResult(
        succeeded=True, text=text, input_tokens=120, output_tokens=60,
        citations=list(citations or []), search_queries=queries,
        web_searches=len(queries) if queries is not None else None,
    )


def named(rank: int = 1) -> ProviderResult:
    """An answer listing the brand at ``rank`` among competitors."""
    others = ["Acme CRM", "Contoso CRM", "Fabrikam CRM"]
    names = others[: rank - 1] + [BRAND] + others[rank - 1:]
    return answer("\n".join(f"{i}. {n} - for small teams." for i, n in enumerate(names, 1)))


def unnamed() -> ProviderResult:
    return answer("1. Acme CRM - pipelines.\n2. Contoso CRM - small teams.")


def failure(error: str, *, billed: bool = False) -> ProviderResult:
    tokens = {"input_tokens": 50, "output_tokens": 10} if billed else {}
    return ProviderResult(succeeded=False, error=error, **tokens)


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
                item = queued.pop(0) if queued else unnamed()
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
    listed, and every other name as a competitor. Records a ledger row like
    the real extraction (tagged with the audit id, no other tags)."""
    from core.ai_tracking import record_usage

    record_usage(
        module="llm_ranking", model_name="claude-haiku-4-5", provider="anthropic",
        input_tokens=200, output_tokens=50, user=user, website=website,
        metadata={"role": "extraction", "audit_id": str(audit_id)} if audit_id else {},
    )
    names = [
        m.group(1).split(" - ")[0].strip()
        for m in (re.match(r"^\s*\d+\.\s*(.+)$", line) for line in response_text.splitlines()) if m
    ]
    fold = brand_name.casefold()
    rank = next((i for i, n in enumerate(names, start=1) if n.casefold() == fold), None)
    mentioned = rank is not None
    return {
        "is_mentioned": mentioned,
        "mention_rank": rank,
        "sentiment": "positive" if mentioned else "not_mentioned",
        "mention_context": f"{brand_name} - for small teams." if mentioned else "",
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

    def extract(**kwargs):
        calls.append(kwargs)
        return fake_extract(**kwargs)

    monkeypatch.setattr(HaikuExtractionService, "extract", staticmethod(extract))
    extract.calls = calls
    return extract


def usd(value) -> Decimal:
    return Decimal(str(value))
