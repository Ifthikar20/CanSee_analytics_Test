"""Starting a prompt run is claimed once.

Run, Run now and the scan task used to read the status and act on it in
separate steps, so a double click, two tabs or a redelivered task ran the
whole scan twice: enrichment again and every prompt x engine cell billed
twice.
"""
from unittest.mock import patch

import pytest
from celery.exceptions import Retry
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingSchedule
from apps.llm_ranking.services.ranking_service import LLMRankingService
from apps.llm_ranking.tests.factories import LLMRankingAuditFactory, LLMRankingResultFactory
from apps.prompt_library.models import BrandPrompt
from apps.prompt_library.tests.factories import PromptFactory
from apps.websites.tests.factories import WebsiteFactory
from core.views import TenantScopedAPIView

DISPATCH = "apps.llm_ranking.services.scan_dispatch.dispatch_scan"
ENRICH = "apps.llm_ranking.services.content_enricher.ContentEnricher.enrich"


@pytest.fixture(autouse=True)
def engine(settings):
    settings.ANTHROPIC_API_KEY = "test-key"


@pytest.fixture
def auth_client():
    user = UserFactory()
    website = WebsiteFactory(user=user)
    client = APIClient()
    client.force_authenticate(user=user)
    return client, user, website


def _audit(website, user, **kwargs):
    kwargs.setdefault("prompts", [{"text": "best crm for a small team", "type": "custom"}])
    kwargs.setdefault("providers_queried", ["claude"])
    return LLMRankingAuditFactory(website=website, created_by=user, **kwargs)


def _run(client, audit):
    return client.post(f"/api/v1/llm-ranking/{audit.website_id}/audits/{audit.id}/run/")


@pytest.mark.django_db
class TestRunView:
    def test_second_run_request_is_refused_and_not_dispatched(self, auth_client):
        client, user, website = auth_client
        audit = _audit(website, user)
        with patch(DISPATCH) as dispatch:
            first = _run(client, audit)
            second = _run(client, audit)
        assert first.status_code == 202
        assert second.status_code == 400
        dispatch.assert_called_once_with(str(audit.id))
        audit.refresh_from_db()
        assert audit.status == LLMRankingAudit.STATUS_RUNNING
        # The scan task claims preparation by setting started_at.
        assert audit.started_at is None

    def test_overlapping_request_with_a_stale_read_is_refused(self, auth_client):
        # The second request read the audit while it was still pending; the
        # first has since claimed it. The claim re-reads the row under a
        # lock, so the stale read cannot dispatch a second scan.
        client, user, website = auth_client
        audit = _audit(website, user)
        stale = LLMRankingAudit.objects.get(id=audit.id)
        LLMRankingAudit.objects.filter(id=audit.id).update(status=LLMRankingAudit.STATUS_RUNNING)
        with patch.object(TenantScopedAPIView, "get_tenant_object", return_value=stale), \
                patch(DISPATCH) as dispatch:
            response = _run(client, audit)
        assert response.status_code == 400
        dispatch.assert_not_called()

    def test_failed_audit_rerun_clears_results_and_claim(self, auth_client):
        client, user, website = auth_client
        audit = _audit(
            website, user, status=LLMRankingAudit.STATUS_FAILED,
            overall_score=40, error_message="boom", started_at=timezone.now(),
        )
        LLMRankingResultFactory(audit=audit, provider="claude")
        with patch(DISPATCH) as dispatch:
            response = _run(client, audit)
        assert response.status_code == 202
        dispatch.assert_called_once()
        audit.refresh_from_db()
        assert audit.results.count() == 0
        assert audit.overall_score is None
        assert audit.error_message == ""
        assert audit.started_at is None


@pytest.mark.django_db
class TestPrepareAudit:
    def test_second_prepare_is_a_no_op(self, auth_client):
        _client, user, website = auth_client
        audit = _audit(website, user)
        with patch(ENRICH, return_value={"llm_context": ""}) as enrich:
            first = LLMRankingService.prepare_audit(audit_id=str(audit.id))
            second = LLMRankingService.prepare_audit(audit_id=str(audit.id))
        assert first is not None
        assert second is None
        enrich.assert_called_once()
        audit.refresh_from_db()
        assert audit.status == LLMRankingAudit.STATUS_RUNNING
        assert audit.started_at is not None

    def test_prepare_after_the_run_view_claimed_it(self, auth_client):
        client, user, website = auth_client
        audit = _audit(website, user)
        with patch(DISPATCH):
            assert _run(client, audit).status_code == 202
        with patch(ENRICH, return_value={"llm_context": ""}):
            assert LLMRankingService.prepare_audit(audit_id=str(audit.id)) is not None

    @pytest.mark.parametrize("status", [
        LLMRankingAudit.STATUS_COMPLETED, LLMRankingAudit.STATUS_FAILED,
    ])
    def test_finished_audit_is_not_prepared(self, auth_client, status):
        _client, user, website = auth_client
        audit = _audit(website, user, status=status)
        with patch(ENRICH) as enrich:
            assert LLMRankingService.prepare_audit(audit_id=str(audit.id)) is None
        enrich.assert_not_called()
        audit.refresh_from_db()
        assert audit.status == status

    def test_missing_audit(self):
        import uuid
        assert LLMRankingService.prepare_audit(audit_id=str(uuid.uuid4())) is None


@pytest.mark.django_db
class TestScanTaskRetry:
    def test_retry_releases_the_claim_and_the_last_attempt_fails(self, auth_client):
        from apps.llm_ranking.tasks import run_llm_ranking_audit

        _client, user, website = auth_client
        audit = _audit(website, user)
        seen = []

        def prepare(*, audit_id):
            row = LLMRankingAudit.objects.get(id=audit_id)
            seen.append((row.status, row.started_at))
            LLMRankingAudit.objects.filter(id=audit_id).update(
                status=LLMRankingAudit.STATUS_RUNNING, started_at=timezone.now(),
            )
            raise RuntimeError("enrichment exploded")

        kwargs = {"audit_id": str(audit.id)}
        with patch.object(LLMRankingService, "prepare_audit", side_effect=prepare):
            # First attempt: a retry is scheduled and the claim released.
            with pytest.raises(Retry):
                run_llm_ranking_audit.apply(kwargs=kwargs, retries=0)
            audit.refresh_from_db()
            assert audit.status == LLMRankingAudit.STATUS_PENDING
            assert audit.started_at is None
            # The retry is the last attempt: the audit fails for good.
            with pytest.raises(RuntimeError):
                run_llm_ranking_audit.apply(kwargs=kwargs, retries=1)
        # Each attempt found the audit pending and unclaimed, so it could
        # prepare it again.
        assert seen == [(LLMRankingAudit.STATUS_PENDING, None)] * 2
        audit.refresh_from_db()
        assert audit.status == LLMRankingAudit.STATUS_FAILED
        assert "enrichment exploded" in audit.error_message


@pytest.mark.django_db
class TestScheduleRunNow:
    def _schedule(self, user, website, last_audit=None):
        return LLMRankingSchedule.objects.create(
            website=website, created_by=user, is_enabled=True,
            frequency="weekly", business_name="Biz", industry="SaaS",
            next_run_at=timezone.now(), last_audit=last_audit,
        )

    def test_stale_read_cannot_start_a_second_run(self, auth_client):
        client, user, website = auth_client
        BrandPrompt.objects.create(website=website, prompt=PromptFactory(text="best crm?"))
        schedule = self._schedule(user, website)
        in_flight = _audit(website, user, status=LLMRankingAudit.STATUS_RUNNING)

        # The request read the schedule before another request set its
        # last_audit to the run now in flight.
        stale = LLMRankingSchedule.objects.select_related("website", "last_audit").get(
            id=schedule.id,
        )
        LLMRankingSchedule.objects.filter(id=schedule.id).update(last_audit=in_flight)

        class _Stale:
            def select_related(self, *args):
                return self

            def get(self, **kwargs):
                return stale

        with patch.object(LLMRankingSchedule.objects, "select_related", return_value=_Stale()), \
                patch("apps.llm_ranking.tasks.run_llm_ranking_audit.delay") as delay:
            response = client.post(f"/api/v1/llm-ranking/{website.id}/schedule/run-now/")
        assert response.status_code == 409
        assert response.json()["audit_id"] == str(in_flight.id)
        delay.assert_not_called()
        assert LLMRankingAudit.objects.filter(website=website).count() == 1
