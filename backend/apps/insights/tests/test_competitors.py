"""Competitors (contract 4a): name and domain-label matching, head to head,
citations by brand, Google page one, site readiness and the empty states."""

from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.insights.models import InsightRun, SiteAudit, SiteAuditPage
from apps.insights.services import competitors
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import (
    SITE,
    answer,
    at,
    cite,
    track,
)
from apps.search_gap.models import GoogleRankCheck

pytestmark = pytest.mark.django_db


def brand(name, position):
    return {"name": name, "position": position, "linked": False}


def check(bp, *, position=None, top=(), error="", days_ago=1):
    return GoogleRankCheck.objects.create(
        website=bp.website, brand_prompt=bp, query=bp.prompt.text, depth=10, position=position,
        top_results=[{"position": i, "url": f"https://{d}/x", "domain": d, "title": d}
                     for i, d in enumerate(top, 1)],
        error=error, checked_at=timezone.now() - timedelta(days=days_ago),
    )


def test_matching_ignores_case_and_punctuation_but_not_substrings(website):
    website.competitors = [{"name": "Notion", "domain": "notion.so"},
                           {"name": "Alpha Notes", "domain": "https://www.alpha-notes.example/"}]
    rivals = competitors.brands(website)[1:]
    assert [(b["key"], b["domain"]) for b in rivals] == [("b1", "notion.so"),
                                                         ("b2", "alpha-notes.example")]

    class R:
        is_mentioned = False
        mention_rank = None

    r = R()
    r.competitors_mentioned = [brand("NOTION!", 2), brand("alpha notes", None), brand("Note", 1)]
    assert competitors.mentions(r, rivals) == {"b1": 2, "b2": None}
    r.competitors_mentioned = [brand("Alpha-Notes", 3)]
    assert competitors.mentions(r, rivals) == {"b2": 3}
    r.competitors_mentioned = [brand("Notions", 1), brand("Not", 2)]
    assert competitors.mentions(r, rivals) == {}


def test_ai_numbers_series_and_head_to_head(website, engines):
    bp = track(website, "best notes app for teams")
    answer(bp, "gpt4", at(1), rank=1, brands=[brand("Alpha Notes", 2)])
    answer(bp, "gpt4", at(1), rank=3, brands=[brand("alpha-notes", 1)])
    answer(bp, "claude", at(2), rank=None, brands=[brand("Alpha Notes", 1)])
    answer(bp, "claude", at(2), mentioned=False, brands=[brand("Beta Notes", 1)])

    data = competitors.build(website, period="7d")
    you, b1, b2 = (data["ai"]["brands"][k] for k in ("you", "b1", "b2"))
    assert data["ai"]["answers"] == 4
    assert (you["named"], you["visibility_pct"], you["avg_rank"], you["first_place"]) == (
        3, 75.0, 2.0, 1)
    assert (b1["named"], b1["visibility_pct"], b1["first_place"]) == (3, 75.0, 2)
    assert (b2["named"], b2["avg_rank"]) == (1, 1.0)
    index = data["window"]["buckets"].index(at(1).date().isoformat())
    assert you["series"][index] == 100.0
    assert you["series"][0] is None
    h2h = {row["key"]: row for row in data["head_to_head"]}
    assert h2h["b1"] == {"key": "b1", "both_named": 3, "you_ahead": 1, "they_ahead": 1,
                         "no_order": 1}
    assert h2h["b2"]["both_named"] == 0
    assert data["empty_reason"] is None
    assert [b["key"] for b in data["brands"]] == ["you", "b1", "b2"]

    only = competitors.build(website, period="7d", engine="claude")
    assert only["ai"]["answers"] == 2 and only["filters"] == {"engine": "claude"}


def test_citations_by_brand_and_no_data(website, engines):
    bp = track(website, "best notes app for teams")
    r1 = answer(bp, "gpt4", at(1))
    r2 = answer(bp, "gpt4", at(1))
    data = competitors.build(website)
    assert data["citations"] == {"has_data": False, "brands": None}
    cite(r1, f"{SITE}/pricing")
    cite(r2, f"{SITE}/pricing")
    cite(r1, "https://blog.alpha-notes.example/compare")
    cite(r1, "https://reviews.example/x")
    data = competitors.build(website)
    assert data["citations"]["has_data"] is True
    assert data["citations"]["brands"]["you"] == {"citations": 2, "pages": 1, "answers": 2}
    assert data["citations"]["brands"]["b1"] == {"citations": 1, "pages": 1, "answers": 1}
    assert data["citations"]["brands"]["b2"] == {"citations": 0, "pages": 0, "answers": 0}


def test_google_uses_the_latest_error_free_check_and_page_one(website, settings):
    settings.SERPAPI_KEY = "k"
    bp = track(website, "best notes app for teams")
    other = track(website, "notes app with slack")
    third = track(website, "never checked")
    check(bp, position=14, top=["alpha-notes.example", "x.example"], days_ago=5)
    check(bp, error="network", days_ago=1)
    check(other, position=2, top=["www.notes-fixture.example", "alpha-notes.example"])
    check(third, position=1, days_ago=200)

    data = competitors.build(website)
    google = data["google"]
    assert (google["configured"], google["prompts_checked"]) == (True, 2)
    assert google["brands"]["you"] == {"on_page_one": 1, "best_position": 2}
    assert google["brands"]["b1"] == {"on_page_one": 2, "best_position": 1}
    assert google["brands"]["b2"] == {"on_page_one": 0, "best_position": None}
    rows = {row["text"]: row for row in data["by_prompt"]}
    first = rows["best notes app for teams"]
    assert first["google_state"] == "ok"
    assert first["google"]["you"] == {"position": 14, "depth": 10}
    assert first["google"]["b1"] == {"position": 1, "depth": 2}
    assert first["google"]["b2"] == {"position": None, "depth": 2}
    assert rows["never checked"]["google_state"] == "not_checked"
    assert rows["never checked"]["google"] is None


def test_google_states_without_a_key_or_a_check(website, settings):
    bp = track(website, "best notes app for teams")
    check(bp, error="http_500")
    data = competitors.build(website)
    assert data["google"]["configured"] is False and data["google"]["brands"] is None
    assert data["by_prompt"][0]["google_state"] == "failed"
    settings.SERPAPI_KEY = "k"
    assert competitors.build(website)["google"]["brands"] is None


def test_site_readiness_follows_the_apex_not_the_stored_key(website, user):
    run = InsightRun.objects.create(website=website, kind="site_audit", status="done")
    mine = SiteAudit.objects.create(run=run, website=website, brand_key="you",
                                    domain="notes-fixture.example", home_url=f"{SITE}/")
    SiteAuditPage.objects.create(audit=mine, url=f"{SITE}/", checks={"ai_search_allowed": True},
                                 passed=7, total=9)
    theirs = SiteAudit.objects.create(run=run, website=website, brand_key="b2",
                                      domain="alpha-notes.example",
                                      home_url="https://alpha-notes.example/")
    SiteAuditPage.objects.create(audit=theirs, url="https://alpha-notes.example/",
                                 checks={"ai_search_allowed": False}, passed=5, total=9)
    site = competitors.build(website)["site"]
    assert site["you"]["checks_passed"] == 7 and site["you"]["ai_search_allowed"] is True
    assert site["b1"] == {"audited_at": site["b1"]["audited_at"], "checks_passed": 5,
                          "checks_total": 9, "ai_search_allowed": False}
    assert site["b2"] is None


def test_no_competitors(website):
    website.competitors = []
    website.save()
    data = competitors.build(website)
    assert data["empty_reason"] == "no_competitors"
    assert data["head_to_head"] == [] and [b["key"] for b in data["brands"]] == ["you"]


def test_api(client, website):
    url = reverse("insights-competitors", kwargs={"website_id": website.id})
    assert client.get(url, {"period": "90d"}).json()["data"]["window"]["interval"] == "week"
    assert client.get(url, {"engine": "bing"}).status_code == 400
