"""research_swarm, the research agents' planning tool (backend design 5,
contract 3 and 4d).

The execution itself (runtime.swarm.executor) is the runtime's; here it is
replaced by a stand-in that does what the executor promises the tool: the
full part (replacing the planning part), one task.finished per task, the
closed part, the saved version row and a VersionOutcome. Everything around
it is real: validation, prompt resolution and tracking, the expansion, the
size and allowance checks, the rows, finalization, the tool result in the
next request and the wire.
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest
from django.utils import timezone
from pydantic import ValidationError

from apps.accounts.models import AITokenUsage
from apps.agent.constants import EventType, PartType
from apps.agent.llm.gate import CancelRequested
from apps.agent.models import AgentMessage, AgentSwarm, AgentSwarmVersion
from apps.agent.runtime import wire
from apps.agent.runtime.emitter import RunEmitter
from apps.agent.runtime.events import now_iso
from apps.agent.runtime.parts import replay
from apps.agent.runtime.swarm import plan
from apps.agent.tests import contract_support as contract
from apps.agent.tests.api_support import add_message, add_run
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import (
    make_chat,
    make_prompt,
    run_events,
    send,
    tool_results_of,
)
from apps.agent.tests.test_swarm_tables import (
    answer,
    cited_detail,
    failure,
    finished,
    gap_item,
    gaps_detail,
    outcome_for,
    overview,
    page,
    serp,
    serp_row,
    source,
)
from apps.agent.tools import swarm as swarm_tool
from apps.agent.tools.context import ToolContext, ToolError
from apps.agent.tools.schemas import ResearchSwarmInput

pytestmark = pytest.mark.django_db

PROMPT = "best crm for startups"
PROMPT_2 = "crm with email tracking"
OWN_URL = "https://northwind.example/crm"
REPORT = "# Northwind research\n\nGoogle ranks you #4; ChatGPT does not name you."


# ── The executor stand-in ─────────────────────────────────────────────────


def result_for(spec: dict) -> dict:
    """A done task for each worker, with the contract's detail shapes."""
    worker = spec["worker"]
    if worker == "serp_page":
        detail, pane = serp(positions=[4], query=PROMPT, ai_overview=overview(), top=[
            serp_row(1, "hubspot.com", competitor="HubSpot"),
            serp_row(4, "northwind.example", yours=True, url=OWN_URL),
        ], capture=uuid.uuid4().hex[:12])
        return finished(spec, detail=detail, pane=pane, result="You're #4", tone=None)
    if worker == "engine_answer":
        return finished(spec, detail=answer(spec["inputs"]["engine"], brands=["HubSpot"],
                                            analysis={"summary": "Names HubSpot.", "reasons": [],
                                                      "opportunity": "Publish a CRM comparison."}),
                        result="Not named · lists HubSpot", tone="warn")
    if worker == "page_inspect":
        own = spec["inputs"]["role"] == "own"
        url = OWN_URL if own else "https://hubspot.com/crm"
        detail, pane = page(spec["inputs"]["role"], url,
                            domain="northwind.example" if own else "hubspot.com",
                            position=4 if own else 1, words=900,
                            capture=uuid.uuid4().hex[:12])
        return finished(spec, detail=detail, pane=pane, result="Page title · 900 words")
    if worker == "content_gap":
        return finished(spec, detail=gaps_detail("HubSpot answers the question; you do not.", [
            gap_item("No pricing table", target=OWN_URL)], compared=[
            {"role": "own", "url": OWN_URL, "title": "Northwind"},
            {"role": "competitor", "url": "https://hubspot.com/crm", "title": "HubSpot"}]),
            result="1 gaps · HubSpot answers the question", tone="warn")
    return finished(spec, detail=cited_detail(3, [source("g2.com", 3, ["chatgpt"])]),
                    result="3 sources · you're not cited", tone="warn")


class StandIn:
    """execute_version as the executor runs it, minus the real work."""

    def __init__(self, *, status=None, overrides=None, raises=None, error=None):
        self.status = status
        self.overrides = overrides or {}
        self.raises = raises
        self.error = error
        self.calls = []

    def __call__(self, ctx, swarm, version, *, part_id=None):
        from apps.agent.runtime.swarm import reporter

        self.calls.append((swarm.id, version.version, part_id))
        wanted = set(version.task_ids)
        specs = [t for t in swarm.tasks if t["id"] in wanted]
        part_id = reporter.add_swarm_part(
            ctx.emitter, part_id=part_id, request=ctx.request, swarm=swarm, version=version,
            categories=swarm.categories, tasks=[plan.initial_task(s) for s in specs],
            scope=version.scope, scope_label="All agents", limits={"max_tasks": 30, "workers": 6},
            started_at=now_iso(),
        )
        if self.raises is not None:
            raise self.raises
        results = {}
        for spec in specs:
            task = self.overrides.get(spec["id"]) or result_for(spec)
            results[spec["id"]] = task
            ctx.emitter.emit(EventType.TASK_FINISHED, part_id=part_id, task_id=spec["id"],
                             rev=2, patch={key: task[key] for key in (
                                 "status", "step", "ended_at", "duration_ms", "result", "tone",
                                 "pane", "error", "detail")})
        status = self.status or ("done" if all(t["status"] == "done" for t in results.values())
                                 else "partial")
        ctx.emitter.update_part(part_id, status=status, ended_at=now_iso(), duration_ms=1500)
        AgentSwarmVersion.objects.filter(id=version.id).update(
            status=status, results=results, finished_at=timezone.now(), duration_ms=1500)
        return outcome_for(version, results, status=status, part_id=part_id, request=ctx.request,
                           duration_ms=1500, error=self.error)


@pytest.fixture
def executor(monkeypatch):
    stand_in = StandIn()
    monkeypatch.setattr("apps.agent.runtime.swarm.executor.execute_version", stand_in)
    return stand_in


@pytest.fixture
def configured(settings, website):
    """Google results, ChatGPT and Claude configured; a roomy allowance."""
    settings.SERPAPI_KEY = "serp-test"
    settings.OPENAI_API_KEY = "sk-test"
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.PERPLEXITY_API_KEY = ""
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0
    website.competitors = [{"name": "HubSpot", "domain": "hubspot.com"}]
    website.save(update_fields=["competitors"])
    return make_prompt(website, PROMPT, location="us")


def tool_context(chat, *, text: str = "Research Northwind on Google and in AI answers.",
                 planning: bool = True) -> ToolContext:
    """A running turn whose stream added the planning part (contract 4b)."""
    from apps.agent.models import AgentRun
    from apps.agent.runtime.swarm.reporter import planning_part_fields

    # The chat's earlier turns have ended (one active run per chat).
    AgentRun.objects.filter(chat=chat, status__in=("queued", "running")).update(
        status="completed")
    question = add_message(chat, role="user", text=text)
    reply = add_message(chat, parent=question, role="assistant", parts=[], status="streaming")
    run = add_run(chat, question, reply, status="running")
    emitter = RunEmitter(run, reply)
    part_id = None
    if planning:
        part_id = emitter.add_part(PartType.SWARM, request=1, **planning_part_fields())
    return ToolContext(run=run, chat=chat, website=chat.website, user=chat.user,
                       emitter=emitter, active=SimpleNamespace(cancelled=False), request=1,
                       part_id=part_id, inline=True)


def plan_input(**fields) -> ResearchSwarmInput:
    return ResearchSwarmInput.model_validate(fields)


def spend(user, usd: float) -> None:
    AITokenUsage.objects.create(user=user, module="agent", provider="anthropic",
                                model_name="claude-opus-5-5", estimated_cost_usd=usd)


# ── One orchestrator turn ─────────────────────────────────────────────────


@pytest.mark.usefixtures("no_title")
def test_an_orchestrator_turn_runs_the_research_and_sends_one_tool_result(
    fake_anthropic, chat, configured, executor,
):
    bp = configured
    fake_anthropic.queue(
        message(text("Starting the research agents."),
                tool_use("research_swarm", {"title": "Research Northwind",
                                            "prompts": [{"prompt_id": str(bp.prompt_id)}]},
                         id="toolu_swarm"),
                stop_reason="tool_use"),
        message(text(REPORT)),
    )
    run = send(chat, "Research Northwind").run
    run.refresh_from_db()
    assert run.status == "completed"
    msg = AgentMessage.objects.get(id=run.assistant_message_id)

    swarm = AgentSwarm.objects.get()
    assert (swarm.chat_id, swarm.user_id, swarm.website_id) == (chat.id, chat.user_id,
                                                                chat.website_id)
    assert (swarm.message_id, swarm.run_id, swarm.title) == (msg.id, run.id,
                                                            "Research Northwind")
    assert swarm.plan["prompts"][0]["prompt_id"] == str(bp.prompt_id)
    assert swarm.plan["engines_asked"] == ["chatgpt", "claude"]
    assert [t["id"] for t in swarm.tasks] == [
        "google.p1.page1", "engines.p1.chatgpt", "engines.p1.claude", "competitors.p1.c1",
        "site.p1.page", "site.p1.gaps", "sources.p1.cited"]
    assert swarm.latest_version == 1
    version = AgentSwarmVersion.objects.get()
    assert (version.version, version.scope, version.status, version.run_id) == (
        1, "all", "done", run.id)
    assert version.message_id == msg.id and version.task_ids == [t["id"] for t in swarm.tasks]
    contract.assert_table(version.table)

    # Parts: the reply's text, the swarm, its table, then the report.
    kinds = [p["type"] for p in msg.parts]
    assert kinds == ["text", "swarm", "swarm_table", "text"]
    swarm_part, table_part = msg.parts[1], msg.parts[2]
    assert (swarm_part["swarm_id"], swarm_part["version"], swarm_part["table_version"]) == (
        str(swarm.id), 1, 1)
    assert (table_part["swarm_id"], table_part["version"], table_part["status"]) == (
        str(swarm.id), 1, "done")
    assert table_part["table"] == version.table and table_part["request"] == 1
    assert msg.parts[-1]["text"] == REPORT

    # Contract 4d: the full part, the tasks, the close, the table, the table version.
    events = run_events(run)
    for event in events:
        contract.assert_event(event)
    assert replay(events) == msg.parts
    part_id = swarm_part["id"]

    def index(test):
        return next(i for i, e in enumerate(events) if test(e))

    full = index(lambda e: e["type"] == "part.added" and e["part"]["type"] == "swarm"
                 and e["part"]["status"] == "running")
    tasks = [i for i, e in enumerate(events) if e["type"] in contract.TASK_EVENTS]
    closed = index(lambda e: e["type"] == "part.updated" and e["part_id"] == part_id
                   and e["patch"].get("status") == "done")
    table = index(lambda e: e["type"] == "part.added" and e["part"]["type"] == "swarm_table")
    table_version = index(lambda e: e["type"] == "part.updated" and e["part_id"] == part_id
                          and e["patch"] == {"table_version": 1})
    assert full < min(tasks) and max(tasks) < closed < table < table_version
    assert events[-1]["type"] == "run.completed"

    # One tool_use and one tool_result on the wire; the result is contract 3f.
    turn = wire.loads(msg.wire)
    uses = [b for m in turn for b in m["content"] if b.get("type") == "tool_use"]
    results = [b for m in turn for b in m["content"] if b.get("type") == "tool_result"]
    assert [u["id"] for u in uses] == ["toolu_swarm"] and len(results) == 1
    sent = tool_results_of(fake_anthropic.requests[1].json)
    assert len(sent) == 1 and sent[0]["tool_use_id"] == "toolu_swarm"
    assert sent[0].get("is_error") is not True
    result = json.loads(sent[0]["content"])
    assert not contract.missing(contract.SWARM_TOOL_RESULT, result)
    assert (result["swarm_id"], result["version"], result["status"]) == (str(swarm.id), 1, "done")
    assert result["agents"] == {"total": 7, "done": 7, "failed": 0, "skipped": 0, "stopped": 0}
    assert result["prompts"][0]["prompt_id"] == str(bp.prompt_id)
    assert result["prompts"][0]["google"]["best_position"] == 4
    assert result["engines_not_configured"] == ["Gemini", "Grok", "Perplexity"]

    # The prompt's gap was read and recorded for reports.
    assert [g["prompt"]["id"] for g in msg.research["gaps"]] == [str(bp.prompt_id)]
    assert executor.calls == [(swarm.id, 1, executor.calls[0][2])]


# ── Refusals ──────────────────────────────────────────────────────────────


def assert_refused(ctx, args, code: str, message: str) -> None:
    with pytest.raises(ToolError) as refused:
        swarm_tool.research_swarm(ctx, args)
    assert refused.value.message == message and refused.value.summary == message
    part = ctx.emitter.part(ctx.part_id)
    assert part["status"] == "error" and part["error"] == {"code": code, "message": message}
    assert part["ended_at"]
    contract.assert_part(part)


def test_refusals_close_the_planning_part(chat, configured, executor, settings, website):
    bp = configured
    by_id = plan_input(prompts=[{"prompt_id": str(bp.prompt_id)}])

    settings.AGENT_SWARM_ENABLED = False
    assert_refused(tool_context(chat), by_id, "swarm_disabled",
                   "The research agents are turned off on this server.")
    settings.AGENT_SWARM_ENABLED = True

    unknown = uuid.uuid4()
    assert_refused(tool_context(chat), plan_input(prompts=[{"prompt_id": str(unknown)}]),
                   "prompt_not_found",
                   f"No tracked prompt with prompt_id {unknown} in this project. Use "
                   "list_tracked_prompts for valid ids.")

    assert_refused(tool_context(chat), plan_input(prompts=[{"text": "crm for dentists"}]),
                   "needs_confirmation",
                   'Not tracked: the user has not seen these prompts in this chat: "crm for '
                   'dentists". List the prompts in your reply and ask the user to confirm '
                   "them; call track_prompts after they say yes.")

    others = [make_prompt(website, f"{PROMPT} {n}") for n in range(2, 6)]
    five = plan_input(prompts=[{"prompt_id": str(p.prompt_id)} for p in [bp, *others]])
    assert_refused(tool_context(chat), five, "too_many_agents",
                   "This plan has 35 agents; the limit is 30. With 2 engines configured, use at "
                   "most 4 prompts, or fewer Google or competitor pages.")

    settings.AI_FREE_MONTHLY_CAP_USD = 0.30
    spend(chat.user, 0.10)
    assert_refused(tool_context(chat), by_id, "insufficient_allowance",
                   "Not enough AI allowance: this research needs up to $0.31 and $0.20 of the "
                   "$0.30 monthly allowance is left. Use fewer prompts or engines.")
    spend(chat.user, 0.25)
    assert_refused(tool_context(chat), by_id, "allowance_exceeded",
                   "You have used your monthly AI allowance.")

    assert not AgentSwarm.objects.exists() and executor.calls == []


def test_nothing_to_measure_without_google_or_engines(chat, configured, executor, settings):
    for key in ("SERPAPI_KEY", "SCRAPERAPI_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        setattr(settings, key, "")
    assert_refused(tool_context(chat), plan_input(prompts=[{"prompt_id": str(
        configured.prompt_id)}]), "nothing_to_measure",
        "Neither Google results nor any AI engine is configured, so the research agents have "
        "nothing to measure.")


def test_a_plan_with_no_agents_says_why(chat, configured, executor, settings):
    settings.SERPAPI_KEY = ""
    args = plan_input(prompts=[{"prompt_id": str(configured.prompt_id)}], engines=["gemini"],
                      content_gaps=False)
    assert_refused(tool_context(chat), args, "nothing_to_measure", swarm_tool.NO_AGENTS)


def test_rerun_refusals(chat, configured, executor):
    ctx = tool_context(chat)
    swarm_tool.research_swarm(ctx, plan_input(prompts=[{"prompt_id": str(configured.prompt_id)}]))
    swarm = AgentSwarm.objects.get()

    missing = uuid.uuid4()
    assert_refused(tool_context(chat), plan_input(rerun_of=str(missing)), "swarm_not_found",
                   f"No research with swarm_id {missing} in this chat.")

    # Busy: a version whose run is still going (a chat has one active run,
    # so here it is this turn's own run).
    busy = tool_context(chat)
    AgentSwarmVersion.objects.filter(swarm=swarm).update(status="running", run=busy.run)
    assert_refused(busy, plan_input(rerun_of=str(swarm.id)), "swarm_busy",
                   "That research is running now; wait for it to finish.")
    AgentSwarmVersion.objects.filter(swarm=swarm).update(status="done")

    AgentSwarmVersion.objects.bulk_create([
        AgentSwarmVersion(swarm=swarm, version=n, scope="all", task_ids=[], status="done")
        for n in range(2, 51)
    ])
    assert_refused(tool_context(chat), plan_input(rerun_of=str(swarm.id)), "version_limit",
                   "This research already has 50 versions; start a new research.")

    # Another chat's research is not found from this chat.
    other = make_chat(chat.user, chat.website)
    assert_refused(tool_context(other), plan_input(rerun_of=str(swarm.id)), "swarm_not_found",
                   f"No research with swarm_id {swarm.id} in this chat.")


# ── Prompts, re-runs, Stop and failures ───────────────────────────────────


def test_new_prompts_are_tracked_and_duplicates_merged(chat, configured, executor):
    from apps.prompt_library.models import BrandPrompt

    ctx = tool_context(chat, text=f"Yes, research these: {PROMPT_2}; {PROMPT}")
    result = swarm_tool.research_swarm(ctx, plan_input(prompts=[
        {"text": PROMPT_2, "location": "GB"},
        {"prompt_id": str(configured.prompt_id)},
        {"text": PROMPT},
    ], title="  Two prompts  ", competitors=["hubspot.com", "not a domain"]))
    swarm = AgentSwarm.objects.get()
    prompts = swarm.plan["prompts"]
    added = BrandPrompt.objects.get(website=chat.website, prompt__text=PROMPT_2)
    assert [(p["key"], p["prompt_id"], p["tracked_now"], p["location"]) for p in prompts] == [
        ("p1", str(added.prompt_id), True, "gb"),
        ("p2", str(configured.prompt_id), False, "us"),
    ]
    assert swarm.title == "Two prompts" and swarm.plan["competitors"] == ["hubspot.com"]
    notes = [n["code"] for c in swarm.categories for n in c["notes"]]
    assert "competitor_dropped" in notes
    assert result.is_error is False
    assert json.loads(result.content)["title"] == "Two prompts"


def test_rerun_of_runs_the_same_plan_as_the_next_version(chat, configured, executor):
    first = tool_context(chat)
    swarm_tool.research_swarm(first, plan_input(prompts=[{"prompt_id": str(configured.prompt_id)}]))
    swarm = AgentSwarm.objects.get()

    ctx = tool_context(chat, text="Run it again")
    result = swarm_tool.research_swarm(ctx, plan_input(rerun_of=str(swarm.id)))
    assert AgentSwarm.objects.count() == 1
    second = AgentSwarmVersion.objects.get(swarm=swarm, version=2)
    assert (second.scope, second.task_ids, second.run_id) == (
        "all", [t["id"] for t in swarm.tasks], ctx.run.id)
    payload = json.loads(result.content)
    assert payload["version"] == 2
    table = second.table
    assert table["previous_version"] == 1 and table["changes"] == []
    swarm.refresh_from_db()
    assert swarm.latest_version == 2
    assert executor.calls[-1][1] == 2 and executor.calls[-1][2] == ctx.part_id


def test_stop_keeps_the_table_and_cancels_the_run(chat, configured, monkeypatch):
    stand_in = StandIn(status="cancelled", overrides={})
    monkeypatch.setattr("apps.agent.runtime.swarm.executor.execute_version", stand_in)
    ctx = tool_context(chat)
    with pytest.raises(CancelRequested):
        swarm_tool.research_swarm(ctx, plan_input(prompts=[{"prompt_id": str(
            configured.prompt_id)}]))
    version = AgentSwarmVersion.objects.get()
    assert version.table is not None and version.table["status"] == "cancelled"
    table_part = next(p for p in ctx.emitter.parts() if p["type"] == "swarm_table")
    assert table_part["status"] == "cancelled"
    assert ctx.emitter.part(ctx.part_id)["table_version"] == 1


def test_an_execution_that_could_not_run_is_an_error_result(chat, configured, monkeypatch):
    stand_in = StandIn(status="error", error=failure("swarm_failed", "The plan could not start."))
    monkeypatch.setattr("apps.agent.runtime.swarm.executor.execute_version", stand_in)
    ctx = tool_context(chat)
    result = swarm_tool.research_swarm(ctx, plan_input(prompts=[{"prompt_id": str(
        configured.prompt_id)}]))
    assert result.is_error is True and result.summary == "The plan could not start."
    assert json.loads(result.content)["error"] == {"code": "swarm_failed",
                                                   "message": "The plan could not start."}
    version = AgentSwarmVersion.objects.get()
    assert (version.status, version.error_code, version.table) == ("error", "swarm_failed", None)
    assert not [p for p in ctx.emitter.parts() if p["type"] == "swarm_table"]


def test_an_execution_that_raises_closes_the_part_and_the_version(chat, configured, monkeypatch):
    stand_in = StandIn(raises=RuntimeError("database went away"))
    monkeypatch.setattr("apps.agent.runtime.swarm.executor.execute_version", stand_in)
    ctx = tool_context(chat)
    with pytest.raises(RuntimeError):
        swarm_tool.research_swarm(ctx, plan_input(prompts=[{"prompt_id": str(
            configured.prompt_id)}]))
    version = AgentSwarmVersion.objects.get()
    assert (version.status, version.error_code) == ("error", "internal_error")
    part = ctx.emitter.part(ctx.part_id)
    assert part["status"] == "error" and part["error"]["code"] == "internal_error"
    finished_ids = [e["task_id"] for e in run_events(ctx.run) if e["type"] == "task.finished"]
    assert finished_ids == [t["id"] for t in AgentSwarm.objects.get().tasks]


def test_without_a_planning_part_the_execution_adds_its_own(chat, configured, executor):
    ctx = tool_context(chat, planning=False)
    swarm_tool.research_swarm(ctx, plan_input(prompts=[{"prompt_id": str(configured.prompt_id)}]))
    kinds = [p["type"] for p in ctx.emitter.parts()]
    assert kinds == ["swarm", "swarm_table"]


# ── With the real executor ────────────────────────────────────────────────


RIVAL_URL = "https://www.hubspot.com/products/crm"


def outside_world(monkeypatch, serp_rows):
    """Google (one page of ``serp_rows``), the two pages and the two engines,
    faked at their service boundaries (tests/swarm_support.py)."""
    from apps.agent.tests.swarm_support import (
        browse_result,
        engine_answer,
        fake_engine_scan,
        fake_fetch,
        fake_serp,
        serp_payload,
    )

    fake_serp(monkeypatch, {1: serp_payload(serp_rows)})
    fake_fetch(monkeypatch, {
        RIVAL_URL: browse_result(RIVAL_URL, title="HubSpot CRM", words=2100,
                                 schema=("FAQPage",)),
        OWN_URL: browse_result(OWN_URL, title="Northwind CRM", words=800),
    })
    return fake_engine_scan(monkeypatch, {
        "gpt4": engine_answer(brands=[("HubSpot", 1), ("Pipedrive", 2)],
                              citations=["https://www.g2.com/categories/crm"]),
        "claude": engine_answer(mentioned=True, rank=2, brands=[("HubSpot", 1)],
                                context="Northwind is a good pick for startups."),
    })


def research_turn(fake, chat, bp):
    fake.queue(
        message(tool_use("research_swarm", {"prompts": [{"prompt_id": str(bp.prompt_id)}]},
                         id="toolu_swarm"), stop_reason="tool_use"),
        message(text(REPORT)),
    )
    run = send(chat, "Research Northwind").run
    run.refresh_from_db()
    return run, AgentMessage.objects.get(id=run.assistant_message_id)


@pytest.mark.usefixtures("no_title")
def test_with_the_real_executor_a_definite_google_result_is_recorded(
    chat, configured, monkeypatch,
):
    from apps.agent.runtime.swarm import limits
    from apps.agent.tests.swarm_support import RoutedFakeAnthropic
    from apps.search_gap.models import GoogleRankCheck

    limits.reset_limits()
    fake = RoutedFakeAnthropic().install()
    asked = outside_world(monkeypatch, [(RIVAL_URL, "HubSpot CRM"),
                                        ("https://reviews.example/best-crm", "Best CRMs"),
                                        (OWN_URL, "Northwind CRM")])
    run, msg = research_turn(fake, chat, configured)

    assert run.status == "completed"
    assert [p["type"] for p in msg.parts] == ["swarm", "swarm_table", "text"]
    events = run_events(run)
    for event in events:
        contract.assert_event(event)
    assert replay(events) == msg.parts
    swarm_adds = [e["part"] for e in events
                  if e["type"] == "part.added" and e["part"]["type"] == "swarm"]
    # The planning part, replaced by the full part under the same id (4d).
    assert [p["status"] for p in swarm_adds] == ["planning", "running"]
    assert swarm_adds[0]["id"] == swarm_adds[1]["id"] == msg.parts[0]["id"]
    part = msg.parts[0]
    assert {t["status"] for t in part["tasks"]} <= {"done", "skipped"}
    assert part["table_version"] == 1 and part["status"] in ("done", "partial")

    version = AgentSwarmVersion.objects.get()
    contract.assert_table(version.table)
    assert msg.parts[1]["table"] == version.table
    check = GoogleRankCheck.objects.get()
    assert (check.position, check.brand_prompt_id) == (3, configured.id)
    result = json.loads(tool_results_of(fake.requests[1].json)[0]["content"])
    prompt = result["prompts"][0]
    assert (prompt["google"]["found"], prompt["google"]["best_position"],
            prompt["google"]["rank_recorded"]) == (True, 3, True)
    assert (prompt["engines"]["chatgpt"]["mentioned"], prompt["engines"]["claude"]["rank"]) == (
        False, 2)
    assert prompt["engines"]["chatgpt"]["analysis"]["untrusted"] is True
    assert sorted(p for _, p, _ in asked["asked"]) == ["claude", "gpt4"]
    assert fake.haiku_requests and len(fake.requests) == 2
    assert [g["prompt"]["id"] for g in msg.research["gaps"]] == [str(configured.prompt_id)]
    turn = wire.loads(msg.wire)
    assert sum(1 for m in turn for b in m["content"] if b.get("type") == "tool_result") == 1


@pytest.mark.usefixtures("no_title")
def test_with_the_real_executor_a_miss_in_the_top_10_is_not_recorded(
    chat, configured, monkeypatch,
):
    from apps.agent.runtime.swarm import limits
    from apps.agent.tests.swarm_support import RoutedFakeAnthropic
    from apps.search_gap.models import GoogleRankCheck

    limits.reset_limits()
    fake = RoutedFakeAnthropic().install()
    rows = [(RIVAL_URL, "HubSpot CRM")] + [
        (f"https://site{n}.example/crm", f"CRM {n}") for n in range(2, 11)]
    outside_world(monkeypatch, rows)
    run, msg = research_turn(fake, chat, configured)

    assert run.status == "completed"
    assert not GoogleRankCheck.objects.exists()
    google = json.loads(tool_results_of(fake.requests[1].json)[0]["content"])["prompts"][0][
        "google"]
    assert (google["state"], google["found"], google["pages_searched"],
            google["rank_recorded"]) == ("ok", False, 1, False)
    cells = AgentSwarmVersion.objects.get().table["sheets"][0]["rows"][0]["cells"]
    assert (cells["google"]["text"], cells["google"]["state"]) == ("Not in top 10", "not_found")


@pytest.mark.usefixtures("no_title")
def test_with_scraperapi_a_miss_in_the_top_10_is_the_recorded_rank(
    chat, configured, monkeypatch,
):
    # ScraperAPI is read on page one only, so its top 10 is the full depth a
    # check measures (serp_google.max_reliable_pages), as on the prompt page.
    from apps.agent.runtime.swarm import limits
    from apps.agent.tests.swarm_support import RoutedFakeAnthropic
    from apps.citations.services import serp_google
    from apps.search_gap.models import GoogleRankCheck

    limits.reset_limits()
    fake = RoutedFakeAnthropic().install()
    rows = [(RIVAL_URL, "HubSpot CRM")] + [
        (f"https://site{n}.example/crm", f"CRM {n}") for n in range(2, 11)]
    outside_world(monkeypatch, rows)
    monkeypatch.setattr(serp_google, "provider", lambda: "scraperapi")
    run, msg = research_turn(fake, chat, configured)

    assert run.status == "completed"
    check = GoogleRankCheck.objects.get()
    assert (check.position, check.depth, check.brand_prompt_id) == (None, 10, configured.id)


def test_with_scraperapi_the_plan_has_google_page_one_only(chat, configured, executor,
                                                           monkeypatch):
    from apps.citations.services import serp_google

    monkeypatch.setattr(serp_google, "provider", lambda: "scraperapi")
    swarm_tool.research_swarm(tool_context(chat), plan_input(
        prompts=[{"prompt_id": str(configured.prompt_id)}], google_pages=2))

    swarm = AgentSwarm.objects.get()
    assert swarm.plan["google_pages"] == 1
    assert [t["id"] for t in swarm.tasks if t["worker"] == "serp_page"] == ["google.p1.page1"]


# ── Input validation (contract 3b) ────────────────────────────────────────


@pytest.mark.parametrize("fields", [
    {},
    {"prompts": []},
    {"prompts": [{"prompt_id": str(uuid.uuid4()), "text": "both at once"}]},
    {"prompts": [{"prompt_id": str(uuid.uuid4()), "location": "us"}]},
    {"prompts": [{"text": "ab"}]},
    {"prompts": [{"text": "x" * 301}]},
    {"prompts": [{"text": f"prompt {n}"} for n in range(6)]},
    {"prompts": [{"text": "crm"}], "title": "t" * 121},
    {"prompts": [{"text": "crm"}], "google_pages": 3},
    {"prompts": [{"text": "crm"}], "competitor_pages": 3},
    {"prompts": [{"text": "crm"}], "engines": ["gpt4"]},
    {"prompts": [{"text": "crm"}], "competitors": ["ab"]},
    {"prompts": [{"text": "crm"}], "competitors": [f"c{n}.com" for n in range(6)]},
    {"prompts": [{"text": "crm"}], "budget": 3},
    {"rerun_of": str(uuid.uuid4()), "title": "Again"},
    {"rerun_of": str(uuid.uuid4()), "prompts": [{"text": "crm"}]},
    {"rerun_of": "not-an-id"},
])
def test_invalid_input_is_refused_before_anything_runs(fields):
    with pytest.raises(ValidationError):
        ResearchSwarmInput.model_validate(fields)


def test_valid_input_defaults():
    args = ResearchSwarmInput.model_validate({"prompts": [{"text": "  crm for teams  ",
                                                           "location": "us"}]})
    assert (args.google_pages, args.competitor_pages, args.content_gaps, args.citations) == (
        1, 1, True, True)
    assert args.engines is None and args.competitors == [] and args.title is None
    assert args.prompts[0].text == "crm for teams"
    rerun = ResearchSwarmInput.model_validate({"rerun_of": str(contract.SID)})
    assert str(rerun.rerun_of) == contract.SID and rerun.prompts is None


def test_registry_errors_reach_the_model_as_is_error_results(chat, configured, executor):
    from apps.agent.tools import registry

    ctx = tool_context(chat)
    result = registry.execute(ctx, "research_swarm", {"rerun_of": str(uuid.uuid4()),
                                                      "title": "x"})
    assert result.is_error and result.summary == "Invalid input"
    assert "rerun_of runs the earlier plan again: leave out title." in result.content
