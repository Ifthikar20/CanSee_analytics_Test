"""Model constraints and storage guarantees the runtime relies on."""

import json

import pytest
from django.db import IntegrityError, transaction

from apps.agent.constants import (
    ArtifactContentType,
    ArtifactKind,
    MessageRole,
    MessageStatus,
    RunStatus,
)
from apps.agent.models import (
    AgentArtifact,
    AgentArtifactVersion,
    AgentBrandContext,
    AgentChat,
    AgentMessage,
    AgentRun,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def chat(user, website, snapshot):
    return AgentChat.objects.create(website=website, user=user, snapshot=snapshot)


def _turn(chat, parent=None):
    """A user message and its (streaming) assistant reply."""
    user_msg = AgentMessage.objects.create(
        chat=chat, parent=parent, role=MessageRole.USER,
        depth=(parent.depth + 1) if parent else 0,
    )
    reply = AgentMessage.objects.create(
        chat=chat, parent=user_msg, role=MessageRole.ASSISTANT,
        depth=user_msg.depth + 1, status=MessageStatus.STREAMING,
    )
    return user_msg, reply


def _run(chat, user_msg, reply, **fields):
    return AgentRun.objects.create(
        chat=chat, user=chat.user, website=chat.website,
        user_message=user_msg, assistant_message=reply, **fields,
    )


def test_defaults(chat):
    assert chat.entry_agent == "gap_analyst"
    assert chat.title_source == "auto"
    user_msg, reply = _turn(chat)
    assert user_msg.wire == "[]"
    assert user_msg.parts == [] and user_msg.research == {}
    run = _run(chat, user_msg, reply)
    assert run.status == RunStatus.QUEUED
    assert run.trigger == "send"
    assert reply.run == run


def test_one_active_run_per_chat(chat):
    first_user, first_reply = _turn(chat)
    first = _run(chat, first_user, first_reply, status=RunStatus.RUNNING)
    second_user, second_reply = _turn(chat, parent=first_reply)

    with pytest.raises(IntegrityError), transaction.atomic():
        _run(chat, second_user, second_reply, status=RunStatus.QUEUED)

    first.status = RunStatus.COMPLETED
    first.save(update_fields=["status"])
    second = _run(chat, second_user, second_reply, status=RunStatus.QUEUED)
    assert second.pk


def test_active_runs_in_different_chats_are_independent(user, website, snapshot):
    a = AgentChat.objects.create(website=website, user=user, snapshot=snapshot)
    b = AgentChat.objects.create(website=website, user=user, snapshot=snapshot)
    _run(a, *_turn(a), status=RunStatus.RUNNING)
    _run(b, *_turn(b), status=RunStatus.RUNNING)
    assert AgentRun.objects.filter(status=RunStatus.RUNNING).count() == 2


def test_idempotency_key_is_unique_per_user(user, website, snapshot, django_user_model):
    a = AgentChat.objects.create(website=website, user=user, snapshot=snapshot)
    b = AgentChat.objects.create(website=website, user=user, snapshot=snapshot)
    first = _run(a, *_turn(a), idempotency_key="key-1")
    first.status = RunStatus.COMPLETED
    first.save(update_fields=["status"])

    with pytest.raises(IntegrityError), transaction.atomic():
        _run(b, *_turn(b), idempotency_key="key-1")

    # Runs without a key never collide.
    _run(b, *_turn(b))
    c = AgentChat.objects.create(website=website, user=user, snapshot=snapshot)
    _run(c, *_turn(c))
    assert AgentRun.objects.filter(idempotency_key__isnull=True).count() == 2

    # The same key from another user is a different request.
    other = django_user_model.objects.create_user(
        email="other@example.com", password="y" * 16, full_name="Other",
    )
    other_chat = AgentChat.objects.create(website=website, user=other, snapshot=snapshot)
    _run(other_chat, *_turn(other_chat), idempotency_key="key-1")


def test_wire_round_trips_nul_and_unicode(chat):
    wire = [{"role": "user", "content": [{"type": "text", "text": "a\u0000b – naïve"}]}]
    user_msg, _ = _turn(chat)
    user_msg.wire = json.dumps(wire, ensure_ascii=False)
    user_msg.save(update_fields=["wire"])

    user_msg.refresh_from_db()
    assert json.loads(user_msg.wire) == wire


def test_artifact_versions_are_unique_per_artifact(chat, website, user):
    artifact = AgentArtifact.objects.create(
        website=website, kind=ArtifactKind.REPORT, title="Report", created_by=user,
        source_chat=chat,
    )
    fields = dict(content="# Report", content_type=ArtifactContentType.MARKDOWN, sha256="0" * 64)
    AgentArtifactVersion.objects.create(artifact=artifact, version=1, **fields)

    with pytest.raises(IntegrityError), transaction.atomic():
        AgentArtifactVersion.objects.create(artifact=artifact, version=1, **fields)

    AgentArtifactVersion.objects.create(artifact=artifact, version=2, **fields)
    assert list(artifact.versions.order_by("version").values_list("version", flat=True)) == [1, 2]


def test_deleting_a_chat_keeps_its_artifacts(chat, website, user):
    user_msg, reply = _turn(chat)
    run = _run(chat, user_msg, reply, status=RunStatus.COMPLETED)
    chat.current_leaf = reply
    chat.save(update_fields=["current_leaf"])
    artifact = AgentArtifact.objects.create(
        website=website, kind=ArtifactKind.PAGE, title="Landing page", source_chat=chat,
        source_message=reply,
    )
    version = AgentArtifactVersion.objects.create(
        artifact=artifact, version=1, content="<!DOCTYPE html>", sha256="1" * 64,
        content_type=ArtifactContentType.HTML, run=run,
    )
    reply.saved_report = artifact
    reply.save(update_fields=["saved_report"])

    chat.delete()

    artifact.refresh_from_db()
    version.refresh_from_db()
    assert artifact.source_chat_id is None
    assert artifact.source_message_id is None
    assert version.run_id is None
    assert not AgentMessage.objects.exists()
    assert not AgentRun.objects.exists()


def test_the_legacy_brand_context_is_one_row_per_website(website):
    """Kept as a legacy table (migration 0003 moved it into context entries)."""
    AgentBrandContext.objects.create(website=website, audience="Small teams")
    with pytest.raises(IntegrityError), transaction.atomic():
        AgentBrandContext.objects.create(website=website, audience="Duplicate")
    assert website.agent_brand_context.revision == 0
    assert "legacy" in AgentBrandContext.__doc__.lower()


def test_context_and_review_rows_go_with_their_parents(website, user):
    from apps.agent.models import (
        AgentArtifactReview,
        AgentContextDocument,
        AgentContextEntry,
        AgentContextReference,
        AgentReviewEvent,
    )

    entry = AgentContextEntry.objects.create(website=website, section="company", title="x")
    document = AgentContextDocument.objects.create(website=website, title="Doc", text="t", chars=1)
    AgentContextReference.objects.create(entry=entry, website=website, kind="document",
                                         document=document)
    document.delete()
    assert AgentContextEntry.objects.filter(pk=entry.pk).exists()
    assert not AgentContextReference.objects.exists()
    artifact = AgentArtifact.objects.create(website=website, kind="document", title="Doc")
    AgentArtifactReview.objects.create(artifact=artifact, website=website)
    AgentReviewEvent.objects.create(artifact=artifact, website=website, actor=user,
                                    kind="comment", version=0)
    assert (entry.revision, entry.status, entry.origin) == (1, "active", "user")
    artifact.delete()
    assert not AgentArtifactReview.objects.exists() and not AgentReviewEvent.objects.exists()


def test_snapshot_is_protected_while_a_chat_uses_it(chat, snapshot):
    from django.db.models import ProtectedError

    with pytest.raises(ProtectedError):
        snapshot.delete()
