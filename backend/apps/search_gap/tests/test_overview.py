"""Database-backed checks: the gap overview through the services and the API.

The fixture builds a small project inline: eight tracked prompts, three
AI runs of five engines each, the citations behind those answers, and one
Google rank check per prompt. Together the prompts cover every gap class
(AI ahead, Google ahead, strong in both, invisible in both).
"""

import math
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.citations.models import Citation, SourceClass
from apps.citations.services.url_normalizer import normalize_url
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services._hash import text_hash
from apps.search_gap.models import GoogleRankCheck
from apps.search_gap.services.overview import build_overview, build_prompt_detail
from apps.websites.models import Website

pytestmark = pytest.mark.django_db

SITE = "https://www.crm-fixture.example"
BRAND = "Fixture CRM"
COMPETITORS = [
    {"name": "Alpha CRM", "domain": "alpha-crm.example"},
    {"name": "Beta CRM", "domain": "beta-crm.example"},
    {"name": "Gamma CRM", "domain": "gamma-crm.example"},
    {"name": "Delta CRM", "domain": "delta-crm.example"},
]
OTHER_BRANDS = ["Epsilon CRM", "Zeta CRM", "Eta CRM", "Theta CRM", "Iota CRM", "Kappa CRM"]
THIRD_PARTY = [
    "https://www.reviews-one.example/categories/crm",
    "https://www.reviews-two.example/crm-software/",
    "https://www.forum.example/r/smallbusiness/which_crm/",
    "https://www.magazine-one.example/best-crm-small-business/",
    "https://www.magazine-two.example/picks/crm-software",
    "https://automation.example/blog/best-crm-app/",
]
COMPETITOR_PAGES = [
    "https://www.alpha-crm.example/products/crm",
    "https://www.beta-crm.example/features",
    "https://www.gamma-crm.example/crm/",
    "https://www.delta-crm.example/crm/",
]
ENGINES = ("gpt4", "claude", "gemini", "grok", "perplexity")

# (prompt, Google position or None, your ranking path, ranks per engine
# over three runs; None = not mentioned in that run).
SCENARIOS = [
    ("best crm for small business", 94, "/blog/small-business-crm", {
        "gpt4": [2, 2, 3], "claude": [3, 3, 2], "gemini": [None, None, None],
        "grok": [5, 4, None], "perplexity": [4, 3, 4]}),
    ("crm with built-in email automation", 4, "/features/email-automation", {
        "gpt4": [None, None, None], "claude": [None, None, None], "gemini": [None, None, None],
        "grok": [None, None, None], "perplexity": [None, 9, None]}),
    ("alpha crm alternatives for startups", 2, "/compare/alpha-crm-alternatives", {
        "gpt4": [1, 1, 2], "claude": [2, 1, 2], "gemini": [1, 2, 1],
        "grok": [3, 2, 3], "perplexity": [2, 2, 1]}),
    ("how to choose a crm", None, "", {
        "gpt4": [None, None, None], "claude": [None, None, None], "gemini": [None, None, None],
        "grok": [None, None, None], "perplexity": [None, None, None]}),
    ("affordable crm for real estate agents", 12, "/industries/real-estate", {
        "gpt4": [4, 5, 4], "claude": [6, 5, 6], "gemini": [5, None, 6],
        "grok": [None, 6, 5], "perplexity": [1, 1, 2]}),
    ("crm pricing comparison", 7, "/pricing", {
        "gpt4": [None, None, None], "claude": [6, None, 7], "gemini": [None, None, None],
        "grok": [None, None, None], "perplexity": [8, None, None]}),
    ("simple crm for freelancers", 31, "/solutions/freelancers", {
        "gpt4": [2, 3, 2], "claude": [3, 2, 3], "gemini": [3, 3, None],
        "grok": [2, 2, 3], "perplexity": [3, 4, 3]}),
    ("crm that integrates with gmail", 3, "/integrations/gmail", {
        "gpt4": [9, None, 10], "claude": [None, None, None], "gemini": [8, 9, None],
        "grok": [None, None, None], "perplexity": [10, None, None]}),
]
RUN_AGES_DAYS = (15, 8, 1)
SERPAPI_COST_PER_SEARCH_USD = Decimal("0.01")


def _brand_list(rank, offset=0):
    """Brands in answer order, with ours at ``rank`` (or absent).

    The category leader (first competitor) leads every list; ``offset``
    rotates the rest and varies the list length.
    """
    leader, *rest = [c["name"] for c in COMPETITORS] + OTHER_BRANDS
    shift = offset % len(rest)
    names = [leader, *rest[shift:], *rest[:shift]]
    length = max(4 + offset % 4, rank or 0)
    listed = names[: length - (1 if rank else 0)]
    if rank:
        listed.insert(rank - 1, BRAND)
    return listed


def _host(url: str) -> str:
    _, host, _ = normalize_url(url)
    return host


def _result(audit, prompt, text, engine, rank, run, offset) -> LLMRankingResult:
    brands = _brand_list(rank, offset)
    answer = "\n".join(f"{i}. {name}" for i, name in enumerate(brands, start=1))
    return LLMRankingResult(
        audit=audit, provider=engine, prompt=text, prompt_index=0, run_id=run,
        response_text=f"Here are good options for {text}:\n{answer}",
        is_mentioned=rank is not None,
        mention_rank=rank,
        sentiment=(
            LLMRankingResult.SENTIMENT_NOT_MENTIONED if rank is None
            else LLMRankingResult.SENTIMENT_POSITIVE if rank <= 3
            else LLMRankingResult.SENTIMENT_NEUTRAL
        ),
        mention_context=(
            f"{BRAND} is quick to set up and easy for a small team to adopt."
            if rank else ""
        ),
        competitors_mentioned=[
            {"name": name, "position": i, "linked": False}
            for i, name in enumerate(brands, start=1) if name != BRAND
        ],
        source_prompt=prompt,
        extraction_model="fixture",
    )


def _citations(result, own_url) -> list[Citation]:
    offset = (ENGINES.index(result.provider) + len(result.prompt)) % len(THIRD_PARTY)
    urls = [THIRD_PARTY[(offset + i) % len(THIRD_PARTY)] for i in range(3)]
    # Engines that rank you near the top cite your own page too.
    if own_url and result.is_mentioned and result.mention_rank and result.mention_rank <= 3:
        urls.insert(0, own_url)
    rows = []
    for position, url in enumerate(urls, start=1):
        normalized, host, apex = normalize_url(url)
        rows.append(Citation(
            result=result, audit=result.audit, url=url, normalized_url=normalized,
            domain=host, apex_domain=apex,
            source_class=SourceClass.YOUR_SITE if url == own_url else SourceClass.OTHER,
            position=position, is_target=url == own_url,
        ))
    return rows


def _google_check(website, brand_prompt, text, position, own_url, now) -> GoogleRankCheck:
    pool = COMPETITOR_PAGES + THIRD_PARTY
    offset = len(text) % len(pool)
    top = [pool[(offset + i) % len(pool)] for i in range(10)]
    if position and position <= 10:
        top[position - 1] = own_url
    top_results = []
    for i, url in enumerate(top, start=1):
        host = _host(url)
        top_results.append({
            "position": i, "url": url,
            "domain": host[4:] if host.startswith("www.") else host,
            "title": f"{text.title()} - result {i}",
        })
    pages = math.ceil(position / 10) if position else 10
    return GoogleRankCheck(
        website=website, brand_prompt=brand_prompt, query=text, location="us",
        depth=100, position=position, url=own_url if position else "",
        title=f"{BRAND}: {text}" if position else "", top_results=top_results,
        ai_overview={
            "shown": True, "mentions_you": bool(position and position <= 3),
            "cites_you": bool(position and position <= 3),
            "references": [{"url": u, "domain": _host(u), "title": ""} for u in THIRD_PARTY[:3]],
        },
        pages_fetched=pages,
        cost_usd=SERPAPI_COST_PER_SEARCH_USD * pages,
        checked_at=now - timedelta(days=1),
    )


def _build_project(user) -> Website:
    website = Website.objects.create(
        user=user, url=SITE, name=BRAND, industry="CRM software",
        description="Simple CRM for small teams.", competitors=COMPETITORS,
    )
    now = timezone.now()
    industry, _ = Industry.objects.get_or_create(
        slug="fixture-crm", defaults={"name": "CRM (fixture)", "is_active": True},
    )
    for index, (text, position, path, ranks) in enumerate(SCENARIOS):
        prompt = Prompt.objects.create(
            industry=industry, text=text, template_text=text, text_hash=text_hash(text),
            intent_bucket="category", style="question", source=PromptSource.MANUAL,
        )
        brand_prompt = BrandPrompt.objects.create(website=website, prompt=prompt, location="us")
        own_url = f"{SITE}{path}" if path else ""

        for run, age in enumerate(RUN_AGES_DAYS):
            ran_at = now - timedelta(days=age)
            audit = LLMRankingAudit.objects.create(
                website=website, created_by=user, status=LLMRankingAudit.STATUS_COMPLETED,
                prompts=[text], business_name=BRAND, providers_queried=list(ENGINES),
                completed_at=ran_at,
            )
            results = [
                _result(
                    audit, prompt, text, engine, ranks[engine][run], run,
                    offset=3 * index + ENGINES.index(engine) + run,
                )
                for engine in ENGINES
            ]
            LLMRankingResult.objects.bulk_create(results)
            LLMRankingResult.objects.filter(audit=audit).update(created_at=ran_at)
            citations = []
            for result in results:
                citations.extend(_citations(result, own_url))
            Citation.objects.bulk_create(citations)

        _google_check(website, brand_prompt, text, position, own_url, now).save()
    return website


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Fixture Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user, settings):
    settings.SERPAPI_KEY = ""
    return _build_project(user)


def _data(resp):
    body = resp.json()
    return body.get("data", body)


def _row(overview, text):
    return next(r for r in overview["prompts"] if r["text"] == text)


def test_overview_classes_every_prompt(website):
    overview = build_overview(website)
    kpis = overview["kpis"]
    assert kpis["prompts"] == 8
    assert kpis["google_checked"] == 8
    assert kpis["not_in_google"] == 1
    assert (kpis["ai_ahead"], kpis["google_ahead"], kpis["strong_both"], kpis["invisible_both"]) == (2, 3, 2, 1)
    assert overview["serp_configured"] is False

    owner_example = _row(overview, "best crm for small business")
    assert owner_example["gap"]["class"] == "ai_ahead"
    assert owner_example["google"]["position"] == 94
    assert owner_example["google"]["page"] == 10
    assert owner_example["engines"]["claude"]["rank"] == 2
    assert owner_example["engines"]["chatgpt"]["class"] == "ai_ahead"
    assert owner_example["top_action"]["kind"] == "make_page_rank"

    assert _row(overview, "crm with built-in email automation")["gap"]["class"] == "google_ahead"
    assert _row(overview, "how to choose a crm")["gap"]["class"] == "invisible_both"
    # Biggest gaps first.
    values = [abs(r["gap"]["value"] or 0) for r in overview["prompts"]]
    assert values == sorted(values, reverse=True)


def test_leaderboard_includes_you(website):
    board = build_overview(website)["leaderboard"]
    you = [b for b in board if b["is_you"]]
    assert len(you) == 1 and you[0]["name"] == BRAND
    assert any(b["name"] == COMPETITORS[0]["name"] for b in board)


def test_prompt_detail_explains_the_gap_and_where_to_change(website):
    bp = BrandPrompt.objects.select_related("prompt").get(
        website=website, prompt__text="best crm for small business",
    )
    detail = build_prompt_detail(website, bp)
    assert detail["verdict"] == (
        "Claude lists you #2, and 2 other engines mention you. Google has you at #94 (page 10)."
    )
    first = detail["actions"][0]
    assert first["kind"] == "make_page_rank"
    assert first["targets"][0]["url"] == f"{SITE}/blog/small-business-crm"
    kinds = [a["kind"] for a in detail["actions"]]
    assert "earn_links" in kinds and "study_competitor" in kinds
    claude = next(e for e in detail["engines"] if e["key"] == "claude")
    assert any(c["is_yours"] for c in claude["citations"])
    assert claude["snippet"]
    assert any(r["is_competitor"] for r in detail["google"]["top_results"])
    assert detail["google"]["gsc"] is None


def test_prompt_detail_includes_search_console_totals(website):
    from datetime import date

    from apps.search_console.models import GscQueryStat

    today = date.today()
    GscQueryStat.objects.bulk_create([
        GscQueryStat(website=website, date=today - timedelta(days=2), query="best crm for small business",
                     clicks=3, impressions=100, ctr=0.03, position=90.0),
        GscQueryStat(website=website, date=today - timedelta(days=3), query="Best CRM for small business",
                     clicks=1, impressions=300, ctr=0.003, position=98.0),
        # Outside the 28-day window: ignored.
        GscQueryStat(website=website, date=today - timedelta(days=60), query="best crm for small business",
                     clicks=50, impressions=50, ctr=1.0, position=1.0),
    ])
    bp = BrandPrompt.objects.get(website=website, prompt__text="best crm for small business")
    gsc = build_prompt_detail(website, bp)["google"]["gsc"]
    # Impression-weighted: (90*100 + 98*300) / 400.
    assert gsc == {"clicks": 4, "impressions": 400, "avg_position": 96.0, "days": 28}


def test_api_overview_detail_and_check(user, website):
    client = APIClient()
    client.force_authenticate(user)
    base = f"/api/v1/search-gap/websites/{website.id}"

    resp = client.get(f"{base}/overview/")
    assert resp.status_code == 200
    overview = _data(resp)
    assert overview["kpis"]["prompts"] == 8

    prompt_id = overview["prompts"][0]["prompt_id"]
    resp = client.get(f"{base}/prompts/{prompt_id}/")
    assert resp.status_code == 200
    assert _data(resp)["actions"]

    assert client.get(f"{base}/prompts/{uuid.uuid4()}/").status_code == 404
    # No SerpAPI key: the check endpoint says so instead of queueing.
    assert client.post(f"{base}/prompts/{prompt_id}/check/").status_code == 409


def test_other_users_cannot_read_the_project(website):
    stranger = get_user_model().objects.create_user(
        email="stranger@example.com", password="x" * 16, full_name="Stranger",
        is_email_verified=True,
    )
    client = APIClient()
    client.force_authenticate(stranger)
    resp = client.get(f"/api/v1/search-gap/websites/{website.id}/overview/")
    assert resp.status_code in (403, 404)


def test_refactored_prompt_detail_view_still_aggregates_by_model(user, website):
    """The by_model roll-up moved into prompt_stats; the old view must not change."""
    bp = BrandPrompt.objects.get(website=website, prompt__text="best crm for small business")
    client = APIClient()
    client.force_authenticate(user)
    resp = client.get(
        f"/api/v1/prompt-library/websites/{website.id}/prompts/{bp.prompt_id}/detail/",
    )
    assert resp.status_code == 200
    by_model = {m["provider"]: m for m in _data(resp)["by_model"]}
    assert by_model["gpt4"]["responses"] == 3
    assert by_model["gpt4"]["visibility_pct"] == 100.0
    assert by_model["gpt4"]["avg_rank"] == 2.3
    assert by_model["gemini"]["mentioned"] == 0
    assert by_model["grok"]["rank_buckets"] == {"1": 0, "2-3": 0, "4-10": 2, "11+": 0}


def test_project_update_sets_competitors_without_wiping_topics(user, website):
    website.topics = ["crm"]
    website.save(update_fields=["topics"])
    client = APIClient()
    client.force_authenticate(user)
    resp = client.put(
        f"/api/v1/websites/{website.id}/",
        {"name": "Fixture", "competitors": [{"name": " Close ", "domain": "Close.example"}]},
        format="json",
    )
    assert resp.status_code == 200
    website.refresh_from_db()
    assert website.name == "Fixture"
    assert website.topics == ["crm"]
    assert website.competitors == [{"name": "Close", "domain": "close.example"}]
    assert _data(resp)["competitors"] == website.competitors


def test_a_miss_within_the_top_10_is_a_range_not_a_zero(website):
    # ScraperAPI reads page one only: "not in the top 10" means position 11
    # or later, a search score from 0 to 55, never a flat 0.
    check = GoogleRankCheck.objects.get(website=website, position__isnull=True)
    check.depth = 10
    check.save(update_fields=["depth"])
    overview = build_overview(website)
    row = next(r for r in overview["prompts"] if r["brand_prompt_id"] == str(check.brand_prompt_id))
    gap = row["gap"]
    assert row["google"]["score_max"] == 55
    assert (gap["search_score"], gap["search_score_max"], gap["value"]) == (None, 55, None)
    if gap["definite"]:
        assert gap["class"] != "no_data" and gap["value_min"] == gap["ai_score"] - 55
    else:
        assert (gap["class"], gap["value_min"]) == ("no_data", None)
        assert overview["kpis"]["not_definite"] == 1
    # A found position keeps its exact value.
    found = _row(overview, "best crm for small business")["gap"]
    assert found["definite"] is True and found["value"] is not None and found["search_score_max"] is None

