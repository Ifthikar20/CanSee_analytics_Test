"""Seats per plan: the $80 plan has one, the $140 plan five, Free one and
Business no limit. Every path that adds a person is gated, and an org over
its cap after a plan change keeps everyone but cannot add more."""
import secrets
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Invitation, OrganizationMember
from apps.accounts.services.org_service import OrgService, _hash_token
from apps.accounts.tests.factories import UserFactory
from apps.billing.services.org_entitlements import (
    seat_available,
    seat_limit_for,
    seats_block,
    seats_used,
)
from apps.billing.tests.support import *  # noqa: F403
from apps.billing.tests.support import Plan, org_with
from core.exceptions import CanseeException
from core.utils.constants import PLAN_LIMITS

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def org_features(settings):
    settings.ORG_FEATURES_ENABLED = True


def _owner_membership(org):
    return OrganizationMember.objects.get(organization=org, role="owner")


def _invite(org, email):
    return OrgService.create_invitation(
        acting=_owner_membership(org), email=email, role="member",
    )


def _pending_invite(org, email):
    """An invitation as it would sit in the table, with its raw token."""
    raw = secrets.token_urlsafe(16)
    Invitation.objects.create(
        organization=org, email=email, role="member", token_hash=_hash_token(raw),
        expires_at=timezone.now() + timedelta(days=7),
    )
    return raw


def _error(exc_info):
    return exc_info.value.code


def test_seat_counts_per_plan():
    seats = {plan: PLAN_LIMITS[plan]["team_members"] for plan in (
        Plan.FREE, Plan.PROMPTS_100, Plan.PROMPTS_200, Plan.BUSINESS)}
    assert seats == {"free": 1, "prompts_100": 1, "prompts_200": 5, "business": -1}
    # Only the seat count differs between the two self-serve plans' seats.
    assert PLAN_LIMITS[Plan.PROMPTS_100]["tracked_prompts"] == 100
    assert PLAN_LIMITS[Plan.PROMPTS_200]["tracked_prompts"] == 200


@pytest.mark.parametrize(("plan", "limit"), [
    (Plan.PROMPTS_100, 1), (Plan.PROMPTS_200, 5), (Plan.FREE, 1), (Plan.BUSINESS, -1),
])
def test_org_seat_limit_follows_the_plan(make_user, plan, limit):
    org = org_with(make_user(), plan=plan)
    assert seat_limit_for(org) == limit


def test_a_contract_seat_count_wins(make_user):
    org = org_with(make_user(), plan=Plan.PROMPTS_100)
    org.seat_limit = 3
    org.save(update_fields=["seat_limit"])
    assert seat_limit_for(org) == 3


class TestTheHundredPromptPlan:
    def test_the_owner_takes_the_only_seat(self, make_user):
        org = org_with(make_user(), plan=Plan.PROMPTS_100)
        assert seats_block(org) == {"used": 1, "max": 1}
        assert not seat_available(org)
        with pytest.raises(CanseeException) as exc:
            _invite(org, "second@example.com")
        assert _error(exc) == "plan_limit_exceeded"
        assert not Invitation.objects.filter(organization=org).exists()

    def test_auto_join_is_refused(self, make_user):
        org = org_with(make_user(), plan=Plan.PROMPTS_100)
        newcomer = make_user()
        for via in ("domain_jit", "sso_jit", "admin"):
            with pytest.raises(CanseeException) as exc:
                OrgService.add_member(
                    organization=org, user=newcomer, role="member", joined_via=via,
                )
            assert _error(exc) == "no_seats_available"
        assert org.members.count() == 1


class TestTheTwoHundredPromptPlan:
    def test_five_seats_then_full(self, make_user):
        org = org_with(make_user(), make_user(), make_user(), plan=Plan.PROMPTS_200)
        _invite(org, "four@example.com")
        _invite(org, "five@example.com")
        assert seats_used(org) == 5
        with pytest.raises(CanseeException) as exc:
            _invite(org, "six@example.com")
        assert _error(exc) == "plan_limit_exceeded"

    def test_an_invitation_keeps_its_seat_when_accepted(self, make_user):
        org = org_with(make_user(), make_user(), make_user(), make_user(),
                       plan=Plan.PROMPTS_200)
        raw = _pending_invite(org, "five@example.com")
        assert seats_used(org) == 5
        joiner = UserFactory(email="five@example.com")
        OrgService.accept_invitation_existing(raw_token=raw, user=joiner)
        assert org.members.count() == 5

    def test_auto_join_needs_a_seat_beyond_pending_invites(self, make_user):
        org = org_with(make_user(), make_user(), make_user(), make_user(),
                       plan=Plan.PROMPTS_200)
        _pending_invite(org, "reserved@example.com")
        with pytest.raises(CanseeException) as exc:
            OrgService.add_member(
                organization=org, user=make_user(), role="member", joined_via="domain_jit",
            )
        assert _error(exc) == "no_seats_available"

    def test_auto_join_with_a_free_seat(self, make_user):
        org = org_with(make_user(), plan=Plan.PROMPTS_200)
        OrgService.add_member(
            organization=org, user=make_user(), role="member", joined_via="domain_jit",
        )
        assert org.members.count() == 2


class TestOverTheNewLimit:
    """A 100-prompt org that had three people before the plan had one seat."""

    @pytest.fixture
    def org(self, make_user):
        org = org_with(make_user(), make_user(), make_user(), plan=Plan.PROMPTS_100)
        self.raw = _pending_invite(org, "late@example.com")
        return org

    def test_nobody_loses_their_seat(self, org):
        assert org.members.count() == 3
        assert seats_block(org) == {"used": 4, "max": 1}
        members = list(org.members.values_list("user_id", flat=True))
        # Reading seats, refusing a new person and logging a member back in
        # leave every membership in place.
        with pytest.raises(CanseeException):
            _invite(org, "new@example.com")
        member = org.members.exclude(role="owner").first()
        again = OrgService.add_member(
            organization=org, user=member.user, role="member", joined_via="domain_jit",
        )
        assert again.pk == member.pk
        assert sorted(org.members.values_list("user_id", flat=True)) == sorted(members)

    def test_cannot_invite(self, org):
        with pytest.raises(CanseeException) as exc:
            _invite(org, "new@example.com")
        assert _error(exc) == "plan_limit_exceeded"

    def test_an_old_invitation_cannot_be_accepted(self, org, make_user):
        joiner = UserFactory(email="late@example.com")
        with pytest.raises(CanseeException) as exc:
            OrgService.accept_invitation_existing(raw_token=self.raw, user=joiner)
        assert _error(exc) == "plan_limit_exceeded"
        assert org.members.count() == 3
        assert not joiner.org_memberships.exists()

    def test_signing_up_through_an_old_invitation_leaves_no_account(self, org):
        from apps.accounts.models import User

        with pytest.raises(CanseeException) as exc:
            OrgService.register_via_invitation(
                raw_token=self.raw, full_name="Late Comer", password="Tr0ub4dor&3-horse",
            )
        assert _error(exc) == "plan_limit_exceeded"
        assert not User.objects.filter(email="late@example.com").exists()
        assert org.members.count() == 3

    def test_cannot_auto_join(self, org, make_user):
        with pytest.raises(CanseeException) as exc:
            OrgService.add_member(
                organization=org, user=make_user(), role="member", joined_via="sso_jit",
            )
        assert _error(exc) == "no_seats_available"

    def test_room_again_on_the_two_hundred_prompt_plan(self, org, make_user):
        org.plan = Plan.PROMPTS_200
        org.save(update_fields=["plan"])
        joiner = UserFactory(email="late@example.com")
        OrgService.accept_invitation_existing(raw_token=self.raw, user=joiner)
        assert org.members.count() == 4


def test_business_has_no_seat_cap(make_user):
    org = org_with(make_user(), plan=Plan.BUSINESS)
    for i in range(7):
        _invite(org, f"person{i}@example.com")
    assert seats_block(org) is None
    assert seat_available(org)
