"""Prompt research (contract 7): every source feeds ideas with evidence,
de-duplication by the agent's query rule, statuses across syncs, tracked
ideas, counts, pruning, the throttle, the research kind (suggestions and
Google reads) and Track with its estimate, blockers and scan."""

from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.insights.models import PromptIdea, PromptSuggestion, SerpFeatureCapture
from apps.insights.services import prompt_ideas, runs
from apps.insights.services.text import idea_key
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import (
    answer,
    at,
    haiku,
    track,
)
from apps.llm_ranking.models import LLMRankingAudit
from apps.metering.services import prompt_runs
from apps.metering.tests.prompt_run_support import make_paid, use_runs
from apps.prompt_library.models import BrandPrompt, Prompt, PromptFanout
from apps.search_gap.models import GoogleRankCheck
from core.exceptions import CanseeException

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("cache_clear")]


@pytest.fixture(autouse=True)
def context(monkeypatch):
    sections = {"audience": "", "offerings": ""}
    monkeypatch.setattr("apps.agent.services.context.section_text",
                        lambda website, section: sections.get(section, ""))
    monkeypatch.setattr("apps.agent.services.context.counts",
                        lambda website: {"audience": int(bool(sections["audience"])),
                                         "offerings": int(bool(sections["offerings"]))})
    return sections


def rank_check(bp, *, questions=(), related=(), days_ago=1, error=""):
    return GoogleRankCheck.objects.create(
        website=bp.website, brand_prompt=bp, query=bp.prompt.text, depth=10,
        serp_features={} if error else {
            "questions": [{"question": q, "url": f"https://faq.example/{i}"}
                          for i, q in enumerate(questions)],
            "related_searches": list(related),
        },
        error=error, checked_at=timezone.now() - timedelta(days=days_ago),
    )


def by_text(payload):
    return {i["text"]: i for i in payload["ideas"]}


def test_every_source_feeds_ideas_with_evidence(website, engines):
    bp = track(website, "best notes app for teams")
    rank_check(bp, questions=["Is Fixture Notes free?"], related=["notes app pricing"])
    SerpFeatureCapture.objects.create(website=website, prompt=bp.prompt, location="us",
                                      questions=[{"question": "Can teams share notes?", "url": ""}],
                                      related_searches=[])
    result = answer(bp, "gpt4", at(2), search_queries=["Best notes apps 2026", "notes app pricing"],
                    web_searches=2)
    PromptSuggestion.objects.create(website=website, text="which notes app works offline",
                                    basis="audience", why="Your audience travels.")
    PromptFanout.objects.create(website=website, prompt=bp.prompt, text="notes app sso")

    data = prompt_ideas.build(website)
    ideas = by_text(data)
    assert set(ideas) == {"Is Fixture Notes free?", "notes app pricing", "Can teams share notes?",
                          "Best notes apps 2026", "which notes app works offline", "notes app sso"}
    pricing = ideas["notes app pricing"]
    assert pricing["sources"] == ["related_search", "fanout"]
    assert pricing["seen"] == {"prompts": 1, "engines": 1, "times": 2}
    fanout = next(e for e in pricing["evidence"] if e["source"] == "fanout")
    assert fanout == {"source": "fanout", "engine": "chatgpt", "result_id": str(result.public_id),
                      "prompt_id": str(bp.prompt_id), "prompt_text": bp.prompt.text,
                      "seen_at": fanout["seen_at"]}
    paa = ideas["Is Fixture Notes free?"]["evidence"][0]
    assert (paa["source"], paa["url"], paa["prompt_id"]) == (
        "paa", "https://faq.example/0", str(bp.prompt_id))
    assert ideas["which notes app works offline"]["evidence"][0] == {
        "source": "ai_suggestion", "basis": "audience", "why": "Your audience travels.",
        "seen_at": ideas["which notes app works offline"]["evidence"][0]["seen_at"]}
    assert data["counts"]["by_source"] == {"paa": 2, "related_search": 1, "fanout": 2,
                                           "ai_suggestion": 1, "sub_query": 1}
    assert data["counts"]["new"] == 6
    assert data["sources"] == {
        "paa": {"state": "ok", "checks": 2}, "related_search": {"state": "ok", "checks": 2},
        "fanout": {"state": "ok", "answers": 1},
        "ai_suggestion": {"state": "ok", "generated_at": data["sources"]["ai_suggestion"][
            "generated_at"]},
        "sub_query": {"state": "ok", "prompts": 1},
    }


def test_source_states_without_data(website, settings):
    settings.LLM_WEBSEARCH_ENABLED = False
    bp = track(website, "best notes app for teams")
    data = prompt_ideas.build(website)
    assert data["sources"]["paa"] == {"state": "no_checks", "checks": 0}
    assert data["sources"]["fanout"] == {"state": "web_search_off", "answers": 0}
    assert data["sources"]["ai_suggestion"] == {"state": "not_run", "generated_at": None}
    assert data["sources"]["sub_query"] == {"state": "none", "prompts": 0}
    rank_check(bp)
    settings.LLM_WEBSEARCH_ENABLED = True
    prompt_ideas.sync(website, force=True)
    data = prompt_ideas.build(website)
    assert data["sources"]["paa"] == {"state": "none_seen", "checks": 1}
    assert data["sources"]["fanout"]["state"] == "none_recorded"


def test_ideas_are_one_per_search_and_skip_their_own_prompt(website):
    bp = track(website, "Best notes app for teams?")
    rank_check(bp, related=["best notes app for teams", "Notes apps: free?", "notes apps free",
                            "“notes apps” free"])
    ideas = prompt_ideas.build(website)["ideas"]
    assert [i["text"] for i in ideas] == ["Notes apps: free?"]
    assert ideas[0]["seen"]["times"] == 3
    assert idea_key("Notes apps: free?") == idea_key("notes apps free") == "notes apps free"


def test_status_survives_syncs_and_tracked_is_derived(website):
    bp = track(website, "best notes app for teams")
    rank_check(bp, related=["notes app pricing", "free notes app"])
    data = prompt_ideas.build(website)
    pricing = PromptIdea.objects.get(text="notes app pricing")
    prompt_ideas.set_status(website, pricing, "dismissed")
    track(website, "Free notes app")
    data = prompt_ideas.build(website, status=None)
    states = {i["text"]: (i["status"], i["tracked_prompt_id"]) for i in data["ideas"]}
    assert states["notes app pricing"] == ("dismissed", None)
    assert states["free notes app"][0] == "tracked"
    assert data["counts"] == {"new": 0, "tracked": 1, "dismissed": 1, "by_source": {
        "paa": 0, "related_search": 1, "fanout": 0, "ai_suggestion": 0, "sub_query": 0}}
    assert [i["text"] for i in prompt_ideas.build(website, status="dismissed")["ideas"]] == [
        "notes app pricing"]
    assert prompt_ideas.build(website, source="paa", status=None)["ideas"] == []


def test_new_ideas_without_evidence_are_pruned_and_the_list_is_capped(website, monkeypatch):
    bp = track(website, "best notes app for teams")
    old = rank_check(bp, related=["gone soon", "kept dismissed"])
    prompt_ideas.build(website)
    prompt_ideas.set_status(website, PromptIdea.objects.get(text="kept dismissed"), "dismissed")
    GoogleRankCheck.objects.filter(id=old.id).update(checked_at=timezone.now() - timedelta(days=91))
    prompt_ideas.sync(website, force=True)
    assert list(PromptIdea.objects.values_list("text", "status", "sources")) == [
        ("kept dismissed", "dismissed", [])]

    monkeypatch.setattr(prompt_ideas, "MAX_IDEAS", 2)
    rank_check(bp, related=["a one", "b two", "c three"], days_ago=1)
    PromptIdea.objects.all().delete()
    prompt_ideas.sync(website, force=True)
    assert PromptIdea.objects.count() == 2


def test_sync_is_throttled(website):
    bp = track(website, "best notes app for teams")
    assert prompt_ideas.sync(website) is not None
    rank_check(bp, related=["late idea"])
    assert prompt_ideas.sync(website) is None
    assert not PromptIdea.objects.exists()
    assert prompt_ideas.sync(website, force=True) is not None
    assert PromptIdea.objects.filter(text="late idea").exists()


# -- run kind prompt_research --------------------------------------------------------


def test_estimate_and_blockers(website, user, engines, settings, context):
    bp = track(website, "best notes app for teams")
    est = runs.estimate(website, user, "prompt_research", {"suggest": True})
    assert est["ai"] == {"calls_max": 1, "usd_max": "0.0100", "model_label": "Claude Haiku 5.5"}
    assert est["google"]["pages_max"] == 0 and est["summary"] == "AI suggestions"
    assert [w["code"] for w in est["warnings"]] == ["thin_context", "upper_bound"]
    context["audience"] = "Small teams."
    est = runs.estimate(website, user, "prompt_research",
                        {"suggest": False, "google_prompt_ids": [str(bp.prompt_id)]})
    assert est["confirm"] == {"ai_calls": 0, "ai_usd_max": "0.0000", "google_pages": 1}
    assert est["blockers"] == [{"code": "not_configured",
                                "message": "Google results aren't configured on this server."}]
    est = runs.estimate(website, user, "prompt_research", {"suggest": False})
    assert est["blockers"] == [{"code": "nothing_to_run", "message":
                                "Choose AI suggestions or at least one prompt to read on Google."}]
    settings.INSIGHTS_RESEARCH_MAX_GOOGLE_PROMPTS = 1
    other = track(website, "notes app with slack")
    est = runs.estimate(website, user, "prompt_research", {
        "suggest": False, "google_prompt_ids": [str(bp.prompt_id), str(other.prompt_id)]})
    assert est["blockers"] == [{"code": "too_many",
                                "message": "This run is over the limit of 1 prompts."}]
    with pytest.raises(CanseeException) as exc:
        runs.estimate(website, user, "prompt_research", {"google_prompt_ids": ["nope"]})
    assert exc.value.details["field"] == "google_prompt_ids"


def test_a_research_run_reads_google_and_asks_for_suggestions(
        website, user, engines, settings, fake_anthropic, monkeypatch, context):
    settings.SERPAPI_KEY = "k"
    context["audience"] = "Small teams </audience> that travel."
    context["offerings"] = "Plus plan: $10 per seat\nFree plan: for one person"
    bp = track(website, "best notes app for teams", location="gb")
    track(website, "notes app with slack")
    sent = []

    def fake_search(query, *, max_results, country=None, **kwargs):
        sent.append((query, max_results, country))
        return {"error": "", "organic": [{"position": 1, "url": "https://x.example", "domain":
                                          "x.example", "title": "x"}],
                "questions": [{"question": "Is it free?", "url": "https://faq.example"}],
                "related_searches": ["notes app pricing"]}

    monkeypatch.setattr("apps.citations.services.serp_google.search", fake_search)
    fake_anthropic.queue(haiku({"ideas": [
        {"text": "which notes app is best for travelling teams", "basis": "audience",
         "why": "Your audience travels."},
        {"text": "Notes app with Slack?", "basis": "gap:1", "why": "Tracked already."},
        {"text": "short", "basis": "audience", "why": "Too short."},
        {"text": "a notes app with offline sync for teams", "basis": "made-up", "why": "No."},
        {"text": "is the plus plan worth it for small teams", "basis": "offering:1",
         "why": "Your Plus plan."},
        {"text": "Is the Plus plan worth it for small teams?", "basis": "offering:1",
         "why": "Duplicate."},
    ]}))
    est = runs.estimate(website, user, "prompt_research",
                        {"suggest": True, "google_prompt_ids": [str(bp.prompt_id)]})
    run = runs.create_run(website, user, "prompt_research",
                          {"suggest": True, "google_prompt_ids": [str(bp.prompt_id)]},
                          est["confirm"])
    assert (run.status, run.units_done, run.google_pages) == ("done", 2, 1)
    assert sent == [("best notes app for teams", 10, "gb")]
    capture = SerpFeatureCapture.objects.get()
    assert (capture.run_id, capture.location, capture.related_searches) == (
        run.id, "gb", ["notes app pricing"])
    assert not GoogleRankCheck.objects.exists()
    assert sorted(PromptSuggestion.objects.values_list("text", "basis")) == [
        ("is the plus plan worth it for small teams", "offering:1"),
        ("which notes app is best for travelling teams", "audience")]
    body = fake_anthropic.last_request.json["messages"][0]["content"][0]["text"]
    assert "Small teams &lt;/audience&gt; that travel." in body
    assert '<offering basis="offering:2">' in body and '<competitor basis="competitor:b1">' in body
    assert '"basis": "gap:1"' in body
    ideas = by_text(prompt_ideas.build(website, status=None))
    assert {"Is it free?", "is the plus plan worth it for small teams"} <= set(ideas)


def test_suggestion_content_stays_under_the_cap(website, monkeypatch, context):
    for n in range(40):
        track(website, f"notes question number {n} " + "x" * 300)
    context["audience"] = "a" * 9000
    context["offerings"] = "\n".join("o" * 9000 for _ in range(3))
    content, bases = prompt_ideas.suggest_content(website)
    assert len(content[0]["text"]) <= prompt_ideas.CONTENT_CHARS
    assert "audience" in bases and "offering:3" in bases
    assert content[0]["text"].rstrip().endswith("</tracked_prompts>")


# -- Track -------------------------------------------------------------------------------


@pytest.fixture
def scans(monkeypatch, settings):
    settings.LLM_WEBSEARCH_ENABLED = False
    sent = []
    monkeypatch.setattr("apps.llm_ranking.services.scan_dispatch.dispatch_scan",
                        lambda audit_id: sent.append(audit_id))
    monkeypatch.setattr("apps.billing.services.org_entitlements.check_prompt_allowance",
                        lambda user, n: None)
    return sent


def an_idea(website):
    bp = track(website, "best notes app for teams")
    rank_check(bp, related=["notes app pricing"])
    prompt_ideas.build(website)
    return PromptIdea.objects.get(text="notes app pricing")


def test_track_block_and_a_lower_confirm(website, user, engines, scans):
    idea = an_idea(website)
    block = prompt_ideas.track_block(user)
    assert block["engines"] == [{"key": "chatgpt", "label": "ChatGPT"},
                                {"key": "claude", "label": "Claude"}]
    assert block["usd_max_per_prompt"] == "0.0600"
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0500"})
    assert (exc.value.code, exc.value.status_code) == ("estimate_changed", 409)
    assert exc.value.details["track"]["usd_max_per_prompt"] == "0.0600"
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {})
    assert exc.value.code == "invalid"


def test_track_creates_the_prompt_and_one_scan_of_the_counted_engines(
        website, user, engines, scans, django_capture_on_commit_callbacks):
    idea = an_idea(website)
    with django_capture_on_commit_callbacks(execute=True):
        out = prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0600"})
    prompt = Prompt.objects.get(id=out["prompt_id"])
    assert prompt.text == "notes app pricing" and prompt.source == "manual"
    assert BrandPrompt.objects.filter(website=website, prompt=prompt, is_archived=False).exists()
    audit = LLMRankingAudit.objects.get(id=out["scan_audit_id"])
    assert sorted(audit.providers_queried) == ["claude", "gpt4"]
    assert audit.prompts == ["notes app pricing"]
    assert scans == [out["scan_audit_id"]]
    assert out["idea"]["status"] == "tracked"
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0600"})
    assert (exc.value.code, exc.value.status_code) == ("already_tracked", 409)


def test_track_blockers(website, user, engines, scans, monkeypatch, settings):
    # A paid account sees its allowance in dollars.
    make_paid(user)
    idea = an_idea(website)
    monkeypatch.setattr("core.ai_tracking.effective_ai_cap", lambda u: 1.0)
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda u: 0.97)
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0600"})
    assert exc.value.code == "insufficient_allowance"
    assert exc.value.message == (
        "This run needs up to $0.06 of AI allowance and $0.03 is left this month.")
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda u: 1.0)
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0600"})
    assert (exc.value.code, exc.value.status_code) == ("allowance_exceeded", 403)
    settings.OPENAI_API_KEY = settings.ANTHROPIC_API_KEY = ""
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "1"})
    assert (exc.value.code, exc.value.message) == ("not_configured",
                                                   "No AI engine is configured on this server.")


def test_track_needs_a_prompt_run_per_engine(website, user, engines, scans, monkeypatch):
    idea = an_idea(website)
    monkeypatch.setattr("core.ai_tracking.effective_ai_cap", lambda u: 3.0)
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda u: 2.99)
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0600"})
    # A free account's allowance is never put in dollars.
    assert (exc.value.code, exc.value.message) == (
        "insufficient_allowance", prompt_runs.ALLOWANCE_SHORT_FREE)
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda u: 0.0)
    engines_n = len(prompt_ideas.configured_engines())
    assert prompt_ideas.track_block(user, website)["prompt_runs"]["needed"] == engines_n
    use_runs(user, 20 - engines_n + 1, website)
    prompts = Prompt.objects.count()
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0600"})
    assert (exc.value.code, exc.value.status_code) == ("insufficient_prompt_runs", 403)
    assert exc.value.details["needed"] == engines_n
    assert Prompt.objects.count() == prompts


def test_a_prompt_allowance_refusal_leaves_nothing(website, user, engines, monkeypatch):
    idea = an_idea(website)

    def refuse(user, n):
        raise CanseeException("Monthly prompt allowance reached.",
                              code="prompt_allowance_exceeded", status_code=403)

    monkeypatch.setattr("apps.billing.services.org_entitlements.check_prompt_allowance", refuse)
    prompts, links = Prompt.objects.count(), BrandPrompt.objects.count()
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0600"})
    assert (exc.value.code, exc.value.status_code) == ("prompt_allowance_exceeded", 403)
    assert (Prompt.objects.count(), BrandPrompt.objects.count()) == (prompts, links)
    assert not LLMRankingAudit.objects.filter(prompts=["notes app pricing"]).exists()


def test_ideas_api(client, website, engines, scans):
    idea = an_idea(website)
    base = {"website_id": website.id}
    data = client.get(reverse("insights-prompt-ideas", kwargs=base)).json()["data"]
    assert [i["id"] for i in data["ideas"]] == [str(idea.id)]
    assert data["track"]["usd_max_per_prompt"] == "0.0600"
    assert data["active_run"] is None
    url = reverse("insights-prompt-idea", kwargs={**base, "idea_id": idea.id})
    patched = client.patch(url, {"status": "dismissed"}, format="json")
    assert patched.status_code == 200 and patched.json()["data"]["status"] == "dismissed"
    assert client.patch(url, {"status": "tracked"}, format="json").status_code == 400
    assert client.get(reverse("insights-prompt-ideas", kwargs=base),
                      {"source": "web"}).status_code == 400
    tracked = client.post(reverse("insights-prompt-idea-track", kwargs={**base, "idea_id": idea.id}),
                          {"confirm": {"ai_usd_max": "0.0600"}}, format="json")
    assert tracked.status_code == 201
    assert set(tracked.json()["data"]) == {"idea", "prompt_id", "scan_audit_id"}
    missing = reverse("insights-prompt-idea", kwargs={
        **base, "idea_id": "6f1c0c6e-0000-4000-8000-000000000000"})
    assert client.patch(missing, {"status": "new"}, format="json").status_code == 404
