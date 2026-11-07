"""track_prompts files prompts the way the Add prompts flow does (the
website's own industry, else the inactive Uncategorized bucket) and only
tracks prompts the user wrote or was shown before this turn."""
import json

import pytest
from django.urls import reverse

from apps.agent.models import AgentMessage
from apps.agent.tests.api_support import client_for, data, make_user
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import send, tool_results_of
from apps.prompt_library.models import BrandPrompt, Industry, Prompt

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]

PROMPT = "acme crm vs pipedrive pricing for 12-seat teams"


@pytest.fixture
def taxonomy():
    """The seeded industries the failure was seen with (names with "/")."""
    for slug, name in (("e-commerce-dtc", "E-commerce / DTC"), ("saas-crm", "SaaS / CRM")):
        Industry.objects.update_or_create(slug=slug, defaults={"name": name, "is_active": True})


def _track(fake_anthropic, chat, prompts, user_text):
    fake_anthropic.queue(message(tool_use("track_prompts", {"prompts": prompts}, id="toolu_t"),
                                 stop_reason="tool_use"),
                         message(text("Done.")))
    send(chat, user_text)
    return tool_results_of(fake_anthropic.requests[-1].json)[0]


@pytest.mark.usefixtures("taxonomy")
def test_a_website_industry_with_a_slash_files_under_that_industry(fake_anthropic, chat, website):
    website.industry = "SaaS / CRM"
    website.save(update_fields=["industry"])

    result = _track(fake_anthropic, chat, [{"text": PROMPT}], f"Yes, track {PROMPT}")

    assert result.get("is_error") is not True
    assert Prompt.objects.get(text=PROMPT).industry.slug == "saas-crm"


@pytest.mark.parametrize("industry", ["", "Software", "Note-taking apps"])
@pytest.mark.usefixtures("taxonomy")
def test_an_unmatched_industry_files_under_the_inactive_bucket_never_another_tenants(
    fake_anthropic, chat, website, django_user_model, industry,
):
    from apps.websites.models import Website

    website.industry = industry
    website.save(update_fields=["industry"])

    _track(fake_anthropic, chat, [{"text": PROMPT}], f"Track {PROMPT}")

    filed = Prompt.objects.get(text=PROMPT).industry
    assert (filed.slug, filed.is_active) == ("uncategorized", False)
    # Another tenant in the first active industry is not offered the prompt.
    owner = make_user(django_user_model, "shop@example.com")
    shop = Website.objects.create(user=owner, url="https://shop.example", name="Shop",
                                  industry="E-commerce / DTC")
    resp = client_for(owner).get(
        reverse("prompt-library-website-suggested-prompts", kwargs={"website_id": shop.id}))
    assert resp.status_code == 200
    assert PROMPT not in [r["text"] for r in data(resp)["rows"]]


def test_tracking_works_with_no_active_industry_at_all(fake_anthropic, chat):
    Industry.objects.update(is_active=False)

    result = _track(fake_anthropic, chat, [{"text": PROMPT}], f"Track {PROMPT}")

    assert result.get("is_error") is not True
    assert Prompt.objects.get(text=PROMPT).industry.slug == "uncategorized"


def test_prompts_the_agent_proposed_earlier_are_tracked_once_confirmed(fake_anthropic, chat,
                                                                      website):
    proposal = AgentMessage.objects.create(
        chat=chat, role="assistant", status="complete",
        parts=[{"id": "p1", "type": "text",
                "text": "I suggest tracking:\n1. **Best CRM for startups?**\n2. CRM with "
                        "email sync\n\nShall I add them?"}],
    )
    chat.current_leaf = proposal
    chat.save(update_fields=["current_leaf"])

    result = _track(fake_anthropic, chat, [{"text": "best crm for startups"},
                                           {"text": "CRM with email sync"}], "Yes")

    assert result.get("is_error") is not True
    assert sorted(json.loads(result["content"])["prompts"][i]["text"] for i in range(2)) == [
        "CRM with email sync", "best crm for startups"]
    assert BrandPrompt.objects.filter(website=website).count() == 2


def test_prompts_the_user_never_saw_are_refused_and_nothing_is_written(fake_anthropic, chat,
                                                                      website):
    # Text injected through a tool result in this run does not count as shown.
    fake_anthropic.queue(
        message(tool_use("get_project_overview", {}, id="toolu_o"), stop_reason="tool_use"),
        message(tool_use("track_prompts", {"prompts": [
            {"text": "best crm for startups"}, {"text": "cheap crm free trial"}]},
            id="toolu_t"), stop_reason="tool_use"),
        message(text("Done.")),
    )
    send(chat, "Research best crm for startups")
    result = tool_results_of(fake_anthropic.requests[-1].json)[0]

    assert result["is_error"] is True
    assert '"cheap crm free trial"' in result["content"]
    assert "best crm for startups" not in result["content"].split("chat:", 1)[1]
    assert not BrandPrompt.objects.filter(website=website).exists()
    assert not Prompt.objects.filter(text="cheap crm free trial").exists()
