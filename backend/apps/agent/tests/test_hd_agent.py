"""Hardening tests for the agent runtime: starting runs with a report
template or an engine limit, the template registry and catalog, the
writer's note, the saved report header, the run's deadline and cost
ceiling (engine spend included) and the research agents' time limits.

Each test pins a decision a hand mutation of the code showed was not
covered before."""
from __future__ import annotations

import time
from decimal import Decimal
from types import SimpleNamespace

import pytest

from apps.agent import report_templates
from apps.agent.models import AgentMessage, AgentRun, AgentSwarmVersion
from apps.agent.runtime import wire
from apps.agent.tests.api_support import client_for, error
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events, send

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]

API = "/api/v1/agent"


def _note_of(user_message) -> str:
    return "\n\n".join(block["text"] for m in wire.loads(user_message.wire)
                       if m["role"] == "system" for block in m["content"])


def _send_url(chat):
    return f"{API}/live/websites/{chat.website_id}/chats/{chat.id}/messages/"


# ── Templates on a send, a regenerate and an edit ─────────────────────────


def test_a_stale_template_key_on_a_reply_is_not_carried_by_regenerate(
        fake_anthropic, chat, user, website):
    """A reply whose research names a template that no longer exists, and
    whose user message names none, is regenerated without a template."""
    from apps.agent.services.runs import start_regenerate

    fake_anthropic.queue(message(text("One")), message(text("Two")))
    first = send(chat, "Go")
    AgentMessage.objects.filter(id=first.assistant_message.id).update(
        research={"template": "weekly_digest"})
    regen = start_regenerate(user=user, website=website, message_id=first.assistant_message.id)
    assert regen.assistant_message.research == {}


def test_a_stale_research_key_falls_back_to_the_template_in_the_user_note(
        fake_anthropic, chat, user, website):
    from apps.agent.services.runs import start_regenerate

    fake_anthropic.queue(message(text("# One")), message(text("# Two")))
    first = send(chat, "Go", template="executive_summary")
    AgentMessage.objects.filter(id=first.assistant_message.id).update(
        research={"template": "weekly_digest"})
    regen = start_regenerate(user=user, website=website, message_id=first.assistant_message.id)
    assert regen.assistant_message.research == {"template": "executive_summary"}


def test_an_edit_naming_an_unavailable_template_is_refused_and_starts_nothing(
        fake_anthropic, chat, user, website, settings):
    from apps.agent.services.runs import TemplateUnavailable, start_edit

    fake_anthropic.queue(message(text("Hello.")))
    first = send(chat, "Hi")
    runs_before = AgentRun.objects.count()
    messages_before = AgentMessage.objects.count()
    settings.INSIGHTS_ENABLED = False
    with pytest.raises(TemplateUnavailable) as caught:
        start_edit(user=user, website=website, message_id=first.user_message.id,
                   text="How do the engines describe us?", template="brand_accuracy")
    assert caught.value.code == "template_unavailable"
    assert "Sentiment and Fact check" in caught.value.message
    assert AgentRun.objects.count() == runs_before
    assert AgentMessage.objects.count() == messages_before


def test_an_edit_that_keeps_a_template_the_workspace_lost_is_refused(
        fake_anthropic, chat, user, website, settings):
    from apps.agent.services.runs import TemplateUnavailable, start_edit

    settings.INSIGHTS_ENABLED = True
    fake_anthropic.queue(message(text("# Accuracy")))
    first = send(chat, "How do engines describe us?", template="brand_accuracy")
    settings.INSIGHTS_ENABLED = False
    with pytest.raises(TemplateUnavailable):
        start_edit(user=user, website=website, message_id=first.user_message.id, text="Again")


@pytest.mark.parametrize("template", [["executive_summary"], {"key": "executive_summary"}, 7])
def test_a_template_that_is_not_a_string_is_400(chat, user, template):
    resp = client_for(user).post(_send_url(chat), {"text": "Go", "template": template},
                                 format="json")
    assert resp.status_code == 400
    assert (error(resp)["code"], error(resp)["message"]) == ("invalid", "Unknown report template.")
    assert not AgentRun.objects.exists()


@pytest.mark.parametrize("key", [None, "", 3, ["change_log"], {"change_log": 1}, "CHANGE_LOG"])
def test_the_registry_lookup_only_answers_exact_string_keys(key):
    assert report_templates.get(key) is None


def test_the_prompt_section_of_a_template_repeats_per_prompt_in_the_note(fake_anthropic, chat):
    fake_anthropic.queue(message(text("# Gap")))
    started = send(chat, "Gap report", template="google_ai_gap")
    note = _note_of(started.user_message)
    assert "3. One section per prompt, titled with the prompt: What Google shows" in note
    assert "3. Prompt:" not in note
    assert "1. Summary: Three sentences on where the brand stands." in note
    assert "5. Method: When the data was captured" in note


def test_the_note_forbids_filling_unmeasured_sections_from_memory(fake_anthropic, chat):
    fake_anthropic.queue(message(text("# Summary")))
    started = send(chat, "Summary", template="executive_summary")
    note = _note_of(started.user_message)
    assert note.rstrip().endswith(
        "- Every number comes from a tool result in this chat. Write a section whose data was "
        "not measured or is not configured as exactly that; never fill it from your own "
        "knowledge.")


def test_outline_lines_are_numbered_from_one_in_section_order():
    template = report_templates.get("change_log")
    lines = report_templates.outline_lines(template)
    assert len(lines) == len(template.sections) == 5
    assert [line.split(".", 1)[0] for line in lines] == ["1", "2", "3", "4", "5"]
    assert lines[0].startswith("1. What changed: ")
    assert lines[-1].startswith("5. Method: ")


# ── The engine limit belongs to its own run ───────────────────────────────


@pytest.mark.parametrize("engines", [[1], ["chatgpt", None], [["claude"]]])
def test_engines_that_are_not_strings_are_400_with_the_list_message(chat, user, engines):
    resp = client_for(user).post(_send_url(chat), {"text": "Hi", "engines": engines},
                                 format="json")
    assert resp.status_code == 400
    assert (error(resp)["code"], error(resp)["message"]) == (
        "invalid", "engines must be a list of engine keys.")
    assert not AgentRun.objects.exists()


def test_an_unknown_engine_names_the_first_unknown_key_and_the_valid_ones(chat, user):
    resp = client_for(user).post(_send_url(chat),
                                 {"text": "Hi", "engines": ["claude", "bing", "deepthought"]},
                                 format="json")
    assert resp.status_code == 400
    assert error(resp)["message"] == (
        "Unknown engine: bing. Use chatgpt, claude, gemini, grok, perplexity.")


def test_an_empty_engine_list_sets_no_limit(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Hello.")))
    run = send(chat, "Hi", engines=[]).run
    run.refresh_from_db()
    assert run.constraints == {}


def test_the_engine_limit_applies_only_to_the_run_it_was_sent_with(
        fake_anthropic, chat, user, website):
    """A later send, a regenerate and an edit in the same chat run with no
    engine limit unless they name one themselves."""
    from apps.agent.services.runs import start_edit, start_regenerate

    fake_anthropic.queue(*(message(text(f"Reply {n}.")) for n in range(5)))
    limited = send(chat, "Research us", engines=["claude"])
    later = send(chat, "Thanks")
    regen = start_regenerate(user=user, website=website,
                             message_id=limited.assistant_message.id)
    edit = start_edit(user=user, website=website, message_id=limited.user_message.id,
                      text="Research us again")
    other = send(chat, "And Gemini only", engines=["gemini"])

    def constraints(started):
        return AgentRun.objects.get(id=started.run.id).constraints

    assert constraints(limited) == {"engines": ["claude"]}
    assert constraints(later) == {}
    assert constraints(regen) == {}
    assert constraints(edit) == {}
    assert constraints(other) == {"engines": ["gemini"]}


# ── Research re-run version limit ─────────────────────────────────────────


@pytest.fixture
def held(monkeypatch):
    started = []
    monkeypatch.setattr("apps.agent.services.runs.dispatch_run", started.append)
    return started


def _versions_up_to(swarm, last: int) -> None:
    AgentSwarmVersion.objects.bulk_create([
        AgentSwarmVersion(swarm=swarm, version=n, scope="all", task_ids=[], status="done")
        for n in range(2, last + 1)
    ])


@pytest.mark.parametrize(("existing", "allowed"), [(49, True), (50, False)])
def test_a_rerun_may_add_the_fiftieth_version_but_not_the_fifty_first(
        user, chat, held, settings, existing, allowed):
    from apps.agent.constants import MAX_SWARM_VERSIONS
    from apps.agent.exceptions import VersionLimit
    from apps.agent.services.runs import start_rerun
    from apps.agent.tests.test_swarm_api import store_swarm

    assert MAX_SWARM_VERSIONS == 50
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0
    swarm = store_swarm(chat)
    _versions_up_to(swarm, existing)

    def rerun():
        return start_rerun(user=user, chat=chat, swarm=swarm, scope="all", scope_key="",
                           task_ids=["google.p1.page1"], text="Re-run all research agents")

    if allowed:
        started = rerun()
        assert started.extra["swarm_version"]["version"] == 50
        assert held == [started.run.id]
    else:
        with pytest.raises(VersionLimit):
            rerun()
        assert held == []
        assert AgentSwarmVersion.objects.filter(swarm=swarm).count() == 50


# ── The catalog ───────────────────────────────────────────────────────────


def _catalog(user):
    from apps.agent.tests.api_support import data

    resp = client_for(user).get(f"{API}/report-templates/")
    assert resp.status_code == 200, resp.content
    return {item["id"]: item for item in data(resp)}


def test_research_agents_off_is_a_limitation_only_of_templates_that_use_them(user, settings):
    settings.DEBUG = False
    settings.AGENT_SWARM_ENABLED = False
    settings.SERPAPI_KEY = "serp-test"
    catalog = _catalog(user)
    note = {"code": "research_agents_off",
            "message": "The research agents are turned off, so the agent runs single searches "
                       "and checks instead."}
    with_agents = {k for k, t in report_templates.TEMPLATES.items() if t.research_agents}
    assert with_agents == {"google_ai_gap", "competitor_comparison"}
    for key, item in catalog.items():
        assert (note in item["limitations"]) is (key in with_agents), key
    settings.AGENT_SWARM_ENABLED = True
    assert not any(n["code"] == "research_agents_off"
                   for item in _catalog(user).values() for n in item["limitations"])


def test_a_template_whose_tool_the_workspace_lacks_is_unavailable(user, settings, monkeypatch):
    from apps.agent.tools import registry

    settings.INSIGHTS_ENABLED = True
    settings.DEBUG = False
    real = registry.client_tool_definitions
    monkeypatch.setattr(registry, "client_tool_definitions", lambda *a, **k: [
        t for t in real(*a, **k) if t["name"] != "get_visibility_history"])
    catalog = _catalog(user)
    assert catalog["change_log"]["available"] is False
    assert catalog["change_log"]["unavailable"] == {
        "code": "tools_missing",
        "message": "Change log since the last run isn't available on this workspace."}
    # The tools_missing note names no setting, even for staff.
    user.is_staff = True
    user.save(update_fields=["is_staff"])
    assert "setting" not in _catalog(user)["change_log"]["unavailable"]
    # Templates that do not need the tool stay available.
    assert catalog["executive_summary"]["available"] is True


def test_a_send_with_a_template_the_workspace_lacks_a_tool_for_is_refused(
        chat, settings, monkeypatch):
    from apps.agent.services.runs import TemplateUnavailable
    from apps.agent.tools import registry

    real = registry.client_tool_definitions
    monkeypatch.setattr(registry, "client_tool_definitions", lambda *a, **k: [
        t for t in real(*a, **k) if t["name"] != "get_visibility_history"])
    with pytest.raises(TemplateUnavailable) as caught:
        send(chat, "What changed?", template="change_log")
    assert caught.value.message == (
        "Change log since the last run isn't available on this workspace.")
    assert not AgentRun.objects.exists()


def test_google_and_engines_missing_make_a_research_template_unavailable(user, settings):
    settings.DEBUG = False
    for name in ("SERPAPI_KEY", "SCRAPERAPI_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
                 "XAI_API_KEY", "PERPLEXITY_API_KEY", "ANTHROPIC_API_KEY"):
        setattr(settings, name, "")
    catalog = _catalog(user)
    for key in ("google_ai_gap", "competitor_comparison"):
        assert catalog[key]["unavailable"] == {
            "code": "nothing_configured",
            "message": "Google search and the AI engines aren't set up on this workspace."}
    # Templates that read saved data need neither.
    assert catalog["executive_summary"]["available"] is True
    assert catalog["sources_citations"]["available"] is True


# ── The saved header ──────────────────────────────────────────────────────


def _engine_part(engine, status, *, error=None, n="1"):
    return {"id": f"e{engine}{n}", "type": "engine_check", "request": 2, "prompt_id": "p1",
            "prompt_text": "best e-bike battery", "engine": engine, "engine_label": engine,
            "status": status, "mentioned": None, "rank": None, "sentiment": None,
            "error": error}


def _header(user, website, snapshot, parts, research=None):
    from apps.agent.tests.test_report_templates import _reply, _save

    parts = [*parts, {"id": "t1", "type": "text", "request": 3, "text": "# Report",
                      "citations": []}]
    reply = _reply(user, website, snapshot, parts=parts,
                   research=research or {"template": "executive_summary"})
    return _save(user, website, reply)["data"]["header"]


def test_an_engine_asked_once_is_asked_even_when_another_check_failed(
        user, website, snapshot, settings):
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    header = _header(user, website, snapshot, [
        _engine_part("chatgpt", "error", n="1"), _engine_part("chatgpt", "done", n="2"),
        _engine_part("claude", "error"),
    ])
    statuses = {e["key"]: e["status"] for e in header["engines"]}
    assert statuses["chatgpt"] == "asked"
    assert statuses["claude"] == "failed"


def test_an_unconfigured_engine_never_asked_is_not_configured(user, website, snapshot,
                                                               settings):
    settings.PERPLEXITY_API_KEY = ""
    settings.OPENAI_API_KEY = "sk-test"
    header = _header(user, website, snapshot, [])
    engines = {e["key"]: e for e in header["engines"]}
    assert (engines["perplexity"]["status"], engines["perplexity"]["configured"]) == (
        "not_configured", False)
    assert (engines["chatgpt"]["status"], engines["chatgpt"]["configured"]) == (
        "not_asked", True)


def test_failed_engine_checks_are_not_listed_as_captured_answers(user, website, snapshot,
                                                                  settings):
    settings.OPENAI_API_KEY = "sk-test"
    failed = _header(user, website, snapshot, [_engine_part("chatgpt", "error")])
    assert "engine_checks" not in [d["key"] for d in failed["data"]]
    answered = _header(user, website, snapshot, [_engine_part("chatgpt", "error"),
                                                 _engine_part("claude", "done")])
    assert "engine_checks" in [d["key"] for d in answered["data"]]


# ── The run's deadline and cost ceiling (llm.gate) ────────────────────────


@pytest.fixture
def limits(monkeypatch, settings):
    """A 600s deadline, a $1 ceiling, 5 requests and no allowance denial."""
    settings.AGENT_RUN_MAX_SECONDS = 600
    settings.AGENT_RUN_MAX_COST_USD = 1.0
    settings.AGENT_MAX_REQUESTS_PER_RUN = 5
    settings.AGENT_ENABLED = True
    monkeypatch.setattr("apps.agent.llm.gate.allowance_denial", lambda user: None)


def _ago(seconds: float) -> float:
    return time.monotonic() - seconds


def _gate(**kwargs):
    from apps.agent.llm.gate import before_request

    args = {"started_monotonic": _ago(0), "requests": 0, "cost_usd": Decimal("0"),
            "cancelled": False, **kwargs}
    return before_request(SimpleNamespace(user=None), **args)


@pytest.mark.usefixtures("limits")
@pytest.mark.parametrize(("elapsed", "stopped"), [(0, False), (599, False), (600.5, True),
                                                  (900, True)])
def test_the_deadline_stops_work_only_once_run_max_seconds_has_passed(elapsed, stopped):
    from apps.agent.llm.gate import GateStop, budget_stop

    stop = budget_stop(started_monotonic=_ago(elapsed), cost_usd=Decimal("0"))
    if not stopped:
        assert stop is None
        _gate(started_monotonic=_ago(elapsed))
        return
    assert stop.as_payload() == {"code": "run_timeout",
                                 "message": "This reply took too long and was stopped.",
                                 "retryable": True}
    with pytest.raises(GateStop) as caught:
        _gate(started_monotonic=_ago(elapsed))
    assert caught.value.code == "run_timeout"


@pytest.mark.usefixtures("limits")
@pytest.mark.parametrize(("cost", "stopped"), [("0", False), ("0.999999", False), ("1", True),
                                               ("1.000001", True), ("25", True)])
def test_the_cost_ceiling_stops_work_once_the_cost_reaches_it(cost, stopped):
    from apps.agent.llm.gate import GateStop, budget_stop

    stop = budget_stop(started_monotonic=_ago(0), cost_usd=Decimal(cost))
    if not stopped:
        assert stop is None
        _gate(cost_usd=Decimal(cost))
        return
    assert stop.as_payload() == {
        "code": "run_cost_limit",
        "message": "This reply reached the $1.00 cost limit for one reply.",
        "retryable": False}
    with pytest.raises(GateStop) as caught:
        _gate(cost_usd=Decimal(cost))
    assert caught.value.code == "run_cost_limit"


@pytest.mark.usefixtures("limits")
def test_past_both_limits_the_deadline_is_reported():
    from apps.agent.llm.gate import budget_stop

    assert budget_stop(started_monotonic=_ago(700), cost_usd=Decimal("5")).code == "run_timeout"


@pytest.mark.usefixtures("limits")
@pytest.mark.parametrize(("requests", "stopped"), [(4, False), (5, True), (6, True)])
def test_the_request_cap_allows_exactly_max_requests(requests, stopped):
    from apps.agent.llm.gate import GateStop

    if not stopped:
        _gate(requests=requests)
        return
    with pytest.raises(GateStop) as caught:
        _gate(requests=requests)
    assert (caught.value.code, caught.value.message) == (
        "request_limit", "This reply reached the limit of 5 model requests.")


@pytest.mark.usefixtures("limits")
def test_the_gate_checks_stop_then_switch_then_deadline_then_allowance_then_cost(
        monkeypatch, settings):
    from apps.agent.llm.gate import CancelRequested, GateStop

    late = _ago(700)
    with pytest.raises(CancelRequested):
        _gate(cancelled=True, started_monotonic=late, cost_usd=Decimal("9"), requests=9)
    settings.AGENT_ENABLED = False
    with pytest.raises(GateStop) as caught:
        _gate(started_monotonic=late, cost_usd=Decimal("9"), requests=9)
    assert caught.value.code == "agent_disabled"
    settings.AGENT_ENABLED = True
    monkeypatch.setattr("apps.agent.llm.gate.allowance_denial", lambda user: "denied")
    with pytest.raises(GateStop) as caught:
        _gate(started_monotonic=late, cost_usd=Decimal("9"), requests=9)
    assert caught.value.code == "run_timeout"
    with pytest.raises(GateStop) as caught:
        _gate(cost_usd=Decimal("9"), requests=9)
    assert caught.value.code == "allowance_exceeded"
    monkeypatch.setattr("apps.agent.llm.gate.allowance_denial", lambda user: None)
    with pytest.raises(GateStop) as caught:
        _gate(cost_usd=Decimal("9"), requests=9)
    assert caught.value.code == "run_cost_limit"


def test_a_run_past_its_deadline_before_a_request_fails_without_sending_it(
        fake_anthropic, chat, settings, monkeypatch):
    """Once AGENT_RUN_MAX_SECONDS has passed since the run started, the
    next model request is not sent and the run fails with run_timeout."""
    from apps.agent.llm import gate
    from apps.agent.tests.fakes import tool_use

    settings.AGENT_RUN_MAX_SECONDS = 600
    calls = {"n": 0}

    def later(run, *, started_monotonic, **kwargs):
        calls["n"] += 1
        # The second request is due 601 seconds after the run started.
        shift = 601 if calls["n"] >= 2 else 0
        return gate.before_request(run, started_monotonic=started_monotonic - shift, **kwargs)

    monkeypatch.setattr("apps.agent.runtime.runner.before_request", later)
    fake_anthropic.queue(message(tool_use("list_artifacts", {}), stop_reason="tool_use"),
                         message(text("Never sent.")))
    started = send(chat)
    run = AgentRun.objects.get(id=started.run.id)
    assert (run.status, run.error_code) == ("failed", "run_timeout")
    assert len(fake_anthropic.requests) == 1


# ── Research agents: task time limits, the research's time limit, cost ────


def _small():
    from apps.agent.runtime.swarm.plan import PlanOptions

    return PlanOptions(title="Research", content_gaps=False, citations=False,
                       competitor_pages=0)


def _use_workers(monkeypatch, worker):
    from apps.agent.constants import WorkerType
    from apps.agent.runtime.swarm import workers

    monkeypatch.setattr(workers, "WORKERS", {kind: worker for kind in (
        WorkerType.SERP_PAGE, WorkerType.ENGINE_ANSWER, WorkerType.PAGE_INSPECT,
        WorkerType.CONTENT_GAP, WorkerType.CITATIONS)})


def test_each_research_agent_has_its_contract_time_limit():
    from apps.agent.constants import WorkerType
    from apps.agent.runtime.swarm import executor

    assert executor.TASK_TIMEOUT == {
        WorkerType.SERP_PAGE: 90, WorkerType.ENGINE_ANSWER: 150, WorkerType.PAGE_INSPECT: 40,
        WorkerType.CONTENT_GAP: 60, WorkerType.CITATIONS: 45}
    for worker, seconds in executor.TASK_TIMEOUT.items():
        assert executor._timeout({"worker": worker}) == seconds
    assert executor._timeout({"worker": "unknown"}) == executor.DEFAULT_TASK_TIMEOUT == 60
    assert executor._timeout({}) == 60


def test_the_research_deadline_is_its_own_limit_or_the_runs_minus_the_margin(settings):
    from apps.agent.conf import agent_conf
    from apps.agent.runtime.swarm import executor

    settings.AGENT_SWARM_MAX_SECONDS = 300
    settings.AGENT_RUN_MAX_SECONDS = 900
    conf = agent_conf()
    assert executor.RUN_DEADLINE_MARGIN_SECONDS == 240
    no_run = SimpleNamespace(extra={})
    assert executor._deadline(no_run, conf, 100.0) == 400.0
    # A run that started long ago: its own deadline minus the margin wins.
    old = SimpleNamespace(extra={"run_started": 0.0})
    assert executor._deadline(old, conf, 500.0) == 900 - 240
    # A run that just started: the research's own limit wins.
    fresh = SimpleNamespace(extra={"run_started": 100.0})
    assert executor._deadline(fresh, conf, 100.0) == 400.0
    # A start that is not a number is ignored.
    assert executor._deadline(SimpleNamespace(extra={"run_started": "x"}), conf, 1.0) == 301.0


def test_inline_research_past_its_time_limit_starts_no_agent(chat, monkeypatch, swarm_limits):
    from apps.agent.conf import agent_conf
    from apps.agent.runtime.swarm import executor
    from apps.agent.runtime.swarm.context import WorkerOutput
    from apps.agent.tests.swarm_support import make_run, make_swarm, plan_prompts, tool_context

    called = []

    def worker(job):
        called.append(job.task_id)
        return WorkerOutput(status="done", result="ran")

    _use_workers(monkeypatch, worker)
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=_small())
    conf = agent_conf()
    # The run's deadline minus the margin passed a second ago.
    run_started = time.monotonic() - conf.run_max_seconds + executor.RUN_DEADLINE_MARGIN_SECONDS - 1
    outcome = executor.execute_version(tool_context(run, inline=True, run_started=run_started),
                                       swarm, version)
    assert called == []
    assert {t["status"] for t in outcome.results.values()} == {"skipped"}
    assert {t["error"]["code"] for t in outcome.results.values()} == {"deadline"}
    assert outcome.results[swarm.tasks[0]["id"]]["error"]["message"] == (
        "Not started: the research reached its time limit.")
    assert (outcome.status, outcome.cancelled) == ("partial", False)


@pytest.fixture
def swarm_limits():
    from apps.agent.runtime.swarm import limits
    from apps.agent.tests.swarm_support import wait_for_swarm_threads

    limits.reset_limits()
    yield limits
    wait_for_swarm_threads()
    limits.reset_limits()


def test_an_agent_that_stops_at_the_cost_ceiling_fails_with_the_cost_message(
        chat, monkeypatch, swarm_limits):
    """An agent whose own spend takes the run to its cost ceiling stops
    (TaskStopped) and is failed with the cost message; the agents after it
    are skipped and the version is partial."""
    from apps.agent.llm.gate import GateStop
    from apps.agent.llm.usage import UsageTotals
    from apps.agent.runtime.swarm import executor
    from apps.agent.runtime.swarm.context import WorkerOutput
    from apps.agent.tests.swarm_support import (
        UsageLog,
        make_run,
        make_swarm,
        plan_prompts,
        tool_context,
    )

    ceiling = Decimal("0.05")
    usage = UsageLog()
    called = []

    def worker(job):
        called.append(job.task_id)
        job.run.add_usage(UsageTotals(cost_usd=Decimal("0.05")), requests=0)
        job.run.over_budget()
        job.check()
        return WorkerOutput(status="done", result="kept going")

    _use_workers(monkeypatch, worker)
    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=_small())
    ctx = tool_context(run, inline=True, usage=usage)
    ctx.budget_stop = lambda extra_usd=None: GateStop(
        "run_cost_limit", "This reply reached the $0.05 cost limit for one reply.") if (
        usage.cost + Decimal(str(extra_usd or 0)) >= ceiling) else None

    outcome = executor.execute_version(ctx, swarm, version)
    first, *rest = (outcome.results[t["id"]] for t in swarm.tasks)
    assert called == [swarm.tasks[0]["id"]]
    assert (first["status"], first["error"]) == ("failed", executor.COST_RUNNING)
    assert rest and all((t["status"], t["error"]) == ("skipped", executor.COST_PENDING)
                        for t in rest)
    assert outcome.status == "partial" and not outcome.cancelled
    assert usage.cost == Decimal("0.05")


def test_an_agent_job_is_stopped_once_the_run_reached_its_cost_ceiling():
    import math

    from apps.agent.runtime.swarm.context import TaskJob, TaskStopped

    swarm_run = SimpleNamespace(cancelled=lambda: False, deadline=math.inf, budget_stop=None)
    job = TaskJob(spec={"id": "t1"}, run=swarm_run, reporter=SimpleNamespace(closed=False),
                  started=time.monotonic())
    assert job.stopped() is False
    job.check()
    swarm_run.budget_stop = object()
    assert job.stopped() is True
    with pytest.raises(TaskStopped):
        job.check()
    swarm_run.budget_stop = None
    swarm_run.deadline = time.monotonic() - 1
    assert job.stopped() is True


# ── Send input checks, idempotency and the tree ───────────────────────────


def test_a_message_may_be_20000_characters_but_not_one_more(fake_anthropic, chat, user):
    from apps.agent.services.runs import MAX_MESSAGE_CHARS

    assert MAX_MESSAGE_CHARS == 20_000
    resp = client_for(user).post(_send_url(chat), {"text": "x" * 20_001}, format="json")
    assert resp.status_code == 400
    assert error(resp)["message"] == "Messages can be at most 20000 characters."
    assert not AgentRun.objects.exists()
    fake_anthropic.queue(message(text("Long.")))
    started = send(chat, "y" * 20_000)
    assert started.user_message.parts[0]["text"] == "y" * 20_000


@pytest.mark.parametrize("body", [{"text": ""}, {"text": "   \n\t"}, {"text": 5}, {}])
def test_an_empty_message_is_400(chat, user, body):
    resp = client_for(user).post(_send_url(chat), body, format="json")
    assert resp.status_code == 400
    assert error(resp)["message"] == "Write a message first."
    assert not AgentRun.objects.exists()


def test_nul_characters_are_removed_and_the_text_is_trimmed(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Hi.")))
    started = send(chat, "  best\x00 crm  ")
    assert started.user_message.parts[0]["text"] == "best crm"


def test_an_unknown_agent_is_400(chat, user):
    resp = client_for(user).post(_send_url(chat), {"text": "Hi", "agent": "astrologer"},
                                 format="json")
    assert resp.status_code == 400
    assert error(resp)["message"] == "Unknown agent."
    assert not AgentRun.objects.exists()


def test_a_later_message_notes_an_agent_change_only_when_the_agent_changes(fake_anthropic, chat):
    fake_anthropic.queue(*(message(text(f"Reply {n}.")) for n in range(4)))
    send(chat, "Hi")
    same = send(chat, "Still you", agent="gap_analyst")
    switched = send(chat, "Write a page", agent="landing_page")
    again = send(chat, "Another page", agent="landing_page")
    assert "selected the" not in _note_of(same.user_message)
    assert "For this message the user selected the" in _note_of(switched.user_message)
    assert "(landing_page)" in _note_of(switched.user_message)
    # The history already says the landing page agent was selected.
    assert "selected the" not in _note_of(again.user_message)


def test_a_first_message_with_another_agent_changes_the_chats_entry_agent(fake_anthropic, chat):
    from apps.agent.models import AgentChat

    fake_anthropic.queue(message(text("Page.")))
    send(chat, "Write a landing page", agent="landing_page")
    assert AgentChat.objects.get(id=chat.id).entry_agent == "landing_page"


@pytest.mark.parametrize(("length", "ok"), [(64, True), (65, False)])
def test_an_idempotency_key_may_be_64_characters(fake_anthropic, chat, user, length, ok):
    fake_anthropic.queue(message(text("Hi.")))
    resp = client_for(user).post(_send_url(chat), {"text": "Hi"}, format="json",
                                 HTTP_IDEMPOTENCY_KEY="k" * length)
    if ok:
        assert resp.status_code == 202, resp.content
        assert AgentRun.objects.get().idempotency_key == "k" * 64
    else:
        assert resp.status_code == 400
        assert error(resp)["message"] == "Idempotency-Key can be at most 64 characters."
        assert not AgentRun.objects.exists()


def test_a_repeated_idempotency_key_returns_the_first_run(fake_anthropic, chat, user, website):
    from apps.agent.services.runs import InvalidRequest, start_send
    from apps.agent.tests.runtime_support import make_chat

    fake_anthropic.queue(message(text("Hi.")))
    first = start_send(user=user, chat=chat, text="Hi", idempotency_key="  abc  ")
    again = start_send(user=user, chat=chat, text="Hi", idempotency_key="abc")
    assert again.replayed is True and first.replayed is False
    assert again.run.id == first.run.id
    assert AgentRun.objects.count() == 1 and AgentMessage.objects.count() == 2
    with pytest.raises(InvalidRequest) as caught:
        start_send(user=user, chat=make_chat(user, website), text="Hi", idempotency_key="abc")
    assert caught.value.message == "This Idempotency-Key was already used for another chat."


def test_a_message_follows_a_reply_and_only_a_reply(fake_anthropic, chat, user):
    from apps.agent.services.runs import InvalidRequest
    from core.exceptions import ResourceNotFound

    fake_anthropic.queue(message(text("One.")), message(text("Two.")))
    first = send(chat, "Hi")
    with pytest.raises(InvalidRequest) as caught:
        send(chat, "Branch", parent_id=first.user_message.id)
    assert caught.value.message == "A message can only follow a reply."
    import uuid
    with pytest.raises(ResourceNotFound):
        send(chat, "Branch", parent_id=uuid.uuid4())
    branch = send(chat, "Branch", parent_id=first.assistant_message.id)
    assert branch.user_message.parent_id == first.assistant_message.id
    assert branch.user_message.depth == 2


def test_a_lost_race_for_the_chats_run_leaves_no_messages_behind(chat, monkeypatch):
    """The database's one-active-run-per-chat rule is the last guard: a
    send that loses it is 409 run_in_progress and its nodes roll back."""
    from apps.agent.exceptions import RunInProgress
    from apps.agent.services import quota
    from apps.agent.tests.api_support import add_message, add_run

    question = add_message(chat, role="user", text="Busy")
    reply = add_message(chat, parent=question, role="assistant", text="")
    add_run(chat, question, reply, status="running")
    monkeypatch.setattr(quota, "check_chat_free", lambda chat: None)
    monkeypatch.setattr(quota, "check_user_slots", lambda user: None)
    before = AgentMessage.objects.count()
    with pytest.raises(RunInProgress) as caught:
        send(chat, "Me too")
    assert (caught.value.code, caught.value.status_code) == ("run_in_progress", 409)
    assert AgentMessage.objects.count() == before
    assert AgentRun.objects.count() == 1


def test_a_chat_snapshot_with_unreadable_tools_cannot_use_a_template_that_needs_one(
        user, website, snapshot):
    from apps.agent.models import AgentChat, AgentPromptSnapshot
    from apps.agent.services.runs import TemplateUnavailable

    AgentPromptSnapshot.objects.filter(id=snapshot.id).update(tools_json="{not json")
    old = AgentChat.objects.create(website=website, user=user, entry_agent="gap_analyst",
                                   snapshot_id=snapshot.id)
    with pytest.raises(TemplateUnavailable):
        send(old, "What changed?", template="change_log")
    assert not AgentRun.objects.exists()


# ── The cost ceiling's message hides dollars from free accounts ────────────


def test_a_free_accounts_reply_at_the_cost_ceiling_names_no_dollar_amount(
        fake_anthropic, chat, settings):
    from apps.agent.tests.fakes import tool_use

    settings.AGENT_RUN_MAX_COST_USD = 0.0001
    fake_anthropic.queue(message(tool_use("list_artifacts", {}), stop_reason="tool_use",
                                 input_tokens=5000, output_tokens=500))
    started = send(chat)
    run = AgentRun.objects.get(id=started.run.id)
    reply = AgentMessage.objects.get(id=started.assistant_message.id)
    assert (run.status, run.error_code) == ("failed", "run_cost_limit")
    assert run.error_message == "This reply reached the cost limit for one reply."
    assert reply.error_message == run.error_message
    failed = run_events(run)[-1]
    assert failed["type"] == "run.failed" and "$" not in failed["error"]["message"]


def test_a_paid_accounts_reply_at_the_cost_ceiling_names_the_amount(
        fake_anthropic, chat, settings):
    from apps.agent.tests.fakes import tool_use
    from apps.metering.tests.prompt_run_support import make_paid

    make_paid(chat.user)
    settings.AGENT_RUN_MAX_COST_USD = 0.0001
    fake_anthropic.queue(message(tool_use("list_artifacts", {}), stop_reason="tool_use",
                                 input_tokens=5000, output_tokens=500))
    started = send(chat)
    run = AgentRun.objects.get(id=started.run.id)
    assert run.error_code == "run_cost_limit"
    assert run.error_message == "This reply reached the $0.00 cost limit for one reply."


def test_a_free_accounts_engine_check_stopped_at_the_ceiling_names_no_dollar_amount(
        chat, website, monkeypatch, settings):
    """The partial tool result the model reads next turn carries the same
    dollar-free message."""
    import json as _json

    from apps.agent.llm.gate import GateStop, budget_stop
    from apps.agent.tests.runtime_support import make_prompt
    from apps.agent.tests.swarm_support import make_run, tool_context
    from apps.agent.tools import research
    from apps.agent.tools.schemas import CheckAiEnginesInput

    settings.OPENAI_API_KEY = "sk-test"
    settings.AGENT_RUN_MAX_COST_USD = 0.01
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0
    first = make_prompt(website, "best crm for startups")
    second = make_prompt(website, "best crm for dentists")
    monkeypatch.setattr(research, "_crawl", lambda *a, **k: None)
    run = make_run(chat)
    ctx = tool_context(run)
    started = time.monotonic()
    calls = {"n": 0}

    def over_after_first(extra_usd=None):
        calls["n"] += 1
        spent = Decimal("0.02") if calls["n"] > 1 else Decimal("0")
        return budget_stop(started_monotonic=started, cost_usd=spent, run=run)

    ctx.budget_stop = over_after_first
    with pytest.raises(GateStop) as stopped:
        research.check_ai_engines(ctx, CheckAiEnginesInput(
            prompt_ids=[first.prompt_id, second.prompt_id]))
    assert stopped.value.message == "This reply reached the cost limit for one reply."
    assert "$" not in _json.loads(stopped.value.tool_result.content)["error"]


def test_spend_a_research_agent_reported_but_the_run_has_not_counted_yet_counts(chat):
    """Thread mode: an agent's spend waits in a queue for the run's thread;
    the cost ceiling check counts it before it is handed over."""
    from apps.agent.llm.gate import GateStop
    from apps.agent.llm.usage import UsageTotals
    from apps.agent.runtime.swarm.context import SwarmRun
    from apps.agent.tests.swarm_support import (
        UsageLog,
        make_run,
        make_swarm,
        plan_prompts,
        tool_context,
    )

    run = make_run(chat)
    swarm, version = make_swarm(chat, run, plan_prompts(chat.website, 1), options=_small())
    usage = UsageLog()
    ctx = tool_context(run, inline=False, usage=usage)
    ctx.budget_stop = lambda extra_usd=None: GateStop("run_cost_limit", "Reached.") if (
        usage.cost + Decimal(str(extra_usd or 0)) >= Decimal("0.05")) else None
    swarm_run = SwarmRun(ctx, swarm, version, deadline=time.monotonic() + 60, carried={})

    swarm_run.add_usage(UsageTotals(cost_usd=Decimal("0.03")), requests=0)
    assert swarm_run.over_budget() is None
    swarm_run.add_usage(UsageTotals(cost_usd=Decimal("0.02")), requests=0)
    assert usage.calls == []          # nothing handed to the run yet
    assert swarm_run.over_budget().code == "run_cost_limit"
    swarm_run.drain_usage()
    assert usage.cost == Decimal("0.05")
    assert swarm_run.cost_usd == Decimal("0.05")
