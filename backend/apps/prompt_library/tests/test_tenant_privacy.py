"""Tenant-authored prompts stay private; the shared catalog stays curated.

Covers three confirmed bugs:
- prompts a tenant types (and their Search Console queries and topic
  names) were readable by every user through the catalog endpoints;
- effectiveness scores mixed every tenant's results and the endpoint
  answered for any prompt id;
- any user could write LLM-generated prompts into the catalog with up to
  51 LLM calls per request.
"""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services.effectiveness import refresh_all_effectiveness_scores
from apps.prompt_library.tests.factories import IndustryFactory, PromptFactory
from apps.websites.tests.factories import WebsiteFactory

pytestmark = pytest.mark.django_db

PRIVATE_TEXT = "is acme crm better than rivalsoft for dentists in leeds"


def _data(resp):
    body = resp.json()
    assert body["success"] is True, body
    return body["data"]


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def tenant_a():
    user = UserFactory()
    return SimpleNamespace(user=user, website=WebsiteFactory(user=user, industry="saas"),
                           client=_client(user))


@pytest.fixture
def tenant_b():
    user = UserFactory()
    return SimpleNamespace(user=user, website=WebsiteFactory(user=user, industry="saas"),
                           client=_client(user))


def _add_prompt(tenant, text=PRIVATE_TEXT, **extra):
    resp = tenant.client.post(
        f"/api/v1/prompt-library/websites/{tenant.website.id}/prompts/",
        {"text": text, "scan": False, **extra},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    return Prompt.objects.get(id=_data(resp)["id"])


def _listed_texts(tenant, **params):
    resp = tenant.client.get("/api/v1/prompt-library/prompts/", params)
    assert resp.status_code == 200
    return [row["text"] for row in _data(resp)]


class TestManualPromptsArePrivate:
    def test_typed_prompt_is_private_and_owned(self, tenant_a):
        prompt = _add_prompt(tenant_a)
        assert prompt.is_catalog is False
        assert prompt.owner_website_id == tenant_a.website.id

    def test_other_tenants_cannot_search_it(self, tenant_a, tenant_b):
        _add_prompt(tenant_a)
        assert _listed_texts(tenant_b, search="rivalsoft") == []
        assert _listed_texts(tenant_a, search="rivalsoft") == [PRIVATE_TEXT]

    def test_catalog_rows_are_still_listed_to_everyone(self, tenant_b):
        PromptFactory(text="what is the best crm for a small team")
        assert _listed_texts(tenant_b, search="small team") == [
            "what is the best crm for a small team"]

    def test_typed_topic_is_not_listed_as_an_industry(self, tenant_a, tenant_b):
        _add_prompt(tenant_a, topic="Acme Secret Launch")
        topic = Industry.objects.get(name="Acme Secret Launch")
        assert topic.is_active is False
        resp = tenant_b.client.get("/api/v1/prompt-library/industries/")
        assert "Acme Secret Launch" not in [row["name"] for row in _data(resp)]

    def test_preview_sample_uses_catalog_rows_only(self, tenant_a, tenant_b):
        industry = IndustryFactory(slug="saas", name="SaaS")
        PromptFactory(industry=industry, text="which crm do agencies use")
        _add_prompt(tenant_a, industry_id=str(industry.id))
        resp = tenant_b.client.post(
            "/api/v1/prompt-library/prompts/preview-sample/",
            {"industry_id": str(industry.id), "n": 10}, format="json",
        )
        assert resp.status_code == 200
        assert [p["text"] for p in _data(resp)["prompts"]] == ["which crm do agencies use"]

    def test_suggestions_never_offer_another_tenants_prompt(self, tenant_a, tenant_b):
        industry = IndustryFactory(slug="saas", name="SaaS")
        catalog = PromptFactory(industry=industry, text="top crm for startups")
        private = _add_prompt(tenant_a, industry_id=str(industry.id))
        resp = tenant_b.client.get(
            f"/api/v1/prompt-library/websites/{tenant_b.website.id}/saved-prompts/suggested/")
        assert [row["id"] for row in _data(resp)["rows"]] == [str(catalog.id)]

        accept = tenant_b.client.post(
            f"/api/v1/prompt-library/websites/{tenant_b.website.id}"
            f"/saved-prompts/accept/{private.id}/")
        assert accept.status_code == 404
        bulk = tenant_b.client.post(
            f"/api/v1/prompt-library/websites/{tenant_b.website.id}/saved-prompts/bulk/accept/",
            {"prompt_ids": [str(private.id)]}, format="json",
        )
        assert _data(bulk)["accepted"] == 0
        assert not BrandPrompt.objects.filter(website=tenant_b.website, prompt=private).exists()

    def test_prompt_endpoints_by_id_hide_another_tenants_prompt(self, tenant_a, tenant_b):
        private = _add_prompt(tenant_a)
        b = tenant_b.client
        assert b.get(f"/api/v1/prompt-library/prompts/{private.id}/preview/").status_code == 404
        assert b.get(
            f"/api/v1/prompt-library/websites/{tenant_b.website.id}"
            f"/prompts/{private.id}/detail/").status_code == 404
        adopt = b.post(
            f"/api/v1/prompt-library/websites/{tenant_b.website.id}/brand-prompts/",
            {"prompt_id": str(private.id)}, format="json",
        )
        assert adopt.status_code == 404
        assert not BrandPrompt.objects.filter(website=tenant_b.website, prompt=private).exists()
        # The owner still reaches it.
        assert tenant_a.client.get(
            f"/api/v1/prompt-library/prompts/{private.id}/preview/").status_code == 200

    def test_same_text_typed_by_two_tenants_is_tracked_by_both(self, tenant_a, tenant_b):
        first = _add_prompt(tenant_a)
        second = _add_prompt(tenant_b)
        assert first.id == second.id
        assert BrandPrompt.objects.filter(prompt=first).count() == 2
        assert _listed_texts(tenant_b, search="rivalsoft") == [PRIVATE_TEXT]


class TestSearchConsoleFeedIsPrivate:
    def test_feed_rows_belong_to_the_website(self, tenant_a, tenant_b):
        from apps.search_console.models import GscQueryStat
        from apps.search_console.services.prompt_feed import feed_prompts_for_website

        IndustryFactory(slug="saas", name="SaaS")
        GscQueryStat.objects.create(
            website=tenant_a.website, query="crm with whatsapp integration for clinics",
            date=timezone.now().date() - timedelta(days=1), impressions=500,
        )
        result = feed_prompts_for_website(tenant_a.website)
        assert result["created"] == 1
        prompt = Prompt.objects.get(source=PromptSource.GSC_AGGREGATE)
        assert prompt.is_catalog is False
        assert prompt.owner_website_id == tenant_a.website.id

        assert _listed_texts(tenant_b, search="whatsapp") == []

        def suggested(tenant):
            resp = tenant.client.get(
                f"/api/v1/prompt-library/websites/{tenant.website.id}/saved-prompts/suggested/")
            return [row["id"] for row in _data(resp)["rows"]]

        assert suggested(tenant_a) == [str(prompt.id)]
        assert suggested(tenant_b) == []


def _result(audit, prompt, index, *, mentioned, provider="claude"):
    return LLMRankingResult.objects.create(
        audit=audit, prompt=prompt.text, prompt_index=index, provider=provider,
        response_text="...", is_mentioned=mentioned, query_succeeded=True,
        source_prompt=prompt,
    )


class TestEffectivenessIsPerWebsite:
    @pytest.fixture
    def shared(self, tenant_a, tenant_b):
        """One prompt tracked by both tenants: A is always mentioned, B never."""
        prompt = PromptFactory(text="best crm for clinics")
        for tenant, mentioned in ((tenant_a, True), (tenant_b, False)):
            BrandPrompt.objects.create(website=tenant.website, prompt=prompt)
            audit = LLMRankingAudit.objects.create(website=tenant.website, created_by=tenant.user)
            for i, provider in enumerate(("claude", "gpt4", "gemini", "perplexity")):
                _result(audit, prompt, i, mentioned=mentioned, provider=provider)
        return prompt

    def _get(self, tenant, prompt, website=None):
        params = {} if website is False else {"website": str((website or tenant.website).id)}
        return tenant.client.get(
            f"/api/v1/prompt-library/prompts/{prompt.id}/effectiveness/", params)

    def test_endpoint_scores_only_the_callers_website(self, tenant_a, tenant_b, shared):
        a = _data(self._get(tenant_a, shared))
        b = _data(self._get(tenant_b, shared))
        assert a["runs"] == 4 and b["runs"] == 4
        assert a["components"]["visibility_hit_rate"] == 1.0
        assert b["components"]["visibility_hit_rate"] == 0.0
        assert a["overall"] > b["overall"]
        assert a["website_id"] == str(tenant_a.website.id)

    def test_endpoint_needs_a_website_the_caller_can_reach(self, tenant_a, tenant_b, shared):
        missing = self._get(tenant_b, shared, website=False)
        assert missing.status_code == 400
        assert missing.json()["error"] == "website_required"
        assert self._get(tenant_b, shared, website=tenant_a.website).status_code == 404

    def test_endpoint_hides_another_tenants_private_prompt(self, tenant_a, tenant_b):
        private = _add_prompt(tenant_a)
        assert self._get(tenant_b, private).status_code == 404

    def test_refresh_stores_each_websites_own_score(self, tenant_a, tenant_b, shared):
        assert refresh_all_effectiveness_scores() == 2
        bp_a = BrandPrompt.objects.get(website=tenant_a.website, prompt=shared)
        bp_b = BrandPrompt.objects.get(website=tenant_b.website, prompt=shared)
        assert bp_a.effectiveness_components["visibility_hit_rate"] == 1.0
        assert bp_b.effectiveness_components["visibility_hit_rate"] == 0.0
        assert bp_a.runs_count == 4 and bp_b.runs_count == 4
        assert bp_a.effectiveness_score > bp_b.effectiveness_score

    def test_dashboard_ranks_by_the_websites_own_score(self, tenant_a, tenant_b, shared):
        from apps.llm_ranking.api.v1.views import _top_prompts

        refresh_all_effectiveness_scores()
        top_a = _top_prompts(tenant_a.website, 5, descending=True)
        bp_a = BrandPrompt.objects.get(website=tenant_a.website, prompt=shared)
        assert top_a == [{"id": str(shared.id), "text": shared.text,
                          "effectiveness_score": round(bp_a.effectiveness_score, 2)}]
        # B is never mentioned: B's own score is below A's, whatever A got.
        bp_b = BrandPrompt.objects.get(website=tenant_b.website, prompt=shared)
        assert bp_b.effectiveness_score < bp_a.effectiveness_score

    def test_catalog_listing_carries_no_shared_score(self, tenant_b, shared):
        rows = _data(tenant_b.client.get("/api/v1/prompt-library/prompts/"))
        assert rows and "effectiveness_score" not in rows[0]
        assert "runs_count" not in rows[0]


class _Result:
    succeeded = True

    def __init__(self, text):
        self.text = text


class _Provider:
    calls = 0

    def query(self, *args, **kwargs):
        type(self).calls += 1
        return _Result('["best crm for {{ city }} clinics", "crm for {{ persona }}"]')


def _template(raw, user=None):
    return {"template_text": raw, "template_variables": [], "style": "question"}


class TestSynthesizeIsStaffOnly:
    def _post(self, user, industry, **body):
        return _client(user).post(
            "/api/v1/prompt-library/prompts/synthesize/",
            {"industry_id": str(industry.id), "count": 2, **body}, format="json",
        )

    def test_regular_users_are_refused_without_any_llm_call(self):
        industry = IndustryFactory()
        _Provider.calls = 0
        with patch("apps.llm_ranking.providers.get_synthesis_provider", return_value=_Provider()):
            resp = self._post(UserFactory(), industry)
        assert resp.status_code == 403
        assert _Provider.calls == 0
        assert not Prompt.objects.exists()

    def test_staff_writes_catalog_rows(self):
        industry = IndustryFactory()
        staff = UserFactory(is_staff=True)
        with patch("apps.llm_ranking.providers.get_synthesis_provider", return_value=_Provider()), \
                patch("apps.prompt_library.services.auto_template.auto_template",
                      side_effect=_template):
            resp = self._post(staff, industry)
        assert resp.status_code == 200, resp.content
        assert _data(resp)["created"] == 2
        assert set(Prompt.objects.values_list("is_catalog", flat=True)) == {True}

    def test_fan_out_is_capped(self):
        staff = UserFactory(is_staff=True)
        resp = self._post(staff, IndustryFactory(), count=21)
        assert resp.status_code == 400

    def test_requests_are_rate_limited_per_user(self):
        industry = IndustryFactory()
        staff = UserFactory(is_staff=True)
        codes = []
        with patch("apps.llm_ranking.providers.get_synthesis_provider", return_value=None):
            for _ in range(4):
                codes.append(self._post(staff, industry).status_code)
        # Three go through (409: no provider configured), the fourth is throttled.
        assert codes == [409, 409, 409, 429]
