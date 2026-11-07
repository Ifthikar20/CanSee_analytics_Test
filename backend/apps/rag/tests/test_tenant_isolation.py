"""
Tenant isolation regression harness for the RAG knowledge base.

The knowledge base belongs to the project, not the person who added it
(a71db88: "Retrieval over the website's shared knowledge base"), so every
teammate on a website retrieves from the same corpus. The boundary that
must hold is the website: every read path filters on it, and no query on
one website may ever surface another website's chunks, even when both
corpora are populated with overlapping wording and both websites sit in
the same organization. If a future refactor drops the ``website=``
filter on any read path, one of these tests fails loudly.

Embeddings come from the offline OpenAI fake in conftest.py.
"""
import pytest

from apps.accounts.tests.factories import UserFactory
from apps.rag.models import KnowledgeChunk, KnowledgeSource
from apps.rag.services.embedder import embed_one
from apps.rag.services.retriever import retrieve, retrieve_context_block
from apps.websites.tests.factories import WebsiteFactory


def _seed(user, website, url, texts, kind=KnowledgeSource.KIND_HOMEPAGE):
    source = KnowledgeSource.objects.create(
        user=user, website=website, url=url, kind=kind,
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
class TestTenantIsolation:
    """One-leak-ends-the-company: prove the retriever is website-scoped."""

    def test_two_websites_never_cross(self, fake_openai_embeddings):
        """Both websites have chunks. Each sees only its own.

        The fake embedder is bag-of-words, so the queries use literal
        tokens from the seeded text. That's fine for this test: we're
        proving the ``website=`` filter is applied, not the semantic
        quality of the ranker.
        """
        site_a = WebsiteFactory()
        site_b = WebsiteFactory()

        _seed(site_a.user, site_a, "https://a.example.com/", [
            "AcmeCorp confidential pricing tier is $2000 per seat per year",
            "AcmeCorp founding investors include Sequoia and Benchmark",
        ])
        _seed(site_b.user, site_b, "https://b.example.com/", [
            "ContosoLtd public list price is $79 per month",
            "ContosoLtd was bootstrapped without outside investment",
        ])

        # Website A queries: must never see any of B's content.
        hits_a = retrieve(
            user=site_a.user, website=site_a,
            query="confidential pricing tier founding investors", top_k=10,
        )
        assert hits_a, "Website A should see its own chunks"
        for h in hits_a:
            assert "Contoso" not in h.text
            assert "$79" not in h.text
            assert "bootstrapped" not in h.text

        # Website B queries: must never see any of A's content.
        hits_b = retrieve(
            user=site_b.user, website=site_b,
            query="public list price bootstrapped investment", top_k=10,
        )
        assert hits_b, "Website B should see its own chunks"
        for h in hits_b:
            assert "Acme" not in h.text
            assert "$2000" not in h.text
            assert "Sequoia" not in h.text

    def test_same_user_two_websites_never_cross(self, fake_openai_embeddings):
        """One person owning two projects still gets two separate corpora:
        the user is never the scope, the website is."""
        owner = UserFactory()
        site_a = WebsiteFactory(user=owner)
        site_b = WebsiteFactory(user=owner)
        _seed(owner, site_a, "https://a.example.com/", [
            "SecretProjectAtlas launches Q4 with $10M budget",
        ])
        _seed(owner, site_b, "https://b.example.com/", [
            "PublicProjectBeta launches Q1 with $1M budget",
        ])

        hits = retrieve(
            user=owner, website=site_b,
            query="SecretProjectAtlas launches budget", top_k=10,
        )
        assert hits, "Website B should see its own chunk"
        assert {h.text for h in hits} == {
            "PublicProjectBeta launches Q1 with $1M budget",
        }

    def test_context_block_never_leaks_other_website(self, fake_openai_embeddings):
        """The formatted context block reuses ``retrieve`` — same guarantee."""
        site_a = WebsiteFactory()
        site_b = WebsiteFactory()

        _seed(site_a.user, site_a, "https://a.example.com/", [
            "SecretProjectAtlas launches Q4 with $10M budget",
        ])
        _seed(site_b.user, site_b, "https://b.example.com/", [
            "PublicProjectBeta launches Q1 with $1M budget",
        ])

        block_b = retrieve_context_block(
            user=site_b.user, website=site_b,
            query="PublicProjectBeta launches budget",
        )
        # B may see its own project mentioned; must never see A's.
        assert "PublicProjectBeta" in block_b
        assert "SecretProjectAtlas" not in block_b
        assert "10m" not in block_b.lower()

    def test_direct_orm_scope_matches_retriever_scope(self, fake_openai_embeddings):
        """Sanity: the retriever's scope is exactly the website.

        If a future refactor widens the query -- e.g. drops ``website=`` --
        this test surfaces the drift by comparing the retriever's result
        set to the direct ORM scope of each website.
        """
        site_a = WebsiteFactory()
        site_b = WebsiteFactory()

        _seed(site_a.user, site_a, "https://a.example.com/", ["alpha content one"])
        _seed(site_b.user, site_b, "https://b.example.com/", ["beta content two"])

        a_scope = {
            str(i) for i in
            KnowledgeChunk.objects.filter(website=site_a).values_list("id", flat=True)
        }
        b_scope = {
            str(i) for i in
            KnowledgeChunk.objects.filter(website=site_b).values_list("id", flat=True)
        }

        # Fundamental invariant: the two websites' chunk sets are disjoint.
        assert a_scope and b_scope
        assert a_scope.isdisjoint(b_scope)

        # A query that matches both corpora returns only the caller's website.
        hits_a = retrieve(user=site_a.user, website=site_a, query="content", top_k=10)
        assert {h.chunk_id for h in hits_a} == a_scope

    def test_deleting_source_only_affects_its_website(self, fake_openai_embeddings):
        """Cascading source deletion must not touch another website's chunks."""
        site_a = WebsiteFactory()
        site_b = WebsiteFactory()

        src_a = _seed(site_a.user, site_a, "https://a.example.com/", ["alpha alpha"])
        _seed(site_b.user, site_b, "https://b.example.com/", ["beta beta"])

        src_a.delete()

        assert not KnowledgeChunk.objects.filter(website=site_a).exists()
        assert KnowledgeChunk.objects.filter(website=site_b).count() == 1
