"""Writers get the output budget the allowance pays for, not all or nothing.

A landing page may use up to AGENT_LANDING_MAX_TOKENS (64000) output
tokens, $1.28 at $20 per MTok, more than the $1 an individual without a
plan gets a month. run_agent used to refuse it outright for every such
user; it now sends the request with what the remaining allowance covers
and refuses only below MIN_WRITER_TOKENS.
"""

import pytest

from apps.agent.models import AgentArtifact, AgentArtifactVersion
from apps.agent.subagents.base import MIN_WRITER_TOKENS, writer_budget
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events, send, tool_results_of

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]

PAGE = ("<!DOCTYPE html><html lang=\"en\"><head><title>CRM</title></head><body>"
        "<h1>CRM for dentists</h1><section><h2>FAQ</h2></section></body></html>")
ARTICLE = "# What is the best CRM for dentists?\n\nNorthwind keeps patient follow-ups in one place."


@pytest.fixture
def allowance(monkeypatch):
    """A $1 monthly cap with a settable month-to-date spend."""
    state = {"cap": 1.0, "spent": 0.0}
    monkeypatch.setattr("core.ai_tracking.effective_ai_cap", lambda user: state["cap"])
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda user: state["spent"])
    return state


def _run_agent(agent, *, id="toolu_writer"):
    args = {"agent": agent, "title": "Draft", "brief": "For dental practices."}
    return message(text("Starting the writer."), tool_use("run_agent", args, id=id),
                   stop_reason="tool_use")


def test_writer_budget_follows_the_allowance(allowance):
    assert writer_budget(None, 64000) == (50000, MIN_WRITER_TOKENS, 1.0, 0.0)
    allowance["spent"] = 0.5
    assert writer_budget(None, 32000) == (25000, MIN_WRITER_TOKENS, 1.0, 0.5)
    allowance["spent"] = 0.99
    assert writer_budget(None, 16000)[0] == 500
    # A smaller agent's minimum is its whole limit.
    assert writer_budget(None, 8000)[1] == 8000
    allowance["cap"] = 0.0
    assert writer_budget(None, 64000) == (64000, MIN_WRITER_TOKENS, 0.0, 0.0)


def test_a_new_free_user_gets_a_landing_page(fake_anthropic, chat, allowance):
    fake_anthropic.queue(_run_agent("landing_page"), message(text(PAGE)),
                         message(text("Saved the page.")))

    started = send(chat, "Draft a landing page for best CRM for dentists")

    writer = fake_anthropic.requests[1].json
    assert writer["max_tokens"] == 50000
    result = tool_results_of(fake_anthropic.requests[2].json)[0]
    assert not result.get("is_error")
    assert AgentArtifact.objects.get().kind == "page"
    assert AgentArtifactVersion.objects.count() == 1
    assert "artifact.completed" in [e["type"] for e in run_events(started.run)]


def test_an_article_still_runs_after_a_research_turn(fake_anthropic, chat, allowance):
    allowance["spent"] = 0.5
    fake_anthropic.queue(_run_agent("aeo_article"), message(text(ARTICLE)),
                         message(text("Saved the article.")))

    send(chat, "Write an article")

    assert fake_anthropic.requests[1].json["max_tokens"] == 25000
    assert AgentArtifact.objects.get().kind == "document"


def test_an_allowance_below_the_minimum_refuses_and_says_why(fake_anthropic, chat, allowance):
    allowance["spent"] = 0.8
    fake_anthropic.queue(_run_agent("landing_page"), message(text("I could not run it.")))

    send(chat, "Draft a landing page")

    assert len(fake_anthropic.requests) == 2
    result = tool_results_of(fake_anthropic.requests[1].json)[0]
    assert result["is_error"] is True
    assert result["content"] == (
        "Insufficient allowance: the landing page agent needs at least $0.32 and $0.20 of the "
        "$1.00 monthly AI allowance is left.")
    assert not AgentArtifact.objects.exists()


def test_a_page_cut_off_by_a_smaller_budget_says_so(fake_anthropic, chat, allowance):
    fake_anthropic.queue(
        _run_agent("landing_page"),
        message(text("<!DOCTYPE html><html><body><h1>Half"), stop_reason="max_tokens"),
        message(text("The page was cut off.")),
    )

    started = send(chat, "Draft a landing page")

    failed = next(e for e in run_events(started.run) if e["type"] == "artifact.failed")
    assert failed["error"]["message"] == (
        "The page was cut off before it was finished. The remaining AI allowance covered "
        "50,000 of the 64,000 output tokens this agent can use.")


def test_an_unlimited_allowance_keeps_the_agents_own_limit(fake_anthropic, chat, allowance):
    allowance["cap"] = 0.0
    fake_anthropic.queue(_run_agent("landing_page"), message(text(PAGE)),
                         message(text("Saved.")))

    send(chat, "Draft a landing page")

    assert fake_anthropic.requests[1].json["max_tokens"] == 64000
