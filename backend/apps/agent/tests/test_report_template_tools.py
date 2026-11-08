"""The read tools the Brand accuracy and Change log templates need:
get_brand_perception and get_visibility_history, and the answer-to-answer
comparison behind the second."""
from __future__ import annotations

import json
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, send, tool_results_of

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]


def _tool(fake_anthropic, chat, name, args=None):
    fake_anthropic.queue(message(tool_use(name, args or {}, id="toolu_t"), stop_reason="tool_use"),
                         message(text("Done.")))
    started = send(chat, "Go")
    result = tool_results_of(fake_anthropic.requests[-1].json)[0]
    assert result.get("is_error") is not True, result
    return json.loads(result["content"]), started


def test_new_chats_offer_both_tools():
    from apps.agent.tools.registry import client_tool_definitions, label_for

    names = [t["name"] for t in client_tool_definitions()]
    assert {"get_brand_perception", "get_visibility_history"} <= set(names)
    assert label_for("get_brand_perception") == "How AI describes the brand"
    assert label_for("get_visibility_history") == "Visibility history"


def test_the_tools_take_no_input(fake_anthropic, chat):
    fake_anthropic.queue(
        message(tool_use("get_visibility_history", {"period": "7d"}, id="toolu_x"),
                stop_reason="tool_use"),
        message(text("Done.")))
    send(chat, "Go")
    result = tool_results_of(fake_anthropic.requests[-1].json)[0]
    assert result["is_error"] is True


# ── get_brand_perception ──────────────────────────────────────────────────


def test_perception_says_plainly_when_the_analysis_is_off(fake_anthropic, chat, settings):
    settings.INSIGHTS_ENABLED = False
    result, _ = _tool(fake_anthropic, chat, "get_brand_perception")
    assert result == {
        "available": False,
        "note": "How the engines describe the brand is not available: the Sentiment and Fact "
                "check analysis is not turned on for this workspace.",
    }


def test_perception_marks_engine_text_untrusted_and_keeps_the_claim_key(
        fake_anthropic, chat, settings, monkeypatch):
    settings.INSIGHTS_ENABLED = True
    monkeypatch.setattr("apps.agent.services.measured.perception", lambda website: {
        "period": "last 90 days", "named_answers": 12, "analyzed_answers": 10,
        "themes": [{"label": "Pricing", "tone": "negative", "answers": 4,
                    "engines": ["chatgpt"], "quote": "It is expensive."}],
        "contradicted": [{"claim": "No free plan", "answers": 2, "engines": ["claude"],
                          "evidence": {"url": "https://northwind.example/pricing"},
                          "note": "", "claim_key": "no free plan|contradicted"}],
    })
    result, _ = _tool(fake_anthropic, chat, "get_brand_perception")
    assert result["available"] is True
    assert (result["named_answers"], result["analyzed_answers"]) == (12, 10)
    assert result["themes"][0]["quote"] == {"untrusted": True, "source": "AI engine answer",
                                            "text": "It is expensive."}
    claim = result["contradicted"][0]
    assert claim["claim"]["untrusted"] is True and claim["claim"]["text"] == "No free plan"
    assert claim["claim_key"] == "no free plan|contradicted"
    assert "note" not in result


def test_perception_with_nothing_analyzed_says_so(fake_anthropic, chat, settings, monkeypatch):
    settings.INSIGHTS_ENABLED = True
    monkeypatch.setattr("apps.agent.services.measured.perception", lambda website: {
        "period": "last 90 days", "themes": [], "contradicted": []})
    result, _ = _tool(fake_anthropic, chat, "get_brand_perception")
    assert result["themes"] == [] and result["named_answers"] is None
    assert "nothing to report yet" in result["note"]


def test_measured_perception_passes_the_claim_key(website, settings, monkeypatch):
    from apps.agent.services import measured

    settings.INSIGHTS_ENABLED = True
    monkeypatch.setattr("apps.insights.services.sentiment.build",
                        lambda *a, **k: {"coverage": {}, "themes": []})
    monkeypatch.setattr("apps.insights.services.fact_check.build", lambda *a, **k: {"claims": [
        {"key": "k1|contradicted", "text": "Claim", "verdict": "contradicted", "answers": 1,
         "engines": [], "evidence": None, "note": ""}]})
    assert measured.perception(website)["contradicted"][0]["claim_key"] == "k1|contradicted"


# ── get_visibility_history ────────────────────────────────────────────────


def _answer(website, bp, provider, *, days_ago, mentioned, rank=None, audit=None):
    from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult

    audit = audit or LLMRankingAudit.objects.create(website=website, created_by=website.user)
    result = LLMRankingResult.objects.create(
        audit=audit, provider=provider, prompt=bp.prompt.text, response_text="answer",
        is_mentioned=mentioned, mention_rank=rank, source_prompt=bp.prompt,
    )
    LLMRankingResult.objects.filter(id=result.id).update(
        created_at=timezone.now() - timedelta(days=days_ago))
    return result


def test_answer_changes_compare_each_prompt_and_engine_with_its_previous_check(website):
    from apps.llm_ranking.services.answer_changes import answer_changes

    crm = make_prompt(website, "best crm")
    tools = make_prompt(website, "crm tools for startups")
    _answer(website, crm, "claude", days_ago=10, mentioned=False)
    _answer(website, crm, "claude", days_ago=2, mentioned=True, rank=2)       # named now
    _answer(website, crm, "gpt4", days_ago=9, mentioned=True, rank=1)
    _answer(website, crm, "gpt4", days_ago=1, mentioned=True, rank=4)          # rank down
    _answer(website, tools, "claude", days_ago=8, mentioned=True, rank=5)
    _answer(website, tools, "claude", days_ago=3, mentioned=True, rank=2)      # rank up
    _answer(website, tools, "gpt4", days_ago=4, mentioned=True)
    _answer(website, tools, "gpt4", days_ago=3, mentioned=False)               # dropped
    _answer(website, tools, "gemini", days_ago=5, mentioned=False)             # first check
    _answer(website, crm, "gemini", days_ago=6, mentioned=False)
    _answer(website, crm, "gemini", days_ago=5, mentioned=False)               # unchanged
    _answer(website, crm, "perplexity", days_ago=200, mentioned=True)          # out of window

    found = answer_changes(website)
    assert [(r["prompt"], r["engine"], r["change"]) for r in found["rows"]] == [
        ("best crm", "claude", "named_now"),
        ("crm tools for startups", "claude", "rank_up"),
        ("crm tools for startups", "chatgpt", "dropped"),
        ("best crm", "chatgpt", "rank_down"),
        ("crm tools for startups", "gemini", "first_check"),
        ("best crm", "gemini", "unchanged"),
    ]
    assert found["counts"] == {"named_now": 1, "rank_up": 1, "dropped": 1, "rank_down": 1,
                               "first_check": 1, "unchanged": 1}
    first = found["rows"][0]
    assert first["latest"]["named"] is True and first["latest"]["rank"] == 2
    assert first["previous"] == {"answered_at": first["previous"]["answered_at"],
                                 "named": False, "rank": None}
    assert found["rows"][4]["previous"] is None
    assert found["latest_check_at"] > found["previous_check_at"]


def test_failed_answers_are_never_a_change(website):
    from apps.llm_ranking.models import LLMRankingResult
    from apps.llm_ranking.services.answer_changes import answer_changes

    crm = make_prompt(website, "best crm")
    _answer(website, crm, "claude", days_ago=5, mentioned=True, rank=1)
    failed = _answer(website, crm, "claude", days_ago=1, mentioned=False)
    LLMRankingResult.objects.filter(id=failed.id).update(query_succeeded=False)
    assert [r["change"] for r in answer_changes(website)["rows"]] == ["first_check"]


def test_visibility_history_tool_records_what_it_compared(fake_anthropic, chat, website):
    crm = make_prompt(website, "best crm")
    _answer(website, crm, "claude", days_ago=10, mentioned=False)
    _answer(website, crm, "claude", days_ago=2, mentioned=True, rank=2)

    result, started = _tool(fake_anthropic, chat, "get_visibility_history")
    assert result["window_days"] == 90
    assert len(result["weekly"]["weeks"]) == len(result["weekly"]["visibility_pct"])
    assert sum(result["weekly"]["answers"]) == 2
    # A week without answers is null, never 0.
    assert None in result["weekly"]["visibility_pct"]
    assert [c["change"] for c in result["changes"]] == ["named_now"]
    assert result["changes_total"] == 1 and "note" not in result

    started.assistant_message.refresh_from_db()
    recorded = started.assistant_message.research["history"]["visibility"]
    assert recorded["window_days"] == 90
    assert recorded["latest_check_at"] == result["latest_check_at"]
    assert recorded["previous_check_at"] == result["previous_check_at"]


def test_visibility_history_with_no_answers_says_so(fake_anthropic, chat):
    result, _ = _tool(fake_anthropic, chat, "get_visibility_history")
    assert result["changes"] == [] and result["latest_check_at"] is None
    assert "nothing can be compared" in result["note"]
