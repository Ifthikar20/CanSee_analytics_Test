from apps.search_gap.services.advice import build_actions
from apps.search_gap.services.scoring import (
    AI_AHEAD,
    GOOGLE_AHEAD,
    INVISIBLE_BOTH,
    NO_DATA,
    STRONG_BOTH,
    classify,
    search_score,
)

SITE = "northwind.example"
OWN = "https://www.northwind.example/blog/small-business-crm"
G2 = "https://www.g2.com/categories/crm"
REDDIT = "https://www.reddit.com/r/smallbusiness/comments/1/crm"
COMPETITORS = [{"name": "HubSpot", "domain": "hubspot.com"}]


def _google(position, url="", top=None, status="ok"):
    return {"status": status, "position": position, "url": url, "depth": 100, "top_results": top or []}


def _engine(key, label, score, position, rank=None, mentioned=None, citations=None, brands=None):
    return {
        "key": key, "label": label, "score": score,
        "class": classify(score, search_score(position)),
        "mentioned": rank is not None if mentioned is None else mentioned,
        "rank": rank, "citations": citations or [], "brands": brands or [],
    }


def _kinds(actions):
    return [a["kind"] for a in actions]


def test_unchecked_google_asks_for_a_check():
    actions = build_actions(
        query="q", site_apex=SITE, google=_google(None, status="not_checked"),
        engines=[], competitors=[], overall_class=NO_DATA,
    )
    assert _kinds(actions) == ["check_google"]


def test_ai_ahead_targets_the_page_google_buries():
    google = _google(94, OWN, top=[
        {"position": 1, "url": G2, "domain": "g2.com"},
        {"position": 2, "url": "https://www.hubspot.com/crm", "domain": "hubspot.com"},
    ])
    claude = _engine("claude", "Claude", 100, 94, rank=3, citations=[
        {"url": OWN, "is_yours": True}, {"url": G2, "is_yours": False},
    ])
    actions = build_actions(
        query="best crm", site_apex=SITE, google=google, engines=[claude],
        competitors=COMPETITORS, overall_class=AI_AHEAD,
    )
    first = actions[0]
    assert first["kind"] == "make_page_rank"
    assert first["targets"][0]["url"] == OWN
    assert "#94 (page 10)" in first["detail"]
    assert "as high as #3" in first["detail"]
    shared = next(a for a in actions if a["kind"] == "earn_links")
    assert [t["url"] for t in shared["targets"]] == [G2]


def test_ai_ahead_without_any_page_suggests_publishing_one():
    claude = _engine("claude", "Claude", 100, None, rank=2)
    actions = build_actions(
        query="best crm", site_apex=SITE, google=_google(None), engines=[claude],
        competitors=[], overall_class=AI_AHEAD,
    )
    assert actions[0]["kind"] == "create_page"
    assert "top 100 results" in actions[0]["detail"]


def test_google_ahead_points_at_cited_pages_and_the_ranking_page():
    google = _google(4, "https://www.northwind.example/features/email")
    gpt = _engine("chatgpt", "ChatGPT", 0, 4, citations=[{"url": G2, "is_yours": False}])
    perplexity = _engine("perplexity", "Perplexity", 0, 4, citations=[
        {"url": G2, "is_yours": False}, {"url": REDDIT, "is_yours": False},
    ])
    actions = build_actions(
        query="crm with email", site_apex=SITE, google=google, engines=[gpt, perplexity],
        competitors=[], overall_class=GOOGLE_AHEAD,
    )
    assert _kinds(actions)[:2] == ["get_cited", "make_quotable"]
    cited = actions[0]
    # Most-cited page first.
    assert [t["url"] for t in cited["targets"]] == [G2, REDDIT]
    assert "Perplexity reads the live web" in cited["detail"]
    assert "don't mention you" in actions[1]["detail"]
    assert actions[1]["targets"][0]["url"] == google["url"]


def test_competitor_above_on_both_is_flagged():
    google = _google(12, OWN, top=[{"position": 1, "url": "https://www.hubspot.com/crm", "domain": "hubspot.com"}])
    gemini = _engine("gemini", "Gemini", 55, 12, rank=6, brands=[{"name": "HubSpot", "position": 1}])
    actions = build_actions(
        query="q", site_apex=SITE, google=google, engines=[gemini],
        competitors=COMPETITORS, overall_class=classify(55, search_score(12)),
    )
    study = next(a for a in actions if a["kind"] == "study_competitor")
    assert study["title"] == "Study HubSpot's page"
    assert study["targets"][0]["url"] == "https://www.hubspot.com/crm"


def test_competitor_below_you_is_ignored():
    google = _google(1, OWN, top=[
        {"position": 1, "url": OWN, "domain": "northwind.example"},
        {"position": 2, "url": "https://www.hubspot.com/crm", "domain": "hubspot.com"},
    ])
    gpt = _engine("chatgpt", "ChatGPT", 100, 1, rank=1, brands=[{"name": "HubSpot", "position": 2}])
    actions = build_actions(
        query="q", site_apex=SITE, google=google, engines=[gpt],
        competitors=COMPETITORS, overall_class=STRONG_BOTH,
    )
    assert "study_competitor" not in _kinds(actions)
    assert _kinds(actions) == ["hold"]


def test_invisible_in_both():
    gpt = _engine("chatgpt", "ChatGPT", 0, None, citations=[{"url": G2, "is_yours": False}])
    actions = build_actions(
        query="how to choose a crm", site_apex=SITE, google=_google(None), engines=[gpt],
        competitors=[], overall_class=INVISIBLE_BOTH,
    )
    assert _kinds(actions) == ["create_page", "get_cited"]


def test_one_action_per_kind_and_sorted_by_priority():
    google = _google(4, OWN)
    engines = [
        _engine("chatgpt", "ChatGPT", 0, 4, citations=[{"url": G2, "is_yours": False}]),
        _engine("claude", "Claude", 0, 4, citations=[{"url": REDDIT, "is_yours": False}]),
    ]
    actions = build_actions(
        query="q", site_apex=SITE, google=google, engines=engines,
        competitors=[], overall_class=GOOGLE_AHEAD,
    )
    assert len(_kinds(actions)) == len(set(_kinds(actions)))
    priorities = [a["priority"] for a in actions]
    assert priorities == sorted(priorities, reverse=True)
