"""get_brand_context says why the knowledge base could not be searched, and
get_cited_sources counts every citation in its window, not a sample."""
import json

import pytest

from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import send, tool_results_of

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


def _tool(fake_anthropic, chat, name, args):
    fake_anthropic.queue(message(tool_use(name, args, id="toolu_d"), stop_reason="tool_use"),
                         message(text("Done.")))
    send(chat, "Go")
    result = tool_results_of(fake_anthropic.requests[-1].json)[0]
    assert result.get("is_error") is not True, result
    return json.loads(result["content"])


def test_sources_waiting_for_embeddings_are_reported_not_hidden(fake_anthropic, chat, website,
                                                               user, settings):
    from apps.rag.models import KnowledgeChunk, KnowledgeSource

    settings.OPENAI_API_KEY = "sk-test"
    source = KnowledgeSource.objects.create(user=user, website=website,
                                            url="https://northwind.example/about")
    KnowledgeChunk.objects.create(source=source, user=user, website=website,
                                  text="Northwind sells CRM software.",
                                  embedding_model="pending")

    brand = _tool(fake_anthropic, chat, "get_brand_context", {})

    assert brand["knowledge"] == []
    assert "have not been indexed" in brand["knowledge_note"]


@pytest.mark.parametrize(("reason", "words"), [
    ("ai_allowance_exhausted", "monthly AI allowance is used up"),
    ("embeddings_failed", "embedding service returned an error"),
    ("embeddings_not_configured", "OPENAI_API_KEY is not set"),
    ("something_new", "something_new"),
])
def test_each_retrieval_reason_has_a_plain_note(fake_anthropic, chat, settings, monkeypatch,
                                                reason, words):
    from apps.rag.services.retriever import RetrievalHits

    settings.OPENAI_API_KEY = "sk-test"
    monkeypatch.setattr("apps.rag.services.retriever.retrieve",
                        lambda **kwargs: RetrievalHits(reason=reason))

    brand = _tool(fake_anthropic, chat, "get_brand_context", {})

    assert brand["knowledge"] == [] and words in brand["knowledge_note"]


def test_nothing_matching_is_not_an_unavailable_knowledge_base(fake_anthropic, chat, settings,
                                                              monkeypatch):
    from apps.rag.services.retriever import RetrievalHits

    settings.OPENAI_API_KEY = "sk-test"
    monkeypatch.setattr("apps.rag.services.retriever.retrieve",
                        lambda **kwargs: RetrievalHits())

    brand = _tool(fake_anthropic, chat, "get_brand_context", {})

    assert brand["knowledge"] == [] and "knowledge_note" not in brand


def test_cited_sources_count_every_citation_in_the_window(fake_anthropic, chat, website):
    from apps.citations.models import Citation
    from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult

    audit = LLMRankingAudit.objects.create(website=website, created_by=website.user)
    results = {
        provider: LLMRankingResult.objects.create(audit=audit, provider=provider,
                                                  prompt="best crm", response_text="answer")
        for provider in ("claude", "perplexity", "gpt4")
    }
    plan = [  # (domain, provider, count, competitor, target)
        ("big.example", "claude", 3000, False, False),
        ("mid.example", "perplexity", 2500, False, False),
        ("rival.example", "gpt4", 10, True, False),
        ("northwind.example", "gpt4", 5, False, True),
    ]
    Citation.objects.bulk_create([
        Citation(result=results[provider], audit=audit, url=f"https://{domain}/p{i}",
                 normalized_url=f"{domain}/p{i}", domain=domain, apex_domain=domain,
                 is_competitor=competitor, is_target=target)
        for domain, provider, count, competitor, target in plan for i in range(count)
    ])

    sources = _tool(fake_anthropic, chat, "get_cited_sources", {})

    assert sources["citations"] == 5515
    assert [(s["domain"], s["citations"]) for s in sources["sources"]] == [
        ("big.example", 3000), ("mid.example", 2500), ("rival.example", 10),
        ("northwind.example", 5)]
    by_domain = {s["domain"]: s for s in sources["sources"]}
    assert by_domain["big.example"]["engines"] == ["claude"]
    assert by_domain["rival.example"]["engines"] == ["chatgpt"]
    assert by_domain["rival.example"]["is_competitor"] is True
    assert by_domain["northwind.example"]["is_yours"] is True
    assert by_domain["big.example"]["is_yours"] is False
    examples = by_domain["mid.example"]["example_urls"]
    assert len(examples) == 3 and all(u.startswith("https://mid.example/") for u in examples)
