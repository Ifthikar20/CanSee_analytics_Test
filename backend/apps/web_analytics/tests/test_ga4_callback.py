"""The GA4 OAuth callback returns to Settings > Connections (pages
contract 4a): every outcome, with the website and the reason in the
query. Google's token exchange and property listing are stubbed."""

import pytest
from django.contrib.auth import get_user_model
from django.core import signing
from django.urls import reverse
from requests import RequestException
from rest_framework.test import APIClient

from apps.web_analytics.services import ga4_client, ga4_oauth
from apps.websites.models import Integration, Website

pytestmark = pytest.mark.django_db

FRONTEND = "https://app.cansee.example"
PROPERTY = {"property_id": "123456", "display_name": "Shop", "account_name": "Shop account"}


@pytest.fixture(autouse=True)
def frontend(settings):
    settings.FRONTEND_URL = FRONTEND + "/"
    settings.WEB_ANALYTICS_ENABLED = True


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Shop Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://shop.example", name="Shop")


@pytest.fixture
def google(monkeypatch):
    """Token exchange and property listing without Google."""
    found = {"properties": [PROPERTY]}

    def exchange(code):
        if code == "bad":
            raise RequestException("exchange failed")
        return {"access_token": "ya29.test", "refresh_token": "1//refresh", "expires_in": 3600}

    monkeypatch.setattr(ga4_oauth, "exchange_code", exchange)
    monkeypatch.setattr(ga4_client, "list_account_summaries",
                        lambda token, **kwargs: list(found["properties"]))
    return found


def _state(website, user) -> str:
    return signing.dumps({"website_id": str(website.id), "user_id": str(user.id)},
                         salt=ga4_oauth.STATE_SALT)


def _callback(**params):
    return APIClient().get(reverse("wa-ga4-oauth-callback"), params)


def test_connected_with_one_property(user, website, google):
    resp = _callback(state=_state(website, user), code="ok")

    assert resp.status_code == 302
    assert resp["Location"] == (
        f"{FRONTEND}/settings/connections?ga4=connected&website={website.id}")
    integration = Integration.objects.get(website=website, type="ga")
    assert integration.metadata["property_id"] == "123456"


def test_several_properties_ask_for_a_choice(user, website, google):
    google["properties"] = [PROPERTY, {**PROPERTY, "property_id": "654321"}]

    resp = _callback(state=_state(website, user), code="ok")

    assert resp["Location"] == (
        f"{FRONTEND}/settings/connections?ga4=select_property&website={website.id}")


def test_errors_carry_a_reason(user, website, google):
    resp = _callback(state=_state(website, user), error="access_denied")
    assert resp["Location"] == (
        f"{FRONTEND}/settings/connections?ga4=error&website={website.id}&reason=denied")

    resp = _callback(state=_state(website, user), code="bad")
    assert resp["Location"] == (
        f"{FRONTEND}/settings/connections?ga4=error&website={website.id}&reason=exchange_failed")

    resp = _callback(state="tampered", code="ok")
    assert resp["Location"] == f"{FRONTEND}/settings/connections?ga4=error&reason=invalid_state"

    stranger = get_user_model().objects.create_user(email="s@example.com", password="x" * 16)
    resp = _callback(state=_state(website, stranger), code="ok")
    assert resp["Location"] == f"{FRONTEND}/settings/connections?ga4=error&reason=invalid_state"
    assert not Integration.objects.filter(website=website, type="ga").exists()


def test_the_callback_is_off_with_the_feature(user, website, google, settings):
    settings.WEB_ANALYTICS_ENABLED = False

    assert _callback(state=_state(website, user), code="ok").status_code == 404
