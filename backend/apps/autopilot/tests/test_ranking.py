"""Prompt ranking (contract 3c): 7 UTC days of every tracked answer, ranked
after AUTOPILOT_MIN_RANK_ANSWERS, ties broken by answers then average rank,
Wilson ranges, null shares at 0 answers, changes only with 4 answers before,
the Google cell, and the view and the text's link with their tenancy."""

from datetime import UTC, datetime, timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.autopilot.services import pipeline
from apps.autopilot.services.ranking import rank_prompts
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import (
    client_for,
    data,
    error,
    join_org,
    make_autopilot,
    make_prompt,
    make_result,
    make_run,
    make_user,
)
from apps.llm_ranking.services.ranking_service import wilson_ci
from apps.search_gap.models import GoogleRankCheck

pytestmark = pytest.mark.django_db

TODAY = datetime(2026, 11, 4, tzinfo=UTC).date()


def at(days_ago: int, hour: int = 12) -> datetime:
    return datetime(2026, 11, 4, hour, tzinfo=UTC) - timedelta(days=days_ago)


def answers(website, bp, *, named: int, total: int, days_ago: int = 1, provider="claude",
            rank=2):
    for i in range(total):
        make_result(website, bp, provider=provider, mentioned=i < named, rank=rank,
                    created_at=at(days_ago))


def by_text(payload) -> dict:
    return {p["text"]: p for p in payload["prompts"]}


def test_the_ranking_payload(website, engines):
    engines.enable("chatgpt", "claude")
    base = timezone.now() - timedelta(days=60)
    a = make_prompt(website, "best notes app", created_at=base)
    b = make_prompt(website, "best wiki app", created_at=base + timedelta(minutes=1))
    c = make_prompt(website, "notes app for teams", created_at=base + timedelta(minutes=2))
    d = make_prompt(website, "notes app with ai", created_at=base + timedelta(minutes=3))
    answers(website, a, named=5, total=6)
    answers(website, a, named=1, total=1, provider="gpt4", rank=1)
    answers(website, b, named=1, total=4)
    answers(website, c, named=3, total=3)                      # 3 answers: not ranked
    answers(website, a, named=2, total=4, days_ago=9)          # the previous 7 days
    answers(website, b, named=1, total=3, days_ago=9)          # too few before
    answers(website, a, named=4, total=4, days_ago=20)         # outside both windows
    make_result(website, a, mentioned=True, created_at=at(1), succeeded=False)

    got = rank_prompts(website, today=TODAY)

    assert got["window"] == {"days": 7, "start": "2026-10-29", "end": "2026-11-04"}
    assert got["min_answers"] == 4
    assert got["tracked"] == {"count": 4, "limit": -1, "over_limit": 0}
    assert [p["text"] for p in got["prompts"]] == [
        "best notes app", "best wiki app", "notes app for teams", "notes app with ai",
    ]
    rows = by_text(got)
    first = rows["best notes app"]
    low, high = wilson_ci(6, 7)
    assert first == {
        "prompt_id": str(a.prompt_id), "brand_prompt_id": str(a.id), "text": "best notes app",
        "rank": 1, "ranked": True, "answers": 7, "named": 6, "share_pct": 85.7,
        "share_low_pct": round(100 * low, 1), "share_high_pct": round(100 * high, 1),
        "prev_share_pct": 50.0, "change_pts": 35.7, "avg_rank": 1.8,
        "engines": {"chatgpt": {"answers": 1, "named": 1}, "claude": {"answers": 6, "named": 5}},
        "google": first["google"],
    }
    second = rows["best wiki app"]
    assert (second["rank"], second["share_pct"], second["prev_share_pct"],
            second["change_pts"]) == (2, 25.0, None, None)
    unranked = rows["notes app for teams"]
    assert (unranked["rank"], unranked["ranked"], unranked["share_pct"]) == (None, False, 100.0)
    empty = rows["notes app with ai"]
    assert (empty["answers"], empty["share_pct"], empty["share_low_pct"],
            empty["share_high_pct"], empty["avg_rank"]) == (0, None, None, None, None)
    assert empty["engines"] == {"chatgpt": {"answers": 0, "named": 0},
                                "claude": {"answers": 0, "named": 0}}
    assert got["headline"] == {"answers": 14, "named": 10, "share_pct": 71.4,
                               "prev_share_pct": 42.9, "change_pts": 28.5}
    assert got["autopilot"] == {"enabled": False, "last_run": None, "next_run_at": None}
    del d


def test_ties_go_to_more_answers_then_the_better_average_rank(website):
    base = timezone.now() - timedelta(days=60)
    few = make_prompt(website, "few answers", created_at=base)
    many = make_prompt(website, "many answers", created_at=base + timedelta(minutes=1))
    worse = make_prompt(website, "worse rank", created_at=base + timedelta(minutes=2))
    better = make_prompt(website, "better rank", created_at=base + timedelta(minutes=3))
    answers(website, few, named=2, total=4)
    answers(website, many, named=4, total=8)
    answers(website, worse, named=2, total=4, rank=5)
    answers(website, better, named=2, total=4, rank=1)
    got = rank_prompts(website, today=TODAY)
    assert [(p["text"], p["rank"]) for p in got["prompts"]] == [
        ("many answers", 1), ("better rank", 2), ("few answers", 3), ("worse rank", 4),
    ]


def test_a_measured_zero_is_zero_and_nothing_is_null(website):
    bp = make_prompt(website, "best notes app")
    answers(website, bp, named=0, total=5)
    (row,) = rank_prompts(website, today=TODAY)["prompts"]
    assert (row["share_pct"], row["ranked"], row["named"]) == (0.0, True, 0)
    assert row["share_low_pct"] == 0.0 and row["share_high_pct"] > 0
    empty = rank_prompts(website, today=TODAY + timedelta(days=30))
    assert empty["headline"] == {"answers": 0, "named": 0, "share_pct": None,
                                 "prev_share_pct": None, "change_pts": None}


def test_the_google_cell(website):
    base = timezone.now() - timedelta(days=60)
    on = make_prompt(website, "on page one", created_at=base)
    off = make_prompt(website, "not on page one", created_at=base + timedelta(minutes=1))
    broken = make_prompt(website, "failed check", created_at=base + timedelta(minutes=2))
    never = make_prompt(website, "never checked", created_at=base + timedelta(minutes=3))
    for bp, position, err in ((on, 4, ""), (off, None, ""), (broken, None, "http_429")):
        GoogleRankCheck.objects.create(website=website, brand_prompt=bp, query=bp.prompt.text,
                                       depth=10, position=position, error=err)
    rows = by_text(rank_prompts(website, today=TODAY))
    assert (rows["on page one"]["google"]["status"], rows["on page one"]["google"]["position"],
            rows["on page one"]["google"]["page_one"]) == ("ok", 4, True)
    assert (rows["not on page one"]["google"]["status"],
            rows["not on page one"]["google"]["page_one"]) == ("ok", False)
    assert (rows["failed check"]["google"]["status"],
            rows["failed check"]["google"]["page_one"]) == ("error", None)
    assert (rows["never checked"]["google"]["status"],
            rows["never checked"]["google"]["page_one"]) == ("not_checked", None)
    del never


def test_a_run_restricts_the_list_to_the_prompts_it_asked(website):
    from apps.autopilot.models import AutopilotRunPrompt

    a = make_prompt(website, "asked prompt")
    b = make_prompt(website, "skipped prompt")
    answers(website, a, named=4, total=4)
    answers(website, b, named=4, total=4)
    run = make_run(website)
    AutopilotRunPrompt.objects.create(run=run, brand_prompt=a, status="done")
    AutopilotRunPrompt.objects.create(run=run, brand_prompt=b, status="skipped")
    got = rank_prompts(website, today=TODAY, run=run, with_autopilot=False)
    assert [p["text"] for p in got["prompts"]] == ["asked prompt"]
    assert "autopilot" not in got


def test_the_autopilot_block(website):
    make_autopilot(website)
    run = make_run(website)
    make_run(website, local_date=run.local_date - timedelta(days=1),
             created_at=timezone.now() + timedelta(seconds=5), status="running", stage="engines")
    block = rank_prompts(website)["autopilot"]
    assert block["enabled"] is True
    assert block["last_run"]["id"] == str(run.id)
    assert block["next_run_at"] is not None


# -- views -----------------------------------------------------------------------------


def test_the_ranking_view_and_its_tenancy(website, user):
    url = reverse("autopilot-ranking", kwargs={"website_id": website.id})
    assert url == f"/api/v1/autopilot/websites/{website.id}/ranking/"
    viewer = make_user("viewer@example.com")
    join_org(website, user, {viewer: "viewer"})
    assert data(client_for(viewer).get(url))["min_answers"] == 4
    assert client_for(make_user("stranger@example.com")).get(url).status_code == 404
    assert client_for().get(url).status_code == 401


def test_the_link_view_and_its_tenancy(website, user):
    run = make_run(website)
    url = reverse("autopilot-link", kwargs={"code": run.link_code})
    assert url == f"/api/v1/autopilot/links/{run.link_code}/"
    assert len(run.link_code) == 8
    assert set(run.link_code) <= set("abcdefghjkmnpqrstuvwxyz23456789")
    got = data(client_for(user).get(url))
    assert got == {"website_id": str(website.id), "run_id": str(run.id),
                   "local_date": run.local_date.isoformat()}
    viewer = make_user("viewer@example.com")
    join_org(website, user, {viewer: "viewer"})
    assert data(client_for(viewer).get(url))["run_id"] == str(run.id)
    stranger = client_for(make_user("stranger@example.com"))
    assert stranger.get(url).status_code == 404
    assert error(stranger.get(url))["code"] == "not_found"
    missing = reverse("autopilot-link", kwargs={"code": "zzzzzzzz"})
    assert client_for(user).get(missing).status_code == 404
    assert client_for().get(url).status_code == 401
    assert pipeline.run_summary(run)["id"] == str(run.id)
