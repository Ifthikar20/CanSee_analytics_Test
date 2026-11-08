"""Hardening tests for onboarding grounding: a brand-profile value is kept
only when its evidence is a verbatim quote from the page of at least three
words (and EVIDENCE_MIN characters) that contains every content word of
the value; competitors come only from Google's results.

Each test pins a decision a hand mutation of the code showed was not
covered before."""
import json
from unittest.mock import patch

import pytest

from apps.onboarding.services import onboarding_service, serp_discovery
from apps.onboarding.services.onboarding_service import (
    EVIDENCE_MIN,
    EVIDENCE_MIN_WORDS,
    _grounded_value,
    _norm,
)


def _value(value, evidence, page, limit=300):
    return _grounded_value({"value": value, "evidence": evidence}, _norm(page), limit)


# ── Brand-profile grounding ───────────────────────────────────────────────


PAGE = ("TutorNote - AI lesson notes for tutors. Built for independent tutors and tutoring "
        "centres. No jargon, no fuss.")


def test_the_limits_are_three_words_and_eight_characters():
    assert (EVIDENCE_MIN_WORDS, EVIDENCE_MIN) == (3, 8)


def test_a_quote_that_is_not_on_the_page_grounds_nothing():
    # Every word of the value is in the quote, but the quote is invented.
    assert _value("Lesson notes for dentists", "AI lesson notes for dentists", PAGE) == ""
    assert _value("Lesson notes for tutors", "AI lesson notes for tutors", PAGE) == (
        "Lesson notes for tutors")


def test_a_fabricated_quote_is_dropped_from_the_scan():
    from apps.onboarding.tests.test_brand_profile import _THIN_SCAN, FakeClaude, _scan

    FakeClaude.responses = {"brand_profile": json.dumps({
        "industry": {"value": "Dental lesson notes", "evidence": "dental lesson notes for tutors"},
        "offerings": [],
        "audience": {"value": "Hospitals and clinics",
                     "evidence": "Built for hospitals and clinics"},
        "voice": {"value": "No jargon, no fuss", "evidence": "No jargon, no fuss."},
    })}
    FakeClaude.calls = []
    FakeClaude.configured = True
    with patch.object(onboarding_service, "ClaudeUtility", FakeClaude), \
         patch.object(onboarding_service, "_safe_discover_competitors", return_value=[]), \
         patch("apps.prompt_library.services.logo_crawler.fetch_site_logo", return_value=""):
        payload = _scan(_THIN_SCAN)
    assert (payload.industry, payload.audience) == ("", "")
    assert payload.voice == "No jargon, no fuss"


def test_a_quote_cut_mid_word_grounds_nothing():
    # "Kent" is not on the page; it is the start of "Kentucky".
    page = "We serve independent tutors in Kentucky and Ohio."
    assert _value("Kent tutors", "tutors in Kent", page) == ""
    assert _value("Tutors in Kent", "pendent tutors in Kent", page) == ""
    assert _value("Kentucky tutors", "tutors in Kentucky", page) == "Kentucky tutors"
    # Punctuation next to the quote still counts as a word boundary.
    assert _value("Ohio tutors", "tutors in Kentucky and Ohio", page) == "Ohio tutors"


def test_a_quote_cut_mid_word_is_dropped_from_the_scan():
    from apps.onboarding.tests.test_brand_profile import _THIN_SCAN, FakeClaude, _scan

    FakeClaude.responses = {"brand_profile": json.dumps({
        # The page says "independent tutors"; "pendent" is not a word on it.
        "industry": {"value": "Pendent tutors", "evidence": "pendent tutors and tutoring"},
        "offerings": [],
        "audience": {"value": "", "evidence": ""},
        "voice": {"value": "", "evidence": ""},
    })}
    FakeClaude.calls = []
    FakeClaude.configured = True
    with patch.object(onboarding_service, "ClaudeUtility", FakeClaude), \
         patch.object(onboarding_service, "_safe_discover_competitors", return_value=[]), \
         patch("apps.prompt_library.services.logo_crawler.fetch_site_logo", return_value=""):
        payload = _scan(_THIN_SCAN)
    assert payload.industry == ""


def test_three_words_under_eight_characters_are_too_short():
    page = "Rent a ski 4 less every winter."
    assert _value("Ski", "a ski 4", page) == ""
    assert _value("Ski", "rent a ski 4", page) == "Ski"


def test_quotes_wrapped_in_quote_marks_or_an_ellipsis_still_match():
    assert _value("Independent tutors", "\"Built for independent tutors…\"", PAGE) == (
        "Independent tutors")
    assert _value("Independent tutors", "'built for independent tutors.'", PAGE) == (
        "Independent tutors")


def test_small_words_of_the_value_need_not_be_in_the_quote():
    page = "Our lesson notes keep tutors organised."
    assert _value("Notes for the tutors", "lesson notes keep tutors", page) == (
        "Notes for the tutors")


def test_a_short_word_is_not_matched_by_a_fragment_of_another():
    # "bed" has no -ed ending to strip (its stem would be one letter), so
    # the single letter "b" in the quote does not ground it.
    page = "Plan B for linen buyers and hotels."
    assert _value("Bed linen", "plan b for linen buyers", page) == ""
    assert _value("Linen buyers", "plan b for linen buyers", page) == "Linen buyers"


def test_forms_with_a_stem_of_three_letters_still_match():
    # "bugs" -> "bug" and "fixes" -> "fix" leave exactly three letters.
    page = "We track bugs and fixes for teams."
    assert _value("Bug fix", "track bugs and fixes", page) == "Bug fix"


# ── Competitors from Google's results ─────────────────────────────────────


def _row(n, url, title, snippet="", candidate=True):
    host = url.split("/")[2].removeprefix("www.")
    return {"n": n, "query": "Turonote alternatives", "rank": n, "url": url, "host": host,
            "apex": serp_discovery.apex_of(host), "title": title, "snippet": snippet,
            "candidate": candidate}


def test_a_brand_search_needs_two_results_naming_the_brand():
    one = serp_discovery.QueryResult(query="Turonote alternatives", purpose="competitors",
                                     payload={"organic": [
                                         {"title": "Turonote review", "snippet": ""},
                                         {"title": "Evernote", "snippet": "Notes"}]})
    two = serp_discovery.QueryResult(query="Turonote alternatives", purpose="competitors",
                                     payload={"organic": [
                                         {"title": "Turonote review", "snippet": ""},
                                         {"title": "Evernote", "snippet": "Like Turonote"}]})
    assert serp_discovery.GUARD_MIN_ROWS == 2
    assert serp_discovery._brand_guard(one, "Turonote") is False
    assert serp_discovery._brand_guard(two, "Turonote") is True


def test_a_pick_on_the_brands_own_site_is_dropped():
    rows = [_row(1, "https://turonote.com/vs", "Turonote vs Notion", candidate=False),
            _row(2, "https://notion.com/", "Notion - workspace")]
    picks = serp_discovery._validated_picks(
        [{"name": "Turonote Teams", "domain": "turonote.com", "row": 1},
         {"name": "Notion", "domain": "notion.com", "row": 2}],
        rows, "Turonote", "turonote.com")
    assert [(p["name"], p["domain"]) for p in picks] == [("Notion", "notion.com")]


@pytest.mark.parametrize(("host", "candidate"), [
    ("notion.com", True), ("docs.obsidian.md", True), ("www.harvard.edu", False),
    ("data.cdc.gov", False), ("www.reddit.com", False), ("www.youtube.com", False),
    ("en.wikipedia.org", False), ("www.g2.com", False), ("turonote.com", False),
    ("app.turonote.com", False),
])
def test_only_company_and_docs_sites_are_competitor_candidates(host, candidate):
    apex = serp_discovery.apex_of(host)
    assert serp_discovery._is_candidate(host, apex, "turonote.com") is candidate


def test_a_one_letter_name_is_not_a_competitor():
    rows = [_row(1, "https://x.example.com/", "X - the notes app", "X is fast.")]
    picks = serp_discovery._validated_picks([{"name": "X", "domain": "", "row": 1}],
                                            rows, "Turonote", "turonote.com")
    assert picks == []
    ok = serp_discovery._validated_picks([{"name": "Xo", "domain": "", "row": 1}],
                                         [_row(1, "https://xo.example.com/", "Xo - notes")],
                                         "Turonote", "turonote.com")
    assert [p["name"] for p in ok] == ["Xo"]


def test_a_name_whose_site_name_is_ambiguous_gets_no_domain_and_is_listed_once():
    rows = [
        _row(1, "https://www.g2.com/x", "Turonote alternatives", "Notion and Evernote.",
             candidate=False),
        _row(2, "https://notion.com/", "Notion - workspace"),
        _row(3, "https://notion.so/", "Notion - docs"),
    ]
    picks = serp_discovery._validated_picks([
        # Cited in the g2 row: two result sites are called "notion", so
        # neither is guessed.
        {"name": "Notion", "domain": "", "row": 1},
        # The same company again, now with a domain: still one entry.
        {"name": "Notion", "domain": "notion.so", "row": 3},
        {"name": "Evernote", "domain": "", "row": 1},
    ], rows, "Turonote", "turonote.com")
    assert [(p["name"], p["domain"]) for p in picks] == [("Notion", ""), ("Evernote", "")]


def test_claude_picks_are_capped_at_eight():
    rows = [_row(n, f"https://brand{n}.example/", f"Brand{n} - app") for n in range(1, 13)]
    data = [{"name": f"Brand{n}", "domain": f"brand{n}.example", "row": n} for n in range(1, 13)]
    picks = serp_discovery._validated_picks(data, rows, "Turonote", "turonote.com")
    assert serp_discovery.COMPETITORS_MAX == 8
    assert [p["name"] for p in picks] == [f"Brand{n}" for n in range(1, 9)]
    assert all(p["source"] == "both" for p in picks)


def test_result_sites_are_capped_at_eight_and_ranked_by_how_often_then_position():
    rows = [_row(n, f"https://brand{n}.example/", f"Brand{n} - app") for n in range(1, 13)]
    again = {**_row(9, "https://brand12.example/", "Brand12 - app"),
             "query": "Turonote competitors"}
    picks = serp_discovery._fallback_pick([*rows, again], brand="Turonote")
    assert len(picks) == 8
    # Listed by both brand searches first, then by best position.
    assert [p["domain"] for p in picks] == ["brand12.example"] + [
        f"brand{n}.example" for n in range(1, 8)]
    assert all(p["source"] == "search" for p in picks)


def test_people_also_ask_drops_repeats_that_differ_only_in_case_and_spacing():
    query = serp_discovery.QueryResult(query="best note app", purpose="questions", payload={
        "questions": [{"question": "What is the best note app?"},
                      {"question": "what is  the BEST note app?"},
                      {"question": "Which note app works offline?"}]})
    results = serp_discovery.GoogleResults(configured=True, provider="serpapi",
                                           queries=[query], brand="Turonote")
    assert [q["text"] for q in results.questions()] == [
        "What is the best note app?", "Which note app works offline?"]


@pytest.fixture
def google_configured(settings):
    from django.core.cache import cache

    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    settings.SERP_PROVIDER = ""
    settings.SCRAPERAPI_COST_PER_SEARCH_USD = 0.0
    settings.ONBOARDING_SERP_DAILY_SEARCHES = 15
    cache.clear()
    yield
    cache.clear()


@pytest.mark.usefixtures("google_configured")
def test_a_three_letter_brand_is_searched():
    calls = []
    with patch("apps.citations.services.serp_google.search",
               lambda query, **kw: calls.append(query) or {"organic": [], "error": ""}):
        lookup = serp_discovery.GoogleLookup.start(business_name="Tur", seed="")
        lookup.collect()
    assert sorted(calls) == ["Tur alternatives", "Tur competitors"]


@pytest.mark.usefixtures("google_configured")
def test_no_search_runs_when_the_daily_limit_cannot_be_read():
    calls = []

    class Broken:
        def consume(self, key):
            raise RuntimeError("cache down")

    with patch("apps.citations.services.serp_google.search",
               lambda query, **kw: calls.append(query) or {"organic": []}), \
         patch.object(serp_discovery, "search_quota", return_value=Broken()):
        lookup = serp_discovery.GoogleLookup.start(business_name="Turonote", seed="note app")
        results = lookup.collect()
    assert calls == []
    assert results.searches == 0
    assert [q.error for q in results.queries] == ["limit_unavailable"] * 3
    assert results.error == "limit_unavailable"


def test_an_unconfigured_claude_is_never_asked_and_the_result_sites_are_used():
    asked = []

    class Unconfigured:
        def __init__(self, **kwargs):
            pass

        def is_configured(self):
            return False

        def query(self, *args, **kwargs):
            asked.append(kwargs.get("role"))
            raise AssertionError("an unconfigured Claude must not be asked")

    rows = [_row(1, "https://notion.com/", "Notion - workspace")]
    with patch("core.llm.ClaudeUtility", Unconfigured):
        picks = serp_discovery._claude_pick(rows, [], brand="Turonote", own_apex="turonote.com")
    assert picks == [] and asked == []
