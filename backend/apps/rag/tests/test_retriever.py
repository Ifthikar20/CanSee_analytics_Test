"""Tests for the RAG retriever (website-shared knowledge base).

Embeddings come from the offline OpenAI fake in conftest.py
(``fake_openai_embeddings``); the word-hash fallback embedder these tests
used to rely on was removed in 3320cdf.
"""
import pytest

from apps.accounts.tests.factories import UserFactory
from apps.rag.models import KnowledgeChunk, KnowledgeSource
from apps.rag.services.embedder import (
    PENDING_MODEL,
    REASON_NOT_CONFIGURED,
    REASON_PENDING,
    embed_one,
)
from apps.rag.services.retriever import retrieve, retrieve_context_block
from apps.websites.tests.factories import WebsiteFactory


def _seed_chunks(user, website, texts):
    # Hash the full first text so two seed calls with the same 10-char
    # prefix (e.g. "Cansee analytics blog" vs "Cansee analytics home")
    # produce distinct URLs and don't collide on the (website, url)
    # unique constraint.
    import hashlib
    slug = hashlib.sha1(texts[0].encode("utf-8")).hexdigest()[:12]
    source = KnowledgeSource.objects.create(
        user=user, website=website,
        url=f"https://example.com/{slug}",
        kind=KnowledgeSource.KIND_HOMEPAGE,
        status=KnowledgeSource.STATUS_READY,
    )
    for i, text in enumerate(texts):
        vec, model, dim = embed_one(text)
        KnowledgeChunk.objects.create(
            source=source, user=user, website=website,
            chunk_index=i, text=text, embedding=vec,
            embedding_model=model, embedding_dim=dim,
            section_label="seed",
        )
    source.chunk_count = len(texts)
    source.save(update_fields=["chunk_count"])
    return source


@pytest.mark.django_db
class TestRetrieve:
    def test_retrieves_relevant_chunk_above_unrelated(self, fake_openai_embeddings):
        user = UserFactory()
        website = WebsiteFactory()
        _seed_chunks(user, website, [
            "Cansee analytics platform with funnel tracking and dashboards",
            "Recipes for chocolate cake and dessert ideas",
            "Cansee integrates with Slack and Salesforce for SaaS teams",
        ])
        hits = retrieve(
            user=user, website=website,
            query="analytics dashboard for SaaS", top_k=2,
        )
        assert len(hits) >= 1
        # The top hit should be about analytics, not cake.
        assert "analytics" in hits[0].text.lower() or "cansee" in hits[0].text.lower()
        assert "cake" not in hits[0].text.lower()

    def test_scoped_to_website(self, fake_openai_embeddings):
        # The knowledge base is shared per website (a71db88): retrieval
        # never filters by user, but it never crosses websites either.
        owner = UserFactory()
        website = WebsiteFactory(user=owner)
        other_website = WebsiteFactory()
        _seed_chunks(owner, website, ["Cansee analytics platform"])
        # Another website (another owner) sees nothing of this corpus.
        hits = retrieve(
            user=other_website.user, website=other_website,
            query="analytics", top_k=5,
        )
        assert hits == []
        assert hits.reason is None

    def test_teammates_on_same_website_share_corpus(self, fake_openai_embeddings):
        author = UserFactory()
        teammate = UserFactory()
        website = WebsiteFactory(user=author)
        source = _seed_chunks(author, website, ["Cansee analytics platform"])
        hits = retrieve(user=teammate, website=website, query="analytics", top_k=5)
        assert [h.source_id for h in hits] == [str(source.id)]

    def test_empty_query_returns_empty(self, fake_openai_embeddings):
        user = UserFactory()
        website = WebsiteFactory()
        assert retrieve(user=user, website=website, query="") == []
        assert retrieve(user=user, website=website, query="   ") == []

    def test_pending_chunks_are_not_scored_and_reason_reported(self, fake_openai_embeddings):
        user = UserFactory()
        website = WebsiteFactory()
        source = KnowledgeSource.objects.create(
            user=user, website=website, url="https://example.com/pending",
            status=KnowledgeSource.STATUS_READY,
        )
        KnowledgeChunk.objects.create(
            source=source, user=user, website=website, chunk_index=0,
            text="Cansee analytics platform", embedding=[],
            embedding_model=PENDING_MODEL, embedding_dim=0,
        )
        hits = retrieve(user=user, website=website, query="Cansee analytics")
        assert hits == []
        assert hits.reason == REASON_PENDING
        assert fake_openai_embeddings.calls == []

    def test_no_key_with_only_pending_chunks_reports_not_configured(self, settings):
        settings.OPENAI_API_KEY = ""
        user = UserFactory()
        website = WebsiteFactory()
        source = KnowledgeSource.objects.create(
            user=user, website=website, url="https://example.com/pending",
            status=KnowledgeSource.STATUS_READY,
        )
        KnowledgeChunk.objects.create(
            source=source, user=user, website=website, chunk_index=0,
            text="Cansee analytics platform", embedding=[],
            embedding_model=PENDING_MODEL, embedding_dim=0,
        )
        hits = retrieve(user=user, website=website, query="Cansee analytics")
        assert hits == []
        assert hits.reason == REASON_NOT_CONFIGURED

    def test_kinds_filter(self, fake_openai_embeddings):
        user = UserFactory()
        website = WebsiteFactory()
        src_blog = _seed_chunks(user, website, ["Cansee analytics blog post"])
        src_blog.kind = KnowledgeSource.KIND_BLOG
        src_blog.save(update_fields=["kind"])
        _seed_chunks(user, website, ["Cansee analytics homepage copy"])
        hits = retrieve(
            user=user, website=website, query="Cansee analytics",
            top_k=5, kinds=[KnowledgeSource.KIND_BLOG],
        )
        assert all(h.source_kind == KnowledgeSource.KIND_BLOG for h in hits)


@pytest.mark.django_db
class TestRetrieveContextBlock:
    def test_returns_empty_when_no_corpus(self, fake_openai_embeddings):
        user = UserFactory()
        website = WebsiteFactory()
        assert retrieve_context_block(
            user=user, website=website, query="anything",
        ) == ""

    def test_block_contains_knowledge_base_header(self, fake_openai_embeddings):
        user = UserFactory()
        website = WebsiteFactory()
        _seed_chunks(user, website, ["Cansee is a SaaS analytics platform"])
        block = retrieve_context_block(
            user=user, website=website, query="SaaS analytics",
        )
        assert "KNOWLEDGE BASE" in block
        assert "Cansee" in block
