"""Prompt visibility querysets: the shared catalog plus a tenant's own
private rows (owned or tracked), never another tenant's private rows,
and org access re-read from the current membership."""
import uuid

import pytest

from apps.accounts.models import Organization, OrganizationMember
from apps.accounts.tests.factories import UserFactory
from apps.prompt_library.models import BrandPrompt, Prompt, PromptSource
from apps.prompt_library.services._hash import text_hash
from apps.prompt_library.tests.factories import IndustryFactory, PromptFactory
from apps.websites.tests.factories import WebsiteFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def world():
    industry = IndustryFactory()
    mine, theirs = WebsiteFactory(), WebsiteFactory()
    catalog = PromptFactory(industry=industry, is_catalog=True)
    my_owned = PromptFactory(industry=industry, is_catalog=False, owner_website=mine)
    my_tracked = PromptFactory(industry=industry, is_catalog=False)
    BrandPrompt.objects.create(website=mine, prompt=my_tracked)
    their_owned = PromptFactory(industry=industry, is_catalog=False, owner_website=theirs)
    their_tracked = PromptFactory(industry=industry, is_catalog=False)
    BrandPrompt.objects.create(website=theirs, prompt=their_tracked)
    orphan = PromptFactory(industry=industry, is_catalog=False)
    return {
        "mine": mine, "theirs": theirs, "catalog": catalog, "my_owned": my_owned,
        "my_tracked": my_tracked, "their_owned": their_owned,
        "their_tracked": their_tracked, "orphan": orphan,
        "ids": {p.id for p in (catalog, my_owned, my_tracked, their_owned,
                               their_tracked, orphan)},
    }


def _ids(qs, world):
    return set(qs.values_list("id", flat=True)) & world["ids"]


def test_visible_to_website(world):
    got = _ids(Prompt.objects.visible_to_website(world["mine"]), world)
    assert got == {world["catalog"].id, world["my_owned"].id, world["my_tracked"].id}


def test_the_other_tenant_sees_its_own_not_mine(world):
    got = _ids(Prompt.objects.visible_to_website(world["theirs"]), world)
    assert got == {world["catalog"].id, world["their_owned"].id, world["their_tracked"].id}


def test_visible_to_user(world):
    got = _ids(Prompt.objects.visible_to_user(world["mine"].user), world)
    assert got == {world["catalog"].id, world["my_owned"].id, world["my_tracked"].id}


def test_a_stranger_sees_only_the_catalog(world):
    got = _ids(Prompt.objects.visible_to_user(UserFactory()), world)
    assert got == {world["catalog"].id}


def test_catalog_is_only_catalog_rows(world):
    assert _ids(Prompt.objects.catalog(), world) == {world["catalog"].id}


def test_org_member_sees_the_orgs_private_rows_until_removed(world):
    owner = UserFactory()
    org = Organization.objects.create(name="Acme", slug=f"acme-{uuid.uuid4().hex[:6]}",
                                      owner=owner)
    OrganizationMember.objects.create(organization=org, user=owner, role="owner")
    site = WebsiteFactory(user=owner, organization=org)
    private = PromptFactory(industry=world["catalog"].industry, is_catalog=False,
                            owner_website=site)
    world["ids"].add(private.id)
    viewer = UserFactory()
    membership = OrganizationMember.objects.create(organization=org, user=viewer, role="viewer")

    assert private.id in _ids(Prompt.objects.visible_to_user(viewer), world)

    membership.delete()
    viewer = type(viewer).objects.get(pk=viewer.pk)
    assert _ids(Prompt.objects.visible_to_user(viewer), world) == {world["catalog"].id}


def test_new_rows_are_private_by_default():
    prompt = Prompt.objects.create(
        industry=IndustryFactory(), text="typed by a tenant", intent_bucket="category",
        source=PromptSource.MANUAL, text_hash=text_hash("typed by a tenant"),
    )
    assert prompt.is_catalog is False
    assert prompt not in Prompt.objects.catalog()
