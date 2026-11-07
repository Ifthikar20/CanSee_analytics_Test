"""AGENT_CHAT_RETENTION_DAYS: idle chats are deleted by a daily beat task;
0 (the default) keeps every chat."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.agent.models import AgentArtifact, AgentChat, AgentMessage
from apps.agent.services.chats import purge_expired_chats
from apps.agent.tasks import purge_expired_agent_chats
from apps.agent.tests.api_support import add_message, add_run, make_chat

pytestmark = pytest.mark.django_db


def _idle_chat(user, website, snapshot, *, days: int):
    chat = make_chat(user, website, snapshot)
    question = add_message(chat, text="How do we rank?")
    AgentChat.objects.filter(id=chat.id).update(
        last_message_at=timezone.now() - timedelta(days=days),
    )
    return chat, question


def test_zero_keeps_every_chat(user, website, snapshot, settings):
    settings.AGENT_CHAT_RETENTION_DAYS = 0
    _idle_chat(user, website, snapshot, days=400)

    assert purge_expired_chats() == 0
    assert AgentChat.objects.count() == 1


def test_idle_chats_are_deleted_and_their_artifacts_stay(user, website, snapshot, settings):
    settings.AGENT_CHAT_RETENTION_DAYS = 30
    old, _ = _idle_chat(user, website, snapshot, days=40)
    recent, _ = _idle_chat(user, website, snapshot, days=5)
    busy, question = _idle_chat(user, website, snapshot, days=60)
    reply = add_message(busy, parent=question, role="assistant", text="Working on it")
    add_run(busy, question, reply, status="running", heartbeat_at=timezone.now())
    never_used = make_chat(user, website, snapshot)
    AgentChat.objects.filter(id=never_used.id).update(
        created_at=timezone.now() - timedelta(days=90),
    )
    report = AgentArtifact.objects.create(
        website=website, kind="report", agent_key="gap_analyst", title="Report",
        source_chat=old, created_by=user,
    )

    assert purge_expired_agent_chats() == 2

    assert set(AgentChat.objects.values_list("id", flat=True)) == {recent.id, busy.id}
    assert not AgentMessage.objects.filter(chat_id=old.id).exists()
    report.refresh_from_db()
    assert report.source_chat_id is None and report.deleted_at is None


def test_beat_purges_daily_off_the_default_queue():
    from config.celery import app

    entry = app.conf.beat_schedule["purge-expired-agent-chats"]
    assert entry["task"] == "apps.agent.tasks.purge_expired_agent_chats"
    assert entry["schedule"].hour == {3} and entry["schedule"].minute == {40}
    assert app.conf.task_routes[entry["task"]] == {"queue": "integrations"}
