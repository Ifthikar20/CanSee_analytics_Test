"""Defects found in the wave 2 review, each pinned by a test that failed
before its fix: robots.txt grouping, llms.txt parsing time on a hostile
file, Stop racing a worker's start, and the work a page payload does."""

import re
import time
from datetime import timedelta

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.insights.models import InsightRun, SiteAudit, SiteAuditPage
from apps.insights.services import competitors, llms_txt, robots, runs, site_audit
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import fake_kind

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def allowed(text: str, token: str, path: str) -> bool:
    _agents, rules = robots.rules_for(robots.parse(text), token)
    return robots.is_allowed(rules, path)[0]


# -- robots.txt: an empty rule still ends the group's user-agent lines ------------------


def test_an_empty_disallow_ends_its_group_so_the_next_user_agent_starts_another():
    # The common "let this bot read everything, keep the rest out" file.
    text = "User-agent: Googlebot\nDisallow:\n\nUser-agent: *\nDisallow: /\n"

    parsed = robots.parse(text)

    assert [g.agents for g in parsed.groups] == [["Googlebot"], ["*"]]
    assert allowed(text, "Googlebot", "/") and allowed(text, "Googlebot", "/pricing")
    assert not allowed(text, "GPTBot", "/")
    assert robots.rules_for(parsed, "Googlebot") == (["Googlebot"], [])


def test_an_empty_allow_ends_its_group_too():
    text = "User-agent: GPTBot\nAllow:\nUser-agent: ClaudeBot\nDisallow: /\n"

    assert allowed(text, "GPTBot", "/")
    assert not allowed(text, "ClaudeBot", "/")


def test_the_audit_reads_the_empty_disallow_as_allowing_the_bot():
    text = "User-agent: GPTBot\nDisallow:\n\nUser-agent: *\nDisallow: /\n"
    parsed = robots.parse(text)
    rules = site_audit.RobotsRules(
        robots.Fetched(robots._info(robots.FOUND, "https://x.example/robots.txt", 200, parsed,
                                    len(text)), parsed, text))

    blocked = rules.blocked("https://x.example/pricing")

    assert "gptbot" not in blocked and "claudebot" in blocked
    home = {b["key"]: b["home"] for b in rules.bots("https://x.example/", [])}
    assert (home["gptbot"], home["claudebot"]) == ("allowed", "blocked")


# -- llms.txt: a hostile line cannot pin the worker -----------------------------------


def test_a_hostile_link_line_is_read_in_linear_time():
    # The link regex backtracked: an unclosed link took quadratic time (5 s at
    # 60,000 characters, about a minute at the 200,000-byte cap) and repeated
    # openers cubic time (4 s for 800 of them, hours for a full file). The
    # sizes stay small so the old code still finished.
    text = "# Site\n- [a](" + "x" * 60_000 + "\n" + "- " + "[a](" * 800 + "\n"

    started = time.perf_counter()
    parsed = llms_txt.parse(text)

    assert time.perf_counter() - started < 1.5
    assert parsed == {"valid": True, "title": "Site", "sections": 0, "links": 0}


@pytest.mark.parametrize(("line", "links"), [
    ("- [Guide](https://notion.so/guide): getting started", 1),
    ("* [API](https://developers.notion.com/)", 1),
    ("1. [Blog](/blog)", 1),
    ("- text before [a](b) and after", 1),
    ("- [a[b](c)", 1),
    ("- [](x)", 1),
    ("- [a] (x)", 0),
    ("- [a]( x)", 0),
    ("- [a]()", 0),
    ("- [a](x", 0),
    ("- [a]b](c)", 0),
    ("- a](b)", 0),
    ("Plain [a](b) is not a list item.", 0),
])
def test_links_count_as_the_markdown_link_rule_reads_them(line, links):
    assert llms_txt.parse(f"# Site\n{line}\n")["links"] == links


# -- Stop racing the worker that starts the run ---------------------------------------------


@pytest.mark.django_db
def test_stop_of_a_run_a_worker_just_started_leaves_its_end_to_the_worker(website, user,
                                                                          monkeypatch):
    kind = fake_kind()
    monkeypatch.setitem(runs.KINDS, kind.key, kind)
    run = InsightRun.objects.create(website=website, kind=kind.key, status="queued",
                                    units_total=3, created_by=user)
    real_finalize = runs.finalize

    def worker_takes_it_first(run_id, **kwargs):
        # The worker moves the run to running between Stop's read and its finalize.
        now = timezone.now()
        InsightRun.objects.filter(id=run_id, status="queued").update(
            status="running", started_at=now, heartbeat_at=now)
        return real_finalize(run_id, **kwargs)

    monkeypatch.setattr(runs, "finalize", worker_takes_it_first)

    stopped = runs.cancel_run(run)

    # Still the worker's: it sees Stop and ends its units itself, so the
    # cost and the counts it records still land on a run that is open.
    assert (stopped.status, stopped.cancel_requested, stopped.units_cancelled) == (
        "running", True, 0)
    monkeypatch.setattr(runs, "finalize", real_finalize)
    ended = runs.finalize(run.id)
    assert (ended.status, ended.units_cancelled) == ("cancelled", 3)


@pytest.mark.django_db
def test_stop_of_a_queued_run_still_ends_it_at_once(website, user, monkeypatch):
    kind = fake_kind()
    monkeypatch.setitem(runs.KINDS, kind.key, kind)
    run = InsightRun.objects.create(website=website, kind=kind.key, status="queued",
                                    units_total=2, created_by=user)

    stopped = runs.cancel_run(run)

    assert (stopped.status, stopped.units_cancelled) == ("cancelled", 2)


# -- Evidence: a failed read is not reused as evidence for a day ----------------------------


@pytest.mark.django_db
def test_a_failed_evidence_read_is_tried_again_by_the_next_run(website, user, monkeypatch,
                                                               cache_clear, settings):
    from apps.insights.models import EvidencePage
    from apps.insights.services import evidence
    from apps.insights.services.runs import RunContext
    from apps.insights.tests.support import SITE

    settings.INSIGHTS_EVIDENCE_PAGES = 1
    monkeypatch.setattr("apps.agent.services.context.offering_urls", lambda website: [])
    fetched = []

    def fetch_page(url, *, with_headers=False, with_links=False):
        fetched.append(url)
        return {"url": url, "final_url": url, "status_code": 200, "title": "Home", "error": None,
                "reader": {"blocks": [{"type": "paragraph", "text": "Plus costs $10."}]},
                "links": []}

    monkeypatch.setattr("apps.agent.services.browse.fetch_page", fetch_page)
    # An hour ago the home page timed out (or the parser was busy).
    EvidencePage.objects.create(website=website, url=SITE, error_code="timeout",
                                read_at=timezone.now() - timedelta(hours=1))
    run = InsightRun.objects.create(website=website, kind="answer_analysis", status="running",
                                    created_by=user)
    ctx = RunContext(InsightRun.objects.select_related("website", "created_by").get(id=run.id))

    ev = evidence.gather(ctx)

    # Reused, the failure made every claim of the next 24 hours "not verifiable".
    assert [p["state"] for p in ev.pages] == ["ok"] and SITE in fetched
    page = EvidencePage.objects.get(website=website, url=SITE)
    assert (page.error_code, page.text) == ("", "Plus costs $10.")
    # A page that loaded is still reused inside the TTL.
    fetched.clear()
    evidence.gather(ctx)
    assert SITE not in fetched


# -- Products: a page reads the newest result per question and engine, not every one ------


@pytest.mark.django_db
def test_products_read_only_the_newest_result_of_each_question_and_engine(website, user):
    from django.db.models.signals import post_init

    from apps.insights.models import ShoppingResult, TrackedProduct
    from apps.insights.services import shopping

    made = TrackedProduct.objects.create(website=website, name="X200", match_terms=["x200"],
                                         queries=["best shoes"])
    run = InsightRun.objects.create(website=website, kind="shopping_check", status="done",
                                    created_by=user)
    now = timezone.now()
    for day in range(25):
        for engine in ("google_shopping", "chatgpt"):
            ShoppingResult.objects.create(
                run=run, website=website, product=made, query="best shoes", engine=engine,
                status="done", state="named" if engine == "chatgpt" else "found", position=day + 1,
                answer_text="An answer. " * 700, checked_at=now - timedelta(days=day),
            )
    loaded = []

    def count(sender, instance, **kwargs):
        loaded.append(instance)

    post_init.connect(count, sender=ShoppingResult)
    try:
        latest = shopping.products_payload(website)["products"][0]["latest"]
        detail = shopping.product_detail(made)
    finally:
        post_init.disconnect(count, sender=ShoppingResult)

    assert latest["google"]["best_position"] == 1 and latest["engines"]["named"] == 1
    assert detail["queries"][0]["google"]["position"] == 1
    assert detail["queries"][0]["engines"][0]["answer_text"].startswith("An answer.")
    assert len(detail["history"]) == 1
    # Two rows per payload (one per question and engine), not all fifty.
    assert len(loaded) <= 4


# -- Fact check: claims are read without their answers' full texts --------------------------


@pytest.mark.django_db
def test_fact_check_claims_do_not_load_the_answer_texts(website):
    from apps.insights.services import fact_check
    from apps.insights.tests.support import analyzed, answer, at, track

    bp = track(website, "best notes app")
    result = answer(bp, "gpt4", at(1), response="Fixture Notes costs $8. " * 400)
    analyzed(result, bp, claims=[("Fixture Notes costs $8", "pricing", "contradicted",
                                  "Fixture Notes costs $8", {"kind": "page",
                                                             "url": "https://x.example/p",
                                                             "quote": "$10"})])

    rows = fact_check._claims([result.id])

    assert len(rows) == 1
    loaded = rows[0].analysis.result
    assert {"response_text", "citations", "mention_context"} <= loaded.get_deferred_fields()
    payload = fact_check.build(website)
    assert payload["claims"][0]["occurrences"][0]["result_id"] == str(result.public_id)
    assert payload["totals"]["contradicted"] == 1


# -- Competitors: the site readiness reads only the latest audits it shows ------------------


@pytest.mark.django_db
def test_site_readiness_reads_one_audit_per_brand_not_every_audit_ever(website, user):
    run = InsightRun.objects.create(website=website, kind="site_audit", status="done",
                                    created_by=user)
    now = timezone.now()
    for n in range(30):
        for key, domain in (("you", "notes-fixture.example"), ("b1", "alpha-notes.example")):
            audit = SiteAudit.objects.create(
                run=run, website=website, brand_key=key, domain=domain,
                home_url=f"https://{domain}/", robots={}, bots=[], llms_txt={},
                summary={"pages": 1}, audited_at=now - timedelta(hours=n),
            )
            SiteAuditPage.objects.create(
                audit=audit, url=f"https://{domain}/", final_url=f"https://{domain}/",
                status_code=200, checks={"ai_search_allowed": n == 0}, passed=9 - n % 3,
                total=9, blocked_bots=[], jsonld_types=[], fetched_at=now,
            )
    all_brands = competitors.brands(website)

    with CaptureQueriesContext(connection) as queries:
        site = competitors._site(website, all_brands)

    assert site["you"]["checks_passed"] == 9 and site["you"]["ai_search_allowed"] is True
    assert site["b1"]["checks_passed"] == 9 and site["b2"] is None
    # Only the pages of the two audits shown are read, not those of all sixty.
    page_sql = [q["sql"] for q in queries.captured_queries
                if 'FROM "insights_siteauditpage"' in q["sql"]]
    audits_read = {m for sql in page_sql for m in UUID.findall(sql)}
    assert page_sql and len(audits_read) <= 2
