"""Settings, conf, exceptions and the read-only admin."""

import pytest
from django.apps import apps
from django.conf import settings as django_settings
from django.test import override_settings
from django.urls import NoReverseMatch, reverse
from rest_framework.test import APIRequestFactory

from apps.agent import exceptions as agent_exceptions
from apps.agent.conf import agent_conf, api_key_configured, check_agent_settings
from apps.agent.constants import ACTIVE_RUN_STATUSES, CONTENT_TYPE_BY_KIND, MessageRole
from core.interceptors.exception_handler import custom_exception_handler


def test_app_is_installed_under_the_agent_label():
    config = apps.get_app_config("agent")
    assert config.name == "apps.agent"
    assert "apps.agent" in django_settings.INSTALLED_APPS


def test_test_settings_run_inline_in_the_agent_process():
    conf = agent_conf()
    assert (conf.enabled, conf.process, conf.run_mode) == (True, True, "inline")
    assert conf.model == "claude-opus-5-5"
    assert (conf.effort, conf.subagent_effort, conf.title_effort) == ("medium", "medium", "low")
    assert conf.max_tokens == 32000 and conf.landing_max_tokens == 64000
    assert conf.cache_ttl == "1h"
    assert conf.run_max_cost_usd == 3.0
    assert conf.serp_max_pages == 5


def test_conf_reads_settings_at_call_time():
    with override_settings(AGENT_MODEL="claude-opus-5", AGENT_MAX_CONCURRENT_RUNS=2):
        conf = agent_conf()
    assert (conf.model, conf.max_concurrent_runs) == ("claude-opus-5", 2)
    assert agent_conf().model == "claude-opus-5-5"


def test_api_key_configured():
    with override_settings(ANTHROPIC_API_KEY=""):
        assert not api_key_configured()
    with override_settings(ANTHROPIC_API_KEY="sk-test"):
        assert api_key_configured()


def test_cors_allows_the_agent_headers():
    assert "idempotency-key" in django_settings.CORS_ALLOW_HEADERS
    assert "last-event-id" in django_settings.CORS_ALLOW_HEADERS


def test_agent_settings_check_passes_by_default():
    assert check_agent_settings() == []


def test_agent_settings_check_rejects_bad_values():
    with override_settings(
        AGENT_RUN_MODE="celery", AGENT_EFFORT="huge", AGENT_CACHE_TTL="2h",
        AGENT_MAX_TOKENS=0, AGENT_RUN_MAX_COST_USD=0,
    ):
        ids = sorted(e.id for e in check_agent_settings())
    assert ids == ["agent.E001", "agent.E002", "agent.E003", "agent.E004", "agent.E006"]


def test_agent_settings_module_is_prod_plus_agent_process():
    source = (django_settings.BASE_DIR / "config/settings/agent.py").read_text(encoding="utf-8")
    assert "from .prod import *" in source
    assert 'AGENT_RUN_MODE = "thread"' in source
    assert "AGENT_PROCESS = True" in source
    assert 'DATABASES["default"]["CONN_MAX_AGE"] = 0' in source


def test_constants_match_the_contract():
    assert ACTIVE_RUN_STATUSES == ("queued", "running")
    assert CONTENT_TYPE_BY_KIND == {
        "page": "text/html", "document": "text/markdown",
        "report": "text/markdown", "sheet": "application/json",
    }
    assert MessageRole.ASSISTANT == "assistant"


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (agent_exceptions.AgentDisabled(), 503, "agent_disabled"),
        (agent_exceptions.AgentUnavailable(), 503, "agent_unavailable"),
        (agent_exceptions.AgentNotConfigured(), 503, "agent_not_configured"),
        (agent_exceptions.AllowanceExceeded(cap_usd=1, spent_usd=1.2), 403, "allowance_exceeded"),
        (agent_exceptions.AgentBusy(), 429, "agent_busy"),
        (agent_exceptions.RunInProgress(), 409, "run_in_progress"),
        (agent_exceptions.AlreadySaved(artifact_id="a1"), 409, "already_saved"),
        (agent_exceptions.RevisionConflict(), 409, "revision_conflict"),
    ],
)
def test_exceptions_render_through_the_envelope(exc, status, code):
    request = APIRequestFactory().get("/api/v1/agent/status/")
    response = custom_exception_handler(exc, {"request": request})

    assert response.status_code == status
    assert response.data["success"] is False
    assert response.data["error"]["code"] == code
    assert response.data["error"]["message"]


def test_exception_details_for_the_ui():
    request = APIRequestFactory().get("/")

    allowance = custom_exception_handler(
        agent_exceptions.AllowanceExceeded(cap_usd=29.25, spent_usd=30.1234567),
        {"request": request},
    )
    assert allowance.data["error"]["details"] == {"cap_usd": 29.25, "spent_usd": 30.123457}

    saved = custom_exception_handler(
        agent_exceptions.AlreadySaved(artifact_id="8f0c"), {"request": request},
    )
    assert saved.data["error"]["details"] == {"artifact_id": "8f0c"}

    busy = custom_exception_handler(
        agent_exceptions.RunInProgress(run_id="r-1"), {"request": request},
    )
    assert busy.data["error"]["details"] == {"run_id": "r-1"}

    stale = custom_exception_handler(
        agent_exceptions.RevisionConflict(revision=4), {"request": request},
    )
    assert stale.data["error"]["details"] == {"revision": 4}


@pytest.mark.django_db
def test_admin_is_read_only_and_never_shows_chat_content(client, django_user_model, website,
                                                          user, snapshot):
    from apps.agent.models import AgentArtifact, AgentChat, AgentMessage, AgentRun

    chat = AgentChat.objects.create(
        website=website, user=user, snapshot=snapshot,
        title="Private question about pricing", preview="Private question about pricing",
    )
    question = AgentMessage.objects.create(
        chat=chat, role="user", parts=[{"id": "p1", "type": "text", "text": "Secret text"}],
    )
    reply = AgentMessage.objects.create(chat=chat, parent=question, role="assistant", depth=1)
    run = AgentRun.objects.create(
        chat=chat, user=user, website=website, user_message=question,
        assistant_message=reply, status="completed",
    )
    artifact = AgentArtifact.objects.create(
        website=website, kind="report", title="Private question about pricing",
    )
    admin_user = django_user_model.objects.create_superuser(
        email="ops@example.com", password="z" * 16, full_name="Ops",
    )
    client.force_login(admin_user)

    for url in (
        reverse("admin:agent_agentrun_changelist"),
        reverse("admin:agent_agentrun_change", args=[run.pk]),
        reverse("admin:agent_agentartifact_changelist"),
        reverse("admin:agent_agentartifact_change", args=[artifact.pk]),
    ):
        page = client.get(url)
        assert page.status_code == 200, url
        body = page.content.decode()
        assert "Private question" not in body, url
        assert "Secret text" not in body, url

    assert client.get(reverse("admin:agent_agentrun_add")).status_code == 403
    assert client.post(reverse("admin:agent_agentrun_delete", args=[run.pk])).status_code == 403
    # Chats and messages have no admin at all.
    with pytest.raises(NoReverseMatch):
        reverse("admin:agent_agentchat_changelist")
    with pytest.raises(NoReverseMatch):
        reverse("admin:agent_agentmessage_changelist")
