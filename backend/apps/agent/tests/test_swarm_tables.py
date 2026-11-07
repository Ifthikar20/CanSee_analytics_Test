"""The research agents' consolidated table (backend design 11, contract 3f
and 5e): every cell rule, the finding drafts, versions and changes, the
Markdown copies, the re-run texts and the tool result.

The builders at the top make swarms, versions, finished tasks and
outcomes from the contract's shapes; the other swarm suites import them
(builders only, never test functions).
"""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest

from apps.agent.runtime.swarm import plan
from apps.agent.services import swarm_tables
from apps.agent.services.swarm_tables import (
    build_table,
    build_tool_result,
    format_duration,
    report_appendix,
    rerun_summary,
    table_markdown,
)
from apps.agent.tests import contract_support as contract
from apps.agent.tools.shaping import compact

PROMPT = "best note taking app for teams"
PROMPT_2 = "notion alternatives for startups"
SID = uuid.UUID(contract.SID)
CAPTURE = "3f2a9c1d0e7b"
OWN_URL = "https://www.notion.so/product"
RIVAL_URL = "https://evernote.com/"
WEBSITE = SimpleNamespace(name="Notion", url="https://www.notion.so")
ENGINES = [
    {"provider": "gpt4", "key": "chatgpt", "label": "ChatGPT", "configured": True,
     "key_setting": "OPENAI_API_KEY"},
    {"provider": "claude", "key": "claude", "label": "Claude", "configured": True,
     "key_setting": "ANTHROPIC_API_KEY"},
    {"provider": "gemini", "key": "gemini", "label": "Gemini", "configured": False,
     "key_setting": "GEMINI_API_KEY"},
    {"provider": "grok", "key": "grok", "label": "Grok", "configured": False,
     "key_setting": "XAI_API_KEY"},
    {"provider": "perplexity", "key": "perplexity", "label": "Perplexity", "configured": False,
     "key_setting": "PERPLEXITY_API_KEY"},
]
GAP = {"class": "google_ahead", "value": -45, "ai_score": 10, "search_score": 55}


# ── Builders (imported by the other swarm suites) ─────────────────────────


def resolved(index: int, text: str, *, location: str = "us", variants=(), prompt_id=None,
             brand_prompt_id=None) -> plan.ResolvedPrompt:
    return plan.ResolvedPrompt(
        key=f"p{index}", prompt_id=str(prompt_id or uuid.uuid4()),
        brand_prompt_id=str(brand_prompt_id or uuid.uuid4()), text=text, location=location,
        model_variants=tuple(variants), tracked_now=False,
    )


def expand(prompts, *, serp: bool = True, catalog=None, title: str = "Research Notion",
           **options) -> plan.Expansion:
    """build_expansion with ENGINES (or ``catalog``) as the engine catalog;
    ``options`` are PlanOptions fields (``engines`` is the plan's filter)."""
    return plan.build_expansion(
        WEBSITE, prompts, plan.PlanOptions(title=title, **options),
        engines=catalog or ENGINES, serp_configured=serp, now_iso="2026-11-04T10:15:00.120Z",
    )


def fake_swarm(expansion: plan.Expansion, *, swarm_id=SID) -> SimpleNamespace:
    return SimpleNamespace(id=swarm_id, title=expansion.plan["title"], plan=expansion.plan,
                           categories=expansion.categories, tasks=expansion.tasks,
                           latest_version=0)


def fake_version(swarm, number: int = 1, *, scope: str = "all", scope_key: str = "",
                 task_ids=None) -> SimpleNamespace:
    ids = list(task_ids) if task_ids is not None else [t["id"] for t in swarm.tasks]
    return SimpleNamespace(id=uuid.uuid4(), version=number, scope=scope, scope_key=scope_key,
                           task_ids=ids, message_id=None)


def spec_of(swarm, task_id: str) -> dict:
    return next(t for t in swarm.tasks if t["id"] == task_id)


def finished(spec: dict, status: str = "done", *, detail=None, error=None, pane=None,
             result: str = "", tone=None) -> dict:
    """The final Task (contract 5c) of a spec."""
    task = plan.initial_task(spec)
    task.update(status=status, step="", result=result, tone=tone, error=error, pane=pane,
                detail=detail, started_at="2026-11-04T10:15:04.401Z",
                ended_at="2026-11-04T10:15:19.149Z", duration_ms=14748,
                attempt=0 if status == "skipped" else 1, rev=4)
    return task


def failure(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def serp_row(position: int, domain: str, *, yours: bool = False, competitor=None,
             url=None) -> dict:
    return {"position": position, "title": f"{domain} title", "url": url or f"https://{domain}/",
            "domain": domain, "is_yours": yours, "is_competitor": competitor is not None,
            "competitor_name": competitor}


def overview(shown=True, *, captured=True, mentions=False, cites=False, references=()) -> dict:
    return {"shown": shown, "content_captured": captured, "mentions_you": mentions,
            "cites_you": cites, "references": list(references)}


def serp(page: int = 1, *, positions=(), top=(), ai_overview=None, capture: str = CAPTURE,
         query: str = PROMPT) -> tuple[dict, dict]:
    """(detail, pane) of a serp_page task (contract 5d)."""
    return {
        "query": query, "page": page, "location": "us", "provider": "scraperapi",
        "captured_at": "2026-11-04T10:15:19.004Z", "reused": False, "result_count": 10,
        "brand_positions": list(positions), "top": list(top), "ai_overview": ai_overview,
        "people_also_ask": [],
    }, {"kind": "serp", "tab_id": f"serp:{capture}"}


def answer(engine: str, *, mentioned: bool = False, rank=None, sentiment=None, brands=(),
           above=None, analysis=None, citations=(), model_id: str = "gpt-4o-mini") -> dict:
    """The detail of an engine_answer task (contract 5d)."""
    brand_rows = [{"name": name, "position": i} for i, name in enumerate(brands, start=1)]
    return {
        "engine": engine, "engine_label": swarm_tables.ENGINE_LABELS[engine], "variant": None,
        "model_id": model_id, "prompt_text": PROMPT, "answered_at": "2026-11-04T10:15:31.220Z",
        "mentioned": mentioned, "rank": rank, "sentiment": sentiment, "brands": brand_rows,
        "brands_above": brand_rows if above is None else [
            {"name": name, "position": i} for i, name in enumerate(above, start=1)],
        "snippet": "", "citations": list(citations), "analysis": analysis,
        "analysis_error": None, "result_id": "c2b1",
    }


def page(role: str, url: str, *, domain: str, position, words: int, schema=(),
         capture: str = "aa11bb22cc33", title: str = "Page title") -> tuple[dict, dict]:
    """(detail, pane) of a page_inspect task (contract 5d)."""
    return {
        "role": role, "url": url, "final_url": url, "status_code": 200, "domain": domain,
        "competitor_name": "Evernote" if role == "competitor" else None, "position": position,
        "chosen_because": "Ranks on Google for this prompt", "title": title,
        "seo": {"title": title, "title_length": len(title), "meta_description": "",
                "meta_description_length": 0, "h1": [title], "h2": [], "word_count": words,
                "structured_data": list(schema), "canonical": url, "robots": "",
                "links": {"internal": 10, "external": 2}, "images": {"count": 3, "missing_alt": 0}},
        "excerpt": "", "reused_from": None,
    }, {"kind": "page", "tab_id": f"page:{capture}"}


def gap_item(issue: str, *, severity: str = "high", target: str = OWN_URL,
             evidence: str = "Evernote's H2 'Evernote vs. OneNote'; your page has none.",
             fix: str = "Add a section comparing Notion with Evernote and OneNote.") -> dict:
    return {"issue": issue, "evidence": evidence, "fix": fix, "target": target,
            "severity": severity}


def gaps_detail(headline: str, items=(), *, compared=None) -> dict:
    return {
        "compared": compared if compared is not None else [
            {"role": "own", "url": OWN_URL, "title": "Notion"},
            {"role": "competitor", "url": RIVAL_URL, "title": "Evernote"},
        ],
        "headline": headline, "gaps": list(items), "analysis_error": None,
    }


def source(domain: str, citations: int, engines=("chatgpt",), *, yours: bool = False,
           competitor=None) -> dict:
    return {"domain": domain, "citations": citations, "engines": list(engines),
            "is_yours": yours, "is_competitor": competitor is not None,
            "competitor_name": competitor, "example_url": f"https://www.{domain}/best"}


def cited_detail(total: int, sources=(), *, you: bool = False, opportunities=(),
                 headline: str = "Engines lean on review sites you are not listed on.") -> dict:
    return {
        "total_citations": total, "you_cited": you, "overview_references": 0,
        "sources": list(sources),
        "analysis": {"headline": headline, "opportunities": list(opportunities)},
        "analysis_error": None,
    }


def outcome_for(version, results: dict, *, carried=None, status=None, part_id: str = "p4",
                request: int = 1, duration_ms: int = 134201, rank_checks=None, notes=None,
                error=None):
    from apps.agent.runtime.swarm.executor import VersionOutcome

    if status is None:
        status = "done" if all(t["status"] == "done" for t in results.values()) else "partial"
    now = datetime(2026, 11, 4, 10, 17, 18, tzinfo=UTC)
    return VersionOutcome(
        status=status, cancelled=status == "cancelled", part_id=part_id, request=request,
        results=results, carried=carried or {}, started_at=now, ended_at=now,
        duration_ms=duration_ms, cost_usd=Decimal("0"), worker_requests=0,
        rank_checks=rank_checks or {}, notes=notes or [], error=error,
    )


def contract_research(**options):
    """The contract's example research: one prompt, ChatGPT and Claude
    configured, one Google page, one competitor page, content gaps and
    cited sources. Returns (swarm, version, results)."""
    expansion = expand([resolved(1, PROMPT)], **options)
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    detail, pane = serp(positions=[4], top=[
        serp_row(1, "evernote.com", competitor="Evernote"),
        serp_row(2, "onenote.com"),
        serp_row(3, "obsidian.md"),
        serp_row(4, "notion.so", yours=True, url=OWN_URL),
    ], ai_overview=overview())
    own, own_pane = page("own", OWN_URL, domain="notion.so", position=4, words=980,
                         capture="0a0a0a0a0a0a")
    rival, rival_pane = page("competitor", RIVAL_URL, domain="evernote.com", position=1,
                             words=2140, schema=["FAQPage"], capture="1b1b1b1b1b1b")
    results = {
        "google.p1.page1": finished(spec_of(swarm, "google.p1.page1"), detail=detail,
                                    pane=pane),
        "engines.p1.chatgpt": finished(spec_of(swarm, "engines.p1.chatgpt"), detail=answer(
            "chatgpt", brands=["Evernote", "OneNote", "Obsidian"], analysis={
                "summary": "ChatGPT recommends Evernote, OneNote and Obsidian.",
                "reasons": ["Strong offline mode", "Free tier"],
                "opportunity": "Publish a comparison page that names offline support."},
            citations=[{"url": "https://www.g2.com/x", "domain": "g2.com", "is_yours": False}])),
        "engines.p1.claude": finished(spec_of(swarm, "engines.p1.claude"), "failed",
                                      error=failure("rate_limited",
                                                    "The engine was busy or rate limited.")),
        "competitors.p1.c1": finished(spec_of(swarm, "competitors.p1.c1"), detail=rival,
                                      pane=rival_pane),
        "site.p1.page": finished(spec_of(swarm, "site.p1.page"), detail=own, pane=own_pane),
        "site.p1.gaps": finished(spec_of(swarm, "site.p1.gaps"), detail=gaps_detail(
            "Evernote's page answers the buyer question directly; yours does not.",
            [gap_item("No comparison with alternatives")])),
        "sources.p1.cited": finished(spec_of(swarm, "sources.p1.cited"), detail=cited_detail(
            14, [source("g2.com", 3, ["chatgpt"]), source("zapier.com", 2, ["chatgpt"])],
            opportunities=[{"domain": "g2.com", "why": "Cited by ChatGPT for this prompt",
                            "action": "Claim and complete the Notion listing on G2."}])),
    }
    return swarm, version, results


def contract_table(**options):
    swarm, version, results = contract_research(**options)
    outcome = outcome_for(version, results)
    table = build_table(swarm, version, outcome, gaps={"p1": {"gap": GAP}}, previous=None)
    return swarm, version, outcome, table


def sheet_of(table: dict, key: str) -> dict:
    return next(s for s in table["sheets"] if s["key"] == key)


def row_of(table: dict, sheet: str, key: str) -> dict:
    return next(r for r in sheet_of(table, sheet)["rows"] if r["key"] == key)


def cell(table: dict, column: str, row: str = "p1", sheet: str = "prompts") -> dict:
    return row_of(table, sheet, row)["cells"][column]


def brief(c: dict) -> tuple:
    return c["text"], c["v"], c["state"], c["tone"], c["note"]


# ── Prompts sheet ─────────────────────────────────────────────────────────


def test_the_contract_example_row_cell_by_cell():
    _, _, _, table = contract_table()
    contract.assert_table(table)
    assert [s["key"] for s in table["sheets"]] == ["prompts", "gaps", "sources"]
    assert table["counts"] == {"total": 7, "done": 6, "failed": 1, "skipped": 0, "stopped": 0}
    assert table["status"] == "partial" and table["previous_version"] is None
    assert table["changes"] == [] and table["notes"] == []

    assert brief(cell(table, "prompt")) == (PROMPT, PROMPT, "ok", None, "Searched from US")
    assert brief(cell(table, "google")) == ("#4", 4, "ok", None, "1 of 1 pages searched")
    assert cell(table, "google")["task_id"] == "google.p1.page1"
    assert brief(cell(table, "ai_overview")) == ("Shown, not named", 2, "ok", "warn", None)
    assert brief(cell(table, "chatgpt")) == (
        "Not named", 1000, "not_found", "warn", "Lists Evernote, OneNote")
    assert brief(cell(table, "claude")) == (
        "Failed", None, "failed", "bad", "The engine was busy or rate limited.")
    for engine, setting in (("gemini", "GEMINI_API_KEY"), ("grok", "XAI_API_KEY"),
                            ("perplexity", "PERPLEXITY_API_KEY")):
        assert brief(cell(table, engine)) == (
            "Not configured", None, "not_configured", "muted", f"{setting} is not set.")
        assert cell(table, engine)["task_id"] is None
    assert cell(table, "ahead")["text"] == (
        "Evernote (1 engine, Google #1), OneNote (1 engine), Obsidian (1 engine)")
    assert cell(table, "ahead")["v"] is None
    assert brief(cell(table, "cited")) == ("14 sources · not you", 14, "ok", "warn", None)
    assert brief(cell(table, "gap")) == (
        "Google ahead (−45)", -45, "ok", "warn",
        "AI score 10, search score 55; from the latest answers and Google check")
    assert cell(table, "finding")["text"] == (
        "Evernote's page answers the buyer question directly; yours does not.")
    assert cell(table, "finding")["task_id"] == "site.p1.gaps"
    assert all(c["version"] == 1 and c["previous"] is None
               for c in row_of(table, "prompts", "p1")["cells"].values())
    assert row_of(table, "prompts", "p1")["task_ids"] == [
        "google.p1.page1", "engines.p1.chatgpt", "engines.p1.claude", "competitors.p1.c1",
        "site.p1.page", "site.p1.gaps", "sources.p1.cited"]


def test_the_contract_example_finding_draft_and_links():
    _, _, _, table = contract_table()
    row = row_of(table, "prompts", "p1")
    draft = row["finding"]
    assert draft["title"] == f"Not named by ChatGPT for “{PROMPT}”"
    assert (draft["category"], draft["severity"], draft["prompt_text"]) == (
        "engines", "medium", PROMPT)
    assert draft["detail"] == (
        "Google: #4, 1 of 1 pages searched. AI Overview: shown, not named. ChatGPT: not named; "
        "lists Evernote, OneNote and Obsidian. Claude: failed. Gap: Google ahead (−45). "
        "Evernote's page answers the buyer question directly; yours does not.")
    serp_item = {"kind": "serp", "label": "Google page 1 · you're #4",
                 "tab_id": f"serp:{CAPTURE}", "url": None}
    own_item = {"kind": "page", "label": "Your page", "tab_id": "page:0a0a0a0a0a0a",
                "url": OWN_URL}
    rival_item = {"kind": "page", "label": "evernote.com", "tab_id": "page:1b1b1b1b1b1b",
                  "url": RIVAL_URL}
    assert draft["evidence"] == [serp_item, own_item, rival_item, {
        "kind": "answer", "label": "ChatGPT answer · not named", "tab_id": None, "url": None}]
    assert row["links"] == [serp_item, own_item, rival_item]


def test_google_cells_for_missing_failed_and_absent_results():
    expansion = expand([resolved(1, PROMPT)], google_pages=2)
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    page1, pane1 = serp(1, top=[serp_row(1, "evernote.com", competitor="Evernote")])
    page2, pane2 = serp(2, capture="999999999999")
    results = {t["id"]: finished(t, "skipped", error=failure("nothing_to_analyze", "n/a"))
               for t in swarm.tasks}
    results["google.p1.page1"] = finished(spec_of(swarm, "google.p1.page1"), detail=page1,
                                          pane=pane1)
    results["google.p1.page2"] = finished(spec_of(swarm, "google.p1.page2"), detail=page2,
                                          pane=pane2)
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    assert brief(cell(table, "google")) == (
        "Not in top 20", 1000, "not_found", "warn", "2 of 2 pages searched")
    assert row_of(table, "prompts", "p1")["finding"]["title"] == (
        f"Not in Google's top 20 for “{PROMPT}”")

    results["google.p1.page1"] = finished(spec_of(swarm, "google.p1.page1"), "stopped",
                                          error=failure("stopped", "Stopped"))
    results["google.p1.page2"] = finished(spec_of(swarm, "google.p1.page2"), "skipped",
                                          error=failure("daily_limit", "Daily allowance used."))
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    assert brief(cell(table, "google")) == ("Stopped", None, "stopped", "muted", "Stopped")
    assert cell(table, "google")["task_id"] == "google.p1.page1"
    results["google.p1.page2"] = finished(spec_of(swarm, "google.p1.page2"), "failed",
                                          error=failure("upstream_error", "Google failed."))
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    assert brief(cell(table, "google")) == ("Failed", None, "failed", "bad", "Google failed.")

    # A Google task never run in any version is not measured.
    table = build_table(swarm, version, outcome_for(version, {}), gaps={}, previous=None)
    assert brief(cell(table, "google")) == ("Not measured", None, "not_measured", "muted", None)
    assert cell(table, "ai_overview")["state"] == "not_measured"


def test_without_google_results_both_google_cells_say_not_configured():
    expansion = expand([resolved(1, PROMPT)], serp=False)
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    assert not [t for t in swarm.tasks if t["category"] in ("google", "competitors")]
    results = {t["id"]: finished(t, "skipped", error=failure("nothing_to_analyze", "n/a"))
               for t in swarm.tasks}
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    for column in ("google", "ai_overview"):
        assert brief(cell(table, column)) == (
            "Not configured", None, "not_configured", "muted", "No Google results key is set.")


@pytest.mark.parametrize(("shown", "expected"), [
    (None, ("Not shown", 0, "ok", None)),
    (overview(shown=False), ("Not shown", 0, "ok", None)),
    (overview(captured=False), ("Shown, not read", 1, "ok", "muted")),
    (overview(mentions=True, cites=True), ("Names you · cites you", 3, "ok", "good")),
    (overview(mentions=True), ("Names you", 3, "ok", "good")),
    (overview(cites=True), ("Cites you", 3, "ok", "good")),
    (overview(), ("Shown, not named", 2, "ok", "warn")),
])
def test_ai_overview_cell(shown, expected):
    from apps.agent.tools.research import DEFERRED_OVERVIEW_NOTE

    swarm, version, results = contract_research()
    detail, pane = serp(positions=[4], ai_overview=shown)
    results["google.p1.page1"] = finished(spec_of(swarm, "google.p1.page1"), detail=detail,
                                          pane=pane)
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    note = DEFERRED_OVERVIEW_NOTE if expected[0] == "Shown, not read" else None
    assert brief(cell(table, "ai_overview")) == (*expected, note)
    assert cell(table, "ai_overview")["task_id"] == "google.p1.page1"


def test_engine_cells_selected_not_asked_named_and_variants():
    configured = [{**e, "configured": True} for e in ENGINES]
    prompts = [
        resolved(1, PROMPT, variants=["gpt4:gpt-4o-mini", "gpt4:gpt-5.5",
                                      "claude:claude-haiku-4-5"]),
    ]
    expansion = expand(prompts, catalog=configured)
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    ids = [t["id"] for t in swarm.tasks if t["category"] == "engines"]
    assert ids == ["engines.p1.chatgpt", "engines.p1.chatgpt-gpt-5-5", "engines.p1.claude"]
    results = {
        "engines.p1.chatgpt": finished(spec_of(swarm, "engines.p1.chatgpt"), detail=answer(
            "chatgpt", brands=["Evernote", "OneNote"])),
        "engines.p1.chatgpt-gpt-5-5": finished(
            spec_of(swarm, "engines.p1.chatgpt-gpt-5-5"),
            detail=answer("chatgpt", mentioned=True, rank=2, sentiment="positive",
                          brands=["Evernote", "Notion"], above=["Evernote"])),
        "engines.p1.claude": finished(spec_of(swarm, "engines.p1.claude"), detail=answer(
            "claude", mentioned=True, sentiment="neutral")),
    }
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    # The best answer of the variants decides; the note counts the others.
    assert brief(cell(table, "chatgpt")) == ("Named #2", 2, "ok", "good",
                                             "Positive · +1 more model")
    assert cell(table, "chatgpt")["task_id"] == "engines.p1.chatgpt-gpt-5-5"
    assert brief(cell(table, "claude")) == ("Named", 100, "ok", None, "Neutral")
    for engine in ("gemini", "grok", "perplexity"):
        assert brief(cell(table, engine)) == (
            "Not selected", None, "not_selected", "muted", "Not in this prompt's model selection")

    # Engines left out by the plan are not measured, not "not selected".
    expansion = expand([resolved(1, PROMPT)], catalog=configured, engines=("claude",))
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    table = build_table(swarm, version, outcome_for(version, {}), gaps={}, previous=None)
    assert brief(cell(table, "chatgpt")) == (
        "Not measured", None, "not_measured", "muted", "Not asked in this research.")
    assert brief(cell(table, "claude")) == ("Not measured", None, "not_measured", "muted", None)


def test_engine_cells_when_no_answer_is_done():
    swarm, version, results = contract_research()
    results["engines.p1.chatgpt"] = finished(
        spec_of(swarm, "engines.p1.chatgpt"), "skipped",
        error=failure("not_configured", "OPENAI_API_KEY is not set."))
    results["engines.p1.claude"] = finished(spec_of(swarm, "engines.p1.claude"), "stopped",
                                            error=failure("stopped", "Stopped"))
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    assert brief(cell(table, "chatgpt")) == (
        "Not configured", None, "not_configured", "muted", "OPENAI_API_KEY is not set.")
    assert brief(cell(table, "claude")) == ("Stopped", None, "stopped", "muted", "Stopped")


def test_ahead_cited_and_finding_fallbacks():
    swarm, version, results = contract_research()
    # Nothing ahead: named first by the engine, first on Google.
    detail, pane = serp(positions=[1], top=[serp_row(1, "notion.so", yours=True)],
                        ai_overview=overview(mentions=True))
    results["google.p1.page1"] = finished(spec_of(swarm, "google.p1.page1"), detail=detail,
                                          pane=pane)
    results["engines.p1.chatgpt"] = finished(spec_of(swarm, "engines.p1.chatgpt"), detail=answer(
        "chatgpt", mentioned=True, rank=1, brands=["Notion"], above=[],
        analysis={"summary": "s", "reasons": [], "opportunity": "Add pricing to the page."}))
    results["sources.p1.cited"] = finished(
        spec_of(swarm, "sources.p1.cited"), "skipped",
        error=failure("nothing_to_analyze", "No engine cited a source for this prompt."))
    results["site.p1.gaps"] = finished(spec_of(swarm, "site.p1.gaps"), "failed",
                                       error=failure("invalid_output", "Unreadable."))
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    assert brief(cell(table, "ahead")) == ("None", None, "ok", None, None)
    assert brief(cell(table, "cited")) == ("None cited", 0, "ok", None, None)
    # The first engine opportunity stands in for a failed content gap analysis.
    assert cell(table, "finding")["text"] == "Add pricing to the page."
    assert cell(table, "finding")["task_id"] == "engines.p1.chatgpt"
    assert brief(cell(table, "gap")) == ("Not checked", None, "not_measured", "muted", None)
    # Named by every engine that answered and found on Google: no draft.
    assert row_of(table, "prompts", "p1")["finding"] is None

    results["engines.p1.chatgpt"]["detail"]["analysis"] = None
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    assert brief(cell(table, "finding")) == ("Failed", None, "failed", "bad", "Unreadable.")

    results["sources.p1.cited"] = finished(spec_of(swarm, "sources.p1.cited"), detail=cited_detail(
        1, [source("notion.so", 1, yours=True)], you=True))
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    assert brief(cell(table, "cited")) == ("1 source · you're cited", 1, "ok", "good", None)


def test_cells_when_content_gaps_and_citations_are_off():
    expansion = expand([resolved(1, PROMPT)], content_gaps=False, citations=False)
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    table = build_table(swarm, version, outcome_for(version, {}), gaps={}, previous=None)
    assert brief(cell(table, "cited")) == (
        "Not measured", None, "not_measured", "muted", "Citations were not requested.")
    assert brief(cell(table, "finding")) == ("—", None, "ok", None, None)
    assert brief(cell(table, "ahead")) == ("Not measured", None, "not_measured", "muted", None)
    assert [s["key"] for s in table["sheets"]] == ["prompts"]


@pytest.mark.parametrize(("gap", "text", "tone"), [
    ({"class": "strong_both", "value": 5, "ai_score": 85, "search_score": 80},
     "Strong in both (+5)", "good"),
    ({"class": "even", "value": 0, "ai_score": 40, "search_score": 40}, "Even (+0)", None),
    ({"class": "ai_ahead", "value": 85, "ai_score": 100, "search_score": 15},
     "AI ahead (+85)", "warn"),
    ({"class": "invisible_both", "value": -5, "ai_score": 0, "search_score": 5},
     "Invisible in both (−5)", "warn"),
])
def test_gap_cells(gap, text, tone):
    swarm, version, results = contract_research()
    table = build_table(swarm, version, outcome_for(version, results), gaps={"p1": {"gap": gap}},
                        previous=None)
    assert (cell(table, "gap")["text"], cell(table, "gap")["v"], cell(table, "gap")["tone"]) == (
        text, gap["value"], tone)


def test_finding_titles_and_severity():
    swarm, version, results = contract_research()
    absent, pane = serp(top=[serp_row(1, "evernote.com", competitor="Evernote")])
    results["google.p1.page1"] = finished(spec_of(swarm, "google.p1.page1"), detail=absent,
                                          pane=pane)
    results["engines.p1.claude"] = finished(spec_of(swarm, "engines.p1.claude"),
                                            detail=answer("claude", brands=["Evernote"]))
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    draft = row_of(table, "prompts", "p1")["finding"]
    # Not named by every engine that answered, and absent on Google: high.
    assert draft["title"] == f"Missing on Google and in ChatGPT and Claude for “{PROMPT}”"
    assert (draft["category"], draft["severity"]) == ("engines", "high")
    assert cell(table, "ahead")["text"] == "Evernote (2 engines, Google #1), OneNote (1 engine), " \
                                           "Obsidian (1 engine)"

    # Named everywhere and found, but the gap class is an issue on its own.
    found, pane = serp(positions=[2], top=[serp_row(2, "notion.so", yours=True)])
    results["google.p1.page1"] = finished(spec_of(swarm, "google.p1.page1"), detail=found,
                                          pane=pane)
    for engine in ("chatgpt", "claude"):
        results[f"engines.p1.{engine}"] = finished(
            spec_of(swarm, f"engines.p1.{engine}"),
            detail=answer(engine, mentioned=True, rank=1, brands=["Notion"], above=[]))
    gap = {"class": "invisible_both", "value": -5, "ai_score": 0, "search_score": 5}
    table = build_table(swarm, version, outcome_for(version, results), gaps={"p1": {"gap": gap}},
                        previous=None)
    draft = row_of(table, "prompts", "p1")["finding"]
    assert draft["title"] == f"Invisible in both for “{PROMPT}”"
    assert (draft["category"], draft["severity"]) == ("google", "high")
    table = build_table(swarm, version, outcome_for(version, results),
                        gaps={"p1": {"gap": {**GAP, "class": "ai_ahead", "value": 40}}},
                        previous=None)
    assert row_of(table, "prompts", "p1")["finding"]["severity"] == "low"
    table = build_table(swarm, version, outcome_for(version, results),
                        gaps={"p1": {"gap": {**GAP, "class": "strong_both", "value": 0}}},
                        previous=None)
    assert row_of(table, "prompts", "p1")["finding"] is None


# ── Gaps and sources sheets ───────────────────────────────────────────────


def test_gap_rows_sorted_by_severity_then_prompt():
    expansion = expand([resolved(1, PROMPT), resolved(2, PROMPT_2)])
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    own, own_pane = page("own", OWN_URL, domain="notion.so", position=4, words=980,
                         capture="0a0a0a0a0a0a")
    results = {
        "site.p1.page": finished(spec_of(swarm, "site.p1.page"), detail=own, pane=own_pane),
        "site.p1.gaps": finished(spec_of(swarm, "site.p1.gaps"), detail=gaps_detail("p1", [
            gap_item("Low one", severity="low"),
            gap_item("High one", severity="high", target=""),
        ])),
        "site.p2.gaps": finished(spec_of(swarm, "site.p2.gaps"), detail=gaps_detail("p2", [
            gap_item("Medium one", severity="medium"),
            gap_item("Other high", severity="high"),
        ])),
    }
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    rows = sheet_of(table, "gaps")["rows"]
    assert [r["key"] for r in rows] == ["p1.g2", "p2.g2", "p2.g1", "p1.g1"]
    first = rows[0]
    assert brief(first["cells"]["page"]) == ("—", None, "ok", None, None)
    assert brief(first["cells"]["severity"]) == ("High", 1, "ok", None, None)
    second = rows[1]["cells"]
    assert (second["page"]["text"], second["page"]["v"]) == ("notion.so/product", OWN_URL)
    assert (second["prompt"]["text"], second["issue"]["text"]) == (PROMPT_2, "Other high")
    assert first["finding"] == {
        "title": "High one",
        "detail": "Evidence: Evernote's H2 'Evernote vs. OneNote'; your page has none. Fix: Add "
                  "a section comparing Notion with Evernote and OneNote.",
        "category": "site", "severity": "high", "prompt_text": PROMPT,
        "evidence": [
            {"kind": "page", "label": "Your page", "tab_id": "page:0a0a0a0a0a0a", "url": OWN_URL},
            {"kind": "page", "label": "evernote.com", "tab_id": None, "url": RIVAL_URL},
        ],
    }
    assert rows[1]["finding"]["evidence"][-1] == {
        "kind": "link", "label": "notion.so/product", "tab_id": None, "url": OWN_URL}
    assert first["task_ids"] == ["site.p1.gaps", "site.p1.page"]

    many = gaps_detail("p1", [gap_item(f"Gap {n}", severity="low") for n in range(1, 13)])
    results["site.p1.gaps"] = finished(spec_of(swarm, "site.p1.gaps"), detail=many)
    results["site.p2.gaps"] = finished(spec_of(swarm, "site.p2.gaps"), detail=many)
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    assert len(sheet_of(table, "gaps")["rows"]) == 20


def test_source_rows_merge_prompts():
    expansion = expand([resolved(1, PROMPT), resolved(2, PROMPT_2)])
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    results = {
        "sources.p1.cited": finished(spec_of(swarm, "sources.p1.cited"), detail=cited_detail(
            5, [source("g2.com", 3, ["chatgpt"]), source("notion.so", 2, ["claude"], yours=True)],
            opportunities=[{"domain": "g2.com", "why": "Cited by ChatGPT",
                            "action": "Claim the G2 listing."}])),
        "sources.p2.cited": finished(spec_of(swarm, "sources.p2.cited"), detail=cited_detail(
            4, [source("g2.com", 1, ["claude"]),
                source("evernote.com", 3, ["chatgpt", "claude"], competitor="Evernote")])),
    }
    table = build_table(swarm, version, outcome_for(version, results), gaps={}, previous=None)
    rows = sheet_of(table, "sources")["rows"]
    assert [r["key"] for r in rows] == ["g2.com", "evernote.com", "notion.so"]
    g2 = rows[0]["cells"]
    assert [g2[c]["text"] for c in contract.SOURCE_COLUMNS] == [
        "g2.com", "4", "ChatGPT, Claude", "2", "No", "—", "Claim the G2 listing."]
    assert (g2["domain"]["v"], g2["citations"]["v"], g2["prompts"]["v"]) == (
        "https://www.g2.com/best", 4, 2)
    assert rows[0]["finding"] == {
        "title": "Get cited on g2.com", "detail": "Claim the G2 listing. Why: Cited by ChatGPT",
        "category": "sources", "severity": "medium", "prompt_text": PROMPT,
        "evidence": [{"kind": "link", "label": "g2.com", "tab_id": None,
                      "url": "https://www.g2.com/best"}],
    }
    assert rows[0]["task_ids"] == ["sources.p1.cited", "sources.p2.cited"]
    assert rows[1]["cells"]["competitor"]["text"] == "Evernote"
    assert rows[1]["finding"] is None
    assert (rows[2]["cells"]["yours"]["text"], rows[2]["cells"]["yours"]["tone"]) == (
        "Yes", "good")


# ── Versions, changes and notes ───────────────────────────────────────────


def test_a_category_rerun_keeps_carried_cells_and_marks_changes():
    swarm, first_version, results = contract_research()
    first = build_table(swarm, first_version, outcome_for(first_version, results),
                        gaps={"p1": {"gap": GAP}}, previous=None)
    previous = json.loads(json.dumps(first))
    detail, pane = serp(positions=[2], top=[serp_row(2, "notion.so", yours=True)],
                        ai_overview=overview(), capture="cccccccccccc")
    google_ids = ["google.p1.page1"]
    version = fake_version(swarm, 2, scope="category", scope_key="google", task_ids=google_ids)
    carried = {task_id: {"version": 1, "message_id": None, "task": task}
               for task_id, task in results.items() if task_id not in google_ids}
    outcome = outcome_for(version, {"google.p1.page1": finished(
        spec_of(swarm, "google.p1.page1"), detail=detail, pane=pane)}, carried=carried)
    table = build_table(swarm, version, outcome, gaps={"p1": {"gap": GAP}}, previous=previous)

    assert table["previous_version"] == 1
    assert table["counts"] == {"total": 1, "done": 1, "failed": 0, "skipped": 0, "stopped": 0}
    assert table["notes"] == [
        "Only the Google (SEO) agents ran in this version; other cells are from version 1."]
    google = cell(table, "google")
    assert (google["text"], google["version"], google["previous"]) == (
        "#2", 2, {"text": "#4", "version": 1})
    assert cell(table, "chatgpt")["version"] == 1 and cell(table, "chatgpt")["previous"] is None
    assert cell(table, "claude")["version"] == 1
    assert table["changes"][0] == {
        "sheet": "prompts", "row": "p1", "column": "google",
        "label": f"{PROMPT} · Google", "from": "#4", "to": "#2"}
    ahead = cell(table, "ahead")
    assert ahead["previous"] == {"text": first["sheets"][0]["rows"][0]["cells"]["ahead"]["text"],
                                 "version": 1}
    assert [c["column"] for c in table["changes"]] == ["google", "ahead"]

    summary = rerun_summary(swarm, version, outcome, table)
    assert summary == (
        "Re-ran 1 agent in 2m 14s: 1 done. The results table is now version 2.\n\n"
        "Changes since version 1:\n"
        f"- {PROMPT} · Google: #4 → #2\n"
        f"- {PROMPT} · Ahead of you: Evernote (1 engine, Google #1), OneNote (1 engine), "
        "Obsidia… → Evernote (1 engine), OneNote (1 engine), Obsidian (1 engine)")


def test_a_task_rerun_note_and_run_time_notes():
    swarm, _, results = contract_research()
    version = fake_version(swarm, 3, scope="task", scope_key="engines.p1.claude",
                           task_ids=["engines.p1.claude"])
    carried = {k: {"version": 1 if k.startswith("google") else 2, "message_id": None, "task": v}
               for k, v in results.items() if k != "engines.p1.claude"}
    outcome = outcome_for(version, {"engines.p1.claude": results["engines.p1.claude"]},
                          carried=carried, notes=[{"level": "info", "code": "reused_captures",
                                                   "text": "Pages were shown again.",
                                                   "category": "google"}])
    table = build_table(swarm, version, outcome, gaps={}, previous=None)
    assert table["notes"] == [
        f"Only the Claude · “{PROMPT}” agent ran in this version; other cells are from earlier "
        "versions.",
        "Pages were shown again.",
    ]


def test_changes_order_and_cap():
    swarm, version, results = contract_research()
    table = build_table(swarm, version, outcome_for(version, results), gaps={"p1": {"gap": GAP}},
                        previous=None)
    previous = json.loads(json.dumps(table))
    previous["version"] = 1
    for key, c in previous["sheets"][0]["rows"][0]["cells"].items():
        c["text"] = f"old {key}"
        c["state"] = "ok"
    previous["sheets"][1]["rows"][0]["cells"]["issue"]["text"] = "old issue"
    again = build_table(swarm, fake_version(swarm, 2), outcome_for(version, results),
                        gaps={"p1": {"gap": GAP}}, previous=previous)
    columns = [(c["sheet"], c["column"]) for c in again["changes"]]
    # Measured columns and changes of state first (chatgpt and claude also
    # changed state), then the text cells, then the other sheets.
    measured = [("prompts", k) for k in ("google", "ai_overview", "chatgpt", "claude", "gemini",
                                         "grok", "perplexity", "gap")]
    assert columns[:len(measured)] == measured
    assert columns[len(measured):] == [("prompts", k) for k in (
        "prompt", "ahead", "cited", "finding")] + [("gaps", "issue")]

    many = json.loads(json.dumps(again))
    rows = many["sheets"][0]["rows"]
    many["sheets"][0]["rows"] = [{**rows[0], "key": f"p{n}"} for n in range(1, 4)]
    for r in many["sheets"][0]["rows"]:
        for c in r["cells"].values():
            c["text"] = "x"
    previous = json.loads(json.dumps(many))
    for r in previous["sheets"][0]["rows"]:
        for c in r["cells"].values():
            c["text"] = "y"
    assert len(swarm_tables.apply_previous(many, previous)) == 30


# ── Markdown and texts ────────────────────────────────────────────────────


def test_table_markdown_and_report_appendix():
    _, _, _, table = contract_table()
    table["generated_at"] = "2026-11-04T10:17:18.880Z"
    assert table_markdown(table, sheets=("prompts",)) == (
        "| Prompt | Google | AI Overview | ChatGPT | Claude | Gemini | Grok | Perplexity | Gap |\n"
        "|---|---|---|---|---|---|---|---|---|\n"
        f"| {PROMPT} | #4 | Shown, not named | Not named | Failed | Not configured | "
        "Not configured | Not configured | Google ahead (−45) |")
    appendix = report_appendix(table, {"duration_ms": 134201})
    assert appendix == (
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
        "Evernote and OneNote. | notion.so/product | High |")


def test_markdown_escapes_pipes_and_newlines():
    _, _, _, table = contract_table()
    row = table["sheets"][0]["rows"][0]
    row["cells"]["prompt"]["text"] = "a | b\nc"
    assert "| a \\| b c |" in table_markdown(table, sheets=("prompts",))


def test_rerun_summary_texts():
    swarm, version, results = contract_research()
    outcome = outcome_for(version, results, duration_ms=9000)
    table = build_table(swarm, version, outcome, gaps={}, previous=None)
    assert rerun_summary(swarm, version, outcome, table) == (
        "Re-ran 7 agents in 9s: 6 done, 1 failed. The results table is now version 1.")
    table["previous_version"] = 1
    assert rerun_summary(swarm, version, outcome, table).endswith(
        "\n\nNo measured value changed since version 1.")
    table["changes"] = [{"sheet": "prompts", "row": "p1", "column": "finding", "label": "x",
                         "from": "a", "to": "b"}]
    assert rerun_summary(swarm, version, outcome, table).endswith(
        "No measured value changed since version 1.")
    stopped = outcome_for(version, results, status="cancelled")
    table["counts"] = {"total": 7, "done": 3, "failed": 1, "skipped": 0, "stopped": 3}
    assert rerun_summary(swarm, version, stopped, table) == (
        "Stopped after 4 of 7 agents. The results table (version 1) shows what they found.")
    error = outcome_for(version, {}, status="error",
                        error=failure("swarm_failed", "The plan could not start."))
    assert rerun_summary(swarm, version, error, None) == (
        "The research agents could not run: The plan could not start.")


@pytest.mark.parametrize(("ms", "text"), [
    (0, "0s"), (9000, "9s"), (65000, "1m 5s"), (120000, "2m"), (134201, "2m 14s"),
    (3840000, "1h 4m"), (7200000, "2h"),
])
def test_format_duration_matches_the_frontend(ms, text):
    assert format_duration(ms) == text


# ── Tool result ───────────────────────────────────────────────────────────


def test_tool_result_shape_states_and_untrusted_text():
    swarm, version, outcome, table = contract_table()
    result = build_tool_result(swarm, version, outcome, table, {"p1": {"gap": GAP}})
    assert not contract.missing(contract.SWARM_TOOL_RESULT, result)
    assert result["agents"] == table["counts"] and result["duration_s"] == 134
    assert result["google"] == {"configured": True, "pages_per_prompt": 1}
    assert result["engines_asked"] == ["ChatGPT", "Claude"]
    assert result["engines_not_configured"] == ["Gemini", "Grok", "Perplexity"]
    assert result["notes"] == [
        "Gemini, Grok and Perplexity are not configured, so they were not asked."]
    assert result["table_shown"] is True and "clipped" not in result
    prompt = result["prompts"][0]
    assert not contract.missing(contract.SWARM_TOOL_PROMPT, prompt)
    assert prompt["location"] == "us"
    google = prompt["google"]
    assert (google["state"], google["found"], google["best_position"], google["pages_searched"],
            google["rank_recorded"]) == ("ok", True, 4, 1, False)
    assert google["ai_overview"] == {"shown": True, "mentions_you": False, "cites_you": False,
                                     "content_captured": True}
    assert google["top"][0] == {"position": 1, "domain": "evernote.com",
                                "title": "evernote.com title", "is_yours": False,
                                "is_competitor": True}
    chatgpt = prompt["engines"]["chatgpt"]
    # Contract 3f: a measured answer is "ok"; ``mentioned`` says it does not name you.
    assert (chatgpt["state"], chatgpt["mentioned"], chatgpt["rank"], chatgpt["sentiment"]) == (
        "ok", False, None, None)
    assert chatgpt["brands_above"] == ["Evernote", "OneNote", "Obsidian"]
    assert chatgpt["analysis"] == {
        "untrusted": True, "source": "ChatGPT answer analysis",
        "text": "Summary: ChatGPT recommends Evernote, OneNote and Obsidian. Reasons: Strong "
                "offline mode; Free tier Opportunity: Publish a comparison page that names "
                "offline support."}
    assert prompt["engines"]["claude"] == {"state": "failed",
                                           "error": "The engine was busy or rate limited."}
    assert prompt["engines"]["gemini"] == {"state": "not_configured"}
    assert prompt["competitor_pages"] == [{
        "url": RIVAL_URL, "position": 1,
        "title": {"untrusted": True, "source": "evernote.com", "text": "Page title"},
        "word_count": 2140, "structured_data": ["FAQPage"]}]
    assert prompt["your_page"] == {"url": OWN_URL, "position": 4, "word_count": 980,
                                   "structured_data": []}
    assert prompt["content_gaps"]["untrusted"] is True
    assert prompt["content_gaps"]["text"].splitlines()[1].startswith(
        "1. No comparison with alternatives Evidence: ")
    assert prompt["sources"]["total"] == 14 and prompt["sources"]["you_cited"] is False
    assert prompt["sources"]["top"][0] == {"domain": "g2.com", "citations": 3,
                                           "engines": ["chatgpt"]}
    assert prompt["gap"] == {"class": "google_ahead", "label": "Google ahead", "value": -45,
                             "ai_score": 10, "search_score": 55}
    assert prompt["problems"] == ["Claude: The engine was busy or rate limited."]


def test_tool_result_for_a_brand_google_does_not_list():
    swarm, version, results = contract_research()
    detail, pane = serp(top=[serp_row(1, "evernote.com", competitor="Evernote")])
    results["google.p1.page1"] = finished(spec_of(swarm, "google.p1.page1"), detail=detail,
                                          pane=pane)
    outcome = outcome_for(version, results, rank_checks={"p1": True})
    table = build_table(swarm, version, outcome, gaps={}, previous=None)
    google = build_tool_result(swarm, version, outcome, table, {})["prompts"][0]["google"]
    assert (google["state"], google["found"], google["best_position"], google["pages_searched"],
            google["rank_recorded"], google["ai_overview"]) == ("ok", False, None, 1, True, None)
    results["google.p1.page1"] = finished(spec_of(swarm, "google.p1.page1"), "failed",
                                          error=failure("upstream_error", "Google failed."))
    outcome = outcome_for(version, results)
    table = build_table(swarm, version, outcome, gaps={}, previous=None)
    assert build_tool_result(swarm, version, outcome, table, {})["prompts"][0]["google"] == {
        "state": "failed", "error": "Google failed."}


def test_tool_result_is_clipped_to_16000_characters():
    prompts = [resolved(i, f"{PROMPT} number {i} " + "x" * 200) for i in range(1, 4)]
    expansion = expand(prompts)
    swarm = fake_swarm(expansion)
    version = fake_version(swarm)
    long = "word " * 400
    results = {}
    for spec in swarm.tasks:
        key = spec["subcategory"]
        if spec["worker"] == "engine_answer":
            detail = answer(spec["inputs"]["engine"], brands=[f"Brand {n}" for n in range(10)],
                            analysis={"summary": long, "reasons": [long, long],
                                      "opportunity": long})
            results[spec["id"]] = finished(spec, detail=detail)
        elif spec["worker"] == "content_gap":
            results[spec["id"]] = finished(spec, detail=gaps_detail(long, [
                gap_item(long, evidence=long, fix=long) for _ in range(4)]))
        elif spec["worker"] == "serp_page":
            detail, pane = serp(top=[serp_row(n, f"site{n}.com") for n in range(1, 6)],
                                capture=f"{key}aaaaaaaaaa")
            results[spec["id"]] = finished(spec, detail=detail, pane=pane)
        else:
            results[spec["id"]] = finished(spec, "skipped",
                                           error=failure("nothing_to_analyze", long))
    outcome = outcome_for(version, results)
    table = build_table(swarm, version, outcome, gaps={}, previous=None)
    result = build_tool_result(swarm, version, outcome, table, {})
    assert result["clipped"] is True
    assert len(compact(result)) <= swarm_tables.TOOL_RESULT_MAX_CHARS
    # Clipped, never dropped: every prompt and engine is still there.
    assert len(result["prompts"]) == 3
    assert set(result["prompts"][0]["engines"]) == set(swarm_tables.ENGINE_KEYS)
