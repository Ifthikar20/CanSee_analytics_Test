"""Ask AI API: tenancy, payloads, the runs list (contract 4)."""
import uuid

import pytest
from django.urls import reverse

from apps.prompt_box.models import PromptBoxRun
from apps.prompt_box.tests.support import *  # noqa: F403
from apps.prompt_box.tests.support import QUESTION, body, data, error, named

pytestmark = pytest.mark.django_db


def _urls(website, run_id=None) -> dict:
    kw = {"website_id": website.id}
    out = {
        "estimate": reverse("prompt-box-estimate", kwargs=kw),
        "runs": reverse("prompt-box-runs", kwargs=kw),
    }
    if run_id:
        out["run"] = reverse("prompt-box-run", kwargs={**kw, "run_id": run_id})
        out["cancel"] = reverse("prompt-box-run-cancel", kwargs={**kw, "run_id": run_id})
    return out


def _ask(client, website, payload=None):
    urls = _urls(website)
    payload = payload or body()
    est = data(client.post(urls["estimate"], payload, format="json"))
    return client.post(urls["runs"], {**payload, "confirm": est["confirm"]}, format="json")


def test_the_prefixes_and_names():
    wid = uuid.uuid4()
    assert reverse("prompt-box-estimate", kwargs={"website_id": wid}) == (
        f"/api/v1/prompt-box/websites/{wid}/estimate/")
    assert reverse("prompt-box-runs", kwargs={"website_id": wid}) == (
        f"/api/v1/prompt-box/websites/{wid}/runs/")


def test_ask_read_and_list(api, website, engines, extraction):
    engines.enable("chatgpt", "claude")
    engines.script("claude", named(1))
    resp = _ask(api, website)
    assert resp.status_code == 201
    run = data(resp)
    assert set(run) == {"id", "text", "samples", "status", "created_at", "finished_at",
                        "progress", "engines", "cost", "tracked", "error"}
    assert (run["status"], run["text"], run["samples"]) == ("done", QUESTION, 3)
    assert run["created_at"].endswith("Z") and run["finished_at"].endswith("Z")
    assert [e["key"] for e in run["engines"]] == ["chatgpt", "claude"]
    assert len(run["engines"][1]["answers"]) == 3

    urls = _urls(website, run["id"])
    one = data(api.get(urls["run"]))
    assert one == {**run, "cost": one["cost"]}
    assert "answer_text" not in one["engines"][0]["answers"][0]
    full = data(api.get(urls["run"] + "?full=1"))
    answer = full["engines"][1]["answers"][0]
    assert answer["answer_text"].startswith("1. Northwind CRM")
    assert (answer["citation_urls"], answer["search_queries"]) == ([], None)

    listed = data(api.get(urls["runs"]))
    assert [r["id"] for r in listed] == [run["id"]]
    assert "answers" not in listed[0]["engines"][0]
    assert listed[0]["engines"][1]["named"] == 1


def test_the_list_keeps_the_20_newest(api, website):
    for n in range(22):
        PromptBoxRun.objects.create(website=website, text=f"question {n}", samples=1,
                                    engines=["chatgpt"], status="done")
    listed = data(api.get(_urls(website)["runs"]))
    assert len(listed) == 20
    assert listed[0]["text"] == "question 21"
    assert listed[0]["engines"] == [{
        "key": "chatgpt", "label": "ChatGPT", "asked": 0, "answered": 0, "named": 0,
        "share_pct": None, "share_low_pct": None, "share_high_pct": None, "avg_rank": None,
    }]


def test_a_blocked_or_invalid_question(api, website, engines):
    resp = api.post(_urls(website)["estimate"], body("hi"), format="json")
    assert resp.status_code == 400
    assert error(resp) == {
        "code": "invalid", "message": "Ask one question, up to 300 characters.",
        "details": {"field": "text", "message": "Ask one question, up to 300 characters."},
    }
    # No engine: the estimate answers with the blocker; asking is refused.
    est = data(api.post(_urls(website)["estimate"], body(), format="json"))
    assert est["can_run"] is False
    resp = api.post(_urls(website)["runs"], {**body(), "confirm": est["confirm"]}, format="json")
    assert resp.status_code == 400
    assert error(resp)["code"] == "not_configured"
    assert api.post(_urls(website)["estimate"], ["not", "an", "object"],
                    format="json").status_code == 400


def test_a_changed_estimate_is_409_with_the_new_one(api, website, engines):
    engines.enable("chatgpt")
    resp = api.post(_urls(website)["runs"],
                    {**body(), "confirm": {"answers": 3, "ai_usd_max": "0.0100"}}, format="json")
    assert resp.status_code == 409
    err = error(resp)
    assert err["code"] == "estimate_changed"
    assert err["details"]["estimate"]["confirm"] == {"answers": 3, "ai_usd_max": "0.0900"}


def test_stop(api, website, engines, settings):
    engines.enable("chatgpt")
    settings.PROMPT_BOX_RUN_MODE = "thread"  # stays queued: no commit in a test
    run = data(_ask(api, website))
    assert run["status"] == "queued"
    stopped = data(api.post(_urls(website, run["id"])["cancel"]))
    assert stopped["status"] == "cancelled"
    assert stopped["progress"] == {"total": 3, "done": 0, "failed": 0, "running": 0}


def test_viewers_read_members_ask_strangers_get_404_viewer_writes_403(website, member_clients, engines, extraction):
    engines.enable("chatgpt")
    member, viewer, stranger = (member_clients[k] for k in ("member", "viewer", "stranger"))
    resp = _ask(member, website)
    assert resp.status_code == 201
    run_id = data(resp)["id"]
    urls = _urls(website, run_id)

    assert viewer.get(urls["runs"]).status_code == 200
    assert viewer.get(urls["run"]).status_code == 200
    for url in (urls["estimate"], urls["runs"], urls["cancel"]):
        assert viewer.post(url, {**body(), "confirm": {}}, format="json").status_code == 403
    for method, url in (("get", urls["runs"]), ("get", urls["run"]),
                        ("post", urls["estimate"]), ("post", urls["cancel"])):
        assert getattr(stranger, method)(url, body(), format="json").status_code == 404
    # A run of another project is not found under this one.
    assert member.get(reverse("prompt-box-run", kwargs={
        "website_id": website.id, "run_id": uuid.uuid4()})).status_code == 404
