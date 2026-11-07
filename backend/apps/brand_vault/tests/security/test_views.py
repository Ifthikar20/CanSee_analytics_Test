"""API contract tests for the /api/v1/brand-security/ endpoints."""
from __future__ import annotations

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.brand_vault.models import BrandSecurityConfig, SafetyAlert
from apps.websites.tests.factories import WebsiteFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def auth():
    user = UserFactory()
    client = APIClient()
    client.force_authenticate(user=user)
    return client, user


def _make_alert(website, **kwargs):
    defaults = dict(
        website=website,
        agent_id="llm_truth",
        source=SafetyAlert.SOURCE_LLM,
        title="Is Acme legit?",
        snippet="Acme is a scam.",
        issue=SafetyAlert.ISSUE_HALLUCINATION,
        severity=SafetyAlert.SEVERITY_HIGH,
        model="claude",
        prompt_text="Is Acme legit?",
    )
    defaults.update(kwargs)
    return SafetyAlert.objects.create(**defaults)


class TestOverview:
    def test_requires_auth(self):
        website = WebsiteFactory()
        url = reverse("brand-security-overview", args=[website.id])
        assert APIClient().get(url).status_code == 401

    def test_returns_health_and_counters(self, auth):
        client, user = auth
        website = WebsiteFactory(user=user)
        _make_alert(website, severity="high")
        _make_alert(website, severity="medium",
                    agent_id="serp_reputation", source=SafetyAlert.SOURCE_SERP)

        resp = client.get(reverse("brand-security-overview", args=[website.id]))
        assert resp.status_code == 200
        body = resp.data
        # A finding exists, so stored answers have been checked.
        assert body["scan_status"] == "scanned"
        assert body["open_alerts"] == 2
        assert body["by_severity"]["high"] == 1
        assert body["by_severity"]["medium"] == 1
        # Health = 100 - (10*1 + 4*1) = 86
        assert body["health_score"] == 86
        assert body["by_source"] == {
            SafetyAlert.SOURCE_LLM: 1, SafetyAlert.SOURCE_SERP: 1,
        }

    def test_health_is_null_until_answers_are_checked(self, auth):
        # No audit, no sweep and no finding yet: no score, not a clean 100.
        client, user = auth
        website = WebsiteFactory(user=user)
        resp = client.get(reverse("brand-security-overview", args=[website.id]))
        assert resp.status_code == 200
        assert resp.data["health_score"] is None
        assert resp.data["scan_status"] == "not_scanned"
        assert resp.data["open_alerts"] == 0


class TestAlerts:
    def test_filter_by_agent(self, auth):
        client, user = auth
        website = WebsiteFactory(user=user)
        _make_alert(website, agent_id="llm_truth")
        _make_alert(website, agent_id="serp_reputation",
                    source=SafetyAlert.SOURCE_SERP, title="X")
        url = reverse("brand-security-alerts", args=[website.id])
        resp = client.get(f"{url}?agent_id=llm_truth")
        results = resp.data.get("results", resp.data)
        assert len(results) == 1
        assert results[0]["agent_id"] == "llm_truth"

    def test_resolve_marks_alert(self, auth):
        client, user = auth
        website = WebsiteFactory(user=user)
        alert = _make_alert(website)
        url = reverse(
            "brand-security-alert-action",
            kwargs={"alert_id": alert.id, "action": "resolve"},
        )
        resp = client.post(url)
        assert resp.status_code == 200
        alert.refresh_from_db()
        assert alert.status == SafetyAlert.STATUS_RESOLVED
        assert alert.resolved_by_id == user.id


class TestConfig:
    def test_get_creates_config_lazily(self, auth):
        client, user = auth
        website = WebsiteFactory(user=user)
        url = reverse("brand-security-config", args=[website.id])
        resp = client.get(url)
        assert resp.status_code == 200
        assert BrandSecurityConfig.objects.filter(website=website).exists()

    def test_put_writes_terms(self, auth):
        client, user = auth
        website = WebsiteFactory(user=user)
        url = reverse("brand-security-config", args=[website.id])
        resp = client.put(
            url,
            {"brand_terms": ["Acme", "acme.io"], "llm_judge_enabled": False},
            format="json",
        )
        assert resp.status_code == 200
        cfg = BrandSecurityConfig.objects.get(website=website)
        assert cfg.brand_terms == ["Acme", "acme.io"]
        assert cfg.llm_judge_enabled is False
