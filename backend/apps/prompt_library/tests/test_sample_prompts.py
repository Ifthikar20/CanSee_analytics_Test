"""Generate-samples endpoint: fills a fresh website with saved prompts.

Fully offline. Since 3320cdf ("Remove fabricated output, demo seeds and
dead code") the prompts come only from Claude, written for what the
business does: the deterministic template packs are deleted, a missing
Claude key is 409 ``synthesis_not_configured`` and a failed call is 502
``synthesis_failed``. ClaudeUtility is replaced by a stub here.

Only the prompts that fit the owner's tracked-prompt cap are added
(505310d: with the paywall on, the free plan tracks 5 prompts); ``limited``
says some were left out. The paywall is off by default, which puts every
account on the unlimited Business tier.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.prompt_library.models import BrandPrompt
from apps.prompt_library.tests.factories import IndustryFactory
from apps.websites.tests.factories import WebsiteFactory

FREE_PLAN_TRACKED_PROMPTS = 5

QUESTIONS = [
    "Which tools help a small team find exposed passwords in their code?",
    "How do I compare penetration testing firms for a startup?",
    "What are alternatives to the big cybersecurity consultancies?",
    "How can I check if my company website has known vulnerabilities?",
    "What should a beginner know about running a security audit?",
    "Is it worth paying for continuous attack surface monitoring?",
    "Who offers managed threat detection for companies under fifty people?",
    "How do I choose a vendor for phishing simulation training?",
    "What does a red team engagement usually cost for a small business?",
    "Which services scan cloud accounts for risky misconfigurations?",
    "How can a non-technical founder assess their security posture?",
    "What questions should I ask before hiring a security consultant?",
    "Are automated vulnerability scanners good enough for compliance?",
    "Which firms help prepare for a SOC 2 audit quickly?",
    "How do I find out if employee credentials were leaked online?",
    "What is the difference between a pentest and a vulnerability scan?",
]


def _url(website):
    return f"/api/v1/prompt-library/websites/{website.id}/prompts/generate-samples/"


def _claude(questions=QUESTIONS, *, configured=True):
    fake = MagicMock()
    fake.is_configured.return_value = configured
    fake.query.return_value = MagicMock(
        succeeded=True, text=json.dumps(list(questions)), error="",
    )
    return fake


@pytest.fixture
def auth_client(db):
    user = UserFactory()
    client = APIClient()
    client.force_authenticate(user=user)
    return client, user


@pytest.fixture
def described_site(auth_client):
    client, user = auth_client
    IndustryFactory(name="Cyber", slug="cyber")
    website = WebsiteFactory(
        user=user, name="strix", industry="cyber",
        description="Security testing and leaked-credential monitoring for small companies.",
    )
    return client, user, website


@pytest.mark.django_db
class TestGenerateSamples:
    def test_creates_ten_website_prompts(self, described_site):
        client, _user, website = described_site
        fake = _claude()

        with patch(
            "apps.prompt_library.services.sample_prompts.ClaudeUtility",
            return_value=fake,
        ):
            resp = client.post(_url(website), {}, format="json")
        assert resp.status_code == 201
        body = resp.json()["data"]
        assert body["source"] == "llm"
        assert body["total"] == 10
        assert body["created_count"] == 10
        assert body["limited"] is False
        assert len(body["generated"]) == 10
        assert [g["text"] for g in body["generated"]] == QUESTIONS[:10]
        assert {g["intent"] for g in body["generated"]} == {"custom"}

        # The table reads BrandPrompt rows — all ten must be linked.
        linked = BrandPrompt.objects.filter(website=website)
        assert linked.count() == 10
        assert {bp.prompt.text for bp in linked} == set(QUESTIONS[:10])
        # The model was asked for the requested count, about this business.
        prompt_text = fake.query.call_args.args[0]
        assert "Write exactly 10 questions" in prompt_text
        assert "leaked-credential monitoring" in prompt_text

    def test_free_plan_adds_only_what_fits_the_cap(self, described_site, settings):
        settings.PAYWALL_ENABLED = True
        client, _user, website = described_site

        with patch(
            "apps.prompt_library.services.sample_prompts.ClaudeUtility",
            return_value=_claude(),
        ):
            resp = client.post(_url(website), {}, format="json")
        assert resp.status_code == 201
        body = resp.json()["data"]
        assert body["total"] == 10
        # Free plan: only the first five fit; the rest are reported left out.
        assert body["created_count"] == FREE_PLAN_TRACKED_PROMPTS
        assert body["limited"] is True
        linked = BrandPrompt.objects.filter(website=website)
        assert {bp.prompt.text for bp in linked} == set(QUESTIONS[:FREE_PLAN_TRACKED_PROMPTS])

    def test_rerun_does_not_duplicate(self, described_site):
        client, _user, website = described_site
        questions = QUESTIONS[:3]

        with patch(
            "apps.prompt_library.services.sample_prompts.ClaudeUtility",
            return_value=_claude(questions),
        ):
            first = client.post(_url(website), {"count": 3}, format="json")
            assert first.status_code == 201
            assert first.json()["data"]["created_count"] == 3
            second = client.post(_url(website), {"count": 3}, format="json")
        assert second.status_code == 201
        # Dedup on text hash: nothing new the second time around, and no
        # duplicate BrandPrompt links.
        assert second.json()["data"]["created_count"] == 0
        assert second.json()["data"]["limited"] is False
        assert BrandPrompt.objects.filter(website=website).count() == 3

    def test_count_is_clamped(self, described_site):
        client, _user, website = described_site
        fake = _claude()

        with patch(
            "apps.prompt_library.services.sample_prompts.ClaudeUtility",
            return_value=fake,
        ):
            resp = client.post(_url(website), {"count": 99}, format="json")
        assert resp.status_code == 201
        assert resp.json()["data"]["total"] == 15
        assert "Write exactly 15 questions" in fake.query.call_args.args[0]

    def test_no_claude_key_is_409_and_creates_nothing(self, described_site):
        client, _user, website = described_site

        with patch(
            "apps.prompt_library.services.sample_prompts.ClaudeUtility",
            return_value=_claude(configured=False),
        ):
            resp = client.post(_url(website), {}, format="json")
        assert resp.status_code == 409
        assert resp.json()["error"] == "synthesis_not_configured"
        assert not BrandPrompt.objects.filter(website=website).exists()

    def test_failed_generation_is_502_and_creates_nothing(self, described_site):
        client, _user, website = described_site
        fake = _claude()
        fake.query.return_value = MagicMock(succeeded=False, text="", error="overloaded")

        with patch(
            "apps.prompt_library.services.sample_prompts.ClaudeUtility",
            return_value=fake,
        ):
            resp = client.post(_url(website), {}, format="json")
        assert resp.status_code == 502
        assert resp.json()["error"] == "synthesis_failed"
        assert not BrandPrompt.objects.filter(website=website).exists()

    def test_foreign_website_is_404(self, auth_client):
        client, user = auth_client
        IndustryFactory()
        other = WebsiteFactory()  # different owner
        resp = client.post(_url(other), {}, format="json")
        assert resp.status_code == 404

    def test_unauthenticated_401(self, db):
        website = WebsiteFactory()
        resp = APIClient().post(_url(website), {}, format="json")
        assert resp.status_code == 401
