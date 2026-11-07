"""Google's questions and related searches on rank checks (backend 2b):
find_rank keeps page one's, google_rank.check stores them, a failed check
stores none, and the agent's research records them from its first page."""

import pytest

from apps.agent.tools import research
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import track
from apps.search_gap.models import GoogleRankCheck
from apps.search_gap.services import google_rank

pytestmark = pytest.mark.django_db

QUESTIONS = [{"question": "Is Fixture Notes free?", "snippet": "s",
              "url": "https://faq.example/free", "domain": "faq.example"},
             {"question": "", "url": "x"}]
RELATED = ["fixture notes pricing", "notes app for teams"]


def page(start, domains, **extra):
    return {
        "error": "",
        "organic": [{"position": start + i + 1, "url": f"https://{d}/p", "domain": d, "title": d}
                    for i, d in enumerate(domains)],
        "questions": QUESTIONS if start == 0 else [{"question": "Later page?", "url": ""}],
        "related_searches": RELATED if start == 0 else ["later"],
        **extra,
    }


def test_find_rank_keeps_page_one_features_even_when_the_site_is_found_first():
    def search(query, *, max_results, start, gl, hl):
        return page(start, ["notes-fixture.example"])

    out = google_rank.find_rank("q", "notes-fixture.example", max_depth=100, search=search)
    assert out["position"] == 1
    assert out["questions"] == QUESTIONS and out["related_searches"] == RELATED


def test_find_rank_reads_features_from_page_one_only(settings):
    settings.SERPAPI_KEY = "k"

    def search(query, *, max_results, start, gl, hl):
        return page(start, [f"x{start}-{i}.example" for i in range(10)])

    out = google_rank.find_rank("q", "notes-fixture.example", max_depth=20, search=search)
    assert out["pages_fetched"] == 2 and out["related_searches"] == RELATED


def test_serp_features_shape():
    assert google_rank.serp_features({"questions": QUESTIONS, "related_searches": RELATED,
                                      "error": ""}) == {
        "questions": [{"question": "Is Fixture Notes free?", "url": "https://faq.example/free"}],
        "related_searches": RELATED,
    }
    assert google_rank.serp_features({"error": "network"}) == {}


def test_check_stores_the_features_and_a_failed_check_stores_none(website, settings, monkeypatch):
    settings.SERPAPI_KEY = "k"
    bp = track(website, "best notes app for teams")
    found = {"position": 2, "url": "https://www.notes-fixture.example/", "title": "t",
             "top_results": [], "ai_overview": {}, "ai_overview_deferred": False,
             "questions": QUESTIONS, "related_searches": RELATED, "pages_fetched": 1,
             "depth": 10, "error": ""}
    monkeypatch.setattr(google_rank, "find_rank", lambda *a, **k: dict(found))
    ok = google_rank.check(bp, force=True)
    assert ok.serp_features == {
        "questions": [{"question": "Is Fixture Notes free?", "url": "https://faq.example/free"}],
        "related_searches": RELATED,
    }
    monkeypatch.setattr(google_rank, "find_rank", lambda *a, **k: {
        **found, "position": None, "questions": [], "related_searches": [], "pages_fetched": 0,
        "error": "http_500"})
    failed = google_rank.check(bp, force=True)
    assert failed.serp_features == {}
    assert GoogleRankCheck.objects.count() == 2


def test_research_capture_and_rank_check_carry_related_searches(website):
    bp = track(website, "best notes app for teams")
    payload = {"provider": "serpapi", "organic": [
        {"position": 1, "url": "https://www.notes-fixture.example/", "domain":
         "www.notes-fixture.example", "title": "Home"}],
        "questions": QUESTIONS, "related_searches": RELATED, "ai_overview": {}}
    capture = research.build_serp_capture(payload, website=website, query="q", page=1,
                                          location="us", capture_id="c1")
    assert capture["related_searches"] == RELATED
    assert capture["people_also_ask"] == ["Is Fixture Notes free?"]

    later = {**capture, "page": 2, "people_also_ask": ["Later?"], "related_searches": ["later"]}
    check = research._record_rank_check(website, bp, query="q", location="us",
                                        pages=[capture, later], fetched=2, exhausted=False)
    assert check.serp_features == {
        "questions": [{"question": "Is Fixture Notes free?", "url": ""}],
        "related_searches": RELATED,
    }
    old = {k: v for k, v in capture.items() if k != "related_searches"}
    check = research._record_rank_check(website, bp, query="q", location="us", pages=[old],
                                        fetched=1, exhausted=False)
    assert check.serp_features["related_searches"] == []
