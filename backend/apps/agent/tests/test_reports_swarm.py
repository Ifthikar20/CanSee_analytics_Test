"""Saving a reply that ran the research agents (contract 6c and 6e): the
report Markdown ends with the "Research agents" appendix and the version
data gains ``swarm``; a reply without them saves as before."""
from __future__ import annotations

import pytest

from apps.agent.models import AgentArtifactVersion
from apps.agent.runtime.swarm import plan
from apps.agent.tests import contract_support as contract
from apps.agent.tests.api_support import add_message, add_run, client_for, data
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.test_swarm_tables import PROMPT, contract_table

pytestmark = pytest.mark.django_db

REPORT = "# Notion on Google and in AI answers\n\nGoogle ranks you #4.\n\n## Fixes\n\n- Compare."
GENERATED_AT = "2026-11-04T10:17:18.880Z"
APPENDIX = (
    "## Research agents\n\n"
    "Ran 7 agents in 2m 14s: 6 done, 1 failed. Version 1 of “Research Notion”, captured "
    "4 Nov 2026 10:17 UTC.\n\n"
    "| Prompt | Google | AI Overview | ChatGPT | Claude | Gemini | Grok | Perplexity | Gap |\n"
    "|---|---|---|---|---|---|---|---|---|\n"
    f"| {PROMPT} | #4 | Shown, not named | Not named | Failed | Not configured | "
    "Not configured | Not configured | Google ahead (−45) |\n\n"
    "### Content gaps\n\n"
    "| Prompt | Issue | Fix | Page | Severity |\n"
    "|---|---|---|---|---|\n"
    f"| {PROMPT} | No comparison with alternatives | Add a section comparing Notion with "
    "Evernote and OneNote. | notion.so/product | High |"
)


def swarm_parts(*, version: int = 1, ids=("p2", "p3")) -> list[dict]:
    """A finished swarm part and its swarm_table part (contract 4b, 5)."""
    swarm, _, outcome, table = contract_table()
    table["generated_at"] = GENERATED_AT
    table["version"] = version
    tasks = [{**plan.initial_task(spec), **outcome.results[spec["id"]]} for spec in swarm.tasks]
    swarm_part = {
        "id": ids[0], "type": "swarm", "request": 1, "swarm_id": str(swarm.id),
        "version": version, "title": "Research Notion", "scope": "all",
        "scope_label": "All agents", "status": "partial",
        "started_at": "2026-11-04T10:15:04.309Z", "ended_at": "2026-11-04T10:17:18.510Z",
        "duration_ms": 134201, "categories": swarm.categories, "tasks": tasks,
        "table_version": version, "error": None, "limits": {"max_tasks": 30, "workers": 6},
    }
    table_part = {
        "id": ids[1], "type": "swarm_table", "request": 1, "swarm_id": str(swarm.id),
        "version": version, "title": "Research Notion", "status": "partial",
        "generated_at": GENERATED_AT, "table": table,
    }
    contract.assert_part(swarm_part)
    contract.assert_part(table_part)
    return [swarm_part, table_part]


def reply_with(chat, parts):
    question = add_message(chat, role="user", text="Research Notion")
    reply = add_message(chat, parent=question, role="assistant", parts=parts, status="complete")
    add_run(chat, question, reply, status="completed")
    return reply


def save(user, website, reply):
    resp = client_for(user).post(f"/api/v1/agent/websites/{website.id}/reports/",
                                 {"message_id": str(reply.id)}, format="json")
    assert resp.status_code == 201, resp.content
    return data(resp)


def test_a_report_ends_with_the_research_agents_appendix(user, website, chat):
    parts = [{"id": "p1", "type": "text", "request": 1, "text": "Starting.", "citations": []},
             *swarm_parts(),
             {"id": "p4", "type": "text", "request": 2, "text": REPORT, "citations": []}]
    body = save(user, website, reply_with(chat, parts))
    assert body["title"] == "Notion on Google and in AI answers"
    assert body["content"] == f"Starting.\n\n{REPORT}\n\n{APPENDIX}"
    assert body["summary"] == "7 research agents, 2 sections"

    snapshot = body["data"]
    assert set(snapshot) == contract.REPORT_DATA
    swarm = snapshot["swarm"]
    assert not contract.missing(contract.REPORT_SWARM, swarm)
    assert (swarm["swarm_id"], swarm["version"], swarm["title"], swarm["status"],
            swarm["duration_ms"]) == (contract.SID, 1, "Research Notion", "partial", 134201)
    assert swarm["counts"] == {"total": 7, "done": 6, "failed": 1, "skipped": 0, "stopped": 0}
    assert swarm["categories"] == [
        {"key": "google", "label": "Google (SEO)",
         "counts": {"total": 1, "done": 1, "failed": 0, "skipped": 0, "stopped": 0}},
        {"key": "engines", "label": "AI engines (GEO)",
         "counts": {"total": 2, "done": 1, "failed": 1, "skipped": 0, "stopped": 0}},
        {"key": "competitors", "label": "Competitor pages",
         "counts": {"total": 1, "done": 1, "failed": 0, "skipped": 0, "stopped": 0}},
        {"key": "site", "label": "Your site and content gaps",
         "counts": {"total": 2, "done": 2, "failed": 0, "skipped": 0, "stopped": 0}},
        {"key": "sources", "label": "Sources and citations",
         "counts": {"total": 1, "done": 1, "failed": 0, "skipped": 0, "stopped": 0}},
    ]
    contract.assert_table(swarm["table"])
    stored = AgentArtifactVersion.objects.get(artifact_id=body["id"])
    assert stored.data["swarm"]["table"] == swarm["table"]


def test_the_last_table_of_a_reply_is_the_one_saved(user, website, chat):
    first = swarm_parts(version=1, ids=("p1", "p2"))
    second = swarm_parts(version=2, ids=("p3", "p4"))
    second[1]["table"]["counts"] = {"total": 1, "done": 1, "failed": 0, "skipped": 0,
                                    "stopped": 0}
    parts = [*first, *second,
             {"id": "p5", "type": "text", "request": 2, "text": REPORT, "citations": []}]
    body = save(user, website, reply_with(chat, parts))
    assert body["data"]["swarm"]["version"] == 2
    assert "Ran 1 agents" not in body["content"]
    assert "Ran 1 agent in 2m 14s: 1 done. Version 2 of “Research Notion”" in body["content"]
    assert body["summary"].startswith("1 research agent, ")


def test_a_rerun_reply_saves_with_its_summary_and_a_default_title(user, website, chat):
    summary = ("Re-ran 7 agents in 2m 14s: 6 done, 1 failed. The results table is now "
               "version 1.")
    parts = [*swarm_parts(), {"id": "p4", "type": "text", "request": 1, "text": summary,
                              "citations": []}]
    body = save(user, website, reply_with(chat, parts))
    # The appendix's heading never becomes the report's title.
    assert body["title"].startswith("SEO and GEO report · Northwind · ")
    assert body["content"] == f"{summary}\n\n{APPENDIX}"


def test_a_report_without_research_agents_is_unchanged(user, website, chat):
    parts = [{"id": "p1", "type": "text", "request": 1, "text": REPORT, "citations": []}]
    body = save(user, website, reply_with(chat, parts))
    assert body["content"] == REPORT
    assert body["data"]["swarm"] is None and set(body["data"]) == contract.REPORT_DATA
    assert body["summary"] == "1 section"
