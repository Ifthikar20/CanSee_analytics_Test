"""Who can reach an org project, re-checked on every request.

Access to an org-owned website goes by the caller's current membership and
role. Having created the website grants nothing once the creator is
removed from the organization or downgraded. Viewers read (200) and get a
403 on writes; anyone outside the organization gets a 404. Deleting a
project, rotating its pixel key and disconnecting an integration need
admin or above.
"""

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.accounts.services.org_service import OrgService
from apps.accounts.tests.factories import UserFactory
from apps.agent.services.access import can_write, is_project_admin
from apps.agent.services.team import team_ids
from apps.websites.models import Website
from apps.websites.services.website_service import WebsiteService
from apps.websites.tests.factories import WebsiteFactory

pytestmark = pytest.mark.django_db


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def org():
    owner = UserFactory(email="owner@example.com")
    organization = Organization.objects.create(name="Acme", slug="acme", owner=owner)
    OrganizationMember.objects.create(organization=organization, user=owner, role="owner")
    return organization


def join(org, role, email=None):
    user = UserFactory(**({"email": email} if email else {}))
    OrganizationMember.objects.create(organization=org, user=user, role=role)
    return user


def owner_membership(org):
    return OrganizationMember.objects.get(organization=org, user=org.owner)


@pytest.fixture
def creator(org):
    return join(org, "member", "creator@example.com")


@pytest.fixture
def project(org, creator):
    """An org project created by a plain member, as WebsiteService.create does."""
    return WebsiteFactory(user=creator, organization=org)


def detail(website):
    return f"/api/v1/websites/{website.id}/"


def remove(org, user):
    member = OrganizationMember.objects.get(organization=org, user=user)
    OrgService.remove_member(acting=owner_membership(org), member_id=member.id)


def change_role(org, user, role):
    member = OrganizationMember.objects.get(organization=org, user=user)
    OrgService.change_role(acting=owner_membership(org), member_id=member.id, role=role)


class TestRemovedCreator:
    def test_loses_read_and_write_access(self, org, creator, project):
        client = client_for(creator)
        assert client.get(detail(project)).status_code == 200

        remove(org, creator)

        assert client.get(detail(project)).status_code == 404
        assert client.put(detail(project), {"name": "Mine now"}, format="json").status_code == 404
        assert client.delete(detail(project)).status_code == 404
        assert client.get(f"/api/v1/websites/{project.id}/settings/").status_code == 404
        project.refresh_from_db()
        assert project.name != "Mine now"
        assert not project.is_deleted

    def test_project_leaves_their_list(self, org, creator, project):
        personal = WebsiteFactory(user=creator)
        remove(org, creator)

        resp = client_for(creator).get("/api/v1/websites/")
        assert resp.status_code == 200
        ids = {row["id"] for row in resp.json()["data"]}
        assert ids == {str(personal.id)}
        assert list(WebsiteService.accessible_qs(creator)) == [personal]

    def test_service_gate_and_agent_rules_refuse(self, org, creator, project):
        remove(org, creator)
        creator = type(creator).objects.get(pk=creator.pk)  # drop cached org id

        with pytest.raises(Exception) as exc:
            WebsiteService.get_for_user(user=creator, website_id=project.id, min_role="viewer")
        assert exc.value.status_code == 404
        assert WebsiteService.role_for(creator, project) is None
        assert not can_write(creator, project)
        assert not is_project_admin(creator, project)
        assert creator.id not in team_ids(project)

    def test_digests_stop_covering_the_project(self, org, creator, project):
        personal = WebsiteFactory(user=creator)
        assert set(WebsiteService.created_by_qs(creator)) == {project, personal}

        remove(org, creator)
        creator = type(creator).objects.get(pk=creator.pk)

        assert list(WebsiteService.created_by_qs(creator)) == [personal]

    def test_the_rest_of_the_org_keeps_access(self, org, creator, project):
        teammate = join(org, "member")
        remove(org, creator)

        assert client_for(teammate).get(detail(project)).status_code == 200
        assert client_for(org.owner).get(detail(project)).status_code == 200


class TestDowngradedCreator:
    def test_creator_downgraded_to_viewer_reads_but_cannot_write(self, org, creator, project):
        change_role(org, creator, "viewer")
        client = client_for(creator)

        assert client.get(detail(project)).status_code == 200
        resp = client.put(detail(project), {"name": "Renamed"}, format="json")
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "permission_denied"
        assert client.delete(detail(project)).status_code == 403
        project.refresh_from_db()
        assert project.name != "Renamed"
        assert not project.is_deleted
        assert not can_write(creator, project)
        assert creator.id not in team_ids(project)

    def test_admin_creator_downgraded_to_member_loses_admin_actions(self, org):
        admin = join(org, "admin")
        website = WebsiteFactory(user=admin, organization=org)
        assert is_project_admin(admin, website)

        change_role(org, admin, "member")

        assert not is_project_admin(admin, website)
        assert client_for(admin).delete(detail(website)).status_code == 403
        assert client_for(admin).get(detail(website)).status_code == 200


class TestViewer:
    def test_reads_work(self, org, project):
        viewer = join(org, "viewer")
        client = client_for(viewer)

        assert client.get(detail(project)).status_code == 200
        assert client.get(f"/api/v1/websites/{project.id}/settings/").status_code == 200
        assert client.get(f"/api/v1/llm-ranking/{project.id}/audits/").status_code == 200
        ids = {row["id"] for row in client.get("/api/v1/websites/").json()["data"]}
        assert str(project.id) in ids

    def test_writes_are_403_not_404(self, org, project):
        viewer = join(org, "viewer")
        client = client_for(viewer)

        for method, path, body in (
            ("put", detail(project), {"name": "x"}),
            ("patch", detail(project), {"name": "x"}),
            ("put", f"/api/v1/websites/{project.id}/settings/", {}),
            ("post", f"/api/v1/websites/{project.id}/pixel/verify/", {}),
        ):
            resp = getattr(client, method)(path, body, format="json")
            assert resp.status_code == 403, (method, path)
            assert resp.json()["error"]["message"] == (
                "Your organization role can view this project but not change it."
            )
        assert client.delete(detail(project)).status_code == 403

    def test_cannot_add_an_org_project(self, org, settings):
        settings.PAYWALL_ENABLED = False
        viewer = join(org, "viewer")
        resp = client_for(viewer).post(
            "/api/v1/websites/", {"url": "viewer-site.example", "name": "v"}, format="json",
        )
        assert resp.status_code == 403
        assert not Website.objects.filter(url__contains="viewer-site").exists()

    def test_stranger_still_gets_404(self, project):
        stranger = UserFactory()
        client = client_for(stranger)
        assert client.get(detail(project)).status_code == 404
        assert client.put(detail(project), {"name": "x"}, format="json").status_code == 404


class TestAdminOnlyProjectActions:
    @pytest.mark.parametrize("path, method", [
        ("/api/v1/websites/{id}/", "delete"),
        ("/api/v1/websites/{id}/pixel/regenerate/", "post"),
        ("/api/v1/search-console/{id}/connection/", "delete"),
    ])
    def test_members_are_refused(self, org, project, path, method):
        member = join(org, "member")
        before = project.pixel_key
        resp = getattr(client_for(member), method)(path.format(id=project.id))
        assert resp.status_code == 403
        assert resp.json()["error"]["message"] == "Only organization admins can do this."
        project.refresh_from_db()
        assert project.pixel_key == before
        assert not project.is_deleted

    def test_creator_who_is_a_plain_member_is_refused_too(self, creator, project):
        assert client_for(creator).delete(detail(project)).status_code == 403

    def test_admin_can_regenerate_and_delete(self, org, project):
        admin = join(org, "admin")
        client = client_for(admin)
        before = project.pixel_key

        assert client.post(f"/api/v1/websites/{project.id}/pixel/regenerate/").status_code == 200
        project.refresh_from_db()
        assert project.pixel_key != before

        assert client.delete(detail(project)).status_code == 204
        assert Website.all_objects.get(id=project.id).is_deleted

    def test_owner_can_delete(self, org, project):
        assert client_for(org.owner).delete(detail(project)).status_code == 204


class TestPersonalProjects:
    def test_owner_keeps_full_access(self):
        website = WebsiteFactory()
        client = client_for(website.user)
        assert client.get(detail(website)).status_code == 200
        assert client.post(f"/api/v1/websites/{website.id}/pixel/regenerate/").status_code == 200
        assert client.delete(detail(website)).status_code == 204

    def test_personal_project_survives_joining_and_leaving_an_org(self, org):
        user = UserFactory()
        website = WebsiteFactory(user=user)
        OrganizationMember.objects.create(organization=org, user=user, role="viewer")

        client = client_for(user)
        # A personal project is not governed by the org role.
        assert client.put(detail(website), {"name": "Still mine"}, format="json").status_code == 200
        remove(org, user)
        assert client.get(detail(website)).status_code == 200
