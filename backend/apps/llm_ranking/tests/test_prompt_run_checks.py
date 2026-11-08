"""Audits ask each prompt of each engine: one prompt run per cell. An
audit, a re-run of a failed one and a scheduled audit are refused (or
skipped) before anything is asked when the runs are not left, and deleting
an audit never hands its prompts back to the monthly prompt allowance."""
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.billing.services.org_entitlements import prompts_used_this_month
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingSchedule
from apps.llm_ranking.services.audit_factory import create_audit
from apps.metering.tests.prompt_run_support import use_runs
from apps.websites.models import Website
from core.exceptions import CanseeException

pytestmark = pytest.mark.django_db


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Site Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://northwind.example", name="Northwind")


@pytest.fixture
def api(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def keys(settings):
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    for name in ("GEMINI_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY"):
        setattr(settings, name, "")
    return settings


def _error(resp) -> dict:
    body = resp.json()
    return body["error"] if isinstance(body.get("error"), dict) else body


def test_an_audit_needs_a_run_per_prompt_and_engine(user, website, keys):
    use_runs(user, 15, website)
    with pytest.raises(CanseeException) as caught:
        create_audit(website=website, user=user, prompts=["a", "b", "c"])
    assert (caught.value.code, caught.value.status_code) == ("insufficient_prompt_runs", 403)
    assert (caught.value.details["needed"], caught.value.details["remaining"]) == (6, 5)
    assert not LLMRankingAudit.objects.exists()
    # Fewer engines fit.
    audit = create_audit(website=website, user=user, prompts=["a", "b", "c"], providers=["gpt4"])
    assert audit.providers_queried == ["gpt4"]


def test_a_re_run_of_a_failed_audit_needs_its_runs(api, user, website, keys):
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=user, business_name="Northwind", prompts=["a", "b"],
        providers_queried=["gpt4", "claude"], status=LLMRankingAudit.STATUS_FAILED,
    )
    use_runs(user, 17, website)
    url = reverse("llm-ranking-run", kwargs={"website_id": website.id, "audit_id": audit.id})
    with patch("apps.llm_ranking.services.scan_dispatch.dispatch_scan") as dispatch:
        resp = api.post(url)
    assert resp.status_code == 403
    assert _error(resp)["code"] == "insufficient_prompt_runs"
    dispatch.assert_not_called()
    audit.refresh_from_db()
    assert audit.status == LLMRankingAudit.STATUS_FAILED


def test_deleting_an_audit_keeps_its_prompts_spent(api, user, website):
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=user, business_name="Northwind", prompts=["a", "b", "c"],
        providers_queried=["gpt4"],
    )
    assert prompts_used_this_month(user) == 3
    url = reverse("llm-ranking-detail", kwargs={"website_id": website.id, "audit_id": audit.id})
    assert api.delete(url).status_code == 204
    assert not LLMRankingAudit.objects.exists()
    assert prompts_used_this_month(user) == 3


def test_deleting_last_months_audit_changes_nothing(api, user, website):
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=user, business_name="Northwind", prompts=["a"],
        providers_queried=["gpt4"],
    )
    LLMRankingAudit.objects.filter(id=audit.id).update(
        created_at=timezone.now() - timedelta(days=40))
    url = reverse("llm-ranking-detail", kwargs={"website_id": website.id, "audit_id": audit.id})
    api.delete(url)
    assert prompts_used_this_month(user) == 0


def test_a_scheduled_audit_is_skipped_with_no_run_left(user, website, keys):
    from apps.llm_ranking.tasks import dispatch_scheduled_audits

    schedule = LLMRankingSchedule.objects.create(
        website=website, created_by=user, business_name="Northwind", industry="CRM",
        next_run_at=timezone.now() - timedelta(minutes=1),
    )
    use_runs(user, 20, website)
    with patch("apps.llm_ranking.services.audit_runner.gather_saved_prompts",
               return_value=["best crm"]), \
            patch("apps.llm_ranking.tasks.run_llm_ranking_audit.delay") as run:
        dispatch_scheduled_audits()
    run.assert_not_called()
    assert not LLMRankingAudit.objects.exists()
    schedule.refresh_from_db()
    assert schedule.next_run_at > timezone.now()
    assert schedule.consecutive_failures == 0
