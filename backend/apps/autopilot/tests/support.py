"""Fixtures and helpers shared by the Autopilot suites (tests only).

Import what a module needs: ``from apps.autopilot.tests.support import *``.
Nothing leaves the process: every engine is a ``FakeEngine`` registered in
PROVIDERS (the real ``query()``, so the spend wall and the usage ledger
run), the structured extraction is ``fake_extract``, Google page one is
``FakeFindRank`` (installed as google_rank.find_rank), Twilio is
``FakeTwilio`` (installed as requests.post), and the per-answer citation,
alignment and brand security tasks are switched off.
"""
from __future__ import annotations

import re
import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.autopilot.models import Autopilot, AutopilotRun
from apps.autopilot.services import pipeline
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.llm_ranking.providers import PROVIDERS
from apps.llm_ranking.services.extraction_service import HaikuExtractionService
from apps.notifications.models import SmsSubscription
from apps.notifications.services import sms_service
from apps.prompt_library.models import BrandPrompt, Industry, Prompt
from apps.prompt_library.services import prompt_crawler
from apps.prompt_library.services._hash import text_hash
from apps.search_gap.services import google_rank
from apps.websites.models import Website
from core.llm.base import LLMProvider, ProviderResult

__all__ = [
    "autopilot_env", "user", "website", "api", "engines", "extraction", "serp", "sms_on",
    "twilio", "SITE", "BRAND", "KEY_SETTINGS", "make_user", "client_for", "join_org",
    "make_prompt", "answer", "failure", "FakeEngines", "fake_extract", "FakeFindRank",
    "FakeTwilio", "verified_number", "make_autopilot", "make_run", "make_result", "data",
    "error", "named_answer", "other_answer", "analysis",
]

SITE = "https://www.notion.example"
BRAND = "Notion"
KEY_SETTINGS = {
    "gpt4": "OPENAI_API_KEY", "claude": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY",
    "grok": "XAI_API_KEY", "perplexity": "PERPLEXITY_API_KEY",
}
PHONE = "+14155550123"


@pytest.fixture(autouse=True)
def autopilot_env(settings, monkeypatch):
    """Deterministic settings, no provider keys, a clean cache (quotas,
    locks, rate buckets) and no waiting."""
    cache.clear()
    settings.AUTOPILOT_ENABLED = True
    settings.AUTOPILOT_RUN_MODE = "inline"
    settings.INSIGHTS_RUN_MODE = "inline"
    settings.AUTOPILOT_MAX_ACTIVE_RUNS = 2
    settings.AUTOPILOT_PROMPT_CONCURRENCY = 3
    settings.AUTOPILOT_STEP_SECONDS = 1200
    settings.AUTOPILOT_STALE_MINUTES = 30
    settings.AUTOPILOT_RESERVE_PCT = 10
    settings.AUTOPILOT_GOOGLE_CADENCE = "weekly"
    settings.AUTOPILOT_GOOGLE_REUSE_HOURS = 20
    settings.AUTOPILOT_GOOGLE_WEEKLY_REUSE_HOURS = 164
    settings.AUTOPILOT_GOOGLE_PAGES_PER_PROJECT = 200
    settings.AUTOPILOT_GOOGLE_PAGES_PER_DAY = 1000
    settings.AUTOPILOT_GOOGLE_CONCURRENCY = 2
    settings.AUTOPILOT_ANALYSIS_WAIT_MINUTES = 15
    settings.AUTOPILOT_MIN_RANK_ANSWERS = 4
    settings.PAYWALL_ENABLED = False
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    settings.FRONTEND_URL = "https://cansee.ai"
    settings.SMS_ENABLED = False
    settings.TWILIO_ACCOUNT_SID = ""
    settings.TWILIO_AUTH_TOKEN = ""
    settings.TWILIO_FROM_NUMBER = ""
    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = ""
    settings.SERP_PROVIDER = ""
    settings.SCRAPERAPI_CREDITS_PER_SEARCH = 25
    settings.SCRAPERAPI_COST_PER_SEARCH_USD = 0.0
    settings.LLM_WEBSEARCH_ENABLED = False
    settings.CITATION_EXTRACTION_ENABLED = False
    settings.CLAIM_VERIFICATION_ENABLED = False
    for setting in KEY_SETTINGS.values():
        setattr(settings, setting, "")
    # The analysis run is faked where a test asks for it (``analysis``).
    settings.INSIGHTS_ENABLED = False
    monkeypatch.setattr(HaikuExtractionService, "extract", staticmethod(_recording_extract))
    _recording_extract.calls.clear()
    monkeypatch.setattr(pipeline, "CANCEL_POLL_SECONDS", 0.0)
    monkeypatch.setattr(pipeline, "ANALYSIS_POLL_SECONDS", 0.0)
    monkeypatch.setattr(prompt_crawler, "_dispatch_citations", lambda result_id: None)
    monkeypatch.setattr(prompt_crawler, "_dispatch_alignment", lambda result_id: None)
    from apps.brand_vault.tasks import audit_recent_results

    monkeypatch.setattr(audit_recent_results, "delay", lambda *a, **k: None)
    yield
    cache.clear()


def make_user(email: str, name: str | None = None):
    return get_user_model().objects.create_user(
        email=email, password="x" * 16, full_name=name or email.split("@")[0].title(),
        is_email_verified=True,
    )


def client_for(user=None) -> APIClient:
    client = APIClient()
    if user is not None:
        client.force_authenticate(user)
    return client


@pytest.fixture
def user(db):
    return make_user("owner@example.com", "Ifthikar")


@pytest.fixture
def website(user):
    return Website.objects.create(
        user=user, url=SITE, name=BRAND, industry="Notes", topics=["notes"],
        competitors=[{"name": "Obsidian", "domain": "obsidian.example"}],
    )


@pytest.fixture
def api(user):
    return client_for(user)


def join_org(website, owner, members: dict) -> Organization:
    """Move ``website`` into an organization with ``members`` ({user: role})."""
    org = Organization.objects.create(
        name="Notion Team", slug=f"notion-{uuid.uuid4().hex[:8]}", owner=owner,
    )
    OrganizationMember.objects.create(organization=org, user=owner, role="owner")
    for member, role in members.items():
        OrganizationMember.objects.create(organization=org, user=member, role=role)
    website.organization = org
    website.save(update_fields=["organization"])
    return org


def make_prompt(website, text: str, *, created_at=None, variants=None,
                archived: bool = False) -> BrandPrompt:
    industry, _ = Industry.objects.get_or_create(
        slug="notes-autopilot", defaults={"name": "Notes (autopilot)", "is_active": True},
    )
    prompt, _ = Prompt.objects.get_or_create(
        text_hash=text_hash(text),
        defaults={"industry": industry, "text": text, "template_text": text,
                  "intent_bucket": "category", "source": "manual"},
    )
    bp = BrandPrompt.objects.create(
        website=website, prompt=prompt, model_variants=list(variants or []),
        is_archived=archived,
    )
    if created_at is not None:
        BrandPrompt.objects.filter(id=bp.id).update(created_at=created_at)
        bp.refresh_from_db()
    return bp


def data(resp):
    body = resp.json()
    assert body.get("success") is True, body
    return body["data"]


def error(resp) -> dict:
    body = resp.json()
    assert body.get("success") is False, body
    return body["error"]


# -- engines -----------------------------------------------------------------------


def answer(text: str) -> ProviderResult:
    return ProviderResult(succeeded=True, text=text, input_tokens=1200, output_tokens=600)


def failure(error: str, *, billed: bool = False) -> ProviderResult:
    tokens = {"input_tokens": 50, "output_tokens": 10} if billed else {}
    return ProviderResult(succeeded=False, error=error, **tokens)


def named_answer() -> ProviderResult:
    return answer(f"1. {BRAND} - all in one.\n2. Obsidian - local files.")


def other_answer() -> ProviderResult:
    return answer("1. Obsidian - local files.\n2. Evernote - web clipper.")


class FakeEngines:
    """LLMProvider subclasses behind PROVIDERS: the real query() (spend wall,
    usage ledger) around a scripted ``_call``. An engine answers
    ``named_answer()`` unless scripted otherwise."""

    def __init__(self, monkeypatch, settings):
        self.monkeypatch = monkeypatch
        self.settings = settings
        self.calls: list[dict] = []
        self.scripts: dict[str, list] = {}
        self.default = named_answer

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
                call = {"provider": key, "model": self.model, "prompt": prompt,
                        "system_prompt": system_prompt}
                fakes.calls.append(call)
                queued = fakes.scripts.get(key)
                item = queued.pop(0) if queued else fakes.default()
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
    mentioned = rank is not None
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


def _recording_extract(**kwargs):
    _recording_extract.calls.append(kwargs)
    return fake_extract(**kwargs)


_recording_extract.calls = []


@pytest.fixture
def extraction():
    """The fake extraction autopilot_env installs; ``calls`` keeps the kwargs."""
    return _recording_extract


@pytest.fixture
def analysis(monkeypatch, settings):
    """The answer analysis run, faked: ``state`` sets what its estimate
    answers and the status the created run gets."""
    from apps.insights.models import InsightRun
    from apps.insights.services import runs as insights_runs

    settings.INSIGHTS_ENABLED = True
    state = {"can_run": True, "blockers": [], "usd_max": "0.0100", "status": "done",
             "calls": [], "raise": None}

    def estimate(website, user, kind, params):
        state["calls"].append(("estimate", kind, dict(params), user))
        return {
            "can_run": state["can_run"], "blockers": list(state["blockers"]),
            "ai": {"usd_max": state["usd_max"]},
            "confirm": {"ai_calls": 2, "ai_usd_max": state["usd_max"], "google_pages": 0},
        }

    def create_run(website, user, kind, params, confirm):
        state["calls"].append(("create", kind, dict(params), confirm))
        if state["raise"] is not None:
            raise state["raise"]
        return InsightRun.objects.create(
            website=website, created_by=user, kind=kind, status=state["status"],
            params=params, units_total=3,
        )

    monkeypatch.setattr(insights_runs, "estimate", estimate)
    monkeypatch.setattr(insights_runs, "create_run", create_run)
    return state


# -- Google ----------------------------------------------------------------------------


class FakeFindRank:
    """google_rank.find_rank: page one by query, ``position`` None (not in
    the top 10) unless set; ``errors`` are served first, in order."""

    def __init__(self):
        self.calls: list[dict] = []
        self.positions: dict[str, int | None] = {}
        self.errors: dict[str, list[str]] = {}

    def __call__(self, query, apex, *, max_depth=100, gl="", hl="", search=None):
        self.calls.append({"query": query, "max_depth": max_depth})
        queued = self.errors.get(query)
        if queued:
            code = queued.pop(0)
            return {"position": None, "url": "", "title": "", "top_results": [],
                    "ai_overview": {}, "ai_overview_deferred": False, "questions": [],
                    "related_searches": [], "pages_fetched": 0, "depth": 10, "error": code}
        position = self.positions.get(query)
        return {
            "position": position, "url": f"{SITE}/page" if position else "",
            "title": "Notion" if position else "", "top_results": [], "ai_overview": {},
            "ai_overview_deferred": False, "questions": [], "related_searches": [],
            "pages_fetched": 1, "depth": min(int(max_depth), 10), "error": "",
        }


@pytest.fixture
def serp(monkeypatch, settings):
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    fake = FakeFindRank()
    monkeypatch.setattr(google_rank, "find_rank", fake)
    return fake


# -- texts -------------------------------------------------------------------------------


@pytest.fixture
def sms_on(settings):
    settings.SMS_ENABLED = True
    settings.TWILIO_ACCOUNT_SID = "AC-test"
    settings.TWILIO_AUTH_TOKEN = "twilio-test-token"
    settings.TWILIO_FROM_NUMBER = "+15005550006"
    return settings


class FakeTwilio:
    """requests.post for Twilio: answers ``statuses`` in order (201 after
    them), or raises an exception put in the list."""

    def __init__(self):
        self.sent: list[dict] = []
        self.statuses: list = []

    def __call__(self, url, data=None, auth=None, timeout=None):
        self.sent.append({"url": url, "to": data["To"], "body": data["Body"]})
        item = self.statuses.pop(0) if self.statuses else 201
        if isinstance(item, Exception):
            raise item

        class Response:
            status_code = item

        return Response()


@pytest.fixture
def twilio(monkeypatch, sms_on):
    import requests

    fake = FakeTwilio()
    monkeypatch.setattr(requests, "post", fake)
    return fake


def verified_number(user, phone: str = PHONE, *, status=SmsSubscription.Status.VERIFIED,
                    consented_at=None) -> SmsSubscription:
    return SmsSubscription.objects.create(
        user=user, phone_e164=phone, phone_hash=sms_service.hash_phone(phone), status=status,
        consented_at=consented_at if consented_at is not None else (
            timezone.now() - timedelta(days=1) if status == SmsSubscription.Status.VERIFIED
            else None
        ),
    )


# -- rows -----------------------------------------------------------------------------


def make_autopilot(website, **fields) -> Autopilot:
    values = {"enabled": True, "timezone": "UTC"}
    values.update(fields)
    return Autopilot.objects.create(website=website, **values)


def make_run(website, *, local_date=None, created_at=None, **fields) -> AutopilotRun:
    values = {"status": AutopilotRun.STATUS_DONE, "stage": AutopilotRun.STAGE_FINISHED}
    values.update(fields)
    run = AutopilotRun.objects.create(
        website=website, local_date=local_date or timezone.now().date(), **values,
    )
    if created_at is not None:
        AutopilotRun.objects.filter(id=run.id).update(created_at=created_at)
        run.refresh_from_db()
    return run


def make_result(website, bp, *, provider: str = "claude", mentioned: bool = True, rank=None,
                created_at=None, succeeded: bool = True) -> LLMRankingResult:
    """One stored engine answer to a tracked prompt (as a scan stores it)."""
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=website.user, business_name=website.name,
        status=LLMRankingAudit.STATUS_COMPLETED, prompts=[bp.prompt.text],
        providers_queried=[provider],
    )
    result = LLMRankingResult.objects.create(
        audit=audit, provider=provider, model_id=f"fake-{provider}", prompt_index=0,
        prompt=bp.prompt.text, source_prompt=bp.prompt,
        response_text="answer" if succeeded else "", query_succeeded=succeeded,
        is_mentioned=mentioned, mention_rank=rank if mentioned else None,
        sentiment="positive" if mentioned else "not_mentioned",
    )
    if created_at is not None:
        LLMRankingResult.objects.filter(id=result.id).update(created_at=created_at)
        result.refresh_from_db()
    return result
