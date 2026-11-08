"""The browser pane's keyword changes (highlight view, spec section 7): the
highlight-changes API over answer_changes, its window and validation, its
join keys against the search-gap overview, and its tenancy; plus the shared
visibility_history service the agent's history tool also uses."""

from datetime import UTC, date, datetime, time, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.llm_ranking.services.visibility_history import build_visibility_history, parse_days
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services._hash import text_hash
from apps.websites.models import Website
from core.exceptions import CanseeException

pytestmark = pytest.mark.django_db

SITE = "https://www.notes-fixture.example"
BRAND = "Fixture Notes"


def _today() -> date:
    return timezone.now().date()


def at(days_ago: int, hour: int = 12) -> datetime:
    """Noon UTC ``days_ago`` days before today."""
    return datetime.combine(_today() - timedelta(days=days_ago), time(hour), tzinfo=UTC)


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Fixture Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url=SITE, name=BRAND)


@pytest.fixture
def engines(settings):
    """ChatGPT and Claude configured; the other engines are not."""
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.PERPLEXITY_API_KEY = ""
    return settings


def track(website, text: str, *, location: str = "us", archived: bool = False) -> BrandPrompt:
    industry, _ = Industry.objects.get_or_create(
        slug="fixture-notes", defaults={"name": "Notes (fixture)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, text_hash=text_hash(text),
        intent_bucket="category", style="question", source=PromptSource.MANUAL,
    )
    return BrandPrompt.objects.create(website=website, prompt=prompt, location=location,
                                      is_archived=archived)


def answer(bp, engine: str, when: datetime, *, rank=None, mentioned=None) -> LLMRankingResult:
    """One successful engine answer to ``bp`` given at ``when``."""
    website = bp.website
    named = (rank is not None) if mentioned is None else mentioned
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=website.user, status=LLMRankingAudit.STATUS_COMPLETED,
        prompts=[bp.prompt.text], business_name=website.name, providers_queried=[engine],
    )
    result = LLMRankingResult.objects.create(
        audit=audit, provider=engine, prompt=bp.prompt.text, response_text="An answer.",
        is_mentioned=named, mention_rank=rank,
        sentiment="positive" if named else "not_mentioned",
        competitors_mentioned=[], query_succeeded=True, source_prompt=bp.prompt,
    )
    LLMRankingResult.objects.filter(id=result.id).update(created_at=when)
    result.created_at = when
    return result


def _url(website) -> str:
    return reverse("llm-ranking-highlight-changes", kwargs={"website_id": website.id})


def _client(person) -> APIClient:
    client = APIClient()
    client.force_authenticate(person)
    return client


# ── API ──────────────────────────────────────────────────────────────────


def test_api_returns_changes_keyed_like_the_overview(user, website, engines):
    bp = track(website, "best note app")
    answer(bp, "claude", at(10), mentioned=False)
    answer(bp, "claude", at(2), rank=2)  # named now
    answer(bp, "gpt4", at(3), rank=1)  # first check
    client = _client(user)

    assert _url(website) == f"/api/v1/llm-ranking/{website.id}/highlight-changes/"
    resp = client.get(_url(website))
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    data = body["data"]
    assert data["window_days"] == 90
    # The pane gets no weekly series or engine list (the agent tool does).
    assert "weekly" not in data and "engines" not in data and "note" not in data
    assert [(c["engine"], c["change"]) for c in data["changes"]] == [
        ("claude", "named_now"), ("chatgpt", "first_check")]
    assert {c["prompt_id"] for c in data["changes"]} == {str(bp.prompt_id)}
    assert {c["brand_prompt_id"] for c in data["changes"]} == {str(bp.id)}
    assert data["counts"]["named_now"] == 1 and data["counts"]["first_check"] == 1
    assert data["changes_total"] == 2
    named = data["changes"][0]
    assert named["latest"]["named"] is True and named["latest"]["rank"] == 2
    assert named["previous"]["named"] is False

    overview = client.get(f"/api/v1/search-gap/websites/{website.id}/overview/")
    assert overview.status_code == 200
    (row,) = overview.json()["data"]["prompts"]
    assert (row["prompt_id"], row["brand_prompt_id"]) == (
        data["changes"][0]["prompt_id"], data["changes"][0]["brand_prompt_id"])


def test_api_window_follows_days(user, website, engines):
    bp = track(website, "best note app")
    answer(bp, "claude", at(40), rank=1)
    answer(bp, "claude", at(2), rank=3)
    client = _client(user)

    assert client.get(_url(website)).json()["data"]["changes"][0]["change"] == "rank_down"
    within_30 = client.get(_url(website), {"days": 30}).json()["data"]
    assert within_30["window_days"] == 30
    assert within_30["changes"][0]["change"] == "first_check"


def test_api_rejects_a_bad_window(user, website, engines):
    client = _client(user)

    for days in ("0", "91", "abc", "-5", "1.5"):
        resp = client.get(_url(website), {"days": days})
        assert resp.status_code == 400, days
        error = resp.json()["error"]
        assert error["code"] == "invalid" and error["details"]["field"] == "days", days


def test_api_says_when_nothing_could_be_compared(user, website, engines):
    track(website, "best note app")
    client = _client(user)

    data = client.get(_url(website)).json()["data"]
    assert data["changes"] == [] and data["changes_total"] == 0
    assert data["latest_check_at"] is None and data["previous_check_at"] is None
    assert data["note"] == ("No engine has answered a tracked prompt in the last 90 days, so "
                            "nothing can be compared.")
    assert "last 30 days" in client.get(_url(website), {"days": 30}).json()["data"]["note"]


def test_api_leaves_archived_prompts_out(user, website, engines):
    live = track(website, "best note app")
    old = track(website, "old prompt", archived=True)
    answer(live, "claude", at(2), rank=1)
    answer(old, "claude", at(2), rank=1)

    data = _client(user).get(_url(website)).json()["data"]
    assert {c["prompt_id"] for c in data["changes"]} == {str(live.prompt_id)}


def test_api_returns_every_change_uncapped(user, website, engines):
    # The agent's history tool caps its list at 40; the pane needs every keyword.
    for i in range(21):
        bp = track(website, f"note app question {i}")
        answer(bp, "claude", at(2), rank=1)
        answer(bp, "gpt4", at(2), rank=1)

    data = _client(user).get(_url(website)).json()["data"]
    assert data["changes_total"] == 42 and len(data["changes"]) == 42


def test_api_hides_the_project_from_strangers_and_serves_viewers(user, website, engines):
    org = Organization.objects.create(name="Acme", slug="acme-notes", owner=user)
    website.organization = org
    website.save(update_fields=["organization"])
    people = get_user_model().objects
    stranger = people.create_user(email="stranger@example.com", password="x" * 16)
    viewer = people.create_user(email="viewer@example.com", password="x" * 16)
    member = people.create_user(email="member@example.com", password="x" * 16)
    OrganizationMember.objects.create(organization=org, user=viewer, role="viewer")
    OrganizationMember.objects.create(organization=org, user=member, role="member")
    client = APIClient()

    for person, status in ((stranger, 404), (viewer, 200), (member, 200)):
        client.force_authenticate(person)
        assert client.get(_url(website)).status_code == status, person.email


def test_api_needs_a_signed_in_user(website, engines):
    assert APIClient().get(_url(website)).status_code in (401, 403)


# ── Service ──────────────────────────────────────────────────────────────


def test_parse_days_defaults_and_bounds():
    assert parse_days(None) == 90 and parse_days("") == 90
    assert (parse_days("1"), parse_days("90"), parse_days(" 30 ")) == (1, 90, 30)
    for raw in ("0", "91", "abc", "-5", "1.5", "1e2"):
        with pytest.raises(CanseeException) as caught:
            parse_days(raw)
        assert caught.value.status_code == 400 and caught.value.details["field"] == "days"


def test_the_weekly_series_needs_the_full_window(website, engines):
    with pytest.raises(ValueError):
        build_visibility_history(website, days=30, weekly=True)
    assert "weekly" not in build_visibility_history(website, days=30, weekly=False)
