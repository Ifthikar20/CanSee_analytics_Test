"""Shared fixtures for the RAG tests.

The embedder no longer has a word-hash fallback (3320cdf "Remove
fabricated output, demo seeds and dead code"): without OPENAI_API_KEY it
raises EmbeddingUnavailable and ingest stores chunks as pending. Tests
that need real vectors use ``fake_openai_embeddings``, which sets a key
and replaces the OpenAI SDK client with a deterministic, offline stand-in
so the production ``embed_texts`` code path runs unchanged.
"""
import hashlib
import re
from types import SimpleNamespace

import pytest

from apps.rag.services.embedder import OPENAI_DIM


def fake_vector(text: str, dim: int = OPENAI_DIM) -> list[float]:
    """Deterministic hashed bag-of-words vector, L2-normalised.

    Texts sharing tokens score high under cosine similarity and texts
    with no tokens in common score 0, which is enough to make retrieval
    ranking assertions meaningful without calling OpenAI.
    """
    tokens = [t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(t) > 1]
    vec = [0.0] * dim
    if not tokens:
        vec[0] = 1.0
        return vec
    for tok in tokens:
        digest = hashlib.sha1(tok.encode("utf-8")).digest()
        vec[int.from_bytes(digest[:4], "big") % dim] += 1.0
    norm = sum(v * v for v in vec) ** 0.5
    return [v / norm for v in vec]


class FakeOpenAI:
    """Stands in for ``openai.OpenAI``; records every embeddings call."""

    calls: list[dict] = []

    def __init__(self, api_key=None, **kwargs):
        self.api_key = api_key
        self.embeddings = SimpleNamespace(create=self._create)

    def _create(self, *, model, input):
        FakeOpenAI.calls.append({"model": model, "input": list(input)})
        return SimpleNamespace(
            data=[SimpleNamespace(embedding=fake_vector(t)) for t in input],
            usage=SimpleNamespace(
                prompt_tokens=sum(len(t.split()) for t in input),
            ),
        )


@pytest.fixture
def fake_openai_embeddings(settings, monkeypatch):
    """Configure a key and route OpenAI embedding calls to FakeOpenAI."""
    settings.OPENAI_API_KEY = "test-openai-key"
    FakeOpenAI.calls = []
    monkeypatch.setattr("openai.OpenAI", FakeOpenAI)
    return FakeOpenAI
