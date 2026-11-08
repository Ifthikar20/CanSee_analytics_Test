"""The ranking history endpoint reads a bounded number of audits.

Each per-prompt crawl completes its own audit, so the unbounded version
grew by one audit per scheduled prompt per day and loaded every result.
"""
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.llm_ranking.api.v1.views import LLMRankingHistoryView
from apps.llm_ranking.models import LLMRankingAudit
from apps.llm_ranking.tests.factories import LLMRankingAuditFactory, LLMRankingResultFactory
from apps.websites.tests.factories import WebsiteFactory


@pytest.fixture
def setup():
    user = UserFactory()
    website = WebsiteFactory(user=user)
    client = APIClient()
    client.force_authenticate(user=user)
    now = timezone.now()
    audits = [
        LLMRankingAuditFactory(
            website=website, created_by=user, status=LLMRankingAudit.STATUS_COMPLETED,
            overall_score=10 * (i + 1), completed_at=now - timedelta(days=5 - i),
        )
        for i in range(5)
    ]
    return client, website, audits


def _history(client, website, **params):
    response = client.get(f"/api/v1/llm-ranking/{website.id}/history/", params)
    assert response.status_code == 200
    return response.json()["data"]


@pytest.mark.django_db
def test_limit_keeps_the_latest_audits_oldest_first(setup):
    client, website, audits = setup
    data = _history(client, website, limit=2)
    assert [row["id"] for row in data] == [str(audits[3].id), str(audits[4].id)]


@pytest.mark.django_db
def test_default_and_maximum_bounds(setup, monkeypatch):
    client, website, audits = setup
    monkeypatch.setattr(LLMRankingHistoryView, "DEFAULT_LIMIT", 3)
    monkeypatch.setattr(LLMRankingHistoryView, "MAX_LIMIT", 4)
    assert len(_history(client, website)) == 3
    assert len(_history(client, website, limit=1000)) == 4
    assert len(_history(client, website, limit="not-a-number")) == 3
    assert len(_history(client, website, limit=0)) == 1


@pytest.mark.django_db
def test_citation_share_is_set_on_each_audit(setup):
    client, website, audits = setup
    LLMRankingResultFactory(
        audit=audits[4], provider="claude", prompt_index=0, is_mentioned=True,
        competitors_mentioned=[{"name": "Rival", "position": 2}],
    )
    data = _history(client, website)
    by_id = {row["id"]: row for row in data}
    latest = by_id[str(audits[4].id)]
    assert latest["citation_self"] == 1
    assert latest["citation_total"] == 2
    assert latest["citation_share"] == 50.0
    untouched = by_id[str(audits[0].id)]
    assert untouched["citation_share"] is None
    assert untouched["citation_total"] == 0
