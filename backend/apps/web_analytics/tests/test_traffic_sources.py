"""Traffic sources (pages contract 4b): each source's state, what it
measures, the default source's precedence and the endpoint's tenancy."""

import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.analytics.models import PageEvent, Visitor
from apps.web_analytics.services import source_resolver
from apps.web_analytics.services.traffic import traffic_sources
from apps.websites.models import Integration, Website

pytestmark = pytest.mark.django_db


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


def pageview(website, when):
    visitor = Visitor.objects.create(website=website, fingerprint_hash=uuid.uuid4().hex)
    return PageEvent.objects.create(visitor=visitor, website=website, url="https://shop.example/",
                                    event_type="pageview", timestamp=when)


def connect_ga4(website, *, property_id="123456", active=True):
    metadata = ({"property_id": property_id, "property_display_name": "Shop property"}
                if property_id else {"pending_property_selection": True})
    return Integration.objects.create(website=website, type="ga", access_token="ya29.test",
                                      refresh_token="1//refresh", is_active=active,
                                      metadata=metadata)


def connect_cloudflare(website, *, zone_id="zone123"):
    metadata = ({"zone_id": zone_id, "zone_name": "shop.example"} if zone_id
                else {"pending_zone_selection": True})
    return Integration.objects.create(website=website, type="cloudflare",
                                      access_token="cf-token", is_active=True, metadata=metadata)


def _source(payload, key):
    return next(s for s in payload["sources"] if s["key"] == key)


def test_every_source_is_listed_with_what_it_measures(website):
    payload = traffic_sources(website)

    assert [s["key"] for s in payload["sources"]] == ["pixel", "ga4", "ga_hosted", "cloudflare"]
    assert [s["label"] for s in payload["sources"]] == [
        "Cansee pixel", "Google Analytics 4", "Cansee Google tag", "Cloudflare"]
    measures = {s["key"]: s["measures"] for s in payload["sources"]}
    assert measures["pixel"] == {"visitors": "visitors", "countries": True, "referrers": True,
                                 "ai_referrals": True, "ai_crawlers": False}
    assert measures["ga4"] == {"visitors": "users", "countries": True, "referrers": True,
                               "ai_referrals": True, "ai_crawlers": False}
    assert measures["ga_hosted"] == {"visitors": "live_only", "countries": False,
                                     "referrers": False, "ai_referrals": False,
                                     "ai_crawlers": False}
    assert measures["cloudflare"] == {"visitors": "requests", "countries": True,
                                      "referrers": False, "ai_referrals": False,
                                      "ai_crawlers": "unknown"}
    for source in payload["sources"]:
        assert set(source) == {"key", "label", "connected", "has_data", "status", "detail",
                               "measured_since", "measures"}
    assert payload["default_source"] is None


def test_pixel_not_installed_installed_and_recording(website):
    pixel = _source(traffic_sources(website), "pixel")
    assert (pixel["status"], pixel["connected"], pixel["has_data"]) == (
        "not_installed", False, False)
    assert (pixel["detail"], pixel["measured_since"]) == ("", None)

    website.pixel_verified = True
    website.save(update_fields=["pixel_verified"])
    pixel = _source(traffic_sources(website), "pixel")
    assert (pixel["status"], pixel["connected"], pixel["has_data"]) == (
        "not_installed", True, False)

    first = timezone.now() - timedelta(days=12)
    last = timezone.now() - timedelta(hours=3)
    pageview(website, first)
    pageview(website, last)
    cache.clear()  # the "no events yet" answer is cached for a minute
    pixel = _source(traffic_sources(website), "pixel")
    assert (pixel["status"], pixel["connected"], pixel["has_data"]) == ("ok", True, True)
    assert pixel["measured_since"] == first.date().isoformat()
    assert pixel["detail"] == f"Last event {last.strftime('%Y-%m-%dT%H:%M:%SZ')}"


def test_ga4_states(website, settings):
    ga4 = _source(traffic_sources(website), "ga4")
    assert (ga4["status"], ga4["connected"], ga4["has_data"]) == ("not_connected", False, False)

    integration = connect_ga4(website, property_id="")
    ga4 = _source(traffic_sources(website), "ga4")
    assert (ga4["status"], ga4["connected"], ga4["has_data"]) == (
        "pending_selection", True, False)

    integration.metadata = {"property_id": "123456", "property_display_name": "Shop property"}
    integration.save()
    ga4 = _source(traffic_sources(website), "ga4")
    assert (ga4["status"], ga4["connected"], ga4["has_data"], ga4["detail"]) == (
        "ok", True, True, "Shop property")

    integration.is_active = False
    integration.save()
    assert _source(traffic_sources(website), "ga4")["status"] == "not_connected"

    integration.is_active = True
    integration.save()
    settings.WEB_ANALYTICS_ENABLED = False
    payload = traffic_sources(website)
    assert {s["key"]: s["status"] for s in payload["sources"]} == {
        "pixel": "not_installed", "ga4": "disabled", "ga_hosted": "disabled",
        "cloudflare": "disabled"}
    assert _source(payload, "ga4")["connected"] is False


def test_hosted_tag_is_live_only(website):
    Integration.objects.create(website=website, type="ga_hosted", is_active=True,
                               metadata={"measurement_id": "G-ABC123", "stream_id": "42"})

    hosted = _source(traffic_sources(website), "ga_hosted")

    assert (hosted["status"], hosted["connected"], hosted["has_data"], hosted["detail"]) == (
        "ok", True, False, "G-ABC123")
    assert traffic_sources(website)["default_source"] is None


def test_cloudflare_states_and_crawler_capability(website):
    integration = connect_cloudflare(website, zone_id="")
    cf = _source(traffic_sources(website), "cloudflare")
    assert (cf["status"], cf["connected"], cf["has_data"]) == ("pending_selection", True, False)
    assert cf["measures"]["ai_crawlers"] == "unknown"

    integration.metadata = {"zone_id": "zone123", "zone_name": "shop.example"}
    integration.save()
    cf = _source(traffic_sources(website), "cloudflare")
    assert (cf["status"], cf["detail"], cf["measures"]["ai_crawlers"]) == (
        "ok", "shop.example", "unknown")

    cache.set("wa:cfcrawl:zone123", "supported", 60)
    assert _source(traffic_sources(website), "cloudflare")["measures"]["ai_crawlers"] is True
    cache.set("wa:cfcrawl:zone123", "unsupported", 60)
    assert _source(traffic_sources(website), "cloudflare")["measures"]["ai_crawlers"] is False


def test_default_source_precedence(website):
    assert source_resolver.auto_source(website) is None

    website.pixel_verified = True
    website.save(update_fields=["pixel_verified"])
    assert source_resolver.auto_source(website) == "pixel"

    connect_cloudflare(website)
    assert source_resolver.auto_source(website) == "cloudflare"

    connect_ga4(website)
    assert source_resolver.auto_source(website) == "ga4"

    pageview(website, timezone.now() - timedelta(days=1))
    cache.clear()
    assert source_resolver.auto_source(website) == "pixel"
    assert traffic_sources(website)["default_source"] == "pixel"


# ── API ──────────────────────────────────────────────────────────────────


def test_endpoint_serves_members_and_hides_the_project_from_others(user, website, settings):
    url = reverse("wa-traffic-sources", kwargs={"website_id": website.id})
    assert url == f"/api/v1/web-analytics/{website.id}/traffic/sources/"
    org = Organization.objects.create(name="Shop Org", slug="shop-org", owner=user)
    website.organization = org
    website.save(update_fields=["organization"])
    people = get_user_model().objects
    viewer = people.create_user(email="viewer@example.com", password="x" * 16)
    stranger = people.create_user(email="stranger@example.com", password="x" * 16)
    OrganizationMember.objects.create(organization=org, user=viewer, role="viewer")
    client = APIClient()

    client.force_authenticate(user)
    resp = client.get(url)
    assert resp.status_code == 200
    assert [s["key"] for s in resp.json()["data"]["sources"]] == [
        "pixel", "ga4", "ga_hosted", "cloudflare"]
    # The pixel works with the external sources switched off.
    settings.WEB_ANALYTICS_ENABLED = False
    assert client.get(url).status_code == 200

    for person in (viewer, stranger):
        client.force_authenticate(person)
        assert client.get(url).status_code == 404
