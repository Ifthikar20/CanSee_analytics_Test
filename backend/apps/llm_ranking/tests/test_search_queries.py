"""Query fan-outs from the providers (p2 backend 2a): the web searches
ChatGPT, Claude and Grok report while answering, read from dict and SDK
object shapes, the states None (not reported) versus [] and 0 (reported
none), and the three places that store them on LLMRankingResult."""

from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model

from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.llm_ranking.providers.claude import ClaudeProvider
from apps.llm_ranking.providers.grok import GrokProvider
from apps.llm_ranking.providers.openai import OpenAIProvider
from apps.llm_ranking.providers.openai_compat import (
    MAX_QUERY_CHARS,
    MAX_SEARCH_QUERIES,
    clean_search_queries,
    extract_search_queries,
)
from apps.llm_ranking.services.ranking_service import LLMRankingService, search_query_fields
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services import prompt_crawler
from apps.prompt_library.services._hash import text_hash
from apps.websites.models import Website
from core.llm import ProviderResult

ANSWER = "1. Acme CRM - pipelines.\n2. Northwind - small teams."
ANALYSIS = {
    "is_mentioned": True, "mention_rank": 2, "sentiment": "positive",
    "mention_context": "Northwind - small teams.", "is_linked": False,
    "competitors_mentioned": [{"name": "Acme CRM", "position": 1}],
    "primary_recommendation": "Acme CRM", "citations": [], "confidence_score": None,
    "extraction_model": "claude-haiku-4-5", "extraction_version": "v1",
}


def web_search_call(action=None, **extra):
    item = {"type": "web_search_call", "id": "ws_1", "status": "completed", **extra}
    if action is not None:
        item["action"] = action
    return item


def as_object(value):
    """An SDK-like object tree (attribute access) from dicts and lists."""
    if isinstance(value, dict):
        return SimpleNamespace(**{k: as_object(v) for k, v in value.items()})
    if isinstance(value, list):
        return [as_object(v) for v in value]
    return value


# ── Responses API items (OpenAI, xAI) ──────────────────────────────────────


def test_a_search_with_a_queries_list_counts_once_and_keeps_every_query():
    resp = {"output": [
        web_search_call({"type": "search", "queries": ["best crm 2026", "crm for startups"]}),
        {"type": "message", "content": [{"type": "output_text", "text": ANSWER}]},
    ]}

    assert extract_search_queries(resp) == (["best crm 2026", "crm for startups"], 1)


def test_a_search_with_a_single_query_and_one_without_action():
    resp = {"output": [
        web_search_call({"type": "search", "query": "  best   crm\n2026 "}),
        web_search_call(),
    ]}

    assert extract_search_queries(resp) == (["best crm 2026"], 2)


def test_open_page_and_find_in_page_count_as_searches_without_a_query():
    resp = {"output": [
        web_search_call({"type": "open_page", "url": "https://example.com/"}),
        web_search_call({"type": "find_in_page", "url": "https://example.com/", "pattern": "x"}),
        web_search_call({"type": "search"}),
    ]}

    assert extract_search_queries(resp) == ([], 3)


def test_sdk_objects_read_like_dicts():
    resp = as_object({"output": [
        web_search_call({"type": "search", "queries": ["crm pricing"]}),
        web_search_call({"type": "search", "query": "crm reviews", "queries": None}),
    ]})

    assert extract_search_queries(resp) == (["crm pricing", "crm reviews"], 2)


def test_no_search_items_is_zero_searches():
    assert extract_search_queries({"output": [{"type": "message", "content": []}]}) == ([], 0)
    assert extract_search_queries(SimpleNamespace(output=None)) == ([], 0)


def test_queries_are_cleaned_deduplicated_capped_and_clipped():
    long = "x" * (MAX_QUERY_CHARS + 50)
    many = [f"query {i}" for i in range(MAX_SEARCH_QUERIES + 5)]
    cleaned = clean_search_queries(["a  b", "a b", "", "   ", None, 7, long, *many])

    assert cleaned[:2] == ["a b", "x" * MAX_QUERY_CHARS]
    assert len(cleaned) == MAX_SEARCH_QUERIES
    assert "" not in cleaned


# ── fakes for the SDK clients ──────────────────────────────────────────────


class _Calls:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def fake_openai(monkeypatch, *, responses=(), chat=()):
    import openai

    client = SimpleNamespace(responses=_Calls(*responses),
                             chat=SimpleNamespace(completions=_Calls(*chat)))
    monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: client)
    return client


def fake_anthropic(monkeypatch, *responses):
    import anthropic

    client = SimpleNamespace(messages=_Calls(*responses))
    monkeypatch.setattr(anthropic, "Anthropic", lambda **kwargs: client)
    return client


def responses_reply(*output, text=ANSWER):
    return as_object({
        "output_text": text,
        "output": [*output, {"type": "message", "content": [
            {"type": "output_text", "text": text, "annotations": []}]}],
        "usage": {"input_tokens": 10, "output_tokens": 20},
    })


def chat_reply(text=ANSWER, finish_reason="stop"):
    return as_object({
        "choices": [{"finish_reason": finish_reason, "message": {"content": text}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20},
    })


def claude_reply(*blocks, stop_reason="end_turn", searches=0):
    return SimpleNamespace(
        content=list(blocks), stop_reason=stop_reason,
        usage=SimpleNamespace(input_tokens=10, output_tokens=20,
                              server_tool_use=SimpleNamespace(web_search_requests=searches)),
    )


def text_block(value=ANSWER):
    return SimpleNamespace(type="text", text=value, citations=None)


def search_block(query, *, as_dict=False):
    block = {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search",
             "input": {"query": query}}
    return block if as_dict else SimpleNamespace(**block)


def _call(provider):
    return provider._call(prompt="Best CRM for a small team?", system_prompt="", region="")


@pytest.fixture
def keys(settings):
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.XAI_API_KEY = "xai-test"
    settings.LLM_CLAUDE_MODEL = ""
    settings.LLM_WEBSEARCH_ENABLED = True
    return settings


# ── OpenAI ────────────────────────────────────────────────────────────────


def test_openai_web_search_answer_records_its_searches(keys, monkeypatch):
    fake_openai(monkeypatch, responses=[responses_reply(
        web_search_call({"type": "search", "queries": ["best crm for a small team"]}),
        web_search_call({"type": "open_page", "url": "https://acme.example/"}),
    )])

    result = _call(OpenAIProvider())

    assert result.succeeded
    assert (result.search_queries, result.web_searches) == (["best crm for a small team"], 2)


def test_openai_without_web_search_reports_no_searches(keys, monkeypatch):
    keys.LLM_WEBSEARCH_ENABLED = False
    client = fake_openai(monkeypatch, chat=[chat_reply()])

    result = _call(OpenAIProvider())

    assert result.succeeded and client.responses.calls == []
    assert (result.search_queries, result.web_searches) == ([], 0)


def test_openai_falls_back_to_chat_when_the_tool_is_unavailable(keys, monkeypatch):
    fake_openai(monkeypatch, responses=[RuntimeError("no tool"), RuntimeError("no preview")],
                chat=[chat_reply()])

    result = _call(OpenAIProvider())

    assert result.succeeded
    assert (result.search_queries, result.web_searches) == ([], 0)


def test_openai_cut_off_answer_records_nothing(keys, monkeypatch):
    keys.LLM_WEBSEARCH_ENABLED = False
    fake_openai(monkeypatch, chat=[chat_reply(finish_reason="length")])

    result = _call(OpenAIProvider())

    assert not result.succeeded
    assert (result.search_queries, result.web_searches) == (None, None)


# ── Claude ────────────────────────────────────────────────────────────────


def test_claude_records_each_web_search_tool_use(keys, monkeypatch):
    fake_anthropic(monkeypatch, claude_reply(
        search_block("best crm small team"), search_block("crm  pricing", as_dict=True),
        text_block(), searches=2,
    ))

    result = _call(ClaudeProvider())

    assert result.succeeded
    assert (result.search_queries, result.web_searches) == (
        ["best crm small team", "crm pricing"], 2)


def test_claude_with_the_tool_but_no_search_reports_none_run(keys, monkeypatch):
    fake_anthropic(monkeypatch, claude_reply(text_block()))

    result = _call(ClaudeProvider())

    assert (result.search_queries, result.web_searches) == ([], 0)


def test_claude_tool_dropped_after_an_error_reports_no_searches(keys, monkeypatch):
    client = fake_anthropic(monkeypatch, RuntimeError("web search unavailable"),
                            claude_reply(text_block()))

    result = _call(ClaudeProvider())

    assert result.succeeded
    assert "tools" in client.messages.calls[0] and "tools" not in client.messages.calls[1]
    assert (result.search_queries, result.web_searches) == ([], 0)


def test_claude_without_web_search_reports_no_searches(keys, monkeypatch):
    keys.LLM_WEBSEARCH_ENABLED = False
    client = fake_anthropic(monkeypatch, claude_reply(text_block()))

    result = _call(ClaudeProvider())

    assert "tools" not in client.messages.calls[0]
    assert (result.search_queries, result.web_searches) == ([], 0)


def test_claude_incomplete_answer_leaves_searches_unrecorded(keys, monkeypatch):
    fake_anthropic(monkeypatch, claude_reply(search_block("best crm"), stop_reason="pause_turn",
                                             searches=1))

    result = _call(ClaudeProvider())

    assert not result.succeeded
    assert (result.search_queries, result.web_searches) == (None, None)


# ── Grok ──────────────────────────────────────────────────────────────────


def test_grok_records_searches_only_when_its_response_carries_them(keys, monkeypatch):
    fake_openai(monkeypatch, responses=[
        responses_reply(web_search_call({"type": "search", "query": "best crm"})),
        responses_reply(),
    ])

    found = _call(GrokProvider())
    silent = _call(GrokProvider())

    assert (found.search_queries, found.web_searches) == (["best crm"], 1)
    assert (silent.search_queries, silent.web_searches) == (None, None)


def test_grok_chat_path_reports_no_searches(keys, monkeypatch):
    keys.LLM_WEBSEARCH_ENABLED = False
    fake_openai(monkeypatch, chat=[chat_reply()])

    result = _call(GrokProvider())

    assert (result.search_queries, result.web_searches) == ([], 0)


def test_providers_that_do_not_report_searches_leave_none():
    result = ProviderResult(succeeded=True, text=ANSWER)

    assert (result.search_queries, result.web_searches) == (None, None)


# ── what is stored ────────────────────────────────────────────────────────


def test_search_query_fields_reads_only_measured_values():
    ok = ProviderResult(succeeded=True, text=ANSWER, search_queries=["a  b", "a b"],
                        web_searches=3)
    failed = ProviderResult(succeeded=False, error="busy", search_queries=["a"], web_searches=1)

    assert search_query_fields(ok) == {"search_queries": ["a b"], "web_searches": 3}
    assert search_query_fields(failed) == {"search_queries": None, "web_searches": None}
    assert search_query_fields(ProviderResult(succeeded=True, text=ANSWER)) == {
        "search_queries": None, "web_searches": None}
    mocked = SimpleNamespace(succeeded=True, search_queries="nope", web_searches=True)
    assert search_query_fields(mocked) == {"search_queries": None, "web_searches": None}


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Fixture Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://northwind.example", name="Northwind")


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


class _Engine:
    """A configured provider whose answer each test sets."""

    name = "gpt4"
    model = "gpt-4o-mini"
    api_key_setting = "OPENAI_API_KEY"
    answer: ProviderResult = ProviderResult(succeeded=True, text=ANSWER)

    def is_configured(self):
        return True

    def query(self, prompt, *args, **kwargs):
        return _Engine.answer


@pytest.fixture
def engine(monkeypatch):
    _Engine.answer = ProviderResult(succeeded=True, text=ANSWER,
                                    search_queries=["best crm 2026"], web_searches=2)
    monkeypatch.setattr(prompt_crawler, "PROVIDERS", {"gpt4": _Engine})
    monkeypatch.setattr(prompt_crawler, "list_model_variants",
                        lambda: [{"provider": "gpt4", "configured": True}])
    monkeypatch.setattr(prompt_crawler, "_llm_fanout", lambda *a, **k: [])
    monkeypatch.setattr(prompt_crawler, "_extract_brands", lambda **kwargs: dict(ANALYSIS))
    monkeypatch.setattr(prompt_crawler, "_dispatch_citations", lambda rid: None)
    monkeypatch.setattr(prompt_crawler, "_dispatch_alignment", lambda rid: None)
    monkeypatch.setattr("apps.brand_vault.tasks.audit_recent_results.delay", lambda *a: None)
    monkeypatch.setattr("apps.llm_ranking.providers.get_provider", lambda key: _Engine())
    monkeypatch.setattr(
        "apps.llm_ranking.services.extraction_service.HaikuExtractionService.extract",
        lambda **kwargs: dict(ANALYSIS),
    )
    monkeypatch.setattr(LLMRankingService, "_dispatch_citation_extraction",
                        staticmethod(lambda rid: None))
    monkeypatch.setattr(LLMRankingService, "_dispatch_alignment", staticmethod(lambda rid: None))
    monkeypatch.setattr("apps.rag.services.retriever.retrieve_context_block", lambda **kw: "")
    return _Engine


@pytest.mark.django_db
def test_crawl_prompt_stores_the_searches(website, user, engine):
    prompt = _prompt(website)

    prompt_crawler.crawl_prompt(website, prompt, acting_user=user)

    row = LLMRankingResult.objects.get()
    assert (row.search_queries, row.web_searches) == (["best crm 2026"], 2)


@pytest.mark.django_db
def test_engine_scan_stores_the_searches(website, user, engine):
    prompt = _prompt(website)

    scan = prompt_crawler.EngineScan(website, prompt, acting_user=user)
    scan.ask("gpt4", None)
    scan.finish()

    row = LLMRankingResult.objects.get()
    assert (row.search_queries, row.web_searches) == (["best crm 2026"], 2)


@pytest.mark.django_db
def test_audit_cell_stores_the_searches_and_a_failed_retry_clears_them(website, engine):
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=website.user, business_name="Northwind",
        prompts=[{"text": "best crm for a small team"}], providers_queried=["gpt4"],
    )

    LLMRankingService.run_audit_cell(audit_id=str(audit.id), prompt_index=0, provider="gpt4")
    row = LLMRankingResult.objects.get()
    assert (row.search_queries, row.web_searches) == (["best crm 2026"], 2)

    engine.answer = ProviderResult(succeeded=False, error="busy")
    LLMRankingService.run_audit_cell(audit_id=str(audit.id), prompt_index=0, provider="gpt4")
    row.refresh_from_db()
    assert not row.query_succeeded
    assert (row.search_queries, row.web_searches) == (None, None)


@pytest.mark.django_db
def test_failed_crawl_answer_records_no_searches(website, user, engine):
    engine.answer = ProviderResult(succeeded=False, error="max_tokens: cut off",
                                   search_queries=["x"], web_searches=1)
    prompt = _prompt(website)

    prompt_crawler.crawl_prompt(website, prompt, acting_user=user)

    rows = list(LLMRankingResult.objects.all())
    assert rows and all((r.search_queries, r.web_searches) == (None, None) for r in rows)


@pytest.mark.django_db
def test_web_search_off_answers_store_empty_and_zero(website, user, engine):
    engine.answer = ProviderResult(succeeded=True, text=ANSWER, search_queries=[], web_searches=0)
    prompt = _prompt(website)

    prompt_crawler.crawl_prompt(website, prompt, acting_user=user)

    row = LLMRankingResult.objects.get()
    assert (row.search_queries, row.web_searches) == ([], 0)
