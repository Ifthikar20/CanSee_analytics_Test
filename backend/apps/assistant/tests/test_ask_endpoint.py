"""Ask Cansee endpoint contract + tenant gate.

Hermetic: the provider and RAG retrieval are patched so no LLM/embedding
network call happens.

build_fact_block returns a FactBlock(text, grounded) and the orchestrator
retrieves through retriever.retrieve; with no provider configured /ask/
answers 503 assistant_not_configured and stores nothing (3320cdf).
"""
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.assistant.models import AssistantConversation, AssistantMessage
from apps.assistant.services.context_builder import FactBlock
from apps.assistant.services.orchestrator import NOT_CONFIGURED_MESSAGE
from apps.rag.services.retriever import RetrievalHits
from apps.websites.tests.factories import WebsiteFactory

ASK = "/api/v1/assistant/{wid}/ask/"

CB = "apps.assistant.services.context_builder.build_fact_block"
RET = "apps.rag.services.retriever.retrieve"
NO_FACTS = FactBlock(text="", grounded=False)
GET_PROVIDER = "apps.llm_ranking.providers.get_provider"
GET_SYNTH = "apps.llm_ranking.providers.get_synthesis_provider"


class _FakeProvider:
    """Records the query() call and returns a fixed answer."""
    def __init__(self, text="**Here** is your answer."):
        self.text = text
        self.calls = []

    def query(self, prompt, system_prompt="", **kwargs):
        self.calls.append({"prompt": prompt, "system": system_prompt, "kwargs": kwargs})
        return SimpleNamespace(text=self.text, succeeded=True)


@pytest.fixture
def auth():
    user = UserFactory()
    website = WebsiteFactory(user=user)
    client = APIClient()
    client.force_authenticate(user=user)
    return client, user, website


@pytest.mark.django_db
class TestAskEndpoint:
    def test_requires_auth(self):
        wid = WebsiteFactory().id
        resp = APIClient().post(ASK.format(wid=wid), {"question": "hi"}, format="json")
        assert resp.status_code in (401, 403)

    def test_happy_path(self, auth):
        client, user, website = auth
        fake = _FakeProvider("**All good.**")
        with patch(CB, return_value=FactBlock(text="LIVE FACTS", grounded=True)), \
             patch(RET, return_value=RetrievalHits()), \
             patch(GET_PROVIDER, return_value=fake):
            resp = client.post(
                ASK.format(wid=website.id),
                {"question": "How is my traffic today?"}, format="json",
            )
        assert resp.status_code == 200
        body = resp.json()["data"]  # global success/data envelope
        assert body["answer"] == "**All good.**"
        assert body["grounded"] is True
        # The provider was called under THIS user + website, module=assistant.
        kw = fake.calls[0]["kwargs"]
        assert kw["user"] == user
        assert kw["website"] == website
        assert kw["module"] == "assistant"
        assert "LIVE FACTS" in fake.calls[0]["prompt"]

    def test_missing_question_is_400(self, auth):
        client, _u, website = auth
        resp = client.post(ASK.format(wid=website.id), {}, format="json")
        assert resp.status_code == 400

    def test_provider_unavailable(self, auth):
        client, _u, website = auth
        with patch(CB, return_value=NO_FACTS), patch(RET, return_value=RetrievalHits()), \
             patch(GET_PROVIDER, return_value=None), \
             patch(GET_SYNTH, return_value=None):
            resp = client.post(
                ASK.format(wid=website.id), {"question": "hi"}, format="json",
            )
        # No canned answer: a plain 503 and nothing stored for the turn.
        assert resp.status_code == 503
        assert resp.json()["error"] == {
            "code": "assistant_not_configured",
            "message": NOT_CONFIGURED_MESSAGE,
        }
        assert not AssistantConversation.objects.filter(website=website).exists()
        assert not AssistantMessage.objects.exists()

    def test_rate_limited(self, auth):
        client, _u, website = auth
        deny = SimpleNamespace(try_acquire=lambda: False)
        with patch("apps.assistant.api.v1.views._ask_bucket", return_value=deny):
            resp = client.post(
                ASK.format(wid=website.id), {"question": "hi"}, format="json",
            )
        assert resp.status_code == 429

    def test_history_is_accepted(self, auth):
        client, _u, website = auth
        fake = _FakeProvider()
        with patch(CB, return_value=NO_FACTS), patch(RET, return_value=RetrievalHits()), \
             patch(GET_PROVIDER, return_value=fake):
            resp = client.post(
                ASK.format(wid=website.id),
                {"question": "and yesterday?",
                 "history": [
                     {"role": "user", "content": "How is my traffic today?"},
                     {"role": "assistant", "content": "1,240 visits."},
                 ]},
                format="json",
            )
        assert resp.status_code == 200
        assert "Conversation so far" in fake.calls[0]["prompt"]
