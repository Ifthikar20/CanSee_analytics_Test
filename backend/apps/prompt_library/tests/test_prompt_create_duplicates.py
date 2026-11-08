"""Adding a prompt whose text exists in more than one industry.

Prompt rows are unique per (industry, text_hash), so the miner and the
Search Console feed can leave the same text in two industries. The add
endpoint looked the row up by hash alone and answered 500
(MultipleObjectsReturned) for such text.
"""
from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.prompt_library.models import BrandPrompt, Prompt
from apps.prompt_library.tests.factories import IndustryFactory, PromptFactory
from apps.websites.tests.factories import WebsiteFactory

TEXT = "best crm for small business"


@pytest.fixture
def auth():
    user = UserFactory()
    website = WebsiteFactory(user=user)
    client = APIClient()
    client.force_authenticate(user=user)
    return client, website


def _add(client, website, text=TEXT):
    return client.post(
        f"/api/v1/prompt-library/websites/{website.id}/prompts/",
        {"text": text, "scan": False},
        format="json",
    )


@pytest.mark.django_db
def test_text_in_two_industries_is_added_not_500(auth):
    client, website = auth
    older = PromptFactory(industry=IndustryFactory(slug="crm"), text=TEXT)
    PromptFactory(industry=IndustryFactory(slug="smb"), text=TEXT)

    resp = _add(client, website)

    assert resp.status_code == 201, resp.content
    bp = BrandPrompt.objects.get(id=resp.json()["data"]["brand_prompt_id"])
    # The oldest matching row is reused; no third copy is created.
    assert bp.prompt_id == older.id
    assert Prompt.objects.filter(text_hash=older.text_hash).count() == 2


@pytest.mark.django_db
def test_re_adding_keeps_the_row_the_website_already_tracks(auth):
    client, website = auth
    PromptFactory(industry=IndustryFactory(slug="crm"), text=TEXT)
    tracked = PromptFactory(industry=IndustryFactory(slug="smb"), text=TEXT)
    BrandPrompt.objects.create(website=website, prompt=tracked)

    resp = _add(client, website)

    assert resp.status_code == 201, resp.content
    assert BrandPrompt.objects.filter(website=website).count() == 1
    assert resp.json()["data"]["brand_prompt_id"] == str(
        BrandPrompt.objects.get(website=website).id
    )


@pytest.mark.django_db
def test_new_text_creates_one_prompt(auth):
    client, website = auth
    resp = _add(client, website, text="which payroll tool suits a five person shop")
    assert resp.status_code == 201, resp.content
    bp = BrandPrompt.objects.select_related("prompt").get(
        id=resp.json()["data"]["brand_prompt_id"],
    )
    assert Prompt.objects.filter(text_hash=bp.prompt.text_hash).count() == 1
