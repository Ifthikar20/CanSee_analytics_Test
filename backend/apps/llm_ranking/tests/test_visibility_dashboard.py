"""The visibility dashboard (pages contract section 5): day and week
buckets with sparse answers, rates by engine, share of voice, sentiment,
citations, the previous window, the engine and prompt filters, Google
history, the empty reasons, and the API's validation and tenancy."""

import uuid
from datetime import UTC, date, datetime, time, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.citations.models import Citation, SourceClass
from apps.citations.services.url_normalizer import normalize_url
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.llm_ranking.services.visibility_dashboard import build_dashboard
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services._hash import text_hash
from apps.search_gap.models import GoogleRankCheck
from apps.websites.models import Website
from core.exceptions import CanseeException, ResourceNotFound

pytestmark = pytest.mark.django_db

SITE = "https://www.notes-fixture.example"
BRAND = "Fixture Notes"
COMPETITORS = [
    {"name": "Alpha Notes", "domain": "alpha-notes.example"},
    {"name": "Beta Notes", "domain": "beta-notes.example"},
]


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
    return Website.objects.create(user=user, url=SITE, name=BRAND, competitors=COMPETITORS)


@pytest.fixture
def engines(settings):
    """ChatGPT and Claude configured; the other engines are not."""
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.PERPLEXITY_API_KEY = ""
    return settings


def track(website, text: str, *, location: str = "us", template: str | None = None,
          archived: bool = False) -> BrandPrompt:
    industry, _ = Industry.objects.get_or_create(
        slug="fixture-notes", defaults={"name": "Notes (fixture)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=template if template is not None else text,
        text_hash=text_hash(text), intent_bucket="category", style="question",
        source=PromptSource.MANUAL,
    )
    return BrandPrompt.objects.create(website=website, prompt=prompt, location=location,
                                      is_archived=archived)


def answer(bp, engine: str, when: datetime, *, rank=None, mentioned=None, sentiment=None,
           brands=(), succeeded=True, linked=True, text=None) -> LLMRankingResult:
    """One engine answer to ``bp`` given at ``when``."""
    website = bp.website
    named = (rank is not None) if mentioned is None else mentioned
    audit = LLMRankingAudit.objects.create(
        website=website, created_by=website.user, status=LLMRankingAudit.STATUS_COMPLETED,
        prompts=[bp.prompt.text], business_name=website.name, providers_queried=[engine],
    )
    result = LLMRankingResult.objects.create(
        audit=audit, provider=engine, prompt=text or bp.prompt.text, response_text="An answer.",
        is_mentioned=named, mention_rank=rank,
        sentiment=sentiment or ("positive" if named else "not_mentioned"),
        competitors_mentioned=[
            {"name": name, "position": i, "linked": False} for i, name in enumerate(brands, 1)
        ],
        query_succeeded=succeeded, source_prompt=bp.prompt if linked else None,
    )
    LLMRankingResult.objects.filter(id=result.id).update(created_at=when)
    result.created_at = when
    return result


def cite(result, url: str, *, target: bool = False, competitor: bool = False) -> Citation:
    normalized, host, apex = normalize_url(url)
    return Citation.objects.create(
        result=result, audit=result.audit, url=url, normalized_url=normalized, domain=host,
        apex_domain=apex, source_class=SourceClass.OTHER, position=1, is_target=target,
        is_competitor=competitor,
    )


def _index(dash, days_ago: int) -> int:
    return dash["window"]["buckets"].index((_today() - timedelta(days=days_ago)).isoformat())


def _engine(dash, key: str) -> dict:
    return next(e for e in dash["visibility"]["by_engine"] if e["key"] == key)


# ── Buckets ──────────────────────────────────────────────────────────────


def test_day_buckets_have_values_only_where_answers_exist(website, engines):
    bp = track(website, "best note app for teams")
    answer(bp, "gpt4", at(2), rank=2)
    answer(bp, "gpt4", at(2))
    answer(bp, "claude", at(5), rank=1)

    dash = build_dashboard(website, period="7d")

    window = dash["window"]
    assert (window["period"], window["interval"]) == ("7d", "day")
    assert window["start"] == (_today() - timedelta(days=6)).isoformat()
    assert window["end"] == _today().isoformat()
    assert window["buckets"] == [
        (_today() - timedelta(days=6 - i)).isoformat() for i in range(7)
    ]
    two, five = _index(dash, 2), _index(dash, 5)
    overall = dash["visibility"]["all"]
    assert overall["answers"] == [2 if i == two else 1 if i == five else 0 for i in range(7)]
    assert overall["visibility_pct"] == [
        50.0 if i == two else 100.0 if i == five else None for i in range(7)
    ]
    assert [e["key"] for e in dash["visibility"]["by_engine"]] == ["chatgpt", "claude"]
    chatgpt = _engine(dash, "chatgpt")
    assert chatgpt["answers"] == [2 if i == two else 0 for i in range(7)]
    assert chatgpt["visibility_pct"] == [50.0 if i == two else None for i in range(7)]
    assert chatgpt["avg_rank"] == [2.0 if i == two else None for i in range(7)]
    claude = _engine(dash, "claude")
    assert claude["visibility_pct"][five] == 100.0 and claude["visibility_pct"][two] is None

    headline = dash["headline"]
    assert (headline["answers"], headline["visibility_pct"], headline["avg_rank"]) == (3, 66.7, 1.5)
    assert dash["has_data"] is True and dash["empty_reason"] is None


def test_week_buckets_start_on_monday_and_count_only_the_window(website, engines):
    bp = track(website, "best note app for teams")
    start = _today() - timedelta(days=89)
    first_day = datetime.combine(start, time(12), tzinfo=UTC)
    answer(bp, "gpt4", first_day, rank=3)
    # The day before the window: the previous window, never a bucket.
    answer(bp, "gpt4", first_day - timedelta(days=1), rank=1)
    answer(bp, "claude", at(0, hour=0), mentioned=False)

    dash = build_dashboard(website, period="90d")

    window = dash["window"]
    assert window["interval"] == "week"
    buckets = [date.fromisoformat(b) for b in window["buckets"]]
    assert all(b.weekday() == 0 for b in buckets)
    assert buckets[0] == start - timedelta(days=start.weekday())
    assert buckets[-1] <= _today() < buckets[-1] + timedelta(days=7)
    assert all(later - earlier == timedelta(days=7)
               for earlier, later in zip(buckets, buckets[1:], strict=False))
    overall = dash["visibility"]["all"]
    assert overall["answers"][0] == 1 and overall["visibility_pct"][0] == 100.0
    assert overall["answers"][-1] == 1 and overall["visibility_pct"][-1] == 0.0
    assert sum(overall["answers"]) == dash["headline"]["answers"] == 2
    assert dash["headline"]["answers_prev"] == 1

    daily = build_dashboard(website, period="90d", interval="day")
    assert len(daily["window"]["buckets"]) == 90


# ── Share of voice, sentiment, citations ─────────────────────────────────


def test_share_of_voice_orders_brands_and_folds_the_rest(website, engines):
    bp = track(website, "best note app for teams")
    answer(bp, "gpt4", at(1), rank=1, brands=["Alpha Notes", "Epsilon", "Zeta"])
    answer(bp, "gpt4", at(1), brands=["Beta Notes", "alpha notes", "Eta"])
    answer(bp, "claude", at(1), rank=2,
           brands=["Alpha Notes", "Theta", "Iota", "Kappa", "Lambda"])
    # Your own name in the brand list is you, not a competitor.
    answer(bp, "claude", at(1), brands=["fixture notes", "Epsilon"])

    dash = build_dashboard(website, period="7d")

    sov = dash["share_of_voice"]
    rows = [(b["key"], b["name"], b["mentions"], b["share_pct"]) for b in sov["brands"]]
    # 14 mentions: you 2, Alpha 3, Beta 1, Epsilon 2, six others 1 each.
    assert rows == [
        ("you", BRAND, 2, 14.3),
        ("b1", "Alpha Notes", 3, 21.4),
        ("b2", "Beta Notes", 1, 7.1),
        ("b3", "Epsilon", 2, 14.3),
        ("b4", "Eta", 1, 7.1),
        ("b5", "Iota", 1, 7.1),
        ("other", "Other brands", 4, 28.6),
    ]
    flags = {b["key"]: (b["is_you"], b["is_competitor"]) for b in sov["brands"]}
    assert flags["you"] == (True, False)
    assert flags["b1"] == flags["b2"] == (False, True)
    assert flags["b3"] == flags["other"] == (False, False)
    one = _index(dash, 1)
    assert list(sov["series"]) == ["you", "b1", "b2", "b3", "b4", "b5", "other"]
    assert sov["series"]["you"][one] == 14.3 and sov["series"]["other"][one] == 28.6
    assert all(v is None for i, v in enumerate(sov["series"]["you"]) if i != one)
    assert dash["headline"]["share_of_voice_pct"] == 14.3


def test_share_of_voice_without_any_brand_named(website, engines):
    bp = track(website, "best note app for teams")
    answer(bp, "gpt4", at(1))

    sov = build_dashboard(website, period="7d")["share_of_voice"]

    assert sov["brands"] == [{"key": "you", "name": BRAND, "is_you": True, "is_competitor": False,
                              "mentions": 0, "share_pct": None}]
    assert set(sov["series"]) == {"you"} and all(v is None for v in sov["series"]["you"])


def test_sentiment_counts_only_answers_that_name_you(website, engines):
    bp = track(website, "best note app for teams")
    answer(bp, "gpt4", at(1), rank=1, sentiment="positive")
    answer(bp, "gpt4", at(1), rank=2, sentiment="negative")
    answer(bp, "claude", at(1), sentiment="not_mentioned")
    answer(bp, "claude", at(3), rank=4, sentiment="neutral")

    dash = build_dashboard(website, period="7d")

    sentiment = dash["sentiment"]
    assert sentiment["totals"] == {"positive": 1, "neutral": 1, "negative": 1}
    one, three = _index(dash, 1), _index(dash, 3)
    assert sentiment["series"]["positive"] == [1 if i == one else 0 for i in range(7)]
    assert sentiment["series"]["neutral"] == [1 if i == three else 0 for i in range(7)]
    by_engine = {e["key"]: e["sentiment"] for e in dash["by_engine"]}
    assert by_engine["chatgpt"] == {"positive": 1, "neutral": 0, "negative": 1}


def test_citations_split_into_yours_competitors_and_other(website, engines):
    bp = track(website, "best note app for teams")
    first = answer(bp, "gpt4", at(1), rank=1)
    cite(first, f"{SITE}/pricing")
    cite(first, "https://www.alpha-notes.example/compare", competitor=True)
    cite(first, "https://g2.example/notes")
    second = answer(bp, "perplexity", at(2), mentioned=False)
    cite(second, "https://blog.notes-fixture.example/guide", target=True)
    cite(second, "https://g2.example/best-notes")

    dash = build_dashboard(website, period="7d")

    citations = dash["citations"]
    assert citations["has_data"] is True
    assert citations["totals"] == {"total": 5, "yours": 2, "competitors": 1, "other": 2}
    one, two = _index(dash, 1), _index(dash, 2)
    assert citations["series"]["yours"][one] == 1 and citations["series"]["yours"][two] == 1
    assert citations["series"]["competitors"] == [1 if i == one else 0 for i in range(7)]
    assert [d["domain"] for d in citations["top_domains"]] == [
        "g2.example", "notes-fixture.example", "alpha-notes.example"]
    g2, yours, rival = citations["top_domains"]
    assert (g2["citations"], g2["answers"], g2["engines"]) == (2, 2, ["chatgpt", "perplexity"])
    assert (g2["is_yours"], g2["is_competitor"]) == (False, False)
    assert (yours["is_yours"], yours["is_competitor"]) == (True, False)
    assert (rival["is_yours"], rival["is_competitor"]) == (False, True)
    assert (dash["headline"]["citations"], dash["headline"]["your_citations"]) == (5, 2)
    by_engine = {e["key"]: (e["citations"], e["your_citations"]) for e in dash["by_engine"]}
    # Perplexity answered, so it is shown although it is not configured.
    assert by_engine == {"chatgpt": (3, 1), "claude": (0, 0), "perplexity": (2, 1)}


def test_answers_without_citation_rows_leave_citation_numbers_null(website, engines):
    bp = track(website, "best note app for teams")
    answer(bp, "gpt4", at(1), rank=1)

    dash = build_dashboard(website, period="7d")

    citations = dash["citations"]
    assert citations["has_data"] is False and citations["totals"] is None
    assert citations["series"] == {k: [None] * 7 for k in ("yours", "competitors", "other")}
    assert citations["top_domains"] == []
    assert dash["headline"]["citations"] is None and dash["headline"]["your_citations"] is None
    assert all(e["citations"] is None and e["your_citations"] is None for e in dash["by_engine"])


# ── Previous window, by engine, by prompt ────────────────────────────────


def test_previous_window_numbers(website, engines):
    bp = track(website, "best note app for teams")
    answer(bp, "gpt4", at(1), rank=2, brands=["Alpha Notes"])
    answer(bp, "gpt4", at(1))
    answer(bp, "gpt4", at(9), rank=4, brands=["Alpha Notes"])
    answer(bp, "claude", at(10), brands=["Alpha Notes"])
    answer(bp, "claude", at(10), brands=["Alpha Notes"])
    answer(bp, "claude", at(20), rank=1)  # before both windows

    headline = build_dashboard(website, period="7d")["headline"]

    assert (headline["answers"], headline["answers_prev"]) == (2, 3)
    assert (headline["visibility_pct"], headline["visibility_prev_pct"]) == (50.0, 33.3)
    assert (headline["avg_rank"], headline["avg_rank_prev"]) == (2.0, 4.0)
    assert (headline["share_of_voice_pct"], headline["share_of_voice_prev_pct"]) == (50.0, 25.0)


def test_previous_window_without_answers_is_null(website, engines):
    bp = track(website, "best note app for teams")
    answer(bp, "gpt4", at(1), rank=2)

    headline = build_dashboard(website, period="7d")["headline"]

    assert headline["answers"] == 1
    assert headline["answers_prev"] is None and headline["visibility_prev_pct"] is None
    assert headline["avg_rank_prev"] is None and headline["share_of_voice_prev_pct"] is None


def test_by_engine_and_by_prompt(website, engines):
    engines.GEMINI_API_KEY = "g-test"
    first = track(website, "best note app")
    second = track(website, "best note app for teams", template="best note app")
    archived = track(website, "note apps with offline mode", archived=True)
    answer(first, "gpt4", at(1), rank=3)
    answer(first, "gpt4", at(2))
    answer(second, "claude", at(1), rank=1)
    # Matched by text to both prompts: counted once, under the older one.
    answer(first, "claude", at(3), linked=False, text="Best  note app")
    # Not counted: a failed call, an engine outside the five, an archived prompt.
    answer(first, "gpt4", at(1), rank=1, succeeded=False)
    answer(first, "mistral", at(1), rank=1)
    answer(archived, "gpt4", at(1), rank=1)

    dash = build_dashboard(website, period="7d")

    assert [p["text"] for p in dash["prompts"]] == ["best note app", "best note app for teams"]
    rows = {r["text"]: r for r in dash["by_prompt"]}
    assert list(rows) == ["best note app", "best note app for teams"]
    top = rows["best note app"]
    assert (top["answers"], top["visibility_pct"]) == (3, 33.3)
    assert top["engines"] == {
        "chatgpt": {"answers": 2, "visibility_pct": 50.0, "avg_rank": 3.0},
        "claude": {"answers": 1, "visibility_pct": 0.0, "avg_rank": None},
        "gemini": None,
    }
    assert rows["best note app for teams"]["engines"]["claude"] == {
        "answers": 1, "visibility_pct": 100.0, "avg_rank": 1.0}
    by_engine = {e["key"]: e for e in dash["by_engine"]}
    assert list(by_engine) == ["chatgpt", "claude", "gemini"]
    assert (by_engine["chatgpt"]["answers"], by_engine["chatgpt"]["mentioned"]) == (2, 1)
    assert by_engine["claude"]["visibility_pct"] == 50.0
    gemini = by_engine["gemini"]
    assert (gemini["configured"], gemini["answers"], gemini["visibility_pct"],
            gemini["avg_rank"]) == (True, 0, None, None)
    assert dash["headline"]["answers"] == 4
    assert [e["key"] for e in dash["engines"]] == ["chatgpt", "claude", "gemini", "grok",
                                                    "perplexity"]
    assert [e["configured"] for e in dash["engines"]] == [True, True, True, False, False]


# ── Filters and Google history ───────────────────────────────────────────


def test_engine_filter_limits_every_number(website, engines):
    bp = track(website, "best note app for teams")
    answer(bp, "gpt4", at(1), rank=1)
    answer(bp, "claude", at(1), rank=3)
    answer(bp, "claude", at(2))

    dash = build_dashboard(website, period="7d", engine="claude")

    assert dash["filters"] == {"engine": "claude", "prompt_id": None}
    assert [e["key"] for e in dash["visibility"]["by_engine"]] == ["claude"]
    assert [e["key"] for e in dash["by_engine"]] == ["claude"]
    assert (dash["headline"]["answers"], dash["headline"]["visibility_pct"]) == (2, 50.0)
    assert list(dash["by_prompt"][0]["engines"]) == ["claude"]
    assert len(dash["engines"]) == 5


def test_prompt_filter_and_google_history(website, engines):
    first = track(website, "best note app")
    second = track(website, "best note app for teams")
    answer(first, "gpt4", at(1), rank=1)
    answer(second, "gpt4", at(1), mentioned=False)
    GoogleRankCheck.objects.create(website=website, brand_prompt=first, query="best note app",
                                   location="us", depth=100, position=4, checked_at=at(3))
    GoogleRankCheck.objects.create(website=website, brand_prompt=first, query="best note app",
                                   location="us", depth=20, error="serp_failed",
                                   checked_at=at(1))
    GoogleRankCheck.objects.create(website=website, brand_prompt=first, query="best note app",
                                   location="us", position=1, checked_at=at(40))
    GoogleRankCheck.objects.create(website=website, brand_prompt=second, query="other",
                                   location="us", position=2, checked_at=at(2))

    dash = build_dashboard(website, prompt_id=str(first.prompt_id))

    assert dash["filters"] == {"engine": None, "prompt_id": str(first.prompt_id)}
    assert [r["prompt_id"] for r in dash["by_prompt"]] == [str(first.prompt_id)]
    assert len(dash["prompts"]) == 2
    assert (dash["headline"]["answers"], dash["headline"]["visibility_pct"]) == (1, 100.0)
    history = dash["google_history"]
    assert [(h["position"], h["depth"], h["page"], h["location"], h["error"]) for h in history] == [
        (4, 100, 1, "us", None),
        (None, 20, None, "us", "serp_failed"),
    ]
    assert history[0]["checked_at"] < history[1]["checked_at"]
    assert build_dashboard(website)["google_history"] is None


def test_unknown_filters_are_rejected(website, engines):
    track(website, "best note app")
    for kwargs, field in (
        ({"period": "1y"}, "period"),
        ({"interval": "month"}, "interval"),
        ({"engine": "bing"}, "engine"),
        ({"prompt_id": "not-a-uuid"}, "prompt_id"),
    ):
        with pytest.raises(CanseeException) as err:
            build_dashboard(website, **kwargs)
        assert (err.value.status_code, err.value.code) == (400, "invalid")
        assert err.value.details["field"] == field
    with pytest.raises(ResourceNotFound):
        build_dashboard(website, prompt_id=str(uuid.uuid4()))


# ── Empty reasons ────────────────────────────────────────────────────────


def test_no_prompts(website, engines):
    dash = build_dashboard(website, period="30d")

    assert (dash["empty_reason"], dash["has_data"]) == ("no_prompts", False)
    assert len(dash["window"]["buckets"]) == 30
    assert dash["visibility"]["all"]["answers"] == [0] * 30
    assert dash["visibility"]["all"]["visibility_pct"] == [None] * 30
    assert dash["by_prompt"] == [] and dash["prompts"] == []
    assert dash["headline"]["answers"] == 0 and dash["headline"]["visibility_pct"] is None


def test_no_engines_then_no_answers(website, settings):
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY",
                "PERPLEXITY_API_KEY"):
        setattr(settings, key, "")
    bp = track(website, "best note app")

    assert build_dashboard(website)["empty_reason"] == "no_engines"

    settings.OPENAI_API_KEY = "sk-test"
    dash = build_dashboard(website)
    assert (dash["empty_reason"], dash["has_data"]) == ("no_answers", False)
    assert [e["key"] for e in dash["visibility"]["by_engine"]] == ["chatgpt"]

    # Answers already collected are shown even when no engine is set up now.
    settings.OPENAI_API_KEY = ""
    answer(bp, "gpt4", at(1), rank=1)
    dash = build_dashboard(website)
    assert (dash["empty_reason"], dash["has_data"]) == (None, True)


# ── API ──────────────────────────────────────────────────────────────────


def _url(website) -> str:
    return reverse("llm-ranking-visibility-dashboard", kwargs={"website_id": website.id})


def test_api_returns_the_dashboard(user, website, engines):
    bp = track(website, "best note app")
    answer(bp, "gpt4", at(1), rank=2)
    client = APIClient()
    client.force_authenticate(user)

    assert _url(website) == f"/api/v1/llm-ranking/{website.id}/visibility-dashboard/"
    resp = client.get(_url(website))
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    data = body["data"]
    assert (data["window"]["period"], data["window"]["interval"]) == ("30d", "day")
    assert data["website"] == {"id": str(website.id), "name": BRAND}
    assert data["headline"]["answers"] == 1

    resp = client.get(_url(website), {"period": "90d", "engine": "chatgpt",
                                      "prompt_id": str(bp.prompt_id)})
    assert resp.status_code == 200
    assert resp.json()["data"]["window"]["interval"] == "week"


def test_api_rejects_bad_filters(user, website, engines):
    archived = track(website, "old prompt", archived=True)
    client = APIClient()
    client.force_authenticate(user)

    for params in ({"period": "1y"}, {"interval": "month"}, {"engine": "bing"},
                   {"prompt_id": "nope"}):
        resp = client.get(_url(website), params)
        assert resp.status_code == 400, params
        error = resp.json()["error"]
        assert error["code"] == "invalid" and error["details"]["field"] == next(iter(params))
    for prompt_id in (uuid.uuid4(), archived.prompt_id):
        resp = client.get(_url(website), {"prompt_id": str(prompt_id)})
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"


def test_api_hides_the_project_from_strangers_and_viewers(user, website, engines):
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

    for person, status in ((stranger, 404), (viewer, 404), (member, 200)):
        client.force_authenticate(person)
        assert client.get(_url(website)).status_code == status, person.email
