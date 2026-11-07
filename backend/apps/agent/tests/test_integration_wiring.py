"""Seams between the runtime and the API services: one version writer,
one heartbeat key, one set of agent display names."""
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest

from apps.agent.models import AgentArtifact
from apps.agent.tests.api_support import add_message, add_run, make_chat


@pytest.mark.django_db
def test_writer_versions_go_through_the_one_version_writer(user, website, snapshot, monkeypatch):
    from apps.agent.services import artifacts
    from apps.agent.subagents import base, landing_page

    calls = []
    real = artifacts.add_version

    def spy(artifact, **kwargs):
        calls.append(kwargs)
        return real(artifact, **kwargs)

    monkeypatch.setattr(artifacts, "add_version", spy)
    chat = make_chat(user, website, snapshot)
    question = add_message(chat, text="Write a landing page")
    reply = add_message(chat, parent=question, role="assistant", text="")
    run = add_run(chat, question, reply, status="running")
    ctx = SimpleNamespace(website=website, user=user, chat=chat, run=run)
    validated = base.Validated(
        content="<!DOCTYPE html><html><body>Hi\x00</body></html>",
        warnings=[{"path": "script\x00", "message": "Removed a script."}],
        summary="H1: Hi",
    )
    artifact_id = uuid.uuid4()

    first = base._save_version(ctx, landing_page.SPEC, artifact_id=artifact_id, existing=False,
                               title="CRM page", validated=validated, cost=Decimal("0.5"))
    second = base._save_version(ctx, landing_page.SPEC, artifact_id=artifact_id, existing=True,
                                title="CRM page, shorter", validated=validated,
                                cost=Decimal("0.25"))

    assert (first, second) == (1, 2) and len(calls) == 2
    artifact = AgentArtifact.objects.get(id=artifact_id)
    assert (artifact.latest_version, artifact.title, artifact.kind) == (
        2, "CRM page, shorter", "page")
    assert artifact.source_chat_id == chat.id and artifact.source_message_id == reply.id
    version = artifact.versions.get(version=2)
    assert "\x00" not in version.content
    assert version.warnings == [{"path": "script", "message": "Removed a script."}]
    assert (version.content_type, version.source, version.run_id) == ("text/html", "agent", run.id)
    assert version.cost_usd == Decimal("0.25") and version.size_bytes == len(version.content)


def test_status_reads_the_heartbeat_key_the_agent_process_writes():
    from apps.agent.runtime import registry
    from apps.agent.services import catalog

    assert catalog.LIVE_HEARTBEAT_CACHE_KEY == registry.LIVE_HEARTBEAT_CACHE_KEY


def test_agent_call_parts_use_the_catalog_names():
    from apps.agent.services.catalog import agent_name, agents
    from apps.agent.subagents.base import _specs

    names = {entry["key"]: entry["name"] for entry in agents()}
    for key in _specs():
        assert agent_name(key) == names[key]
    assert names == {"gap_analyst": "Gap Analyst", "landing_page": "Landing Page Agent",
                     "aeo_article": "AEO Article Agent", "ad_campaign": "Ad Campaign Agent",
                     "page_optimizer": "Page Optimizer", "llms_txt": "llms.txt Agent",
                     "comparison_page": "Comparison Page Agent",
                     "social_posts": "Social Posts Agent", "pr_writer": "PR Agent",
                     "messaging_brief": "Messaging Agent"}
