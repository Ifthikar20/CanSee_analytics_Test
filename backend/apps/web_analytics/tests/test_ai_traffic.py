"""AI traffic (pages contract 4e): referrals from the pixel's sessions and
GA4's classified sources, and AI crawler requests from a stubbed
Cloudflare GraphQL seam (patterns, classification, un-sampling, per-day
totals, and the plan probe). Nothing reaches GA4 or Cloudflare."""

import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.analytics.models import PageEvent, Session, Visitor
from apps.web_analytics.services import ai_crawlers, cloudflare_client, ga4_client
from apps.web_analytics.services.ai_traffic import ai_traffic
from apps.web_analytics.services.traffic import traffic_sources
from apps.websites.models import Integration, Website

pytestmark = pytest.mark.django_db

CRAWLER_NOTE = "Counted from user-agent strings, which bots can fake. Cloudflare samples these numbers."
GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"
CLAUDEBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"
PERPLEXITY_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0)"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"


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


def visit(website, when, *, source="", medium="", country="", entry="https://shop.example/"):
    """A visitor with one pageview and one session at ``when``."""
    person = Visitor.objects.create(website=website, fingerprint_hash=uuid.uuid4().hex,
                                    geo_country=country)
    PageEvent.objects.create(visitor=person, website=website, url=entry, event_type="pageview",
                             timestamp=when)
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
    return {"rows": [
        {"dimensionValues": [{"value": v} for v in row[:-1]],
         "metricValues": [{"value": str(row[-1])}]}
        for row in rows
    ]}


def group(count, interval, **dimensions) -> dict:
    return {"count": count, "avg": {"sampleInterval": interval}, "dimensions": dimensions}


# ── Referrals: pixel ─────────────────────────────────────────────────────


def test_pixel_referrals_by_assistant_day_page_and_country(website):
    visit(website, ago(20))  # the pixel's first visit
    visit(website, ago(2), source="chatgpt", medium="ai", country="US",
          entry="https://shop.example/pricing?utm_source=chatgpt.com")
    visit(website, ago(2), source="chatgpt", medium="ai", country="GB",
          entry="https://shop.example/pricing")
    visit(website, ago(5), source="perplexity", medium="ai", country="US",
          entry="https://shop.example/blog")
    visit(website, ago(3), source="google", medium="organic", country="US")

    referrals = ai_traffic(website, period="30d", source="auto")["referrals"]

    assert (referrals["source"], referrals["source_label"], referrals["available"],
            referrals["reason"]) == ("pixel", "Cansee pixel", True, None)
    assert (referrals["total_sessions"], referrals["ai_sessions"], referrals["ai_share_pct"]) == (
        5, 3, 60.0)
    assert referrals["assistants"] == [
        {"key": "chatgpt", "label": "ChatGPT", "sessions": 2, "share_pct": 66.7},
        {"key": "perplexity", "label": "Perplexity", "sessions": 1, "share_pct": 33.3},
    ]
    series = referrals["series"]
    labels = series["labels"]
    assert len(labels) == 31 and labels[-1] == day(0)
    assert list(series["by_assistant"]) == ["chatgpt", "perplexity"]
    chatgpt = series["by_assistant"]["chatgpt"]
    assert chatgpt[labels.index(day(2))] == 2 and chatgpt[labels.index(day(3))] == 0
    assert series["by_assistant"]["perplexity"][labels.index(day(5))] == 1
    # Days before the pixel's first event are not measured.
    assert all(v is None for v in chatgpt[: labels.index(day(20))])
    assert referrals["landing_pages"] == [
        {"path": "/pricing", "sessions": 2, "by_assistant": {"chatgpt": 2}},
        {"path": "/blog", "sessions": 1, "by_assistant": {"perplexity": 1}},
    ]
    assert referrals["countries"] == [{"code": "US", "sessions": 2},
                                      {"code": "GB", "sessions": 1}]
    assert referrals["measured_since"] == day(20)
    assert referrals["notes"] == [
        f"The Cansee pixel started recording on {day(20)}; earlier days are not measured."]


def test_no_ai_sessions_is_a_measured_zero(website):
    visit(website, ago(40))
    visit(website, ago(2), source="google", medium="organic")

    referrals = ai_traffic(website, period="7d", source="pixel")["referrals"]

    assert (referrals["available"], referrals["total_sessions"], referrals["ai_sessions"]) == (
        True, 1, 0)
    assert referrals["ai_share_pct"] == 0.0
    assert referrals["assistants"] == [] and referrals["series"]["by_assistant"] == {}
    assert referrals["notes"] == []


def test_referral_reasons(website, monkeypatch):
    referrals = ai_traffic(website, period="30d", source="auto")["referrals"]
    assert (referrals["available"], referrals["reason"], referrals["source"]) == (
        False, "no_source", None)
    assert referrals["total_sessions"] is None and referrals["assistants"] == []

    referrals = ai_traffic(website, period="30d", source="ga4")["referrals"]
    assert (referrals["reason"], referrals["source_label"]) == ("not_connected", "Google Analytics 4")

    website.pixel_verified = True
    website.save(update_fields=["pixel_verified"])
    assert ai_traffic(website, period="30d", source="auto")["referrals"]["reason"] == "no_data"

    connect_ga4(website)
    monkeypatch.setattr(ga4_client, "run_report", lambda *a, **k: None)
    referrals = ai_traffic(website, period="30d", source="auto")["referrals"]
    assert (referrals["source"], referrals["reason"]) == ("ga4", "source_error")


# ── Referrals: GA4 ───────────────────────────────────────────────────────


def test_ga4_referrals_classify_assistant_sources(website, monkeypatch):
    connect_ga4(website)
    yesterday = (timezone.now() - timedelta(days=1)).strftime("%Y%m%d")
    today = timezone.now().strftime("%Y%m%d")
    calls = []

    def run_report(token, property_id, *, metrics, date_ranges, dimensions=None, **kwargs):
        calls.append(tuple(dimensions or ()))
        assert metrics == ["sessions"] and date_ranges == [(day(29), day(0))]
        if not dimensions:
            return ga4_rows((200,))
        if dimensions[0] == "date":
            return ga4_rows((yesterday, "chatgpt.com", 5), (yesterday, "google", 50),
                            (today, "perplexity", 2), (today, "copilot.microsoft.com", 1))
        if dimensions[0] == "landingPage":
            return ga4_rows(("/pricing", "chatgpt.com", 4), ("/pricing", "perplexity", 2),
                            ("/", "google", 40), ("(not set)", "chatgpt.com", 1))
        return ga4_rows(("US", "chatgpt.com", 3), ("DE", "perplexity", 2),
                        ("(not set)", "copilot.microsoft.com", 1), ("US", "google", 30))

    monkeypatch.setattr(ga4_client, "run_report", run_report)

    referrals = ai_traffic(website, period="30d", source="ga4")["referrals"]

    assert sorted(calls) == [(), ("countryId", "sessionSource"), ("date", "sessionSource"),
                             ("landingPage", "sessionSource")]
    assert (referrals["source"], referrals["available"], referrals["measured_since"]) == (
        "ga4", True, None)
    assert (referrals["total_sessions"], referrals["ai_sessions"], referrals["ai_share_pct"]) == (
        200, 8, 4.0)
    assert [(a["key"], a["label"], a["sessions"]) for a in referrals["assistants"]] == [
        ("chatgpt", "ChatGPT", 5), ("perplexity", "Perplexity", 2), ("copilot", "Copilot", 1)]
    labels = referrals["series"]["labels"]
    assert len(labels) == 30
    assert referrals["series"]["by_assistant"]["chatgpt"][labels.index(day(1))] == 5
    assert referrals["series"]["by_assistant"]["copilot"][-1] == 1
    assert referrals["landing_pages"] == [
        {"path": "/pricing", "sessions": 6, "by_assistant": {"chatgpt": 4, "perplexity": 2}}]
    assert referrals["countries"] == [{"code": "US", "sessions": 3}, {"code": "DE", "sessions": 2}]
    assert referrals["notes"] == []

    # The four reports are cached together.
    ai_traffic(website, period="30d", source="ga4")
    assert len(calls) == 4


# ── Crawlers ─────────────────────────────────────────────────────────────


def test_the_query_names_every_crawler_pattern():
    assert len(ai_crawlers.patterns()) == len(ai_crawlers.CATALOG) == 19
    document = ai_crawlers.query()
    for pattern in ai_crawlers.patterns():
        assert f'{{userAgent_like: "{pattern}"}}' in document
    assert '"%meta-externalagent%"' in document and '"%GPTBot%"' in document
    assert "requestSource: \"eyeball\"" in document and "%(or)s" not in document


def test_classify_matches_case_insensitively_and_specific_tokens_first():
    assert ai_crawlers.classify(GPTBOT_UA) == "gptbot"
    assert ai_crawlers.classify("gptbot/1.1") == "gptbot"
    assert ai_crawlers.classify("Mozilla/5.0 (compatible; Claude-SearchBot/1.0)") == "claude-searchbot"
    assert ai_crawlers.classify("Claude-User/1.0") == "claude-user"
    assert ai_crawlers.classify(CLAUDEBOT_UA) == "claudebot"
    assert ai_crawlers.classify("meta-externalfetcher/1.1") == "meta-externalfetcher"
    assert ai_crawlers.classify("meta-externalagent/1.1") == "meta-externalagent"
    assert ai_crawlers.classify("Mozilla/5.0 (compatible; OAI-SearchBot/1.0)") == "oai-searchbot"
    assert ai_crawlers.classify(BROWSER_UA) is None
    assert ai_crawlers.classify("") is None


def _per_day(variables) -> dict:
    """Today: GPTBot and ClaudeBot (sampled); the day before: PerplexityBot."""
    since = variables["since"][:10]
    if since == day(0):
        agents = [group(10, 2, userAgent=GPTBOT_UA), group(5, 1, userAgent=CLAUDEBOT_UA),
                  group(7, 1, userAgent=BROWSER_UA)]
        paths = [group(4, 2, clientRequestPath="/blog/how-to", userAgent=GPTBOT_UA),
                 group(3, 1, clientRequestPath="/blog/how-to", userAgent=CLAUDEBOT_UA),
                 group(6, 1, clientRequestPath="/", userAgent=BROWSER_UA)]
    elif since == day(1):
        agents = [group(4, 1, userAgent=PERPLEXITY_UA)]
        paths = [group(4, 1, clientRequestPath="/pricing", userAgent=PERPLEXITY_UA)]
    else:
        agents, paths = [], []
    return {"viewer": {"zones": [{"agents": agents, "paths": paths}]}}


def test_crawler_report_unsamples_and_totals_seven_days(website, monkeypatch):
    connect_cloudflare(website)
    calls = []

    def post(api_token, query, variables, *, stats=None, errors=None):
        calls.append(variables)
        assert api_token == "cf-token" and "userAgent_like" in query
        return _per_day(variables)

    monkeypatch.setattr(cloudflare_client, "_post_graphql", post)

    crawlers = ai_traffic(website, period="30d", source="auto")["crawlers"]

    assert len(calls) == 7
    assert {c["zone"] for c in calls} == {"zone123"}
    assert sorted(c["since"][:10] for c in calls) == [day(i) for i in range(6, -1, -1)]
    assert calls[0]["since"][:10] == day(0)  # the newest day is the probe
    for c in calls[1:]:
        assert c["since"].endswith("T00:00:00Z") and c["until"].endswith("T00:00:00Z")
    assert (crawlers["available"], crawlers["reason"], crawlers["source"]) == (
        True, None, "cloudflare")
    assert (crawlers["window_days"], crawlers["window_start"]) == (7, day(6))
    assert (crawlers["sampled"], crawlers["verified"]) == (True, False)
    assert crawlers["total_requests"] == 29
    assert crawlers["bots"] == [
        {"key": "gptbot", "name": "GPTBot", "operator": "OpenAI", "purpose": "training",
         "requests": 20, "share_pct": 69.0},
        {"key": "claudebot", "name": "ClaudeBot", "operator": "Anthropic",
         "purpose": "training", "requests": 5, "share_pct": 17.2},
        {"key": "perplexitybot", "name": "PerplexityBot", "operator": "Perplexity",
         "purpose": "search", "requests": 4, "share_pct": 13.8},
    ]
    assert crawlers["purposes"] == [
        {"key": "training", "label": "Model training", "requests": 25},
        {"key": "search", "label": "AI search index", "requests": 4},
    ]
    series = crawlers["series"]
    assert series["labels"] == [day(i) for i in range(6, -1, -1)]
    assert series["by_bot"] == {"gptbot": [0, 0, 0, 0, 0, 0, 20],
                                "claudebot": [0, 0, 0, 0, 0, 0, 5],
                                "perplexitybot": [0, 0, 0, 0, 0, 4, 0]}
    assert crawlers["paths"] == [
        {"path": "/blog/how-to", "requests": 11, "bots": ["gptbot", "claudebot"]},
        {"path": "/pricing", "requests": 4, "bots": ["perplexitybot"]},
    ]
    assert crawlers["notes"] == [CRAWLER_NOTE]
    # The probe's answer is remembered and shown on the sources payload.
    cloudflare = next(s for s in traffic_sources(website)["sources"] if s["key"] == "cloudflare")
    assert cloudflare["measures"]["ai_crawlers"] is True
    # Cached: a second read makes no request.
    ai_traffic(website, period="7d", source="auto")
    assert len(calls) == 7


def test_no_crawler_requests_is_a_measured_zero(website, monkeypatch):
    connect_cloudflare(website)
    monkeypatch.setattr(cloudflare_client, "_post_graphql",
                        lambda *a, **k: {"viewer": {"zones": [{"agents": [], "paths": []}]}})

    crawlers = ai_traffic(website, period="30d", source="auto")["crawlers"]

    assert (crawlers["available"], crawlers["total_requests"]) == (True, 0)
    assert crawlers["bots"] == crawlers["purposes"] == crawlers["paths"] == []
    assert crawlers["series"]["by_bot"] == {} and len(crawlers["series"]["labels"]) == 7


def test_a_refused_query_means_the_plan_is_unsupported(website, monkeypatch):
    connect_cloudflare(website)
    calls = []

    def post(api_token, query, variables, *, stats=None, errors=None):
        calls.append(variables)
        errors.append("zone 'zone123' does not have access to the field userAgent")
        return None

    monkeypatch.setattr(cloudflare_client, "_post_graphql", post)

    crawlers = ai_traffic(website, period="30d", source="auto")["crawlers"]

    assert (crawlers["available"], crawlers["reason"], crawlers["total_requests"]) == (
        False, "plan_unsupported", None)
    assert len(calls) == 1
    assert cache.get("wa:cfcrawl:zone123") == "unsupported"
    assert ai_crawlers.capability("zone123") is False
    # Known for a day: no further probe, even after the report expires.
    cache.delete_many(["wa:cfai:zone123:" + str(website.id),
                       "wa:cfai:zone123:" + str(website.id) + ":last"])
    assert ai_traffic(website, period="30d", source="auto")["crawlers"]["reason"] == "plan_unsupported"
    assert len(calls) == 1


class _Response:
    def __init__(self, body):
        self.body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self.body


def test_the_graphql_seam_hands_error_messages_to_the_caller(monkeypatch):
    refused = {"data": None, "errors": [
        {"message": "zone 'zone123' does not have access to the field userAgent"}, "busy"]}
    monkeypatch.setattr(cloudflare_client.requests, "post", lambda *a, **k: _Response(refused))

    errors = []
    assert cloudflare_client._post_graphql("cf-token", "{ viewer }", {}, errors=errors) is None
    assert errors == ["zone 'zone123' does not have access to the field userAgent", "busy"]
    # Existing callers pass no list and see the same None.
    assert cloudflare_client._post_graphql("cf-token", "{ viewer }", {}) is None

    monkeypatch.setattr(cloudflare_client.requests, "post",
                        lambda *a, **k: _Response({"data": {"viewer": {"zones": []}}}))
    errors = []
    assert cloudflare_client._post_graphql("cf-token", "{ viewer }", {}, errors=errors) == {
        "viewer": {"zones": []}}
    assert errors == []


def test_the_plan_probe_reads_errors_through_the_real_seam(website, monkeypatch):
    connect_cloudflare(website)
    refused = {"data": None, "errors": [{"message": "not authorized for that account"}]}
    monkeypatch.setattr(cloudflare_client.requests, "post", lambda *a, **k: _Response(refused))

    crawlers = ai_traffic(website, period="30d", source="auto")["crawlers"]

    assert (crawlers["available"], crawlers["reason"]) == (False, "plan_unsupported")
    assert ai_crawlers.capability("zone123") is False


def test_a_failed_request_is_a_source_error_and_not_remembered(website, monkeypatch):
    connect_cloudflare(website)
    monkeypatch.setattr(cloudflare_client, "_post_graphql", lambda *a, **k: None)

    crawlers = ai_traffic(website, period="30d", source="auto")["crawlers"]

    assert (crawlers["available"], crawlers["reason"]) == (False, "source_error")
    assert ai_crawlers.capability("zone123") == "unknown"


def test_crawlers_need_cloudflare(website, settings):
    crawlers = ai_traffic(website, period="30d", source="auto")["crawlers"]
    assert (crawlers["available"], crawlers["reason"]) == (False, "no_cloudflare")
    assert crawlers["bots"] == [] and crawlers["series"] == {"labels": [], "by_bot": {}}

    connect_cloudflare(website)
    settings.WEB_ANALYTICS_ENABLED = False
    assert ai_traffic(website, period="30d", source="auto")["crawlers"]["reason"] == "disabled"


# ── API ──────────────────────────────────────────────────────────────────


def test_api_returns_both_parts(user, website):
    client = APIClient()
    client.force_authenticate(user)
    url = reverse("wa-ai-traffic", kwargs={"website_id": website.id})

    resp = client.get(url, {"period": "7d"})

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["period"] == "7d"
    assert (data["referrals"]["reason"], data["crawlers"]["reason"]) == ("no_source", "no_cloudflare")
    assert client.get(url, {"source": "pixel"}).status_code == 200
    assert client.get(url, {"source": "cloudflare"}).status_code == 400
