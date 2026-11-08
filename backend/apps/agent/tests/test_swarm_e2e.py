"""The research agents end to end (design/swarm_contract.md).

A whole research runs with every provider faked at its service boundary
(Google results, page fetches, the AI engines and the analysis model) and
everything else real: the orchestrator turn and its planning part, the
tool handler, the expansion, the executor and its five workers, the
consolidation, the tool result and the report the model writes after it.
Then one category is re-run through the live endpoint, the swarm is read
back, rows of its table become findings, both replies are saved as
reports and the chat is reloaded. Every event and every part is checked
against the contract: shapes and vocabularies (sections 4 and 5), the
revs of every task (4c) and the order of section 4d.

The main research runs inline (AGENT_RUN_MODE "inline", the test
setting); one test runs the same research in thread mode, as production
does, and one stops a research half way (4d.8).
"""
from __future__ import annotations

import json
import threading
import time
from collections import defaultdict
from decimal import Decimal

import pytest
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.recorder import MigrationRecorder
from django.urls import reverse

from apps.accounts.models import AITokenUsage
from apps.agent.models import AgentMessage, AgentRun, AgentSwarm, AgentSwarmVersion
from apps.agent.runtime import wire
from apps.agent.runtime.events import get_event_store
from apps.agent.runtime.parts import replay
from apps.agent.runtime.registry import get_registry
from apps.agent.runtime.swarm import limits
from apps.agent.tests import contract_support as contract
from apps.agent.tests.api_support import client_for, data, error
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, run_events, send, tool_results_of
from apps.agent.tests.swarm_support import (
    RoutedFakeAnthropic,
    browse_result,
    engine_answer,
    fake_engine_scan,
    fake_fetch,
    fake_serp,
    serp_payload,
    wait_for_swarm_threads,
)
from apps.search_gap.models import GoogleRankCheck

PROMPTS = ("best crm for startups", "crm with email tracking")
OWN_CRM = "https://northwind.example/crm"
HOMEPAGE = "https://northwind.example"
RIVAL_CRM = "https://www.hubspot.com/products/crm"
RIVAL_EMAIL = "https://www.hubspot.com/email-tracking"
REVIEWS = "https://reviews.example/best-crm"
PIPEDRIVE = "https://www.pipedrive.com/email-tracking"
G2 = "https://www.g2.com/categories/crm"
ZAPIER = "https://zapier.com/blog/best-crm-apps/"
INTRO = "I'll run the research agents."
REPORT = "# Northwind research\n\nGoogle ranks you #3 for one prompt; ChatGPT does not name you."
TASK_IDS = [
    task_id
    for key in ("p1", "p2")
    for task_id in (f"google.{key}.page1", f"engines.{key}.chatgpt", f"engines.{key}.claude",
                    f"competitors.{key}.c1", f"site.{key}.page", f"site.{key}.gaps",
                    f"sources.{key}.cited")
]
GOOGLE_IDS = ["google.p1.page1", "google.p2.page1"]
PLANNING_PART = {
    "type": "swarm", "request": 1, "swarm_id": None, "version": None, "title": "",
    "scope": "all", "scope_label": "", "status": "planning", "started_at": None,
    "ended_at": None, "duration_ms": None, "categories": [], "tasks": [],
    "table_version": None, "error": None, "limits": None,
}
STARTED_PATCH = {"status", "started_at", "step", "attempt"}
PROGRESS_PATCH = {"step", "target", "attempt"}
FINISHED_PATCH = {"status", "step", "ended_at", "duration_ms", "result", "tone", "pane", "error",
                  "detail"}


# ── The outside world ─────────────────────────────────────────────────────


class World:
    """The fake providers of one research. ``round`` 2 is the re-run, in
    which Google ranks Northwind one place higher for the first prompt."""

    def __init__(self, monkeypatch):
        self.round = 1
        # The threads Google was searched from (thread mode: the agents' own).
        self.threads: set[str] = set()
        self.serp_calls = fake_serp(monkeypatch, self.serp)
        self.fetches = fake_fetch(monkeypatch, {
            RIVAL_CRM: browse_result(RIVAL_CRM, title="HubSpot CRM for startups", words=2100,
                                     h2=("Compare plans", "Free CRM"),
                                     schema=("FAQPage", "Organization")),
            OWN_CRM: browse_result(OWN_CRM, title="Northwind CRM", words=800),
            RIVAL_EMAIL: browse_result(RIVAL_EMAIL, title="HubSpot email tracking", words=1500),
            HOMEPAGE: browse_result(HOMEPAGE, title="Northwind", words=600),
        })
        self.engines = fake_engine_scan(monkeypatch, {
            "gpt4": engine_answer(brands=[("HubSpot", 1), ("Pipedrive", 2)],
                                  citations=[G2, ZAPIER], model_id="gpt-4o-mini"),
            "claude": engine_answer(mentioned=True, rank=2, sentiment="positive",
                                    brands=[("HubSpot", 1)], citations=[G2],
                                    context="Northwind is a good pick for startups.",
                                    model_id="claude-sonnet-5"),
        })

    def serp(self, query: str, page: int) -> dict:
        self.threads.add(threading.current_thread().name)
        if query == PROMPTS[0]:
            rows = [(RIVAL_CRM, "HubSpot CRM"), (REVIEWS, "The best CRMs"),
                    (OWN_CRM, "Northwind CRM")]
            if self.round == 2:
                rows = [rows[0], rows[2], rows[1]]
            overview = {"text": "HubSpot and Pipedrive are popular choices for startups.",
                        "references": [{"title": "Best CRM software", "url": G2,
                                        "domain": "g2.com"}]}
            return serp_payload(rows, overview=overview,
                                questions=["Which CRM is best for a small startup?"])
        return serp_payload([(PIPEDRIVE, "Pipedrive email tracking"),
                             (RIVAL_EMAIL, "HubSpot email tracking")])


def analyses(purpose: str) -> dict:
    """The analysis model's answers (test data), by purpose."""
    if purpose == "engine_answer":
        return {"summary": "The answer recommends HubSpot first.",
                "reasons": ["Free tier", "Large app marketplace"],
                "opportunity": "Publish a page comparing the free tiers."}
    if purpose == "content_gap":
        return {"headline": "HubSpot's page compares its plans; yours does not.",
                "gaps": [{"issue": "No plan comparison",
                          "evidence": "HubSpot's H2 'Compare plans'; your page has none.",
                          "fix": "Add a section comparing Northwind's plans.",
                          "target": OWN_CRM, "severity": "high"}]}
    if purpose == "citations":
        return {"headline": "Review sites dominate the sources.",
                "opportunities": [{"domain": "g2.com",
                                   "why": "Cited by both engines and the AI Overview",
                                   "action": "Claim and complete the Northwind listing on G2."}]}
    return {}


@pytest.fixture
def research(settings, website, monkeypatch):
    """Google results, ChatGPT and Claude configured, a roomy allowance,
    HubSpot as a tracked competitor and two tracked prompts."""
    settings.SERPAPI_KEY = "serp-test"
    settings.OPENAI_API_KEY = "sk-test"
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.PERPLEXITY_API_KEY = ""
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0
    website.competitors = [{"name": "HubSpot", "domain": "hubspot.com"}]
    website.save(update_fields=["competitors"])
    limits.reset_limits()
    fake = RoutedFakeAnthropic(haiku=analyses).install()
    prompts = [make_prompt(website, prompt, location="us") for prompt in PROMPTS]
    yield World(monkeypatch), fake, prompts
    wait_for_swarm_threads()
    limits.reset_limits()


def script_turn(fake, prompts) -> None:
    fake.queue(
        message(text(INTRO),
                tool_use("research_swarm", {
                    "title": "Research Northwind",
                    "prompts": [{"prompt_id": str(bp.prompt_id)} for bp in prompts],
                }, id="toolu_swarm"),
                stop_reason="tool_use"),
        message(text(REPORT)),
    )


# ── Contract checks ───────────────────────────────────────────────────────


def check_swarm_events(events: list[dict], *, version: int, task_ids: list[str],
                       planning: bool, status: str) -> dict:
    """Every event of one execution's swarm part against contract 4: the
    payloads, the planning part (4b), the full part, each task's events
    in rev order (4c), the captures before their task.finished, and the
    order of 4d (full part, tasks, close, table, table version). Returns
    the indices of the milestones and the full part."""
    for event in events:
        contract.assert_event(event)
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(set(seqs)), "seq is strictly increasing"
    assert events[-1]["type"] in contract.TERMINAL_EVENTS
    assert sum(e["type"] in contract.TERMINAL_EVENTS for e in events) == 1

    full_at = next(i for i, e in enumerate(events) if e["type"] == "part.added"
                   and e["part"]["type"] == "swarm" and e["part"]["status"] == "running")
    full = events[full_at]["part"]
    part_id = full["id"]
    adds = [i for i, e in enumerate(events) if e["type"] == "part.added"
            and e["part"]["type"] == "swarm"]
    if planning:
        # 4d.1: the planning part, its title when the input is complete, then
        # the full part under the same id (4c: it replaces the planning part).
        assert len(adds) == 2 and adds[1] == full_at
        planning_part = events[adds[0]]["part"]
        assert planning_part == {"id": part_id, **PLANNING_PART}
        between = [e for e in events[adds[0] + 1:full_at] if e.get("part_id") == part_id]
        assert [e["type"] for e in between] == ["part.updated"]
        assert between[0]["patch"] == {"title": full["title"]}
    else:
        # 4d.3: a re-run turn adds the full part directly.
        assert adds == [full_at]

    # The full part (4b, second example): every task queued at rev 1.
    assert (full["swarm_id"], full["version"], full["status"]) == (
        full["swarm_id"], version, "running")
    assert full["started_at"] and full["ended_at"] is None and full["duration_ms"] is None
    assert (full["table_version"], full["error"]) == (None, None)
    assert full["limits"] == {"max_tasks": 50, "workers": 8}
    assert [t["id"] for t in full["tasks"]] == task_ids
    for task in full["tasks"]:
        contract.assert_task(task)
        assert (task["status"], task["rev"], task["attempt"]) == ("queued", 1, 0)
        assert task["error"] is task["pane"] is task["detail"] is None
    keys = [c["key"] for c in full["categories"]]
    assert keys == [k for k in contract.SWARM_CATEGORIES if k in keys]
    for category in full["categories"]:
        contract.assert_category(category)

    task_events = [(i, e) for i, e in enumerate(events) if e["type"] in contract.TASK_EVENTS]
    assert task_events and min(i for i, _ in task_events) > full_at, "4d.3"
    by_task: dict[str, list[tuple[int, dict]]] = defaultdict(list)
    for i, event in task_events:
        assert event["part_id"] == part_id
        by_task[event["task_id"]].append((i, event))
    assert set(by_task) == set(task_ids)
    finished_at = {}
    for task_id, own in by_task.items():
        kinds = [e["type"] for _, e in own]
        # 4c / 4d.4: revs 2, 3, ... in emission order; started, progress...,
        # exactly one finished, nothing after it. Skipped before it started:
        # only finished (rev 2).
        assert [e["rev"] for _, e in own] == list(range(2, 2 + len(own))), task_id
        assert kinds.count("task.finished") == 1 and kinds[-1] == "task.finished", task_id
        if kinds[0] == "task.started":
            assert set(kinds[1:-1]) <= {"task.progress"}, (task_id, kinds)
        else:
            assert kinds == ["task.finished"], (task_id, kinds)
        for _, event in own:
            patch = event["patch"]
            if event["type"] == "task.started":
                assert set(patch) == STARTED_PATCH and patch["status"] == "running"
                assert patch["attempt"] == 1 and 0 < len(patch["step"]) <= 80
            elif event["type"] == "task.progress":
                assert patch and set(patch) <= PROGRESS_PATCH, patch
                assert len(patch.get("step", "")) <= 80
            else:
                assert FINISHED_PATCH <= set(patch) <= FINISHED_PATCH | {"target", "attempt"}
                assert patch["step"] == "" and len(patch["result"]) <= 140
        finished_at[task_id] = own[-1][0]

    # 4d.4: a task's capture is recorded before its task.finished.
    recorded: dict[tuple[str, str], int] = {}
    for i, event in enumerate(events):
        if event["type"] == "research.recorded":
            recorded.setdefault((event["kind"], event["capture_id"]), i)
    for task_id, i in finished_at.items():
        pane = events[i]["patch"]["pane"]
        if pane is not None:
            kind, capture_id = pane["tab_id"].split(":", 1)
            assert kind == pane["kind"]
            assert recorded[(kind, capture_id)] < i, task_id

    # 4d.5: the part closes once every task is terminal.
    closed_at = next(i for i, e in enumerate(events) if e["type"] == "part.updated"
                     and e["part_id"] == part_id and "status" in e["patch"])
    closed = events[closed_at]["patch"]
    assert set(closed) == {"status", "ended_at", "duration_ms"} and closed["status"] == status
    assert closed_at > max(finished_at.values())
    # 4d.6: the swarm_table part, then the table version on the swarm part.
    table_at = next(i for i, e in enumerate(events) if e["type"] == "part.added"
                    and e["part"]["type"] == "swarm_table")
    version_at = next(i for i, e in enumerate(events) if e["type"] == "part.updated"
                      and e["part_id"] == part_id and "table_version" in e["patch"])
    assert closed_at < table_at < version_at
    assert events[version_at]["patch"] == {"table_version": version}
    table_part = events[table_at]["part"]
    assert (table_part["swarm_id"], table_part["version"], table_part["status"],
            table_part["request"]) == (full["swarm_id"], version, status, full["request"])
    # Nothing of the swarm part follows: no task event after the close.
    assert not [e for e in events[closed_at:] if e["type"] in contract.TASK_EVENTS]
    return {"full": full, "full_at": full_at, "closed_at": closed_at, "table_at": table_at,
            "version_at": version_at, "part_id": part_id}


def check_parts(msg: AgentMessage, events: list[dict]) -> tuple[dict, dict]:
    """The message as stored: replaying the run's events gives its parts
    (contract 7), and every part, task and table is the contract's."""
    assert replay(events) == msg.parts
    for part in msg.parts:
        contract.assert_part(part)
    swarm_part = next(p for p in msg.parts if p["type"] == "swarm")
    table_part = next(p for p in msg.parts if p["type"] == "swarm_table")
    for task in swarm_part["tasks"]:
        contract.assert_task(task)
        assert task["status"] in contract.TERMINAL_TASK_STATUSES
        if task["pane"] is not None:
            bucket = "serp" if task["pane"]["kind"] == "serp" else "pages"
            capture = msg.research[bucket][task["pane"]["tab_id"].split(":", 1)[1]]
            assert "reader" not in capture
    for category in swarm_part["categories"]:
        contract.assert_category(category)
    assert swarm_part["table_version"] == table_part["version"]
    assert swarm_part["ended_at"] and isinstance(swarm_part["duration_ms"], int)
    return swarm_part, table_part


def check_tool_result(result: dict, content: str) -> None:
    """Contract 3f: the fields, a state for every value nobody measured,
    third-party and analysis text marked untrusted, at most 16,000 chars."""
    assert len(content) <= 16_000
    assert not contract.missing(contract.SWARM_TOOL_RESULT, result)
    for prompt in result["prompts"]:
        assert not contract.missing(contract.SWARM_TOOL_PROMPT, prompt)
        assert prompt["google"]["state"] in contract.CELL_STATES
        assert set(prompt["engines"]) == {"chatgpt", "claude", "gemini", "grok", "perplexity"}
        for engine in prompt["engines"].values():
            assert engine["state"] in contract.CELL_STATES
            if "analysis" in engine:
                assert engine["analysis"]["untrusted"] is True and engine["analysis"]["text"]
        for page in prompt["competitor_pages"]:
            assert page["title"]["untrusted"] is True
        if "content_gaps" in prompt:
            assert prompt["content_gaps"]["untrusted"] is True
        assert not contract.missing({"class", "label", "value", "ai_score", "search_score"},
                                    prompt["gap"])


def cell(table: dict, sheet: str, row: str, column: str) -> dict:
    found = next(s for s in table["sheets"] if s["key"] == sheet)
    return next(r for r in found["rows"] if r["key"] == row)["cells"][column]


def row_of(table: dict, sheet: str, key: str) -> dict:
    found = next(s for s in table["sheets"] if s["key"] == sheet)
    return next(r for r in found["rows"] if r["key"] == key)


# ── The research, a re-run, the reads, findings, reports and a reload ─────


@pytest.mark.django_db
@pytest.mark.usefixtures("no_title")
def test_a_research_runs_end_to_end(user, website, chat, research):
    world, fake, prompts = research
    script_turn(fake, prompts)

    run = send(chat, "Research Northwind on Google and in the AI engines").run
    run.refresh_from_db()
    assert run.status == "completed"
    first = AgentMessage.objects.get(id=run.assistant_message_id)
    assert first.status == "complete"

    # ── Events and parts (contract 4 and 5) ──
    events = run_events(run)
    marks = check_swarm_events(events, version=1, task_ids=TASK_IDS, planning=True,
                               status="done")
    assert events[-1]["type"] == "run.completed"
    report_at = next(i for i, e in enumerate(events) if e["type"] == "part.added"
                     and e["part"]["type"] == "text" and e["part"]["request"] == 2)
    assert marks["version_at"] < report_at, "4d.7: the report follows the table"
    assert [p["type"] for p in first.parts] == ["text", "swarm", "swarm_table", "text"]
    swarm_part, table_part = check_parts(first, events)
    assert first.parts[0]["text"] == INTRO and first.parts[-1]["text"] == REPORT
    assert swarm_part["id"] == marks["part_id"]
    assert (swarm_part["title"], swarm_part["scope"], swarm_part["scope_label"],
            swarm_part["status"]) == ("Research Northwind", "all", "All agents", "done")
    assert [c["key"] for c in swarm_part["categories"]] == contract.SWARM_CATEGORIES
    engines_category = swarm_part["categories"][1]
    assert engines_category["notes"] == [{
        "level": "info", "code": "engines_not_configured",
        "text": "Gemini, Grok and Perplexity are not configured, so they were not asked."}]
    assert [s["label"] for s in engines_category["subcategories"]] == list(PROMPTS)
    tasks = {t["id"]: t for t in swarm_part["tasks"]}
    assert [t["status"] for t in swarm_part["tasks"]] == ["done"] * len(TASK_IDS)
    assert tasks["google.p1.page1"]["result"] == (
        "You're #3 · AI Overview shown")
    assert (tasks["google.p2.page1"]["result"], tasks["google.p2.page1"]["tone"]) == (
        "Not on page 1 · HubSpot #2", "warn")
    assert tasks["engines.p1.chatgpt"]["result"] == "Not named · lists HubSpot, Pipedrive"
    assert (tasks["engines.p1.claude"]["result"], tasks["engines.p1.claude"]["tone"]) == (
        "Named #2 · positive", "good")
    # 5c: a page task's target becomes the chosen host and path.
    assert tasks["competitors.p1.c1"]["target"] == "hubspot.com/products/crm"
    assert tasks["competitors.p2.c1"]["detail"]["chosen_because"] == (
        "Ranks #2 on Google for this prompt; a tracked competitor")
    assert tasks["site.p1.page"]["detail"]["chosen_because"] == (
        "Ranks #3 on Google for this prompt")
    assert tasks["site.p2.page"]["detail"]["chosen_because"] == (
        "Your homepage: you are not in the Google pages searched")
    # A gap may only point at a compared page (5d): the second prompt's own
    # page is the homepage, so its gap's target is cleared.
    assert tasks["site.p1.gaps"]["detail"]["gaps"][0]["target"] == OWN_CRM
    assert tasks["site.p2.gaps"]["detail"]["gaps"][0]["target"] == ""
    sources = tasks["sources.p1.cited"]["detail"]
    assert (sources["total_citations"], sources["overview_references"]) == (4, 1)
    assert sources["sources"][0] == {
        "domain": "g2.com", "citations": 3, "engines": ["chatgpt", "claude", "ai_overview"],
        "is_yours": False, "is_competitor": False, "competitor_name": None, "example_url": G2}
    assert tasks["sources.p1.cited"]["result"] == (
        "2 sources · you're not cited · g2.com cited 3 times")

    # ── The table (5e) ──
    table = table_part["table"]
    assert (table["version"], table["status"], table["previous_version"], table["changes"]) == (
        1, "done", None, [])
    assert table["counts"] == {"total": 14, "done": 14, "failed": 0, "skipped": 0, "stopped": 0}
    assert [s["key"] for s in table["sheets"]] == ["prompts", "gaps", "sources"]
    assert (cell(table, "prompts", "p1", "google")["text"],
            cell(table, "prompts", "p1", "google")["note"]) == ("#3", "1 of 1 pages searched")
    assert cell(table, "prompts", "p2", "google")["state"] == "not_found"
    assert cell(table, "prompts", "p1", "ai_overview")["text"] == "Shown, not named"
    assert cell(table, "prompts", "p1", "chatgpt")["text"] == "Not named"
    assert cell(table, "prompts", "p1", "claude")["text"] == "Named #2"
    for engine in ("gemini", "grok", "perplexity"):
        assert cell(table, "prompts", "p1", engine)["state"] == "not_configured"
    assert cell(table, "prompts", "p1", "ahead")["text"] == (
        "HubSpot (2 engines, Google #1), Pipedrive (1 engine)")
    assert row_of(table, "prompts", "p1")["finding"]["title"] == (
        "Not named by ChatGPT for “best crm for startups”")
    assert row_of(table, "prompts", "p2")["finding"]["title"] == (
        "Missing on Google and in ChatGPT for “crm with email tracking”")
    assert cell(table, "gaps", "p1.g1", "page")["text"] == "northwind.example/crm"
    assert cell(table, "gaps", "p2.g1", "page")["text"] == "—"
    g2 = row_of(table, "sources", "g2.com")
    assert (g2["cells"]["citations"]["text"], g2["cells"]["engines"]["text"],
            g2["cells"]["prompts"]["text"]) == ("5", "ChatGPT, Claude, Google AI Overview", "2")
    assert g2["finding"]["title"] == "Get cited on g2.com"
    assert row_of(table, "sources", "zapier.com")["finding"] is None

    # ── The tool is offered to a new chat (3a), and its one result (0, 3f) ──
    assert len(fake.requests) == 2
    offered = {t["name"]: t for t in fake.requests[0].json["tools"]}
    assert offered["research_swarm"]["eager_input_streaming"] is True
    assert offered["research_swarm"]["input_schema"]["additionalProperties"] is False
    [sent] = tool_results_of(fake.requests[1].json)
    assert sent["tool_use_id"] == "toolu_swarm" and sent.get("is_error") is not True
    result = json.loads(sent["content"])
    check_tool_result(result, sent["content"])
    swarm = AgentSwarm.objects.get()
    assert (result["swarm_id"], result["version"], result["status"]) == (str(swarm.id), 1, "done")
    assert result["agents"] == table["counts"]
    assert result["engines_asked"] == ["ChatGPT", "Claude"]
    assert result["engines_not_configured"] == ["Gemini", "Grok", "Perplexity"]
    google = [p["google"] for p in result["prompts"]]
    assert [(g["found"], g["best_position"], g["rank_recorded"]) for g in google] == [
        (True, 3, True), (False, None, False)]
    turn = wire.loads(first.wire)
    uses = [b for m in turn for b in m["content"] if b.get("type") == "tool_use"]
    results = [b for m in turn for b in m["content"] if b.get("type") == "tool_result"]
    assert [u["id"] for u in uses] == ["toolu_swarm"] and len(results) == 1

    # ── Rows, usage and the measurements recorded ──
    version = AgentSwarmVersion.objects.get(swarm=swarm, version=1)
    assert (version.status, version.scope, version.run_id, version.message_id) == (
        "done", "all", run.id, first.id)
    assert sorted(version.results) == sorted(TASK_IDS) and version.table == table
    assert version.counts == table["counts"]
    assert (swarm.latest_version, swarm.message_id, swarm.title) == (1, first.id,
                                                                     "Research Northwind")
    assert version.worker_requests == len(fake.haiku_requests) == 8
    worker_rows = AITokenUsage.objects.filter(metadata__role="worker",
                                              metadata__swarm_id=str(swarm.id))
    assert worker_rows.count() >= 8
    assert sum((r.estimated_cost_usd for r in worker_rows), Decimal("0")).quantize(
        Decimal("0.000001")) == version.cost_usd > 0
    assert all(r.module == "agent" for r in worker_rows)
    run.refresh_from_db()
    assert run.requests == 2 and run.cost_usd >= version.cost_usd
    for request in fake.haiku_requests:
        body = request.json
        assert (body["model"], body["thinking"], body["output_config"]["effort"]) == (
            "claude-haiku-5-5", {"type": "disabled"}, "low")
        assert not {"temperature", "top_p", "top_k", "tools"} & set(body)
        assert body["messages"][-1]["role"] == "user"
    [check] = GoogleRankCheck.objects.all()
    assert (check.position, check.brand_prompt_id) == (3, prompts[0].id)
    assert sorted(g["prompt"]["text"] for g in first.research["gaps"]) == sorted(PROMPTS)
    assert sorted(world.engines["finished"]) == sorted((p, False) for p in PROMPTS)
    assert sorted(world.fetches) == sorted([RIVAL_CRM, OWN_CRM, RIVAL_EMAIL, HOMEPAGE])
    assert world.threads == {threading.current_thread().name}, "inline: the run's own thread"

    # ── A re-run of one category through the live endpoint (6b) ──
    world.round = 2
    owner = client_for(user)
    rerun_url = reverse("agent-live-swarm-rerun",
                        kwargs={"website_id": website.id, "swarm_id": swarm.id})
    resp = owner.post(rerun_url, {"scope": "category", "category": "google"}, format="json",
                      HTTP_IDEMPOTENCY_KEY="rerun-google-1")
    assert resp.status_code == 202, resp.content
    started = data(resp)
    assert not contract.missing(contract.RERUN_RESPONSE, started)
    assert started["swarm_version"] == {"swarm_id": str(swarm.id), "version": 2,
                                        "scope": "category", "scope_key": "google",
                                        "task_ids": GOOGLE_IDS}
    assert started["user_message"]["parts"][0]["text"] == "Re-run the Google (SEO) agents"
    assert started["user_message"]["parent_id"] == str(first.id)
    rerun = AgentRun.objects.get(id=started["run"]["id"])
    assert (rerun.trigger, rerun.status) == ("rerun", "completed")
    again = owner.post(rerun_url, {"scope": "category", "category": "google"}, format="json",
                       HTTP_IDEMPOTENCY_KEY="rerun-google-1")
    assert again.status_code == 202
    assert (data(again)["run"]["id"], data(again)["swarm_version"]) == (
        str(rerun.id), started["swarm_version"])
    assert AgentSwarmVersion.objects.filter(swarm=swarm).count() == 2

    second = AgentMessage.objects.get(id=rerun.assistant_message_id)
    rerun_events = run_events(rerun)
    marks = check_swarm_events(rerun_events, version=2, task_ids=GOOGLE_IDS, planning=False,
                               status="done")
    # 4d.7: one text part with the change summary, then run.completed.
    text_at = next(i for i, e in enumerate(rerun_events) if e["type"] == "part.added"
                   and e["part"]["type"] == "text")
    assert marks["version_at"] < text_at and rerun_events[-1]["type"] == "run.completed"
    assert [p["type"] for p in second.parts] == ["swarm", "swarm_table", "text"]
    swarm_part2, table_part2 = check_parts(second, rerun_events)
    assert (swarm_part2["scope"], swarm_part2["scope_label"], swarm_part2["version"]) == (
        "category", "Google (SEO)", 2)
    assert [c["key"] for c in swarm_part2["categories"]] == ["google"]
    assert swarm_part2["categories"][0]["notes"][-1]["code"] == "carried"
    assert len(fake.requests) == 2 and len(fake.haiku_requests) == 8, "no model request"
    table2 = table_part2["table"]
    assert (table2["version"], table2["previous_version"]) == (2, 1)
    assert table2["counts"] == {"total": 2, "done": 2, "failed": 0, "skipped": 0, "stopped": 0}
    google2 = cell(table2, "prompts", "p1", "google")
    assert (google2["text"], google2["version"], google2["previous"]) == (
        "#2", 2, {"text": "#3", "version": 1})
    assert cell(table2, "prompts", "p1", "chatgpt")["version"] == 1, "carried"
    assert table2["notes"][0] == (
        "Only the Google (SEO) agents ran in this version; other cells are from version 1.")
    assert table2["changes"][0] == {
        "sheet": "prompts", "row": "p1", "column": "google",
        "label": "best crm for startups · Google", "from": "#3", "to": "#2"}
    summary = second.parts[-1]["text"]
    assert summary.startswith("Re-ran 2 agents in ")
    assert ": 2 done. The results table is now version 2.\n\nChanges since version 1:\n" in summary
    assert "- best crm for startups · Google: #3 → #2" in summary
    assert wire.loads(second.wire) == [{"role": "assistant", "content": [
        {"type": "text", "text": summary + "\n\n" + summary_table(table2)}]}]
    version2 = AgentSwarmVersion.objects.get(swarm=swarm, version=2)
    assert (version2.status, version2.worker_requests, version2.table) == ("done", 0, table2)
    assert sorted(version2.results) == GOOGLE_IDS
    swarm.refresh_from_db()
    assert swarm.latest_version == 2
    assert sorted(GoogleRankCheck.objects.values_list("position", flat=True)) == [2, 3]

    # ── Reads (6a, 6d) ──
    detail = data(owner.get(reverse("agent-swarm-detail", kwargs={
        "website_id": website.id, "swarm_id": swarm.id})))
    assert not contract.missing(contract.SWARM_DETAIL, detail)
    assert [v["version"] for v in detail["versions"]] == [2, 1]
    for row in detail["versions"]:
        assert not contract.missing(contract.SWARM_DETAIL_VERSION, row) and row["has_table"]
    assert (detail["latest_version"], detail["message_id"]) == (2, str(first.id))
    assert [t["id"] for t in detail["tasks"]] == TASK_IDS
    read = data(owner.get(reverse("agent-swarm-version", kwargs={
        "website_id": website.id, "swarm_id": swarm.id, "number": 2})))
    assert not contract.missing(contract.SWARM_VERSION, read)
    assert (read["scope_label"], read["table"]) == ("Google (SEO)", table2)

    # ── Findings from the table (6a, 6d) ──
    findings_url = reverse("agent-findings", kwargs={"website_id": website.id})
    assert data(owner.get(findings_url)) == {
        "results": [], "next_cursor": None, "counts": {"open": 0, "done": 0, "dismissed": 0},
        "can_edit": True}

    def add(sheet, keys):
        return owner.post(findings_url, {"from_swarm": {
            "swarm_id": str(swarm.id), "version": 1, "sheet": sheet, "row_keys": keys}},
            format="json")

    created = add("prompts", ["p1", "p2"])
    assert created.status_code == 201, created.content
    body = data(created)
    assert len(body["created"]) == 2 and body["duplicates"] == []
    for finding in body["created"]:
        assert not contract.missing(contract.FINDING, finding)
        assert not contract.missing(contract.FINDING_SOURCE, finding["source"])
        assert (finding["source"]["chat_id"], finding["source"]["message_id"]) == (
            str(chat.id), str(first.id))
    assert body["created"][0]["title"] == row_of(table, "prompts", "p1")["finding"]["title"]
    assert body["created"][0]["evidence"] == row_of(table, "prompts", "p1")["finding"]["evidence"]
    repeat = data(add("prompts", ["p1"]))
    assert (repeat["created"], [f["id"] for f in repeat["duplicates"]]) == (
        [], [body["created"][0]["id"]])
    assert add("gaps", ["p1.g1"]).status_code == 201
    assert add("sources", ["g2.com"]).status_code == 201
    refused = add("sources", ["zapier.com"])
    assert (refused.status_code, error(refused)["code"]) == (400, "no_finding")
    detail_url = reverse("agent-finding-detail", kwargs={
        "website_id": website.id, "finding_id": body["created"][0]["id"]})
    changed = data(owner.patch(detail_url, {"status": "done"}, format="json"))
    assert (changed["status"], changed["status_changed_by_name"]) == ("done", "Site Owner")
    listed = data(owner.get(findings_url, {"status": "all"}))
    assert listed["counts"] == {"open": 3, "done": 1, "dismissed": 0}
    assert len(listed["results"]) == 4
    assert owner.delete(detail_url).status_code == 204

    # ── Reports (6c, 6e) ──
    reports_url = reverse("agent-reports", kwargs={"website_id": website.id})
    saved = owner.post(reports_url, {"message_id": str(first.id)}, format="json")
    assert saved.status_code == 201, saved.content
    report = data(saved)
    assert report["title"] == "Northwind research"
    assert report["content"].startswith(
        f"{INTRO}\n\n{REPORT}\n\n## Research agents\n\nRan 14 agents in ")
    assert "| Prompt | Google | AI Overview | ChatGPT | Claude | Gemini | Grok | Perplexity | Gap |" \
        in report["content"]
    assert "\n\n### Content gaps\n\n| Prompt | Issue | Fix | Page | Severity |" in report["content"]
    snapshot = report["data"]["swarm"]
    assert not contract.missing(contract.REPORT_SWARM, snapshot)
    assert (snapshot["version"], snapshot["table"], snapshot["counts"]) == (
        1, table, table["counts"])
    assert snapshot["categories"][0] == {"key": "google", "label": "Google (SEO)", "counts": {
        "total": 2, "done": 2, "failed": 0, "skipped": 0, "stopped": 0}}
    assert report["summary"].startswith("14 research agents")
    rerun_report = data(owner.post(reports_url, {"message_id": str(second.id)}, format="json"))
    assert rerun_report["content"].startswith(f"{summary}\n\n## Research agents\n\nRan 2 agents")
    assert "Version 2 of “Research Northwind”" in rerun_report["content"]

    # ── A reload rebuilds everything from the chat (contract 7) ──
    reloaded = data(owner.get(reverse("agent-chat-detail", kwargs={
        "website_id": website.id, "chat_id": chat.id})))
    messages = {m["id"]: m for m in reloaded["messages"]}
    for stored in (first, second):
        stored.refresh_from_db()
        shown = messages[str(stored.id)]
        assert shown["parts"] == stored.parts and shown["research"] == stored.research
        assert shown["parts_seq"] == stored.parts_seq
    status = data(owner.get(reverse("agent-status")))
    assert status["swarm"] == {"enabled": True, "max_agents": 50,
                               "worker_model": "claude-haiku-5-5"}


def summary_table(table: dict) -> str:
    from apps.agent.services.swarm_tables import table_markdown

    return table_markdown(table, sheets=("prompts",))


@pytest.mark.django_db
@pytest.mark.usefixtures("no_title")
def test_stop_half_way_keeps_the_table_of_what_finished(chat, research, monkeypatch):
    """Stop pressed while Claude answers the first prompt (4d.8): every
    agent not finished is stopped, the part and the version end cancelled,
    a table of what finished is still added, then run.cancelled."""
    world, fake, prompts = research
    claude = engine_answer(mentioned=True, rank=2, brands=[("HubSpot", 1)])

    def stop_then_answer(provider, variant, should_stop, on_step):
        running = AgentRun.objects.get(status="running")
        get_registry().cancel_local(running.id)
        return claude

    asked = fake_engine_scan(monkeypatch, {
        "gpt4": engine_answer(brands=[("HubSpot", 1)], citations=[G2]),
        "claude": stop_then_answer,
    })
    script_turn(fake, prompts)

    run = send(chat, "Research Northwind").run
    run.refresh_from_db()
    assert run.status == "cancelled"
    msg = AgentMessage.objects.get(id=run.assistant_message_id)
    assert msg.status == "cancelled"
    events = run_events(run)
    check_swarm_events(events, version=1, task_ids=TASK_IDS, planning=True, status="cancelled")
    assert events[-1]["type"] == "run.cancelled"
    swarm_part, table_part = check_parts(msg, events)
    statuses = {t["id"]: (t["status"], (t["error"] or {}).get("message"))
                for t in swarm_part["tasks"]}
    assert statuses["google.p1.page1"] == ("done", None)
    assert statuses["engines.p1.chatgpt"] == ("done", None)
    assert statuses["engines.p1.claude"] == ("stopped", "Stopped")
    assert {statuses[t] for t in TASK_IDS[3:]} == {("stopped", "Stopped before it started")}
    assert all(t["error"]["code"] == "stopped" for t in swarm_part["tasks"]
               if t["status"] == "stopped")
    table = table_part["table"]
    assert (table["status"], table["counts"]) == ("cancelled", {
        "total": 14, "done": 2, "failed": 0, "skipped": 0, "stopped": 12})
    assert cell(table, "prompts", "p1", "google")["text"] == "#3"
    assert cell(table, "prompts", "p1", "claude")["state"] == "stopped"
    assert cell(table, "prompts", "p2", "google")["state"] == "stopped"
    version = AgentSwarmVersion.objects.get()
    assert (version.status, version.counts) == ("cancelled", table["counts"])
    # No report request after Stop; the one tool call is closed on the wire.
    assert len(fake.requests) == 1
    results = [b for m in wire.loads(msg.wire) for b in m["content"]
               if b.get("type") == "tool_result"]
    assert [r["tool_use_id"] for r in results] == ["toolu_swarm"]
    # The first prompt's Google page was done: its rank check is kept.
    assert list(GoogleRankCheck.objects.values_list("position", flat=True)) == [3]
    assert asked["finished"] == [(PROMPTS[0], True)]


# ── Thread mode, as production runs it ────────────────────────────────────


def wait_terminal(run_id, timeout: float = 30.0) -> list[dict]:
    store = get_event_store()
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        found = store.read(str(run_id), 0, limit=100000)
        if found.terminal:
            return found.events
        time.sleep(0.05)
    raise AssertionError("the run did not finish")


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("no_title")
def test_a_research_runs_end_to_end_in_thread_mode(settings, user, website, chat, research):
    """The same research on the process's run threads, its agents on their
    own threads under the swarm and process limits: the same events, parts,
    table and tool result as inline. Then a re-run started from the live
    endpoint runs after its request committed, on a run thread too."""
    settings.AGENT_RUN_MODE = "thread"
    world, fake, prompts = research
    script_turn(fake, prompts)

    run = send(chat, "Research Northwind").run
    events = wait_terminal(run.id)
    wait_for_swarm_threads()

    run.refresh_from_db()
    assert run.status == "completed", (run.error_code, run.error_message)
    msg = AgentMessage.objects.get(id=run.assistant_message_id)
    check_swarm_events(events, version=1, task_ids=TASK_IDS, planning=True, status="done")
    swarm_part, table_part = check_parts(msg, run_events(run))
    assert [t["status"] for t in swarm_part["tasks"]] == ["done"] * len(TASK_IDS)
    table = table_part["table"]
    contract.assert_table(table)
    assert cell(table, "prompts", "p1", "google")["text"] == "#3"
    assert cell(table, "prompts", "p1", "claude")["text"] == "Named #2"
    [sent] = tool_results_of(fake.requests[1].json)
    check_tool_result(json.loads(sent["content"]), sent["content"])
    version = AgentSwarmVersion.objects.get()
    assert (version.status, version.worker_requests) == ("done", 8)
    run.refresh_from_db()
    # The analyses' usage reached the run on its own thread, not as requests.
    assert run.requests == 2 and run.cost_usd >= version.cost_usd > 0
    assert sorted(world.fetches) == sorted([RIVAL_CRM, OWN_CRM, RIVAL_EMAIL, HOMEPAGE])
    assert world.threads == {f"agent-swarm-{task_id}" for task_id in GOOGLE_IDS}

    world.round = 2
    resp = client_for(user).post(
        reverse("agent-live-swarm-rerun", kwargs={"website_id": website.id,
                                                  "swarm_id": version.swarm_id}),
        {"scope": "task", "task_id": "google.p1.page1"}, format="json")
    assert resp.status_code == 202, resp.content
    started = data(resp)
    assert started["swarm_version"]["task_ids"] == ["google.p1.page1"]
    assert started["user_message"]["parts"][0]["text"] == (
        "Re-run the Google page 1 agent for “best crm for startups”")
    rerun_events = wait_terminal(started["run"]["id"])
    wait_for_swarm_threads()
    rerun = AgentRun.objects.get(id=started["run"]["id"])
    assert rerun.status == "completed", (rerun.error_code, rerun.error_message)
    check_swarm_events(rerun_events, version=2, task_ids=["google.p1.page1"], planning=False,
                       status="done")
    second = AgentMessage.objects.get(id=rerun.assistant_message_id)
    swarm_part, table_part = check_parts(second, run_events(rerun))
    assert (swarm_part["scope"], swarm_part["scope_label"]) == (
        "task", "Google page 1 · “best crm for startups”")
    google = cell(table_part["table"], "prompts", "p1", "google")
    assert (google["text"], google["previous"]) == ("#2", {"text": "#3", "version": 1})
    assert cell(table_part["table"], "prompts", "p2", "google")["version"] == 1, "carried"
    assert len(fake.requests) == 2, "a re-run makes no model request"


# ── The migration ─────────────────────────────────────────────────────────


@pytest.mark.django_db
def test_the_swarm_migration_is_applied_and_is_the_agent_leaf():
    applied = MigrationRecorder(connection).applied_migrations()
    assert ("agent", "0002_swarm_findings") in applied
    # Wave 2's context and review tables (0003) come after it.
    leaves = MigrationLoader(connection).graph.leaf_nodes("agent")
    assert leaves == [("agent", "0003_context_reviews")]
    tables = set(connection.introspection.table_names())
    assert {"agent_swarm", "agent_swarm_version", "agent_finding"} <= tables
    with connection.cursor() as cursor:
        version_constraints = connection.introspection.get_constraints(
            cursor, "agent_swarm_version")
        finding_constraints = connection.introspection.get_constraints(cursor, "agent_finding")
    assert version_constraints["agent_swarm_version_unique"]["unique"]
    assert version_constraints["agent_swarm_version_unique"]["columns"] == ["swarm_id", "version"]
    assert finding_constraints["agent_finding_dedupe"]["unique"]
    run_indexes = [c for c in version_constraints.values()
                   if c["index"] and c["columns"] == ["run_id"]]
    assert len(run_indexes) == 1, "one index on run"
