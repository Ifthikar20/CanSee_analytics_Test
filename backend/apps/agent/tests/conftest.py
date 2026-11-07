import os

import pytest

from apps.agent.llm.client import set_client_factory
from apps.agent.tests.fakes import FakeAnthropic, refusing_client


@pytest.fixture(scope="session")
def django_db_modify_db_settings():
    """Point the suite at the throwaway Postgres when run in a container.

    config.settings.test pins HOST=localhost; run_be_tests.sh starts the
    database as its own container and passes its name in TEST_DB_HOST.
    """
    from django.conf import settings

    host = os.environ.get("TEST_DB_HOST")
    if host:
        settings.DATABASES["default"]["HOST"] = host


@pytest.fixture(autouse=True)
def _no_real_anthropic():
    """A test that reaches get_client() without a fake gets an error, never
    the network."""
    set_client_factory(refusing_client)
    yield
    set_client_factory(None)


@pytest.fixture
def fake_anthropic():
    """A FakeAnthropic installed as the agent's client factory."""
    fake = FakeAnthropic().install()
    yield fake
    set_client_factory(None)


@pytest.fixture
def user(django_user_model):
    return django_user_model.objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Site Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    from apps.websites.models import Website

    return Website.objects.create(user=user, url="https://northwind.example", name="Northwind")


@pytest.fixture
def snapshot():
    from apps.agent.models import AgentPromptSnapshot

    return AgentPromptSnapshot.objects.create(
        id="0" * 64,
        agent_key="gap_analyst",
        version="1",
        system_text="system",
        tools_json="[]",
        config={"model": "claude-opus-5-5"},
    )
