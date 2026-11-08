"""Edges of the plan limits next to the free plan's prompt runs: the
monthly prompt allowance at its limit, which invitations hold a seat, a
lapsed trial, and a limit value that is not a number."""
import secrets
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Invitation
from apps.accounts.services.org_service import _hash_token
from apps.billing.services import org_entitlements, plan_limits, tracked_prompts
from apps.billing.tests.support import *  # noqa: F403
from apps.billing.tests.support import Plan, SubscriptionStatus, org_with, subscribe
from apps.llm_ranking.models import LLMRankingAudit
from apps.metering.services import prompt_runs
from core.exceptions import CanseeException
from core.utils.constants import PLAN_LIMITS

pytestmark = pytest.mark.django_db


def _audit(user, website, n):
    return LLMRankingAudit.objects.create(
        website=website, created_by=user, business_name="Northwind",
        prompts=[f"best crm {i}" for i in range(n)], providers_queried=["gpt4"],
    )


def _invitation(org, email, **fields):
    defaults = {"expires_at": timezone.now() + timedelta(days=7)}
    defaults.update(fields)
    return Invitation.objects.create(
        organization=org, email=email, role="member",
        token_hash=_hash_token(secrets.token_urlsafe(16)), **defaults,
    )


# -- the monthly prompt allowance ------------------------------------------------------


def test_the_allowance_is_reached_exactly_at_its_limit(user, website, paywall):
    subscribe(user, Plan.PRO)  # 100 prompts a month
    _audit(user, website, 97)
    from apps.billing.tests.support import fresh

    owner = fresh(user)
    org_entitlements.check_prompt_allowance(owner, 3)
    with pytest.raises(CanseeException) as caught:
        org_entitlements.check_prompt_allowance(owner, 4)
    err = caught.value
    assert (err.code, err.status_code) == ("prompt_allowance_exceeded", 403)
    assert err.details == {"used": 97, "limit": 100, "requested": 4}
    assert err.message == ("Monthly prompt allowance reached (97 of 100 used; 3 left). "
                           "The allowance resets at the start of next month.")


def test_a_used_up_allowance_says_nothing_is_left(user, website, paywall):
    subscribe(user, Plan.PRO)
    _audit(user, website, 100)
    from apps.billing.tests.support import fresh

    with pytest.raises(CanseeException) as caught:
        org_entitlements.check_prompt_allowance(fresh(user), 1)
    assert caught.value.message == ("Monthly prompt allowance reached (100 of 100 used). "
                                    "The allowance resets at the start of next month.")


def test_last_months_audits_do_not_use_this_months_allowance(user, website):
    old = _audit(user, website, 9)
    LLMRankingAudit.objects.filter(id=old.id).update(
        created_at=timezone.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        - timedelta(seconds=1))
    _audit(user, website, 2)
    assert org_entitlements.prompts_used_this_month(user) == 2


def test_with_the_paywall_off_a_personal_account_has_no_prompt_allowance(user, settings):
    settings.PAYWALL_ENABLED = False
    subscribe(user, Plan.PRO)
    assert org_entitlements.monthly_prompt_allowance_for(user) == -1
    org_entitlements.check_prompt_allowance(user, 10_000)


def test_with_the_paywall_on_the_plan_sets_the_allowance(user, paywall):
    assert org_entitlements.monthly_prompt_allowance_for(user) == -1  # Free: runs instead
    subscribe(user, Plan.PRO)
    from apps.billing.tests.support import fresh

    assert org_entitlements.monthly_prompt_allowance_for(fresh(user)) == 100


def test_a_negotiated_organization_allowance_binds_even_with_the_paywall_off(make_user, settings):
    settings.PAYWALL_ENABLED = False
    settings.ORG_FEATURES_ENABLED = True
    owner = make_user()
    org = org_with(owner, plan=Plan.BUSINESS)
    assert org_entitlements.monthly_prompt_allowance_for(owner) == 200
    org.monthly_prompt_allowance = 7
    org.save(update_fields=["monthly_prompt_allowance"])
    from apps.billing.tests.support import fresh

    assert org_entitlements.monthly_prompt_allowance_for(fresh(owner)) == 7
    org.monthly_prompt_allowance = 0
    org.save(update_fields=["monthly_prompt_allowance"])
    # Zero is a real contract number, not "no override".
    assert org_entitlements.monthly_prompt_allowance_for(fresh(owner)) == 0


# -- seats ------------------------------------------------------------------------------


def test_only_live_invitations_hold_a_seat(make_user, settings):
    settings.ORG_FEATURES_ENABLED = True
    owner = make_user()
    org = org_with(owner, plan=Plan.PROMPTS_200)  # five seats
    _invitation(org, "live@example.com")
    _invitation(org, "expired@example.com", expires_at=timezone.now() - timedelta(seconds=1))
    _invitation(org, "revoked@example.com", revoked_at=timezone.now())
    _invitation(org, "accepted@example.com", accepted_at=timezone.now())
    assert org_entitlements.seats_used(org) == 2  # the owner and the live invitation
    assert org_entitlements.seats_block(org) == {"used": 2, "max": 5}
    for n in range(3):
        _invitation(org, f"more{n}@example.com")
    assert org_entitlements.seat_available(org) is False
    # Accepting a held invitation compares only the members with the cap.
    assert org_entitlements.seat_available(org, holding_invitation=True) is True


# -- a lapsed trial ------------------------------------------------------------------------


def test_a_lapsed_trial_is_back_on_the_free_runs(user):
    subscribe(user, Plan.PROMPTS_100, status=SubscriptionStatus.TRIALING,
              current_period_start=timezone.now() - timedelta(days=16),
              current_period_end=timezone.now() - plan_limits.TRIAL_LAPSE_GRACE
              - timedelta(minutes=1))
    from apps.billing.tests.support import fresh

    owner = fresh(user)
    assert plan_limits.current_plan_for(owner) == Plan.FREE
    assert prompt_runs.limit_for(owner) == 20
    assert prompt_runs.is_limited(owner) is True


def test_a_trial_inside_its_grace_keeps_unlimited_runs(user):
    subscribe(user, Plan.PROMPTS_100, status=SubscriptionStatus.TRIALING,
              current_period_start=timezone.now() - timedelta(days=14),
              current_period_end=timezone.now() - timedelta(hours=1))
    from apps.billing.tests.support import fresh

    owner = fresh(user)
    assert plan_limits.current_plan_for(owner) == Plan.PROMPTS_100
    assert prompt_runs.limit_for(owner) == -1


# -- limit values ------------------------------------------------------------------------------


def test_a_tracked_prompt_limit_that_is_not_a_number_is_unlimited(user, paywall, monkeypatch):
    monkeypatch.setitem(PLAN_LIMITS[Plan.FREE], "tracked_prompts", True)
    assert tracked_prompts.limit_for(user) == -1
    monkeypatch.setitem(PLAN_LIMITS[Plan.FREE], "tracked_prompts", "5")
    assert tracked_prompts.limit_for(user) == -1
    monkeypatch.setitem(PLAN_LIMITS[Plan.FREE], "tracked_prompts", 5)
    assert tracked_prompts.limit_for(user) == 5


# -- callers without an account ----------------------------------------------------------------


class _BrokenSubscription:
    """A user whose subscription lookup fails (a database hiccup)."""

    pk = "broken"

    @property
    def subscription(self):
        raise RuntimeError("db gone")


def test_no_user_and_a_failing_subscription_read_as_free():
    assert plan_limits.current_plan_for(None) == Plan.FREE
    assert plan_limits.current_plan_for(_BrokenSubscription()) == Plan.FREE


def test_an_object_without_memberships_has_no_organization_plan(settings):
    settings.ORG_FEATURES_ENABLED = True
    assert plan_limits.org_plan_for(_BrokenSubscription()) is None
    assert plan_limits.org_plan_for(None) is None


def test_nobody_uses_tracked_prompts_or_the_monthly_allowance():
    assert tracked_prompts.used_by(None) == 0
    assert org_entitlements._deleted_prompts(None, timezone.now()) == 0
