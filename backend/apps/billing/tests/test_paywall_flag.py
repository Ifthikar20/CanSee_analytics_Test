"""
Tests for the PAYWALL_ENABLED master switch.

When PAYWALL_ENABLED is False (the default):
    - SessionView never returns next_route == "paywall"; onboarding
      still comes first, then users go straight to the app.
    - The audit prompt cap resolves to the top tier.

When PAYWALL_ENABLED is True the original gating behaviour applies
unchanged, so flipping the env var restores the paywall with no code
change. (The plan-limit, feature-flag, integration-registry and DRF
permission layers this file used to cover were removed as dead code in
3320cdf; plan gating is covered in test_plans.py.)
"""
import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.billing.models import Subscription
from apps.websites.tests.factories import WebsiteFactory
from core.utils.constants import SubscriptionStatus, max_prompts_for_user

SESSION_URL = "/api/v1/auth/session/"


@pytest.fixture
def user(db):
    return UserFactory(plan="starter")


def _session(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client.get(SESSION_URL).data


@pytest.mark.django_db
class TestSessionRouting:
    def test_paywall_off_unpaid_user_goes_to_app(self, user, settings):
        settings.PAYWALL_ENABLED = False
        WebsiteFactory(user=user)
        data = _session(user)
        assert data["next_route"] == "app"
        assert data["subscription"]["is_paying"] is False

    def test_paywall_on_unpaid_user_goes_to_paywall(self, user, settings):
        settings.PAYWALL_ENABLED = True
        WebsiteFactory(user=user)
        assert _session(user)["next_route"] == "paywall"

    def test_onboarding_still_first_with_paywall_off(self, user, settings):
        settings.PAYWALL_ENABLED = False
        assert _session(user)["next_route"] == "onboarding"

    def test_paywall_on_paying_user_goes_to_app(self, user, settings):
        settings.PAYWALL_ENABLED = True
        WebsiteFactory(user=user)
        Subscription.objects.create(
            user=user, status=SubscriptionStatus.ACTIVE, plan="starter",
        )
        data = _session(user)
        assert data["next_route"] == "app"
        assert data["subscription"]["is_paying"] is True

    def test_paywall_on_dismissed_user_goes_to_app(self, user, settings):
        settings.PAYWALL_ENABLED = True
        WebsiteFactory(user=user)
        user.paywall_dismissed_at = timezone.now()
        user.save(update_fields=["paywall_dismissed_at", "updated_at"])
        data = _session(user)
        assert data["next_route"] == "app"
        assert data["paywall_dismissed"] is True

    def test_paywall_off_dismissed_user_goes_to_app(self, user, settings):
        settings.PAYWALL_ENABLED = False
        WebsiteFactory(user=user)
        user.paywall_dismissed_at = timezone.now()
        user.save(update_fields=["paywall_dismissed_at", "updated_at"])
        assert _session(user)["next_route"] == "app"

    def test_onboarding_still_first_when_dismissed(self, user, settings):
        settings.PAYWALL_ENABLED = True
        user.paywall_dismissed_at = timezone.now()
        user.save(update_fields=["paywall_dismissed_at", "updated_at"])
        assert _session(user)["next_route"] == "onboarding"

    def test_paywall_on_dismissed_paying_user_goes_to_app(self, user, settings):
        settings.PAYWALL_ENABLED = True
        WebsiteFactory(user=user)
        user.paywall_dismissed_at = timezone.now()
        user.save(update_fields=["paywall_dismissed_at", "updated_at"])
        Subscription.objects.create(
            user=user, status=SubscriptionStatus.ACTIVE, plan="pro",
        )
        data = _session(user)
        assert data["next_route"] == "app"
        assert data["subscription"]["is_paying"] is True


@pytest.mark.django_db
class TestEntitlementBypass:
    def test_max_prompts_uses_enterprise_cap(self, user, settings):
        settings.PAYWALL_ENABLED = False
        assert max_prompts_for_user(user) == 50
        settings.PAYWALL_ENABLED = True
        assert max_prompts_for_user(user) == 5  # no subscription -> Free cap
