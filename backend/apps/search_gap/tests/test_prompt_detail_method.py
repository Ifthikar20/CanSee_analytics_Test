"""The prompt detail's ``google.method``: how a Google check for the
prompt's location runs now with the configured provider (contract 3)."""
import pytest

from apps.search_gap.services.overview import build_prompt_detail
from apps.search_gap.tests.country_support import *  # noqa: F403
from apps.search_gap.tests.country_support import data, make_prompt

pytestmark = pytest.mark.django_db


def _method(website, location):
    bp = make_prompt(website, f"best crm ({location or 'global'})", location=location)
    return build_prompt_detail(website, bp)["google"]["method"]


def test_scraperapi_methods(website, scraperapi):
    assert _method(website, "gb") == {"method": "google_setting", "label": "Google set to GB, US connection"}
    assert _method(website, "us") == {"method": "proxy", "label": "Searched from US"}
    assert _method(website, "") == {"method": "default", "label": "Searched from US (default)"}

    scraperapi.SCRAPERAPI_GEO_COUNTRIES = "all"
    assert _method(website, "uk") == {"method": "proxy", "label": "Searched from GB"}


def test_serpapi_methods(website, serpapi):
    assert _method(website, "gb") == {"method": "google_setting", "label": "Google set to GB"}
    assert _method(website, "") == {"method": "default", "label": "Google default (US)"}


def test_no_method_without_a_google_key(website):
    assert _method(website, "gb") is None


def test_the_prompt_endpoint_carries_it(api, website, scraperapi):
    bp = make_prompt(website, "best crm for startups", location="de")

    google = data(api.get(f"/api/v1/search-gap/websites/{website.id}/prompts/{bp.prompt_id}/"))["google"]

    assert google["method"] == {"method": "google_setting", "label": "Google set to DE, US connection"}
    assert google["status"] == "not_checked"
