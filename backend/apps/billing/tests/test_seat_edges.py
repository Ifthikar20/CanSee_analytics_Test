"""Seat boundaries: what holds a seat, the exact cap edge on each plan,
and which number an accepted invitation is compared with."""
import secrets
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Invitation, OrganizationMember
from apps.accounts.services.org_service import OrgService, _hash_token
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


def invite_row(org, email, **fields):
    raw = secrets.token_urlsafe(16)
    defaults = {"expires_at": timezone.now() + timedelta(days=7)}
    defaults.update(fields)
    Invitation.objects.create(
        organization=org, email=email, role="member", token_hash=_hash_token(raw), **defaults,
    )
    return raw


def owner_of(org):
    return OrganizationMember.objects.get(organization=org, role="owner")


class TestWhatHoldsASeat:
    def test_only_live_pending_invites_hold_seats(self, make_user):
        org = org_with(make_user(), plan=Plan.PROMPTS_200)
        invite_row(org, "live@example.com")
        invite_row(org, "expired@example.com", expires_at=timezone.now() - timedelta(seconds=1))
        invite_row(org, "revoked@example.com", revoked_at=timezone.now())
        invite_row(org, "accepted@example.com", accepted_at=timezone.now())
        assert seats_used(org) == 2
        assert seats_block(org) == {"used": 2, "max": 5}

    def test_another_orgs_invites_do_not_count(self, make_user):
        org = org_with(make_user(), plan=Plan.PROMPTS_200)
        other = org_with(make_user(), plan=Plan.PROMPTS_200)
        for i in range(3):
            invite_row(other, f"o{i}@example.com")
        assert seats_used(org) == 1

    def test_revoking_an_invite_frees_its_seat(self, make_user):
        org = org_with(make_user(), plan=Plan.PROMPTS_100)
        OrganizationMember.objects.filter(organization=org).delete()  # no one yet
        invite_row(org, "a@example.com")
        assert not seat_available(org)
        invitation = Invitation.objects.get(organization=org)
        OrgService.revoke_invitation(acting=_fake_owner(org), invitation_id=invitation.id)
        assert seat_available(org)


def _fake_owner(org):
    return OrganizationMember(organization=org, user=org.owner, role="owner")


class TestTheCapEdge:
    @pytest.mark.parametrize(("plan", "cap"), [
        (Plan.FREE, 1), (Plan.PROMPTS_100, 1), (Plan.PROMPTS_200, 5),
    ])
    def test_one_below_the_cap_has_a_seat_and_the_cap_has_none(self, make_user, plan, cap):
        org = org_with(*(make_user() for _ in range(cap)), plan=plan)
        assert seats_used(org) == cap
        assert not seat_available(org)
        assert not seat_available(org, holding_invitation=True)
        if cap > 1:
            org.members.exclude(role="owner").first().delete()
            assert seats_used(org) == cap - 1
            assert seat_available(org)

    def test_two_hundred_plan_invites_up_to_exactly_five(self, make_user):
        org = org_with(make_user(), plan=Plan.PROMPTS_200)
        for i in range(4):
            OrgService.create_invitation(acting=owner_of(org), email=f"p{i}@example.com",
                                         role="member")
        assert seats_used(org) == 5
        with pytest.raises(CanseeException) as exc:
            OrgService.create_invitation(acting=owner_of(org), email="p5@example.com",
                                         role="member")
        assert exc.value.code == "plan_limit_exceeded"
        assert exc.value.details == {"used": 5, "limit": 5}
        assert Invitation.objects.filter(organization=org).count() == 4

    def test_accepting_compares_members_only(self, make_user):
        """At 4 members + 1 invite the invitee joins (5 of 5); a domain
        auto-join at the same moment is refused."""
        org = org_with(*(make_user() for _ in range(4)), plan=Plan.PROMPTS_200)
        invite_row(org, "five@example.com")
        assert seat_available(org, holding_invitation=True)
        assert not seat_available(org)

    def test_holding_an_invitation_at_a_full_member_list_is_refused(self, make_user):
        org = org_with(*(make_user() for _ in range(5)), plan=Plan.PROMPTS_200)
        assert not seat_available(org, holding_invitation=True)

    def test_free_org_owner_alone_cannot_add_anyone(self, make_user):
        org = org_with(make_user(), plan=Plan.FREE)
        assert seats_block(org) == {"used": 1, "max": 1}
        with pytest.raises(CanseeException) as exc:
            OrgService.create_invitation(acting=owner_of(org), email="x@example.com",
                                         role="member")
        assert exc.value.code == "plan_limit_exceeded"

    def test_business_is_unlimited_even_with_many_members(self, make_user):
        org = org_with(*(make_user() for _ in range(8)), plan=Plan.BUSINESS)
        assert seat_limit_for(org) == -1
        assert seat_available(org) and seat_available(org, holding_invitation=True)
        assert seats_block(org) is None


class TestContractSeats:
    def test_a_contract_raises_a_one_seat_plan(self, make_user):
        org = org_with(make_user(), plan=Plan.PROMPTS_100)
        org.seat_limit = 2
        org.save(update_fields=["seat_limit"])
        assert seat_available(org)
        OrgService.create_invitation(acting=owner_of(org), email="x@example.com", role="member")
        assert not seat_available(org)

    def test_a_contract_caps_business(self, make_user):
        org = org_with(make_user(), make_user(), plan=Plan.BUSINESS)
        org.seat_limit = 2
        org.save(update_fields=["seat_limit"])
        assert seats_block(org) == {"used": 2, "max": 2}
        assert not seat_available(org)


@pytest.mark.parametrize("legacy, seats", [
    ("starter", 5), ("growth", 5), ("individual", 5), ("enterprise", -1), ("scale", -1),
])
def test_legacy_plans_resolve_to_a_live_seat_count(make_user, legacy, seats):
    org = org_with(make_user(), plan=Plan.BUSINESS)
    org.plan = legacy
    assert seat_limit_for(org) == seats
    assert PLAN_LIMITS[legacy]["team_members"] == seats


def test_seats_used_counts_members_plus_invites_for_each_plan(make_user):
    org = org_with(make_user(), make_user(), plan=Plan.PROMPTS_200)
    invite_row(org, "a@example.com")
    invite_row(org, "b@example.com")
    assert seats_used(org) == 4
    assert seat_available(org)
    invite_row(org, "c@example.com")
    assert seats_used(org) == 5
    assert not seat_available(org)


class TestResendingAnInvitation:
    """A live invitation already holds its seat; an expired one gave it up,
    so bringing it back to life needs a free seat like a new invitation."""

    def test_a_live_invite_can_be_resent_when_the_org_is_full(self, make_user):
        org = org_with(*(make_user() for _ in range(4)), plan=Plan.PROMPTS_200)
        invite_row(org, "five@example.com")
        invitation = Invitation.objects.get(organization=org)
        OrgService.resend_invitation(acting=owner_of(org), invitation_id=invitation.id)
        assert seats_used(org) == 5

    def test_an_expired_invite_cannot_be_revived_past_the_cap(self, make_user):
        org = org_with(*(make_user() for _ in range(4)), plan=Plan.PROMPTS_200)
        invite_row(org, "late@example.com", expires_at=timezone.now() - timedelta(days=1))
        OrgService.create_invitation(acting=owner_of(org), email="new@example.com",
                                     role="member")
        assert seats_used(org) == 5
        expired = Invitation.objects.get(organization=org, email="late@example.com")

        with pytest.raises(CanseeException) as exc:
            OrgService.resend_invitation(acting=owner_of(org), invitation_id=expired.id)

        assert exc.value.code == "plan_limit_exceeded"
        expired.refresh_from_db()
        assert not expired.is_pending
        assert seats_used(org) == 5

    def test_an_expired_invite_is_revived_when_a_seat_is_free(self, make_user):
        org = org_with(*(make_user() for _ in range(4)), plan=Plan.PROMPTS_200)
        invite_row(org, "late@example.com", expires_at=timezone.now() - timedelta(days=1))
        expired = Invitation.objects.get(organization=org)
        OrgService.resend_invitation(acting=owner_of(org), invitation_id=expired.id)
        expired.refresh_from_db()
        assert expired.is_pending
        assert seats_used(org) == 5

    def test_the_resend_endpoint_answers_403_when_full(self, make_user):
        from apps.billing.tests.support import client_for

        org = org_with(*(make_user() for _ in range(5)), plan=Plan.PROMPTS_200)
        invite_row(org, "late@example.com", expires_at=timezone.now() - timedelta(days=1))
        expired = Invitation.objects.get(organization=org)
        resp = client_for(org.owner).post(
            f"/api/v1/orgs/current/invitations/{expired.id}/resend/")
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "plan_limit_exceeded"
        expired.refresh_from_db()
        assert not expired.is_pending


def _invite_at_once(owner, emails, monkeypatch):
    """Send one invitation per email from parallel threads. The seat count
    is read slowly to widen the gap between check and write, as under
    load. Returns each thread's outcome: "created" or the error code."""
    import threading
    import time

    from django.db import connection

    from apps.billing.services import org_entitlements

    real_seats_used = org_entitlements.seats_used

    def slow_seats_used(o):
        used = real_seats_used(o)
        time.sleep(0.3)
        return used

    monkeypatch.setattr(org_entitlements, "seats_used", slow_seats_used)
    start, outcomes = threading.Barrier(len(emails)), []

    def invite(email):
        try:
            start.wait(5)
            acting = OrganizationMember.objects.select_related("organization", "user").get(
                pk=owner.pk)
            OrgService.create_invitation(acting=acting, email=email, role="member")
            outcomes.append("created")
        except CanseeException as exc:
            outcomes.append(exc.code)
        except Exception as exc:  # noqa: BLE001 - the test reports what escaped
            outcomes.append(type(exc).__name__)
        finally:
            connection.close()

    threads = [threading.Thread(target=invite, args=(email,)) for email in emails]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    monkeypatch.setattr(org_entitlements, "seats_used", real_seats_used)
    return sorted(outcomes)


@pytest.mark.django_db(transaction=True)
def test_two_admins_inviting_at_once_cannot_both_take_the_last_seat(make_user, monkeypatch):
    """Four of five seats taken; two invitations are sent at the same
    moment: exactly one is created."""
    org = org_with(*(make_user() for _ in range(4)), plan=Plan.PROMPTS_200)
    outcomes = _invite_at_once(owner_of(org), ["race0@example.com", "race1@example.com"],
                               monkeypatch)
    assert outcomes == ["created", "plan_limit_exceeded"]
    assert Invitation.objects.filter(organization=org).count() == 1
    assert seats_used(org) == 5


@pytest.mark.django_db(transaction=True)
def test_a_double_submitted_invitation_is_created_once(make_user, monkeypatch):
    """The same address invited twice at once (a double click): one
    invitation, and the other request gets the clean already-invited
    answer instead of a database error."""
    org = org_with(make_user(), plan=Plan.PROMPTS_200)
    outcomes = _invite_at_once(owner_of(org), ["twice@example.com", "twice@example.com"],
                               monkeypatch)
    assert outcomes == ["already_invited", "created"]
    assert Invitation.objects.filter(organization=org).count() == 1
