"""Traffic and traffic by country (pages contract 4c, 4d): the pixel from
its own rows, GA4 from a stubbed bundle and country report, Cloudflare
from a stubbed GraphQL seam; empty reasons, stale copies and the API's
validation. Nothing reaches GA4 or Cloudflare."""

import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.analytics.models import PageEvent, Session, Visitor
from apps.web_analytics.services import (
    cloudflare_client,
    cloudflare_dashboard,
    cloudflare_reports,
    ga4_client,
    source_resolver,
)
from apps.web_analytics.services.traffic import traffic, traffic_countries
from apps.websites.models import Integration, Website

pytestmark = pytest.mark.django_db

CF_NOTES = [
    "Cloudflare counts every request to your site, including bots and crawlers, "
    "so these numbers are not visitors.",
    "Cloudflare samples its page and device breakdowns, so those are estimates.",
    "Cloudflare does not report referrers on this plan.",
]
CF_BREAKDOWNS_FAILED = "Cloudflare's page and device breakdowns could not be loaded just now."


@pytest.fixture(autouse=True)
def fresh_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Shop Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://shop.example", name="Shop")


def ago(days: float):
    return timezone.now() - timedelta(days=days)


def day(days: int) -> str:
    return (timezone.now() - timedelta(days=days)).date().isoformat()


def visitor(website, *, country="", device="desktop", last_seen=None):
    row = Visitor.objects.create(website=website, fingerprint_hash=uuid.uuid4().hex,
                                 geo_country=country, device_type=device)
    Visitor.objects.filter(id=row.id).update(last_seen=last_seen or timezone.now())
    return row


def pageview(person, when, url="https://shop.example/"):
    return PageEvent.objects.create(visitor=person, website=person.website, url=url,
                                    event_type="pageview", timestamp=when)


def session(person, when, *, source="", medium="", entry="https://shop.example/"):
    return Session.objects.create(visitor=person, started_at=when, source=source, medium=medium,
                                  entry_page=entry, page_count=1)


def connect_ga4(website):
    return Integration.objects.create(
        website=website, type="ga", access_token="ya29.test", refresh_token="1//refresh",
        is_active=True, metadata={"property_id": "123456", "property_display_name": "Shop"},
    )


def connect_cloudflare(website):
    return Integration.objects.create(
        website=website, type="cloudflare", access_token="cf-token", is_active=True,
        metadata={"zone_id": "zone123", "zone_name": "shop.example"},
    )


def ga4_rows(*rows) -> dict:
    """A GA4 runReport response from (dimension values..., metric) rows."""
    return {"rows": [
        {"dimensionValues": [{"value": v} for v in row[:-1]],
         "metricValues": [{"value": str(row[-1])}]}
        for row in rows
    ]}


# ── Pixel ────────────────────────────────────────────────────────────────


def test_pixel_traffic_with_a_recent_install(website):
    us = visitor(website, country="US", last_seen=ago(2))
    gb = visitor(website, country="GB", device="mobile", last_seen=ago(2))
    nowhere = visitor(website, last_seen=ago(1))
    pageview(us, ago(10), "https://shop.example/pricing?ref=x")
    pageview(us, ago(2), "https://shop.example/pricing")
    pageview(gb, ago(2))
    pageview(nowhere, ago(1), "https://shop.example/blog/post")
    session(us, ago(10), source="google", medium="organic")
    session(gb, ago(2), source="chatgpt", medium="ai")
    session(nowhere, ago(1))

    data = traffic(website, period="30d", source="auto")

    assert (data["source"], data["source_label"], data["period"]) == ("pixel", "Cansee pixel", "30d")
    assert (data["metric"], data["metric_label"], data["sampled"], data["stale"]) == (
        "visitors", "Unique visitors", False, False)
    assert (data["empty_reason"], data["available_sources"]) == (None, ["pixel"])
    assert data["measured_since"] == day(10)
    # The previous window was not measured, so every change is unknown.
    assert data["overview"] == {
        "visitors": 3, "visitors_change_pct": None, "pageviews": 4,
        "pageviews_change_pct": None, "sessions": 3, "sessions_change_pct": None,
    }
    series = data["series"]
    labels = series["labels"]
    assert len(labels) == 31 and labels[-1] == day(0)
    assert series["pageviews"][labels.index(day(10))] == 1
    assert series["pageviews"][labels.index(day(2))] == 2
    assert series["visitors"][labels.index(day(2))] == 2
    assert series["sessions"][labels.index(day(1))] == 1
    assert series["pageviews"][labels.index(day(5))] == 0
    assert all(v is None for v in series["visitors"][: labels.index(day(10))])
    assert data["countries"] == [{"code": "GB", "value": 1, "share_pct": 50.0},
                                 {"code": "US", "value": 1, "share_pct": 50.0}]
    assert data["countries_unknown"] == 1
    referrers = sorted((r["source"], r["medium"], r["sessions"], r["is_ai"])
                       for r in data["referrers"])
    assert referrers == [("Chatgpt", "ai", 1, True), ("Direct", "none", 1, False),
                         ("Google", "organic", 1, False)]
    assert data["pages"] == [{"path": "/pricing", "views": 2}, {"path": "/", "views": 1},
                             {"path": "/blog/post", "views": 1}]
    assert data["devices"] == [{"name": "Desktop", "value": 2, "share_pct": 66.7},
                               {"name": "Mobile", "value": 1, "share_pct": 33.3}]
    assert data["breakdown_hours"] is None
    assert data["notes"] == [
        f"The Cansee pixel started recording on {day(10)}; earlier days are not measured."]


def test_pixel_changes_compare_a_fully_measured_previous_window(website):
    early = visitor(website, country="US", last_seen=ago(70))
    pageview(early, ago(70))
    before = visitor(website, country="US", last_seen=ago(40))
    pageview(before, ago(40))
    session(before, ago(40))
    for days in (2, 3):
        person = visitor(website, country="DE", last_seen=ago(days))
        pageview(person, ago(days))
        session(person, ago(days))

    data = traffic(website, period="30d", source="pixel")

    assert data["overview"] == {
        "visitors": 2, "visitors_change_pct": 100.0, "pageviews": 2,
        "pageviews_change_pct": 100.0, "sessions": 2, "sessions_change_pct": 100.0,
    }
    assert data["notes"] == []
    assert None not in data["series"]["visitors"]


def test_pixel_empty_reasons(website):
    data = traffic(website, period="30d", source="auto")
    assert (data["source"], data["source_label"], data["metric"]) == (None, None, None)
    assert data["empty_reason"] == "no_source"
    assert (data["overview"], data["series"], data["countries_unknown"]) == (None, None, None)
    assert data["countries"] == data["referrers"] == data["pages"] == data["devices"] == []
    assert data["breakdown_hours"] is None
    assert data["notes"] == [] and data["available_sources"] == []

    assert traffic(website, period="7d", source="pixel")["empty_reason"] == "not_connected"
    ga4 = traffic(website, period="7d", source="ga4")
    assert (ga4["empty_reason"], ga4["source"], ga4["source_label"], ga4["metric"]) == (
        "not_connected", "ga4", "Google Analytics 4", "users")

    website.pixel_verified = True
    website.save(update_fields=["pixel_verified"])
    data = traffic(website, period="7d", source="auto")
    assert (data["source"], data["empty_reason"]) == ("pixel", "no_data")
    assert data["available_sources"] == ["pixel"]


# ── GA4 ──────────────────────────────────────────────────────────────────


def _ga4_bundle(*, stale=False, users=120):
    chart = [{"date": day(1), "label": "", "visitors": users, "pageviews": 300, "sessions": 150},
             {"date": day(0), "label": "", "visitors": 0, "pageviews": 0, "sessions": 0}]
    return {
        "overview": {"total_visitors": users, "total_pageviews": 300 if users else 0,
                     "visitor_growth_pct": 20.0, "pageviews_trend": -5.0},
        "chart": chart if users else [{**b, "visitors": 0, "pageviews": 0, "sessions": 0}
                                      for b in chart],
        "pages": [{"url": "/pricing", "views": 90}, {"url": "/", "views": 60}],
        "sources": [
            {"source": "google", "medium": "organic", "count": 100, "sessions": 100},
            {"source": "chatgpt.com", "medium": "ai", "count": 7, "sessions": 7},
        ],
        "devices": {"devices": [{"name": "Desktop", "count": 80, "pct": 66.7},
                                {"name": "Mobile", "count": 40, "pct": 33.3}]},
        "countries": [],
        "stale": stale,
    }


def test_ga4_traffic_from_the_bundle_and_a_country_report(website, monkeypatch):
    integration = connect_ga4(website)
    bundles = []
    monkeypatch.setattr(source_resolver, "fetch_bundle",
                        lambda w, source, period, integration=None: bundles.append(
                            (source, period, integration.id)) or _ga4_bundle())
    calls = []

    def run_report(token, property_id, **kwargs):
        calls.append((token, property_id, kwargs))
        return ga4_rows(("US", 50), ("GB", 30), ("(not set)", 5))

    monkeypatch.setattr(ga4_client, "run_report", run_report)

    data = traffic(website, period="30d", source="ga4")

    assert bundles == [("ga4", "30d", integration.id)]
    assert (data["source"], data["metric"], data["metric_label"], data["sampled"]) == (
        "ga4", "users", "Users", False)
    assert (data["empty_reason"], data["measured_since"], data["stale"]) == (None, None, False)
    assert data["overview"] == {
        "visitors": 120, "visitors_change_pct": 20.0, "pageviews": 300,
        "pageviews_change_pct": -5.0, "sessions": 150, "sessions_change_pct": None,
    }
    assert data["series"] == {"labels": [day(1), day(0)], "visitors": [120, 0],
                              "pageviews": [300, 0], "sessions": [150, 0]}
    assert data["countries"] == [{"code": "US", "value": 50, "share_pct": 62.5},
                                 {"code": "GB", "value": 30, "share_pct": 37.5}]
    assert data["countries_unknown"] == 5
    assert data["referrers"] == [
        {"source": "google", "medium": "organic", "sessions": 100, "is_ai": False},
        {"source": "chatgpt.com", "medium": "ai", "sessions": 7, "is_ai": True},
    ]
    assert data["pages"] == [{"path": "/pricing", "views": 90}, {"path": "/", "views": 60}]
    assert data["devices"][0] == {"name": "Desktop", "value": 80, "share_pct": 66.7}
    assert data["breakdown_hours"] is None
    assert data["notes"] == []
    [(token, property_id, kwargs)] = calls
    assert (token, property_id) == ("ya29.test", "123456")
    assert (kwargs["metrics"], kwargs["dimensions"], kwargs["limit"]) == (
        ["totalUsers"], ["countryId"], 250)
    assert kwargs["date_ranges"] == [(day(29), day(0))]

    # A second read inside ten minutes is served from the cache.
    traffic(website, period="30d", source="ga4")
    assert len(calls) == 1


def test_ga4_stale_failed_and_empty(website, monkeypatch):
    connect_ga4(website)
    monkeypatch.setattr(ga4_client, "run_report", lambda *a, **k: ga4_rows(("US", 1)))

    monkeypatch.setattr(source_resolver, "fetch_bundle",
                        lambda *a, **k: _ga4_bundle(stale=True))
    data = traffic(website, period="7d", source="ga4")
    assert data["stale"] is True
    assert data["notes"] == ["Showing the last saved copy; Google Analytics 4 could not be reached."]

    monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, **k: None)
    data = traffic(website, period="7d", source="ga4")
    assert (data["empty_reason"], data["overview"], data["source_label"]) == (
        "source_error", None, "Google Analytics 4")

    monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, **k: _ga4_bundle(users=0))
    assert traffic(website, period="7d", source="ga4")["empty_reason"] == "no_data"


# ── Cloudflare ───────────────────────────────────────────────────────────


def _cf_report(*, requests=970, previous=800):
    return {"viewer": {"zones": [{
        "days": [
            {"dimensions": {"date": day(1)}, "sum": {"requests": requests - 400, "pageViews": 80}},
            {"dimensions": {"date": day(0)}, "sum": {"requests": 400, "pageViews": 20}},
        ] if requests else [],
        "totals": [{"sum": {"requests": requests, "pageViews": 100 if requests else 0,
                            "countryMap": [
                                {"clientCountryName": "US", "requests": 600},
                                {"clientCountryName": "gb", "requests": 300},
                                {"clientCountryName": "XX", "requests": 50},
                                {"clientCountryName": "T1", "requests": 20},
                            ] if requests else []}}],
        "previous": [{"sum": {"requests": previous, "pageViews": 0}}],
    }]}}


def _cf_bundle(**fields):
    """A cached dashboard bundle. Without ``breakdowns_failed`` it is one
    saved before the bundle carried the key."""
    return {
        "overview": {"total_visitors": 77, "breakdown_window_hours": 24},
        "pages": [{"url": "/blog/how-to", "views": 120}, {"url": "/", "views": 80}],
        "devices": {"devices": [{"name": "Desktop", "count": 150, "pct": 75.0}]},
        "stale": False,
        **fields,
    }


def test_cloudflare_traffic_counts_requests(website, monkeypatch):
    connect_cloudflare(website)
    posts = []

    def post(api_token, query, variables, **kwargs):
        posts.append((api_token, query, variables))
        return _cf_report()

    monkeypatch.setattr(cloudflare_client, "_post_graphql", post)
    monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, **k: _cf_bundle())

    data = traffic(website, period="30d", source="cloudflare")

    assert (data["metric"], data["metric_label"], data["sampled"]) == ("requests", "Requests", True)
    assert data["overview"] == {
        "visitors": 970, "visitors_change_pct": 21.2, "pageviews": 100,
        "pageviews_change_pct": None, "sessions": None, "sessions_change_pct": None,
    }
    series = data["series"]
    assert len(series["labels"]) == 30 and series["labels"][-2:] == [day(1), day(0)]
    assert series["visitors"][-2:] == [570, 400] and series["visitors"][0] == 0
    assert series["pageviews"][-2:] == [80, 20]
    assert series["sessions"] == [None] * 30
    assert data["countries"] == [{"code": "US", "value": 600, "share_pct": 66.7},
                                 {"code": "GB", "value": 300, "share_pct": 33.3}]
    assert data["countries_unknown"] == 70
    assert data["referrers"] is None
    # The cached bundle predates breakdowns_failed, so it reads as not failed.
    assert data["pages"] == [{"path": "/blog/how-to", "views": 120}, {"path": "/", "views": 80}]
    assert data["devices"] == [{"name": "Desktop", "value": 150, "share_pct": 75.0}]
    assert data["breakdown_hours"] == 24
    assert data["notes"] == [*CF_NOTES,
                             "Cloudflare's pages and devices cover the last 24 hours on this plan."]
    [(api_token, query, variables)] = posts
    assert api_token == "cf-token" and "countryMap" in query
    assert variables == {"zone": "zone123", "since": day(29), "until": day(0),
                         "prevSince": day(59), "prevUntil": day(30)}


def test_cloudflare_breakdowns_that_did_not_load_are_null(website, monkeypatch):
    connect_cloudflare(website)
    monkeypatch.setattr(cloudflare_client, "_post_graphql", lambda *a, **k: _cf_report())

    for bundle in (_cf_bundle(breakdowns_failed=True), None):
        monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, b=bundle, **k: b)
        data = traffic(website, period="30d", source="cloudflare")
        assert (data["pages"], data["devices"], data["breakdown_hours"]) == (None, None, None)
        assert data["notes"] == [CF_NOTES[0], CF_BREAKDOWNS_FAILED, CF_NOTES[2]]
        # The rollup numbers do not depend on the breakdowns.
        assert data["overview"]["visitors"] == 970 and data["countries"][0]["code"] == "US"

    monkeypatch.setattr(source_resolver, "fetch_bundle",
                        lambda *a, **k: _cf_bundle(breakdowns_failed=False))
    data = traffic(website, period="30d", source="cloudflare")
    assert data["pages"][0] == {"path": "/blog/how-to", "views": 120}
    assert data["breakdown_hours"] == 24

    # A breakdown window as long as the period needs no hours.
    monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, **k: _cf_bundle(
        overview={"breakdown_window_hours": 168}))
    data = traffic(website, period="7d", source="cloudflare")
    assert data["breakdown_hours"] is None and data["notes"] == CF_NOTES
    # Empty breakdowns that did load are a measured nothing.
    monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, **k: _cf_bundle(
        pages=[], devices={"devices": []}, breakdowns_failed=False))
    data = traffic(website, period="30d", source="cloudflare")
    assert (data["pages"], data["devices"]) == ([], [])


BREAKDOWNS = {"viewer": {"zones": [{
    "pages": [{"count": 12, "avg": {"sampleInterval": 10},
               "dimensions": {"clientRequestPath": "/pricing"}}],
    "deviceTypes": [{"count": 5, "avg": {"sampleInterval": 1},
                     "dimensions": {"clientDeviceType": "desktop"}}],
}]}}


@pytest.mark.parametrize("period", ["30d", "24h", "1h"])
def test_the_dashboard_bundle_says_when_its_breakdowns_failed(monkeypatch, period):
    """Daily and hourly rollups and the minute-class adaptive path: only
    the adaptive breakdown query fails, every other query answers."""
    answers = {}

    def post(api_token, query, variables, **kwargs):
        if query == cloudflare_dashboard._ADAPTIVE_BREAKDOWNS:
            return answers["breakdowns"]
        return {"viewer": {"zones": [{}]}}

    monkeypatch.setattr(cloudflare_dashboard, "_post_graphql", post)

    answers["breakdowns"] = None
    bundle = cloudflare_dashboard.build_bundle("cf-token", "zone123", period=period)
    assert bundle["breakdowns_failed"] is True
    assert bundle["pages"] == [] and bundle["devices"]["devices"] == []

    answers["breakdowns"] = BREAKDOWNS
    bundle = cloudflare_dashboard.build_bundle("cf-token", "zone123", period=period)
    assert bundle["breakdowns_failed"] is False
    assert bundle["pages"] == [{"url": "/pricing", "views": 120}]
    assert [row["name"] for row in bundle["devices"]["devices"]] == ["Desktop"]


def test_cloudflare_failed_and_empty(website, monkeypatch):
    connect_cloudflare(website)
    monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, **k: _cf_bundle())

    monkeypatch.setattr(cloudflare_client, "_post_graphql", lambda *a, **k: None)
    assert traffic(website, period="7d", source="cloudflare")["empty_reason"] == "source_error"

    monkeypatch.setattr(cloudflare_client, "_post_graphql",
                        lambda *a, **k: _cf_report(requests=0, previous=0))
    cache.clear()
    data = traffic(website, period="7d", source="cloudflare")
    assert (data["empty_reason"], data["referrers"]) == ("no_data", [])


def test_a_disconnected_source_is_never_read_from_cache(website, monkeypatch):
    integration = connect_cloudflare(website)
    monkeypatch.setattr(cloudflare_client, "_post_graphql", lambda *a, **k: _cf_report())
    monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, **k: _cf_bundle())
    assert traffic(website, period="7d", source="cloudflare")["empty_reason"] is None

    integration.access_token = ""
    integration.is_active = False
    integration.save()

    data = traffic(website, period="7d", source="cloudflare")
    assert (data["empty_reason"], data["overview"]) == ("not_connected", None)
    assert data["available_sources"] == []


# ── Countries (4d) ───────────────────────────────────────────────────────


def test_countries_from_the_pixel(website):
    us = visitor(website, country="US", last_seen=ago(1))
    pageview(us, ago(40))
    visitor(website, country="US", last_seen=ago(2))
    visitor(website, country="FR", last_seen=ago(3))
    visitor(website, last_seen=ago(3))

    data = traffic_countries(website, period="30d", source="auto")

    assert set(data) == {"source", "source_label", "period", "available_sources", "metric",
                         "metric_label", "sampled", "stale", "empty_reason", "countries",
                         "countries_unknown", "total", "notes"}
    assert data["countries"] == [{"code": "US", "value": 2, "share_pct": 66.7},
                                 {"code": "FR", "value": 1, "share_pct": 33.3}]
    assert (data["countries_unknown"], data["total"], data["notes"]) == (1, 4, [])


def test_countries_from_ga4_and_cloudflare(website, monkeypatch):
    connect_ga4(website)
    connect_cloudflare(website)
    monkeypatch.setattr(ga4_client, "run_report", lambda *a, **k: ga4_rows(("DE", 9), ("", 1)))
    posts = []
    monkeypatch.setattr(cloudflare_client, "_post_graphql",
                        lambda *a, **k: posts.append(a) or _cf_report())

    ga4 = traffic_countries(website, period="7d", source="auto")
    assert (ga4["source"], ga4["metric_label"]) == ("ga4", "Users")
    assert ga4["countries"] == [{"code": "DE", "value": 9, "share_pct": 100.0}]
    assert (ga4["countries_unknown"], ga4["total"], ga4["notes"]) == (1, 10, [])

    cf = traffic_countries(website, period="7d", source="cloudflare")
    assert (cf["metric"], cf["sampled"], cf["total"]) == ("requests", True, 970)
    # Rollup countries are not sampled: only the requests note.
    assert cf["notes"] == CF_NOTES[:1]
    assert len(posts) == 1
    # The traffic page reuses the same cached report: no second upstream call.
    monkeypatch.setattr(source_resolver, "fetch_bundle", lambda *a, **k: _cf_bundle())
    traffic(website, period="7d", source="cloudflare")
    assert len(posts) == 1

    monkeypatch.setattr(cloudflare_reports, "report", lambda *a, **k: None)
    failed = traffic_countries(website, period="7d", source="cloudflare")
    assert (failed["empty_reason"], failed["countries"], failed["total"]) == (
        "source_error", [], None)


# ── API ──────────────────────────────────────────────────────────────────


def test_api_validates_period_and_source(user, website):
    client = APIClient()
    client.force_authenticate(user)
    traffic_url = reverse("wa-traffic", kwargs={"website_id": website.id})
    countries_url = reverse("wa-traffic-countries", kwargs={"website_id": website.id})
    ai_url = reverse("wa-ai-traffic", kwargs={"website_id": website.id})
    assert traffic_url == f"/api/v1/web-analytics/{website.id}/traffic/"
    assert countries_url == f"/api/v1/web-analytics/{website.id}/traffic/countries/"
    assert ai_url == f"/api/v1/web-analytics/{website.id}/ai-traffic/"

    resp = client.get(traffic_url)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert (data["period"], data["empty_reason"]) == ("30d", "no_source")
    assert client.get(countries_url, {"period": "7d", "source": "pixel"}).status_code == 200

    for url, params, field in (
        (traffic_url, {"period": "1y"}, "period"),
        (traffic_url, {"source": "bing"}, "source"),
        (countries_url, {"period": "24h"}, "period"),
        (ai_url, {"source": "cloudflare"}, "source"),
    ):
        resp = client.get(url, params)
        assert resp.status_code == 400, (url, params)
        error = resp.json()["error"]
        assert error["code"] == "invalid" and error["details"]["field"] == field

    stranger = get_user_model().objects.create_user(email="s@example.com", password="x" * 16)
    client.force_authenticate(stranger)
    assert client.get(traffic_url).status_code == 404
