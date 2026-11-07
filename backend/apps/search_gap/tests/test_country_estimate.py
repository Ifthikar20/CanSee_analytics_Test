"""The estimate a user confirms before a country check runs: counts,
credits and dollar upper bounds, the per-check caps, the daily Google
quota, the monthly AI allowance, warnings, blockers, and request
validation."""
from decimal import Decimal

import pytest
from django.urls import reverse

from apps.search_gap.services import country_checks
from apps.search_gap.services.country_checks import estimate, parse_confirm, validate_request
from apps.search_gap.tests.country_support import *  # noqa: F403
from apps.search_gap.tests.country_support import body_for, data, make_prompt, make_run
from core.exceptions import CanseeException

pytestmark = pytest.mark.django_db

ASKED_MESSAGE = (
    "ChatGPT and Claude answer without web search here, so they are asked to answer for each "
    "country instead of searching from it."
)
UPPER_BOUND = (
    "These are upper bounds; checks stop early when your site is found and failed requests are "
    "not billed."
)


@pytest.fixture
def prompts(website):
    return [make_prompt(website, "best crm for startups"), make_prompt(website, "crm for teams")]


@pytest.fixture
def allowance(monkeypatch):
    """Sets the user's monthly AI allowance (cap 0 = unlimited) and spend."""
    from core import ai_tracking

    def set_allowance(cap: float, spent: float):
        monkeypatch.setattr(ai_tracking, "effective_ai_cap", lambda user: cap)
        monkeypatch.setattr(ai_tracking, "month_to_date_cost", lambda user: spent)

    return set_allowance


def _estimate(website, user, prompts, **body):
    countries = body.pop("countries", ["gb", "de"])
    engine_keys = body.pop("engines", ["chatgpt", "claude"])
    plan = validate_request(website, body_for(prompts, countries, engine_keys, **body))
    return estimate(website, user, plan)


def _codes(items):
    return [i["code"] for i in items]


def test_counts_credits_and_upper_bounds(website, user, prompts, fake_serp, engines):
    engines.enable("chatgpt", "claude")

    est = _estimate(website, user, prompts)

    assert est["cells"] == 2 * 2 * (2 + 1)
    assert est["google"] == {
        "included": True, "pages_max": 4, "credits_max": 100, "usd_max": "0.0000",
        "provider": "scraperapi", "provider_label": "ScraperAPI",
        "daily_limit": 100, "daily_left": 100, "enough_daily": True,
        "countries": [
            {"country": "gb", "method": "google_setting", "method_label": "Google set to GB, US connection"},
            {"country": "de", "method": "google_setting", "method_label": "Google set to DE, US connection"},
        ],
    }
    by_engine = {"answers": 4, "usd_max": "0.1200", "method": "asked",
                 "method_label": "Asked to answer for each country"}
    assert est["engines"] == {
        "answers": 8, "usd_max": "0.2400",
        "by_engine": [
            {"key": "chatgpt", "label": "ChatGPT", **by_engine},
            {"key": "claude", "label": "Claude", **by_engine},
        ],
    }
    # The free plan's allowance (AI_FREE_MONTHLY_CAP_USD in the test settings).
    assert est["allowance"] == {"unlimited": False, "cap_usd": "1.00", "left_usd": "1.00", "enough": True}
    assert est["confirm"] == {"google_pages": 4, "engine_answers": 8, "ai_usd_max": "0.2400"}
    assert est["blockers"] == [] and est["can_run"] is True


def test_two_google_pages_double_the_pages(website, user, prompts, serpapi, engines):
    # SerpAPI: ScraperAPI is read on page one only (serp_google.max_reliable_pages).
    engines.enable("chatgpt")

    est = _estimate(website, user, prompts, engines=["chatgpt"], google_pages=2)

    assert (est["google"]["pages_max"], est["google"]["credits_max"]) == (8, 0)
    assert est["cells"] == 2 * 2 * 2


def test_scraperapi_offers_the_top_10_only(website, user, prompts, fake_serp, engines, settings):
    # ScraperAPI's results past page one answer another query, so a country
    # check measures its top 10 only (pages contract options.limits.max_pages).
    engines.enable("chatgpt")
    assert country_checks.limits()["max_pages"] == 1
    assert _invalid(website, body_for(prompts, google_pages=2)) == (
        "google_pages", "Only the first Google results page (the top 10) can be checked.")
    assert validate_request(website, body_for(prompts, google_pages=1)).google_pages == 1
    settings.SCRAPERAPI_KEY, settings.SERPAPI_KEY = "", "serp-test-key"
    assert country_checks.limits()["max_pages"] == 2


def test_serpapi_bills_dollars_not_credits(website, user, prompts, serpapi, engines):
    engines.enable("chatgpt")

    est = _estimate(website, user, prompts[:1], engines=["chatgpt"], google_pages=2)

    google = est["google"]
    assert (google["provider"], google["credits_max"], google["usd_max"]) == ("serpapi", 0, "0.0600")
    assert google["countries"][0]["method_label"] == "Google set to GB"
    setting = next(w for w in est["warnings"] if w["code"] == "google_setting")
    assert setting["message"] == "Google results for GB and DE use Google's country setting."


def test_web_search_changes_the_bounds_and_methods(website, user, prompts, settings, engines):
    settings.LLM_WEBSEARCH_ENABLED = True
    engines.enable("chatgpt", "gemini", "perplexity")

    est = _estimate(website, user, prompts[:1], countries=["gb"],
                    engines=["perplexity", "gemini", "chatgpt"])

    rows = {r["key"]: (r["usd_max"], r["method"]) for r in est["engines"]["by_engine"]}
    assert list(rows) == ["chatgpt", "gemini", "perplexity"]
    assert rows == {"chatgpt": ("0.0800", "searched"), "gemini": ("0.0300", "asked"),
                    "perplexity": ("0.0300", "searched")}
    assert est["engines"]["usd_max"] == "0.1400"
    assert est["google"]["included"] is False and est["google"]["pages_max"] == 0
    asked = next(w for w in est["warnings"] if w["code"] == "asked_not_searched")
    assert asked["message"] == (
        "Gemini has no location setting here, so it is asked to answer for each country "
        "instead of searching from it."
    )


def test_warnings(website, user, prompts, fake_serp, engines):
    engines.enable("chatgpt", "claude")

    est = _estimate(website, user, prompts)

    assert est["warnings"] == [
        {"code": "asked_not_searched", "message": ASKED_MESSAGE},
        {"code": "google_setting",
         "message": "Google results for GB and DE use Google's country setting through a US connection."},
        {"code": "upper_bound", "message": UPPER_BOUND},
    ]


def test_searching_from_the_country_needs_no_google_warning(website, user, prompts, fake_serp,
                                                            settings):
    settings.SCRAPERAPI_GEO_COUNTRIES = "all"

    est = _estimate(website, user, prompts, engines=[])

    assert _codes(est["warnings"]) == ["upper_bound"]
    assert est["google"]["countries"][0]["method_label"] == "Searched from GB"
    assert est["engines"] == {"answers": 0, "usd_max": "0.0000", "by_engine": []}


def test_per_check_caps_block(website, user, prompts, fake_serp, engines, settings):
    engines.enable("chatgpt", "claude")
    settings.COUNTRY_CHECK_MAX_GOOGLE_PAGES = 3
    settings.COUNTRY_CHECK_MAX_ENGINE_ANSWERS = 7

    est = _estimate(website, user, prompts)

    assert est["can_run"] is False
    assert est["blockers"] == [
        {"code": "too_many_google_pages",
         "message": "This check needs up to 4 Google pages; the limit per check is 3. "
                    "Use fewer prompts, countries or pages."},
        {"code": "too_many_answers",
         "message": "This check needs 8 engine answers; the limit per check is 7. "
                    "Use fewer prompts, countries or engines."},
    ]


def test_daily_quota_left(website, user, prompts, fake_serp):
    country_checks.google_quota().consume(str(website.id), 98)

    est = _estimate(website, user, prompts, engines=[])

    assert (est["google"]["daily_left"], est["google"]["enough_daily"]) == (2, False)
    assert est["blockers"] == [{
        "code": "daily_limit",
        "message": "This project has 2 Google pages left today; this check needs up to 4.",
    }]


def test_allowance_enough_insufficient_exceeded_unlimited(website, user, prompts, engines, allowance):
    engines.enable("chatgpt", "claude")

    allowance(5.0, 0.92)
    est = _estimate(website, user, prompts)
    assert est["allowance"] == {"unlimited": False, "cap_usd": "5.00", "left_usd": "4.08", "enough": True}
    assert est["can_run"] is True

    allowance(5.0, 4.9)
    est = _estimate(website, user, prompts)
    assert est["allowance"]["enough"] is False
    assert est["blockers"] == [{
        "code": "insufficient_allowance",
        "message": "This check needs up to $0.24 of AI allowance and $0.10 is left this month.",
    }]

    allowance(5.0, 5.0)
    est = _estimate(website, user, prompts)
    assert est["blockers"] == [
        {"code": "allowance_exceeded", "message": "You have used your monthly AI allowance."},
    ]
    # Google alone spends no AI allowance.
    assert _estimate(website, user, prompts, engines=[], include_google=False)["blockers"] == [
        {"code": "nothing_to_check", "message": "Choose Google or at least one AI engine."},
    ]

    allowance(0.0, 12.0)
    est = _estimate(website, user, prompts)
    assert est["allowance"] == {"unlimited": True, "cap_usd": None, "left_usd": None, "enough": True}
    assert est["can_run"] is True


def test_an_active_check_blocks_another(website, user, prompts, engines):
    engines.enable("chatgpt")
    make_run(website, user, status="running")

    est = _estimate(website, user, prompts, engines=["chatgpt"])

    assert est["blockers"] == [
        {"code": "run_in_progress", "message": "A country check is running for this project."},
    ]


def _invalid(website, body):
    with pytest.raises(CanseeException) as caught:
        validate_request(website, body)
    exc = caught.value
    assert (exc.code, exc.status_code) == ("invalid", 400)
    assert exc.details["message"] == exc.message
    return exc.details["field"], exc.message


def test_country_validation(website, prompts, engines):
    engines.enable("chatgpt")
    assert _invalid(website, body_for(prompts, ["xx"])) == ("countries", "xx is not a supported country.")
    assert _invalid(website, body_for(prompts, ["global"]))[0] == "countries"
    assert _invalid(website, body_for(prompts, [])) == ("countries", "Choose at least one country.")
    assert _invalid(website, body_for(prompts, ["gb", "uk"])) == (
        "countries", "Each country can be chosen once.")
    six = ["gb", "de", "fr", "es", "it", "nl"]
    assert _invalid(website, body_for(prompts, six)) == ("countries", "Choose up to 5 countries.")
    # Google's "uk" is the ISO "gb".
    assert validate_request(website, body_for(prompts, ["UK", "de"])).countries == ["gb", "de"]


def test_prompt_validation(website, user, prompts, engines):
    engines.enable("chatgpt")
    archived = make_prompt(website, "an archived prompt", archived=True)
    other_site = type(website).objects.create(user=user, url="https://other.example", name="Other")
    foreign = make_prompt(other_site, "someone else's prompt")

    for bp in (archived, foreign):
        assert _invalid(website, body_for([bp])) == (
            "prompt_ids", f"No tracked prompt with id {bp.prompt_id} in this project.")
    assert _invalid(website, {**body_for(prompts), "prompt_ids": ["not-a-uuid"]}) == (
        "prompt_ids", "No tracked prompt with id not-a-uuid in this project.")
    assert _invalid(website, body_for([prompts[0], prompts[0]])) == (
        "prompt_ids", "Each prompt can be chosen once.")
    assert _invalid(website, {**body_for(prompts), "prompt_ids": []})[0] == "prompt_ids"
    plan = validate_request(website, body_for(list(reversed(prompts))))
    assert [bp.id for bp in plan.prompts] == [prompts[1].id, prompts[0].id]


def test_engine_and_google_validation(website, prompts, engines, settings):
    engines.enable("chatgpt", "claude")
    assert _invalid(website, body_for(prompts, engines=["gemini"])) == (
        "engines", "Gemini is not configured.")
    assert _invalid(website, body_for(prompts, engines=["bing"])) == (
        "engines", "bing is not an AI engine.")
    # Default: every configured engine, in display order; [] is Google only.
    body = body_for(prompts)
    del body["engines"]
    assert validate_request(website, body).engines == ["chatgpt", "claude"]
    assert validate_request(website, body_for(prompts, engines=[])).engines == []

    # No Google key: Google is off by default and cannot be asked for.
    assert validate_request(website, body).include_google is False
    assert _invalid(website, body_for(prompts, include_google=True)) == (
        "include_google", "Google results are not configured on this server.")
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    assert validate_request(website, body).include_google is True
    assert validate_request(website, body_for(prompts, include_google=False)).include_google is False

    # SerpAPI: ScraperAPI is read on page one only (test_scraperapi_offers_the_top_10_only).
    settings.SCRAPERAPI_KEY, settings.SERPAPI_KEY = "", "serp-test-key"
    for pages in (0, 3, True, "2"):
        assert _invalid(website, body_for(prompts, google_pages=pages)) == (
            "google_pages", "Choose 1 to 2 Google results pages.")
    assert validate_request(website, body_for(prompts, google_pages=2)).google_pages == 2


def test_confirm_parsing():
    confirm = parse_confirm({"confirm": {"google_pages": 4, "engine_answers": 8, "ai_usd_max": "0.16"}})
    assert confirm == {"google_pages": 4, "engine_answers": 8, "ai_usd_max": Decimal("0.16")}
    for bad in (None, {}, {"google_pages": 4, "engine_answers": 8},
                {"google_pages": -1, "engine_answers": 8, "ai_usd_max": "0.16"},
                {"google_pages": 4, "engine_answers": 8, "ai_usd_max": "NaN"},
                {"google_pages": 4, "engine_answers": 8, "ai_usd_max": "lots"}):
        with pytest.raises(CanseeException) as caught:
            parse_confirm({"confirm": bad})
        assert caught.value.details["field"] == "confirm"


def test_estimate_endpoint(api, website, prompts, fake_serp, engines):
    engines.enable("chatgpt", "claude")
    url = reverse("search-gap-country-estimate", kwargs={"website_id": website.id})

    resp = api.post(url, body_for(prompts, ["gb", "de"], ["chatgpt", "claude"]), format="json")

    assert resp.status_code == 200
    assert data(resp)["confirm"] == {"google_pages": 4, "engine_answers": 8, "ai_usd_max": "0.2400"}
    assert not website.country_runs.exists()

    resp = api.post(url, body_for(prompts, ["zz"]), format="json")
    assert resp.status_code == 400
    error = resp.json()["error"]
    assert error["code"] == "invalid"
    assert error["details"] == {"field": "countries", "message": "zz is not a supported country."}
