"""The research plan's expansion into categories and tasks (design 6)."""
from decimal import Decimal

import pytest

from apps.agent.runtime.swarm import plan
from apps.agent.runtime.swarm.plan import PlanOptions, ResolvedPrompt
from apps.agent.tests.swarm_support import catalog

NOW = "2026-11-04T10:15:00.120Z"


def _prompt(i: int, text: str | None = None, *, variants=(), location="us") -> ResolvedPrompt:
    return ResolvedPrompt(key=f"p{i}", prompt_id=f"prompt-{i}", brand_prompt_id=f"bp-{i}",
                          text=text or f"best crm for team {i}", location=location,
                          model_variants=tuple(variants), tracked_now=False)


def _expand(prompts, *, options=None, engines=None, serp=True):
    return plan.build_expansion(None, prompts, options or PlanOptions(title="Research Northwind"),
                                engines=engines or catalog(), serp_configured=serp,
                                now_iso=NOW)


def _ids(expansion):
    return [t["id"] for t in expansion.tasks]


def _task(expansion, task_id):
    return next(t for t in expansion.tasks if t["id"] == task_id)


def _notes(expansion, category):
    found = next((c for c in expansion.categories if c["key"] == category), None)
    return {n["code"]: n for n in (found or {}).get("notes", [])}


def test_the_defaults_plan_every_task_of_every_prompt_in_task_order():
    expansion = _expand([_prompt(1), _prompt(2)])

    assert _ids(expansion) == [
        "google.p1.page1", "engines.p1.chatgpt", "engines.p1.claude", "competitors.p1.c1",
        "site.p1.page", "site.p1.gaps", "sources.p1.cited",
        "google.p2.page1", "engines.p2.chatgpt", "engines.p2.claude", "competitors.p2.c1",
        "site.p2.page", "site.p2.gaps", "sources.p2.cited",
    ]
    labels = {t["id"]: t["label"] for t in expansion.tasks}
    assert labels["google.p1.page1"] == "Google page 1"
    assert labels["engines.p1.chatgpt"] == "ChatGPT"
    assert labels["competitors.p1.c1"] == "Competitor page 1"
    assert labels["site.p1.page"] == "Your page"
    assert labels["site.p1.gaps"] == "Content gaps"
    assert labels["sources.p1.cited"] == "Cited sources"
    assert _task(expansion, "competitors.p1.c1")["target"] == "Chosen from Google results"
    assert _task(expansion, "site.p1.page")["target"] == "Your best-ranking page"
    assert _task(expansion, "engines.p2.claude")["target"] == "best crm for team 2"
    assert _task(expansion, "engines.p1.chatgpt")["inputs"] == {
        "prompt_key": "p1", "engine": "chatgpt", "provider": "gpt4", "variant": None}
    assert _task(expansion, "google.p1.page1")["inputs"] == {"prompt_key": "p1", "page": 1}
    assert _task(expansion, "site.p1.page")["inputs"] == {"prompt_key": "p1", "role": "own"}
    assert {t["subcategory"] for t in expansion.tasks if t["id"].split(".")[1] == "p2"} == {"p2"}


def test_no_google_page_past_the_providers_reliable_pages_is_planned():
    # ScraperAPI reads page one only (serp_google.max_reliable_pages).
    options = PlanOptions(title="Research Northwind", google_pages=2)

    def google_ids(serp_pages):
        expansion = plan.build_expansion(None, [_prompt(1)], options, engines=catalog(),
                                         serp_configured=True, now_iso=NOW,
                                         serp_pages=serp_pages)
        return [i for i in _ids(expansion) if i.startswith("google.")], expansion.plan

    ids, planned = google_ids(1)
    assert ids == ["google.p1.page1"] and planned["google_pages"] == 1
    ids, planned = google_ids(10)
    assert ids == ["google.p1.page1", "google.p1.page2"] and planned["google_pages"] == 2


def test_dependencies_follow_the_contract():
    expansion = _expand([_prompt(1)], options=PlanOptions(title="R", google_pages=2,
                                                          competitor_pages=2))

    assert _task(expansion, "competitors.p1.c2")["depends_on"] == [
        "google.p1.page1", "google.p1.page2"]
    assert _task(expansion, "site.p1.page")["depends_on"] == ["google.p1.page1", "google.p1.page2"]
    assert _task(expansion, "site.p1.gaps")["depends_on"] == [
        "site.p1.page", "competitors.p1.c1", "competitors.p1.c2", "engines.p1.chatgpt",
        "engines.p1.claude"]
    assert _task(expansion, "sources.p1.cited")["depends_on"] == [
        "engines.p1.chatgpt", "engines.p1.claude", "google.p1.page1"]
    assert _task(expansion, "google.p1.page2")["depends_on"] == []
    # Every dependency comes earlier in task order.
    seen = set()
    for task in expansion.tasks:
        assert set(task["depends_on"]) <= seen
        seen.add(task["id"])


def test_categories_hold_the_prompts_with_tasks_and_the_plan_is_normalized():
    expansion = _expand([_prompt(1), _prompt(2)],
                        options=PlanOptions(title="Research Northwind",
                                            competitors=("https://www.HubSpot.com/crm",)))

    assert [c["key"] for c in expansion.categories] == [
        "google", "engines", "competitors", "site", "sources"]
    google = expansion.categories[0]
    assert google["label"] == "Google (SEO)"
    assert google["subcategories"] == [{"key": "p1", "label": "best crm for team 1"},
                                       {"key": "p2", "label": "best crm for team 2"}]
    engines_note = _notes(expansion, "engines")["engines_not_configured"]
    assert engines_note == {
        "level": "info", "code": "engines_not_configured",
        "text": "Gemini, Grok and Perplexity are not configured, so they were not asked.",
    }
    assert _task(expansion, "competitors.p1.c1")["inputs"]["prefer"] == ["hubspot.com"]
    assert expansion.plan == {
        "title": "Research Northwind",
        "prompts": [
            {"key": "p1", "prompt_id": "prompt-1", "brand_prompt_id": "bp-1",
             "text": "best crm for team 1", "location": "us", "model_variants": [],
             "tracked_now": False},
            {"key": "p2", "prompt_id": "prompt-2", "brand_prompt_id": "bp-2",
             "text": "best crm for team 2", "location": "us", "model_variants": [],
             "tracked_now": False},
        ],
        "google_pages": 1, "engines": None, "competitor_pages": 1,
        "competitors": ["hubspot.com"], "content_gaps": True, "citations": True,
        "serp_configured": True, "engines_asked": ["chatgpt", "claude"],
        "engines_not_configured": ["gemini", "grok", "perplexity"], "planned_at": NOW,
    }


def test_a_non_default_variant_gets_its_own_id_and_label():
    expansion = _expand([_prompt(1, variants=["claude:claude-sonnet-5", "gpt4:gpt-4o-mini",
                                              "gpt4:gpt-5.6-terra"])])

    engines = [t for t in expansion.tasks if t["category"] == "engines"]
    assert [(t["id"], t["label"], t["inputs"]["variant"]) for t in engines] == [
        ("engines.p1.chatgpt", "ChatGPT", None),
        ("engines.p1.chatgpt-gpt-5-6-terra", "ChatGPT · GPT-5.6 Terra", "gpt4:gpt-5.6-terra"),
        ("engines.p1.claude-claude-sonnet-5", "Claude · Claude Sonnet 5",
         "claude:claude-sonnet-5"),
    ]
    assert all(t["inputs"]["engine"] in ("chatgpt", "claude") for t in engines)


def test_engines_outside_a_prompts_selection_are_noted_not_planned():
    expansion = _expand([_prompt(1, "best crm", variants=["claude:claude-haiku-4-5"])],
                        engines=catalog(("chatgpt", "claude", "perplexity")))

    assert [t["id"] for t in expansion.tasks if t["category"] == "engines"] == [
        "engines.p1.claude"]
    note = _notes(expansion, "engines")["engines_not_selected"]
    assert note["text"] == ("The prompt “best crm” selects only Haiku 4.5, so ChatGPT and "
                            "Perplexity were not asked for it.")
    assert expansion.plan["engines_asked"] == ["claude"]


def test_deepseek_in_a_selection_is_noted_as_not_compared():
    expansion = _expand([_prompt(1, "best crm", variants=["deepseek:deepseek-chat",
                                                          "claude:claude-haiku-4-5"])])

    assert not any("deepseek" in t["id"] for t in expansion.tasks)
    note = _notes(expansion, "engines")["variant_not_compared"]
    assert note["text"].startswith("DeepSeek Chat is selected for “best crm” but the research")
    assert note["level"] == "info"


def test_without_google_results_there_are_no_google_or_competitor_tasks():
    expansion = _expand([_prompt(1)], serp=False)

    assert _ids(expansion) == ["engines.p1.chatgpt", "engines.p1.claude", "site.p1.page",
                               "site.p1.gaps", "sources.p1.cited"]
    assert _task(expansion, "site.p1.page")["target"] == "Your homepage"
    assert _task(expansion, "site.p1.page")["depends_on"] == []
    assert _task(expansion, "sources.p1.cited")["depends_on"] == [
        "engines.p1.chatgpt", "engines.p1.claude"]
    first = expansion.categories[0]
    assert first["key"] == "engines"
    assert first["notes"][0] == {
        "level": "warning", "code": "serp_not_configured",
        "text": "Google results are not available (no SERPAPI_KEY or SCRAPERAPI_KEY), so no "
                "Google pages or competitor pages were planned. Your homepage is read instead.",
    }
    assert expansion.plan["serp_configured"] is False


def test_content_gaps_and_citations_can_be_left_out():
    expansion = _expand([_prompt(1)], options=PlanOptions(title="R", content_gaps=False,
                                                          citations=False, competitor_pages=0))

    assert _ids(expansion) == ["google.p1.page1", "engines.p1.chatgpt", "engines.p1.claude"]
    assert [c["key"] for c in expansion.categories] == ["google", "engines"]


def test_no_engine_configured_keeps_the_engines_notes_and_skips_citations():
    expansion = _expand([_prompt(1)], engines=catalog(()), serp=True)

    assert "sources.p1.cited" not in _ids(expansion)
    engines = next(c for c in expansion.categories if c["key"] == "engines")
    assert engines["subcategories"] == []
    assert engines["notes"][0]["text"] == (
        "ChatGPT, Claude, Gemini, Grok and Perplexity are not configured, so they were not "
        "asked.")
    assert _task(expansion, "site.p1.gaps")["depends_on"] == ["site.p1.page", "competitors.p1.c1"]


def test_the_engines_option_limits_the_engines_asked():
    expansion = _expand([_prompt(1)], options=PlanOptions(title="R", engines=("claude", "grok")))

    assert [t["id"] for t in expansion.tasks if t["category"] == "engines"] == [
        "engines.p1.claude"]
    assert expansion.plan["engines"] == ["claude", "grok"]
    assert expansion.plan["engines_not_configured"] == ["grok"]
    assert _notes(expansion, "engines")["engines_not_configured"]["text"] == (
        "Grok is not configured, so it was not asked.")


def test_competitors_that_are_not_domains_are_dropped_with_a_note():
    expansion = _expand([_prompt(1)], options=PlanOptions(
        title="R", competitors=("atlassian.com", "not a domain", "atlassian.com")))

    assert expansion.plan["competitors"] == ["atlassian.com"]
    note = _notes(expansion, "competitors")["competitor_dropped"]
    assert note["text"] == ("“not a domain” is not a domain, so it was not used to choose "
                            "competitor pages.")


def test_estimate_cost_counts_engine_answers_and_analyses():
    specs = _expand([_prompt(1)]).tasks  # 2 engines, 1 content gap, 1 citations

    assert plan.estimate_cost(specs, with_report=False) == Decimal("0.056")
    assert plan.estimate_cost(specs, with_report=True) == Decimal("0.306")
    assert plan.estimate_cost([], with_report=False) == Decimal("0")


def test_max_prompts_for_divides_the_cap_by_the_agents_per_prompt():
    common = {"google_pages": 1, "competitor_pages": 1, "content_gaps": True, "citations": True,
              "max_tasks": 30}
    assert plan.max_prompts_for(engines_per_prompt=5, serp_configured=True, **common) == 3
    assert plan.max_prompts_for(engines_per_prompt=2, serp_configured=True, **common) == 4
    assert plan.max_prompts_for(engines_per_prompt=0, serp_configured=False,
                                **{**common, "content_gaps": False}) == 0


def test_scope_task_ids():
    tasks = _expand([_prompt(1), _prompt(2)]).tasks

    assert plan.scope_task_ids(tasks, "all", "") == [t["id"] for t in tasks]
    assert plan.scope_task_ids(tasks, "category", "google") == ["google.p1.page1",
                                                                "google.p2.page1"]
    assert plan.scope_task_ids(tasks, "task", "engines.p2.claude") == ["engines.p2.claude"]
    no_google = _expand([_prompt(1)], serp=False).tasks
    assert plan.scope_task_ids(no_google, "category", "google") == []
    for scope, key in (("category", "maps"), ("task", "engines.p9.claude"), ("everything", "")):
        with pytest.raises(ValueError):
            plan.scope_task_ids(tasks, scope, key)


def test_scope_labels():
    expansion = _expand([_prompt(1, "best note taking app for teams that work remotely a lot "
                                    "and need offline mode")])
    args = (expansion.categories, expansion.tasks, expansion.plan["prompts"])

    assert plan.scope_label(*args, "all", "") == "All agents"
    assert plan.scope_label(*args, "category", "engines") == "AI engines (GEO)"
    assert plan.scope_label(*args, "task", "engines.p1.claude") == (
        "Claude · “best note taking app for teams that work remotely a lot and…”")


def test_initial_task_is_queued_at_rev_one():
    spec = _task(_expand([_prompt(1)]), "site.p1.gaps")

    assert plan.initial_task(spec) == {
        "id": "site.p1.gaps", "category": "site", "subcategory": "p1", "worker": "content_gap",
        "label": "Content gaps", "target": "best crm for team 1", "status": "queued",
        "step": "", "result": "", "tone": None,
        "depends_on": ["site.p1.page", "competitors.p1.c1", "engines.p1.chatgpt",
                       "engines.p1.claude"],
        "started_at": None, "ended_at": None, "duration_ms": None, "attempt": 0,
        "error": None, "pane": None, "detail": None, "rev": 1,
    }
