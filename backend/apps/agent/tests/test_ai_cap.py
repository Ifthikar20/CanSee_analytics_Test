"""effective_ai_cap is organization-aware; individuals keep the free cap."""

import pytest

from apps.accounts.models import AITokenUsage, Organization, OrganizationMember
from apps.billing.models import Subscription
from apps.billing.services.plan_limits import get_limits, org_plan_for
from core.ai_tracking import AI_SPEND_CAP_RATIO, effective_ai_cap
from core.llm.base import allowance_denial
from core.utils.constants import PLAN_LIMITS, Plan, SubscriptionStatus

pytestmark = pytest.mark.django_db

PRO_CAP = round(PLAN_LIMITS[Plan.PRO]["price_monthly"] * AI_SPEND_CAP_RATIO, 2)


@pytest.fixture
def make_user(django_user_model):
    counter = iter(range(1, 100))

    def _make(**fields):
        n = next(counter)
        return django_user_model.objects.create_user(
            email=f"user{n}@example.com", password="x" * 16, full_name=f"User {n}", **fields,
        )

    return _make


def _org_member(make_user, plan=Plan.BUSINESS, **user_fields):
    owner = make_user()
    org = Organization.objects.create(name="Acme", slug=f"acme-{owner.pk}", owner=owner, plan=plan)
    member = make_user(**user_fields)
    OrganizationMember.objects.create(organization=org, user=member)
    return member


def _fresh(user):
    """Reload so cached org/subscription lookups do not leak between asserts."""
    return type(user).objects.get(pk=user.pk)


def test_no_user_is_unattributed():
    assert effective_ai_cap(None) == 0.0


@pytest.mark.parametrize("paywall", [False, True])
def test_individual_without_a_plan_keeps_the_free_cap(make_user, settings, paywall):
    settings.PAYWALL_ENABLED = paywall
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    user = make_user()

    assert effective_ai_cap(user) == 1.0
    # Paywall-off still opens every feature gate, but never the AI wallet.
    if not paywall:
        assert get_limits(user) is PLAN_LIMITS[Plan.BUSINESS]


def test_individual_free_cap_follows_the_setting(make_user, settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 2.5
    assert effective_ai_cap(make_user()) == 2.5


def test_individual_manual_cap_raises_the_free_cap(make_user):
    assert effective_ai_cap(make_user(monthly_ai_cost_cap_usd=5)) == 5.0


def test_individual_pro_subscription(make_user):
    user = make_user()
    Subscription.objects.create(user=user, plan=Plan.PRO, status=SubscriptionStatus.ACTIVE)

    assert effective_ai_cap(_fresh(user)) == PRO_CAP == 29.25


def test_org_member_gets_the_org_business_ceiling(make_user, settings):
    settings.AI_ENTERPRISE_MONTHLY_CAP_USD = 250.0
    member = _org_member(make_user, plan=Plan.BUSINESS)

    assert org_plan_for(_fresh(member)) == Plan.BUSINESS
    assert effective_ai_cap(_fresh(member)) == 250.0


@pytest.mark.parametrize("paywall", [False, True])
def test_org_cap_does_not_depend_on_the_paywall(make_user, settings, paywall):
    settings.PAYWALL_ENABLED = paywall
    settings.AI_ENTERPRISE_MONTHLY_CAP_USD = 500.0
    member = _org_member(make_user, plan=Plan.BUSINESS)

    assert effective_ai_cap(_fresh(member)) == 500.0


def test_org_member_on_a_pro_org_without_own_subscription(make_user):
    member = _org_member(make_user, plan=Plan.PRO)

    assert effective_ai_cap(_fresh(member)) == PRO_CAP


def test_org_member_on_a_free_org(make_user, settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    member = _org_member(make_user, plan=Plan.FREE)

    assert effective_ai_cap(_fresh(member)) == 1.0


def test_legacy_org_plan_maps_to_business(make_user, settings):
    settings.AI_ENTERPRISE_MONTHLY_CAP_USD = 300.0
    member = _org_member(make_user, plan=Plan.ENTERPRISE)

    assert org_plan_for(_fresh(member)) == Plan.BUSINESS
    assert effective_ai_cap(_fresh(member)) == 300.0


def test_org_manual_cap_sets_the_business_ceiling(make_user):
    member = _org_member(make_user, plan=Plan.BUSINESS, monthly_ai_cost_cap_usd=40)

    assert effective_ai_cap(_fresh(member)) == 40.0


def test_unknown_org_plan_grants_only_the_free_cap(make_user, settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    member = _org_member(make_user, plan=Plan.BUSINESS)
    Organization.objects.update(plan="mystery")

    assert effective_ai_cap(_fresh(member)) == 1.0


def test_org_plan_wins_over_a_personal_subscription(make_user, settings):
    settings.AI_ENTERPRISE_MONTHLY_CAP_USD = 500.0
    member = _org_member(make_user, plan=Plan.BUSINESS)
    Subscription.objects.create(user=member, plan=Plan.PRO, status=SubscriptionStatus.ACTIVE)

    assert effective_ai_cap(_fresh(member)) == 500.0


def test_org_plan_for_individuals_is_none(make_user):
    assert org_plan_for(make_user()) is None
    assert org_plan_for(None) is None


def test_feature_plan_resolution_is_unchanged(make_user, settings):
    """_resolve_plan_key now shares org_plan_for; its answers must not move."""
    from django.contrib.auth.models import AnonymousUser

    from apps.billing.services.plan_limits import _resolve_plan_key

    settings.PAYWALL_ENABLED = True
    individual = make_user()
    pro = make_user()
    Subscription.objects.create(user=pro, plan=Plan.PRO, status=SubscriptionStatus.ACTIVE)
    member = _org_member(make_user, plan=Plan.ENTERPRISE)

    assert _resolve_plan_key(_fresh(individual)) == Plan.FREE
    assert _resolve_plan_key(_fresh(pro)) == Plan.PRO
    assert _resolve_plan_key(_fresh(member)) == Plan.BUSINESS
    assert _resolve_plan_key(None) == Plan.PRO
    assert _resolve_plan_key(AnonymousUser()) == Plan.PRO

    settings.PAYWALL_ENABLED = False
    assert _resolve_plan_key(_fresh(individual)) == Plan.BUSINESS
    assert _resolve_plan_key(_fresh(member)) == Plan.BUSINESS


def test_org_lookup_is_cached_on_the_user(make_user, django_assert_num_queries):
    member = _fresh(_org_member(make_user, plan=Plan.PRO))
    with django_assert_num_queries(1):
        assert org_plan_for(member) == Plan.PRO
        assert org_plan_for(member) == Plan.PRO
    # User.effective_plan reads the same cache.
    assert member.effective_plan == Plan.PRO


def _spend(user, usd):
    AITokenUsage.objects.create(
        user=user, module="agent", provider="anthropic", model_name="claude-opus-5-5",
        estimated_cost_usd=usd,
    )


def test_allowance_denial_individual_over_the_free_cap(make_user, settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    user = make_user()
    _spend(user, 1.5)

    denial = allowance_denial(_fresh(user))
    assert denial and denial.startswith("monthly_ai_allowance_exceeded")


def test_allowance_denial_org_member_within_the_org_cap(make_user, settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 1.0
    settings.AI_ENTERPRISE_MONTHLY_CAP_USD = 500.0
    member = _org_member(make_user, plan=Plan.BUSINESS)
    _spend(member, 1.5)

    assert allowance_denial(_fresh(member)) is None
