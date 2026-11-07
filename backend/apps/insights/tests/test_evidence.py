"""Evidence for claim checks (backend 3c): planned pages (home, Offerings
pages, home-page links), the 24-hour reuse, failed reads, the facts
filter, and what one answer's check reads."""

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.brand_vault.models import BrandFact
from apps.insights.models import EvidencePage, InsightRun
from apps.insights.services import evidence
from apps.insights.services.runs import RunContext
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import SITE

pytestmark = pytest.mark.django_db

LINKS = [
    {"url": "https://elsewhere.example/pricing", "text": "Their pricing"},
    {"url": f"{SITE}/en/plans", "text": "Plans"},
    {"url": f"{SITE}/pricing", "text": "Pricing"},
    {"url": f"{SITE}/about-us", "text": "About"},
    {"url": f"{SITE}/supporters", "text": "Supporters"},
    {"url": f"{SITE}/help/support", "text": "Support"},
    {"url": "mailto:hi@notes-fixture.example", "text": "Mail"},
]


@pytest.fixture
def fetch(monkeypatch):
    calls = []

    def fake(url, *, with_headers=False, with_links=False):
        calls.append((url, with_links))
        if url.endswith("/broken"):
            return {"url": url, "final_url": url, "status_code": None, "reader": None,
                    "error": {"code": "timeout", "message": "Slow."}}
        if url.endswith("/gone"):
            return {"url": url, "final_url": url, "status_code": 404, "title": "Not found",
                    "reader": {"blocks": [{"type": "paragraph", "text": "Not found"}]},
                    "error": None}
        out = {
            "url": url, "final_url": url + ("/" if url == SITE else ""), "status_code": 200,
            "title": "Page", "error": None,
            "reader": {"blocks": [
                {"type": "heading", "level": 1, "text": f"Page {url}"},
                {"type": "list", "items": ["One", "Two"]},
                {"type": "table", "rows": [["Plan", "Price"], ["Plus", "$10"]]},
            ]},
        }
        if with_links:
            out["links"] = LINKS
        return out

    monkeypatch.setattr("apps.agent.services.browse.fetch_page", fake)
    return calls


@pytest.fixture
def offerings(monkeypatch):
    urls = []
    monkeypatch.setattr("apps.agent.services.context.offering_urls", lambda website: list(urls))
    return urls


def ctx_for(website, user):
    run = InsightRun.objects.create(website=website, kind="answer_analysis", status="running",
                                    created_by=user)
    return RunContext(InsightRun.objects.select_related("website", "created_by").get(id=run.id))


def test_planned_pages_follow_home_offerings_then_one_link_per_pattern(
        website, fetch, offerings, cache_clear, settings):
    settings.INSIGHTS_EVIDENCE_PAGES = 6
    offerings.append(f"{SITE}/product/teams")
    planned = evidence.planned_pages(website)
    assert planned == [
        SITE,
        f"{SITE}/product/teams",
        f"{SITE}/en/plans",
        f"{SITE}/about-us",
        f"{SITE}/help/support",
    ]
    assert fetch == [(SITE, True)]

    settings.INSIGHTS_EVIDENCE_PAGES = 2
    assert evidence.planned_pages(website) == [SITE, f"{SITE}/product/teams"]


def test_options_plan_pages_without_network(website, fetch, offerings, cache_clear):
    assert evidence.planned_pages(website, fetch=False) == [SITE]
    assert fetch == []
    evidence.planned_pages(website)  # fills the links cache
    fetch.clear()
    assert evidence.planned_pages(website, fetch=False)[:3] == [
        SITE, f"{SITE}/en/plans", f"{SITE}/about-us"]
    assert fetch == []


def test_pages_are_read_once_and_reused_inside_the_ttl(website, user, fetch, offerings,
                                                       cache_clear, settings):
    settings.INSIGHTS_EVIDENCE_PAGES = 2
    ev = evidence.gather(ctx_for(website, user))
    assert [(p["id"], p["url"], p["state"]) for p in ev.readable_pages] == [
        ("p1", SITE, "ok"), ("p2", f"{SITE}/en/plans", "ok")]
    page = EvidencePage.objects.get(url=f"{SITE}/en/plans")
    assert page.text == "\n\n".join([f"Page {SITE}/en/plans", "One", "Two", "Plan | Price",
                                     "Plus | $10"])
    reads = len(fetch)
    evidence.gather(ctx_for(website, user))
    assert len(fetch) == reads  # links cached, pages fresh

    EvidencePage.objects.update(read_at=timezone.now() - timedelta(hours=25))
    evidence.gather(ctx_for(website, user))
    assert len(fetch) == reads + 2


def test_failed_reads_are_kept_with_their_state(website, user, fetch, offerings, cache_clear):
    offerings.extend([f"{SITE}/broken", f"{SITE}/gone"])
    ev = evidence.gather(ctx_for(website, user))
    states = {p["url"]: (p["state"], p["id"]) for p in ev.pages}
    assert states[f"{SITE}/broken"] == ("failed", None)
    assert states[f"{SITE}/gone"] == ("failed", None)
    gone = EvidencePage.objects.get(url=f"{SITE}/gone")
    assert (gone.status_code, gone.error_code, gone.text) == (404, "fetch_failed", "")
    assert EvidencePage.objects.get(url=f"{SITE}/broken").error_code == "timeout"


def test_facts_are_current_approved_or_auto(website, user, fetch, offerings, cache_clear):
    def fact(obj, status="approved", superseded=False):
        return BrandFact.objects.create(
            website=website, subject="Fixture Notes", predicate="costs", object=obj,
            status=status, version_to=timezone.now() if superseded else None,
        )

    fact("$10 per seat")
    fact("$5 per seat", status="auto")
    fact("$1 per seat", status="pending")
    fact("$8 per seat", superseded=True)
    fact("free", status="rejected")
    ev = evidence.gather(ctx_for(website, user))
    assert sorted(f["text"] for f in ev.facts) == [
        "Fixture Notes costs $10 per seat", "Fixture Notes costs $5 per seat"]
    assert {f["id"] for f in ev.facts} == {"f1", "f2"}
    assert evidence.fact_counts(website) == {"facts": 2, "facts_pending": 1}


def test_one_answer_reads_the_closest_facts_and_shares_the_page_budget(monkeypatch):
    facts = [{"id": f"f{i}", "fact_id": str(i), "text": text, "source_url": ""}
             for i, text in enumerate(["Fixture Notes has offices in Oslo",
                                       "Fixture Notes costs $10 per seat",
                                       "Fixture Notes integrates with Slack"], 1)]
    pages = [
        {"id": "p1", "url": "a", "final_url": "a", "text": "x" * 100, "state": "ok"},
        {"id": "p2", "url": "b", "final_url": "b", "text": "y" * 50_000, "state": "ok"},
        {"id": None, "url": "c", "final_url": "c", "text": "", "state": "failed"},
    ]
    ev = evidence.Evidence(facts=facts, pages=pages)
    chosen, read = evidence.for_answer(ev, [{"text": "It costs $8 per seat"}])
    assert chosen[0]["id"] == "f2"
    assert [len(p["text"]) for p in read] == [100, evidence.ANSWER_PAGE_CHARS - 100]

    monkeypatch.setattr(evidence, "ANSWER_FACT_CHARS", 40)
    chosen, _read = evidence.for_answer(ev, [{"text": "Slack"}])
    assert [f["id"] for f in chosen] == ["f3"]


def test_water_caps():
    assert evidence.water_caps([10, 100, 1000], 300) == [10, 100, 190]
    assert evidence.water_caps([500, 500], 300) == [150, 150]
    assert evidence.water_caps([], 300) == []
