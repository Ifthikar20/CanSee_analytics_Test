"""Tests for LLM Ranking service logic."""
import itertools
from unittest.mock import patch

import pytest

from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.llm_ranking.services.ranking_service import SCORE_FIELDS, LLMRankingService
from apps.llm_ranking.tests.factories import LLMRankingAuditFactory, LLMRankingResultFactory

# Each (audit, prompt_index, provider, model_id, run_id) cell is unique.
_PROMPT_INDEX = itertools.count()


def _result(audit, **kwargs):
    kwargs.setdefault("prompt_index", next(_PROMPT_INDEX))
    return LLMRankingResultFactory(audit=audit, **kwargs)

# ── Mention analysis ──────────────────────────────────────────────────────────

class TestAnalyzeMention:
    def test_detects_mention_by_business_name(self):
        result = LLMRankingService._analyze_mention(
            response_text="We recommend Acme SaaS for its great dashboard.",
            business_name="Acme SaaS",
            keywords=[],
        )
        assert result["is_mentioned"] is True

    def test_detects_mention_by_keyword(self):
        result = LLMRankingService._analyze_mention(
            response_text="The best analytics tool on the market is...",
            business_name="Acme SaaS",
            keywords=["analytics"],
        )
        assert result["is_mentioned"] is True

    def test_no_mention(self):
        result = LLMRankingService._analyze_mention(
            response_text="We recommend Competitor X and Competitor Y.",
            business_name="Acme SaaS",
            keywords=["acme"],
        )
        assert result["is_mentioned"] is False
        assert result["sentiment"] == "not_mentioned"
        assert result["mention_rank"] is None

    def test_detects_rank_from_numbered_list(self):
        response = (
            "1. Competitor X — fast\n"
            "2. Acme SaaS — great analytics\n"
            "3. Competitor Y — cheap\n"
        )
        result = LLMRankingService._analyze_mention(
            response_text=response,
            business_name="Acme SaaS",
            keywords=[],
        )
        assert result["is_mentioned"] is True
        assert result["mention_rank"] == 2

    def test_detects_rank_position_one(self):
        response = "1. Acme SaaS — top pick\n2. Others"
        result = LLMRankingService._analyze_mention(
            response_text=response,
            business_name="Acme SaaS",
            keywords=[],
        )
        assert result["mention_rank"] == 1

    def test_positive_sentiment_detected(self):
        result = LLMRankingService._analyze_mention(
            response_text="Acme SaaS is the best and most recommended tool.",
            business_name="Acme SaaS",
            keywords=[],
        )
        assert result["sentiment"] == "positive"

    def test_negative_sentiment_detected(self):
        result = LLMRankingService._analyze_mention(
            response_text="Acme SaaS is expensive and difficult to use.",
            business_name="Acme SaaS",
            keywords=[],
        )
        assert result["sentiment"] == "negative"

    def test_case_insensitive_match(self):
        result = LLMRankingService._analyze_mention(
            response_text="ACME SAAS is popular.",
            business_name="Acme SaaS",
            keywords=[],
        )
        assert result["is_mentioned"] is True


# ── Score computation ─────────────────────────────────────────────────────────

@pytest.mark.django_db
class TestComputeOverallScore:
    def test_empty_results_returns_none(self):
        # No answered query: nothing was measured, so no score is invented.
        scores = LLMRankingService.compute_overall_score([])
        assert scores == dict.fromkeys(SCORE_FIELDS)
        assert scores["overall_score"] is None
        assert scores["mention_rate"] is None

    def test_all_mentioned_rank_1_gives_high_score(self):
        audit = LLMRankingAuditFactory()
        results = [
            LLMRankingResultFactory(
                audit=audit,
                provider=p,
                is_mentioned=True,
                mention_rank=1,
                sentiment=LLMRankingResult.SENTIMENT_POSITIVE,
                query_succeeded=True,
            )
            for p in ["claude", "gpt4", "gemini"]
        ]
        scores = LLMRankingService.compute_overall_score(results)
        assert scores["overall_score"] >= 70
        assert scores["mention_rate"] == 100.0

    def test_no_mentions_gives_low_score(self):
        audit = LLMRankingAuditFactory()
        results = [
            LLMRankingResultFactory(
                audit=audit,
                provider="claude",
                is_mentioned=False,
                mention_rank=None,
                sentiment=LLMRankingResult.SENTIMENT_NOT_MENTIONED,
                query_succeeded=True,
            )
        ]
        scores = LLMRankingService.compute_overall_score(results)
        assert scores["overall_score"] < 20
        assert scores["mention_rate"] == 0.0

    def test_failed_queries_excluded_from_mention_rate(self):
        audit = LLMRankingAuditFactory()
        results = [
            LLMRankingResultFactory(audit=audit, provider="claude", query_succeeded=False),
            LLMRankingResultFactory(
                audit=audit, provider="gpt4",
                is_mentioned=True, query_succeeded=True, mention_rank=1,
                sentiment=LLMRankingResult.SENTIMENT_POSITIVE,
            ),
        ]
        scores = LLMRankingService.compute_overall_score(results)
        # Only 1 succeeded, 1 mentioned → 100% mention rate for succeeded
        assert scores["mention_rate"] == 100.0

    def test_score_capped_at_100(self):
        audit = LLMRankingAuditFactory()
        results = [
            LLMRankingResultFactory(
                audit=audit, provider=p,
                is_mentioned=True, mention_rank=1,
                sentiment=LLMRankingResult.SENTIMENT_POSITIVE,
                query_succeeded=True,
            )
            for p in ["claude", "gpt4", "gemini", "perplexity"]
        ]
        scores = LLMRankingService.compute_overall_score(results)
        assert scores["overall_score"] <= 100


# ── Recommendations ───────────────────────────────────────────────────────────

@pytest.mark.django_db
class TestRecommendations:
    # Recommendations are derived from the run's answers; an audit with no
    # results gets the "start a prompt run" placeholder instead.

    def test_no_results_asks_for_a_prompt_run(self):
        audit = LLMRankingAuditFactory(
            status=LLMRankingAudit.STATUS_COMPLETED,
            overall_score=15,
            mention_rate=10.0,
        )
        recs = LLMRankingService.generate_recommendations(audit=audit)
        assert recs == ["Start a prompt run to see recommendations."]

    def test_low_score_gives_content_recommendation(self):
        audit = LLMRankingAuditFactory(
            status=LLMRankingAudit.STATUS_COMPLETED,
            overall_score=15,
            mention_rate=10.0,
            avg_mention_rank=0.0,
        )
        _result(
            audit, query_succeeded=True, is_mentioned=False, mention_rank=None,
            sentiment=LLMRankingResult.SENTIMENT_NOT_MENTIONED,
        )
        recs = LLMRankingService.generate_recommendations(audit=audit)
        assert len(recs) >= 1
        combined = " ".join(recs).lower()
        assert "content" in combined or "mentioned" in combined or "publish" in combined

    def test_high_score_gives_maintenance_recommendation(self):
        audit = LLMRankingAuditFactory(
            status=LLMRankingAudit.STATUS_COMPLETED,
            overall_score=80,
            mention_rate=85.0,
            avg_mention_rank=1.5,
        )
        _result(
            audit, query_succeeded=True, is_mentioned=True, mention_rank=1,
            sentiment=LLMRankingResult.SENTIMENT_POSITIVE,
        )
        recs = LLMRankingService.generate_recommendations(audit=audit)
        combined = " ".join(recs).lower()
        assert "maintain" in combined or "strong" in combined or "content" in combined

    def test_high_rank_gives_position_recommendation(self):
        audit = LLMRankingAuditFactory(
            status=LLMRankingAudit.STATUS_COMPLETED,
            overall_score=50,
            mention_rate=70.0,
            avg_mention_rank=7.0,
        )
        _result(
            audit, query_succeeded=True, is_mentioned=True, mention_rank=7,
            sentiment=LLMRankingResult.SENTIMENT_POSITIVE,
        )
        recs = LLMRankingService.generate_recommendations(audit=audit)
        combined = " ".join(recs).lower()
        assert "rank" in combined or "position" in combined or "authority" in combined


# ── Wilson CI helper ──────────────────────────────────────────────────────────

class TestWilsonCI:
    def test_zero_sample_returns_zeros(self):
        from apps.llm_ranking.services.ranking_service import wilson_ci
        lower, upper = wilson_ci(0, 0)
        assert lower == 0.0
        assert upper == 0.0

    def test_all_successes_has_upper_at_one(self):
        from apps.llm_ranking.services.ranking_service import wilson_ci
        lower, upper = wilson_ci(10, 10)
        assert upper == 1.0
        assert lower < 1.0  # Wilson keeps lower away from 1 even for perfect success

    def test_all_failures_has_lower_at_zero(self):
        from apps.llm_ranking.services.ranking_service import wilson_ci
        lower, upper = wilson_ci(0, 10)
        assert lower == 0.0
        assert upper > 0.0

    def test_small_sample_wider_than_large_sample(self):
        from apps.llm_ranking.services.ranking_service import wilson_ci
        l_small, u_small = wilson_ci(3, 10)
        l_large, u_large = wilson_ci(300, 1000)
        # Both point estimates equal 0.3, but CI shrinks as N grows.
        assert (u_small - l_small) > (u_large - l_large)

    def test_half_proportion_centres_around_half(self):
        from apps.llm_ranking.services.ranking_service import wilson_ci
        lower, upper = wilson_ci(50, 100)
        # Expected Wilson CI on 50/100 is approx [0.404, 0.596]
        assert 0.38 < lower < 0.42
        assert 0.58 < upper < 0.62


@pytest.mark.django_db
class TestComputeOverallScoreCI:
    def test_mention_rate_ci_is_returned(self):
        audit = LLMRankingAuditFactory()
        results = [
            _result(
                audit, provider="claude",
                is_mentioned=(i % 2 == 0), query_succeeded=True,
                mention_rank=1 if (i % 2 == 0) else None,
                sentiment=(LLMRankingResult.SENTIMENT_POSITIVE if (i % 2 == 0)
                           else LLMRankingResult.SENTIMENT_NOT_MENTIONED),
            )
            for i in range(10)
        ]
        scores = LLMRankingService.compute_overall_score(results)
        assert "mention_rate_ci_lower" in scores
        assert "mention_rate_ci_upper" in scores
        assert scores["mention_rate"] == 50.0
        assert scores["mention_rate_ci_lower"] < 50.0 < scores["mention_rate_ci_upper"]


class TestBetaBinomialMean:
    def test_handles_cold_start(self):
        from apps.llm_ranking.services.ranking_service import beta_binomial_mean
        # 1/1 should NOT be 100% — Beta(2,8) prior pulls it down well below 0.5.
        assert beta_binomial_mean(1, 1) < 0.5

    def test_zero_n_returns_prior_mean(self):
        from apps.llm_ranking.services.ranking_service import beta_binomial_mean
        # Prior mean for Beta(2, 8) is 2/10 = 0.2.
        assert abs(beta_binomial_mean(0, 0) - 0.2) < 1e-9

    def test_approaches_empirical_at_large_n(self):
        from apps.llm_ranking.services.ranking_service import beta_binomial_mean
        # The Beta(2, 8) prior carries the weight of 10 observations, so at
        # n=100 the posterior is still (2+80)/(10+100) = 0.745. By n=1000
        # it is (2+800)/(10+1000) = 0.794, close to the empirical 80%.
        assert beta_binomial_mean(80, 100) == pytest.approx(82 / 110)
        assert abs(beta_binomial_mean(800, 1000) - 0.80) < 0.01
        assert (
            abs(beta_binomial_mean(800, 1000) - 0.80)
            < abs(beta_binomial_mean(80, 100) - 0.80)
        )


@pytest.mark.django_db
class TestComputeOverallScoreSmoothed:
    def test_smoothed_field_present_and_used_for_score(self):
        audit = LLMRankingAuditFactory()
        # 1 successful query, 1 mention: raw=100% but smoothed should pull
        # the mention component well below the 40-pt cap.
        results = [LLMRankingResultFactory(
            audit=audit, provider="claude",
            is_mentioned=True, query_succeeded=True,
            mention_rank=1,
            sentiment=LLMRankingResult.SENTIMENT_POSITIVE,
        )]
        scores = LLMRankingService.compute_overall_score(results)
        assert scores["mention_rate"] == 100.0
        assert "mention_rate_smoothed" in scores
        assert scores["mention_rate_smoothed"] < 50.0  # heavily shrunk

    def test_empty_results_includes_smoothed_none(self):
        scores = LLMRankingService.compute_overall_score([])
        assert "mention_rate_smoothed" in scores
        assert scores["mention_rate_smoothed"] is None


# ── Haiku extraction service ──────────────────────────────────────────────────

class TestHaikuExtractionService:
    def test_returns_empty_result_for_blank_input(self):
        from apps.llm_ranking.services.extraction_service import HaikuExtractionService
        result = HaikuExtractionService.extract(
            response_text="", brand_name="Acme SaaS", keywords=["analytics"],
        )
        assert result["is_mentioned"] is False
        assert result["competitors_mentioned"] == []
        assert result["citations"] == []

    def test_falls_back_to_heuristic_when_llm_call_fails(self):
        from apps.llm_ranking.services import extraction_service as svc
        with patch.object(svc, "_call_haiku", side_effect=RuntimeError("boom")):
            result = svc.HaikuExtractionService.extract(
                response_text="1. Acme SaaS — great analytics platform\n2. Other tool",
                brand_name="Acme SaaS",
                keywords=["analytics"],
            )
        assert result["is_mentioned"] is True
        assert result["mention_rank"] == 1
        assert result["extraction_model"] == "heuristic"

    def test_successful_extraction_normalises_payload(self):
        from apps.llm_ranking.services import extraction_service as svc
        fake_json = (
            '{"target_mentioned": true, "target_position": 2, "target_linked": true, '
            '"target_sentiment": "positive", "target_context": "Acme SaaS is great", '
            '"competitors_mentioned": ['
            '  {"name": "Mixpanel", "position": 1, "linked": false},'
            '  {"name": "", "position": 3, "linked": false},'   # dropped: empty name
            '  "not a dict"'                                    # dropped: wrong type
            '], '
            '"primary_recommendation": "Mixpanel", '
            '"citations": ["https://g2.com/x", "not-a-url"]}'
        )
        with patch.object(svc, "_call_haiku", return_value=fake_json):
            result = svc.HaikuExtractionService.extract(
                response_text="irrelevant",
                brand_name="Acme SaaS",
                keywords=[],
            )
        assert result["is_mentioned"] is True
        assert result["mention_rank"] == 2
        assert result["is_linked"] is True
        assert result["sentiment"] == "positive"
        assert len(result["competitors_mentioned"]) == 1
        assert result["competitors_mentioned"][0]["name"] == "Mixpanel"
        assert result["primary_recommendation"] == "Mixpanel"
        assert result["citations"] == ["https://g2.com/x"]
        assert result["extraction_model"] == svc.EXTRACTION_MODEL

    def test_invalid_sentiment_defaults_based_on_mention(self):
        from apps.llm_ranking.services import extraction_service as svc
        fake_json = (
            '{"target_mentioned": false, "target_position": null, "target_linked": false, '
            '"target_sentiment": "garbage", "target_context": "", '
            '"competitors_mentioned": [], "primary_recommendation": null, "citations": []}'
        )
        with patch.object(svc, "_call_haiku", return_value=fake_json):
            result = svc.HaikuExtractionService.extract(
                response_text="x", brand_name="Acme SaaS", keywords=[],
            )
        assert result["sentiment"] == "not_mentioned"
