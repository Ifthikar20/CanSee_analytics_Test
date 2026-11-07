"""Fixtures and helpers shared by the billing suites (tests only).

Import what a module needs: ``from apps.billing.tests.support import *``.
Nothing here leaves the process: Polar is never configured with a real
token and every polar_client call a test makes is replaced by a fake.
"""
from __future__ import annotations

import itertools
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.billing.models import Subscription
from apps.prompt_library.models import BrandPrompt, Industry, Prompt
from apps.prompt_library.services._hash import text_hash
from apps.websites.models import Website
from core.utils.constants import Plan, SubscriptionStatus

__all__ = [
    "billing_env", "paywall", "make_user", "user", "api", "client_for", "data", "error",
    "make_website", "website", "make_prompt", "track", "subscribe", "org_with", "fresh",
    "FakePolar", "polar", "polar_ready", "Plan", "SubscriptionStatus",
]

_counter = itertools.count(1)


@pytest.fixture(autouse=True)
def billing_env(settings):
    """No Polar, no engines, no Google and no texts unless a test opts in."""
    cache.clear()
    settings.PAYWALL_ENABLED = False
    settings.POLAR_ACCESS_TOKEN = ""
    settings.POLAR_PRODUCT_PRO_MONTHLY_ID = ""
    settings.POLAR_PRODUCT_PRO_ANNUAL_ID = ""
    settings.POLAR_PRODUCT_PROMPTS_100_ID = ""
    settings.POLAR_PRODUCT_PROMPTS_200_ID = ""
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY",
                "PERPLEXITY_API_KEY", "SERPAPI_KEY", "SCRAPERAPI_KEY", "SERP_PROVIDER"):
        setattr(settings, key, "")
    settings.SMS_ENABLED = False
    settings.LLM_WEBSEARCH_ENABLED = False
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    yield
    cache.clear()


@pytest.fixture
def paywall(settings):
    settings.PAYWALL_ENABLED = True
    return settings


@pytest.fixture
def make_user(db):
    def _make(**fields):
        n = next(_counter)
        return get_user_model().objects.create_user(
            email=f"user{n}@example.com", password="x" * 16, full_name=f"User {n}",
            is_email_verified=True, **fields,
        )

    return _make


@pytest.fixture
def user(make_user):
    return make_user()


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


def make_website(owner, *, organization=None, name="Northwind CRM") -> Website:
    n = next(_counter)
    return Website.objects.create(
        user=owner, organization=organization, url=f"https://site-{n}.example",
        name=name, industry="CRM software",
    )


@pytest.fixture
def website(user):
    return make_website(user)


def make_prompt(text: str) -> Prompt:
    industry, _ = Industry.objects.get_or_create(
        slug="crm-billing-tests", defaults={"name": "CRM (billing tests)", "is_active": True},
    )
    return Prompt.objects.create(
        industry=industry, text=text, template_text=text, intent_bucket="category",
        source="manual", text_hash=text_hash(text),
    )


def track(website, count: int, *, archived: bool = False, start=None) -> list[BrandPrompt]:
    """``count`` brand prompts on ``website``, oldest first: created_at one
    microsecond apart from ``start`` (or from a day ago, so later calls are
    newer)."""
    base = start or timezone.now() - timedelta(days=1)
    rows = []
    for i in range(count):
        n = next(_counter)
        bp = BrandPrompt.objects.create(
            website=website, prompt=make_prompt(f"best crm question number {n}"),
            is_archived=archived,
        )
        BrandPrompt.objects.filter(id=bp.id).update(created_at=base + timedelta(microseconds=i))
        bp.refresh_from_db()
        rows.append(bp)
    return rows


def subscribe(user, plan=Plan.PROMPTS_100, status=SubscriptionStatus.ACTIVE, **fields) -> Subscription:
    sub, _ = Subscription.objects.update_or_create(
        user=user, defaults={"plan": plan, "status": status, **fields},
    )
    return sub


def org_with(owner, *members, plan=Plan.BUSINESS) -> Organization:
    org = Organization.objects.create(
        name="Acme", slug=f"acme-{next(_counter)}", owner=owner, plan=plan,
    )
    OrganizationMember.objects.create(organization=org, user=owner, role="owner")
    for member in members:
        OrganizationMember.objects.create(organization=org, user=member, role="member")
    return org


def fresh(user):
    """Reload so cached org and subscription lookups do not leak between asserts."""
    return type(user).objects.get(pk=user.pk)


class FakePolar:
    """Records polar_client calls; the customer state lists what the test sets."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.subscriptions: list = []

    def update_subscription_plan(self, subscription_id, **kwargs):
        self.calls.append(("update_subscription_plan", subscription_id, kwargs))
        for sub in self.subscriptions:
            if sub.id == subscription_id and kwargs.get("product_id"):
                sub.product_id = kwargs["product_id"]

    def get_customer_state(self, external_id):
        self.calls.append(("get_customer_state", external_id))
        return SimpleNamespace(active_subscriptions=[
            s for s in self.subscriptions if s.customer.external_id == str(external_id)
        ])

    def get_subscription(self, subscription_id):
        self.calls.append(("get_subscription", subscription_id))
        return next(s for s in self.subscriptions if s.id == subscription_id)

    def create_checkout(self, **kwargs):
        self.calls.append(("create_checkout", kwargs))
        return SimpleNamespace(id="chk_1", url="https://sandbox.polar.sh/checkout/chk_1")

    def polar_subscription(self, sub_id, product_id, *, owner, status="active"):
        sub = SimpleNamespace(
            id=sub_id, product_id=product_id, status=status, started_at=timezone.now(),
            current_period_start=timezone.now(), cancel_at_period_end=False,
            current_period_end=timezone.now() + timedelta(days=30),
            recurring_interval="month", customer=SimpleNamespace(external_id=str(owner.id)),
        )
        self.subscriptions.append(sub)
        return sub


@pytest.fixture
def polar(monkeypatch):
    from apps.metering import polar_client

    fake = FakePolar()
    for name in ("update_subscription_plan", "get_customer_state", "get_subscription",
                 "create_checkout"):
        monkeypatch.setattr(polar_client, name, getattr(fake, name))
    return fake


@pytest.fixture
def polar_ready(settings, polar):
    """A Polar token and both plan products (no Pro products); every
    polar_client call goes to the fake."""
    settings.POLAR_ACCESS_TOKEN = "polar_test_token"
    settings.POLAR_PRODUCT_PROMPTS_100_ID = "prod_100"
    settings.POLAR_PRODUCT_PROMPTS_200_ID = "prod_200"
    return settings
