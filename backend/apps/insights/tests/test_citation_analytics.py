"""Citation analytics (contract 4b): cited in text against retrieved only,
source classes, your pages and competitor pages, gaps, and no data."""

import pytest
from django.urls import reverse

from apps.citations.models import SourceClass
from apps.insights.services import citation_analytics
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import (
    SITE,
    answer,
    at,
    cite,
    track,
)

pytestmark = pytest.mark.django_db


def test_no_citations_is_no_data(website, engines):
    bp = track(website, "best notes app for teams")
    answer(bp, "gpt4", at(1))
    data = citation_analytics.build(website)
    assert data["has_data"] is False and data["totals"] is None
    assert data["by_class"] == data["your_pages"] == data["competitor_pages"] == data["gaps"] == []


def test_totals_classes_pages_and_gaps(website, engines):
    bp = track(website, "best notes app for teams")
    gap = track(website, "notes app with slack")
    r1 = answer(bp, "gpt4", at(1))
    r2 = answer(bp, "claude", at(2))
    r3 = answer(gap, "gpt4", at(3))
    answer(gap, "claude", at(3))  # no sources
    cite(r1, f"{SITE}/pricing", references=2, source_class=SourceClass.YOUR_SITE)
    cite(r2, f"{SITE}/pricing", references=0, source_class=SourceClass.YOUR_SITE)
    cite(r1, "https://reddit.com/r/notes", references=1, source_class=SourceClass.REDDIT)
    cite(r3, "https://alpha-notes.example/compare", references=0,
         source_class=SourceClass.COMPETITOR_SITE)
    cite(r3, "https://alpha-notes.example/pricing", references=1,
         source_class=SourceClass.COMPETITOR_SITE)
    cite(r3, "https://g2.com/notes", references=1, source_class=SourceClass.OTHER)

    data = citation_analytics.build(website)
    assert data["has_data"] is True
    assert data["totals"] == {"answers": 4, "answers_with_sources": 3, "citations": 6,
                              "cited_in_text": 4, "retrieved_only": 2, "your_pages": 1}
    assert [(c["key"], c["label"], c["citations"]) for c in data["by_class"]] == [
        ("competitor_site", "Competitor", 2), ("your_site", "Your Site", 2),
        ("other", "Other", 1), ("reddit", "Reddit", 1)]
    [page] = data["your_pages"]
    assert page == {"url": f"{SITE}/pricing", "citations": 2, "cited_in_text": 1, "answers": 2,
                    "engines": ["chatgpt", "claude"], "prompts": 1,
                    "last_cited_at": page["last_cited_at"]}
    assert page["last_cited_at"].startswith(at(1).date().isoformat())
    assert [(p["url"], p["brand_key"], p["brand_name"]) for p in data["competitor_pages"]] == [
        ("https://alpha-notes.example/compare", "b1", "Alpha Notes"),
        ("https://alpha-notes.example/pricing", "b1", "Alpha Notes")]
    assert data["gaps"] == [{
        "prompt_id": str(gap.prompt_id), "text": "notes app with slack",
        "competitor_citations": 2, "your_citations": 0,
        "top_domains": [{"domain": "alpha-notes.example", "citations": 2},
                        {"domain": "g2.com", "citations": 1}],
    }]
    engines_ = {e["key"]: e for e in data["by_engine"]}
    assert engines_["chatgpt"] == {"key": "chatgpt", "label": "ChatGPT", "answers": 2,
                                   "answers_with_sources": 2, "citations": 5, "your_citations": 1}
    assert engines_["claude"]["answers_with_sources"] == 1


def test_the_engine_filter_and_the_api(client, website, engines):
    bp = track(website, "best notes app for teams")
    cite(answer(bp, "claude", at(1)), "https://reddit.com/r/notes")
    url = reverse("insights-citations", kwargs={"website_id": website.id})
    data = client.get(url, {"engine": "chatgpt"}).json()["data"]
    assert data["has_data"] is False and data["filters"] == {"engine": "chatgpt"}
    data = client.get(url, {"engine": "claude", "period": "7d"}).json()["data"]
    assert data["totals"]["citations"] == 1
    assert client.get(url, {"period": "2d"}).status_code == 400
