"""Stale runs, the process registry and chat titles."""

import json
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.agent.models import AgentChat, AgentMessage, AgentRun
from apps.agent.runtime import wire
from apps.agent.runtime.events import get_event_store
from apps.agent.runtime.registry import LIVE_HEARTBEAT_CACHE_KEY, get_registry
from apps.agent.runtime.sweeper import sweep_chat, sweep_stale_runs
from apps.agent.runtime.title import fallback_title
from apps.agent.tasks import sweep_stale_agent_runs
from apps.agent.tests.fakes import http_error, message, refusal, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat, run_events, send

pytestmark = pytest.mark.django_db

OPEN_CALL = {"type": "tool_use", "id": "toolu_open", "name": "list_artifacts", "input": {}}


def _running_run(chat, *, beat_age: int | None, status="running", executor_id="host:1:1"):
    user_msg = AgentMessage.objects.create(chat=chat, role="user", parts=[])
    reply = AgentMessage.objects.create(
        chat=chat, parent=user_msg, role="assistant", status="streaming",
        wire=wire.dumps([wire.assistant_message([{"type": "text", "text": "Looking"}, OPEN_CALL])]),
        parts=[{"id": "p1", "type": "tool", "request": 1, "status": "running", "name": "x"},
               {"id": "p2", "type": "thinking", "request": 1, "text": "t", "ended_at": None}],
    )
    beat = timezone.now() - timedelta(seconds=beat_age) if beat_age is not None else None
    return AgentRun.objects.create(
        chat=chat, user=chat.user, website=chat.website, user_message=user_msg,
        assistant_message=reply, status=status, heartbeat_at=beat, executor_id=executor_id,
    )


def test_sweeper_interrupts_stale_runs_and_leaves_valid_wire(chat, user, website):
    stale = _running_run(chat, beat_age=600)
    fresh = _running_run(make_chat(user, website), beat_age=5)
    get_event_store().open(str(stale.id))

    assert sweep_stale_agent_runs() == 1

    stale.refresh_from_db()
    fresh.refresh_from_db()
    assert stale.status == "interrupted" and stale.error_code == "interrupted"
    assert fresh.status == "running"
    msg = AgentMessage.objects.get(id=stale.assistant_message_id)
    assert msg.status == "interrupted"
    stored = json.loads(msg.wire)
    assert stored[-1] == wire.stopped_results(["toolu_open"])
    assert msg.parts[0]["status"] == "error" and msg.parts[1]["ended_at"]
    events = get_event_store().read(str(stale.id), 0).events
    assert events[-1]["type"] == "run.interrupted" and events[-1]["reason"] == "stale"
    # Idempotent: nothing left to sweep.
    assert sweep_stale_runs() == 0


def test_queued_runs_without_a_heartbeat_age_from_creation(chat):
    run = _running_run(chat, beat_age=None, status="queued")
    AgentRun.objects.filter(id=run.id).update(created_at=timezone.now() - timedelta(hours=1))
    assert sweep_chat(chat.id) == 1
    run.refresh_from_db()
    assert run.status == "interrupted"


def test_heartbeat_refreshes_runs_and_notices_lost_and_stopped_ones(chat, user, website):
    registry = get_registry()
    me = registry.executor_id
    alive = _running_run(chat, beat_age=60, executor_id=me)
    lost = _running_run(make_chat(user, website), beat_age=60, status="interrupted",
                        executor_id=me)
    stopped = _running_run(make_chat(user, website), beat_age=60, executor_id=me)
    AgentRun.objects.filter(id=stopped.id).update(cancel_requested_at=timezone.now())
    handles = {r.id: registry.register(r.id) for r in (alive, lost, stopped)}

    registry.beat()

    alive.refresh_from_db()
    assert (timezone.now() - alive.heartbeat_at).total_seconds() < 5
    assert not handles[alive.id].cancelled
    assert handles[lost.id].cancelled and handles[lost.id].lost
    assert handles[stopped.id].cancelled and not handles[stopped.id].lost
    from django.core.cache import cache
    assert cache.get(LIVE_HEARTBEAT_CACHE_KEY)


def test_orphans_of_an_earlier_process_on_this_host_are_interrupted(chat):
    registry = get_registry()
    host = registry.executor_id.split(":", 1)[0]
    orphan = _running_run(chat, beat_age=1, executor_id=f"{host}:999999:1")
    assert registry.recover_orphans() == 1
    orphan.refresh_from_db()
    assert orphan.status == "interrupted"
    assert registry.recover_orphans() == 0


def test_runner_respects_a_lost_run(fake_anthropic, chat, monkeypatch):
    """When the sweeper ends a run mid-flight, the runner does not overwrite it."""
    from apps.agent.runtime import runner

    original = runner.TurnRunner._gate

    def gate(self):
        AgentRun.objects.filter(id=self.run.id).update(status="interrupted")
        self.active.lost = True
        self.active.cancel()
        return original(self)

    monkeypatch.setattr(runner.TurnRunner, "_gate", gate)
    monkeypatch.setattr("apps.agent.runtime.title.generate_title", lambda run, emitter=None: None)

    started = send(chat, "Hi")

    run = AgentRun.objects.get(id=started.run.id)
    assert run.status == "interrupted"
    assert run_events(run)[-1]["type"] == "run.interrupted"
    assert fake_anthropic.requests == []


def test_first_turn_gets_a_model_title(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Here is the research.")),
                         message(text('{"title": "Northwind vs HubSpot on Google."}')))

    question = "Research how Northwind ranks against HubSpot for best crm please"
    started = send(chat, question)

    chat.refresh_from_db()
    assert chat.title == "Northwind vs HubSpot on Google"
    assert chat.title_source == "model"
    title_request = fake_anthropic.requests[1]
    assert not title_request.streamed
    assert title_request.json["output_config"]["effort"] == "low"
    assert title_request.json["output_config"]["format"]["type"] == "json_schema"
    events = run_events(started.run)
    titles = [e["title"] for e in events if e["type"] == "chat.updated"]
    # The first message's title right away, then the model's, before the end.
    assert titles == [fallback_title(question), "Northwind vs HubSpot on Google"]
    assert events[-1]["type"] == "run.completed"


def test_title_falls_back_to_the_message_and_never_overrides_the_user(fake_anthropic, chat, user,
                                                                       website):
    text_in = "Research how Northwind ranks against HubSpot for best crm in the United States"
    fake_anthropic.queue(message(text("Done.")), http_error(500, "api_error", "boom"))
    send(chat, text_in)
    chat.refresh_from_db()
    assert chat.title == fallback_title(text_in) and chat.title_source == "auto"
    assert len(chat.title) <= 60 and text_in.startswith(chat.title)

    named = make_chat(user, website)
    AgentChat.objects.filter(id=named.id).update(title="My chat", title_source="user")
    named.refresh_from_db()
    before = len(fake_anthropic.requests)
    fake_anthropic.queue(message(text("Done.")))
    send(named, "Anything")
    named.refresh_from_db()
    assert (named.title, named.title_source) == ("My chat", "user")
    assert len(fake_anthropic.requests) == before + 1


def test_a_refused_title_keeps_the_fallback(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Done.")), refusal())
    send(chat, "Compare us with HubSpot")
    chat.refresh_from_db()
    assert (chat.title, chat.title_source) == ("Compare us with HubSpot", "auto")


def test_fallback_title_cuts_on_a_word_boundary():
    assert fallback_title("short one") == "short one"
    long = "word " * 30
    cut = fallback_title(long)
    assert len(cut) <= 60 and cut.endswith("word")
    assert fallback_title("a" * 80) == "a" * 60
