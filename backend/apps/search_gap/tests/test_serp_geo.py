"""Google per country: ISO codes, Google's own codes ("uk" for the United
Kingdom), the localization plan per provider, and what serp_google.search
sends to each provider."""
from decimal import Decimal

import pytest
import responses

from apps.citations.services import serp_google
from apps.search_gap.tests.country_support import *  # noqa: F403
from apps.search_gap.tests.country_support import organic_page

PAGE = {"organic_results": [{"position": 1, "link": "https://www.acme-crm.example/", "title": "Acme"}]}


@pytest.mark.parametrize("raw, iso", [
    ("GB", "gb"), (" gb ", "gb"), ("UK", "gb"), ("uk", "gb"), ("De", "de"), ("us", "us"),
    ("global", ""), ("", ""), (None, ""), ("g", ""), ("g1", ""), ("üs", ""), ("usa", ""),
])
def test_iso_country(raw, iso):
    assert serp_google.iso_country(raw) == iso


def test_google_code_differs_only_for_the_united_kingdom():
    assert serp_google.google_code("gb") == "uk"
    assert serp_google.google_code("de") == "de"
    assert serp_google.google_code("us") == "us"


def test_scraperapi_geo_countries(settings):
    settings.SCRAPERAPI_GEO_COUNTRIES = "us"
    assert serp_google.scraperapi_geo_countries() == {"us"}
    settings.SCRAPERAPI_GEO_COUNTRIES = "all"
    assert serp_google.scraperapi_geo_countries() == serp_google.SCRAPERAPI_COUNTRIES
    assert "gb" in serp_google.SCRAPERAPI_COUNTRIES and "uk" not in serp_google.SCRAPERAPI_COUNTRIES
    # ISO or Google codes, commas or spaces; junk and undocumented countries dropped.
    settings.SCRAPERAPI_GEO_COUNTRIES = "UK, de xx,kw  global"
    assert serp_google.scraperapi_geo_countries() == {"gb", "de", "us"}


def _plan(country, provider):
    plan = serp_google.geo_plan(country, provider)
    return plan["method"], plan["proxy_country"], plan["params"], plan["label"]


def test_scraperapi_plan_on_the_default_us_plan(settings):
    settings.SCRAPERAPI_GEO_COUNTRIES = "us"
    scraper = serp_google.PROVIDER_SCRAPERAPI
    # Unchanged: the US, and no country at all, search from the US.
    assert _plan("", scraper) == ("default", "us", {"country_code": "us"}, "Searched from US (default)")
    assert _plan("US", scraper) == ("proxy", "us", {"country_code": "us"}, "Searched from US")
    # Elsewhere: a US connection with Google's country set (Google's code).
    assert _plan("gb", scraper) == (
        "google_setting", "us", {"country_code": "us", "gl": "uk"}, "Google set to GB, US connection",
    )
    assert _plan("de", scraper)[2] == {"country_code": "us", "gl": "de"}


def test_scraperapi_plan_with_country_targeting(settings):
    settings.SCRAPERAPI_GEO_COUNTRIES = "all"
    scraper = serp_google.PROVIDER_SCRAPERAPI
    assert _plan("gb", scraper) == (
        "proxy", "gb", {"country_code": "uk", "gl": "uk", "tld": "co.uk"}, "Searched from GB",
    )
    # No documented Google domain for Ireland: no tld.
    assert _plan("ie", scraper)[2] == {"country_code": "ie", "gl": "ie"}
    # Kuwait is not on ScraperAPI's country list.
    assert _plan("kw", scraper) == (
        "google_setting", "us", {"country_code": "us", "gl": "kw"}, "Google set to KW, US connection",
    )


def test_scraperapi_tlds_are_googles_real_search_domains(settings):
    settings.SCRAPERAPI_GEO_COUNTRIES = "all"
    scraper = serp_google.PROVIDER_SCRAPERAPI
    # google.in and google.sa are not Google's search domains (ScraperAPI
    # answered tld=in with a billed 404); google.co.in and google.com.sa are.
    assert _plan("in", scraper)[2] == {"country_code": "in", "gl": "in", "tld": "co.in"}
    assert _plan("sa", scraper)[2] == {"country_code": "sa", "gl": "sa", "tld": "com.sa"}
    # China has no Google search domain of its own (google.cn redirects to
    # google.com.hk): searched from China with gl only.
    assert _plan("cn", scraper)[2] == {"country_code": "cn", "gl": "cn"}
    assert "cn" not in serp_google.SCRAPERAPI_TLDS
    # Every tld is the Google domain SerpAPI is given for the same country.
    for country, tld in serp_google.SCRAPERAPI_TLDS.items():
        assert serp_google.GOOGLE_DOMAINS[country] == f"google.{tld}", country


def test_serpapi_plan_sets_gl_and_the_google_domain():
    serp = serp_google.PROVIDER_SERPAPI
    assert _plan("", serp) == ("default", "", {}, "Google default (US)")
    assert _plan("gb", serp) == (
        "google_setting", "", {"gl": "uk", "google_domain": "google.co.uk"}, "Google set to GB",
    )
    assert _plan("UK", serp)[2] == {"gl": "uk", "google_domain": "google.co.uk"}
    # google.com is SerpAPI's default: the US gets no domain.
    assert _plan("us", serp)[2] == {"gl": "us"}


def test_geo_plan_defaults_to_the_provider_in_use(scraperapi):
    plan = serp_google.geo_plan("gb")
    assert plan["country"] == "gb" and plan["method"] == "google_setting"
    assert plan["label"] == "Google set to GB, US connection"


def test_geo_labels():
    scraper, serp = serp_google.PROVIDER_SCRAPERAPI, serp_google.PROVIDER_SERPAPI
    assert serp_google.geo_label("proxy", "gb", scraper) == "Searched from GB"
    assert serp_google.geo_label("google_setting", "gb", scraper) == "Google set to GB, US connection"
    assert serp_google.geo_label("google_setting", "gb", serp) == "Google set to GB"
    assert serp_google.geo_label("default", "", scraper) == "Searched from US (default)"
    assert serp_google.geo_label("default", "", serp) == "Google default (US)"


def test_cost_per_search_for_a_named_provider(settings):
    settings.SERPAPI_COST_PER_SEARCH_USD = 0.015
    settings.SCRAPERAPI_COST_PER_SEARCH_USD = 0.002
    assert serp_google.cost_per_search_usd("serpapi") == Decimal("0.015")
    assert serp_google.cost_per_search_usd("scraperapi") == Decimal("0.002")
    assert serp_google.cost_per_search_usd("") == Decimal("0")


@responses.activate
def test_scraperapi_search_for_a_country(scraperapi):
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json=PAGE)

    payload = serp_google.search("best crm", country="gb", gl="de", hl="en")

    sent = responses.calls[0].request.params
    # ``country`` decides; gl is ignored and hl is never sent to ScraperAPI.
    assert sent == {"api_key": "scraper-test-key", "query": "best crm", "country_code": "us", "gl": "uk"}
    assert payload["geo"] == {
        "country": "gb", "method": "google_setting", "proxy_country": "us",
        "label": "Google set to GB, US connection",
    }


@responses.activate
def test_scraperapi_search_from_the_country_when_the_plan_allows(scraperapi):
    scraperapi.SCRAPERAPI_GEO_COUNTRIES = "gb"
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json=PAGE)

    payload = serp_google.search("best crm", country="gb", start=10)

    sent = responses.calls[0].request.params
    assert sent == {"api_key": "scraper-test-key", "query": "best crm", "country_code": "uk",
                    "gl": "uk", "tld": "co.uk", "start": "10"}
    assert payload["geo"]["method"] == "proxy" and payload["geo"]["proxy_country"] == "gb"


@responses.activate
def test_legacy_us_search_sends_exactly_what_it_did(scraperapi):
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, json=PAGE)

    serp_google.search("best crm", gl="US", hl="en")

    assert responses.calls[0].request.params == {
        "api_key": "scraper-test-key", "query": "best crm", "country_code": "us",
    }


@responses.activate
def test_serpapi_search_for_a_country(serpapi):
    responses.get(serp_google.SEARCH_ENDPOINT, json=PAGE)

    payload = serp_google.search("best crm", country="gb", hl="en")

    sent = responses.calls[0].request.params
    assert (sent["gl"], sent["google_domain"], sent["hl"]) == ("uk", "google.co.uk", "en")
    assert payload["geo"]["label"] == "Google set to GB" and payload["geo"]["proxy_country"] == ""


@responses.activate
def test_legacy_gl_gb_becomes_googles_uk(serpapi):
    responses.get(serp_google.SEARCH_ENDPOINT, json=PAGE)

    serp_google.search("best crm", gl="gb", hl="en")

    assert responses.calls[0].request.params["gl"] == "uk"


@responses.activate
def test_an_empty_country_is_global_even_with_gl(serpapi):
    responses.get(serp_google.SEARCH_ENDPOINT, json=PAGE)

    payload = serp_google.search("best crm", country="", gl="gb")

    assert "gl" not in responses.calls[0].request.params
    assert payload["geo"]["method"] == "default"


@responses.activate
def test_error_payloads_carry_the_plan(scraperapi):
    responses.get(serp_google.SCRAPERAPI_ENDPOINT, status=500)

    payload = serp_google.search("best crm", country="de")

    assert payload["error"] == "http_500"
    assert payload["geo"]["country"] == "de" and payload["geo"]["method"] == "google_setting"


def test_payloads_before_a_plan_have_no_geo(settings):
    assert serp_google._empty()["geo"] is None
    assert serp_google.search("best crm", country="gb")["geo"] is None
    assert organic_page(0, ["a.example"])["geo"] is None
