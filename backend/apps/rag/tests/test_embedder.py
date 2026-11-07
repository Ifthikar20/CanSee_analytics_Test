"""Tests for the embedder and the similarity math.

The word-hash fallback embedder was removed in 3320cdf ("Remove
fabricated output, demo seeds and dead code"): with no key, a spent
allowance or a failed API call, ``embed_texts`` raises
EmbeddingUnavailable with a stable reason code instead of inventing a
vector. The OpenAI client is replaced by the offline fake from
conftest.py wherever a vector is expected.
"""
import pytest

from apps.rag.services.embedder import (
    OPENAI_DIM,
    OPENAI_MODEL,
    REASON_ALLOWANCE,
    REASON_FAILED,
    REASON_NOT_CONFIGURED,
    EmbeddingUnavailable,
    cosine_similarity,
    embed_one,
    embed_texts,
    is_model_vector,
)


class TestEmbedTexts:
    def test_empty_input_returns_empty(self):
        vectors, model, dim = embed_texts([])
        assert vectors == []
        assert dim == 0

    def test_no_api_key_raises_not_configured(self, settings):
        settings.OPENAI_API_KEY = ""
        with pytest.raises(EmbeddingUnavailable) as exc_info:
            embed_one("analytics platform with dashboards")
        assert exc_info.value.reason == REASON_NOT_CONFIGURED

    def test_configured_key_returns_model_vectors(self, fake_openai_embeddings):
        vec, model, dim = embed_one("analytics platform with dashboards")
        assert model == OPENAI_MODEL
        assert dim == OPENAI_DIM
        assert len(vec) == OPENAI_DIM
        assert any(v != 0 for v in vec)
        assert fake_openai_embeddings.calls == [{
            "model": OPENAI_MODEL,
            "input": ["analytics platform with dashboards"],
        }]

    def test_api_failure_raises_failed(self, fake_openai_embeddings, monkeypatch):
        def boom(self, **kwargs):
            raise RuntimeError("upstream 500")

        monkeypatch.setattr(fake_openai_embeddings, "_create", boom)
        with pytest.raises(EmbeddingUnavailable) as exc_info:
            embed_texts(["anything"])
        assert exc_info.value.reason == REASON_FAILED

    def test_spent_allowance_raises_before_calling_api(
        self, fake_openai_embeddings, monkeypatch,
    ):
        monkeypatch.setattr(
            "core.llm.allowance_denial",
            lambda user: "monthly_ai_allowance_exceeded",
        )
        with pytest.raises(EmbeddingUnavailable) as exc_info:
            embed_texts(["anything"], user=object())
        assert exc_info.value.reason == REASON_ALLOWANCE
        assert fake_openai_embeddings.calls == []


class TestIsModelVector:
    @pytest.mark.parametrize("name", ["pending", "hash-256", "", None])
    def test_placeholder_names_are_not_model_vectors(self, name):
        assert is_model_vector(name) is False

    def test_real_model_name_is_a_model_vector(self):
        assert is_model_vector(OPENAI_MODEL) is True


class TestCosineSimilarity:
    def test_orthogonal_vectors_zero(self):
        assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == 0.0

    def test_identical_vectors_one(self):
        assert abs(cosine_similarity([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) - 1.0) < 1e-9

    def test_mismatched_dim_returns_zero(self):
        assert cosine_similarity([1.0, 2.0], [1.0, 2.0, 3.0]) == 0.0

    def test_empty_returns_zero(self):
        assert cosine_similarity([], [1.0]) == 0.0
