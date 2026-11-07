"""google_search and the prompt's Google rank: only a definite result is
saved, from the prompt's own location; a tracked prompt can be searched
by prompt_id; results carry their URLs; pages captured within the hour
are shown again instead of bought again; a deferred AI Overview is
reported as shown but not read."""
import json
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
import responses
from django.utils import timezone

from apps.agent.models import AgentMessage
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, run_events, send, tool_results_of
from apps.agent.tools.data import trim_prompt_detail
from apps.search_gap.models import GoogleRankCheck
from apps.search_gap.services.overview import build_prompt_detail

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]

SERP = "https://serpapi.com/search.json"


def _organic(start, rows):
    return [{"position": start + i + 1, "link": url, "title": title}
            for i, (url, title) in enumerate(rows)]


PAGES = {
    None: {"organic_results": _organic(0, [("https://www.hubspot.com/products/crm", "HubSpot"),
                                           ("https://reviews.example/best-crm", "Best CRMs")])},
    "10": {"organic_results": _organic(10, [("https://blog.example/crm", "CRM guide"),
                                            ("https://other.example/crm", "Other CRM")])},
    "20": {"organic_results": _organic(20, [("https://northwind.example/crm", "Northwind")])},
}


@pytest.fixture
def serp(settings):
    settings.SERPAPI_KEY = "serp-test"
    seen = []

    def callback(request):
        params = {k: v[0] for k, v in parse_qs(urlsplit(request.url).query).items()}
        seen.append(params)
        body = PAGES.get(params.get("start"), {"organic_results": []})
        return 200, {"Content-Type": "application/json"}, json.dumps(body)

    with responses.RequestsMock(assert_all_requests_are_fired=False) as mock:
        mock.add_callback(responses.GET, SERP, callback=callback)
        mock.seen = seen
        yield mock


def _search(fake_anthropic, chat, args, user_text="How do we rank?"):
    fake_anthropic.queue(message(tool_use("google_search", args, id="toolu_g"),
                                 stop_reason="tool_use"),
                         message(text("Done.")))
    started = send(chat, user_text)
    result = tool_results_of(fake_anthropic.requests[-1].json)[0]
    assert result.get("is_error") is not True, result
    return started, json.loads(result["content"])


def _deep_check(bp, *, position, hours_ago=3):
    return GoogleRankCheck.objects.create(
        website=bp.website, brand_prompt=bp, query=bp.prompt.text, location=bp.location,
        depth=100, position=position, url="https://northwind.example/crm", title="Northwind",
        top_results=[], ai_overview={}, pages_fetched=3,
        checked_at=timezone.now() - timedelta(hours=hours_ago),
    )


def test_a_miss_on_two_pages_does_not_replace_a_deeper_rank(fake_anthropic, chat, website, serp):
    bp = make_prompt(website, "best crm for startups")
    _deep_check(bp, position=28)

    _, result = _search(fake_anthropic, chat, {"query": "best crm for startups", "pages": 2})

    assert result["brand_best_position"] is None
    assert result["rank_check_recorded"] is False
    assert "not in the top 20" in result["rank_note"]
    assert GoogleRankCheck.objects.count() == 1
    google = build_prompt_detail(website, bp)["google"]
    assert (google["status"], google["position"], google["depth"]) == ("ok", 28, 100)


def test_a_miss_where_google_ran_out_of_results_is_definite(fake_anthropic, chat, website, serp,
                                                            settings):
    bp = make_prompt(website, "best crm for startups")
    # Page 1 as usual, then Google has nothing more.
    serp.replace(responses.GET, SERP, json=PAGES[None])
    serp.add(responses.GET, SERP, json={"organic_results": []})

    _, result = _search(fake_anthropic, chat, {"query": "best crm for startups", "pages": 3})

    assert result["rank_check_recorded"] is True
    check = GoogleRankCheck.objects.get(brand_prompt=bp)
    assert check.position is None and check.depth == settings.SEARCH_GAP_MAX_DEPTH


def test_a_found_position_is_saved(fake_anthropic, chat, website, serp):
    bp = make_prompt(website, "best crm for startups")
    _deep_check(bp, position=28)

    _, result = _search(fake_anthropic, chat, {"query": "best crm for startups", "pages": 3})

    assert result["brand_best_position"] == 21 and result["rank_check_recorded"] is True
    assert build_prompt_detail(website, bp)["google"]["position"] == 21


def test_a_tracked_prompt_is_searched_by_prompt_id_with_its_text_and_location(
    fake_anthropic, chat, website, serp,
):
    bp = make_prompt(website, "What is the best CRM for startups?", location="gb")

    _, result = _search(fake_anthropic, chat, {"prompt_id": str(bp.prompt_id), "pages": 3})

    assert {(s["q"], s.get("gl")) for s in serp.seen} == {
        ("What is the best CRM for startups?", "uk")}
    assert result["tracked_prompt_id"] == str(bp.prompt_id)
    assert result["rank_check_recorded"] is True and result["location"] == "gb"
    assert GoogleRankCheck.objects.get(brand_prompt=bp).location == "gb"


def test_the_same_question_without_its_punctuation_is_the_tracked_prompt(fake_anthropic, chat,
                                                                         website, serp):
    bp = make_prompt(website, "What is the best CRM for startups?")

    _, result = _search(fake_anthropic, chat,
                        {"query": "what is the best crm for startups", "pages": 3})

    assert result["tracked_prompt_id"] == str(bp.prompt_id)
    assert result["rank_check_recorded"] is True


def test_a_tracked_prompt_is_searched_from_its_country(fake_anthropic, chat, website, serp):
    bp = make_prompt(website, "best crm for startups", location="gb")

    _, result = _search(fake_anthropic, chat, {"query": "best crm for startups", "pages": 3})

    assert {s.get("gl") for s in serp.seen} == {"uk"}
    assert result["location"] == "gb" and result["rank_check_recorded"] is True
    assert GoogleRankCheck.objects.get(brand_prompt=bp).location == "gb"


def test_a_search_from_another_country_is_not_saved_as_the_prompts_rank(fake_anthropic, chat,
                                                                        website, serp):
    make_prompt(website, "best crm for startups", location="gb")

    _, result = _search(fake_anthropic, chat,
                        {"query": "best crm for startups", "pages": 3, "location": "US"})

    assert {s.get("gl") for s in serp.seen} == {"us"}
    assert result["brand_best_position"] == 21
    assert result["rank_check_recorded"] is False
    assert "tracked from GB" in result["rank_note"] and "from US" in result["rank_note"]
    assert not GoogleRankCheck.objects.exists()


def test_results_carry_their_urls_for_inspect_page(fake_anthropic, chat, website, serp):
    bp = make_prompt(website, "best crm for startups")

    _, result = _search(fake_anthropic, chat, {"query": "best crm for startups", "pages": 3})

    assert result["pages"][0]["top"][0]["url"] == "https://www.hubspot.com/products/crm"
    gap = trim_prompt_detail(build_prompt_detail(website, bp))
    assert [r["url"] for r in gap["google"]["top_results"]] == [
        "https://www.hubspot.com/products/crm", "https://reviews.example/best-crm"]


def test_searching_deeper_reuses_the_pages_already_captured(fake_anthropic, chat, serp,
                                                           settings):
    first_run, first = _search(fake_anthropic, chat, {"query": "best crm", "pages": 2})
    second_run, second = _search(fake_anthropic, chat, {"query": "best crm", "pages": 3},
                                 user_text="Yes, search deeper")

    assert [s.get("start") for s in serp.seen] == [None, "10", "20"]
    assert (second["pages_searched"], second["pages_fetched"], second["pages_reused"]) == (3, 1, 2)
    assert second["cost_usd"] == pytest.approx(settings.SERPAPI_COST_PER_SEARCH_USD)
    assert second["brand_best_position"] == 21
    first_tabs = [e["tab"]["id"] for e in run_events(first_run.run) if e["type"] == "browser.open"]
    second_tabs = [e["tab"]["id"] for e in run_events(second_run.run)
                   if e["type"] == "browser.open"]
    assert second_tabs[:2] == first_tabs and second_tabs[2] not in first_tabs
    reply = AgentMessage.objects.get(id=second_run.assistant_message.id)
    assert len(reply.research["serp"]) == 3
    assert [p["status"] for p in reply.parts if p["type"] == "serp"] == ["done"] * 3


def test_a_capture_older_than_an_hour_is_searched_again(fake_anthropic, chat, serp):
    started, _ = _search(fake_anthropic, chat, {"query": "best crm", "pages": 1})
    reply = AgentMessage.objects.get(id=started.assistant_message.id)
    old = (timezone.now() - timedelta(hours=2)).isoformat()
    for capture in reply.research["serp"].values():
        capture["captured_at"] = old
    AgentMessage.objects.filter(id=reply.id).update(research=reply.research)

    _search(fake_anthropic, chat, {"query": "best crm", "pages": 1}, user_text="Again")

    assert [s.get("start") for s in serp.seen] == [None, None]


def test_a_deferred_ai_overview_is_shown_but_not_measured(fake_anthropic, chat, website,
                                                         settings, monkeypatch):
    settings.SERPAPI_KEY = "serp-test"
    bp = make_prompt(website, "best crm for startups")

    def search(query, **kwargs):
        # serp_google's shape for an overview Google loaded separately: no
        # content, only the flag.
        return {"organic": [{"position": 1, "url": "https://northwind.example/crm",
                             "domain": "northwind.example", "title": "Northwind"}],
                "ai_overview": {}, "ai_overview_deferred": True,
                "questions": []}

    monkeypatch.setattr("apps.citations.services.serp_google.search", search)
    started, result = _search(fake_anthropic, chat, {"query": "best crm for startups",
                                                     "pages": 1})

    overview = result["ai_overview"]
    assert overview["shown"] is True and overview["content_captured"] is False
    assert overview["mentions_you"] is None and overview["cites_you"] is None
    assert "not read" in overview["note"]
    capture = next(iter(AgentMessage.objects.get(
        id=started.assistant_message.id).research["serp"].values()))
    # The field the pane reads (SerpView, ResearchAppendix).
    assert capture["ai_overview"] == {"shown": True, "content_captured": False,
                                      "mentions_you": None, "cites_you": None, "references": []}
    stored = GoogleRankCheck.objects.get(brand_prompt=bp).ai_overview
    assert stored["shown"] is True and stored["mentions_you"] is None
    assert stored["content_captured"] is False
    gap = trim_prompt_detail(build_prompt_detail(website, bp))
    assert gap["google"]["ai_overview"]["mentions_you"] is None
    assert "not read" in gap["google"]["ai_overview"]["note"]
