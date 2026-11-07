import pytest
import responses

from apps.citations.services import serp_google
from apps.search_gap.services import google_rank
from apps.search_gap.services.google_rank import (
    find_rank,
    is_same_site,
    locale,
    site_apex,
    summarize_ai_overview,
)


def _page(start, domains):
    return {
        "error": "",
        "organic": [
            {"position": start + i + 1, "url": f"https://{d}/page", "domain": d, "title": d}
            for i, d in enumerate(domains)
        ],
        "ai_overview": {"text": "x", "references": []} if start == 0 else {},
    }


class FakeSearch:
    """Serves canned pages and records every call."""

    def __init__(self, pages, errors=None):
        self.pages = pages
        self.errors = errors or {}
        self.calls = []

    def __call__(self, query, *, max_results, start, gl, hl):
        self.calls.append({"start": start, "gl": gl, "hl": hl})
        if start in self.errors:
            return {"error": self.errors[start], "organic": []}
        return _page(start, self.pages.get(start, []))


def _filler(n, tag):
    return [f"{tag}{i}.com" for i in range(n)]


def test_site_apex_and_same_site_matching():
    apex = site_apex("www.northwind.example/pricing")
    assert apex == "northwind.example"
    assert is_same_site("northwind.example", apex)
    assert is_same_site("www.northwind.example", apex)
    assert is_same_site("blog.northwind.example", apex)
    assert not is_same_site("northwind.example.evil.com", apex)
    assert not is_same_site("", apex)


def test_locale():
    assert locale("US") == ("us", "en")
    assert locale("") == ("", "en")
    assert locale("global") == ("", "en")


def test_found_on_page_one_costs_one_call():
    search = FakeSearch({0: ["a.com", "www.site.example", "b.com"]})
    out = find_rank("q", "site.example", max_depth=100, search=search)
    assert out["position"] == 2
    assert out["url"] == "https://www.site.example/page"
    assert out["pages_fetched"] == 1
    assert len(search.calls) == 1
    assert out["ai_overview"] == {"text": "x", "references": []}


def test_walks_pages_and_keeps_absolute_position():
    search = FakeSearch({
        0: _filler(10, "p1-"),
        10: _filler(10, "p2-"),
        20: _filler(3, "p3-") + ["site.example"],
    })
    out = find_rank("q", "site.example", max_depth=100, search=search)
    assert out["position"] == 24
    assert [c["start"] for c in search.calls] == [0, 10, 20]
    assert out["pages_fetched"] == 3
    # Only page one is kept as "what you are up against".
    assert len(out["top_results"]) == 10


def test_not_found_within_depth():
    search = FakeSearch({0: _filler(10, "a"), 10: _filler(10, "b"), 20: _filler(10, "c")})
    out = find_rank("q", "site.example", max_depth=30, search=search)
    assert out["position"] is None
    assert out["pages_fetched"] == 3
    assert len(search.calls) == 3


def test_stops_when_results_run_out():
    search = FakeSearch({0: _filler(10, "a"), 10: []})
    out = find_rank("q", "site.example", max_depth=100, search=search)
    assert out["position"] is None
    assert len(search.calls) == 2


def test_first_page_error_is_reported():
    search = FakeSearch({}, errors={0: "http_429"})
    out = find_rank("q", "site.example", max_depth=100, search=search)
    assert out["error"] == "http_429"
    assert out["pages_fetched"] == 0


def test_later_page_error_keeps_what_was_learned():
    search = FakeSearch({0: _filler(10, "a")}, errors={10: "network"})
    out = find_rank("q", "site.example", max_depth=100, search=search)
    assert out["error"] == ""
    assert out["pages_fetched"] == 1
    assert len(out["top_results"]) == 10


def test_locale_is_passed_through():
    search = FakeSearch({0: ["site.example"]})
    find_rank("q", "site.example", gl="gb", hl="en", search=search)
    assert search.calls[0] == {"start": 0, "gl": "gb", "hl": "en"}


def test_summarize_ai_overview():
    block = {
        "text": "Northwind CRM and Pipedrive are both popular.",
        "references": [{"url": "https://www.site.example/x", "domain": "site.example", "title": ""}],
    }
    out = summarize_ai_overview(block, brand="Northwind CRM", apex="site.example")
    assert out["shown"] and out["mentions_you"] and out["cites_you"]
    assert out["content_captured"] is True
    assert summarize_ai_overview({}, brand="Northwind CRM", apex="site.example") == {
        "shown": False, "content_captured": True, "mentions_you": False, "cites_you": False,
        "references": [],
    }


def test_a_deferred_ai_overview_is_shown_but_not_measured():
    # Google loaded the overview separately: shown, content never read.
    assert summarize_ai_overview({}, brand="Northwind CRM", apex="site.example",
                                 deferred=True) == {
        "shown": True, "content_captured": False, "mentions_you": None, "cites_you": None,
        "references": [],
    }
    # Content that did come with the page is measured as usual.
    block = {"text": "Northwind CRM is popular.", "references": []}
    out = summarize_ai_overview(block, brand="Northwind CRM", apex="site.example", deferred=True)
    assert out["content_captured"] is True and out["mentions_you"] is True


def test_find_rank_keeps_the_first_page_deferred_overview_flag():
    class Deferred(FakeSearch):
        def __call__(self, query, **kwargs):
            payload = super().__call__(query, **kwargs)
            payload["ai_overview"] = {}
            payload["ai_overview_deferred"] = kwargs["start"] == 0
            return payload

    search = Deferred({0: _filler(10, "p1-"), 10: ["site.example"]})
    out = find_rank("q", "site.example", search=search)
    assert out["position"] == 11
    assert out["ai_overview"] == {} and out["ai_overview_deferred"] is True
    assert find_rank("q", "site.example", search=FakeSearch({0: ["site.example"]}))[
        "ai_overview_deferred"] is False


@pytest.mark.django_db
def test_check_stores_a_deferred_overview_as_not_measured(settings, monkeypatch):
    from django.contrib.auth import get_user_model

    from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
    from apps.prompt_library.services._hash import text_hash
    from apps.websites.models import Website

    settings.SERPAPI_KEY = "test-key"
    user = get_user_model().objects.create_user(email="rank@example.com", password="x" * 16)
    website = Website.objects.create(user=user, url="https://site.example", name="Northwind CRM")
    industry, _ = Industry.objects.get_or_create(
        slug="rank-crm", defaults={"name": "CRM (rank)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text="best crm", template_text="best crm", text_hash=text_hash("best crm"),
        intent_bucket="category", style="question", source=PromptSource.MANUAL,
    )
    bp = BrandPrompt.objects.create(website=website, prompt=prompt)
    monkeypatch.setattr(google_rank, "find_rank", lambda *a, **k: {
        "position": 3, "url": "https://site.example/crm", "title": "Northwind",
        "top_results": [], "ai_overview": {}, "ai_overview_deferred": True,
        "pages_fetched": 1, "error": "",
    })

    check = google_rank.check(bp, force=True)

    assert check.ai_overview == {"shown": True, "content_captured": False, "mentions_you": None,
                                 "cites_you": None, "references": []}


def test_check_without_key_raises_before_touching_the_database(settings):
    settings.SERPAPI_KEY = ""
    with pytest.raises(google_rank.NotConfigured):
        google_rank.check(object())


@responses.activate
def test_serp_google_pages_with_start_and_locale(settings):
    settings.SERPAPI_KEY = "test-key"
    responses.add(
        responses.GET, serp_google.SEARCH_ENDPOINT,
        json={"organic_results": [
            {"position": 11, "link": "https://www.a.com/x", "title": "A"},
            {"position": 12, "link": "https://b.com/y", "title": "B"},
        ]},
    )
    payload = serp_google.search("best crm", max_results=10, start=10, gl="US", hl="en")
    sent = responses.calls[0].request.params
    assert sent["start"] == "10" and sent["gl"] == "us" and sent["hl"] == "en"
    assert [(r["position"], r["rank"], r["domain"]) for r in payload["organic"]] == [
        (11, 1, "a.com"), (12, 2, "b.com"),
    ]


@responses.activate
def test_serp_google_first_page_sends_no_paging_params(settings):
    settings.SERPAPI_KEY = "test-key"
    responses.add(responses.GET, serp_google.SEARCH_ENDPOINT, json={"organic_results": []})
    serp_google.search("best crm")
    sent = responses.calls[0].request.params
    assert "start" not in sent and "gl" not in sent


@responses.activate
def test_serp_google_http_error(settings):
    settings.SERPAPI_KEY = "test-key"
    responses.add(responses.GET, serp_google.SEARCH_ENDPOINT, status=429)
    assert serp_google.search("best crm", start=10)["error"] == "http_429"


@responses.activate
def test_serp_google_flags_an_ai_overview_whose_content_did_not_come(settings):
    settings.SERPAPI_KEY = "test-key"
    # Each first page lists a result: an empty first page is a failed read.
    row = [{"position": 1, "title": "Best CRM", "link": "https://example.org/best-crm"}]
    for body in (
        # Google loads the overview separately: SerpAPI sends only a token.
        {"organic_results": row, "ai_overview": {
            "page_token": "tok", "serpapi_link": "https://serpapi.com/search.json?page_token=tok"}},
        {"organic_results": row, "ai_overview": {"text_blocks": [{"snippet": "Northwind CRM."}]}},
        {"organic_results": row},
    ):
        responses.add(responses.GET, serp_google.SEARCH_ENDPOINT, json=body)

    deferred, read, absent = (serp_google.search("best crm") for _ in range(3))

    assert deferred["ai_overview"] == {} and deferred["ai_overview_deferred"] is True
    assert read["ai_overview"]["text"] == "Northwind CRM." and read["ai_overview_deferred"] is False
    assert absent["ai_overview"] == {} and absent["ai_overview_deferred"] is False
    assert serp_google._empty()["ai_overview_deferred"] is False


def _tracked_prompt(email: str, text: str):
    from django.contrib.auth import get_user_model

    from apps.prompt_library.models import BrandPrompt, Industry, Prompt
    from apps.prompt_library.services._hash import text_hash
    from apps.websites.models import Website

    user = get_user_model().objects.create_user(email=email, password="x" * 16)
    website = Website.objects.create(user=user, url="https://site.example", name="Northwind CRM")
    industry, _ = Industry.objects.get_or_create(
        slug="rank-crm", defaults={"name": "CRM (rank)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, text_hash=text_hash(text),
        intent_bucket="category", style="question", source="manual",
    )
    return BrandPrompt.objects.create(website=website, prompt=prompt)


@pytest.mark.django_db
def test_check_reads_to_the_depth_asked_and_can_skip_the_rolling_cap(settings, monkeypatch):
    # Autopilot reads page one only (depth 10, SerpAPI too) and applies its
    # own daily page quotas instead of the rolling 24h cap.
    settings.SERPAPI_KEY = "test-key"
    settings.SEARCH_GAP_MAX_DEPTH = 100
    settings.SEARCH_GAP_DAILY_CHECKS_PER_WEBSITE = 1
    bp = _tracked_prompt("depth@example.com", "best crm for startups")
    depths = []

    def find(query, apex, *, max_depth, gl="", hl=""):
        depths.append(max_depth)
        return {"position": None, "url": "", "title": "", "top_results": [], "ai_overview": {},
                "ai_overview_deferred": False, "pages_fetched": 1,
                "depth": min(max_depth, 100), "error": ""}

    monkeypatch.setattr(google_rank, "find_rank", find)

    first = google_rank.check(bp, force=True)
    assert depths == [100] and first.depth == 100
    with pytest.raises(google_rank.DailyLimitReached):
        google_rank.check(bp, force=True)
    page_one = google_rank.check(bp, force=True, depth=10, enforce_daily_cap=False)
    assert depths == [100, 10]
    assert (page_one.depth, page_one.pages_fetched, page_one.position) == (10, 1, None)
    # Without the new arguments a check behaves as before.
    with pytest.raises(google_rank.DailyLimitReached):
        google_rank.check(bp, force=True, depth=10)
