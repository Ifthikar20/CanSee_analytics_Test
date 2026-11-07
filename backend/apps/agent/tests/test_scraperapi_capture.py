import pytest

from apps.agent.tools.research import build_serp_capture


@pytest.mark.django_db
def test_capture_names_the_provider_and_keeps_absolute_positions(website):
    payload = {
        "provider": "scraperapi",
        "error": "",
        "organic": [{"position": 11, "url": "https://evernote.com/", "domain": "evernote.com",
                     "title": "Evernote", "snippet": "Remember everything."}],
        "ai_overview": {},
        "ai_overview_deferred": False,
        "questions": [],
    }
    capture = build_serp_capture(payload, website=website, query="best note app", page=2,
                                 location="us", capture_id="c1")
    assert capture["provider"] == "scraperapi"
    assert capture["results"][0]["position"] == 11
    assert capture["start"] == 10
