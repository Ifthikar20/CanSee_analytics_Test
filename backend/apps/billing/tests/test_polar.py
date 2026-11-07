"""Polar: the two gates, products by plan, checkout and plan changes (backend 2e, 2f)."""
import pytest
from django.urls import reverse

from apps.billing.services import polar_billing
from apps.billing.tests.support import *  # noqa: F403
from apps.billing.tests.support import (
    Plan,
    SubscriptionStatus,
    client_for,
    data,
    error,
    fresh,
    make_website,
    subscribe,
    track,
)

pytestmark = pytest.mark.django_db


def _set(settings, *, token=True, pro=False, plans=False):
    settings.POLAR_ACCESS_TOKEN = "polar_test_token" if token else ""
    settings.POLAR_PRODUCT_PRO_MONTHLY_ID = "prod_pro_m" if pro else ""
    settings.POLAR_PRODUCT_PRO_ANNUAL_ID = "prod_pro_y" if pro else ""
    settings.POLAR_PRODUCT_PROMPTS_100_ID = "prod_100" if plans else ""
    settings.POLAR_PRODUCT_PROMPTS_200_ID = "prod_200" if plans else ""


@pytest.mark.parametrize(("token", "pro", "plans", "configured", "ready"), [
    (False, True, True, False, False),
    (True, False, False, False, False),
    (True, True, False, True, False),
    (True, False, True, True, True),
    (True, True, True, True, True),
])
def test_the_two_gates(settings, token, pro, plans, configured, ready):
    _set(settings, token=token, pro=pro, plans=plans)
    assert polar_billing.is_configured() is configured
    assert polar_billing.checkout_ready() is ready


def test_one_new_product_is_not_enough_for_checkout(settings):
    _set(settings, plans=True)
    settings.POLAR_PRODUCT_PROMPTS_200_ID = ""
    assert polar_billing.is_configured() is True
    assert polar_billing.checkout_ready() is False


def test_products_map_to_plans_and_never_match_an_empty_setting(settings):
    _set(settings, plans=True)
    assert polar_billing._plan_for_product("prod_100") == Plan.PROMPTS_100
    assert polar_billing._plan_for_product("prod_200") == Plan.PROMPTS_200
    # Without the Pro ids, a Pro product is not ours (it would sync as cancelled).
    assert polar_billing._plan_for_product("prod_pro_m") is None
    assert polar_billing._plan_for_product("") is None
    _set(settings, pro=True, plans=True)
    assert polar_billing._plan_for_product("prod_pro_m") == Plan.PRO
    assert polar_billing._plan_for_product("prod_pro_y") == Plan.PRO
    _set(settings, pro=True, plans=False)
    assert polar_billing._plan_for_product("") is None
    assert polar_billing.product_id_for(Plan.PROMPTS_100) == ""
    assert polar_billing.product_id_for(Plan.PRO) == ""


@pytest.mark.parametrize("plan", ["prompts_100", "prompts_200"])
def test_checkout_by_plan(user, polar_ready, polar, plan):
    resp = client_for(user).post(reverse("billing-checkout"), {"plan": plan}, format="json")
    assert resp.status_code == 200
    assert data(resp)["data"]["checkout_url"].startswith("https://sandbox.polar.sh/checkout/")
    call = next(c for c in polar.calls if c[0] == "create_checkout")[1]
    assert call["product_ids"] == ["prod_100" if plan == "prompts_100" else "prod_200"]
    assert call["metadata"] == {"plan": plan}
    assert call["external_customer_id"] == str(user.id)


@pytest.mark.parametrize("body", [{}, {"plan": "pro"}, {"plan": "business"}, {"plan": "free"},
                                  {"plan": ["prompts_100"]}])
def test_checkout_refuses_other_plans(user, polar_ready, body):
    resp = client_for(user).post(reverse("billing-checkout"), body, format="json")
    assert resp.status_code == 400
    assert error(resp) == {"code": "invalid_plan", "message": "Choose the 100 or 200 prompt plan."}


def test_checkout_is_monthly_only(user, polar_ready):
    resp = client_for(user).post(
        reverse("billing-checkout"), {"plan": "prompts_100", "annual": True}, format="json")
    assert resp.status_code == 400
    assert error(resp) == {"code": "invalid_plan", "message": "Billing is monthly only."}


def test_checkout_waits_for_both_products(user, settings, polar):
    _set(settings, pro=True, plans=False)
    resp = client_for(user).post(reverse("billing-checkout"), {"plan": "prompts_100"}, format="json")
    assert resp.status_code == 503
    assert error(resp) == {"code": "billing_not_configured",
                           "message": "Checkout isn't set up yet."}
    assert not [c for c in polar.calls if c[0] == "create_checkout"]


def test_checkout_refuses_an_active_subscriber(user, polar_ready, polar):
    subscribe(user, Plan.PROMPTS_100, polar_subscription_id="sub_1")
    resp = client_for(user).post(reverse("billing-checkout"), {"plan": "prompts_200"}, format="json")
    assert resp.status_code == 400
    assert error(resp)["code"] == "already_subscribed"


def _managed(user, polar, plan, product, status=SubscriptionStatus.ACTIVE):
    sub = subscribe(user, plan, status, polar_subscription_id=f"sub_{user.pk}")
    polar.polar_subscription(
        sub.polar_subscription_id, product, owner=user,
        status="trialing" if status == SubscriptionStatus.TRIALING else "active",
    )
    return sub


def _plan_call(polar):
    return [c for c in polar.calls if c[0] == "update_subscription_plan"]


def test_moving_up_invoices_now(user, polar_ready, polar, settings):
    settings.PAYWALL_ENABLED = True
    _managed(user, polar, Plan.PROMPTS_100, "prod_100")
    resp = client_for(user).post(reverse("billing-change-plan"), {"plan": "prompts_200"},
                                 format="json")
    assert resp.status_code == 200
    out = data(resp)["data"]
    assert _plan_call(polar) == [("update_subscription_plan", f"sub_{user.pk}",
                                  {"product_id": "prod_200", "proration_behavior": "invoice"})]
    assert out["subscription"]["plan"] == "prompts_200"
    assert out["limits"]["tracked_prompts"] == {"limit": 200, "used": 0}
    assert fresh(user).subscription.plan == "prompts_200"
    assert fresh(user).plan == "prompts_200"


def test_moving_down_prorates(user, polar_ready, polar):
    _managed(user, polar, Plan.PROMPTS_200, "prod_200")
    track(make_website(user), 3)
    sub = polar_billing.change_plan(user, plan=Plan.PROMPTS_100)
    assert _plan_call(polar)[0][2] == {"product_id": "prod_100", "proration_behavior": "prorate"}
    assert sub.plan == "prompts_100"
    # Nothing is archived on a downgrade.
    assert user.websites.first().brand_prompts.filter(is_archived=False).count() == 3


def test_a_pro_subscriber_moves_up_and_a_pro_trial_moves_free(user, polar_ready, polar, settings):
    settings.POLAR_PRODUCT_PRO_MONTHLY_ID = "prod_pro_m"
    _managed(user, polar, Plan.PRO, "prod_pro_m")
    polar_billing.change_plan(user, plan=Plan.PROMPTS_100)
    assert _plan_call(polar)[-1][2]["proration_behavior"] == "invoice"

    trial_user = type(user).objects.create_user(email="trial@example.com", password="x" * 16)
    _managed(trial_user, polar, Plan.PRO, "prod_pro_m", status=SubscriptionStatus.TRIALING)
    polar_billing.change_plan(trial_user, plan=Plan.PROMPTS_200)
    assert _plan_call(polar)[-1][2] == {"product_id": "prod_200", "proration_behavior": None}


def test_already_on_the_plan(user, polar_ready, polar):
    _managed(user, polar, Plan.PROMPTS_200, "prod_200")
    resp = client_for(user).post(reverse("billing-change-plan"), {"plan": "prompts_200"},
                                 format="json")
    assert resp.status_code == 400
    assert error(resp) == {"code": "already_on_plan", "message": "You're already on 200 prompts."}
    assert not _plan_call(polar)


def test_plan_change_refusals(user, polar_ready, polar, settings):
    client = client_for(user)
    url = reverse("billing-change-plan")
    resp = client.post(url, {"plan": "prompts_200"}, format="json")
    assert (resp.status_code, error(resp)["code"]) == (400, "no_subscription")

    subscribe(user, Plan.PROMPTS_100, SubscriptionStatus.PAST_DUE, polar_subscription_id="sub_x")
    resp = client.post(url, {"plan": "prompts_200"}, format="json")
    assert (resp.status_code, error(resp)["code"]) == (400, "not_active")

    resp = client.post(url, {"plan": "business"}, format="json")
    assert error(resp) == {"code": "invalid_plan", "message": "Choose the 100 or 200 prompt plan."}
    resp = client.post(url, {}, format="json")
    assert error(resp)["code"] == "invalid_plan"

    settings.POLAR_PRODUCT_PROMPTS_200_ID = ""
    resp = client.post(url, {"plan": "prompts_200"}, format="json")
    assert resp.status_code == 503
    assert error(resp)["message"] == "Checkout isn't set up yet."


def test_a_failed_polar_call_reads_billing_failed(user, polar_ready, polar, monkeypatch):
    from apps.metering import polar_client

    _managed(user, polar, Plan.PROMPTS_100, "prod_100")

    def boom(*args, **kwargs):
        raise polar_client.PolarUnavailable("polar circuit open")

    monkeypatch.setattr(polar_client, "update_subscription_plan", boom)
    resp = client_for(user).post(reverse("billing-change-plan"), {"plan": "prompts_200"},
                                 format="json")
    assert resp.status_code == 400
    assert error(resp)["code"] == "billing_failed"


def test_the_annual_body_works_for_pro_rows_only(user, polar_ready, polar, settings):
    settings.POLAR_PRODUCT_PRO_MONTHLY_ID = "prod_pro_m"
    settings.POLAR_PRODUCT_PRO_ANNUAL_ID = "prod_pro_y"
    sub = _managed(user, polar, Plan.PRO, "prod_pro_m")
    sub.interval = "month"
    sub.save(update_fields=["interval"])
    resp = client_for(user).post(reverse("billing-change-plan"), {"annual": True}, format="json")
    assert resp.status_code == 200
    assert _plan_call(polar)[-1][2] == {"product_id": "prod_pro_y", "proration_behavior": "invoice"}
    assert "limits" in data(resp)["data"]

    other = type(user).objects.create_user(email="monthly@example.com", password="x" * 16)
    _managed(other, polar, Plan.PROMPTS_100, "prod_100")
    resp = client_for(other).post(reverse("billing-change-plan"), {"annual": True}, format="json")
    assert resp.status_code == 400
    assert error(resp) == {"code": "invalid_plan", "message": "Billing is monthly only."}


def test_the_pro_cadence_switch_needs_the_pro_products(user, polar_ready, polar):
    # Plan products only: billing is configured, but there is no annual Pro product.
    sub = _managed(user, polar, Plan.PRO, "prod_pro_m")
    sub.interval = "month"
    sub.save(update_fields=["interval"])
    resp = client_for(user).post(reverse("billing-change-plan"), {"annual": True}, format="json")
    assert resp.status_code == 503
    assert error(resp)["code"] == "billing_not_configured"
    assert not _plan_call(polar)


def test_sync_maps_the_new_products(user, polar_ready, polar):
    polar.polar_subscription("sub_sync", "prod_200", owner=user)
    sub = polar_billing.sync_from_customer_state(user)
    assert (sub.plan, sub.status) == ("prompts_200", SubscriptionStatus.ACTIVE)


def test_billing_ready_needs_both_products(user, settings, polar):
    _set(settings, pro=True)
    assert data(client_for(user).get(reverse("billing-overview")))["billing_ready"] is False
    _set(settings, plans=True)
    assert data(client_for(user).get(reverse("billing-overview")))["billing_ready"] is True
