"""One plan resolution for the AI allowance, its label and the session and
billing pages, on both sides of ORG_FEATURES_ENABLED (findings K2 and
be-integration-5)."""
import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.billing.models import Subscription
from apps.billing.services.plan_limits import _resolve_plan_key, org_plan_for
from apps.metering.services.usage_reader import allowance_status
from core.ai_tracking import AI_SPEND_CAP_RATIO, ai_allowance_plan, effective_ai_cap
from core.utils.constants import PLAN_LIMITS, Plan, SubscriptionStatus

pytestmark = pytest.mark.django_db

PRO_CAP = round(PLAN_LIMITS[Plan.PRO]["price_monthly"] * AI_SPEND_CAP_RATIO, 2)


@pytest.fixture
def caps(settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    settings.AI_ENTERPRISE_MONTHLY_CAP_USD = 500.0
    return settings


@pytest.fixture
def member(django_user_model):
    owner = django_user_model.objects.create_user(
        email="founder@acme.example", password="x" * 16, full_name="Founder",
    )
    org = Organization.objects.create(name="Acme", slug="acme", owner=owner, plan=Plan.BUSINESS)
    user = django_user_model.objects.create_user(
        email="jane@acme.example", password="x" * 16, full_name="Jane",
        is_email_verified=True,
    )
    OrganizationMember.objects.create(organization=org, user=user)
    return user


def _fresh(user):
    return type(user).objects.get(pk=user.pk)


def _pages(user):
    client = APIClient()
    client.force_authenticate(user)
    session = client.get("/api/v1/auth/session/")
    billing = client.get("/api/v1/billing/")
    assert session.status_code == 200, session.content
    assert billing.status_code == 200, billing.content
    session_body = session.json().get("data", session.json())
    billing_body = billing.json().get("data", billing.json())
    return session_body["subscription"], billing_body


def test_an_org_member_sees_the_org_plan_next_to_the_org_allowance(caps, member):
    caps.ORG_FEATURES_ENABLED = True

    status = allowance_status(_fresh(member))
    subscription, billing = _pages(_fresh(member))

    assert (status["plan"], status["cap_usd"]) == ("business", 500.0)
    assert subscription["plan"] == billing["plan"] == "business"
    assert subscription["source"] == billing["source"] == "organization"


def test_with_org_features_off_the_member_is_an_individual_everywhere(caps, member):
    caps.ORG_FEATURES_ENABLED = False

    status = allowance_status(_fresh(member))
    subscription, billing = _pages(_fresh(member))

    assert org_plan_for(_fresh(member)) is None
    assert effective_ai_cap(_fresh(member)) == 1.0
    assert (status["plan"], status["cap_usd"]) == ("free", 1.0)
    assert subscription["plan"] == billing["plan"] == "free"
    assert subscription["source"] == billing["source"] == "user"


def test_with_org_features_off_a_staged_member_keeps_their_own_subscription(caps, member):
    caps.ORG_FEATURES_ENABLED = False
    Subscription.objects.create(user=member, plan=Plan.PRO, status=SubscriptionStatus.ACTIVE)

    status = allowance_status(_fresh(member))

    assert (status["plan"], status["cap_usd"]) == ("pro", PRO_CAP)


def test_the_org_plan_wins_over_a_personal_subscription_in_the_label_too(caps, member):
    caps.ORG_FEATURES_ENABLED = True
    Subscription.objects.create(user=member, plan=Plan.PRO, status=SubscriptionStatus.ACTIVE)

    status = allowance_status(_fresh(member))

    assert (status["plan"], status["cap_usd"]) == ("business", 500.0)


def test_an_unknown_org_plan_is_labelled_with_the_free_cap_it_gets(caps, member):
    caps.ORG_FEATURES_ENABLED = True
    Organization.objects.update(plan="mystery")

    status = allowance_status(_fresh(member))

    assert ai_allowance_plan(_fresh(member)) == Plan.FREE
    assert (status["plan"], status["cap_usd"]) == ("free", 1.0)


def test_the_assistant_usage_line_names_the_org_plan(caps, member):
    from apps.assistant.services.providers import usage_lines

    caps.ORG_FEATURES_ENABLED = True

    lines = usage_lines(_fresh(member), None)

    assert lines[-1] == "Allowance: $0.0 of $500.0 (business plan)."


def test_feature_gates_follow_the_same_switch(caps, member):
    caps.PAYWALL_ENABLED = True
    caps.ORG_FEATURES_ENABLED = True
    assert _resolve_plan_key(_fresh(member)) == Plan.BUSINESS

    caps.ORG_FEATURES_ENABLED = False
    assert _resolve_plan_key(_fresh(member)) == Plan.FREE
