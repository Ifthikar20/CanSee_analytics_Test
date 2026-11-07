"""Pages (p2 backend 6, contract 6): page keys, each of the five sources,
null versus measured zero per source state, crawler paths outside the top
50, retrieved but never cited, filters, sorting and ``page_row``. The AI
traffic helpers are stubbed; nothing reaches GA4, Cloudflare or Google."""

from datetime import timedelta
from urllib.parse import urlsplit

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.citations.models import Citation, SourceClass
from apps.citations.services.url_normalizer import normalize_url
from apps.insights.models import InsightRun, SiteAudit, SiteAuditPage
from apps.insights.services import pages, site_audit
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services._hash import text_hash
from apps.search_gap.models import GoogleRankCheck
from apps.web_analytics.services import ai_crawlers
from apps.web_analytics.services.ai_traffic import ai_landing_pages as real_landing_pages
from apps.web_analytics.services.ai_traffic import crawler_paths as real_crawler_paths
from apps.websites.models import Website
from core.exceptions import CanseeException

pytestmark = pytest.mark.django_db

SITE = "https://www.notes-fixture.example"
HOST = "notes-fixture.example"
GOOD = dict.fromkeys(site_audit.CHECK_KEYS, True)


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Fixture Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url=SITE, name="Fixture Notes",
                                  competitors=[{"name": "Alpha", "domain": "alpha.example"}])


@pytest.fixture(autouse=True)
def traffic(monkeypatch):
    """AI visits and crawler paths as each test sets them (both off by default)."""
    state = {
        "visits": {"source": None, "source_label": None, "available": False,
                   "reason": "no_source", "pages": []},
        "crawlers": {"available": False, "reason": "no_cloudflare", "window_days": 7, "paths": []},
    }
    monkeypatch.setattr("apps.web_analytics.services.ai_traffic.ai_landing_pages",
                        lambda website, **kw: state["visits"])
    monkeypatch.setattr("apps.web_analytics.services.ai_traffic.crawler_paths",
                        lambda website: state["crawlers"])
    return state


@pytest.fixture
def google_on(settings):
    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = "scraper-test"
    return settings


def track(website, text: str, location: str = "us") -> BrandPrompt:
    industry, _ = Industry.objects.get_or_create(
        slug="fixture-notes", defaults={"name": "Notes (fixture)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, text_hash=text_hash(text),
        intent_bucket="category", style="question", source=PromptSource.MANUAL,
    )
    return BrandPrompt.objects.create(website=website, prompt=prompt, location=location)


def answer(bp, engine: str = "gpt4", days_ago: int = 1) -> LLMRankingResult:
    audit = LLMRankingAudit.objects.create(
        website=bp.website, created_by=bp.website.user, status=LLMRankingAudit.STATUS_COMPLETED,
        prompts=[bp.prompt.text], business_name="Fixture Notes", providers_queried=[engine],
    )
    result = LLMRankingResult.objects.create(
        audit=audit, provider=engine, prompt=bp.prompt.text, response_text="An answer.",
        source_prompt=bp.prompt, query_succeeded=True,
    )
    when = timezone.now() - timedelta(days=days_ago)
    LLMRankingResult.objects.filter(id=result.id).update(created_at=when)
    result.created_at = when
    return result


def cite(result, url: str, *, references: int = 0, target: bool = False) -> Citation:
    normalized, host, apex = normalize_url(url)
    return Citation.objects.create(
        result=result, audit=result.audit, url=url, normalized_url=normalized, domain=host,
        apex_domain=apex, source_class=SourceClass.OTHER, reference_count=references,
        is_target=target,
    )


def _row(position: int, url: str) -> dict:
    host = urlsplit(url).hostname or ""
    return {"position": position, "url": url, "title": "",
            "domain": host[4:] if host.startswith("www.") else host}


def check(bp, *, position=None, url="", top=(), error="", days_ago=1) -> GoogleRankCheck:
    return GoogleRankCheck.objects.create(
        website=bp.website, brand_prompt=bp, query=bp.prompt.text, location=bp.location,
        depth=10, position=position, url=url, top_results=[_row(p, u) for p, u in top],
        error=error, checked_at=timezone.now() - timedelta(days=days_ago),
    )


def audit(website, rows, *, days_ago: int = 0) -> SiteAudit:
    run = InsightRun.objects.create(website=website, kind="site_audit", status="done")
    found = SiteAudit.objects.create(
        run=run, website=website, brand_key="you", domain=HOST, home_url=SITE,
        summary={"pages": len(rows)}, audited_at=timezone.now() - timedelta(days=days_ago),
    )
    for url, checks, words in rows:
        measured = [v for v in checks.values() if v is not None]
        SiteAuditPage.objects.create(audit=found, url=url, final_url=url, status_code=200,
                                     checks=checks, passed=sum(measured), total=len(measured),
                                     words=words)
    return found


def by_path(payload) -> dict:
    return {row["path"]: row for row in payload["pages"]}


# ── keys ──────────────────────────────────────────────────────────────────


def test_page_keys_ignore_www_trailing_slashes_queries_and_fragments():
    assert pages.page_key("https://www.notes-fixture.example/pricing/?a=1#x", HOST) == (
        "notes-fixture.example/pricing")
    assert pages.page_key("http://notes-fixture.example", HOST) == "notes-fixture.example/"
    assert pages.page_key("https://blog.notes-fixture.example/post", HOST) is None
    assert pages.page_key("mailto:hi@notes-fixture.example", HOST) is None
    assert pages.clean_path("/blog/?utm=1") == "/blog" and pages.clean_path("") == "/"


# ── sources ───────────────────────────────────────────────────────────────


def test_google_reads_each_prompts_latest_error_free_check(website, google_on):
    notes = track(website, "best note app")
    teams = track(website, "notes for teams")
    check(notes, position=9, url=f"{SITE}/old", top=[(9, f"{SITE}/old")], days_ago=5)
    check(notes, position=3, url=f"{SITE}/pricing", days_ago=2, top=[
        (1, "https://alpha.example/"), (3, f"{SITE}/pricing"), (5, "https://blog.notes-fixture.example/x"),
        (7, "https://notes-fixture.example/blog/"),
    ])
    check(notes, error="http_500", days_ago=1)
    check(teams, top=[(4, f"{SITE}/features")])
    check(teams, position=1, url=f"{SITE}/ancient", days_ago=130)

    payload = pages.build(website, period="30d", filter="all")

    assert payload["sources"]["google"] == {"state": "ok", "checked_prompts": 2}
    rows = by_path(payload)
    assert set(rows) == {"/pricing", "/blog", "/features"}
    assert rows["/pricing"]["google"] == {"best_position": 3, "prompts": [
        {"prompt_id": str(notes.prompt_id), "text": "best note app", "position": 3}]}
    assert rows["/blog"]["google"]["best_position"] == 7
    assert rows["/features"]["google"]["prompts"][0]["text"] == "notes for teams"
    assert rows["/pricing"]["url"] == f"{SITE}/pricing"
    assert payload["totals"]["ranking"] == 3


def test_google_states_leave_signals_null(website, google_on):
    bp = track(website, "best note app")

    assert pages.build(website)["sources"]["google"] == {"state": "no_checks", "checked_prompts": 0}

    check(bp, position=2, url=f"{SITE}/pricing")
    google_on.SCRAPERAPI_KEY = ""
    payload = pages.build(website)
    assert payload["sources"]["google"] == {"state": "not_configured", "checked_prompts": None}
    assert payload["pages"] == [] and payload["totals"]["ranking"] is None


def test_citations_on_your_site_in_the_window(website):
    bp = track(website, "best note app")
    chatgpt, claude, old = answer(bp, "gpt4"), answer(bp, "claude"), answer(bp, days_ago=40)
    cite(chatgpt, f"{SITE}/pricing", references=2)
    cite(claude, "https://notes-fixture.example/pricing/", references=0)
    cite(claude, f"{SITE}/guide", references=0)
    cite(chatgpt, "https://alpha.example/compare", references=3)
    cite(old, f"{SITE}/archive", references=1)

    payload = pages.build(website, period="30d")

    assert payload["sources"]["citations"] == {"state": "ok", "answers_with_sources": 2}
    rows = by_path(payload)
    assert set(rows) == {"/pricing", "/guide"}
    assert rows["/pricing"]["citations"] == {"citations": 2, "cited_in_text": 1, "answers": 2,
                                             "engines": ["chatgpt", "claude"]}
    assert rows["/guide"]["citations"] == {"citations": 1, "cited_in_text": 0, "answers": 1,
                                           "engines": ["claude"]}
    assert payload["totals"]["cited"] == 1 and payload["totals"]["retrieved_not_cited"] == 1
    assert [r["path"] for r in pages.build(website, filter="retrieved_not_cited")["pages"]] == [
        "/guide"]
    assert [r["path"] for r in pages.build(website, filter="cited")["pages"]] == ["/pricing"]


def test_no_citations_in_the_window_is_no_data(website):
    answer(track(website, "best note app"))

    payload = pages.build(website)

    assert payload["sources"]["citations"] == {"state": "no_data", "answers_with_sources": 0}
    assert payload["totals"]["cited"] is None


def test_ai_visits_and_crawler_requests(website, traffic):
    traffic["visits"] = {"source": "pixel", "source_label": "Cansee pixel", "available": True,
                         "reason": None, "pages": [
                             {"path": "/pricing", "sessions": 12,
                              "by_assistant": {"perplexity": 3, "chatgpt": 9}},
                             {"path": "/blog/", "sessions": 2, "by_assistant": {"claude": 2}},
                         ]}
    traffic["crawlers"] = {"available": True, "reason": None, "window_days": 7, "paths": [
        {"path": "/pricing", "requests": 40, "bots": ["gptbot"]},
        {"path": "/docs?x=1", "requests": 5, "bots": ["claudebot"]},
    ]}

    payload = pages.build(website)

    assert payload["sources"]["ai_visits"] == {"state": "ok", "source": "pixel",
                                               "source_label": "Cansee pixel"}
    assert payload["sources"]["crawlers"] == {"state": "ok", "window_days": 7}
    rows = by_path(payload)
    assert rows["/pricing"]["ai_visits"] == {"sessions": 12,
                                             "by_assistant": {"chatgpt": 9, "perplexity": 3}}
    assert rows["/pricing"]["crawler_requests"] == {"requests": 40, "state": "ok"}
    assert rows["/blog"]["crawler_requests"] == {"requests": None, "state": "not_in_top"}
    assert rows["/docs"]["ai_visits"] == {"sessions": 0, "by_assistant": {}}
    assert (payload["totals"]["ai_visits"], payload["totals"]["crawled"]) == (2, 2)
    assert [r["path"] for r in pages.build(website, filter="crawled")["pages"]] == [
        "/pricing", "/docs"]


def test_sources_that_are_off_give_null_signals(website, traffic):
    traffic["visits"] = {"source": "ga4", "source_label": "Google Analytics 4", "available": False,
                         "reason": "not_connected", "pages": []}
    audit(website, [(f"{SITE}/", GOOD, 300)])

    payload = pages.build(website)

    row = payload["pages"][0]
    assert payload["sources"]["ai_visits"]["state"] == "not_connected"
    assert payload["sources"]["crawlers"] == {"state": "no_cloudflare", "window_days": 7}
    assert (row["ai_visits"], row["crawler_requests"], row["google"]) == (None, None, None)
    assert row["citations"] is None
    assert payload["totals"] == {"pages": 1, "ranking": None, "cited": None,
                                 "retrieved_not_cited": None, "ai_visits": None, "crawled": None,
                                 "audited": 1}


def test_the_latest_own_audit(website, traffic):
    traffic["visits"] = {"source": "pixel", "source_label": "Cansee pixel", "available": True,
                         "reason": None, "pages": [{"path": "/blog", "sessions": 1,
                                                    "by_assistant": {"chatgpt": 1}}]}
    audit(website, [(f"{SITE}/pricing", GOOD, 500)], days_ago=3)
    latest = audit(website, [
        (f"{SITE}/pricing", {**GOOD, "meta_description": False, "text_without_js": False}, 90),
    ])

    payload = pages.build(website)

    rows = by_path(payload)
    assert payload["sources"]["audit"] == {"state": "ok",
                                           "audited_at": rows["/pricing"]["audit"]["audited_at"]}
    assert rows["/pricing"]["audit"] == {
        "passed": 7, "total": 9, "failed": ["meta_description", "text_without_js"],
        "audited_at": rows["/pricing"]["audit"]["audited_at"]}
    assert rows["/pricing"]["audit"]["audited_at"].startswith(latest.audited_at.date().isoformat())
    assert rows["/blog"]["audit"] == {"passed": None, "total": None, "state": "not_audited"}
    assert [r["path"] for r in pages.build(website, filter="failing_checks")["pages"]] == [
        "/pricing"]


def test_without_an_audit_the_audit_signal_is_null(website, traffic):
    traffic["visits"] = {"source": "pixel", "source_label": "Cansee pixel", "available": True,
                         "reason": None, "pages": [{"path": "/", "sessions": 3,
                                                    "by_assistant": {"chatgpt": 3}}]}

    payload = pages.build(website)

    assert payload["sources"]["audit"] == {"state": "not_run", "audited_at": None}
    assert payload["pages"][0]["audit"] is None and payload["totals"]["audited"] is None


# ── rows ──────────────────────────────────────────────────────────────────


def test_rows_sort_by_signals_then_citations_and_cap(website, traffic, google_on):
    bp = track(website, "best note app")
    check(bp, position=2, url=f"{SITE}/pricing")
    result = answer(bp)
    cite(result, f"{SITE}/pricing", references=1)
    cite(result, f"{SITE}/a", references=1)
    for _ in range(3):
        cite(answer(bp), f"{SITE}/b", references=0)
    traffic["visits"] = {"source": "pixel", "source_label": "Cansee pixel", "available": True,
                         "reason": None, "pages": [
                             {"path": f"/v{i}", "sessions": 1, "by_assistant": {"chatgpt": 1}}
                             for i in range(205)
                         ]}

    payload = pages.build(website)

    assert payload["totals"]["pages"] == 208
    assert len(payload["pages"]) == pages.MAX_ROWS
    assert [r["path"] for r in payload["pages"][:3]] == ["/pricing", "/b", "/a"]
    assert payload["pages"][0]["signals"] == 2
    assert payload["window"]["period"] == "30d" and payload["filter"] == "all"


def test_an_unknown_filter_is_invalid(website):
    with pytest.raises(CanseeException) as err:
        pages.build(website, filter="everything")
    assert (err.value.code, err.value.status_code, err.value.details["field"]) == (
        "invalid", 400, "filter")


def test_no_pages_seen_yet(website):
    payload = pages.build(website)

    assert payload["pages"] == [] and payload["totals"]["pages"] == 0
    assert set(payload["sources"]) == {"google", "citations", "ai_visits", "crawlers", "audit"}


def test_page_row_carries_the_sources_and_the_dates_writers_need(website, google_on):
    bp = track(website, "best note app")
    made = check(bp, position=4, url=f"{SITE}/pricing")
    audit(website, [(f"{SITE}/pricing", {**GOOD, "text_without_js": False}, 80)])

    row = pages.page_row(website, "https://notes-fixture.example/pricing/")

    assert row["path"] == "/pricing" and row["signals"] == 2
    assert row["google"]["prompts"][0]["checked_at"].startswith(
        made.checked_at.date().isoformat())
    assert row["audit"]["words"] == 80 and row["audit"]["failed"] == ["text_without_js"]
    assert row["sources"]["google"]["state"] == "ok"
    assert pages.page_row(website, f"{SITE}/nowhere") is None
    assert pages.page_row(website, "https://alpha.example/pricing") is None


def test_known_urls_name_every_page_with_its_signals(website, traffic):
    traffic["crawlers"] = {"available": True, "reason": None, "window_days": 7,
                           "paths": [{"path": "/docs", "requests": 2, "bots": []}]}

    known = pages.known_urls(website)

    assert list(known) == ["notes-fixture.example/docs"]
    assert known["notes-fixture.example/docs"].signal_count() == 1
    assert known["notes-fixture.example/docs"].url == f"{SITE}/docs"


# ── the wave 1 helpers pages reads ────────────────────────────────────────


def visit(website, path: str, *, source: str, medium: str = "ai"):
    import uuid

    from apps.analytics.models import PageEvent, Session, Visitor

    when = timezone.now() - timedelta(days=1)
    person = Visitor.objects.create(website=website, fingerprint_hash=uuid.uuid4().hex)
    PageEvent.objects.create(visitor=person, website=website, url=f"{SITE}{path}",
                             event_type="pageview", timestamp=when)
    Session.objects.create(visitor=person, started_at=when, source=source, medium=medium,
                           entry_page=f"{SITE}{path}", page_count=1)


def test_ai_landing_pages_has_no_top_ten_cut(website):
    from django.core.cache import cache

    cache.clear()
    for i in range(12):
        visit(website, f"/p{i}", source="chatgpt")
    visit(website, "/p0?utm_source=perplexity", source="perplexity")
    visit(website, "/", source="google", medium="organic")

    found = real_landing_pages(website, period="30d")

    assert (found["source"], found["source_label"], found["available"], found["reason"]) == (
        "pixel", "Cansee pixel", True, None)
    assert len(found["pages"]) == 12
    assert found["pages"][0] == {"path": "/p0", "sessions": 2,
                                 "by_assistant": {"chatgpt": 1, "perplexity": 1}}
    assert real_landing_pages(website, period="30d", limit=3)["pages"][-1]["path"] == "/p10"


def test_crawler_paths_without_cloudflare(website):
    found = real_crawler_paths(website)

    assert (found["available"], found["reason"], found["paths"]) == (False, "no_cloudflare", [])
    assert ai_crawlers.MAX_PATHS == 50
