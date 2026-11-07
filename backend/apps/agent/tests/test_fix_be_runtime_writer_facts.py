"""What writers are told and what they may link to.

Facts the orchestrator passes to run_agent are its own words: they reach
the writer as facts_from_chat (nobody approved them), and the
orchestrator may take brand claims only from tool results and the user.
An ad campaign's final_url and sitelinks must come from the data the
writer was given; any other URL is reported, never rewritten.
"""

import json

import pytest

from apps.agent.models import AgentArtifactVersion
from apps.agent.prompts import ad_campaign as ad_prompt
from apps.agent.prompts import orchestrator
from apps.agent.subagents.sheet_schema import validate_sheet
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import send

pytestmark = [pytest.mark.usefixtures("no_title")]

SITE = "https://northwind.example"


def _campaign(final_url: str, *sitelinks: str) -> dict:
    return {
        "campaign": {"name": "CRM search", "objective": "Leads", "platform": "google_search",
                     "daily_budget": None, "bid_strategy": None, "final_url": final_url},
        "ad_groups": [{
            "name": "Best CRM",
            "keywords": [{"text": "best crm", "match": "exact"}],
            "negatives": [],
            "ads": [{"headlines": ["CRM for small teams", "Try Northwind", "Book a demo"],
                     "descriptions": ["Track every deal.", "Built for small teams."],
                     "path1": None, "path2": None}],
        }],
        "sitelinks": [{"text": f"Link {i}", "url": url, "description1": None,
                       "description2": None} for i, url in enumerate(sitelinks)],
    }


@pytest.fixture
def allowance(settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0


def _run_agent(args):
    return message(text("Starting the writer."), tool_use("run_agent", args, id="toolu_w"),
                   stop_reason="tool_use")


def test_the_orchestrator_takes_brand_claims_only_from_tools_and_the_user():
    prompt = orchestrator.SYSTEM_PROMPT
    assert "never from your own knowledge or a guess" in prompt
    assert "the facts you pass to run_agent" in prompt
    assert "the facts to use (each from a tool result in this chat or the user's words)" in prompt


def test_url_warnings_flag_invented_off_site_and_non_http_links():
    raw = json.dumps(_campaign(f"{SITE}/pricing", f"{SITE}/demo", "https://evil.example/x",
                               "javascript:alert(1)", "https://www.northwind.example/"))
    content, warnings = validate_sheet(raw, site_url=SITE, known_urls={SITE, f"{SITE}/pricing/"})

    assert [(w["path"], w["message"]) for w in warnings] == [
        ("sitelinks[0].url", "This URL does not appear in the brand data or the brief; check "
                             "that the page exists before uploading."),
        ("sitelinks[1].url", "This URL is not on the brand's website."),
        ("sitelinks[2].url", "This is not an http(s) link to a page."),
    ]
    # Reported, never rewritten.
    assert [s["url"] for s in content["sitelinks"]][:2] == [f"{SITE}/demo",
                                                           "https://evil.example/x"]
    assert content["warnings"] == warnings


def test_url_checks_need_the_writers_data():
    _, warnings = validate_sheet(json.dumps(_campaign("https://anything.example/x")))
    assert warnings == []


@pytest.mark.django_db
@pytest.mark.usefixtures("allowance")
def test_the_ad_writer_links_only_to_urls_from_its_data(fake_anthropic, chat):
    brief = f"Search ads for small teams. The pricing page is {SITE}/pricing."
    fake_anthropic.queue(
        _run_agent({"agent": "ad_campaign", "title": "CRM ads", "brief": brief,
                    "facts": ["Free plan for 3 users", f"Demo booking at {SITE}/demo"]}),
        message(text(json.dumps(_campaign(f"{SITE}/pricing", f"{SITE}/demo",
                                          f"{SITE}/features")))),
        message(text("Done.")),
    )

    send(chat, "Build an ad campaign")

    writer = fake_anthropic.requests[1].json
    brand = writer["messages"][0]["content"][0]["text"]
    assert '"facts_from_chat"' in brand and "approved_facts" not in brand
    assert "Never construct a path" in writer["system"][0]["text"]
    # final_url comes from the brief and the demo sitelink from the facts;
    # the features page appears nowhere.
    stored = json.loads(AgentArtifactVersion.objects.get().content)
    assert [w["path"] for w in stored["warnings"]] == ["sitelinks[1].url"]
    assert stored["sitelinks"][1]["url"] == f"{SITE}/features"


def test_the_ad_prompt_forbids_invented_urls():
    assert "Never construct a path" in ad_prompt.SYSTEM_PROMPT
    assert "return fewer sitelinks, or none, rather than invent one" in ad_prompt.SYSTEM_PROMPT
