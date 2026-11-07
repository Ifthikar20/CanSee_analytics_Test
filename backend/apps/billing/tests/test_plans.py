"""The two plans: payloads, feature lines, plan resolution, limits (contract 1, 2)."""
import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.billing.services import plan_limits
from apps.billing.services.plan_limits import (
    limits_block,
    plan_allows,
    plan_for_subscription,
    subscription_state,
    tier_for_subscription,
)
from apps.billing.services.plan_service import PlanService
from apps.billing.tests.support import *  # noqa: F403
from apps.billing.tests.support import (
    Plan,
    SubscriptionStatus,
    client_for,
    data,
    fresh,
    make_website,
    subscribe,
    track,
)
from core.utils.constants import PLAN_LIMITS

pytestmark = pytest.mark.django_db

ENGINE_KEYS = {"gpt4": "OPENAI_API_KEY", "claude": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}


def _plan(plan_id):
    return next(p for p in PlanService.get_all_plans() if p["id"] == plan_id)


def _engines_on(settings, *providers):
    for provider in providers:
        setattr(settings, ENGINE_KEYS[provider], f"{provider}-test-key")


def test_the_list_is_free_the_two_plans_and_business_in_order():
    plans = PlanService.get_all_plans()
    assert [p["id"] for p in plans] == ["free", "prompts_100", "prompts_200", "business"]
    assert [p["id"] for p in plans if p["self_serve"]] == ["prompts_100", "prompts_200"]


def test_the_100_prompt_plan_matches_the_contract(settings):
    _engines_on(settings, "gpt4", "claude")
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    settings.SMS_ENABLED = True
    settings.TWILIO_ACCOUNT_SID = "AC-test"
    settings.TWILIO_AUTH_TOKEN = "test-token"
    settings.TWILIO_FROM_NUMBER = "+15005550006"

    assert _plan("prompts_100") == {
        "id": "prompts_100", "name": "100 prompts", "self_serve": True, "segment": "individual",
        "price_monthly": 80, "price_yearly": 0, "interval": "month", "trial_days": 0,
        "features": ["100 tracked prompts", "ChatGPT and Claude, asked every day",
                     "Google page one, checked every week", "One text a day with your results",
                     "$52 of AI usage a month", "5 projects"],
        "limits": {"projects": 5, "monthly_prompts": -1, "tracked_prompts": 100,
                   "autopilot": True, "sms_digest": True},
    }
    plan = _plan("prompts_200")
    assert (plan["name"], plan["price_monthly"], plan["limits"]["tracked_prompts"]) == (
        "200 prompts", 140, 200)
    assert plan["features"][0] == "200 tracked prompts"
    assert "$91 of AI usage a month" in plan["features"]


def test_feature_lines_promise_only_what_the_server_can_do(settings):
    # No engine, no Google provider, texts off.
    assert _plan("prompts_100")["features"] == [
        "100 tracked prompts", "$52 of AI usage a month", "5 projects"]
    _engines_on(settings, "claude")
    assert _plan("prompts_100")["features"][1] == "Claude, asked every day"
    _engines_on(settings, "gpt4", "gemini")
    assert _plan("prompts_100")["features"][1] == "ChatGPT, Claude and Gemini, asked every day"
    settings.SERPAPI_KEY = "serp-test-key"
    assert "Google page one, checked every week" in _plan("prompts_100")["features"]
    # SMS on without Twilio credentials is not a working text.
    settings.SMS_ENABLED = True
    assert "One text a day with your results" not in _plan("prompts_100")["features"]


def test_free_and_business_entries():
    free = _plan("free")
    assert free["features"] == ["1 project", "5 tracked prompts", "$1 of AI usage a month"]
    assert (free["self_serve"], free["price_monthly"], free["limits"]["tracked_prompts"]) == (
        False, 0, 5)
    assert free["limits"]["autopilot"] is False and free["limits"]["sms_digest"] is False
    business = _plan("business")
    assert (business["self_serve"], business["price_monthly"]) == (False, -1)
    assert business["limits"]["tracked_prompts"] == -1


def test_legacy_pro_is_hidden_but_still_resolves():
    pro = PlanService.get_plan("pro")
    assert (pro["id"], pro["name"], pro["self_serve"]) == ("pro", "Pro", False)
    assert pro["limits"]["tracked_prompts"] == 100
    assert PlanService.get_plan("growth")["id"] == "pro"
    assert PlanService.get_plan("prompts_200")["name"] == "200 prompts"
    assert PlanService.get_plan("mystery") is None


def test_plan_limits_for_every_plan():
    assert {k: PLAN_LIMITS[k]["tracked_prompts"] for k in (
        Plan.FREE, Plan.PROMPTS_100, Plan.PROMPTS_200, Plan.PRO, Plan.BUSINESS)} == {
        "free": 5, "prompts_100": 100, "prompts_200": 200, "pro": 100, "business": -1}
    for key in (Plan.PROMPTS_100, Plan.PROMPTS_200):
        limits = PLAN_LIMITS[key]
        assert (limits["monthly_prompts"], limits["trial_days"], limits["price_yearly"]) == (
            -1, 0, 0)
        assert limits["autopilot"] is True and limits["sms_digest"] is True
    assert PLAN_LIMITS[Plan.PRO]["autopilot"] is True
    assert PLAN_LIMITS[Plan.FREE]["autopilot"] is False
    # Legacy aliases point at Pro, so they carry the new keys too.
    assert PLAN_LIMITS[Plan.STARTER]["tracked_prompts"] == 100


def test_plans_are_public():
    resp = APIClient().get(reverse("billing-plans"))
    assert resp.status_code == 200
    assert [p["id"] for p in data(resp)] == ["free", "prompts_100", "prompts_200", "business"]
    # A stale token does not turn the public list into a 401.
    stale = APIClient()
    stale.credentials(HTTP_AUTHORIZATION="Bearer not-a-real-token")
    assert stale.get(reverse("billing-plans")).status_code == 200


@pytest.mark.parametrize("plan", [Plan.PROMPTS_100, Plan.PROMPTS_200])
def test_both_plans_resolve_as_themselves(user, plan):
    sub = subscribe(user, plan)
    assert plan_for_subscription(sub) == plan
    assert tier_for_subscription(sub) == plan
    state = subscription_state(sub)
    assert (state["plan"], state["tier"], state["is_paying"]) == (plan, plan, True)
    # A past-due row keeps its tier for the label but grants Free.
    sub.status = SubscriptionStatus.PAST_DUE
    assert (plan_for_subscription(sub), tier_for_subscription(sub)) == (Plan.FREE, plan)


def test_an_unknown_value_on_a_paid_row_still_reads_pro(user):
    sub = subscribe(user, Plan.PRO)
    sub.plan = "team-unknown"
    assert plan_for_subscription(sub) == Plan.PRO
    sub.plan = "growth"
    assert plan_for_subscription(sub) == Plan.PRO


def test_plan_allows_follows_the_plan(user, settings):
    # Paywall off: every account is on Business.
    assert plan_allows(user, "autopilot") is True and plan_allows(user, "sms_digest") is True
    settings.PAYWALL_ENABLED = True
    assert plan_allows(fresh(user), "autopilot") is False
    subscribe(user, Plan.PROMPTS_100)
    assert plan_allows(fresh(user), "autopilot") is True
    assert plan_allows(fresh(user), "sms_digest") is True
    assert plan_allows(fresh(user), "nonexistent_feature") is False


def test_limits_block(user, settings):
    website = make_website(user)
    track(website, 3)
    track(website, 2, archived=True)
    assert limits_block(user) == {
        "projects": -1, "tracked_prompts": {"limit": -1, "used": 3},
        "autopilot": True, "sms_digest": True,
    }
    settings.PAYWALL_ENABLED = True
    assert limits_block(fresh(user)) == {
        "projects": 1, "tracked_prompts": {"limit": 5, "used": 3},
        "autopilot": False, "sms_digest": False,
    }
    subscribe(user, Plan.PROMPTS_200)
    assert limits_block(fresh(user)) == {
        "projects": 5, "tracked_prompts": {"limit": 200, "used": 3},
        "autopilot": True, "sms_digest": True,
    }


def test_billing_overview_and_session_carry_the_limits(user, settings):
    settings.PAYWALL_ENABLED = True
    subscribe(user, Plan.PROMPTS_100)
    track(make_website(user), 9)
    expected = {"projects": 5, "tracked_prompts": {"limit": 100, "used": 9},
                "autopilot": True, "sms_digest": True}

    overview = data(client_for(fresh(user)).get(reverse("billing-overview")))
    assert overview["plan"] == "prompts_100"
    assert overview["limits"] == expected
    assert overview["plan_details"]["name"] == "100 prompts"
    assert overview["billing_ready"] is False

    session = data(client_for(fresh(user)).get(reverse("auth-session")))
    assert session["limits"] == expected
    assert session["subscription"]["plan"] == "prompts_100"


def test_the_resolver_returns_the_paid_plans():
    assert plan_limits.PAID_PLANS == (Plan.PROMPTS_100, Plan.PROMPTS_200, Plan.PRO, Plan.BUSINESS)


def test_the_google_line_follows_the_default_cadence(settings):
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    settings.AUTOPILOT_GOOGLE_CADENCE = "daily"
    assert "Google page one, checked every day" in _plan("prompts_100")["features"]
    settings.AUTOPILOT_GOOGLE_CADENCE = "weekly"
    assert "Google page one, checked every week" in _plan("prompts_100")["features"]

