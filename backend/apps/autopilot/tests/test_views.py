"""The Autopilot API (contract 3): Run now (estimate, create with its
confirm, the 409s), the runs list and one run, Stop, and who may do what
(viewers read, members run, everyone else gets 404, signed out 401)."""

from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.autopilot.models import AutopilotRun
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import (
    client_for,
    data,
    error,
    join_org,
    make_autopilot,
    make_prompt,
    make_run,
    make_user,
)

pytestmark = pytest.mark.django_db


def urls(website, run=None) -> dict:
    wid = {"website_id": website.id}
    out = {
        "settings": reverse("autopilot-settings", kwargs=wid),
        "estimate": reverse("autopilot-run-estimate", kwargs=wid),
        "create": reverse("autopilot-run-create", kwargs=wid),
        "runs": reverse("autopilot-runs", kwargs=wid),
        "test": reverse("autopilot-text-test", kwargs=wid),
        "ranking": reverse("autopilot-ranking", kwargs=wid),
    }
    if run is not None:
        out["run"] = reverse("autopilot-run", kwargs={**wid, "run_id": run.id})
        out["cancel"] = reverse("autopilot-run-cancel", kwargs={**wid, "run_id": run.id})
    return out


def test_the_paths(website):
    run = make_run(website)
    base = f"/api/v1/autopilot/websites/{website.id}/"
    assert urls(website, run) == {
        "settings": base, "estimate": f"{base}run/estimate/", "create": f"{base}run/",
        "runs": f"{base}runs/", "test": f"{base}text/test/", "ranking": f"{base}ranking/",
        "run": f"{base}runs/{run.id}/", "cancel": f"{base}runs/{run.id}/cancel/",
    }


def test_run_now_end_to_end(api, website, engines):
    engines.enable("chatgpt", "claude")
    make_prompt(website, "best notes app")
    paths = urls(website)
    est = data(api.post(paths["estimate"], {}, format="json"))
    assert est["can_run"] and est["confirm"] == {"answers": 2, "ai_usd_max": "0.0600",
                                                 "google_pages": 0}
    resp = api.post(paths["create"], {"confirm": est["confirm"]}, format="json")
    assert resp.status_code == 201
    run = data(resp)
    assert (run["status"], run["trigger"], run["prompts"]["done"]) == ("done", "manual", 1)
    assert set(run) == {
        "id", "local_date", "trigger", "status", "stage", "started_at", "finished_at",
        "prompts", "answers", "change_pts", "google", "analysis", "cost", "text", "error",
    }
    # Today's run exists now.
    again = data(api.post(paths["estimate"], {}, format="json"))
    assert again["blockers"] == [{
        "code": "run_today_exists",
        "message": "Today's run already happened. The next one is tomorrow at 07:00.",
    }]
    resp = api.post(paths["create"], {"confirm": est["confirm"]}, format="json")
    assert resp.status_code == 409
    assert error(resp)["code"] == "run_today_exists"


def test_a_confirm_below_the_estimate_is_refused(api, website, engines):
    engines.enable("chatgpt", "claude")
    make_prompt(website, "best notes app")
    paths = urls(website)
    resp = api.post(paths["create"], {"confirm": {"answers": 1, "ai_usd_max": "0.0600",
                                                  "google_pages": 0}}, format="json")
    assert resp.status_code == 409
    err = error(resp)
    assert (err["code"], err["message"]) == (
        "estimate_changed", "The cost changed. Check the new estimate and confirm again.")
    assert err["details"]["estimate"]["confirm"]["answers"] == 2
    for bad in (None, "yes", {"answers": "2", "ai_usd_max": "1", "google_pages": 0},
                {"answers": 2, "ai_usd_max": "lots", "google_pages": 0}):
        resp = api.post(paths["create"], {"confirm": bad}, format="json")
        assert resp.status_code == 400
        assert error(resp)["details"] == {"field": "confirm",
                                          "message": "Confirm the estimate before running."}
    assert not AutopilotRun.objects.exists()


def test_a_blocker_is_the_create_error(api, website):
    resp = api.post(urls(website)["create"], {"confirm": {
        "answers": 0, "ai_usd_max": "0", "google_pages": 0}}, format="json")
    assert resp.status_code == 400
    assert (error(resp)["code"], error(resp)["message"]) == ("nothing_to_run",
                                                             "Track a prompt first.")


def test_the_runs_list_and_one_run(api, website, engines):
    engines.enable("claude")
    bp = make_prompt(website, "best notes app")
    paths = urls(website)
    for days in range(32):
        make_run(website, local_date=timezone.now().date() - timedelta(days=days + 1),
                 created_at=timezone.now() - timedelta(days=days + 1))
    listed = data(api.get(paths["runs"]))
    assert len(listed) == 30
    assert listed[0]["local_date"] == (timezone.now().date() - timedelta(days=1)).isoformat()

    est = data(api.post(paths["estimate"], {}, format="json"))
    run_id = data(api.post(paths["create"], {"confirm": est["confirm"]}, format="json"))["id"]
    run = AutopilotRun.objects.get(id=run_id)
    detail = data(api.get(urls(website, run)["run"]))
    assert detail["id"] == run_id and detail["text_body"] == run.text_body
    assert detail["prompts"]["planned"] == 1
    (row,) = detail["prompt_rows"]
    assert (row["brand_prompt_id"], row["prompt_id"], row["text"], row["status"]) == (
        str(bp.id), str(bp.prompt_id), "best notes app", "done")
    assert row["answers"] == {"asked": 1, "answered": 1, "named": 1}
    assert row["google"]["status"] == "off"


def test_stop_a_waiting_run(api, website, user, engines, settings):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    settings.AUTOPILOT_MAX_ACTIVE_RUNS = 1
    other = make_user("other@example.com")
    from apps.websites.models import Website

    busy_site = Website.objects.create(user=other, url="https://busy.example", name="Busy")
    make_run(busy_site, status="running", stage="engines", heartbeat_at=timezone.now())
    est = data(api.post(urls(website)["estimate"], {}, format="json"))
    run_id = data(api.post(urls(website)["create"], {"confirm": est["confirm"]},
                           format="json"))["id"]
    run = AutopilotRun.objects.get(id=run_id)
    assert run.status == "queued"
    stopped = data(api.post(urls(website, run)["cancel"]))
    assert stopped["status"] == "cancelled"
    assert stopped["text"] == {"status": "skipped", "reason": "cancelled", "due_at": None,
                               "sent_at": None}
    # Stopping again changes nothing.
    assert data(api.post(urls(website, run)["cancel"]))["status"] == "cancelled"


def test_who_may_do_what(website, user, engines):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    viewer = make_user("viewer@example.com")
    member = make_user("member@example.com")
    join_org(website, user, {viewer: "viewer", member: "member"})
    run = make_run(website, local_date=timezone.now().date() - timedelta(days=1))
    paths = urls(website, run)
    as_viewer, as_member = client_for(viewer), client_for(member)

    for name in ("settings", "runs", "run", "ranking"):
        assert as_viewer.get(paths[name]).status_code == 200, name
    for name in ("estimate", "create", "cancel", "test"):
        assert as_viewer.post(paths[name], {}, format="json").status_code == 404, name
    assert as_viewer.put(paths["settings"], {}, format="json").status_code == 404

    est = data(as_member.post(paths["estimate"], {}, format="json"))
    assert est["can_run"]
    resp = as_member.post(paths["create"], {"confirm": est["confirm"]}, format="json")
    assert resp.status_code == 201
    created = AutopilotRun.objects.get(id=data(resp)["id"])
    # The member ran it; the spend is the owner's (actor system).
    assert created.created_by == member

    stranger = client_for(make_user("stranger@example.com"))
    for name, method in (("settings", "get"), ("runs", "get"), ("run", "get"),
                         ("ranking", "get"), ("estimate", "post"), ("create", "post"),
                         ("cancel", "post"), ("test", "post")):
        assert getattr(stranger, method)(paths[name]).status_code == 404, name
        assert getattr(client_for(), method)(paths[name]).status_code == 401, name


def test_a_run_of_another_project_is_not_found(api, website, user):
    from apps.websites.models import Website

    other = Website.objects.create(user=user, url="https://second.example", name="Second")
    run = make_run(other)
    resp = api.get(reverse("autopilot-run", kwargs={"website_id": website.id,
                                                    "run_id": run.id}))
    assert resp.status_code == 404
    assert error(resp)["message"] == "Run not found."


def test_settings_view_ends_stale_runs(api, website):
    make_autopilot(website)
    dead = timezone.now() - timedelta(minutes=45)
    run = make_run(website, status="running", stage="google", heartbeat_at=dead)
    got = data(api.get(urls(website)["settings"]))
    run.refresh_from_db()
    assert run.status == "interrupted"
    assert got["today_run"]["status"] == "interrupted"
