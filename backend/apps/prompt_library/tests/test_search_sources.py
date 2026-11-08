"""The prompt 'search sources' lookup: cached, rate limited, time bounded.

Every uncached lookup is a paid SerpAPI search, so the endpoint must reuse
answers and stop one user from looping it.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.prompt_library.api.v1.views import PromptSearchSourcesView
from apps.prompt_library.services import source_verifier as sv
from apps.prompt_library.services.search_sources import (
    SearchRateLimited,
    search_sources,
)

URL = "/api/v1/prompt-library/prompts/search-sources/"
QUERY = "best vineyards in napa for a wedding"


def _serp_response(urls=("https://forum.example.com/napa",)):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "organic_results": [
            {"title": f"Result {i}", "link": url, "snippet": "napa vineyards wedding"}
            for i, url in enumerate(urls, start=1)
        ],
    }
    return resp


@pytest.fixture(autouse=True)
def _clean_cache(settings):
    settings.SERPAPI_KEY = "test-serp-key"
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def client():
    api = APIClient()
    api.force_authenticate(user=UserFactory())
    return api


@pytest.fixture
def page_text():
    with patch.object(sv, "_fetch", return_value="napa vineyards for a wedding") as fetch:
        yield fetch


@pytest.mark.django_db
def test_returns_the_whole_payload_not_a_flattened_page(client, page_text):
    with patch("requests.get", return_value=_serp_response()):
        resp = client.post(URL, {"query": QUERY}, format="json")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["provider"] == "serpapi"
    assert data["query"] == QUERY
    assert [row["url"] for row in data["results"]] == ["https://forum.example.com/napa"]


@pytest.mark.django_db
def test_same_query_is_served_from_cache(client, page_text):
    with patch("requests.get", return_value=_serp_response()) as serp:
        first = client.post(URL, {"query": QUERY}, format="json")
        # Case and spacing do not make a new paid search.
        second = client.post(URL, {"query": "  Best Vineyards in NAPA for a wedding "},
                             format="json")
    assert first.status_code == second.status_code == 200
    assert serp.call_count == 1
    assert second.json()["data"]["cached"] is True
    assert second.json()["data"]["results"] == first.json()["data"]["results"]


@pytest.mark.django_db
def test_uncached_searches_are_rate_limited_per_user(client, page_text):
    capacity = PromptSearchSourcesView._BUCKET_CAPACITY
    with patch("requests.get", return_value=_serp_response()) as serp:
        for i in range(capacity):
            ok = client.post(URL, {"query": f"{QUERY} number {i}"}, format="json")
            assert ok.status_code == 200
        limited = client.post(URL, {"query": f"{QUERY} one more"}, format="json")
        assert limited.status_code == 429
        assert serp.call_count == capacity
        # A cached answer costs nothing, so it is still served.
        again = client.post(URL, {"query": f"{QUERY} number 0"}, format="json")
        assert again.status_code == 200
        assert serp.call_count == capacity

    # Another user has their own allowance.
    other = APIClient()
    other.force_authenticate(user=UserFactory())
    with patch("requests.get", return_value=_serp_response()):
        assert other.post(URL, {"query": f"{QUERY} other"}, format="json").status_code == 200


@pytest.mark.django_db
def test_failed_search_is_not_cached(page_text):
    failed = MagicMock(status_code=503)
    with patch("requests.get", return_value=failed):
        out = search_sources(QUERY)
    assert out["error"] == "http_503"
    with patch("requests.get", return_value=_serp_response()) as serp:
        out = search_sources(QUERY)
    assert serp.call_count == 1
    assert out.get("error") is None


def test_denied_budget_raises_before_any_paid_call(page_text):
    with patch("requests.get") as serp, pytest.raises(SearchRateLimited):
        search_sources(QUERY, allow_paid_call=lambda: False)
    serp.assert_not_called()


def test_unconfigured_key_skips_budget(settings):
    settings.SERPAPI_KEY = ""
    budget = MagicMock(return_value=False)
    out = search_sources(QUERY, allow_paid_call=budget)
    assert out["provider"] == "unconfigured"
    budget.assert_not_called()


def test_verification_stops_when_time_budget_is_spent():
    rows = [{"url": f"https://forum.example.com/{i}"} for i in range(5)]
    clock = iter([0.0, 0.0, 1.0, 20.0, 21.0, 22.0, 23.0])
    with patch.object(sv, "_fetch", return_value="napa vineyards wedding") as fetch, \
            patch.object(sv.time, "monotonic", side_effect=lambda: next(clock)):
        kept = sv.filter_verified(QUERY, rows, max_seconds=15)
    # Two pages fit in the budget; the rest are not fetched.
    assert fetch.call_count == 2
    assert [row["url"] for row in kept] == [rows[0]["url"], rows[1]["url"]]
