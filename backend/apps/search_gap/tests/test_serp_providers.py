"""SerpAPI and ScraperAPI behind one serp_google.search.

The ScraperAPI bodies below are trimmed from real structured Google
responses: positions restart on every page (page two counts from 0), the
AI Overview only shows up as an ``ai_box`` marker, and related searches
carry a position and a link.
"""

import pytest
import responses

from apps.citations.services import serp_google
from apps.search_gap.services import google_rank

SCRAPER_PAGE_1 = {
    "search_information": {"query_displayed": "best note app"},
    "ai_box": {"position": 0, "ai_is_loading": False},
    "organic_results": [
        {"position": 1, "title": "The 9 best note taking apps", "snippet": "Tested and ranked.",
         "highlighs": ["best note app"], "link": "https://zapier.com/blog/best-note-taking-apps/",
         "displayed_link": "https://zapier.com > blog"},
        {"position": 2, "title": "Notion", "snippet": "One workspace.",
         "link": "https://www.notion.com/", "displayed_link": "https://www.notion.com"},
        {"position": 3, "title": "Turonote", "snippet": "Notes that write back.",
         "link": "https://turonote.example/", "displayed_link": "https://turonote.example"},
    ],
    "related_searches": [
        {"position": 10, "query": "Best note app free", "link": "https://www.google.com/search?q=x"},
        {"position": 11, "query": "best note app for android", "link": "https://www.google.com/search?q=y"},
    ],
    "pagination": {"pages_count": 10, "current_page": 1},
}

SCRAPER_PAGE_2 = {
    "search_information": {"query_displayed": "best note app"},
    "organic_results": [
        {"position": 0, "title": "Evernote", "snippet": "Remember everything.",
         "link": "https://evernote.com/", "displayed_link": "https://evernote.com"},
        {"position": 1, "title": "Turonote pricing", "snippet": "Plans.",
         "link": "https://www.turonote.example/pricing", "displayed_link": "https://turonote.example"},
    ],
    "related_searches": [],
    "pagination": {"pages_count": 10, "current_page": 2},
}


@pytest.fixture
def scraper_only(settings):
    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    settings.SERP_PROVIDER = ""
    settings.SCRAPERAPI_COST_PER_SEARCH_USD = 0.0
    return settings


def test_provider_choice(settings):
    settings.SERP_PROVIDER = ""
    settings.SERPAPI_KEY, settings.SCRAPERAPI_KEY = "", ""
    assert serp_google.provider() == ""
    assert not serp_google.is_configured()

    settings.SCRAPERAPI_KEY = "s"
    assert serp_google.provider() == "scraperapi"
    assert serp_google.is_configured()

    # SerpAPI parses more of the page, so it wins when both keys are set...
    settings.SERPAPI_KEY = "p"
    assert serp_google.provider() == "serpapi"
    # ...unless SERP_PROVIDER pins the other one.
    settings.SERP_PROVIDER = "ScraperAPI "
    assert serp_google.provider() == "scraperapi"
    # A pinned provider without a key means not configured, never a silent switch.
    settings.SCRAPERAPI_KEY = ""
    assert serp_google.provider() == ""


def test_cost_follows_the_provider(settings):
    settings.SERP_PROVIDER = ""
    settings.SERPAPI_COST_PER_SEARCH_USD = 0.015
    settings.SCRAPERAPI_COST_PER_SEARCH_USD = 0.002
    settings.SERPAPI_KEY, settings.SCRAPERAPI_KEY = "", ""
    assert serp_google.cost_per_search_usd() == 0
    settings.SCRAPERAPI_KEY = "s"
    assert str(serp_google.cost_per_search_usd()) == "0.002"
    settings.SERPAPI_KEY = "p"
    assert str(serp_google.cost_per_search_usd()) == "0.015"


@responses.activate
def test_scraperapi_page_one_maps_to_the_shared_shape(scraper_only):
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json=SCRAPER_PAGE_1)

    payload = serp_google.search("best note app", max_results=10, gl="US", hl="en")

    assert payload["provider"] == "scraperapi"
    assert payload["error"] == ""
    sent = responses.calls[0].request.params
    assert sent["query"] == "best note app"
    assert sent["country_code"] == "us"
    assert sent["api_key"] == "scraper-test-key"
    assert "start" not in sent and "hl" not in sent
    assert [r["position"] for r in payload["organic"]] == [1, 2, 3]
    assert [r["domain"] for r in payload["organic"]] == ["zapier.com", "notion.com", "turonote.example"]
    assert payload["organic"][0]["snippet"] == "Tested and ranked."
    assert payload["related_searches"] == ["Best note app free", "best note app for android"]
    # The ai_box marker says an overview was shown; its content never came.
    assert payload["ai_overview"] == {}
    assert payload["ai_overview_deferred"] is True


@responses.activate
def test_scraperapi_page_two_positions_are_absolute(scraper_only):
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json=SCRAPER_PAGE_2)

    payload = serp_google.search("best note app", max_results=10, start=10)

    assert responses.calls[0].request.params["start"] == "10"
    # No country given: ScraperAPI would pick a proxy anywhere, so it asks
    # for US results, as SerpAPI does by default.
    assert responses.calls[0].request.params["country_code"] == "us"
    # ScraperAPI numbered this page 0 and 1; Google's positions are 11 and 12.
    assert [r["position"] for r in payload["organic"]] == [11, 12]
    assert payload["ai_overview_deferred"] is False


@responses.activate
def test_scraperapi_errors_never_log_the_key(scraper_only, monkeypatch):
    logged = []
    monkeypatch.setattr(serp_google.logger, "warning", lambda msg, *args: logged.append(msg % args))

    responses.get(serp_google.SCRAPERAPI_ENDPOINT, status=401, json={"error": "Invalid API key"})
    payload = serp_google.search("best note app")
    assert payload["error"] == "http_401"
    assert payload["provider"] == "scraperapi"
    assert payload["organic"] == []

    responses.replace(responses.GET, serp_google.SCRAPERAPI_ENDPOINT,
                      body=ConnectionError("failed: /structured/google/search?api_key=scraper-test-key"))
    payload = serp_google.search("best note app")
    assert payload["error"] == "network"
    assert logged and not any("scraper-test-key" in line for line in logged)
    assert "***" in logged[-1]


def test_unconfigured_search_keeps_its_error_code(settings):
    settings.SERPAPI_KEY, settings.SCRAPERAPI_KEY, settings.SERP_PROVIDER = "", "", ""
    payload = serp_google.search("best note app")
    assert payload["configured"] is False
    assert payload["error"] == "serpapi_not_configured"


@responses.activate
def test_rank_check_reads_only_scraperapis_first_page(scraper_only):
    # Was "walks ScraperAPI pages": its page 2 answers another query (live,
    # 2026-11-03), so a ScraperAPI rank check stops at the top 10.
    def page_for(request):
        start = request.params.get("start")
        body = SCRAPER_PAGE_2 if start == "10" else {**SCRAPER_PAGE_1, "organic_results": [
            row for row in SCRAPER_PAGE_1["organic_results"] if "turonote" not in row["link"]
        ]}
        import json
        return (200, {}, json.dumps(body))

    responses.add_callback(responses.GET, serp_google.SCRAPERAPI_ENDPOINT, callback=page_for)

    found = google_rank.find_rank("best note app", "turonote.example", max_depth=20)

    assert len(responses.calls) == 1 and "start" not in responses.calls[0].request.params
    assert (found["pages_fetched"], found["depth"]) == (1, 10)
    assert found["position"] is None and found["url"] == ""
    assert found["ai_overview_deferred"] is True


def test_max_reliable_pages(settings):
    assert serp_google.max_reliable_pages("scraperapi") == 1
    assert serp_google.max_reliable_pages("serpapi") == 10
    settings.SERP_PROVIDER, settings.SERPAPI_KEY, settings.SCRAPERAPI_KEY = "", "", "k"
    assert serp_google.max_reliable_pages() == 1
    settings.SERPAPI_KEY = "k"
    assert serp_google.max_reliable_pages() == 10


@responses.activate
def test_a_scraperapi_rank_check_is_stored_as_not_in_the_top_10(scraper_only, django_user_model,
                                                                 db):
    from apps.prompt_library.models import BrandPrompt, Industry, Prompt
    from apps.prompt_library.services._hash import text_hash
    from apps.websites.models import Website

    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json=SCRAPER_PAGE_1)
    user = django_user_model.objects.create_user(email="depth@example.com", password="x" * 16)
    website = Website.objects.create(user=user, url="https://absent.example", name="Absent")
    industry, _ = Industry.objects.get_or_create(
        slug="depth-notes", defaults={"name": "Notes (depth)", "is_active": True},
    )
    prompt = Prompt.objects.create(industry=industry, text="best note app",
                                   template_text="best note app", intent_bucket="category",
                                   source="manual", text_hash=text_hash("best note app"))
    bp = BrandPrompt.objects.create(website=website, prompt=prompt)

    check = google_rank.check(bp, force=True)

    # Searched the top 10 only, and says so: not "not in the top 100".
    assert (check.position, check.depth, check.pages_fetched) == (None, 10, 1)
    assert len(responses.calls) == 1


@responses.activate
def test_serpapi_still_walks_its_pages(settings):
    settings.SERP_PROVIDER, settings.SCRAPERAPI_KEY, settings.SERPAPI_KEY = "", "", "serp-key"

    def page_for(request):
        import json
        start = int(request.params.get("start") or 0)
        rows = [{"position": start + i + 1, "link": f"https://other-{start + i}.example/",
                 "title": "Other"} for i in range(10)]
        if start == 10:
            rows[1] = {"position": 12, "link": "https://www.turonote.example/pricing",
                       "title": "Turonote"}
        return (200, {}, json.dumps({"organic_results": rows}))

    responses.add_callback(responses.GET, serp_google.SEARCH_ENDPOINT, callback=page_for)

    found = google_rank.find_rank("best note app", "turonote.example", max_depth=100)

    assert (found["position"], found["pages_fetched"], found["depth"]) == (12, 2, 100)


# Trimmed from a real response: Google's newer result pages link most rows
# through an opaque click redirect, and forum rows name no site at all.
SCRAPER_REDIRECTS = {
    "organic_results": [
        {"position": 1, "title": "17 Best Team Collaboration Software Tools",
         "link": "https://www.google.com/goto?url=CAESgwEB6zswFYvkBby0v0bNIIWEQzl5",
         "displayed_link": "https://www.recruiterslineup.com \u203a best-team-collaborati..."},
        {"position": 2, "title": "25+ Collaboration Tools for Teams",
         "link": "https://gmelius.com/blog/team-collaboration-tools-software",
         "displayed_link": "https://gmelius.com \u203a blog \u203a team-collaboration-tools-s..."},
        {"position": 3, "title": "Which team collaboration tools do you prefer?",
         "link": "https://www.google.com/goto?url=CAESfQHrOzAVZ7_gtlLS3CEm2wqnwyrnO",
         "displayed_link": "40+ answers  \u00b7  4 years ago"},
        {"position": 4, "title": "Top 20 Collaboration Software",
         "link": "https://www.google.com/url?q=https://mopinion.com/collaboration-software/&sa=U",
         "displayed_link": "https://mopinion.com \u203a Blog"},
        {"position": 5, "title": "Collaboration in Notion",
         "link": "https://www.google.com/goto?url=CAESiQEB6zswFYkJcmvggNVx",
         "displayed_link": "https://www.notion.com \u203a product \u203a wikis"},
    ],
}


@responses.activate
def test_scraperapi_google_redirects_fall_back_to_the_breadcrumb_site(scraper_only):
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json=SCRAPER_REDIRECTS)

    rows = serp_google.search("best software for teams")["organic"]

    assert [(r["position"], r["domain"]) for r in rows] == [
        (1, "recruiterslineup.com"),
        (2, "gmelius.com"),
        # The forum row names no site and is skipped; later rows keep their
        # Google positions.
        (4, "mopinion.com"),
        (5, "notion.com"),
    ]
    # Only the site is known behind an opaque /goto token...
    assert rows[0]["url"] == "https://www.recruiterslineup.com/"
    assert rows[0]["site_only"] is True
    # ...a direct link and a /url?q= redirect keep the exact page.
    assert rows[1]["url"] == "https://gmelius.com/blog/team-collaboration-tools-software"
    assert rows[1]["site_only"] is False
    assert rows[2]["url"] == "https://mopinion.com/collaboration-software/"
    assert rows[2]["site_only"] is False
    assert rows[3]["breadcrumb"].startswith("https://www.notion.com")


@responses.activate
def test_rank_check_finds_a_site_behind_a_google_redirect(scraper_only):
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json=SCRAPER_REDIRECTS)

    found = google_rank.find_rank("best software for teams", "notion.com", max_depth=10)

    assert found["position"] == 5
    assert found["url"] == "https://www.notion.com/"


@responses.activate
def test_an_empty_first_page_is_a_failed_read_not_no_results(scraper_only):
    # ScraperAPI sometimes answers 200 with no organic results for a query
    # whose real first page is full. That is a failed read: it must never be
    # recorded as "not ranked".
    responses.get(serp_google.SCRAPERAPI_ENDPOINT,
                  json={"search_information": {}, "ai_box": {"position": 0}, "related_searches": []})

    payload = serp_google.search("how to centralize all business information in one place")
    assert payload["error"] == "empty_results"
    assert payload["organic"] == []

    found = google_rank.find_rank("how to centralize all business information", "notion.com",
                                  max_depth=100)
    assert found["error"] == "empty_results"
    assert found["position"] is None
    assert found["pages_fetched"] == 0


@responses.activate
def test_an_empty_later_page_means_google_ran_out(scraper_only):
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json={"organic_results": []})
    payload = serp_google.search("best note app", start=10)
    assert payload["error"] == ""
    assert payload["organic"] == []
