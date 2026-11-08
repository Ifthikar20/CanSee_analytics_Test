"""What the orchestrator is told about the research agents (backend design
5a and 16): the prompt version and its section, the exact research_swarm
definition of contract 3a, and the tool offered only while enabled."""
from __future__ import annotations

import json

import pytest

from apps.agent.prompts import orchestrator
from apps.agent.tools import registry

# Contract 3a, verbatim (the registry adds eager_input_streaming).
DEFINITION = json.loads(r"""
{
  "name": "research_swarm",
  "description": "Run the research agents: a team of up to 30 agents that work in parallel on 1 to 5 buyer prompts, each doing one real step: fetching one Google results page, asking one AI engine one prompt, reading one competitor page or the brand's own page, or analyzing content gaps or cited sources. The user sees every agent's status live. Returns one consolidated table: per prompt the Google position, the AI Overview, each engine's mention and rank, the brands ahead, the cited sources and the gap class, plus the content gaps and the cited sources. Agents per prompt = Google pages + engines asked + competitor pages + 2 when content_gaps is on + 1 when citations is on; at most 30 in total. Pass rerun_of with an earlier result's swarm_id, and nothing else, to run the same research again with fresh data. Google pages and engine answers cost money and use the project's allowances.",
  "input_schema": {
    "type": "object",
    "properties": {
      "title": {"type": "string", "description": "A short name for this research, shown to the user, for example \"Research Notion\"."},
      "prompts": {
        "type": "array", "minItems": 1, "maxItems": 5,
        "description": "The buyer prompts to research. Use tracked prompts (prompt_id) when they fit. A new prompt (text) must be one the user wrote or confirmed in this chat; it is tracked before the agents start.",
        "items": {
          "type": "object",
          "properties": {
            "prompt_id": {"type": "string", "description": "A tracked prompt's prompt_id, as list_tracked_prompts returns it."},
            "text": {"type": "string", "description": "A new prompt's exact text, as the user wrote or confirmed it."},
            "location": {"type": "string", "description": "Two-letter country code (ISO 3166-1 alpha-2) to search from, for a new prompt only, for example \"us\"."}
          },
          "additionalProperties": false
        }
      },
      "google_pages": {"type": "integer", "minimum": 1, "maximum": 2, "description": "Google results pages per prompt, 10 results each (default 1)."},
      "engines": {"type": "array", "minItems": 1, "maxItems": 5, "items": {"type": "string", "enum": ["chatgpt", "claude", "gemini", "grok", "perplexity"]}, "description": "AI engines to ask (default: every configured engine). Engines without an API key are reported as not configured."},
      "competitor_pages": {"type": "integer", "minimum": 0, "maximum": 2, "description": "Competitor pages to read per prompt, chosen from that prompt's Google results (default 1)."},
      "competitors": {"type": "array", "maxItems": 5, "items": {"type": "string"}, "description": "Competitor domains to prefer when choosing competitor pages, for example \"atlassian.com\"."},
      "content_gaps": {"type": "boolean", "description": "Read the brand's own page for each prompt and compare it with the competitor pages (default true)."},
      "citations": {"type": "boolean", "description": "Collect and analyze the sources the AI engines cite for each prompt (default true)."},
      "rerun_of": {"type": "string", "description": "A swarm_id from an earlier research_swarm result: runs that research again with fresh data and the same plan. Leave out every other field."}
    },
    "additionalProperties": false
  }
}
""")

SECTION = """\
# Research agents (research_swarm)
Use research_swarm for broad research: the user asks you to research the brand, to check how it \
shows up on Google and in the AI engines across several prompts, to compare it with competitors, \
or asks for the research agents. It runs a team of agents in parallel (each fetches one Google \
results page, asks one engine one prompt, reads one page or analyzes one prompt), shows them \
working, and returns one consolidated table. For a narrow question about one prompt, one engine \
or one page, use the single tools instead.
1. Prompts. Call list_tracked_prompts first. Pick 2 to 4 prompts that fit the request: tracked \
prompts by prompt_id, or prompts the user wrote or confirmed in this chat by text (they are \
tracked when the research starts). If there are none, propose 3 to 5 buyer-intent prompts, ask \
the user to confirm, and run the research after they say yes.
2. Plan. Use the defaults (google_pages 1, competitor_pages 1, every configured engine, \
content_gaps and citations on) unless the user asked for more depth. Put competitors the user \
named in competitors. A research has at most 30 agents: each prompt adds its Google pages, the \
engines asked, its competitor pages, and 3 more with content_gaps and citations on, so with all \
five engines configured use at most 3 prompts. If the result says the plan is too large or the \
allowance is short, make the plan smaller and call it once more.
3. Report. The app shows the agents and the results table above your reply, and a saved report \
includes that table, so do not repeat the full table. Write the report from the tool result: a \
title line starting with "# ", a summary of three sentences, one section per prompt (what Google \
shows, what each engine says and which brands it lists above the brand, what the competitor pages \
do that the brand's page does not, which sources the engines cite, the gap label and value, and \
the 2 to 4 most important fixes, each naming the page to change or create), and a "Method" \
section (when the research ran, the location, how many agents ran, failed and were skipped, the \
engines asked and the engines not configured). Report every cell that is not measured, not \
configured, not selected, skipped or failed as exactly that, never as zero or "not named".
4. Re-runs. When the user asks to run the research again, call research_swarm with rerun_of set \
to the earlier result's swarm_id and nothing else. Do not also call google_search, \
check_ai_engines or inspect_page for the same prompts in the same turn.
"""


def test_the_prompt_version_is_bumped():
    assert orchestrator.VERSION == "2026-11-08.1"


def test_the_research_agents_section_follows_the_ground_rules():
    prompt = orchestrator.SYSTEM_PROMPT
    assert SECTION in prompt
    order = [prompt.index(h) for h in ("# Ground rules", "# Research agents (research_swarm)",
                                       "# Research workflow", "# When to call each tool")]
    assert order == sorted(order)
    assert ("# Research workflow\nUse it for a narrow research question about one or two "
            "prompts, or when research_swarm is not in your tools.\n1. Prompts.") in prompt
    assert ("# When to call each tool\n- research_swarm: for broad research across several "
            "prompts, or when the user asks for the research agents (see \"Research "
            "agents\").\n") in prompt
    assert all(ord(ch) < 0x2190 for ch in prompt), "no emojis or pictographs in the prompt"


def test_the_definition_is_contract_3a_exactly():
    definitions = {t["name"]: t for t in registry.client_tool_definitions()}
    assert definitions["research_swarm"] == {**DEFINITION, "eager_input_streaming": True}
    spec = registry.TOOLS["research_swarm"]
    assert (spec.label, spec.own_parts) == ("Research agents", True)
    assert registry.owns_parts("research_swarm")


@pytest.mark.django_db
def test_research_swarm_is_offered_only_while_enabled(settings):
    from apps.agent.llm.snapshot import get_or_create_snapshot

    enabled = get_or_create_snapshot()
    names = [t["name"] for t in json.loads(enabled.tools_json)]
    assert "research_swarm" in names and names == sorted(names)
    assert enabled.version == "2026-11-08.1"

    settings.AGENT_SWARM_ENABLED = False
    disabled = get_or_create_snapshot()
    names = [t["name"] for t in json.loads(disabled.tools_json)]
    assert "research_swarm" not in names and "google_search" in names
    assert disabled.id != enabled.id
    # A chat pinned to the enabled snapshot still gets an answer: the tool
    # refuses with swarm_disabled (test_swarm_tool), never "Unknown tool".
    assert "research_swarm" in registry.TOOLS
