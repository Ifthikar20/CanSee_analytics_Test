"""A re-run turn (trigger ``rerun``): the runner runs one version of a
research swarm with no model request of its own, adds the summary text
and stores it as the turn's wire."""
import sys
import types
from dataclasses import dataclass

import pytest

from apps.agent.models import AgentMessage, AgentRun, AgentSwarmVersion
from apps.agent.runtime.dispatch import dispatch_run
from apps.agent.runtime.registry import get_registry
from apps.agent.runtime.swarm.plan import PlanOptions
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import event_types, run_events
from apps.agent.tests.swarm_support import *  # noqa: F403
from apps.agent.tests.swarm_support import (
    engine_answer,
    fake_engine_scan,
    fake_serp,
    make_run,
    make_swarm,
    plan_prompts,
    serp_payload,
)

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("swarm_limits", "engines_on")]

SMALL = PlanOptions(title="Research Northwind", content_gaps=False, citations=False,
                    competitor_pages=0)
YOURS = "https://northwind.example/crm"


@pytest.fixture
def engines_on(settings):
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"


@dataclass
class Stubbed:
    table: dict | None
    tool_result: dict
    summary: str
    summary_text: str
    wire_text: str


def _finalize_with(monkeypatch, finalize) -> None:
    """Replace swarm_tables.finalize_version (its module is BE-api's)."""
    try:
        import apps.agent.services.swarm_tables as module
    except ImportError:
        module = types.ModuleType("apps.agent.services.swarm_tables")
        monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setattr(module, "finalize_version", finalize, raising=False)


def _stub(calls: list):
    def finalize(ctx, swarm, version, outcome):
        calls.append(outcome)
        text = f"Re-ran {len(outcome.results)} agents: {outcome.status}."
        return Stubbed(table={"status": outcome.status}, tool_result={}, summary=text,
                       summary_text=text, wire_text=f"{text}\n\n| Prompt |\n|---|")
    return finalize


def _queued_rerun(chat):
    """A finished research (version 1) and a queued re-run of it (version 2)."""
    first = make_run(chat, status="completed")
    swarm, version_one = make_swarm(chat, first, plan_prompts(chat.website, 1), options=SMALL,
                                    version_status="done")
    AgentSwarmVersion.objects.filter(id=version_one.id).update(results={
        t["id"]: {"id": t["id"], "status": "done", "result": "earlier", "rev": 4}
        for t in swarm.tasks})
    run = make_run(chat, trigger="rerun", status="queued", parent=first.assistant_message)
    version = AgentSwarmVersion.objects.create(
        swarm=swarm, version=2, scope="all", task_ids=[t["id"] for t in swarm.tasks],
        status="queued", run=run, message=run.assistant_message)
    return swarm, version, run


def _research(monkeypatch, *, on_search=None):
    def page(query, number):
        if on_search is not None:
            on_search()
        return serp_payload([("https://hubspot.com/crm", "HubSpot CRM"), (YOURS, "Northwind")])

    fake_serp(monkeypatch, page)
    return fake_engine_scan(monkeypatch, {
        "gpt4": engine_answer(brands=[("HubSpot", 1)]),
        "claude": engine_answer(mentioned=True, rank=2, brands=[("HubSpot", 1)])})


def test_a_rerun_turn_runs_the_version_without_a_model_request(chat, monkeypatch,
                                                               routed_anthropic):
    calls = []
    _finalize_with(monkeypatch, _stub(calls))
    _research(monkeypatch)
    swarm, version, run = _queued_rerun(chat)

    dispatch_run(run.id)

    run.refresh_from_db()
    message = AgentMessage.objects.get(id=run.assistant_message_id)
    assert (run.status, message.status) == ("completed", "complete")
    assert routed_anthropic.requests == []
    assert len(routed_anthropic.haiku_requests) == 2
    swarm_part, text_part = message.parts
    assert (swarm_part["type"], swarm_part["version"], swarm_part["status"]) == (
        "swarm", 2, "done")
    assert (swarm_part["scope"], swarm_part["scope_label"]) == ("all", "All agents")
    assert [t["status"] for t in swarm_part["tasks"]] == ["done", "done", "done"]
    assert text_part == {"id": text_part["id"], "type": "text", "request": 1,
                         "text": "Re-ran 3 agents: done.", "citations": []}
    assert json_wire(message) == [{"role": "assistant", "content": [
        {"type": "text", "text": "Re-ran 3 agents: done.\n\n| Prompt |\n|---|"}]}]
    version.refresh_from_db()
    assert version.status == "done"
    assert version.counts == {"total": 3, "done": 3, "failed": 0, "skipped": 0, "stopped": 0}
    assert version.worker_requests == 2
    [outcome] = calls
    assert (outcome.part_id, outcome.request, outcome.cancelled) == (swarm_part["id"], 1, False)
    types_ = event_types(run)
    assert types_[0] == "run.started" and types_[-1] == "run.completed"
    assert types_.count("part.added") == 2
    assert "turn.reset" not in types_ and "chat.updated" not in types_


def test_stop_during_a_rerun_keeps_what_finished(chat, monkeypatch, routed_anthropic):
    calls = []
    _finalize_with(monkeypatch, _stub(calls))
    holder = {}
    _research(monkeypatch, on_search=lambda: get_registry().cancel_local(holder["run"].id))
    swarm, version, run = _queued_rerun(chat)
    holder["run"] = run

    dispatch_run(run.id)

    run.refresh_from_db()
    message = AgentMessage.objects.get(id=run.assistant_message_id)
    assert (run.status, message.status) == ("cancelled", "cancelled")
    swarm_part, text_part = message.parts
    assert swarm_part["status"] == "cancelled"
    first, *rest = swarm_part["tasks"]
    assert (first["status"], first["error"]["message"]) == ("stopped", "Stopped")
    assert all(t["error"]["message"] == "Stopped before it started" for t in rest)
    assert text_part["text"] == "Re-ran 3 agents: cancelled."
    version.refresh_from_db()
    assert version.status == "cancelled"
    assert routed_anthropic.haiku_requests == []
    assert calls[0].cancelled is True
    assert event_types(run)[-1] == "run.cancelled"


def test_a_rerun_with_the_real_consolidation(chat, monkeypatch, routed_anthropic):
    pytest.importorskip("apps.agent.services.swarm_tables")
    _research(monkeypatch)
    swarm, version, run = _queued_rerun(chat)

    dispatch_run(run.id)

    run.refresh_from_db()
    message = AgentMessage.objects.get(id=run.assistant_message_id)
    assert run.status == "completed"
    kinds = [p["type"] for p in message.parts]
    assert kinds == ["swarm", "swarm_table", "text"]
    swarm_part, table_part, text_part = message.parts
    assert swarm_part["table_version"] == 2
    assert (table_part["version"], table_part["swarm_id"]) == (2, str(swarm.id))
    assert text_part["text"]
    [wire] = json_wire(message)
    assert wire["content"][0]["text"].startswith(text_part["text"])
    version.refresh_from_db()
    swarm.refresh_from_db()
    assert version.table is not None and swarm.latest_version == 2
    assert routed_anthropic.requests == []


def test_a_rerun_that_cannot_find_its_version_fails_cleanly(chat):
    run = make_run(chat, trigger="rerun", status="queued")

    dispatch_run(run.id)

    run.refresh_from_db()
    assert run.status == "failed"
    assert run_events(run)[-1]["type"] == "run.failed"
    assert AgentRun.objects.filter(status__in=["queued", "running"]).count() == 0


def json_wire(message) -> list:
    import json

    return json.loads(message.wire)
