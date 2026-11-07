"""Sentiment (contract 3c): tone from the stored labels, themes from
analyses, the previous window, coverage, engine rows, filters, the empty
reason and the API's validation and tenancy."""

import pytest
from django.urls import reverse

from apps.insights.services import sentiment
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import (
    analyzed,
    answer,
    at,
    track,
)
from core.exceptions import ResourceNotFound

pytestmark = pytest.mark.django_db


def _theme(payload, label, tone):
    return next(t for t in payload["themes"] if t["label"] == label and t["tone"] == tone)


def test_tone_counts_named_answers_by_their_stored_label(website, engines):
    bp = track(website, "best notes app for teams")
    answer(bp, "gpt4", at(1), sentiment="positive")
    answer(bp, "gpt4", at(1), sentiment="negative")
    answer(bp, "claude", at(3), sentiment="neutral")
    answer(bp, "claude", at(3), mentioned=False)
    answer(bp, "claude", at(3), sentiment="mixed")
    data = sentiment.build(website, period="7d")
    assert (data["tone"]["positive"], data["tone"]["neutral"], data["tone"]["negative"]) == (1, 1, 1)
    index = data["window"]["buckets"].index(at(1).date().isoformat())
    assert data["tone"]["series"]["positive"][index] == 1
    assert data["tone"]["series"]["negative"][index] == 1
    assert data["coverage"] == {"named_answers": 4, "analyzed": 0, "not_analyzed": 4, "failed": 0}
    assert data["empty_reason"] is None and data["themes"] == []


def test_themes_group_by_label_and_tone_with_quotes_newest_first(website, engines):
    bp = track(website, "best notes app for teams")
    other = track(website, "notes app with slack")
    a1 = answer(bp, "gpt4", at(1))
    a2 = answer(bp, "claude", at(2))
    a3 = answer(other, "gpt4", at(3))
    a4 = answer(other, "gpt4", at(4))
    analyzed(a1, bp, themes=[("easy to set up", "positive", "minutes to set up")])
    analyzed(a2, bp, themes=[("Easy to set up", "positive", "quick setup"),
                             ("expensive", "negative", "pricey")])
    analyzed(a3, other, themes=[("easy to set up", "positive", "simple start"),
                                ("easy to set up", "negative", "set up is easy but slow")])
    analyzed(a4, other, themes=[("easy to set up", "positive", "fourth quote")])

    data = sentiment.build(website, period="30d")
    easy = _theme(data, "easy to set up", "positive")
    assert easy["key"] == "easy to set up|positive"
    assert (easy["answers"], easy["prompts"], easy["engines"]) == (4, 2, ["chatgpt", "claude"])
    assert [q["quote"] for q in easy["quotes"]] == [
        "minutes to set up", "quick setup", "simple start"]
    assert easy["quotes"][0]["result_id"] == str(a1.public_id)
    assert easy["quotes"][0]["engine"] == "chatgpt"
    assert data["themes"][0] is easy or data["themes"][0]["key"] == easy["key"]
    assert _theme(data, "easy to set up", "negative")["answers"] == 1
    assert easy["prev_answers"] is None  # no analyzed answer before the window
    assert data["coverage"] == {"named_answers": 4, "analyzed": 4, "not_analyzed": 0, "failed": 0}


def test_previous_window_counts_and_zero_when_the_theme_is_absent(website, engines):
    bp = track(website, "best notes app for teams")
    analyzed(answer(bp, "gpt4", at(1)), bp, themes=[("easy to set up", "positive", "q")])
    analyzed(answer(bp, "gpt4", at(2)), bp, themes=[("fast", "positive", "q")])
    analyzed(answer(bp, "gpt4", at(9)), bp, themes=[("easy to set up", "positive", "q")])
    data = sentiment.build(website, period="7d")
    assert _theme(data, "easy to set up", "positive")["prev_answers"] == 1
    assert _theme(data, "fast", "positive")["prev_answers"] == 0


def test_coverage_counts_failed_analyses_as_not_analyzed(website, engines):
    bp = track(website, "best notes app for teams")
    analyzed(answer(bp, "gpt4", at(1)), bp)
    analyzed(answer(bp, "gpt4", at(2)), bp, status="failed")
    answer(bp, "gpt4", at(3))
    data = sentiment.build(website)
    assert data["coverage"] == {"named_answers": 3, "analyzed": 1, "not_analyzed": 2, "failed": 1}


def test_engine_theme_counts_are_null_without_an_analysis(website, engines):
    bp = track(website, "best notes app for teams")
    analyzed(answer(bp, "gpt4", at(1), sentiment="positive"), bp,
             themes=[("easy", "positive", "q"), ("slow", "negative", "q2")])
    answer(bp, "claude", at(1), sentiment="negative")
    data = sentiment.build(website)
    rows = {row["key"]: row for row in data["by_engine"]}
    assert rows["chatgpt"] == {"key": "chatgpt", "named": 1, "positive": 1, "neutral": 0,
                               "negative": 0, "themes_positive": 1, "themes_negative": 1}
    assert (rows["claude"]["themes_positive"], rows["claude"]["themes_negative"]) == (None, None)
    assert rows["claude"]["negative"] == 1
    assert [p["named"] for p in data["by_prompt"]] == [2]


def test_filters_and_the_empty_reason(website, engines):
    bp = track(website, "best notes app for teams")
    other = track(website, "notes app with slack")
    answer(bp, "gpt4", at(1))
    answer(other, "claude", at(1))
    data = sentiment.build(website, engine="claude")
    assert data["coverage"]["named_answers"] == 1
    assert [row["key"] for row in data["by_engine"]] == ["claude"]
    data = sentiment.build(website, prompt_id=str(bp.prompt_id))
    assert data["coverage"]["named_answers"] == 1
    assert data["filters"] == {"engine": None, "prompt_id": str(bp.prompt_id)}
    assert [p["prompt_id"] for p in data["by_prompt"]] == [str(bp.prompt_id)]
    data = sentiment.build(website, period="7d", engine="grok")
    assert data["empty_reason"] == "no_answers"
    with pytest.raises(ResourceNotFound):
        sentiment.build(website, prompt_id="6f1c0c6e-0000-4000-8000-000000000000")


def test_api_validates_filters_and_tenancy(client, website, stranger):
    from apps.websites.models import Website

    url = reverse("insights-sentiment", kwargs={"website_id": website.id})
    ok = client.get(url, {"period": "7d"})
    assert ok.status_code == 200
    data = ok.json()["data"]
    assert data["active_run"] is None and data["last_run"] is None
    assert data["window"]["period"] == "7d" and data["window"]["interval"] == "day"
    for params, field in (({"period": "1y"}, "period"), ({"engine": "bing"}, "engine"),
                          ({"interval": "hour"}, "interval"), ({"prompt_id": "x"}, "prompt_id")):
        bad = client.get(url, params)
        assert bad.status_code == 400 and bad.json()["error"]["details"]["field"] == field
    missing = client.get(url, {"prompt_id": "6f1c0c6e-0000-4000-8000-000000000000"})
    assert missing.status_code == 404
    other = Website.objects.create(user=stranger, url="https://other.example", name="Other")
    assert client.get(reverse("insights-sentiment",
                              kwargs={"website_id": other.id})).status_code == 404
