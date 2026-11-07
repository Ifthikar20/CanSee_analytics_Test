"""The country matrix: the latest answer per (prompt, country, engine),
per-country summaries, gaps (a Google miss is a range, so only a gap both
ends agree on is definite), filters and the 120-day window."""
import pytest
from django.urls import reverse

from apps.search_gap.services.country_matrix import build_matrix
from apps.search_gap.tests.country_support import *  # noqa: F403
from apps.search_gap.tests.country_support import data, make_cell, make_prompt, make_run
from core.exceptions import ResourceNotFound

pytestmark = pytest.mark.django_db

FAILED = {"error_code": "rate_limited", "error_message": "The engine was busy or rate limited."}


@pytest.fixture
def prompts(website):
    return [make_prompt(website, "best crm for startups"), make_prompt(website, "crm for teams")]


@pytest.fixture
def configured(scraperapi, engines):
    engines.enable("chatgpt", "claude")
    return engines


@pytest.fixture
def checked(website, user, prompts, configured):
    """GB: found / missed on Google; DE: two misses, one with AI 100 and one
    with AI 40; FR: an engine answer without Google."""
    p1, p2 = prompts
    run = make_run(website, user, countries=["gb", "de", "fr"], engines=["chatgpt", "claude"],
                   prompts=prompts)
    make_cell(run, p1, "gb", "google", position=4, depth=10, pages_fetched=1, age_days=1)
    make_cell(run, p2, "gb", "google", position=None, depth=10, pages_fetched=1, age_days=1)
    make_cell(run, p1, "gb", "chatgpt", mentioned=True, rank=2, sentiment="positive", age_days=1)
    make_cell(run, p2, "gb", "chatgpt", mentioned=False, age_days=1)
    make_cell(run, p1, "gb", "claude", status="failed", age_days=1, **FAILED)

    make_cell(run, p1, "de", "google", position=None, depth=10, pages_fetched=1, age_days=2)
    make_cell(run, p2, "de", "google", position=None, depth=10, pages_fetched=1, age_days=2)
    make_cell(run, p1, "de", "chatgpt", mentioned=True, rank=1, age_days=2)
    make_cell(run, p2, "de", "chatgpt", mentioned=True, rank=4, age_days=2)
    make_cell(run, p2, "de", "claude", mentioned=False, age_days=2)

    make_cell(run, p1, "fr", "chatgpt", mentioned=True, rank=None, age_days=3)
    return run


def _country(matrix, code):
    return next(c for c in matrix["countries"] if c["country"] == code)


def _gap(matrix, bp, country):
    return next(g for g in matrix["gaps"] if g["prompt_id"] == str(bp.prompt_id) and g["country"] == country)


def test_summaries(website, prompts, checked):
    matrix = build_matrix(website)

    assert [c["country"] for c in matrix["countries"]] == ["fr", "de", "gb"]  # by name
    gb = _country(matrix, "gb")
    assert gb["name"] == "United Kingdom"
    assert gb["google"] == {
        "state": "ok", "checked": 2, "found": 1, "not_found": 1, "failed": 0,
        "avg_position": 4.0, "best_position": 4, "depth": 10,
        "method": "google_setting", "method_label": "Google set to GB, US connection",
    }
    assert gb["engines"]["chatgpt"] == {
        "state": "ok", "answered": 2, "mentioned": 1, "visibility_pct": 50.0, "avg_rank": 2.0,
        "method": "asked", "method_label": "Asked to answer for GB",
    }
    assert gb["engines"]["claude"] == {"state": "failed", "answered": 0, "mentioned": 0,
                                       "visibility_pct": None, "avg_rank": None, "method": None,
                                       "method_label": None}
    # Not configured on this server, and never checked: not_configured.
    assert gb["engines"]["gemini"] == {"state": "not_configured"}
    assert list(gb["engines"]) == ["chatgpt", "claude", "gemini", "grok", "perplexity"]
    assert gb["ai_visibility_pct"] == 50.0
    assert gb["last_checked_at"].endswith("Z")

    fr = _country(matrix, "fr")
    assert fr["google"]["state"] == "not_checked" and fr["google"]["avg_position"] is None
    assert fr["engines"]["claude"] == {"state": "not_checked"}
    assert fr["engines"]["chatgpt"]["avg_rank"] is None  # named without a position

    assert matrix["google"] == {"configured": True, "provider": "scraperapi"}
    assert matrix["engines"][0] == {"key": "chatgpt", "label": "ChatGPT", "configured": True}
    assert [p["prompt_id"] for p in matrix["prompts"]] == [str(bp.prompt_id) for bp in prompts]
    assert matrix["last_checked_at"] == gb["last_checked_at"]
    assert matrix["active_run"] is None


def test_gaps(website, prompts, checked):
    p1, p2 = prompts
    matrix = build_matrix(website)

    # Found at #4 (80) against a mean AI score of 100 (the failed engine is left out).
    assert _gap(matrix, p1, "gb") == {
        "prompt_id": str(p1.prompt_id), "country": "gb", "class": "strong_both", "value": 20,
        "definite": True, "ai_score": 100, "search_score": 80, "search_score_max": None,
    }
    # Not in the top 10: Google scores 0..55. AI 0 is Google ahead at 55 but
    # invisible in both at 0, so nothing definite.
    assert _gap(matrix, p2, "gb") == {
        "prompt_id": str(p2.prompt_id), "country": "gb", "class": "no_data", "value": None,
        "definite": False, "ai_score": 0, "search_score": None, "search_score_max": 55,
    }
    # AI 100 is ahead of anything up to 55: definite.
    assert _gap(matrix, p1, "de") == {
        "prompt_id": str(p1.prompt_id), "country": "de", "class": "ai_ahead", "value": None,
        "definite": True, "ai_score": 100, "search_score": None, "search_score_max": 55,
    }
    # AI 40 (80 and 0): even against 55, AI ahead against 0.
    de2 = _gap(matrix, p2, "de")
    assert (de2["class"], de2["definite"], de2["ai_score"]) == ("no_data", False, 40)
    # No Google cell.
    fr = _gap(matrix, p1, "fr")
    assert (fr["class"], fr["definite"], fr["ai_score"]) == ("no_data", False, 55)
    assert fr["search_score"] is None and fr["search_score_max"] is None
    assert not any(g["country"] == "fr" and g["prompt_id"] == str(p2.prompt_id) for g in matrix["gaps"])

    assert _country(matrix, "de")["gap_counts"] == {
        "ai_ahead": 1, "google_ahead": 0, "strong_both": 0, "invisible_both": 0, "even": 0, "no_data": 1,
    }


def test_a_measured_answer_beats_a_newer_failure(website, user, prompts, configured):
    p1 = prompts[0]
    older, newer = make_run(website, user, prompts=prompts), make_run(website, user, prompts=prompts)
    make_cell(older, p1, "gb", "chatgpt", mentioned=True, rank=3, age_days=5)
    make_cell(newer, p1, "gb", "chatgpt", status="failed", age_days=1, **FAILED)
    make_cell(older, p1, "gb", "claude", mentioned=False, age_days=5)
    make_cell(newer, p1, "gb", "claude", mentioned=True, rank=1, age_days=1)
    make_cell(newer, p1, "gb", "google", status="failed", age_days=1,
              error_code="serp_failed", error_message="Google search failed.")

    matrix = build_matrix(website)

    cells = {c["engine"]: c for c in matrix["cells"]}
    assert (cells["chatgpt"]["run_id"], cells["chatgpt"]["rank"]) == (str(older.id), 3)
    assert (cells["claude"]["run_id"], cells["claude"]["rank"]) == (str(newer.id), 1)
    assert cells["google"]["state"] == "failed"
    assert cells["google"]["error"] == {"code": "serp_failed", "message": "Google search failed."}
    assert _country(matrix, "gb")["google"]["state"] == "failed"
    assert [c["engine"] for c in matrix["cells"]] == ["google", "chatgpt", "claude"]


def test_not_checked_versus_not_configured(website, user, prompts, configured):
    configured.enable("perplexity")
    run = make_run(website, user, prompts=prompts)
    make_cell(run, prompts[0], "gb", "chatgpt", mentioned=False)
    make_cell(run, prompts[0], "gb", "grok", status="skipped", error_code="not_configured",
              error_message="The engine is not configured.")

    engines = _country(build_matrix(website), "gb")["engines"]

    assert engines["perplexity"] == {"state": "not_checked"}
    assert engines["gemini"] == {"state": "not_configured"}
    assert engines["grok"] == {"state": "not_configured"}


def test_filters(website, prompts, checked):
    p1, p2 = prompts

    by_prompt = build_matrix(website, prompt_id=str(p1.prompt_id))
    assert [p["prompt_id"] for p in by_prompt["prompts"]] == [str(p1.prompt_id)]
    assert {c["prompt_id"] for c in by_prompt["cells"]} == {str(p1.prompt_id)}
    assert {g["prompt_id"] for g in by_prompt["gaps"]} == {str(p1.prompt_id)}

    google = build_matrix(website, engine="google")
    assert {c["engine"] for c in google["cells"]} == {"google"}
    assert _country(google, "gb")["engines"] == {}
    assert _country(google, "gb")["ai_visibility_pct"] is None
    assert _country(google, "gb")["google"]["found"] == 1

    chatgpt = build_matrix(website, engine="chatgpt")
    assert {c["engine"] for c in chatgpt["cells"]} == {"chatgpt"}
    assert list(_country(chatgpt, "de")["engines"]) == ["chatgpt"]
    # The gap is ChatGPT's alone: rank 4 scores 80 (Claude's 0 is left out).
    assert _gap(chatgpt, p2, "de")["ai_score"] == 80

    claude = build_matrix(website, engine="claude")
    # Claude's answer failed here, so there is nothing to compare with Google.
    gap = _gap(claude, p1, "gb")
    assert (gap["class"], gap["ai_score"], gap["search_score"]) == ("no_data", None, 80)

    with pytest.raises(ResourceNotFound):
        build_matrix(website, prompt_id="0b8e8c5e-1d7a-4c8e-9a1c-2f0d5f8a9b10")


def test_the_window_is_120_days(website, user, prompts, configured):
    run = make_run(website, user, prompts=prompts)
    make_cell(run, prompts[0], "gb", "chatgpt", mentioned=True, rank=1, age_days=121)
    make_cell(run, prompts[0], "de", "chatgpt", mentioned=True, rank=1, age_days=119)

    matrix = build_matrix(website)

    assert [c["country"] for c in matrix["countries"]] == ["de"]
    assert len(matrix["cells"]) == 1


def test_archived_prompts_and_unfinished_cells_are_left_out(website, user, prompts, configured):
    archived = make_prompt(website, "an archived prompt", archived=True)
    run = make_run(website, user, status="running", prompts=prompts)
    make_cell(run, archived, "gb", "chatgpt", mentioned=True, rank=1)
    make_cell(run, prompts[0], "gb", "chatgpt", status="queued")
    make_cell(run, prompts[1], "gb", "chatgpt", status="cancelled", error_code="cancelled",
              error_message="Stopped before it ran.")

    matrix = build_matrix(website)

    assert matrix["countries"] == [] and matrix["cells"] == [] and matrix["gaps"] == []
    assert matrix["last_checked_at"] is None
    assert matrix["active_run"]["id"] == str(run.id)


def test_matrix_endpoint(api, website, prompts, checked):
    base = reverse("search-gap-countries", kwargs={"website_id": website.id})

    matrix = data(api.get(base))
    assert len(matrix["countries"]) == 3 and len(matrix["cells"]) == 11

    filtered = data(api.get(base, {"prompt_id": str(prompts[1].prompt_id), "engine": "Claude"}))
    assert [(c["prompt_id"], c["engine"]) for c in filtered["cells"]] == [
        (str(prompts[1].prompt_id), "claude")]

    resp = api.get(base, {"engine": "bing"})
    assert resp.status_code == 400
    assert resp.json()["error"]["details"]["field"] == "engine"
    assert api.get(base, {"prompt_id": "nope"}).status_code == 400
    resp = api.get(base, {"prompt_id": "0b8e8c5e-1d7a-4c8e-9a1c-2f0d5f8a9b10"})
    assert resp.status_code == 404 and resp.json()["error"]["code"] == "not_found"
