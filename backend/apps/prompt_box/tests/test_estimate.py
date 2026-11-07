"""Ask AI estimate: validation words, bounds, blockers, tracked detection (contract 4)."""
import pytest

from apps.prompt_box.models import PromptBoxRun
from apps.prompt_box.services import runs
from apps.prompt_box.tests.support import *  # noqa: F403
from apps.prompt_box.tests.support import QUESTION, body, make_prompt
from core.exceptions import CanseeException

pytestmark = pytest.mark.django_db

TEXT = "Ask one question, up to 300 characters."
ENGINES = "Choose at least one configured engine."


def _invalid(website, user, data) -> CanseeException:
    with pytest.raises(CanseeException) as exc:
        runs.estimate(website, user, data)
    assert (exc.value.code, exc.value.status_code) == ("invalid", 400)
    return exc.value


@pytest.mark.parametrize("text", ["ab", "   a \n  ", "x" * 301, None, 42, ["best crm"]])
def test_the_question_must_be_3_to_300_characters(website, user, engines, text):
    engines.enable("chatgpt")
    exc = _invalid(website, user, {"text": text, "samples": 3})
    assert exc.details == {"field": "text", "message": TEXT}
    assert exc.message == TEXT


def test_whitespace_collapses_to_one_line(website, user, engines):
    engines.enable("chatgpt")
    make_prompt(website, QUESTION)
    est = runs.estimate(website, user, body("  best crm for a\nsmall   plumbing business "))
    assert est["tracked"]["prompt_id"] is not None
    # 300 characters after collapsing is still one question.
    runs.estimate(website, user, body("word " * 60 + "  "))


@pytest.mark.parametrize("samples", [0, 11, -1, "3", True, 2.5])
def test_samples_are_1_to_the_setting(website, user, engines, samples):
    engines.enable("chatgpt")
    exc = _invalid(website, user, body(samples=samples))
    assert exc.details == {"field": "samples", "message": "Choose 1 to 10 answers per engine."}


def test_the_samples_limit_follows_the_setting(website, user, engines, settings):
    engines.enable("chatgpt")
    settings.PROMPT_BOX_MAX_SAMPLES = 5
    exc = _invalid(website, user, body(samples=6))
    assert exc.message == "Choose 1 to 5 answers per engine."


@pytest.mark.parametrize("chosen", [[], ["bard"], ["gemini"], "chatgpt", [None]])
def test_engines_must_be_configured(website, user, engines, chosen):
    engines.enable("chatgpt", "claude")
    exc = _invalid(website, user, body(engines=chosen))
    assert exc.details == {"field": "engines", "message": ENGINES}


def test_the_estimate_payload(website, user, engines):
    engines.enable("chatgpt", "claude")
    assert runs.estimate(website, user, body()) == {
        "answers": 6,
        "usd_max": "0.1800",
        "engines": [{"key": "chatgpt", "label": "ChatGPT"}, {"key": "claude", "label": "Claude"}],
        "allowance": {"unlimited": False, "left_usd": "1.00"},
        "daily": {"limit": 100, "left": 100},
        "tracked": {"prompt_id": None, "brand_prompt_id": None},
        "blockers": [],
        "can_run": True,
        "confirm": {"answers": 6, "ai_usd_max": "0.1800"},
    }


def test_the_bound_per_answer_follows_web_search(website, user, engines, settings, monkeypatch):
    engines.enable("chatgpt", "claude", "perplexity", "grok")
    monkeypatch.setattr("core.ai_tracking.effective_ai_cap", lambda u: 50.0)
    settings.LLM_WEBSEARCH_ENABLED = True
    est = runs.estimate(website, user, body(engines=["chatgpt", "claude"]))
    assert (est["answers"], est["usd_max"]) == (6, "0.4800")
    # Perplexity $0.03, Grok $0.07: both per answer, 3 answers each.
    est = runs.estimate(website, user, body(engines=["perplexity", "grok"]))
    assert (est["answers"], est["usd_max"]) == (6, "0.3000")
    assert [e["key"] for e in est["engines"]] == ["grok", "perplexity"]


def test_an_engine_subset(website, user, engines):
    engines.enable("chatgpt", "claude")
    est = runs.estimate(website, user, body(samples=10, engines=["claude"]))
    assert (est["answers"], est["confirm"]) == (10, {"answers": 10, "ai_usd_max": "0.3000"})


def test_no_engine_configured(website, user):
    est = runs.estimate(website, user, body(engines=["chatgpt"]))
    assert est["blockers"] == [
        {"code": "not_configured", "message": "AI engines aren't available yet."}]
    assert (est["answers"], est["can_run"], est["engines"]) == (0, False, [])


def test_allowance_blockers(website, user, engines, monkeypatch):
    engines.enable("chatgpt", "claude")
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda u: 0.9)
    est = runs.estimate(website, user, body())
    assert est["blockers"] == [{
        "code": "insufficient_allowance",
        "message": "This run needs up to $0.18 of AI allowance and $0.10 is left this month.",
    }]
    assert est["allowance"] == {"unlimited": False, "left_usd": "0.10"}
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda u: 1.0)
    est = runs.estimate(website, user, body())
    assert est["blockers"] == [
        {"code": "allowance_exceeded", "message": "You have used your monthly AI allowance."}]
    assert est["can_run"] is False


def test_an_unlimited_allowance(website, user, engines, monkeypatch):
    engines.enable("chatgpt")
    monkeypatch.setattr("core.ai_tracking.effective_ai_cap", lambda u: 0.0)
    est = runs.estimate(website, user, body())
    assert est["allowance"] == {"unlimited": True, "left_usd": None}
    assert est["can_run"] is True


def test_both_daily_limit_wordings(website, user, engines, settings):
    engines.enable("chatgpt", "claude")
    settings.PROMPT_BOX_DAILY_ANSWERS = 4
    est = runs.estimate(website, user, body())
    assert est["daily"] == {"limit": 4, "left": 4}
    assert est["blockers"] == [{
        "code": "daily_limit",
        "message": "This project has 4 Ask AI answers left today; this question needs 6.",
    }]
    runs.daily_quota().consume(str(website.id), 3)
    assert runs.estimate(website, user, body())["blockers"][0]["message"] == (
        "This project has 1 Ask AI answer left today; this question needs 6.")
    runs.daily_quota().consume(str(website.id), 1)
    assert runs.estimate(website, user, body())["blockers"] == [{
        "code": "daily_limit",
        "message": "This project used its 4 Ask AI answers for today. Try again tomorrow.",
    }]
    # Exactly what is left passes.
    settings.PROMPT_BOX_DAILY_ANSWERS = 10
    assert runs.estimate(website, user, body(samples=3))["can_run"] is True


def test_a_question_in_progress_blocks(website, user, engines):
    engines.enable("chatgpt")
    PromptBoxRun.objects.create(website=website, text="earlier question", samples=1,
                                engines=["chatgpt"], status=PromptBoxRun.STATUS_RUNNING)
    est = runs.estimate(website, user, body())
    assert est["blockers"] == [{
        "code": "run_in_progress",
        "message": "A question is already being asked for this project.",
    }]


def test_tracked_detection(website, user, engines):
    engines.enable("chatgpt")
    bp = make_prompt(website, QUESTION)
    est = runs.estimate(website, user, body("Best CRM for a small plumbing business?"))
    assert est["tracked"] == {"prompt_id": str(bp.prompt_id), "brand_prompt_id": str(bp.id)}
    bp.is_archived = True
    bp.save(update_fields=["is_archived"])
    assert runs.estimate(website, user, body())["tracked"] == {
        "prompt_id": None, "brand_prompt_id": None}


def test_the_estimate_has_no_side_effects(website, user, engines):
    engines.enable("chatgpt", "claude")
    runs.estimate(website, user, body(samples=10))
    assert PromptBoxRun.objects.count() == 0
    assert runs.daily_quota().remaining(str(website.id)) == 100
    assert engines.calls == []
