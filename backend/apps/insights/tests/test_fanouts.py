"""Query fan-outs (p2 backend 8, contract 8): searches grouped per prompt by
idea_key, the per-answer states (not recorded, no web search, not
reported), Google states of each search, the empty reasons, the writers'
``queries_for_prompts``, and the ``fanout_google`` kind. Google is a fake
``serp_google.search``; nothing reaches the network."""

from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone

from apps.citations.services import serp_google
from apps.insights.models import FanoutGoogleCheck
from apps.insights.services import fanouts, google, runs
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.prompt_library.models import BrandPrompt, Industry, Prompt, PromptSource
from apps.prompt_library.services._hash import text_hash
from apps.search_gap.models import GoogleRankCheck
from apps.websites.models import Website
from core.exceptions import CanseeException, ResourceNotFound

pytestmark = pytest.mark.django_db

SITE = "https://www.notes-fixture.example"


@pytest.fixture(autouse=True)
def fresh(settings, monkeypatch):
    cache.clear()
    settings.LLM_WEBSEARCH_ENABLED = True
    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = "scraper-test"
    monkeypatch.setattr(google, "RETRY_SECONDS", 0)
    yield
    cache.clear()


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Fixture Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url=SITE, name="Fixture Notes",
                                  competitors=[{"name": "Alpha", "domain": "alpha.example"}])


def track(website, text: str, location: str = "us") -> BrandPrompt:
    industry, _ = Industry.objects.get_or_create(
        slug="fixture-notes", defaults={"name": "Notes (fixture)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, text_hash=text_hash(text),
        intent_bucket="category", style="question", source=PromptSource.MANUAL,
    )
    return BrandPrompt.objects.create(website=website, prompt=prompt, location=location)


def answer(bp, engine="gpt4", queries=None, searches=None, hours_ago=24) -> LLMRankingResult:
    audit = LLMRankingAudit.objects.create(
        website=bp.website, created_by=bp.website.user, status=LLMRankingAudit.STATUS_COMPLETED,
        prompts=[bp.prompt.text], business_name="Fixture Notes", providers_queried=[engine],
    )
    result = LLMRankingResult.objects.create(
        audit=audit, provider=engine, prompt=bp.prompt.text, response_text="An answer.",
        source_prompt=bp.prompt, query_succeeded=True, search_queries=queries,
        web_searches=searches,
    )
    when = timezone.now() - timedelta(hours=hours_ago)
    LLMRankingResult.objects.filter(id=result.id).update(created_at=when)
    result.created_at = when
    return result


def google_check(website, bp, query, *, position=None, error="", days_ago=1, location=None):
    return FanoutGoogleCheck.objects.create(
        website=website, prompt=bp.prompt, query=query, query_key=fanouts.idea_key(query),
        location=bp.location if location is None else location, position=position, depth=10,
        url=f"{SITE}/x" if position else "", error_code=error,
        checked_at=timezone.now() - timedelta(days=days_ago),
    )


# ── the payload ───────────────────────────────────────────────────────────


def test_searches_are_grouped_per_prompt_by_their_key(website):
    notes = track(website, "best note app")
    teams = track(website, "notes for teams")
    answer(notes, "gpt4", ["Best note apps 2026", "notion pricing"], 2, hours_ago=30)
    answer(notes, "claude", ["best note apps, 2026?"], 1, hours_ago=5)
    answer(notes, "gpt4", ["old search"], 1, hours_ago=24 * 40)
    answer(notes, "perplexity")
    answer(teams, "gpt4", [], 0)

    payload = fanouts.build(website, period="30d")

    assert payload["totals"] == {"answers": 4, "recorded": 3, "searched": 2, "searches": 3,
                                 "queries": 3, "unique_queries": 2}
    assert payload["empty_reason"] is None
    assert [p["text"] for p in payload["prompts"]] == ["best note app", "notes for teams"]
    first = payload["prompts"][0]
    assert (first["answers"], first["searched"], first["searches"], first["not_reported"]) == (
        3, 2, 3, 0)
    assert first["location"] == "us"
    assert first["queries"][0] == {
        "key": "best note apps 2026", "text": "best note apps, 2026?",
        "engines": ["chatgpt", "claude"], "answers": 2,
        "last_seen_at": first["queries"][0]["last_seen_at"],
        "google": {"state": "not_checked", "position": None, "depth": None, "checked_at": None,
                   "url": None},
    }
    assert [q["text"] for q in first["queries"]] == ["best note apps, 2026?", "notion pricing"]
    assert payload["prompts"][1]["queries"] == [] and payload["prompts"][1]["searched"] == 0
    engines = {e["key"]: e for e in payload["by_engine"]}
    assert engines["chatgpt"] == {"key": "chatgpt", "answers": 2, "recorded": 2, "searched": 1,
                                  "searches": 2, "queries": 2}
    assert engines["perplexity"]["recorded"] == 0
    assert payload["web_search"] == {"enabled": True, "engines": [
        {"key": "chatgpt", "reports_queries": True}, {"key": "claude", "reports_queries": True},
        {"key": "gemini", "reports_queries": False}, {"key": "grok", "reports_queries": False},
        {"key": "perplexity", "reports_queries": False}]}
    assert payload["active_run"] is None and payload["last_run"] is None


def test_searches_without_their_text_are_not_reported(website):
    bp = track(website, "best note app")
    answer(bp, "gpt4", ["notion pricing"], 3)

    first = fanouts.build(website)["prompts"][0]

    assert (first["searches"], first["not_reported"], len(first["queries"])) == (3, 2, 1)


def test_each_search_shows_its_newest_google_check_of_30_days(website):
    bp = track(website, "best note app")
    answer(bp, "gpt4", ["found search", "missing search", "failed search", "stale search",
                        "elsewhere search"], 5)
    google_check(website, bp, "Found search", position=9, days_ago=3)
    google_check(website, bp, "found search", position=4, days_ago=1)
    google_check(website, bp, "missing search")
    google_check(website, bp, "failed search", error="serp_failed")
    google_check(website, bp, "stale search", position=2, days_ago=31)
    google_check(website, bp, "elsewhere search", position=1, location="gb")

    queries = {q["key"]: q["google"] for q in fanouts.build(website)["prompts"][0]["queries"]}

    assert queries["found search"]["state"] == "found"
    assert (queries["found search"]["position"], queries["found search"]["depth"],
            queries["found search"]["url"]) == (4, 10, f"{SITE}/x")
    assert queries["missing search"] == {"state": "not_found", "position": None, "depth": 10,
                                         "checked_at": queries["missing search"]["checked_at"],
                                         "url": None}
    assert queries["failed search"]["state"] == "failed"
    assert queries["stale search"]["state"] == "not_checked"
    assert queries["elsewhere search"]["state"] == "not_checked"


def test_engine_and_prompt_filters(website, user):
    notes = track(website, "best note app")
    teams = track(website, "notes for teams")
    answer(notes, "gpt4", ["a search"], 1)
    answer(notes, "claude", ["b search"], 1)
    answer(teams, "claude", ["c search"], 1)

    claude = fanouts.build(website, engine="claude")
    one = fanouts.build(website, prompt_id=str(teams.prompt_id))

    assert claude["filters"] == {"engine": "claude", "prompt_id": None}
    assert claude["totals"]["answers"] == 2
    assert [q["text"] for p in claude["prompts"] for q in p["queries"]] == ["b search", "c search"]
    assert [p["text"] for p in one["prompts"]] == ["notes for teams"]
    other = Website.objects.create(user=user, url="https://other.example", name="Other")
    stranger = track(other, "someone else's prompt")
    with pytest.raises(ResourceNotFound):
        fanouts.build(website, prompt_id=str(stranger.prompt_id))
    with pytest.raises(CanseeException):
        fanouts.build(website, engine="bing")


def test_empty_reasons(website, settings):
    bp = track(website, "best note app")
    assert fanouts.build(website)["empty_reason"] == "no_answers"

    answer(bp, "gpt4")
    assert fanouts.build(website)["empty_reason"] == "none_recorded"

    settings.LLM_WEBSEARCH_ENABLED = False
    answer(bp, "claude", [], 0)
    off = fanouts.build(website)
    assert off["empty_reason"] == "web_search_off" and off["web_search"]["enabled"] is False

    answer(bp, "gpt4", ["kept from when it was on"], 1)
    assert fanouts.build(website)["empty_reason"] is None


def test_queries_for_prompts_lists_the_most_seen_searches(website):
    notes = track(website, "best note app")
    teams = track(website, "notes for teams")
    other = track(website, "unrelated prompt")
    answer(notes, "gpt4", ["notion pricing", "notion vs evernote"], 2)
    answer(notes, "claude", ["Notion pricing"], 1)
    answer(teams, "gpt4", ["team wiki tools"], 1, hours_ago=48)
    answer(other, "gpt4", ["not asked for"], 1)
    google_check(website, notes, "notion pricing", position=3)

    rows = fanouts.queries_for_prompts(website, [notes.prompt_id, str(teams.prompt_id)], limit=2)

    assert [r["query"] for r in rows] == ["Notion pricing", "notion vs evernote"]
    assert rows[0]["prompt_text"] == "best note app"
    assert (rows[0]["engines"], rows[0]["answers"]) == (["chatgpt", "claude"], 2)
    assert rows[0]["google"]["state"] == "found"
    assert fanouts.queries_for_prompts(website, ["not-a-uuid"]) == []
    assert len(fanouts.queries_for_prompts(website, [notes.prompt_id, teams.prompt_id])) == 3


# ── kind fanout_google ────────────────────────────────────────────────────


def test_validate_needs_recorded_searches(website, settings):
    bp = track(website, "best note app")
    answer(bp, "gpt4", ["notion pricing"], 1)

    def codes(params):
        with pytest.raises(CanseeException) as err:
            fanouts.validate(website, params)
        return err.value.code, err.value.message

    assert codes({"queries": []}) == ("nothing_to_run", "Choose at least one search.")
    assert codes({"queries": [{"prompt_id": str(bp.prompt_id), "text": "never searched"}]}) == (
        "invalid", "This search wasn't recorded for this prompt.")
    assert codes({"queries": [{"prompt_id": "nope", "text": "notion pricing"}]})[0] == "invalid"
    plan = fanouts.validate(website, {"queries": [
        {"prompt_id": str(bp.prompt_id), "text": "Notion  pricing?"},
        {"prompt_id": str(bp.prompt_id), "text": "notion pricing"},
    ]})
    assert [(s.text, s.key, s.location) for s in plan] == [("notion pricing", "notion pricing", "us")]

    settings.INSIGHTS_FANOUT_MAX_QUERIES = 1
    texts = ["notion pricing", "other search"]
    answer(bp, "gpt4", texts, 2)
    assert codes({"queries": [{"prompt_id": str(bp.prompt_id), "text": t} for t in texts]}) == (
        "too_many", "This run is over the limit of 1 searches.")

    settings.SCRAPERAPI_KEY = ""
    assert codes({"queries": [{"prompt_id": str(bp.prompt_id), "text": "notion pricing"}]}) == (
        "not_configured", "Google results aren't configured on this server.")


def serp_page(*rows, error=""):
    return {"error": error, "provider": "scraperapi", "organic": [
        {"rank": i, "position": i, "url": url, "domain": domain, "title": f"Result {i}"}
        for i, (url, domain) in enumerate(rows, start=1)
    ]}


def test_a_run_checks_each_search_on_google(website, user, monkeypatch):
    bp = track(website, "best note app", location="gb")
    answer(bp, "gpt4", ["notion pricing", "notion vs evernote"], 2)
    calls = []
    pages = {
        "notion pricing": [serp_page(("https://alpha.example/p", "alpha.example"),
                                     ("https://g2.example/notes", "g2.example"),
                                     (f"{SITE}/pricing", "notes-fixture.example"))],
        "notion vs evernote": [{"error": "http_500"}, {"error": "network"}],
    }

    def search(query, *, max_results, country=None, **kwargs):
        calls.append((query, max_results, country))
        return pages[query].pop(0)

    monkeypatch.setattr(serp_google, "search", search)
    params = {"queries": [{"prompt_id": str(bp.prompt_id), "text": "notion pricing"},
                          {"prompt_id": str(bp.prompt_id), "text": "notion vs evernote"}]}

    est = runs.estimate(website, user, "fanout_google", params)
    assert (est["google"]["pages_max"], est["google"]["credits_max"]) == (2, 50)
    assert est["summary"] == "2 searches checked on Google"
    run = runs.create_run(website, user, "fanout_google", params, est["confirm"])

    assert run.status == "partial"
    assert (run.units_done, run.units_failed, run.google_pages) == (1, 1, 1)
    assert sorted(calls) == [("notion pricing", 10, "gb"), ("notion vs evernote", 10, "gb"),
                             ("notion vs evernote", 10, "gb")]
    found = FanoutGoogleCheck.objects.get(query="notion pricing")
    assert (found.position, found.depth, found.url, found.location) == (3, 3, f"{SITE}/pricing", "gb")
    assert [(r["is_yours"], r["is_competitor"]) for r in found.top_results] == [
        (False, True), (False, False), (True, False)]
    failed = FanoutGoogleCheck.objects.get(query="notion vs evernote")
    assert failed.error_code == "serp_failed" and failed.position is None
    assert not GoogleRankCheck.objects.exists()

    queries = {q["key"]: q["google"] for q in fanouts.build(website)["prompts"][0]["queries"]}
    assert queries["notion pricing"]["state"] == "found"
    assert queries["notion vs evernote"]["state"] == "failed"


def test_a_search_past_the_daily_google_pages_is_skipped(website):
    bp = track(website, "best note app")
    search = fanouts.Search(bp, "notion pricing", "notion pricing")
    ended = []
    ctx = SimpleNamespace(
        cancelled=lambda: False, google_page=lambda: False, start_item=lambda: None,
        end_item=lambda status, error=None, started=True: ended.append((status, error)),
        website=website, run=None,
    )

    fanouts._check(ctx, search, "notes-fixture.example", set())

    assert ended == [("skipped", "daily_limit")]
    assert not FanoutGoogleCheck.objects.exists()
