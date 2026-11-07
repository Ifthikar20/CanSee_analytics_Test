"""What the agents read of the context (design/p2_backend.md 11f): the
<brand> block's sections, the water-fill, suggestions left out, the
offerings mirror, the project context line, the measured helpers'
section text and counts, and BRAND_RULES at the end of every writer."""
import json

import pytest

from apps.agent.models import AgentContextEntry
from apps.agent.prompts.common import BRAND_RULES
from apps.agent.prompts.context import brand_context_line, project_context
from apps.agent.services import context
from apps.agent.subagents.base import _specs
from apps.agent.tools.data import brand_facts

pytestmark = pytest.mark.django_db


def test_agent_context_lists_active_entries_in_section_order(user, website):
    website.competitors = [{"name": "Evernote", "domain": "evernote.com"}]
    website.save(update_fields=["competitors"])
    context.create_entry(website, user, section="execution", title="Voice", body="Plain.")
    context.create_entry(website, user, section="company", title="Founded in 2013",
                         body="Since 2013.", references=[
                             {"kind": "page", "url": "https://northwind.example/about",
                              "quote": "q" * 300},
                             {"kind": "competitor", "competitor_domain": "evernote.com"}])
    AgentContextEntry.objects.create(website=website, section="company", title="Suggested",
                                     status="suggested", origin="built")

    out = context.agent_context(website)
    assert list(out) == list(context.SECTION_KEYS)
    assert out["company"] == [{
        "id": "e1", "title": "Founded in 2013", "body": "Since 2013.",
        "references": [
            {"kind": "page", "label": "/about", "url": "https://northwind.example/about",
             "quote": "q" * 199 + "…"},
            {"kind": "competitor", "label": "Evernote", "url": "", "quote": ""},
        ],
    }]
    assert out["execution"] == [{"id": "e2", "title": "Voice", "body": "Plain.",
                                 "references": []}]
    assert out["audience"] == [] and out["strategy"] == []


def test_long_sections_share_the_room_short_ones_stay_whole(user, website):
    context.create_entry(website, user, section="audience", title="Short", body="Fleet managers.")
    for i in range(3):
        context.create_entry(website, user, section="strategy", title=f"Long {i}",
                             body="x" * 3900)
    out = context.agent_context(website, max_chars=3000)
    assert out["audience"][0]["body"] == "Fleet managers."
    total = sum(len(e["title"]) + len(e["body"]) for s in out.values() for e in s)
    assert total <= 3000
    lengths = [len(e["body"]) for e in out["strategy"]]
    assert max(lengths) - min(lengths) <= 1 and min(lengths) > 900


def test_brand_facts_carry_the_context_and_an_offerings_mirror(user, website):
    context.create_entry(website, user, section="offerings", title="Fleet packs", body="48V.",
                         references=[{"kind": "page", "url": "https://northwind.example/fleet"}])
    context.create_entry(website, user, section="offerings", title="Service", body="Yearly.")
    facts = brand_facts(website)
    assert set(facts) == {"name", "url", "industry", "description", "topics", "competitors",
                          "context", "offerings"}
    assert facts["offerings"] == [
        {"name": "Fleet packs", "description": "48V.", "url": "https://northwind.example/fleet"},
        {"name": "Service", "description": "Yearly.", "url": ""},
    ]
    assert facts["context"]["offerings"][0]["id"] == "e1"


def test_the_helpers_the_insights_read(user, website):
    context.create_entry(website, user, section="offerings", title="Fleet packs", body="48V.",
                         references=[{"kind": "page", "url": "https://northwind.example/fleet"},
                                     {"kind": "page", "url": "https://northwind.example/fleet"}])
    context.create_entry(website, user, section="audience", title="Fleet managers",
                         body="Run 5 to 500\nvans.")
    context.create_entry(website, user, section="audience", body="Hate downtime.")
    AgentContextEntry.objects.create(website=website, section="audience", title="Suggested",
                                     status="suggested")
    assert context.offering_urls(website) == ["https://northwind.example/fleet"]
    assert context.section_text(website, "audience") == (
        "Fleet managers: Run 5 to 500 vans.\nHate downtime.")
    assert context.counts(website) == {"company": 0, "audience": 2, "competitors": 0,
                                       "offerings": 1, "strategy": 0, "execution": 0}


def test_the_project_context_line(user, website):
    assert brand_context_line(website) == "- Brand context: not set"
    context.create_entry(website, user, section="company", title="Founded in 2013")
    context.create_entry(website, user, section="execution", title="Voice")
    AgentContextEntry.objects.create(website=website, section="audience", title="Suggested",
                                     status="suggested")
    line = ("- Brand context: 2 entries (Company 1, Audience 0, Competitors 0, Offerings 0, "
            "Strategy 0, Execution 1); 1 suggestions wait for review")
    assert brand_context_line(website) == line
    from datetime import date

    text = project_context(website, entry_agent="page_optimizer", tracked_prompts=0,
                           today=date(2026, 11, 5))
    assert line in text.splitlines()
    assert "- Agent the user started with: Page optimizer (page_optimizer)" in text


def test_every_writer_ends_with_the_brand_rules():
    specs = _specs()
    assert list(specs) == ["landing_page", "aeo_article", "ad_campaign", "page_optimizer",
                           "llms_txt", "comparison_page", "social_posts", "pr_writer",
                           "messaging_brief"]
    for spec in specs.values():
        assert spec.system.rstrip().endswith(BRAND_RULES), spec.key
        assert "Do not use emojis." in spec.system, spec.key
        assert spec.version == "2026-11-05.1", spec.key


def test_get_brand_context_reports_counts_and_waiting_suggestions(user, website, settings):
    from types import SimpleNamespace

    from apps.agent.tools.data import get_brand_context

    settings.OPENAI_API_KEY = ""
    context.create_entry(website, user, section="company", title="Founded in 2013")
    AgentContextEntry.objects.create(website=website, section="company", title="Suggested",
                                     status="suggested")
    ctx = SimpleNamespace(website=website, user=user)
    result = json.loads(get_brand_context(ctx, SimpleNamespace(query=None)).content)
    assert result["context_counts"]["company"] == 1 and result["suggested"] == 1
    assert [e["title"] for e in result["context"]["company"]] == ["Founded in 2013"]
    assert "audience" not in result and "voice" not in result and "rules" not in result
