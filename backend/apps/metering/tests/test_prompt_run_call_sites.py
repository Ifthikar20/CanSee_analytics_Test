"""Every place that asks an AI engine counts prompt runs, and asks no
engine once the free plan's runs are used up: audit cells, the per-prompt
crawl (Check now and the schedule), EngineScan (research agents and
Autopilot), country checks, Ask AI, shopping, the brand research engine
lane and the smoke test."""
from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.llm_ranking.services.ranking_service import LLMRankingService
from apps.metering.models import PromptRun
from apps.metering.services import prompt_runs
from apps.metering.tests.prompt_run_support import make_paid, use_runs
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services import prompt_crawler
from apps.prompt_library.services._hash import text_hash
from apps.websites.models import Website
from core.llm import ProviderResult

pytestmark = pytest.mark.django_db

ANSWER = "1. Acme CRM\n2. Northwind"
ANALYSIS = {
    "is_mentioned": True, "mention_rank": 2, "sentiment": "positive",
    "mention_context": "Northwind", "is_linked": False,
    "competitors_mentioned": [{"name": "Acme CRM", "position": 1}],
    "primary_recommendation": "Acme CRM", "citations": [], "confidence_score": None,
    "extraction_model": "claude-haiku-4-5", "extraction_version": "v1",
}


class Engine:
    """A configured provider that records each question it is asked."""

    name = "gpt4"
    model = "gpt-4o-mini"
    api_key_setting = "OPENAI_API_KEY"
    asked: list = []
    answer = ProviderResult(succeeded=True, text=ANSWER)

    def is_configured(self):
        return True

    def query(self, prompt, *args, **kwargs):
        type(self).asked.append(self.name)
        return type(self).answer


class Claude(Engine):
    name = "claude"
    model = "claude-sonnet"
    api_key_setting = "ANTHROPIC_API_KEY"


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
def engines(monkeypatch):
    Engine.asked = []
    Engine.answer = ProviderResult(succeeded=True, text=ANSWER)
    registry = {"gpt4": Engine, "claude": Claude}
    monkeypatch.setattr(prompt_crawler, "PROVIDERS", registry)
    monkeypatch.setattr(prompt_crawler, "list_model_variants", lambda: [
        {"provider": "gpt4", "configured": True}, {"provider": "claude", "configured": True}])
    monkeypatch.setattr(prompt_crawler, "_llm_fanout", lambda *a, **k: [])
    monkeypatch.setattr(prompt_crawler, "_extract_brands", lambda **kwargs: dict(ANALYSIS))
    monkeypatch.setattr(prompt_crawler, "_dispatch_citations", lambda rid: None)
    monkeypatch.setattr(prompt_crawler, "_dispatch_alignment", lambda rid: None)
    monkeypatch.setattr("apps.brand_vault.tasks.audit_recent_results.delay", lambda *a: None)
    monkeypatch.setattr("apps.llm_ranking.providers.get_provider", lambda key: registry[key]())
    monkeypatch.setattr(
        "apps.llm_ranking.services.extraction_service.HaikuExtractionService.extract",
        lambda **kwargs: dict(ANALYSIS),
    )
    monkeypatch.setattr(LLMRankingService, "_dispatch_citation_extraction",
                        staticmethod(lambda rid: None))
    monkeypatch.setattr(LLMRankingService, "_dispatch_alignment", staticmethod(lambda rid: None))
    monkeypatch.setattr("apps.rag.services.retriever.retrieve_context_block", lambda **kw: "")
    return registry


def _prompt(website, text="best crm for a small team"):
    industry, _ = Industry.objects.get_or_create(
        slug="fixture-crm", defaults={"name": "CRM (fixture)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, text_hash=text_hash(text),
        intent_bucket="category", style="question", source=PromptSource.MANUAL,
    )
    BrandPrompt.objects.create(website=website, prompt=prompt, location="us")
    return prompt


def _audit(website, prompts=("best crm for a small team",), providers=("gpt4",)):
    return LLMRankingAudit.objects.create(
        website=website, created_by=website.user, business_name="Northwind",
        prompts=[{"text": t} for t in prompts], providers_queried=list(providers),
        started_at=timezone.now(),
    )


def _status(user, website=None):
    return prompt_runs.status(user, website)


# -- audit cells -------------------------------------------------------------------------


def test_an_audit_cell_is_one_run_and_a_replay_is_counted_once(user, website, engines):
    audit = _audit(website)
    LLMRankingService.run_audit_cell(audit_id=str(audit.id), prompt_index=0, provider="gpt4")
    # A redelivered cell task asks again but is not counted again.
    LLMRankingService.run_audit_cell(audit_id=str(audit.id), prompt_index=0, provider="gpt4")
    assert _status(user, website)["used"] == 1
    assert PromptRun.objects.get().feature == "audit"
    assert PromptRun.objects.get().engine == "chatgpt"


def test_re_running_a_failed_audit_counts_again(user, website, engines):
    audit = _audit(website)
    LLMRankingService.run_audit_cell(audit_id=str(audit.id), prompt_index=0, provider="gpt4")
    LLMRankingAudit.objects.filter(id=audit.id).update(
        started_at=timezone.now() + timedelta(minutes=5))
    LLMRankingService.run_audit_cell(audit_id=str(audit.id), prompt_index=0, provider="gpt4")
    assert _status(user, website)["used"] == 2


def test_an_audit_cell_past_the_last_run_asks_no_engine(user, website, engines):
    use_runs(user, 20, website)
    audit = _audit(website)
    LLMRankingService.run_audit_cell(audit_id=str(audit.id), prompt_index=0, provider="gpt4")
    assert Engine.asked == []
    row = LLMRankingResult.objects.get()
    assert row.query_succeeded is False
    assert row.error_message.startswith("prompt_runs_exhausted")


def test_a_failed_cell_gives_its_run_back(user, website, engines):
    Engine.answer = ProviderResult(succeeded=False, error="engine overloaded")
    audit = _audit(website)
    LLMRankingService.run_audit_cell(audit_id=str(audit.id), prompt_index=0, provider="gpt4")
    assert _status(user, website)["remaining"] == 20


# -- the per-prompt crawl -----------------------------------------------------------------------


def test_check_now_counts_each_engine_and_stops_at_the_limit(user, website, engines):
    prompt = _prompt(website)
    use_runs(user, 19, website)
    outcome = prompt_crawler.crawl_prompt(website, prompt, acting_user=user)
    assert len(Engine.asked) == 1
    assert _status(user, website)["remaining"] == 0
    assert outcome.errors == [f"claude: {prompt_runs.DENIAL}"]
    assert LLMRankingResult.objects.filter(
        provider="claude", query_succeeded=False,
        error_message__startswith="prompt_runs_exhausted").exists()
    assert set(PromptRun.objects.values_list("feature", flat=True)) == {"prompt_crawl"}


def test_a_scheduled_crawl_counts_on_the_owner(user, website, engines):
    prompt = _prompt(website)
    prompt_crawler.crawl_prompt(website, prompt)
    assert _status(user, website)["used"] == 2
    assert set(PromptRun.objects.values_list("feature", flat=True)) == {"scheduled_crawl"}


def test_a_crawl_can_be_limited_to_some_engines(user, website, engines):
    prompt = _prompt(website)
    prompt_crawler.crawl_prompt(website, prompt, acting_user=user, providers=["claude"])
    assert Engine.asked == ["claude"]
    assert _status(user, website)["by_engine"] == {"claude": 1}


def test_engine_scans_count_under_their_feature(user, website, engines):
    prompt = _prompt(website)
    scan = prompt_crawler.EngineScan(website, prompt, acting_user=user)
    scan.ask("gpt4", None)
    scan.finish()
    make_paid(user)
    autopilot = prompt_crawler.EngineScan(website, prompt, acting_user=user, actor="system",
                                          feature="autopilot")
    autopilot.ask("claude", None)
    autopilot.finish()
    assert sorted(PromptRun.objects.values_list("feature", flat=True)) == [
        "agent_research", "autopilot"]


def test_an_engine_scan_past_the_last_run_reports_why(user, website, engines):
    from apps.agent.runtime.swarm.workers.engine_answer import failure

    use_runs(user, 20, website)
    scan = prompt_crawler.EngineScan(website, _prompt(website), acting_user=user)
    answer = scan.ask("gpt4", None)
    scan.finish()
    assert Engine.asked == [] and answer.succeeded is False
    out = failure(answer.error)
    assert (out.status, out.error) == ("skipped", {
        "code": "prompt_runs_exhausted", "message": "This month's free prompt runs are used up."})


# -- the shared retry helper (country checks, Ask AI, shopping) ----------------------------------


def test_country_style_calls_ask_nothing_once_the_runs_are_used(user, website):
    from apps.search_gap.services import country_checks

    instance = MagicMock()
    instance.name = "gpt4"
    instance.query.return_value = ProviderResult(succeeded=True, text=ANSWER)
    country_checks.query_with_retry(instance, "q", user=user, website=website,
                                    run_feature="country_check", run_key="country:1:1")
    assert _status(user, website)["by_feature"] == {"country_check": 1}

    use_runs(user, 20, website)
    instance.query.reset_mock()
    result = country_checks.query_with_retry(instance, "q", user=user, website=website,
                                             run_feature="prompt_box", run_key="promptbox:2")
    instance.query.assert_not_called()
    assert country_checks.engine_error(result.error) == ("skipped", "prompt_runs_exhausted")
    assert country_checks.CELL_MESSAGES["prompt_runs_exhausted"] == (
        "This month's free prompt runs are used up.")


def test_ask_ai_and_shopping_know_the_code():
    from apps.insights.services import shopping
    from apps.prompt_box.services import runs

    assert runs.ANSWER_MESSAGES["prompt_runs_exhausted"] == (
        "This month's free prompt runs are used up.")
    assert "prompt_runs_exhausted" in shopping._ENGINE_CODES


# -- brand research and the smoke test ------------------------------------------------------------


def test_the_brand_research_engine_lane_counts_and_stops(user, website, monkeypatch):
    from apps.citations.services import engine_probe

    monkeypatch.setattr("apps.citations.services.source_sentiment.analyze_content",
                        lambda *a, **k: {"brands": []})
    Engine.asked = []
    Engine.answer = ProviderResult(succeeded=True, text=ANSWER)
    row = engine_probe.probe_engine("gpt4", Engine, query="best crm", target_brand="Northwind",
                                    website=website, user=user)
    assert row["status"] == "ok"
    assert _status(user, website)["by_feature"] == {"brand_research": 1}

    use_runs(user, 20, website)
    row = engine_probe.probe_engine("gpt4", Engine, query="best crm", target_brand="Northwind",
                                    website=website, user=user)
    assert Engine.asked == ["gpt4"]
    assert (row["status"], row["error"]) == ("failed", "This month's free prompt runs are used up.")


def test_the_smoke_test_is_a_prompt_run(user, website, engines, monkeypatch):
    from apps.prompt_library.services.smoke_test import smoke_test_prompt

    prompt = _prompt(website)
    use_runs(user, 20, website)
    envelope = smoke_test_prompt(prompt, website=website, provider="gpt4", user=user)
    assert Engine.asked == []
    assert envelope["ok"] is False and envelope["error"].startswith("prompt_runs_exhausted")


# -- public words ----------------------------------------------------------------------------


def test_the_agent_says_the_runs_are_used_up():
    from apps.agent.tools.research import public_engine_error

    assert public_engine_error(prompt_runs.DENIAL) == "This month's free prompt runs are used up."
    assert public_engine_error(prompt_runs.CHECK_FAILED) == (
        "The prompt runs could not be checked, so the engine was not asked.")
