"""EngineScan: one prompt's engines asked one at a time, recording what
crawl_prompt records (design section 9)."""
import threading

import pytest
from django.db import connections

from apps.agent.tests.runtime_support import make_prompt
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.prompt_library.models import PromptCrawlRun
from apps.prompt_library.services import prompt_crawler
from apps.prompt_library.services.prompt_crawler import EngineScan, crawl_prompt
from core.llm import ProviderResult

RESULT_FIELDS = (
    "provider", "model_id", "prompt_index", "prompt", "source_prompt_id", "response_text",
    "query_succeeded", "error_message", "is_mentioned", "mention_rank", "sentiment",
    "confidence_score", "mention_context", "is_linked", "competitors_mentioned",
    "primary_recommendation", "citations", "extraction_model", "extraction_version",
)
AUDIT_FIELDS = (
    "website_id", "created_by_id", "business_name", "status", "prompt_source", "prompts",
    "providers_queried", "overall_score",
)
RUN_FIELDS = ("website_id", "prompt_id", "providers", "fanout_count", "source_count", "status",
              "error")
ANALYSIS = {
    "is_mentioned": True, "mention_rank": 2, "sentiment": "positive",
    "mention_context": "Northwind is great.", "is_linked": False,
    "competitors_mentioned": [{"name": "HubSpot", "position": 1}],
    "primary_recommendation": "HubSpot", "citations": ["https://capterra.com/y"],
    "confidence_score": None, "extraction_model": "claude-haiku-4-5",
    "extraction_version": "v1",
}


class Engine:
    """A configured provider whose answer the test sets."""

    name = "claude"
    model = "claude-haiku-4-5"
    api_key_setting = "ANTHROPIC_API_KEY"
    answer = ProviderResult(succeeded=True, text="Northwind is great.",
                            citations=["https://g2.com/x"])
    calls: list = []
    hook = None

    def is_configured(self):
        return True

    def query(self, prompt, **kwargs):
        Engine.calls.append(kwargs)
        if Engine.hook is not None:
            Engine.hook()
        return Engine.answer


@pytest.fixture
def engines(monkeypatch):
    Engine.calls = []
    Engine.hook = None
    Engine.answer = ProviderResult(succeeded=True, text="Northwind is great.",
                                   citations=["https://g2.com/x"])
    dispatched = {"citations": [], "alignment": [], "security": []}
    monkeypatch.setattr(prompt_crawler, "PROVIDERS", {"claude": Engine})
    monkeypatch.setattr(prompt_crawler, "list_model_variants",
                        lambda: [{"provider": "claude", "configured": True}])
    monkeypatch.setattr(prompt_crawler, "_llm_fanout", lambda *a, **k: [])
    monkeypatch.setattr(prompt_crawler, "_extract_brands", lambda **kwargs: dict(ANALYSIS))
    monkeypatch.setattr(prompt_crawler, "_dispatch_citations",
                        lambda rid: dispatched["citations"].append(rid))
    monkeypatch.setattr(prompt_crawler, "_dispatch_alignment",
                        lambda rid: dispatched["alignment"].append(rid))
    monkeypatch.setattr("apps.brand_vault.tasks.audit_recent_results.delay",
                        lambda *args: dispatched["security"].append(args))
    return dispatched


def _values(obj, fields):
    return {f: getattr(obj, f) for f in fields}


@pytest.mark.django_db
def test_engine_scan_records_what_crawl_prompt_records(user, website, engines):
    bp = make_prompt(website, "best crm for startups")

    crawl_prompt(website, bp.prompt, acting_user=user)
    crawled = LLMRankingResult.objects.get()
    crawl_audit, crawl_run = LLMRankingAudit.objects.get(), PromptCrawlRun.objects.get()

    scan = EngineScan(website, bp.prompt, acting_user=user)
    steps = []
    answer = scan.ask("claude", None, on_step=steps.append)
    outcome = scan.finish()

    scanned = LLMRankingResult.objects.exclude(id=crawled.id).get()
    audit = LLMRankingAudit.objects.exclude(id=crawl_audit.id).get()
    run = PromptCrawlRun.objects.exclude(id=crawl_run.id).get()
    assert _values(scanned, RESULT_FIELDS) == _values(crawled, RESULT_FIELDS)
    assert _values(audit, AUDIT_FIELDS) == _values(crawl_audit, AUDIT_FIELDS)
    assert _values(run, RUN_FIELDS) == _values(crawl_run, RUN_FIELDS)
    assert scanned.citations == ["https://g2.com/x", "https://capterra.com/y"]
    assert (audit.status, run.status, run.fanout_count, run.source_count) == (
        "completed", "complete", 0, 1)
    assert audit.completed_at is not None and run.completed_at is not None
    assert all(call["user"] == user and call["extra_metadata"] == {"actor": "user"}
               and call["module"] == "prompt_library" for call in Engine.calls)
    assert steps == ["extracting"]
    assert (answer.succeeded, answer.result_id, answer.model_id) == (
        True, str(scanned.public_id), "claude-haiku-4-5")
    assert answer.analysis["mention_rank"] == 2
    assert answer.created_at == scanned.created_at
    assert (outcome.responses, outcome.errors, outcome.stopped) == (1, [], False)
    assert engines["citations"].count(scanned.id) == 1
    assert engines["alignment"].count(scanned.id) == 1
    assert (str(website.id), str(audit.id)) in engines["security"]


@pytest.mark.django_db
def test_finish_is_idempotent(user, website, engines):
    bp = make_prompt(website, "best crm for startups")
    scan = EngineScan(website, bp.prompt, acting_user=user)
    scan.ask("claude", None)

    first = scan.finish()
    audit = LLMRankingAudit.objects.get()
    completed = audit.completed_at
    second = scan.finish(stopped=True)

    audit.refresh_from_db()
    assert second is first
    assert audit.completed_at == completed
    assert PromptCrawlRun.objects.get().error == ""
    assert len(engines["security"]) == 1


@pytest.mark.django_db
def test_an_unconfigured_variant_or_a_stop_asks_nothing(user, website, engines, settings):
    settings.GEMINI_API_KEY = ""
    bp = make_prompt(website, "best crm for startups")
    scan = EngineScan(website, bp.prompt, acting_user=user)

    gemini = scan.ask("gemini", "gemini:gemini-2.5-flash")
    stopped = scan.ask("claude", None, should_stop=lambda: True)

    assert (gemini.succeeded, gemini.not_configured) == (False, True)
    assert (stopped.succeeded, stopped.stopped) == (False, True)
    assert Engine.calls == []
    assert not PromptCrawlRun.objects.exists() and not LLMRankingAudit.objects.exists()
    outcome = scan.finish(stopped=True)
    assert (outcome.responses, outcome.stopped) == (0, True)


@pytest.mark.django_db
def test_failed_answers_are_stored_and_reported_by_the_crawl_run(user, website, engines):
    Engine.answer = ProviderResult(succeeded=False, error="claude rate limit exceeded")
    bp = make_prompt(website, "best crm for startups")
    scan = EngineScan(website, bp.prompt, acting_user=user)

    answer = scan.ask("claude", None)
    scan.finish(stopped=True)

    row = LLMRankingResult.objects.get()
    run = PromptCrawlRun.objects.get()
    assert (answer.succeeded, answer.error) == (False, "claude rate limit exceeded")
    assert (row.query_succeeded, row.error_message) == (False, "claude rate limit exceeded")
    assert run.status == "failed"
    assert run.error == ("claude: claude rate limit exceeded; stopped before every model was "
                         "asked")
    assert LLMRankingAudit.objects.get().status == "failed"
    assert engines["citations"] == [] and engines["security"] == []


@pytest.mark.django_db
def test_an_answer_after_finish_is_stored_without_scoring_again(user, website, engines):
    bp = make_prompt(website, "best crm for startups")
    scan = EngineScan(website, bp.prompt, acting_user=user)
    # Stop ends the research while the engine is still answering.
    Engine.hook = lambda: scan.finish(stopped=True)

    late = scan.ask("claude", None)
    Engine.hook = None
    after = scan.ask("claude", None)

    assert late.succeeded and LLMRankingResult.objects.count() == 1
    audit = LLMRankingAudit.objects.get()
    assert (audit.status, audit.providers_queried) == ("failed", [])
    assert PromptCrawlRun.objects.get().source_count == 0
    assert after.stopped and LLMRankingResult.objects.count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_asks_share_one_crawl_run_and_one_audit(user, website, engines, monkeypatch):
    class Second(Engine):
        name = "perplexity"
        model = "sonar"

    monkeypatch.setattr(prompt_crawler, "PROVIDERS", {"claude": Engine, "perplexity": Second})
    bp = make_prompt(website, "best crm for startups")
    scan = EngineScan(website, bp.prompt, acting_user=user)
    both_ready = threading.Barrier(2, timeout=5)
    answers = {}

    def ask(provider):
        try:
            answers[provider] = scan.ask(provider, None,
                                         should_stop=lambda: (both_ready.wait(), False)[1])
        finally:
            connections.close_all()

    threads = [threading.Thread(target=ask, args=(p,)) for p in ("claude", "perplexity")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    scan.finish()

    assert all(a.succeeded for a in answers.values()) and len(answers) == 2
    assert PromptCrawlRun.objects.count() == 1
    assert LLMRankingAudit.objects.count() == 1
    assert sorted(LLMRankingResult.objects.values_list("provider", flat=True)) == [
        "claude", "perplexity"]
    run = PromptCrawlRun.objects.get()
    assert (sorted(run.providers), run.source_count, run.status) == (
        ["claude", "perplexity"], 2, "complete")
