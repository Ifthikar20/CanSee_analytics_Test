"""Tenancy edges of WebsiteService: two organizations side by side, the
per-user "created by" lists, the org owner without a membership row, and
project creation never reaching into another tenant's rows.
"""
import uuid

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.accounts.tests.factories import UserFactory
from apps.websites.models import Website
from apps.websites.services.website_service import WebsiteService
from apps.websites.tests.factories import WebsiteFactory
from core.exceptions import DuplicateWebsite, PermissionDenied, ResourceNotFound
from core.utils.constants import Plan

pytestmark = pytest.mark.django_db


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def make_org(name, plan=Plan.BUSINESS):
    owner = UserFactory()
    org = Organization.objects.create(
        name=name, slug=f"{name.lower()}-{uuid.uuid4().hex[:6]}", owner=owner, plan=plan,
    )
    OrganizationMember.objects.create(organization=org, user=owner, role="owner")
    return org


def join(org, role):
    user = UserFactory()
    OrganizationMember.objects.create(organization=org, user=user, role=role)
    return user


def fresh(user):
    return type(user).objects.get(pk=user.pk)


@pytest.fixture
def acme():
    return make_org("Acme")


@pytest.fixture
def globex():
    return make_org("Globex")


class TestTwoOrganizations:
    def test_members_see_only_their_own_orgs_projects(self, acme, globex):
        a_member = join(acme, "member")
        a_site = WebsiteFactory(user=acme.owner, organization=acme)
        g_site = WebsiteFactory(user=globex.owner, organization=globex)
        personal_elsewhere = WebsiteFactory()

        assert set(WebsiteService.accessible_qs(a_member)) == {a_site}
        assert set(WebsiteService.accessible_qs(globex.owner)) == {g_site}
        ids = {r["id"] for r in client_for(a_member).get("/api/v1/websites/").json()["data"]}
        assert ids == {str(a_site.id)}
        assert str(personal_elsewhere.id) not in ids

    def test_another_orgs_project_is_404_for_every_method(self, acme, globex):
        g_site = WebsiteFactory(user=globex.owner, organization=globex)
        client = client_for(acme.owner)
        path = f"/api/v1/websites/{g_site.id}/"
        assert client.get(path).status_code == 404
        assert client.put(path, {"name": "x"}, format="json").status_code == 404
        assert client.delete(path).status_code == 404
        assert client.post(f"{path}pixel/regenerate/").status_code == 404
        g_site.refresh_from_db()
        assert not g_site.is_deleted

    def test_a_strangers_personal_project_is_404(self):
        site = WebsiteFactory()
        stranger = UserFactory()
        assert WebsiteService.role_for(stranger, site) is None
        with pytest.raises(ResourceNotFound):
            WebsiteService.get_for_user(user=stranger, website_id=site.id, min_role="viewer")
        assert client_for(stranger).get(f"/api/v1/websites/{site.id}/").status_code == 404

    def test_a_non_uuid_id_is_404(self, acme):
        with pytest.raises(ResourceNotFound):
            WebsiteService.get_for_user(user=acme.owner, website_id="not-a-uuid")


class TestCreatedByLists:
    def test_created_by_excludes_teammates_projects(self, acme):
        bob = join(acme, "member")
        mine = WebsiteFactory(user=bob, organization=acme)
        WebsiteFactory(user=acme.owner, organization=acme)

        assert list(WebsiteService.created_by_qs(bob)) == [mine]
        assert list(WebsiteService.created_by_qs_with_role(bob, "member")) == [mine]
        assert len(WebsiteService.accessible_qs(bob)) == 2

    def test_user_without_an_org_keeps_their_personal_projects(self):
        site = WebsiteFactory()
        user = site.user
        assert list(WebsiteService.created_by_qs(user)) == [site]
        assert list(WebsiteService.created_by_qs_with_role(user, "admin")) == [site]

    def test_admin_min_role_keeps_only_personal_for_members(self, acme):
        bob = join(acme, "member")
        org_site = WebsiteFactory(user=bob, organization=acme)
        personal = WebsiteFactory(user=bob)
        assert list(WebsiteService.created_by_qs_with_role(bob, "admin")) == [personal]
        assert set(WebsiteService.created_by_qs_with_role(bob, "member")) == {org_site, personal}


class TestOrgOwnerWithoutMembershipRow:
    """The owner field stands in for a missing owner membership row."""

    def test_owner_still_resolves_as_owner(self, acme):
        site = WebsiteFactory(user=acme.owner, organization=acme)
        OrganizationMember.objects.filter(organization=acme, user=acme.owner).delete()
        assert WebsiteService.role_for(acme.owner, site) == "owner"
        got = WebsiteService.get_for_user(user=acme.owner, website_id=site.id, min_role="admin")
        assert got == site

    def test_nobody_else_gets_the_fallback(self, acme):
        site = WebsiteFactory(user=acme.owner, organization=acme)
        OrganizationMember.objects.filter(organization=acme, user=acme.owner).delete()
        stranger = UserFactory()
        assert WebsiteService.role_for(stranger, site) is None


class TestRoleLadderAtTheGate:
    @pytest.mark.parametrize("role, min_role, allowed", [
        ("viewer", "viewer", True), ("viewer", "member", False),
        ("member", "member", True), ("member", "admin", False),
        ("admin", "admin", True), ("admin", "owner", False),
        ("owner", "owner", True),
    ])
    def test_each_boundary(self, acme, role, min_role, allowed):
        user = acme.owner if role == "owner" else join(acme, role)
        site = WebsiteFactory(user=acme.owner, organization=acme)
        if allowed:
            assert WebsiteService.get_for_user(user=user, website_id=site.id, min_role=min_role)
        else:
            with pytest.raises(PermissionDenied):
                WebsiteService.get_for_user(user=user, website_id=site.id, min_role=min_role)

    def test_viewer_head_and_options_are_reads(self, acme):
        viewer = join(acme, "viewer")
        site = WebsiteFactory(user=acme.owner, organization=acme)
        client = client_for(viewer)
        assert client.head(f"/api/v1/websites/{site.id}/").status_code == 200
        assert client.options(f"/api/v1/websites/{site.id}/").status_code == 200

    def test_viewer_cannot_change_settings(self, acme):
        viewer = join(acme, "viewer")
        site = WebsiteFactory(user=acme.owner, organization=acme)
        resp = client_for(viewer).put(
            f"/api/v1/websites/{site.id}/settings/", {"weekly_report": False}, format="json",
        )
        assert resp.status_code == 403
        site.settings.refresh_from_db()
        assert site.settings.weekly_report is True

    def test_viewer_reads_the_pixel_but_cannot_rotate_it(self, acme):
        viewer = join(acme, "viewer")
        site = WebsiteFactory(user=acme.owner, organization=acme)
        client = client_for(viewer)
        assert client.get(f"/api/v1/websites/{site.id}/pixel/").status_code == 200
        before = site.pixel_key
        assert client.post(f"/api/v1/websites/{site.id}/pixel/regenerate/").status_code == 403
        site.refresh_from_db()
        assert site.pixel_key == before


class TestCreate:
    def test_org_user_creates_an_org_project(self, acme, settings):
        settings.PAYWALL_ENABLED = False
        bob = join(acme, "member")
        site = WebsiteService.create(user=bob, url="new-site.example", name="New")
        assert (site.organization_id, site.user_id) == (acme.id, bob.id)
        assert site in WebsiteService.accessible_qs(fresh(acme.owner))

    def test_same_url_in_another_org_is_not_a_duplicate(self, acme, globex):
        WebsiteService.create(user=globex.owner, url="shared.example", name="G")
        mine = WebsiteService.create(user=acme.owner, url="shared.example", name="A")
        assert mine.organization_id == acme.id
        assert Website.objects.filter(url="https://shared.example").count() == 2

    def test_same_url_in_the_same_org_is_a_duplicate(self, acme):
        WebsiteService.create(user=acme.owner, url="dup.example", name="One")
        with pytest.raises(DuplicateWebsite):
            WebsiteService.create(user=join(acme, "member"), url="dup.example", name="Two")

    def test_never_restores_another_orgs_deleted_project(self, acme, globex):
        theirs = WebsiteService.create(user=globex.owner, url="gone.example", name="Theirs")
        theirs.soft_delete(user=globex.owner)

        mine = WebsiteService.create(user=acme.owner, url="gone.example", name="Mine")

        assert mine.id != theirs.id
        assert mine.organization_id == acme.id
        theirs = Website.all_objects.get(id=theirs.id)
        assert (theirs.is_deleted, theirs.organization_id, theirs.name) == (
            True, globex.id, "Theirs")

    def test_restores_its_own_orgs_deleted_project(self, acme):
        old = WebsiteService.create(user=acme.owner, url="back.example", name="Old")
        old.soft_delete(user=acme.owner)
        again = WebsiteService.create(user=acme.owner, url="back.example", name="Again")
        assert again.id == old.id
        assert (again.is_deleted, again.name) == (False, "Again")

    def test_personal_create_never_restores_an_org_project(self, acme):
        org_site = WebsiteService.create(user=acme.owner, url="mixed.example", name="Org")
        org_site.soft_delete(user=acme.owner)
        loner = acme.owner
        OrganizationMember.objects.filter(user=loner).delete()
        loner = fresh(loner)

        personal = WebsiteService.create(user=loner, url="mixed.example", name="Personal")

        assert personal.id != org_site.id
        assert personal.organization_id is None
        assert Website.all_objects.get(id=org_site.id).is_deleted

    def test_personal_duplicate_check_ignores_org_projects(self, acme):
        WebsiteService.create(user=acme.owner, url="both.example", name="Org")
        OrganizationMember.objects.filter(user=acme.owner).delete()
        personal = WebsiteService.create(user=fresh(acme.owner), url="both.example", name="Mine")
        assert personal.organization_id is None

    def test_project_cap_counts_the_whole_org(self, settings):
        settings.PAYWALL_ENABLED = True
        org = make_org("Capped", plan=Plan.FREE)
        WebsiteFactory(user=org.owner, organization=org)
        bob = join(org, "member")

        resp = client_for(bob).post(
            "/api/v1/websites/", {"url": "second.example", "name": "Second"}, format="json",
        )

        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "project_limit_reached"
        assert resp.json()["error"]["meta"] == {"current": 1, "limit": 1}
        assert not Website.objects.filter(url__contains="second.example").exists()


class TestUpdateAndPixel:
    def test_regenerating_the_key_resets_verification(self):
        site = WebsiteFactory(pixel_verified=True)
        before = site.pixel_key
        resp = client_for(site.user).post(f"/api/v1/websites/{site.id}/pixel/regenerate/")
        assert resp.status_code == 200
        site.refresh_from_db()
        assert site.pixel_key != before
        assert resp.json()["data"]["pixel_key"] == str(site.pixel_key)
        assert (site.pixel_verified, site.pixel_verified_at) == (False, None)

    def test_update_writes_only_editable_fields(self):
        site = WebsiteFactory()
        owner = site.user
        other = UserFactory()
        WebsiteService.update(website=site, user=owner, name="Renamed", user_id=other.id,
                              pixel_verified=True, url="https://evil.example")
        site.refresh_from_db()
        assert site.name == "Renamed"
        assert site.user_id == owner.id
        assert site.pixel_verified is False
        assert site.url != "https://evil.example"

    def test_update_through_the_api_cannot_move_the_project(self, acme, globex):
        site = WebsiteFactory(user=acme.owner, organization=acme)
        resp = client_for(acme.owner).put(
            f"/api/v1/websites/{site.id}/",
            {"name": "Ok", "organization": str(globex.id), "user": str(globex.owner.id)},
            format="json",
        )
        assert resp.status_code == 200
        site.refresh_from_db()
        assert (site.organization_id, site.user_id, site.name) == (acme.id, acme.owner.id, "Ok")


def test_unknown_and_deleted_ids_are_404():
    site = WebsiteFactory()
    with pytest.raises(ResourceNotFound):
        WebsiteService.get_for_user(user=site.user, website_id=uuid.uuid4())
    site.soft_delete(user=site.user)
    with pytest.raises(ResourceNotFound):
        WebsiteService.get_for_user(user=site.user, website_id=site.id)
    assert client_for(site.user).get(f"/api/v1/websites/{site.id}/").status_code == 404


def test_competitors_are_stored_trimmed_and_blank_names_dropped():
    site = WebsiteFactory()
    WebsiteService.update(website=site, user=site.user, competitors=[
        {"name": "  Rival  ", "domain": " Rival.COM "},
        {"name": "NoDomain"},
        {"name": "   ", "domain": "ghost.com"},
        {"domain": "nameless.com"},
    ])
    site.refresh_from_db()
    assert site.competitors == [
        {"name": "Rival", "domain": "rival.com"},
        {"name": "NoDomain", "domain": ""},
    ]


class TestMemberWrites:
    def test_member_changes_settings(self, acme):
        bob = join(acme, "member")
        site = WebsiteFactory(user=acme.owner, organization=acme)
        resp = client_for(bob).put(
            f"/api/v1/websites/{site.id}/settings/", {"weekly_report": False}, format="json",
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["weekly_report"] is False
        site.settings.refresh_from_db()
        assert site.settings.weekly_report is False

    def test_member_runs_pixel_verification(self, acme, monkeypatch):
        from apps.websites.services.pixel_service import PixelService

        bob = join(acme, "member")
        site = WebsiteFactory(user=acme.owner, organization=acme)
        monkeypatch.setattr(PixelService, "verify", staticmethod(lambda *, website: False))
        resp = client_for(bob).post(f"/api/v1/websites/{site.id}/pixel/verify/")
        assert resp.status_code == 200
        assert resp.json()["data"] == {"verified": False, "pixel_key": str(site.pixel_key)}
