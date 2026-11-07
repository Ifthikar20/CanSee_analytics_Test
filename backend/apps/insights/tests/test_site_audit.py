"""The crawler access audit (p2 backend 5d): page planning, every check,
robots.txt verdicts per bot, the run with competitor home pages, its caps,
Stop, and the Crawler access payload. ``safe_get`` (robots.txt, llms.txt)
and ``fetch_page`` are replaced; nothing reaches the network."""

from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone

from apps.agent.services import browse
from apps.insights.models import InsightRun, SiteAudit, SiteAuditPage
from apps.insights.services import llms_txt, pages, robots, runs, site_audit
from apps.insights.services.pages import PageSignals
from apps.websites.models import Website
from core.exceptions import CanseeException
from core.validators.safe_http import FetchError

pytestmark = pytest.mark.django_db

SITE = "https://www.notes-fixture.example"
COMPETITORS = [
    {"name": "Alpha Notes", "domain": "alpha-notes.example"},
    {"name": "No Domain", "domain": ""},
    {"name": "Beta Notes", "domain": "https://www.beta-notes.example/"},
]
FREE = {"ai_calls": 0, "ai_usd_max": "0.0000", "google_pages": 0}
LLMS = "# Fixture Notes\n## Docs\n- [Guide](https://notes-fixture.example/guide)\n"


@pytest.fixture(autouse=True)
def fresh(settings, monkeypatch):
    cache.clear()
    settings.SITE_AUDIT_MAX_PAGES = 20
    settings.SITE_AUDIT_MIN_WORDS = 150
    monkeypatch.setattr(runs, "CANCEL_POLL_SECONDS", 0)
    monkeypatch.setattr(site_audit, "BUSY_RETRY_SECONDS", 0)
    yield
    cache.clear()


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Fixture Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url=SITE, name="Fixture Notes",
                                  competitors=COMPETITORS)


def page(url: str, *, status=200, title="Fixture Notes", description="Notes for teams.",
         h1=("Write it down",), words=400, types=("Organization",), canonical="auto",
         meta_robots=None, x_robots="", links=(), error=None) -> dict:
    """A fetch_page result."""
    if error:
        return {"url": url, "final_url": url, "status_code": None, "seo": None, "reader": None,
                "error": {"code": error, "message": "x"},
                "headers": {"x-robots-tag": "", "content-type": ""}, "links": []}
    seo = {"title": title, "meta_description": description, "robots": meta_robots,
           "canonical": url if canonical == "auto" else canonical, "h1": list(h1),
           "word_count": words, "structured_data": list(types)}
    return {"url": url, "final_url": url, "status_code": status, "seo": seo, "reader": {},
            "error": None, "headers": {"x-robots-tag": x_robots, "content-type": "text/html"},
            "links": [{"url": link, "text": ""} for link in links]}


def rules(text=None, state="found") -> site_audit.RobotsRules:
    parsed = robots.parse(text) if text is not None else None
    return site_audit.RobotsRules(robots.Fetched({"state": state}, parsed, text or ""))


ALLOW_ALL = "User-agent: *\nAllow: /\n"


# ── checks ────────────────────────────────────────────────────────────────


def test_a_good_page_passes_every_check():
    fields = site_audit.page_fields(page(f"{SITE}/pricing"), f"{SITE}/pricing", rules(ALLOW_ALL))

    assert fields["checks"] == dict.fromkeys(site_audit.CHECK_KEYS, True)
    assert (fields["passed"], fields["total"], fields["words"]) == (9, 9, 400)
    assert (fields["noindex_source"], fields["blocked_bots"], fields["error_code"]) == ("", [], "")
    assert fields["jsonld_types"] == ["Organization"]


@pytest.mark.parametrize("override, check", [
    ({"title": None}, "title"),
    ({"description": None}, "meta_description"),
    ({"h1": ()}, "h1"),
    ({"words": 149}, "text_without_js"),
    ({"types": ()}, "structured_data"),
    ({"canonical": None}, "canonical"),
    ({"meta_robots": "NoIndex, follow"}, "indexable"),
    ({"meta_robots": "none"}, "indexable"),
    ({"x_robots": "noindex"}, "indexable"),
    ({"x_robots": "GPTBot: noindex, nofollow"}, "indexable"),
])
def test_each_check_fails_on_its_own(override, check):
    fields = site_audit.page_fields(page(f"{SITE}/a", **override), f"{SITE}/a", rules(ALLOW_ALL))

    failed = [key for key, value in fields["checks"].items() if value is False]
    assert failed == [check]
    assert (fields["passed"], fields["total"]) == (8, 9)


def test_noindex_says_where_it_came_from():
    meta = site_audit.page_fields(page("https://x.example/", meta_robots="noindex"),
                                  "https://x.example/", rules(ALLOW_ALL))
    header = site_audit.page_fields(page("https://x.example/", x_robots="googlebot: noindex"),
                                    "https://x.example/", rules(ALLOW_ALL))

    assert (meta["noindex_source"], header["noindex_source"]) == ("meta", "header")


@pytest.mark.parametrize("value", [
    "otherbot: noindex", "unavailable_after: 25 Jun 2030 15:00:00 PST", "max-snippet: -1",
    "nofollow", "",
])
def test_x_robots_tag_values_that_do_not_apply(value):
    assert not site_audit.header_noindex(value)


def test_a_page_that_did_not_load_checks_nothing_else():
    missing = site_audit.page_fields(page(f"{SITE}/gone", status=404), f"{SITE}/gone",
                                     rules(ALLOW_ALL))
    failed = site_audit.page_fields(page(f"{SITE}/slow", error="timeout"), f"{SITE}/slow",
                                    rules(ALLOW_ALL))

    for fields in (missing, failed):
        assert fields["checks"]["status_ok"] is False
        assert all(fields["checks"][k] is None for k in site_audit.CHECK_KEYS[1:])
        assert (fields["passed"], fields["total"], fields["words"]) == (0, 1, None)
    assert (missing["status_code"], missing["error_code"]) == (404, "")
    assert failed["error_code"] == "timeout"
    assert site_audit.public_error("timeout") == {"code": "timeout",
                                                  "message": "The page took too long to load."}
    assert site_audit.public_error("too_large")["code"] == "fetch_failed"
    assert site_audit.public_error("") is None


# ── robots.txt verdicts ───────────────────────────────────────────────────


def test_robots_rules_decide_each_bot_and_the_search_bots_check():
    text = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /private\n"
    found = rules(text)

    private = site_audit.page_fields(page(f"{SITE}/private/x"), f"{SITE}/private/x", found)
    home = site_audit.page_fields(page(f"{SITE}/"), f"{SITE}/", found)

    assert private["blocked_bots"] == ["gptbot", "perplexitybot"]
    assert private["checks"]["ai_search_allowed"] is False
    assert home["blocked_bots"] == ["gptbot"]
    assert home["checks"]["ai_search_allowed"] is True

    rows = [SimpleNamespace(blocked_bots=private["blocked_bots"]),
            SimpleNamespace(blocked_bots=home["blocked_bots"])]
    bots = {b["key"]: b for b in found.bots(f"{SITE}/", rows)}
    assert bots["gptbot"] == {"key": "gptbot", "home": "blocked", "group": "GPTBot",
                              "rule": "Disallow: /", "pages_blocked": 2}
    assert bots["perplexitybot"] == {"key": "perplexitybot", "home": "allowed",
                                     "group": "PerplexityBot", "rule": None, "pages_blocked": 1}
    assert bots["claudebot"] == {"key": "claudebot", "home": "allowed", "group": None,
                                 "rule": None, "pages_blocked": 0}


def test_an_unreachable_robots_txt_blocks_every_bot():
    down = rules(state="unreachable")

    fields = site_audit.page_fields(page(f"{SITE}/"), f"{SITE}/", down)

    assert fields["blocked_bots"] == list(site_audit.BOT_KEYS)
    assert fields["checks"]["ai_search_allowed"] is False
    rows = [SimpleNamespace(blocked_bots=fields["blocked_bots"])] * 3
    assert {b["home"] for b in down.bots(f"{SITE}/", rows)} == {"blocked_unreachable"}
    assert {b["pages_blocked"] for b in down.bots(f"{SITE}/", rows)} == {3}


def test_a_missing_robots_txt_allows_every_bot():
    missing = rules(state="missing")

    fields = site_audit.page_fields(page(f"{SITE}/"), f"{SITE}/", missing)

    assert fields["blocked_bots"] == [] and fields["checks"]["ai_search_allowed"] is True
    assert {(b["home"], b["pages_blocked"]) for b in missing.bots(f"{SITE}/", [])} == {
        ("allowed", 0)}


def test_robots_txt_cansee_could_not_fetch_is_unknown():
    unknown = rules(state="failed")

    fields = site_audit.page_fields(page(f"{SITE}/"), f"{SITE}/", unknown)

    assert fields["checks"]["ai_search_allowed"] is None
    assert (fields["passed"], fields["total"]) == (8, 8)
    assert {(b["home"], b["pages_blocked"]) for b in unknown.bots(f"{SITE}/", [])} == {
        ("unknown", None)}


# ── planning ──────────────────────────────────────────────────────────────


def signals(website, path: str, **values) -> PageSignals:
    host = pages.site_host(website)
    return PageSignals(key=host + path, path=path, url=f"{SITE}{path}", **values)


def test_own_pages_are_the_home_page_then_known_pages_by_signals(website, monkeypatch):
    known = {
        s.key: s for s in (
            signals(website, "/blog", citations=2),
            signals(website, "/pricing", citations=3, sessions=4, google={"p": {"position": 3}}),
            signals(website, "/", citations=9),
            signals(website, "/about", sessions=1),
            signals(website, "/careers", sessions=1),
            signals(website, "/docs", requests=5),
        )
    }
    monkeypatch.setattr(pages, "known_urls", lambda website, **kw: known)

    plan = site_audit.validate(website, {"competitors": True})

    assert plan.pages == [SITE, f"{SITE}/pricing", f"{SITE}/about", f"{SITE}/blog",
                          f"{SITE}/careers", f"{SITE}/docs"]
    assert plan.pages_max == 6 and not plan.more_from_links
    assert [(b.key, b.domain) for b in plan.competitors] == [
        ("b1", "alpha-notes.example"), ("b3", "beta-notes.example")]
    assert site_audit.plan_items(None, plan) == 8


def test_with_few_known_pages_the_home_page_links_fill_the_plan(website, monkeypatch, settings):
    settings.SITE_AUDIT_MAX_PAGES = 5
    monkeypatch.setattr(pages, "known_urls", lambda website, **kw: {})

    plan = site_audit.validate(website, {"competitors": False})
    links = [
        {"url": f"{SITE}/pricing"}, {"url": "https://notes-fixture.example/about"},
        {"url": f"{SITE}/pricing"}, {"url": f"{SITE}/search?q=x"}, {"url": f"{SITE}/guide.pdf"},
        {"url": "https://blog.notes-fixture.example/post"}, {"url": "https://other.example/"},
        {"url": f"{SITE}/terms.html"}, {"url": f"{SITE}/"}, {"url": f"{SITE}/a"},
        {"url": f"{SITE}/b"},
    ]

    assert plan.pages == [SITE] and plan.more_from_links and plan.pages_max == 5
    assert site_audit.links_to_add(links, plan.pages, "notes-fixture.example") == [
        f"{SITE}/pricing", "https://notes-fixture.example/about", f"{SITE}/terms.html",
        f"{SITE}/a"]


def test_validate_rejects_a_non_boolean_competitors_flag(website):
    with pytest.raises(CanseeException) as err:
        site_audit.validate(website, {"competitors": "yes"})
    assert (err.value.code, err.value.details["field"]) == ("invalid", "competitors")


# ── the run ───────────────────────────────────────────────────────────────


@pytest.fixture
def web(monkeypatch):
    """A fake web: robots.txt and llms.txt by host, pages by URL."""
    state = SimpleNamespace(robots={}, llms={}, pages={}, fetched=[], on_fetch=None)

    def safe_get(url, **kwargs):
        host = url.split("/")[2]
        files = state.robots if url.endswith("/robots.txt") else state.llms
        answer = files.get(host, (404, ""))
        if url.endswith("/llms-full.txt"):
            answer = (404, "")
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        return SimpleNamespace(status_code=status, content=body.encode(), content_type="text/plain",
                               headers={}, final_url=url)

    def fetch_page(url, *, with_headers=False, with_links=False):
        state.fetched.append(url)
        if state.on_fetch is not None:
            state.on_fetch(url)
        return state.pages.get(url) or page(url)

    monkeypatch.setattr(robots, "safe_get", safe_get)
    monkeypatch.setattr(llms_txt, "safe_get", safe_get)
    monkeypatch.setattr(browse, "fetch_page", fetch_page)
    return state


def start(website, user, params=None):
    return runs.create_run(website, user, "site_audit", params or {"competitors": True}, FREE)


def test_a_run_audits_own_pages_and_each_competitor_home_page(website, user, web):
    web.robots["www.notes-fixture.example"] = (200, "User-agent: GPTBot\nDisallow: /private\n")
    web.llms["www.notes-fixture.example"] = (200, LLMS)
    web.robots["alpha-notes.example"] = (503, "")
    web.pages[SITE] = page(SITE, links=[f"{SITE}/pricing", f"{SITE}/private/plan"])
    web.pages[f"{SITE}/pricing"] = page(f"{SITE}/pricing", words=90)

    run = start(website, user)

    assert run.status == "done", run.error_message
    assert (run.units_total, run.units_done, run.units_failed) == (5, 5, 0)
    assert web.fetched == [SITE, f"{SITE}/pricing", f"{SITE}/private/plan",
                           "https://alpha-notes.example/", "https://www.beta-notes.example/"]
    own = SiteAudit.objects.get(run=run, brand_key="you")
    assert own.robots["state"] == "found" and own.llms_txt["state"] == "found"
    assert own.summary["pages"] == 3 and own.summary["by_check"]["text_without_js"] == {
        "passed": 2, "failed": 1, "not_checked": 0}
    gptbot = next(b for b in own.bots if b["key"] == "gptbot")
    assert (gptbot["home"], gptbot["pages_blocked"]) == ("allowed", 1)
    alpha = SiteAudit.objects.get(run=run, domain="alpha-notes.example")
    assert alpha.robots["state"] == "unreachable" and alpha.pages.count() == 1
    assert alpha.pages.get().blocked_bots == list(site_audit.BOT_KEYS)
    assert run.estimate["fetches"]["pages_max"] == 20 + 2 + 9
    assert run.summary == "20 pages of notes-fixture.example and 2 competitor home pages"


def test_a_page_that_fails_to_load_makes_the_run_partial(website, user, web):
    web.pages[SITE] = page(SITE, links=[f"{SITE}/slow"])
    web.pages[f"{SITE}/slow"] = page(f"{SITE}/slow", error="timeout")

    run = start(website, user, {"competitors": False})

    assert run.status == "partial"
    assert (run.units_total, run.units_done, run.units_failed) == (2, 1, 1)
    slow = SiteAuditPage.objects.get(url=f"{SITE}/slow")
    assert slow.error_code == "timeout" and slow.checks["status_ok"] is False


def test_a_busy_parser_is_retried_once(website, user, web, monkeypatch):
    answers = iter([page(SITE, error="busy"), page(SITE)])

    def fetch_page(url, *, with_headers=False, with_links=False):
        web.fetched.append(url)
        return next(answers)

    monkeypatch.setattr(browse, "fetch_page", fetch_page)

    run = start(website, user, {"competitors": False})

    assert web.fetched == [SITE, SITE]
    assert run.units_done == 1 and SiteAuditPage.objects.get(audit__run=run).error_code == ""


def test_cooldown_and_daily_runs_block_another_audit(website, user, web, settings):
    run = start(website, user, {"competitors": False})
    assert run.status == "done"

    est = runs.estimate(website, user, "site_audit", {"competitors": False})
    assert [b["code"] for b in est["blockers"]] == ["cooldown"]
    assert est["blockers"][0]["message"].startswith("An audit ran 1 minutes ago. Run it again after ")
    assert est["can_run"] is False
    with pytest.raises(CanseeException) as err:
        start(website, user, {"competitors": False})
    assert (err.value.code, err.value.status_code) == ("cooldown", 409)

    SiteAudit.objects.update(audited_at=timezone.now() - timedelta(minutes=11))
    settings.SITE_AUDIT_DAILY_RUNS = 1
    est = runs.estimate(website, user, "site_audit", {"competitors": False})
    assert [b["code"] for b in est["blockers"]] == ["daily_runs"]
    assert est["blockers"][0]["message"] == "This project ran 1 audits today; the limit is 1."


def test_stop_ends_the_remaining_pages(website, user, web):
    links = [f"{SITE}/p{i}" for i in range(6)]
    web.pages[SITE] = page(SITE, links=links)

    def stop_after_two(url):
        if len(web.fetched) == 2:
            InsightRun.objects.update(cancel_requested=True)

    web.on_fetch = stop_after_two

    run = start(website, user)

    assert run.status == "cancelled"
    assert web.fetched == [SITE, f"{SITE}/p0"]
    assert (run.units_done, run.units_cancelled) == (2, run.units_total - 2)
    # The audit of what was read is complete; competitors were never started.
    own = SiteAudit.objects.get(run=run)
    assert own.summary["pages"] == 2
    assert not SiteAudit.objects.exclude(brand_key="you").exists()


def test_the_estimate_is_free(website, user, web):
    est = runs.estimate(website, user, "site_audit", {"competitors": True})

    assert est["confirm"] == {"ai_calls": 0, "ai_usd_max": "0.0000", "google_pages": 0}
    assert est["units"] == {"pages": 20, "competitors": 2}
    assert [w["code"] for w in est["warnings"]] == []
    options = runs.options(website, user, "site_audit")
    assert options["choices"] == {
        "domain": "notes-fixture.example",
        "competitors": [{"key": "b1", "name": "Alpha Notes", "domain": "alpha-notes.example"},
                        {"key": "b3", "name": "Beta Notes", "domain": "beta-notes.example"}],
        "pages_planned": 20, "cooldown_until": None,
    }


# ── presenters ────────────────────────────────────────────────────────────


def test_crawler_access_shows_your_audit_and_competitors_by_apex(website, user, web):
    web.robots["www.notes-fixture.example"] = (200, "User-agent: *\nDisallow: /admin\n")
    web.pages[SITE] = page(SITE, links=[f"{SITE}/pricing"])
    run = start(website, user)

    # The list changes after the audit: keys follow the current list.
    website.competitors = [{"name": "Beta Notes", "domain": "beta-notes.example"},
                           {"name": "Gamma Notes", "domain": "gamma-notes.example"}]
    website.save(update_fields=["competitors"])
    payload = site_audit.crawler_access(website)

    assert [b["key"] for b in payload["bots"]][:3] == ["gptbot", "oai-searchbot", "chatgpt-user"]
    assert payload["bots"][0] == {"key": "gptbot", "token": "GPTBot", "operator": "OpenAI",
                                  "purpose": "training", "purpose_label": "Model training",
                                  "robots": "yes"}
    checks = {c["key"]: c for c in payload["checks"]}
    assert checks["status_ok"]["rule"] == "The final response status is 200-299."
    assert checks["text_without_js"]["rule"] == (
        "At least 150 words are in the HTML before any script runs.")
    you = payload["you"]
    assert (you["brand_key"], you["name"], you["domain"], you["run_id"]) == (
        "you", "Fixture Notes", "notes-fixture.example", str(run.id))
    assert you["robots"]["state"] == "found" and you["llms_txt"]["state"] == "missing"
    assert [p["url"] for p in you["pages"]] == [SITE, f"{SITE}/pricing"]
    assert you["pages"][0]["error"] is None and you["pages"][0]["noindex_source"] is None
    assert [(c["brand_key"], c["name"], c["domain"]) for c in payload["competitors"]] == [
        ("b1", "Beta Notes", "beta-notes.example")]
    assert len(payload["competitors"][0]["pages"]) == 1
    assert payload["active_run"] is None and payload["last_run"]["id"] == str(run.id)

    assert site_audit.latest_own_pages(website) == [
        {"url": SITE, "final_url": SITE, "title": "Fixture Notes", "status_code": 200,
         "passed": 9, "total": 9},
        {"url": f"{SITE}/pricing", "final_url": f"{SITE}/pricing", "title": "Fixture Notes",
         "status_code": 200, "passed": 9, "total": 9},
    ]


def test_before_the_first_audit(website):
    payload = site_audit.crawler_access(website)

    assert (payload["you"], payload["competitors"], payload["last_run"]) == (None, [], None)
    assert site_audit.latest_own_pages(website) == []


def test_an_unfinished_audit_is_not_shown(website, user):
    run = InsightRun.objects.create(website=website, kind="site_audit", status="running")
    SiteAudit.objects.create(run=run, website=website, brand_key="you",
                             domain="notes-fixture.example", home_url=SITE, summary={})

    assert site_audit.latest_own_audit(website) is None


def test_an_audit_of_another_domain_is_not_yours(website):
    run = InsightRun.objects.create(website=website, kind="site_audit", status="done")
    SiteAudit.objects.create(run=run, website=website, brand_key="you", domain="old-site.example",
                             home_url="https://old-site.example/", summary={"pages": 0})

    assert site_audit.latest_own_audit(website) is None


def test_fetch_errors_reach_the_audit_as_their_state(website, user, web):
    web.robots["www.notes-fixture.example"] = FetchError("unsafe URL", code="blocked_url")

    run = start(website, user, {"competitors": False})

    own = SiteAudit.objects.get(run=run)
    assert own.robots["state"] == "failed"
    assert {b["home"] for b in own.bots} == {"unknown"}
    assert own.pages.get().checks["ai_search_allowed"] is None
