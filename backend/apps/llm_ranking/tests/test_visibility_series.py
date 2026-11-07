"""Tests for the visibility-over-time series builder.

Audits are scoped by project (every website the user can access), not by
creator, and the brand rate is the share of answered AI queries in a
bucket that mention the brand. A bucket with no answered query is a gap
(None), never a measured zero.
"""
import itertools
from datetime import datetime, timedelta

import pytest
from django.utils import timezone

from apps.accounts.tests.factories import UserFactory
from apps.llm_ranking.models import LLMRankingAudit
from apps.llm_ranking.services.visibility_series import (
    DAY_BUCKETS,
    MONTH12_BUCKETS,
    MONTH_BUCKETS,
    WEEK_BUCKETS,
    build_for_user,
    build_overview_for_website,
)
from apps.llm_ranking.tests.factories import (
    LLMRankingAuditFactory,
    LLMRankingResultFactory,
)
from apps.websites.tests.factories import WebsiteFactory

# Each (audit, prompt_index, provider, model_id, run_id) cell is unique.
_PROMPT_INDEX = itertools.count()


def _result(audit, **kwargs):
    kwargs.setdefault("prompt_index", next(_PROMPT_INDEX))
    return LLMRankingResultFactory(audit=audit, **kwargs)


def _answers(audit, *, mentioned, total):
    """Store ``total`` answered queries, ``mentioned`` of them naming the brand."""
    for i in range(total):
        _result(
            audit, query_succeeded=True, is_mentioned=i < mentioned,
            mention_rank=1 if i < mentioned else None,
        )


def _completed(website, completed_at, **kwargs):
    return LLMRankingAuditFactory(
        website=website, created_by=website.user,
        status=LLMRankingAudit.STATUS_COMPLETED,
        completed_at=completed_at, **kwargs,
    )


def _months_ago(n):
    """Noon on the first day of the month ``n`` calendar months back."""
    now = timezone.localtime()
    year, month = now.year, now.month - n
    while month < 1:
        month += 12
        year -= 1
    return timezone.make_aware(datetime(year, month, 1, 12))


@pytest.mark.django_db
class TestBuildForUser:
    def test_returns_none_when_user_has_no_completed_audits(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        # A pending audit must not flip the gate.
        LLMRankingAuditFactory(
            website=website, created_by=user, status=LLMRankingAudit.STATUS_PENDING,
        )
        assert build_for_user(user) is None

    def test_returns_all_resolutions_when_user_has_data(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        audit = _completed(website, timezone.now())
        _answers(audit, mentioned=1, total=2)
        series = build_for_user(user)
        assert set(series) == {"day", "week", "month", "month12"}
        assert len(series["day"]["labels"]) == DAY_BUCKETS
        assert len(series["week"]["labels"]) == WEEK_BUCKETS
        assert len(series["month"]["labels"]) == MONTH_BUCKETS
        assert len(series["month12"]["labels"]) == MONTH12_BUCKETS
        for res in ("day", "week", "month", "month12"):
            assert len(series[res]["brand"]) == len(series[res]["labels"])
            assert len(series[res]["competitor"]) == len(series[res]["labels"])
            assert series[res]["measured_periods"] == 1

    def test_brand_series_is_share_of_answers_mentioning_brand(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        now = timezone.now()
        # Two audits in today's bucket: 2/5 and 3/5 answers mention the
        # brand -> 5 of 10 answered queries -> 50%.
        first = _completed(website, now)
        _answers(first, mentioned=2, total=5)
        second = _completed(website, now)
        _answers(second, mentioned=3, total=5)
        # A failed query is not an answer and must not dilute the rate.
        _result(first, query_succeeded=False, is_mentioned=False, mention_rank=None)
        series = build_for_user(user)
        # Today's bucket is the last entry in the day series.
        assert series["day"]["brand"][-1] == 50.0

    def test_competitor_rate_is_share_of_answers_with_competitors(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        audit = _completed(website, timezone.now())
        _result(audit, query_succeeded=True, competitors_mentioned=[])
        _result(audit, query_succeeded=True, competitors_mentioned=["Rival"])
        _result(
            audit, query_succeeded=True,
            competitors_mentioned=[{"name": "Rival2", "position": 2}],
        )
        # Failed cell should be ignored entirely.
        _result(audit, query_succeeded=False, competitors_mentioned=["Ignored"])
        series = build_for_user(user)
        # 2 of 3 succeeded cells mention a competitor -> 66.7%
        assert series["day"]["competitor"][-1] == pytest.approx(66.7, abs=0.05)

    def test_other_tenants_audits_are_excluded(self):
        user = UserFactory()
        own_site = WebsiteFactory(user=user)
        stranger_site = WebsiteFactory()  # another account's project
        stranger_audit = _completed(stranger_site, timezone.now())
        _answers(stranger_audit, mentioned=5, total=5)
        # The user has an audit of their own so a series comes back.
        own_audit = _completed(own_site, timezone.now() - timedelta(days=3))
        _answers(own_audit, mentioned=1, total=10)
        series = build_for_user(user)
        # Today's bucket holds only the stranger's audit -> a gap, not 100%.
        assert series["day"]["brand"][-1] is None
        assert series["day"]["brand"][-4] == 10.0

    def test_unmeasured_buckets_are_gaps(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        # Only one audit, well in the past — the day series has nothing.
        audit = _completed(website, timezone.now() - timedelta(days=120))
        _answers(audit, mentioned=3, total=10)
        series = build_for_user(user)
        assert series["day"]["brand"] == [None] * DAY_BUCKETS
        assert series["day"]["competitor"] == [None] * DAY_BUCKETS
        assert series["day"]["measured_periods"] == 0


@pytest.mark.django_db
class TestBuildOverview:
    def test_empty_state(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        out = build_overview_for_website(user, website)
        assert out["has_data"] is False
        assert out["brand_current"] is None
        assert out["competitor_current"] is None
        assert out["brand_delta_pct"] is None
        assert out["measured_periods"] == 0
        assert len(out["labels"]) == MONTH12_BUCKETS
        assert out["brand"] == [None] * MONTH12_BUCKETS

    def test_headline_is_most_recent_populated_bucket(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        audit = _completed(website, timezone.now())
        _answers(audit, mentioned=3, total=5)
        out = build_overview_for_website(user, website)
        assert out["has_data"] is True
        assert out["brand_current"] == 60.0

    def test_trend_delta_uses_three_month_windows(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        # Prior 3-mo mean 10%, recent 3-mo mean 50% -> +400%.
        for months_ago, (mentioned, total) in [
            (5, (1, 10)), (4, (1, 10)), (3, (1, 10)),
            (2, (1, 2)), (1, (1, 2)), (0, (1, 2)),
        ]:
            audit = _completed(website, _months_ago(months_ago))
            _answers(audit, mentioned=mentioned, total=total)
        out = build_overview_for_website(user, website)
        assert out["brand_delta_pct"] == pytest.approx(400.0, abs=1.0)
        assert out["brand_current"] == 50.0
        assert out["measured_periods"] == 6

    def test_per_competitor_breakdown_ranks_by_total_mentions(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        audit = _completed(website, timezone.now())
        # Four successful answers: Mixpanel in 3, Amplitude in 2, Heap in 1.
        # Expected rates: Mixpanel 75%, Amplitude 50%, Heap 25%.
        _result(
            audit, query_succeeded=True,
            competitors_mentioned=[{"name": "Mixpanel"}, {"name": "Amplitude"}],
        )
        _result(audit, query_succeeded=True, competitors_mentioned=["Mixpanel", "Heap"])
        _result(audit, query_succeeded=True, competitors_mentioned=["Mixpanel", "Amplitude"])
        _result(audit, query_succeeded=True, competitors_mentioned=[])

        out = build_overview_for_website(user, website)
        names = [c["name"] for c in out["competitors"]]
        assert names[:3] == ["Mixpanel", "Amplitude", "Heap"]

        # Per-competitor current (last populated bucket) reflects the rates.
        by_name = {c["name"]: c for c in out["competitors"]}
        assert by_name["Mixpanel"]["current"] == 75.0
        assert by_name["Amplitude"]["current"] == 50.0
        assert by_name["Heap"]["current"] == 25.0

        # Competitor avg = mean across the three rates = 50.0.
        assert out["competitor_current"] == 50.0

    def test_competitor_names_are_deduped_case_insensitively(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        audit = _completed(website, timezone.now())
        # Same answer names "Mixpanel" twice in different casings — should
        # only count once.
        _result(audit, query_succeeded=True, competitors_mentioned=["Mixpanel", "mixpanel"])
        _result(audit, query_succeeded=True, competitors_mentioned=[])
        out = build_overview_for_website(user, website)
        # One competitor, mentioned in 1 of 2 answers -> 50%.
        assert len(out["competitors"]) == 1
        assert out["competitors"][0]["current"] == 50.0

    def test_empty_state_returns_empty_competitor_list(self):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        out = build_overview_for_website(user, website)
        assert out["competitors"] == []
        assert out["competitor_current"] is None
