"""ASSISTANT_ENABLED entitlement / maintenance switch."""
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.assistant.services.context_builder import FactBlock
from apps.assistant.services.orchestrator import NOT_CONFIGURED_MESSAGE
from apps.rag.services.retriever import RetrievalHits
from apps.websites.tests.factories import WebsiteFactory

ASK = "/api/v1/assistant/{wid}/ask/"
STATUS = "/api/v1/assistant/status/"
CB = "apps.assistant.services.context_builder.build_fact_block"
RET = "apps.rag.services.retriever.retrieve"
GET_PROVIDER = "apps.llm_ranking.providers.get_provider"
GET_SYNTH = "apps.llm_ranking.providers.get_synthesis_provider"
NO_FACTS = FactBlock(text="", grounded=False)


class _Provider:
    def __init__(self):
        self.calls = 0

    def query(self, prompt, system_prompt="", **kwargs):
        self.calls += 1
        return SimpleNamespace(text="answer", succeeded=True)


@pytest.fixture
def auth():
    user = UserFactory()
    website = WebsiteFactory(user=user)
    client = APIClient()
    client.force_authenticate(user=user)
    return client, user, website


@pytest.mark.django_db
class TestAssistantEntitlementFlag:
    def test_status_reports_enabled(self, auth, settings):
        client, _u, _w = auth
        settings.ASSISTANT_ENABLED = True
        # "enabled" with an empty message also needs a configured provider.
        with patch(GET_PROVIDER, return_value=_Provider()):
            body = client.get(STATUS).json()["data"]
        assert body["enabled"] is True
        assert body["configured"] is True
        assert body["message"] == ""

    def test_status_reports_not_configured(self, auth, settings):
        client, _u, _w = auth
        settings.ASSISTANT_ENABLED = True
        with patch(GET_PROVIDER, return_value=None), patch(GET_SYNTH, return_value=None):
            body = client.get(STATUS).json()["data"]
        assert body["enabled"] is True
        assert body["configured"] is False
        assert body["message"] == NOT_CONFIGURED_MESSAGE

    def test_status_reports_maintenance(self, auth, settings):
        client, _u, _w = auth
        settings.ASSISTANT_ENABLED = False
        settings.ASSISTANT_MAINTENANCE_MESSAGE = "Back in 10 minutes."
        body = client.get(STATUS).json()["data"]
        assert body["enabled"] is False
        assert body["message"] == "Back in 10 minutes."

    def test_ask_returns_503_when_disabled(self, auth, settings):
        client, _u, website = auth
        settings.ASSISTANT_ENABLED = False
        settings.ASSISTANT_MAINTENANCE_MESSAGE = "Down for maintenance."
        provider = _Provider()
        with patch(CB, return_value=NO_FACTS), patch(RET, return_value=RetrievalHits()), \
             patch(GET_PROVIDER, return_value=provider):
            resp = client.post(
                ASK.format(wid=website.id), {"question": "hi"}, format="json",
            )
        assert resp.status_code == 503
        # The kill switch runs BEFORE the model: no spend while disabled.
        assert provider.calls == 0
        assert "maintenance" in resp.json()["error"]["message"].lower()

    def test_ask_works_when_enabled(self, auth, settings):
        client, _u, website = auth
        settings.ASSISTANT_ENABLED = True
        provider = _Provider()
        with patch(CB, return_value=NO_FACTS), patch(RET, return_value=RetrievalHits()), \
             patch(GET_PROVIDER, return_value=provider):
            resp = client.post(
                ASK.format(wid=website.id), {"question": "hi"}, format="json",
            )
        assert resp.status_code == 200
        assert provider.calls == 1
