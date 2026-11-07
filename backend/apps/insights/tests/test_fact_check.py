"""Fact check (contract 3d): claim grouping and order, evidence shapes,
null counts before any analysis, the empty reasons, the verdict and topic
filters, the evidence block, claim_group with its cited pages, and the API."""

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.brand_vault.models import BrandFact
from apps.insights.models import EvidencePage
from apps.insights.services import fact_check
from apps.insights.services.text import claim_key
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import (
    SITE,
    analyzed,
    answer,
    at,
    cite,
    track,
)

pytestmark = pytest.mark.django_db

PRICE = "Fixture Notes costs $8 per user per month"


@pytest.fixture(autouse=True)
def no_offerings(monkeypatch):
    monkeypatch.setattr("apps.agent.services.context.offering_urls", lambda website: [])


def page_evidence(quote="Plus $10 per seat/month"):
    return {"kind": "page", "url": f"{SITE}/pricing", "quote": quote,
            "note": "The pricing page lists $10."}


def test_claims_group_by_text_and_verdict_in_table_order(website, engines):
    bp = track(website, "best notes app for teams")
    other = track(website, "notes app with slack")
    a1 = answer(bp, "gpt4", at(1))
    a2 = answer(other, "claude", at(2))
    a3 = answer(bp, "gpt4", at(3))
    analyzed(a1, bp, claims=[
        (PRICE, "pricing", "contradicted", "costs $8 per user", page_evidence()),
        ("Fixture Notes integrates with Slack", "integrations", "supported", "Slack", None),
    ])
    analyzed(a2, other, claims=[
        (PRICE.lower() + ".", "pricing", "contradicted", "$8 a user", page_evidence()),
        ("Fixture Notes has offline mode", "features", "not_verifiable", "offline", None),
    ])
    analyzed(a3, bp, claims=[(PRICE, "pricing", "unchecked", "costs $8", None)])

    data = fact_check.build(website)
    keys = [(c["verdict"], c["answers"]) for c in data["claims"]]
    assert keys == [("contradicted", 2), ("not_verifiable", 1), ("unchecked", 1), ("supported", 1)]
    top = data["claims"][0]
    assert top["key"] == f"{claim_key(PRICE)}|contradicted"
    assert top["text"] == PRICE  # the newest claim's text
    assert top["engines"] == ["chatgpt", "claude"]
    assert [p["prompt_id"] for p in top["prompts"]] == [str(bp.prompt_id), str(other.prompt_id)]
    assert [o["result_id"] for o in top["occurrences"]] == [str(a1.public_id), str(a2.public_id)]
    assert top["evidence"] == {"kind": "page", "url": f"{SITE}/pricing",
                               "quote": "Plus $10 per seat/month", "fact": None}
    assert top["note"] == "The pricing page lists $10."
    assert data["claims"][1]["evidence"] is None
    assert data["totals"] == {"claims": 5, "supported": 1, "contradicted": 2,
                              "not_verifiable": 1, "unchecked": 1}
    topics = {t["topic"]: t for t in data["by_topic"]}
    assert topics["pricing"] == {"topic": "pricing", "label": "Pricing", "claims": 3,
                                 "supported": 0, "contradicted": 2, "not_verifiable": 0,
                                 "unchecked": 1}
    assert [t["topic"] for t in data["by_topic"]] == ["pricing", "features", "integrations"]
    engines_ = {e["key"]: e["claims"] for e in data["by_engine"]}
    assert engines_ == {"chatgpt": 3, "claude": 2}
    index = data["window"]["buckets"].index(at(1).date().isoformat())
    assert data["series"]["contradicted"][index] == 1
    assert data["empty_reason"] is None


def test_a_fact_as_evidence(website, engines):
    bp = track(website, "best notes app for teams")
    fact = BrandFact.objects.create(website=website, subject="Fixture Notes",
                                    predicate="integrates with", object="Slack",
                                    status="approved", source_url=f"{SITE}/integrations")
    analyzed(answer(bp, "gpt4", at(1)), bp, claims=[(
        "Fixture Notes integrates with Slack", "integrations", "supported", "Slack",
        {"kind": "fact", "url": f"{SITE}/integrations", "fact": fact, "quote": "Slack"},
    )])
    [claim] = fact_check.build(website)["claims"]
    assert claim["evidence"] == {
        "kind": "fact", "url": f"{SITE}/integrations", "quote": "Slack",
        "fact": {"id": str(fact.id), "subject": "Fixture Notes", "predicate": "integrates with",
                 "object": "Slack", "source_url": f"{SITE}/integrations"},
    }


def test_nothing_analyzed_means_null_counts_never_zeros(website, engines):
    data = fact_check.build(website)
    assert data["empty_reason"] == "no_answers"
    bp = track(website, "best notes app for teams")
    answer(bp, "gpt4", at(1))
    data = fact_check.build(website)
    assert data["empty_reason"] == "not_analyzed"
    assert (data["totals"], data["series"], data["by_topic"], data["by_engine"]) == (
        None, None, None, None)
    analyzed(answer(bp, "gpt4", at(2)), bp)
    data = fact_check.build(website)
    assert data["empty_reason"] == "no_claims"
    assert data["totals"] == {"claims": 0, "supported": 0, "contradicted": 0,
                              "not_verifiable": 0, "unchecked": 0}


def test_verdict_and_topic_filter_the_claims_only(website, engines):
    bp = track(website, "best notes app for teams")
    analyzed(answer(bp, "gpt4", at(1)), bp, claims=[
        (PRICE, "pricing", "contradicted", "q", page_evidence()),
        ("Fixture Notes integrates with Slack", "integrations", "supported", "q", None),
    ])
    data = fact_check.build(website, verdict="supported")
    assert [c["verdict"] for c in data["claims"]] == ["supported"]
    assert data["totals"]["claims"] == 2
    data = fact_check.build(website, topic="pricing")
    assert [c["topic"] for c in data["claims"]] == ["pricing"]
    assert data["filters"]["topic"] == "pricing"


def test_the_evidence_block(website, engines, cache_clear):
    BrandFact.objects.create(website=website, subject="a", predicate="b", object="c",
                             status="approved")
    BrandFact.objects.create(website=website, subject="a", predicate="b", object="d",
                             status="pending")
    EvidencePage.objects.create(website=website, url=SITE, final_url=SITE, status_code=200,
                                text="Home", read_at=timezone.now())
    data = fact_check.build(website)
    assert data["evidence"]["facts"] == 1 and data["evidence"]["facts_pending"] == 1
    assert [(p["url"], p["state"]) for p in data["evidence"]["pages"]] == [(SITE, "ok")]


def test_claim_group_has_the_cited_pages_of_its_answers(website, engines):
    bp = track(website, "best notes app for teams")
    a1 = answer(bp, "gpt4", at(1))
    a2 = answer(bp, "claude", at(2))
    for result in (a1, a2):
        analyzed(result, bp, claims=[(PRICE, "pricing", "contradicted", "q", page_evidence())])
    cite(a1, "https://review.example/notes-apps")
    cite(a2, "https://review.example/notes-apps")
    cite(a2, "https://blog.example/post")
    cite(a1, f"{SITE}/pricing")
    cite(a1, "https://other.example/x", target=True)

    group = fact_check.claim_group(website, f"{claim_key(PRICE)}|contradicted")
    assert group["answers"] == 2 and group["verdict"] == "contradicted"
    assert group["cited_urls"] == [
        {"url": "https://review.example/notes-apps", "domain": "review.example", "answers": 2},
        {"url": "https://blog.example/post", "domain": "blog.example", "answers": 1},
    ]
    assert fact_check.claim_group(website, f"{claim_key(PRICE)}|supported") is None
    assert fact_check.claim_group(website, "nonsense") is None


def test_api_filters(client, website):
    url = reverse("insights-fact-check", kwargs={"website_id": website.id})
    assert client.get(url, {"verdict": "contradicted", "topic": "pricing"}).status_code == 200
    bad = client.get(url, {"verdict": "wrong"})
    assert bad.status_code == 400 and bad.json()["error"]["details"]["field"] == "verdict"
    bad = client.get(url, {"topic": "weather"})
    assert bad.status_code == 400 and bad.json()["error"]["details"]["field"] == "topic"
