"""
Onboarding competitors and buyer questions from real Google results.

``serp_google.search`` is replaced by ``FakeGoogle``, which answers per query
in the provider's parsed shape and records every call. Claude is replaced by
``FakeClaude`` (patched over ``core.llm.ClaudeUtility`` for the discovery
module and over the orchestrator's own import), answering per ``role``.
``scan_domain`` and the logo crawler are patched at their source modules.
Nothing reaches the network.

The ScraperAPI-shaped answers carry no People also ask block, as the real
structured responses do not; the SerpAPI-shaped ones carry
``questions``.
"""
import json
import threading
from unittest.mock import patch

import pytest
from django.core.cache import cache

from apps.citations.services.domain_classifier import is_aggregator
from apps.llm_ranking.services import competitor_discovery
from apps.onboarding.services import onboarding_service, serp_discovery
from apps.onboarding.services.onboarding_service import run_onboarding_scan, to_dict
from core.llm import ProviderResult

SCAN_DOMAIN = "apps.llm_ranking.services.domain_scanner.scan_domain"
FETCH_LOGO = "apps.prompt_library.services.logo_crawler.fetch_site_logo"
SEARCH = "apps.citations.services.serp_google.search"

SCAN = {
    "success": True,
    "business_name": "Turonote",
    "industry": "note taking app",
    "domain": "turonote.com",
    "description": "Turonote is a note taking app for teams.",
    "products": ["Turonote Teams"],
    "features": [],
    "selling_points": [],
    "page_text": "",
}


def _row(rank, url, title, snippet=""):
    host = url.split("/")[2].removeprefix("www.")
    return {"rank": rank, "position": rank, "url": url, "domain": host, "site_only": False,
            "breadcrumb": "", "title": title, "snippet": snippet, "date": ""}


def _payload(organic, *, questions=(), related=(), provider="scraperapi"):
    return {
        "configured": True, "provider": provider, "error": "",
        "organic": list(organic), "discussions": [],
        "questions": [{"question": q, "snippet": "", "url": "", "domain": ""} for q in questions],
        "related_searches": list(related), "ai_overview": {}, "ai_overview_deferred": False,
        "knowledge_graph": {}, "geo": None,
    }


ALTERNATIVES = _payload([
    _row(1, "https://www.g2.com/products/turonote/competitors/alternatives",
         "Top 10 Turonote Alternatives & Competitors", "Notion, Evernote and Obsidian are"
         " popular Turonote alternatives."),
    _row(2, "https://turonote.com/compare", "Turonote vs the rest", "Why teams pick Turonote."),
    _row(3, "https://www.notion.com/", "Notion - Your connected workspace",
         "A Turonote alternative for docs and notes."),
    _row(4, "https://evernote.com/", "Evernote | Remember everything", "Take notes anywhere."),
    _row(5, "https://www.dropbox.com/paper", "Dropbox Paper", "Turonote users also try Paper."),
    _row(6, "https://www.reddit.com/r/notes/", "Turonote alternatives? : r/notes", "Thread."),
    _row(7, "https://zapier.com/blog/best-note-apps/", "The best note apps", "Tested."),
], related=["turonote alternatives free", "best note taking app for teams like turonote",
            "note apps for small teams that sync offline"])

COMPETITORS = _payload([
    _row(1, "https://www.capterra.com/p/1/turonote/", "Turonote Competitors", "Turonote ranks"),
    _row(2, "https://evernote.com/compare", "Evernote vs Turonote", "Evernote compared"),
    _row(3, "https://obsidian.md/", "Obsidian - Sharpen your thinking", "A private notes app."),
])

BEST = _payload([
    _row(1, "https://zapier.com/blog/best-note-taking-apps/", "The 9 best note taking apps", ""),
], related=["best note app", "best note taking app for android tablets",
            "note taking app with offline sync for teams"])

BEST_SERPAPI = _payload(
    [_row(1, "https://zapier.com/blog/best-note-taking-apps/", "The 9 best note taking apps", "")],
    questions=["What is the best note taking app for teams?",
               "Is Turonote free?",
               "Which note app works offline?"],
    related=["best note app free"],
    provider="serpapi",
)


class FakeGoogle:
    def __init__(self, answers):
        self.answers = answers
        self.calls = []
        self.threads = set()

    def __call__(self, query, **kwargs):
        self.calls.append({"query": query, **kwargs})
        self.threads.add(threading.current_thread().name)
        answer = self.answers.get(query)
        if isinstance(answer, Exception):
            raise answer
        if answer is None:
            return {**_payload([]), "error": "empty_results"}
        return answer


def _ok(text):
    return ProviderResult(succeeded=True, text=text, input_tokens=10, output_tokens=10)


class FakeClaude:
    responses: dict = {}
    calls: list = []
    configured = True

    def __init__(self, *, model, max_tokens=1024):
        self.model = model
        self.max_tokens = max_tokens

    def is_configured(self):
        return self.configured

    def query(self, prompt, system_prompt="", **kwargs):
        role = kwargs.get("role")
        FakeClaude.calls.append({"prompt": prompt, "system_prompt": system_prompt, **kwargs})
        answer = FakeClaude.responses.get(role)
        if isinstance(answer, ProviderResult):
            return answer
        if answer is None:
            return ProviderResult(succeeded=False, error="no fake answer")
        return _ok(answer)


ANSWERS = {
    "Turonote alternatives": ALTERNATIVES,
    "Turonote competitors": COMPETITORS,
    "best note taking app": BEST,
}


@pytest.fixture(autouse=True)
def _isolated(settings):
    settings.ANTHROPIC_API_KEY = ""
    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    settings.SERP_PROVIDER = ""
    settings.SCRAPERAPI_COST_PER_SEARCH_USD = 0.0
    settings.GOOGLE_SEARCH_API_KEY = ""
    settings.GOOGLE_SEARCH_ENGINE_ID = ""
    settings.ONBOARDING_SERP_DAILY_SEARCHES = 15
    cache.clear()
    with patch(FETCH_LOGO, return_value=""):
        yield
    cache.clear()


@pytest.fixture
def google():
    fake = FakeGoogle(dict(ANSWERS))
    with patch(SEARCH, fake):
        yield fake


@pytest.fixture
def claude():
    FakeClaude.responses = {}
    FakeClaude.calls = []
    FakeClaude.configured = True
    with patch("core.llm.ClaudeUtility", FakeClaude), \
         patch.object(onboarding_service, "ClaudeUtility", FakeClaude):
        yield FakeClaude


class _User:
    pk = 42


def _scan(scan=SCAN, user=None):
    with patch(SCAN_DOMAIN, return_value=scan):
        return run_onboarding_scan(f"https://{scan.get('domain', 'turonote.com')}", user=user)


# -- the searches ---------------------------------------------------------------


class TestSearches:
    def test_three_searches_with_short_timeout_on_worker_threads(self, google, settings):
        settings.ONBOARDING_SERP_TIMEOUT = 12
        payload = _scan()
        queries = sorted(c["query"] for c in google.calls)
        assert queries == ["Turonote alternatives", "Turonote competitors", "best note taking app"]
        assert all(c["timeout"] == 12 and c["country"] == "" for c in google.calls)
        assert all(name.startswith("onboarding-serp") for name in google.threads)
        assert payload.google["configured"] is True
        assert payload.google["provider"] == "scraperapi"
        assert payload.google["label"] == "ScraperAPI"
        assert payload.google["searches"] == 3
        assert payload.google["error"] == ""
        assert {q["query"] for q in payload.google["queries"]} == set(queries)

    def test_not_configured_makes_no_search(self, settings):
        settings.SCRAPERAPI_KEY = ""
        fake = FakeGoogle(ANSWERS)
        with patch(SEARCH, fake):
            payload = _scan()
        assert fake.calls == []
        assert payload.google == {
            "configured": False, "provider": "", "label": "",
            "error": "serpapi_not_configured", "searches": 0, "queries": [],
        }

    def test_short_brand_skips_brand_searches(self, google):
        _scan({**SCAN, "business_name": "Tu"})
        assert [c["query"] for c in google.calls] == ["best note taking app"]

    def test_seed_from_first_offering_without_industry(self, google):
        _scan({**SCAN, "industry": "", "products": ["Meeting notes"]})
        assert "best Meeting notes" in [c["query"] for c in google.calls]

    def test_no_seed_no_question_search(self, google):
        _scan({**SCAN, "industry": "", "products": []})
        assert sorted(c["query"] for c in google.calls) == [
            "Turonote alternatives", "Turonote competitors"]

    def test_daily_limit_per_user(self, google, settings):
        settings.ONBOARDING_SERP_DAILY_SEARCHES = 4
        user = _User()
        first = _scan(user=user)
        second = _scan(user=user)
        assert first.google["searches"] == 3
        assert second.google["searches"] == 1
        assert len(google.calls) == 4
        errors = [q["error"] for q in second.google["queries"]]
        assert errors.count("daily_limit") == 2

    def test_limit_counts_per_user(self, google, settings):
        settings.ONBOARDING_SERP_DAILY_SEARCHES = 3
        _scan(user=_User())

        class Other:
            pk = 7

        other = _scan(user=Other())
        assert other.google["searches"] == 3

    def test_search_errors_are_reported_and_scan_continues(self, settings):
        fake = FakeGoogle({"Turonote alternatives": RuntimeError("boom")})
        with patch(SEARCH, fake):
            payload = _scan()
        assert payload.success is True
        assert payload.google["error"] in {"network", "empty_results"}
        assert payload.competitors == []

    def test_hung_search_times_out(self, settings):
        settings.ONBOARDING_SERP_TIMEOUT = 0.01
        release = threading.Event()

        def slow(query, **kwargs):
            release.wait(10)
            return ALTERNATIVES

        with patch(SEARCH, slow), patch.object(serp_discovery, "_timeout", return_value=0.01):
            lookup = serp_discovery.GoogleLookup.start(business_name="Turonote", seed="")
            # collect waits timeout + 5 at most; shrink it for the test.
            with patch("concurrent.futures.wait") as wait:
                wait.return_value = None
                results = lookup.collect()
        release.set()
        assert [q.error for q in results.queries] == ["timeout", "timeout"]
        assert results.error == "timeout"


# -- competitors ------------------------------------------------------------------


class TestCompetitorsFromSearchOnly:
    def test_result_sites_suggested_without_claude(self, google):
        payload = _scan()
        domains = [c["domain"] for c in payload.competitors]
        # Own site, review directories, reddit and zapier are not competitors;
        # dropbox.com survives (no substring match on "x.com").
        assert "turonote.com" not in domains
        assert not any(is_aggregator(d) for d in domains)
        assert "reddit.com" not in domains
        assert set(domains) == {"evernote.com", "notion.com", "dropbox.com", "obsidian.md"}
        # Listed by both brand searches first.
        assert domains[0] == "evernote.com"
        assert all(c["source"] == "search" for c in payload.competitors)
        assert payload.competitors_source == "search"
        first = payload.competitors[0]
        assert first["name"] == "Evernote"
        assert first["evidence"]["query"] in {"Turonote alternatives", "Turonote competitors"}
        assert first["evidence"]["url"].startswith("https://evernote.com/")
        names = {c["domain"]: c["name"] for c in payload.competitors}
        assert names["notion.com"] == "Notion"
        assert names["obsidian.md"] == "Obsidian"

    def test_misspelled_brand_results_are_not_used(self):
        # Google answered for another spelling: no result names the brand.
        other = _payload([
            _row(1, "https://evernote.com/", "Evernote", "Remember everything."),
            _row(2, "https://notion.com/", "Notion", "Workspace."),
        ], related=["notion alternatives for teams and students"])
        fake = FakeGoogle({"Turonote alternatives": other, "Turonote competitors": other})
        with patch(SEARCH, fake):
            payload = _scan({**SCAN, "industry": "", "products": []})
        assert payload.competitors == []
        assert payload.competitors_source == "failed"
        assert payload.google["error"] == "no_brand_results"
        assert payload.topics == []

    def test_usable_results_without_competitors_give_none_from_memory(self, claude):
        only_directories = _payload([
            _row(1, "https://www.g2.com/x", "Turonote alternatives", "Turonote compared"),
            _row(2, "https://www.capterra.com/y", "Turonote reviews", "Turonote rated"),
        ])
        claude.responses = {
            "competitor_discovery_serp": "[]",
            "competitor_discovery": json.dumps([{"name": "Evernote", "domain": "evernote.com"}]),
        }
        fake = FakeGoogle({"Turonote alternatives": only_directories,
                           "Turonote competitors": only_directories})
        with patch(SEARCH, fake):
            payload = _scan({**SCAN, "industry": ""})
        assert payload.competitors == []
        assert not [c for c in claude.calls if c["role"] == "competitor_discovery"]


class TestClaudePicksFromResults:
    def test_picks_are_checked_against_the_cited_row(self, google, claude):
        claude.responses = {"competitor_discovery_serp": json.dumps([
            # Named in the g2 row's snippet; its own site is a result too.
            {"name": "Obsidian", "domain": "", "row": 1},
            # Its own site is row 3.
            {"name": "Notion", "domain": "notion.com", "row": 3},
            # Not in the cited row: from memory, rejected.
            {"name": "Bear", "domain": "bear.app", "row": 4},
            # A domain that is not a result site is blanked.
            {"name": "Evernote", "domain": "evernote.example", "row": 4},
            # The brand itself.
            {"name": "Turonote", "domain": "turonote.com", "row": 2},
            # A row that does not exist.
            {"name": "Simplenote", "domain": "", "row": 99},
            # A duplicate.
            {"name": "Notion", "domain": "notion.com", "row": 1},
        ])}
        payload = _scan()
        assert [(c["name"], c["domain"]) for c in payload.competitors] == [
            ("Obsidian", "obsidian.md"),
            ("Notion", "notion.com"),
            ("Evernote", "evernote.com"),
        ]
        assert all(c["source"] == "both" for c in payload.competitors)
        assert payload.competitors_source == "both"
        assert payload.competitors[0]["evidence"]["url"].startswith("https://www.g2.com/")
        assert payload.competitors[1]["evidence"]["rank"] == 3

    def test_claude_sees_numbered_rows_as_untrusted(self, google, claude):
        claude.responses = {"competitor_discovery_serp": "[]"}
        _scan()
        call = next(c for c in claude.calls if c["role"] == "competitor_discovery_serp")
        assert call["module"] == "onboarding"
        assert "[3] notion.com | Notion - Your connected workspace" in call["system_prompt"]
        assert "UNTRUSTED" in call["system_prompt"]
        assert "notion.com" not in call["prompt"]
        # Memory is never asked when Google's results are usable.
        assert not [c for c in claude.calls if c["role"] == "competitor_discovery"]

    def test_no_picks_falls_back_to_result_sites(self, google, claude):
        claude.responses = {"competitor_discovery_serp": "not json"}
        payload = _scan()
        assert payload.competitors
        assert all(c["source"] == "search" for c in payload.competitors)

    def test_brand_name_is_clipped_in_the_prompt(self, claude):
        long_name = "Turonote " + "x" * 300
        fake = FakeGoogle({})
        with patch(SEARCH, fake):
            _scan({**SCAN, "business_name": long_name})
        assert all(len(c["query"]) <= serp_discovery.BRAND_MAX + len(" alternatives")
                   for c in fake.calls)
        for call in claude.calls:
            assert "x" * 120 not in call["prompt"]


class TestMemoryFallback:
    def test_claude_memory_when_google_not_configured(self, settings, claude):
        settings.SCRAPERAPI_KEY = ""
        claude.responses = {"competitor_discovery": json.dumps([
            {"name": "Evernote", "domain": "evernote.com"}])}
        payload = _scan()
        assert payload.competitors == [
            {"name": "Evernote", "domain": "evernote.com", "source": "ai", "evidence": None}]
        assert payload.competitors_source == "ai"

    def test_nothing_configured_is_unavailable(self, settings):
        settings.SCRAPERAPI_KEY = ""
        payload = _scan()
        assert payload.competitors == []
        assert payload.competitors_source == "unavailable"


# -- buyer questions ----------------------------------------------------------------


class TestQuestionsWithoutClaude:
    def test_google_text_used_as_written(self, google):
        payload = _scan()
        # ScraperAPI: no People also ask, so related searches of 4+ words,
        # without the brand's own name.
        assert payload.topics == [
            "best note taking app for android tablets",
            "note taking app with offline sync for teams",
            "note apps for small teams that sync offline",
        ]
        assert payload.topic_sources == ["search"] * 3
        assert payload.topic_brands == [[], [], []]
        assert payload.topic_evidence[0] == {
            "kind": "related", "text": "best note taking app for android tablets",
            "query": "best note taking app"}
        assert payload.topics_source == "search"
        assert payload.missing_keys == ["ANTHROPIC_API_KEY"]

    def test_people_also_ask_first_and_brand_questions_dropped(self, settings):
        settings.SERPAPI_KEY = "serp-test-key"
        fake = FakeGoogle({**ANSWERS, "best note taking app": BEST_SERPAPI})
        with patch(SEARCH, fake):
            payload = _scan()
        assert payload.topics[:2] == ["What is the best note taking app for teams?",
                                      "Which note app works offline?"]
        assert "Is Turonote free?" not in payload.topics
        assert payload.topic_evidence[0]["kind"] == "question"

    def test_at_most_ten(self, settings):
        many = _payload([_row(1, "https://a.example/", "A", "")],
                        questions=[f"How do I pick note app number {i}?" for i in range(8)],
                        related=[f"note app option {i} for teams" for i in range(8)],
                        provider="serpapi")
        settings.SERPAPI_KEY = "serp-test-key"
        fake = FakeGoogle({"best note taking app": many})
        with patch(SEARCH, fake):
            payload = _scan()
        assert len(payload.topics) == onboarding_service.TOPICS_MAX == 10
        assert len(payload.topic_sources) == len(payload.topic_evidence) == 10

    def test_nothing_from_google_and_no_claude_is_unavailable(self, settings):
        settings.SCRAPERAPI_KEY = ""
        payload = _scan()
        assert payload.topics == []
        assert payload.topics_source == "unavailable"


class TestQuestionsWithClaude:
    def test_sources_are_validated_against_google_text(self, google, claude):
        claude.responses = {
            "competitor_discovery_serp": "[]",
            "topic_generation": json.dumps([
                # Google's related search, word for word.
                {"topic": "note taking app with offline sync for teams", "brands": [],
                 "source": "related", "from": "note taking app with offline sync for teams"},
                # Reworded from a real related search.
                {"topic": "What is the best note taking app for an Android tablet",
                 "brands": ["Evernote"], "source": "related",
                 "from": "best note taking app for android tablets"},
                # Claims Google, but names text Google never returned.
                {"topic": "Which note apps do lawyers trust most", "brands": ["Notion"],
                 "source": "question", "from": "Which note apps do lawyers trust?"},
                # Drafted.
                {"topic": "How to share meeting notes with a remote team",
                 "brands": ["Notion", "Turonote"], "source": "ai", "from": None},
            ]),
        }
        payload = _scan()
        assert payload.topic_sources == ["search", "both", "ai", "ai"]
        assert payload.topic_evidence[1] == {
            "kind": "related", "text": "best note taking app for android tablets",
            "query": "best note taking app"}
        assert payload.topic_evidence[2] is None
        assert payload.topic_brands[3] == ["Notion"]
        assert payload.topics_source == "both"
        assert payload.missing_keys == []

    def test_prompt_asks_for_ten_and_carries_google_text_as_untrusted(self, google, claude):
        claude.responses = {"topic_generation": "[]"}
        _scan()
        call = next(c for c in claude.calls if c["role"] == "topic_generation")
        assert "Return 10 entries" in call["prompt"]
        assert "Related search: note taking app with offline sync for teams" in call["system_prompt"]
        assert "UNTRUSTED" in call["system_prompt"]

    def test_failed_claude_falls_back_to_google_text(self, google, claude):
        claude.responses = {"topic_generation": ProviderResult(succeeded=False, error="x")}
        payload = _scan()
        assert payload.topics
        assert set(payload.topic_sources) == {"search"}
        assert payload.topics_source == "search"

    def test_claude_without_google_is_ai(self, settings, claude):
        settings.SCRAPERAPI_KEY = ""
        claude.responses = {"topic_generation": json.dumps([
            {"topic": "best note taking app for remote teams", "brands": ["Notion"],
             "source": "question", "from": "best note taking app for remote teams"},
        ] + [{"topic": f"how to organise team notes number {i}", "brands": []}
             for i in range(12)])}
        payload = _scan()
        assert len(payload.topics) == 10
        assert set(payload.topic_sources) == {"ai"}
        assert payload.topics_source == "ai"


def test_payload_dict_carries_sources(google):
    data = to_dict(_scan())
    for key in ("competitors_source", "topic_sources", "topic_evidence", "google"):
        assert key in data
    assert set(data["competitors"][0]) == {"name", "domain", "source", "evidence"}


# -- filters ----------------------------------------------------------------------


@pytest.mark.parametrize("host", [
    "g2.com", "www.capterra.com", "reddit.com", "old.reddit.com", "google.com",
    "google.co.uk", "maps.google.com", "play.google.com", "apps.apple.com", "zapier.com",
])
def test_aggregators(host):
    assert is_aggregator(host)


@pytest.mark.parametrize("host", ["dropbox.com", "wix.com", "notion.com", "netflix.com",
                                  "apple.com", "mygoogle.com"])
def test_not_aggregators(host):
    assert not is_aggregator(host)


class TestLegacyFilter:
    def test_suffix_match_keeps_dropbox_and_wix(self):
        for link, name in (("https://www.dropbox.com/", "Dropbox"), ("https://wix.com/", "Wix")):
            got = competitor_discovery._extract_competitor(
                {"link": link, "title": f"{name} - Website builder"}, "acme.com", "Acme")
            assert got == {"name": name, "domain": link.split("/")[2].removeprefix("www.")}

    def test_own_domain_by_suffix(self):
        assert competitor_discovery._extract_competitor(
            {"link": "https://app.acme.com/", "title": "Acme app"}, "acme.com", "Other") is None
        assert competitor_discovery._extract_competitor(
            {"link": "https://notacme.com/", "title": "NotAcme"}, "acme.com", "Other") == {
            "name": "NotAcme", "domain": "notacme.com"}

    @pytest.mark.parametrize("link", ["https://x.com/acme", "https://www.g2.com/p",
                                      "https://facebook.com/a"])
    def test_skips_social_and_directories(self, link):
        assert competitor_discovery._extract_competitor(
            {"link": link, "title": "Something"}, "acme.com", "Acme") is None

