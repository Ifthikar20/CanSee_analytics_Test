"""
Asserts the per-plan ``max_prompts_per_audit`` cap resolved by
``max_prompts_for_user``. Audits run the saved prompt list, which
``gather_saved_prompts`` caps with this lookup (covered in
test_saved_prompt_audits).
"""
from unittest.mock import MagicMock

import pytest

from core.utils.constants import Plan, SubscriptionStatus, max_prompts_for_user


@pytest.fixture(autouse=True)
def _paywall_on(settings):
    # These tests assert plan gating, which only applies while the
    # paywall is enabled (PAYWALL_ENABLED defaults to False).
    settings.PAYWALL_ENABLED = True


class _FakeSub:
    def __init__(self, plan, status=SubscriptionStatus.ACTIVE):
        self.plan = plan
        self.status = status


class _FakeUser:
    def __init__(self, plan):
        self.subscription = _FakeSub(plan) if plan else None


class TestMaxPromptsForUser:
    def test_pro_returns_15(self):
        assert max_prompts_for_user(_FakeUser(Plan.PRO)) == 15

    def test_business_returns_50(self):
        assert max_prompts_for_user(_FakeUser(Plan.BUSINESS)) == 50

    def test_legacy_individual_resolves_to_pro_limit(self):
        # The retired Individual tier aliases to Pro ($45).
        assert max_prompts_for_user(_FakeUser(Plan.INDIVIDUAL)) == 15

    def test_legacy_enterprise_resolves_to_business_limit(self):
        assert max_prompts_for_user(_FakeUser(Plan.ENTERPRISE)) == 50

    def test_no_subscription_falls_back_to_free(self):
        user = MagicMock()
        # The user belongs to no organization (org members resolve through
        # the org's plan instead): the membership lookup finds nothing.
        del user._org_or_none_cache
        user.org_memberships.select_related.return_value.order_by.return_value.first.return_value = None
        # Simulate the OneToOne reverse relation raising
        # Subscription.DoesNotExist when accessed.
        type(user).subscription = property(
            fget=lambda self: (_ for _ in ()).throw(AttributeError("missing")),
        )
        # The helper should not propagate the error; no subscription
        # resolves to the Free plan cap.
        assert max_prompts_for_user(user) == 5

    def test_unknown_plan_falls_back_to_pro(self):
        # An ACTIVE subscription on an unrecognised plan honours the
        # payment and resolves to the Pro cap.
        assert max_prompts_for_user(_FakeUser("ghost-tier")) == 15

    def test_legacy_starter_resolves_to_pro_limit(self):
        # Subscriptions on the old "starter" plan should keep working.
        assert max_prompts_for_user(_FakeUser(Plan.STARTER)) == 15
