"""Organization membership API: who may change roles, remove people and
invite, what each answer is, and that a change takes effect on the very
next request.

The ladder is owner > admin > member > viewer. Only the owner grants or
revokes admin and removes admins; nobody changes the owner or their own
row; viewers and members cannot manage anyone. Every refusal leaves the
rows as they were.
"""
import secrets
from datetime import timedelta
from decimal import Decimal

import pytest
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import AITokenUsage, Invitation, Organization, OrganizationMember
from apps.accounts.services.org_service import OrgService, _hash_token
from apps.accounts.tests.factories import UserFactory
from apps.websites.tests.factories import WebsiteFactory
from core.exceptions import CanseeException, PermissionDenied, ResourceNotFound
from core.utils.constants import Plan

pytestmark = pytest.mark.django_db

CURRENT = "/api/v1/orgs/current/"
MEMBERS = "/api/v1/orgs/current/members/"
INVITES = "/api/v1/orgs/current/invitations/"
USAGE = "/api/v1/orgs/current/usage/"


@pytest.fixture(autouse=True)
def org_features(settings):
    settings.ORG_FEATURES_ENABLED = True


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def org():
    owner = UserFactory(email="owner@acme.test", full_name="Olive Owner")
    organization = Organization.objects.create(
        name="Acme", slug=f"acme-{secrets.token_hex(4)}", owner=owner, plan=Plan.BUSINESS,
    )
    OrganizationMember.objects.create(organization=organization, user=owner, role="owner")
    return organization


def join(org, role, email=None):
    user = UserFactory(**({"email": email} if email else {}))
    OrganizationMember.objects.create(organization=org, user=user, role=role)
    return user


def member_row(org, user):
    return OrganizationMember.objects.get(organization=org, user=user)


def raw_invite(org, email, *, role="member", expires_in=timedelta(days=7), **fields):
    raw = secrets.token_urlsafe(16)
    Invitation.objects.create(
        organization=org, email=email, role=role, token_hash=_hash_token(raw),
        expires_at=timezone.now() + expires_in, **fields,
    )
    return raw


def error(resp):
    return resp.json()["error"]


# ── Role changes ────────────────────────────────────────────────────


class TestChangeRole:
    def test_owner_promotes_a_member_to_admin(self, org):
        bob = join(org, "member")
        resp = client_for(org.owner).patch(
            f"{MEMBERS}{member_row(org, bob).id}/", {"role": "admin"}, format="json",
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["role"] == "admin"
        assert member_row(org, bob).role == "admin"

    def test_admin_changes_member_to_viewer(self, org):
        admin = join(org, "admin")
        bob = join(org, "member")
        resp = client_for(admin).patch(
            f"{MEMBERS}{member_row(org, bob).id}/", {"role": "viewer"}, format="json",
        )
        assert resp.status_code == 200
        assert member_row(org, bob).role == "viewer"

    def test_admin_cannot_grant_admin(self, org):
        admin = join(org, "admin")
        bob = join(org, "member")
        resp = client_for(admin).patch(
            f"{MEMBERS}{member_row(org, bob).id}/", {"role": "admin"}, format="json",
        )
        assert resp.status_code == 403
        assert error(resp)["message"] == "Only the owner can grant or revoke admin."
        assert member_row(org, bob).role == "member"

    def test_admin_cannot_demote_another_admin(self, org):
        admin = join(org, "admin")
        other = join(org, "admin")
        resp = client_for(admin).patch(
            f"{MEMBERS}{member_row(org, other).id}/", {"role": "member"}, format="json",
        )
        assert resp.status_code == 403
        assert error(resp)["message"] == "Only the owner can grant or revoke admin."
        assert member_row(org, other).role == "admin"

    def test_owner_demotes_an_admin(self, org):
        admin = join(org, "admin")
        resp = client_for(org.owner).patch(
            f"{MEMBERS}{member_row(org, admin).id}/", {"role": "member"}, format="json",
        )
        assert resp.status_code == 200
        assert member_row(org, admin).role == "member"

    def test_owner_role_cannot_be_granted(self, org):
        bob = join(org, "member")
        resp = client_for(org.owner).patch(
            f"{MEMBERS}{member_row(org, bob).id}/", {"role": "owner"}, format="json",
        )
        assert resp.status_code == 403
        assert error(resp)["message"] == "That role can't be granted."
        assert member_row(org, bob).role == "member"
        assert OrganizationMember.objects.filter(organization=org, role="owner").count() == 1

    @pytest.mark.parametrize("role", ["", "editor", "superuser", "OWNER"])
    def test_unknown_roles_are_refused(self, org, role):
        bob = join(org, "member")
        resp = client_for(org.owner).patch(
            f"{MEMBERS}{member_row(org, bob).id}/", {"role": role}, format="json",
        )
        assert resp.status_code == 403
        assert member_row(org, bob).role == "member"

    def test_the_owner_row_cannot_be_changed(self, org):
        admin = join(org, "admin")
        owner_row = member_row(org, org.owner)
        for actor in (org.owner, admin):
            resp = client_for(actor).patch(
                f"{MEMBERS}{owner_row.id}/", {"role": "viewer"}, format="json",
            )
            assert resp.status_code == 403
            assert error(resp)["message"] == "The owner's role can't be changed."
        assert member_row(org, org.owner).role == "owner"

    def test_nobody_changes_their_own_role(self, org):
        admin = join(org, "admin")
        resp = client_for(admin).patch(
            f"{MEMBERS}{member_row(org, admin).id}/", {"role": "viewer"}, format="json",
        )
        assert resp.status_code == 403
        assert error(resp)["message"] == "You can't change your own role."
        assert member_row(org, admin).role == "admin"

    @pytest.mark.parametrize("role", ["member", "viewer"])
    def test_members_and_viewers_cannot_manage(self, org, role):
        actor = join(org, role)
        bob = join(org, "member")
        resp = client_for(actor).patch(
            f"{MEMBERS}{member_row(org, bob).id}/", {"role": "viewer"}, format="json",
        )
        assert resp.status_code == 403
        assert member_row(org, bob).role == "member"

    def test_a_member_of_another_org_is_not_found(self, org):
        other_owner = UserFactory()
        other = Organization.objects.create(name="Other", slug="other-org", owner=other_owner)
        OrganizationMember.objects.create(organization=other, user=other_owner, role="owner")
        outsider = join(other, "member")
        resp = client_for(org.owner).patch(
            f"{MEMBERS}{member_row(other, outsider).id}/", {"role": "viewer"}, format="json",
        )
        assert resp.status_code == 404
        assert member_row(other, outsider).role == "member"


class TestDowngradeTakesEffectNextRequest:
    def test_member_downgraded_to_viewer_loses_write_on_the_next_request(self, org):
        bob = join(org, "member")
        project = WebsiteFactory(user=org.owner, organization=org)
        client = client_for(bob)
        path = f"/api/v1/websites/{project.id}/"
        assert client.put(path, {"name": "First"}, format="json").status_code == 200

        client_for(org.owner).patch(
            f"{MEMBERS}{member_row(org, bob).id}/", {"role": "viewer"}, format="json",
        )

        assert client.put(path, {"name": "Second"}, format="json").status_code == 403
        assert client.get(path).status_code == 200
        project.refresh_from_db()
        assert project.name == "First"

    def test_admin_downgraded_to_member_loses_member_management(self, org):
        admin = join(org, "admin")
        bob = join(org, "member")
        client = client_for(admin)
        assert client.get(INVITES).status_code == 200

        client_for(org.owner).patch(
            f"{MEMBERS}{member_row(org, admin).id}/", {"role": "member"}, format="json",
        )

        assert client.get(INVITES).status_code == 403
        resp = client.delete(f"{MEMBERS}{member_row(org, bob).id}/")
        assert resp.status_code == 403
        assert OrganizationMember.objects.filter(organization=org, user=bob).exists()


# ── Removal ─────────────────────────────────────────────────────────


class TestRemoveMember:
    def test_admin_removes_a_member_and_their_access_ends(self, org):
        admin = join(org, "admin")
        bob = join(org, "member")
        project = WebsiteFactory(user=bob, organization=org)
        bob_client = client_for(bob)
        assert bob_client.get(f"/api/v1/websites/{project.id}/").status_code == 200

        resp = client_for(admin).delete(f"{MEMBERS}{member_row(org, bob).id}/")

        assert resp.status_code == 200
        assert not OrganizationMember.objects.filter(organization=org, user=bob).exists()
        assert bob_client.get(f"/api/v1/websites/{project.id}/").status_code == 404
        assert bob_client.get(CURRENT).status_code == 403

    def test_removal_revokes_the_removed_users_sessions_only(self, org):
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
        from rest_framework_simplejwt.tokens import RefreshToken

        bob = join(org, "member")
        carol = join(org, "member")
        bob_token = RefreshToken.for_user(bob)
        carol_token = RefreshToken.for_user(carol)

        OrgService.remove_member(acting=member_row(org, org.owner),
                                 member_id=member_row(org, bob).id)

        blacklisted = set(BlacklistedToken.objects.values_list("token__jti", flat=True))
        assert bob_token["jti"] in blacklisted
        assert carol_token["jti"] not in blacklisted

    def test_admin_cannot_remove_an_admin(self, org):
        admin = join(org, "admin")
        other = join(org, "admin")
        resp = client_for(admin).delete(f"{MEMBERS}{member_row(org, other).id}/")
        assert resp.status_code == 403
        assert error(resp)["message"] == "Only the owner can remove an admin."
        assert OrganizationMember.objects.filter(organization=org, user=other).exists()

    def test_owner_removes_an_admin(self, org):
        admin = join(org, "admin")
        resp = client_for(org.owner).delete(f"{MEMBERS}{member_row(org, admin).id}/")
        assert resp.status_code == 200
        assert not OrganizationMember.objects.filter(organization=org, user=admin).exists()

    def test_the_owner_cannot_be_removed(self, org):
        admin = join(org, "admin")
        resp = client_for(admin).delete(f"{MEMBERS}{member_row(org, org.owner).id}/")
        assert resp.status_code == 403
        assert error(resp)["message"] == "The owner can't be removed."
        assert member_row(org, org.owner)

    def test_admins_cannot_remove_themselves_here(self, org):
        admin = join(org, "admin")
        resp = client_for(admin).delete(f"{MEMBERS}{member_row(org, admin).id}/")
        assert resp.status_code == 403
        assert error(resp)["message"] == (
            "Leave the organization from your own account settings."
        )
        assert member_row(org, admin)

    def test_another_orgs_member_is_not_found(self, org):
        other_owner = UserFactory()
        other = Organization.objects.create(name="Other", slug="other-rm", owner=other_owner)
        OrganizationMember.objects.create(organization=other, user=other_owner, role="owner")
        outsider = join(other, "member")
        resp = client_for(org.owner).delete(f"{MEMBERS}{member_row(other, outsider).id}/")
        assert resp.status_code == 404
        assert member_row(other, outsider)

    @pytest.mark.parametrize("role", ["member", "viewer"])
    def test_members_and_viewers_cannot_remove(self, org, role):
        actor = join(org, role)
        bob = join(org, "member")
        assert client_for(actor).delete(f"{MEMBERS}{member_row(org, bob).id}/").status_code == 403
        assert member_row(org, bob)


# ── Listing and can_manage ──────────────────────────────────────────


class TestMemberList:
    def _can_manage(self, actor):
        rows = client_for(actor).get(MEMBERS).json()["data"]
        return {row["user"]["email"]: row["can_manage"] for row in rows}

    def test_owner_can_manage_everyone_but_themselves(self, org):
        join(org, "admin", "a@acme.test")
        join(org, "member", "m@acme.test")
        join(org, "viewer", "v@acme.test")
        assert self._can_manage(org.owner) == {
            "owner@acme.test": False, "a@acme.test": True,
            "m@acme.test": True, "v@acme.test": True,
        }

    def test_admin_manages_members_and_viewers_only(self, org):
        admin = join(org, "admin", "a@acme.test")
        join(org, "admin", "a2@acme.test")
        join(org, "member", "m@acme.test")
        join(org, "viewer", "v@acme.test")
        assert self._can_manage(admin) == {
            "owner@acme.test": False, "a@acme.test": False, "a2@acme.test": False,
            "m@acme.test": True, "v@acme.test": True,
        }

    def test_viewer_sees_the_list_and_manages_nobody(self, org):
        viewer = join(org, "viewer", "v@acme.test")
        join(org, "member", "m@acme.test")
        assert self._can_manage(viewer) == {
            "owner@acme.test": False, "v@acme.test": False, "m@acme.test": False,
        }

    def test_list_is_only_the_callers_org(self, org):
        other_owner = UserFactory(email="other@else.test")
        other = Organization.objects.create(name="Other", slug="other-list", owner=other_owner)
        OrganizationMember.objects.create(organization=other, user=other_owner, role="owner")
        join(org, "member", "m@acme.test")
        emails = {r["user"]["email"] for r in client_for(org.owner).get(MEMBERS).json()["data"]}
        assert emails == {"owner@acme.test", "m@acme.test"}

    def test_user_without_an_org_is_refused(self):
        loner = UserFactory()
        assert client_for(loner).get(MEMBERS).status_code == 403
        assert client_for(loner).get(CURRENT).status_code == 403

    def test_anonymous_is_refused(self):
        assert APIClient().get(MEMBERS).status_code == 401


class TestCurrentOrg:
    def test_reports_my_role_and_member_count(self, org):
        viewer = join(org, "viewer")
        join(org, "member")
        body = client_for(viewer).get(CURRENT).json()["data"]
        assert (body["name"], body["my_role"], body["member_count"]) == ("Acme", "viewer", 3)

    @pytest.mark.parametrize("role", ["member", "viewer"])
    def test_members_and_viewers_cannot_rename(self, org, role):
        actor = join(org, role)
        resp = client_for(actor).patch(CURRENT, {"name": "Hijacked"}, format="json")
        assert resp.status_code == 403
        org.refresh_from_db()
        assert org.name == "Acme"

    def test_admin_renames_but_cannot_change_the_plan(self, org):
        admin = join(org, "admin")
        resp = client_for(admin).patch(
            CURRENT, {"name": "Acme Ltd", "plan": "free", "require_sso": True}, format="json",
        )
        assert resp.status_code == 200
        org.refresh_from_db()
        assert (org.name, org.plan, org.require_sso) == ("Acme Ltd", Plan.BUSINESS, False)


class TestOrgFeaturesSwitch:
    @pytest.mark.parametrize("method, path", [
        ("get", CURRENT), ("get", MEMBERS), ("get", INVITES), ("get", USAGE),
        ("post", INVITES), ("get", "/api/v1/orgs/invitations/whatever/"),
    ])
    def test_every_org_route_is_404_when_off(self, org, settings, method, path):
        settings.ORG_FEATURES_ENABLED = False
        resp = getattr(client_for(org.owner), method)(path, {}, format="json")
        assert resp.status_code == 404
        assert not Invitation.objects.filter(organization=org).exists()


# ── Invitations ─────────────────────────────────────────────────────


class TestInvitations:
    def test_admin_invites_a_member(self, org):
        admin = join(org, "admin")
        resp = client_for(admin).post(
            INVITES, {"email": "  New@Example.COM ", "role": "member"}, format="json",
        )
        assert resp.status_code == 201
        invitation = Invitation.objects.get(organization=org)
        assert (invitation.email, invitation.role) == ("new@example.com", "member")
        assert invitation.invited_by == admin
        assert len(mail.outbox) == 1 and mail.outbox[0].to == ["new@example.com"]

    def test_only_the_owner_invites_admins(self, org):
        admin = join(org, "admin")
        resp = client_for(admin).post(INVITES, {"email": "x@example.com", "role": "admin"},
                                      format="json")
        assert resp.status_code == 403
        assert not Invitation.objects.filter(organization=org).exists()
        resp = client_for(org.owner).post(INVITES, {"email": "x@example.com", "role": "admin"},
                                          format="json")
        assert resp.status_code == 201

    @pytest.mark.parametrize("role", ["member", "viewer"])
    def test_members_and_viewers_cannot_invite(self, org, role):
        actor = join(org, role)
        resp = client_for(actor).post(INVITES, {"email": "x@example.com"}, format="json")
        assert resp.status_code == 403
        assert not Invitation.objects.filter(organization=org).exists()

    @pytest.mark.parametrize("role", ["owner", "superadmin"])
    def test_invitation_role_must_be_grantable(self, org, role):
        acting = member_row(org, org.owner)
        with pytest.raises(ValueError):
            OrgService.create_invitation(acting=acting, email="x@example.com", role=role)
        assert not Invitation.objects.filter(organization=org).exists()

    @pytest.mark.parametrize("email", ["", "   ", "not-an-email"])
    def test_invalid_email_is_refused(self, org, email):
        with pytest.raises(ValueError):
            OrgService.create_invitation(acting=member_row(org, org.owner), email=email,
                                         role="member")

    def test_someone_already_in_an_org_cannot_be_invited(self, org):
        other_owner = UserFactory(email="taken@else.test")
        other = Organization.objects.create(name="Other", slug="other-inv", owner=other_owner)
        OrganizationMember.objects.create(organization=other, user=other_owner, role="owner")
        with pytest.raises(CanseeException) as exc:
            OrgService.create_invitation(acting=member_row(org, org.owner),
                                         email="TAKEN@else.test", role="member")
        assert exc.value.code == "already_in_org"

    def test_a_second_pending_invite_for_the_same_address_is_refused(self, org):
        acting = member_row(org, org.owner)
        OrgService.create_invitation(acting=acting, email="x@example.com", role="member")
        with pytest.raises(CanseeException) as exc:
            OrgService.create_invitation(acting=acting, email="x@example.com", role="viewer")
        assert exc.value.code == "already_invited"
        assert Invitation.objects.filter(organization=org).count() == 1

    def test_an_expired_invite_is_retired_and_replaced(self, org):
        raw_invite(org, "x@example.com", expires_in=timedelta(seconds=-1))
        acting = member_row(org, org.owner)
        fresh = OrgService.create_invitation(acting=acting, email="x@example.com", role="member")
        old = Invitation.objects.exclude(pk=fresh.pk).get(organization=org)
        assert old.revoked_at is not None
        assert fresh.is_pending

    def test_listing_shows_only_live_invites(self, org):
        raw_invite(org, "live@example.com")
        raw_invite(org, "expired@example.com", expires_in=timedelta(seconds=-1))
        raw_invite(org, "revoked@example.com", revoked_at=timezone.now())
        raw_invite(org, "accepted@example.com", accepted_at=timezone.now())
        emails = [r["email"] for r in client_for(org.owner).get(INVITES).json()["data"]]
        assert emails == ["live@example.com"]

    def test_revoke_frees_the_invite(self, org):
        raw = raw_invite(org, "x@example.com")
        invitation = Invitation.objects.get(organization=org)
        resp = client_for(org.owner).delete(f"{INVITES}{invitation.id}/")
        assert resp.status_code == 200
        invitation.refresh_from_db()
        assert invitation.revoked_at is not None
        with pytest.raises(ResourceNotFound):
            OrgService.invitation_by_token(raw)

    def test_another_orgs_invite_cannot_be_revoked_or_resent(self, org):
        other_owner = UserFactory()
        other = Organization.objects.create(name="Other", slug="other-rev", owner=other_owner)
        OrganizationMember.objects.create(organization=other, user=other_owner, role="owner")
        raw_invite(other, "x@example.com")
        invitation = Invitation.objects.get(organization=other)
        client = client_for(org.owner)
        assert client.delete(f"{INVITES}{invitation.id}/").status_code == 404
        assert client.post(f"{INVITES}{invitation.id}/resend/").status_code == 404
        invitation.refresh_from_db()
        assert invitation.revoked_at is None

    def test_resend_rotates_the_token(self, org):
        raw = raw_invite(org, "x@example.com")
        invitation = Invitation.objects.get(organization=org)
        resp = client_for(org.owner).post(f"{INVITES}{invitation.id}/resend/")
        assert resp.status_code == 200
        with pytest.raises(ResourceNotFound):
            OrgService.invitation_by_token(raw)
        assert len(mail.outbox) == 1


class TestAcceptingAnInvitation:
    def test_accept_joins_with_the_invited_role_and_marks_it_used(self, org):
        raw = raw_invite(org, "joiner@example.com", role="viewer")
        joiner = UserFactory(email="joiner@example.com")
        resp = client_for(joiner).post(f"/api/v1/orgs/invitations/{raw}/accept/")
        assert resp.status_code == 200
        assert resp.json()["data"]["role"] == "viewer"
        assert member_row(org, joiner).role == "viewer"
        invitation = Invitation.objects.get(organization=org)
        assert invitation.accepted_at is not None
        # A used token is gone.
        resp = client_for(joiner).post(f"/api/v1/orgs/invitations/{raw}/accept/")
        assert resp.status_code == 404

    def test_a_different_account_cannot_accept(self, org):
        raw = raw_invite(org, "joiner@example.com")
        intruder = UserFactory(email="intruder@example.com")
        resp = client_for(intruder).post(f"/api/v1/orgs/invitations/{raw}/accept/")
        assert resp.status_code == 403
        assert error(resp)["code"] == "invitation_email_mismatch"
        assert not intruder.org_memberships.exists()
        assert Invitation.objects.get(organization=org).accepted_at is None

    def test_email_case_does_not_matter(self, org):
        raw = raw_invite(org, "joiner@example.com")
        joiner = UserFactory(email="Joiner@Example.com")
        OrgService.accept_invitation_existing(raw_token=raw, user=joiner)
        assert member_row(org, joiner)

    @pytest.mark.parametrize("fields", [
        {"expires_in": timedelta(seconds=-1)},
        {"revoked_at": timezone.now()},
        {"accepted_at": timezone.now()},
    ])
    def test_dead_tokens_are_not_found(self, org, fields):
        raw = raw_invite(org, "joiner@example.com", **fields)
        joiner = UserFactory(email="joiner@example.com")
        with pytest.raises(ResourceNotFound):
            OrgService.accept_invitation_existing(raw_token=raw, user=joiner)
        assert APIClient().get(f"/api/v1/orgs/invitations/{raw}/").status_code == 404
        assert not joiner.org_memberships.exists()

    def test_someone_in_another_org_cannot_accept(self, org):
        other_owner = UserFactory(email="busy@example.com")
        other = Organization.objects.create(name="Other", slug="other-acc", owner=other_owner)
        OrganizationMember.objects.create(organization=other, user=other_owner, role="owner")
        raw = raw_invite(org, "busy@example.com")
        with pytest.raises(CanseeException) as exc:
            OrgService.accept_invitation_existing(raw_token=raw, user=other_owner)
        assert exc.value.code == "already_in_org"
        assert list(other_owner.org_memberships.values_list("organization_id", flat=True)) == [
            other.id]

    def test_add_member_is_idempotent_for_the_same_org(self, org):
        bob = join(org, "member")
        again = OrgService.add_member(organization=org, user=bob, role="admin")
        assert again.role == "member"
        assert OrganizationMember.objects.filter(organization=org, user=bob).count() == 1


# ── Usage rollup ────────────────────────────────────────────────────


class TestOrgUsage:
    def test_admin_only(self, org):
        for role in ("member", "viewer"):
            assert client_for(join(org, role)).get(USAGE).status_code == 403
        assert client_for(join(org, "admin")).get(USAGE).status_code == 200

    def test_cost_is_this_month_for_members_only(self, org):
        bob = join(org, "member")
        outsider = UserFactory()
        now = timezone.now()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

        def spend(user, cost, when):
            row = AITokenUsage.objects.create(
                user=user, module="llm_ranking", model_name="claude",
                total_tokens=10, estimated_cost_usd=Decimal(cost),
            )
            AITokenUsage.objects.filter(pk=row.pk).update(created_at=when)

        spend(bob, "0.250000", now)
        spend(bob, "9.000000", month_start - timedelta(seconds=1))
        spend(outsider, "5.000000", now)

        body = client_for(org.owner).get(USAGE).json()["data"]
        by_email = {r["user"]["email"]: r for r in body["members"]}
        assert by_email[bob.email]["ai_cost_usd"] == pytest.approx(0.25)
        assert by_email[org.owner.email]["ai_cost_usd"] == 0
        assert outsider.email not in by_email
        assert body["totals"]["ai_cost_usd"] == pytest.approx(0.25)
        assert body["totals"]["members"] == 2
        assert body["seats"] == {"used": 2, "max": -1}


# ── Service-level refusals (no API in front) ────────────────────────


def test_change_role_service_refuses_without_writing(org):
    admin = join(org, "admin")
    bob = join(org, "member")
    with pytest.raises(PermissionDenied):
        OrgService.change_role(acting=member_row(org, admin),
                               member_id=member_row(org, bob).id, role="admin")
    assert member_row(org, bob).role == "member"


class TestSsoEnforcementIsOwnerOnly:
    SSO = "/api/v1/orgs/current/sso/enforce/"

    @pytest.mark.parametrize("role", ["admin", "member", "viewer"])
    def test_everyone_but_the_owner_is_refused(self, org, role):
        actor = join(org, role)
        resp = client_for(actor).post(self.SSO, {"enabled": True}, format="json")
        assert resp.status_code == 403
        org.refresh_from_db()
        assert org.require_sso is False

    def test_the_owner_is_checked_for_a_verified_domain(self, org):
        resp = client_for(org.owner).post(self.SSO, {"enabled": True}, format="json")
        assert resp.status_code == 400
        assert error(resp)["code"] == "domain_not_verified"
        org.refresh_from_db()
        assert org.require_sso is False


class TestTokenAddressedInvitationRoutes:
    def test_preview_shows_only_what_the_landing_page_needs(self, org):
        raw = raw_invite(org, "fresh@example.com", role="viewer")
        Invitation.objects.filter(organization=org).update(invited_by=org.owner)
        resp = APIClient().get(f"/api/v1/orgs/invitations/{raw}/")
        assert resp.status_code == 200
        body = resp.json()["data"]
        assert body["org"] == {"name": "Acme", "logo_url": ""}
        assert (body["email"], body["role"], body["invited_by_name"]) == (
            "fresh@example.com", "viewer", "Olive Owner")
        assert (body["user_exists"], body["sso_enforced"]) == (False, False)
        assert "id" not in body["org"] and "token_hash" not in body

    def test_preview_says_when_the_account_exists(self, org):
        raw = raw_invite(org, "known@example.com")
        UserFactory(email="Known@Example.com")
        body = APIClient().get(f"/api/v1/orgs/invitations/{raw}/").json()["data"]
        assert body["user_exists"] is True

    def test_register_creates_a_verified_member_and_logs_in(self, org):
        raw = raw_invite(org, "fresh@example.com", role="viewer")
        resp = APIClient().post(
            f"/api/v1/orgs/invitations/{raw}/register/",
            {"full_name": "  Fresh Person ", "password": "Tr0ub4dor&3-horse"}, format="json",
        )
        assert resp.status_code == 201
        body = resp.json()["data"]
        assert body["access"]
        assert body["org"] == {"id": str(org.id), "name": "Acme"}
        assert resp.cookies["refresh_token"].value
        user = type(org.owner).objects.get(email="fresh@example.com")
        assert (user.full_name, user.is_email_verified) == ("Fresh Person", True)
        assert member_row(org, user).role == "viewer"
        assert Invitation.objects.get(organization=org).accepted_at is not None

    def test_register_refuses_an_existing_account(self, org):
        raw = raw_invite(org, "known@example.com")
        UserFactory(email="known@example.com")
        resp = APIClient().post(
            f"/api/v1/orgs/invitations/{raw}/register/",
            {"full_name": "X", "password": "Tr0ub4dor&3-horse"}, format="json",
        )
        assert resp.status_code == 409
        assert error(resp)["code"] == "user_exists"
        assert not org.members.filter(user__email="known@example.com").exists()

    def test_register_with_a_dead_token_creates_nothing(self, org):
        raw = raw_invite(org, "late@example.com", expires_in=timedelta(seconds=-1))
        resp = APIClient().post(
            f"/api/v1/orgs/invitations/{raw}/register/",
            {"full_name": "X", "password": "Tr0ub4dor&3-horse"}, format="json",
        )
        assert resp.status_code == 404
        assert not type(org.owner).objects.filter(email="late@example.com").exists()

    def test_accept_needs_a_signed_in_account(self, org):
        raw = raw_invite(org, "fresh@example.com")
        assert APIClient().post(f"/api/v1/orgs/invitations/{raw}/accept/").status_code == 401
        assert Invitation.objects.get(organization=org).accepted_at is None
