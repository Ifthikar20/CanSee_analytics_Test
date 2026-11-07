"""The run lifecycle every insights kind shares (contract 1e), with an
in-test fake kind: registration, the estimate's shared parts and blockers,
confirm checks, inline execution, unit counts, the ledger cost, Stop, the
stale sweep, dispatch failures, the Google quota and the runs API."""

import dataclasses
from collections import Counter
from datetime import timedelta
from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import AITokenUsage
from apps.insights.models import AnswerAnalysis, InsightRun
from apps.insights.services import runs
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import answer, fake_kind, track
from core.ai_tracking import record_usage
from core.exceptions import CanseeException

pytestmark = pytest.mark.django_db

CONFIRM_FREE = {"ai_calls": 0, "ai_usd_max": "0.0000", "google_pages": 0}


@pytest.fixture
def kind(monkeypatch):
    k = fake_kind()
    monkeypatch.setitem(runs.KINDS, k.key, k)
    return k


def install(monkeypatch, k):
    monkeypatch.setitem(runs.KINDS, k.key, k)
    return k


def allowance(monkeypatch, *, cap, spent):
    monkeypatch.setattr("core.ai_tracking.effective_ai_cap", lambda u: cap)
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda u: spent)


# -- registration ----------------------------------------------------------------


def test_register_is_idempotent_and_refuses_a_second_kind_under_one_key(monkeypatch):
    monkeypatch.setattr(runs, "KINDS", {})
    k = fake_kind("one")
    runs.register(k)
    runs.register(k)
    assert runs.KINDS == {"one": k}
    with pytest.raises(ValueError):
        runs.register(fake_kind("one", label="Another"))


def test_the_app_registers_the_five_measurement_kinds():
    expected = {
        "answer_analysis": ("Answer analysis", "ai"),
        "site_audit": ("Crawler audit", "integrations"),
        "prompt_research": ("Prompt research", "ai"),
        "fanout_google": ("Fan-out Google check", "integrations"),
        "shopping_check": ("Shopping check", "ai"),
    }
    for key, (label, queue) in expected.items():
        assert (runs.KINDS[key].label, runs.KINDS[key].queue) == (label, queue)


# -- estimate --------------------------------------------------------------------


def test_estimate_adds_allowance_google_confirm_and_the_upper_bound(website, user, monkeypatch,
                                                                    settings, cache_clear):
    settings.SCRAPERAPI_KEY = "sk"
    settings.SERP_PROVIDER = "scraperapi"
    install(monkeypatch, fake_kind(calls=4, usd="0.0240", pages=2, warnings=[
        {"code": "capped", "message": "Capped."}]))
    allowance(monkeypatch, cap=5.0, spent=0.92)

    est = runs.estimate(website, user, "fake_kind", {})

    assert est["summary"] == "3 fake units" and est["units"] == {"items": 3}
    assert est["ai"] == {"calls_max": 4, "usd_max": "0.0240", "model_label": "Claude Haiku 5.5"}
    assert est["google"] == {"pages_max": 2, "credits_max": 50, "usd_max": "0.0000",
                             "daily_left": 60, "daily_limit": 60}
    assert est["allowance"] == {"unlimited": False, "cap_usd": "5.00", "left_usd": "4.08",
                                "enough": True}
    assert est["confirm"] == {"ai_calls": 4, "ai_usd_max": "0.0240", "google_pages": 2}
    assert [w["code"] for w in est["warnings"]] == ["capped", "upper_bound"]
    assert est["warnings"][-1]["message"] == (
        "These are upper bounds; you are billed only for what runs.")
    assert est["blockers"] == [] and est["can_run"] is True


def test_a_free_run_has_no_upper_bound_warning_and_zero_confirm(website, user, kind):
    est = runs.estimate(website, user, "fake_kind", {})
    assert est["confirm"] == CONFIRM_FREE
    assert est["warnings"] == []
    assert est["google"]["credits_max"] == 0


def test_allowance_blockers(website, user, monkeypatch):
    install(monkeypatch, fake_kind(calls=2, usd="0.5000"))
    allowance(monkeypatch, cap=1.0, spent=0.8)
    est = runs.estimate(website, user, "fake_kind", {})
    assert est["blockers"] == [{
        "code": "insufficient_allowance",
        "message": "This run needs up to $0.50 of AI allowance and $0.20 is left this month.",
    }]
    assert est["allowance"]["enough"] is False and est["can_run"] is False

    allowance(monkeypatch, cap=1.0, spent=1.0)
    est = runs.estimate(website, user, "fake_kind", {})
    assert est["blockers"] == [{"code": "allowance_exceeded",
                                "message": "You have used your monthly AI allowance."}]

    with pytest.raises(CanseeException) as exc:
        runs.create_run(website, user, "fake_kind", {},
                        {"ai_calls": 2, "ai_usd_max": "0.5000", "google_pages": 0})
    assert (exc.value.code, exc.value.status_code) == ("allowance_exceeded", 403)


def test_daily_google_limit_blocks(website, user, monkeypatch, settings, cache_clear):
    settings.INSIGHTS_DAILY_GOOGLE_PAGES = 3
    install(monkeypatch, fake_kind(pages=4))
    est = runs.estimate(website, user, "fake_kind", {})
    assert est["blockers"] == [{
        "code": "daily_limit",
        "message": "This project has 3 Google pages left today; this run needs up to 4.",
    }]
    with pytest.raises(CanseeException) as exc:
        runs.create_run(website, user, "fake_kind", {},
                        {"ai_calls": 0, "ai_usd_max": "0", "google_pages": 4})
    assert (exc.value.code, exc.value.status_code) == ("daily_limit", 409)
    assert exc.value.details == {"left": 3, "need": 4}


def test_a_validate_blocker_shows_in_the_estimate_and_fails_create(website, user, monkeypatch):
    def nothing(website, params):
        raise CanseeException("Nothing here.", code="nothing_to_run", status_code=400)

    install(monkeypatch, fake_kind(validate=nothing))
    est = runs.estimate(website, user, "fake_kind", {})
    assert est["blockers"] == [{"code": "nothing_to_run", "message": "Nothing here."}]
    assert est["confirm"] == CONFIRM_FREE and est["can_run"] is False
    with pytest.raises(CanseeException) as exc:
        runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)
    assert (exc.value.code, exc.value.status_code) == ("nothing_to_run", 400)


def test_an_invalid_param_is_a_400_not_a_blocker(website, user, monkeypatch):
    def bad(website, params):
        raise CanseeException("No.", code="invalid", status_code=400,
                              details={"field": "engines", "message": "No."})

    install(monkeypatch, fake_kind(validate=bad))
    with pytest.raises(CanseeException) as exc:
        runs.estimate(website, user, "fake_kind", {})
    assert exc.value.code == "invalid"
    with pytest.raises(CanseeException) as exc:
        runs.estimate(website, user, "fake_kind", ["not", "a", "dict"])
    assert exc.value.details["field"] == "params"
    with pytest.raises(CanseeException) as exc:
        runs.estimate(website, user, "no_such_kind", {})
    assert exc.value.details["field"] == "kind"


def test_kind_blockers_follow_the_shared_ones_and_create_raises_the_first(website, user,
                                                                          monkeypatch):
    install(monkeypatch, fake_kind(blockers=[
        {"code": "cooldown", "status": 409, "message": "An audit ran 3 minutes ago."}]))
    InsightRun.objects.create(website=website, kind="fake_kind", status="running")
    est = runs.estimate(website, user, "fake_kind", {})
    assert [b["code"] for b in est["blockers"]] == ["run_in_progress", "cooldown"]
    assert est["blockers"][0]["message"] == "Fake kind is already running for this project."
    with pytest.raises(CanseeException) as exc:
        runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)
    assert (exc.value.code, exc.value.status_code) == ("run_in_progress", 409)
    assert "run_id" in exc.value.details


# -- create, execute, finalize ------------------------------------------------------


def test_create_refuses_a_confirm_below_the_estimate(website, user, monkeypatch):
    install(monkeypatch, fake_kind(calls=2, usd="0.0120"))
    for confirm in (
        {"ai_calls": 1, "ai_usd_max": "0.0120", "google_pages": 0},
        {"ai_calls": 2, "ai_usd_max": "0.0119", "google_pages": 0},
    ):
        with pytest.raises(CanseeException) as exc:
            runs.create_run(website, user, "fake_kind", {}, confirm)
        assert (exc.value.code, exc.value.status_code) == ("estimate_changed", 409)
        assert exc.value.details["estimate"]["confirm"]["ai_usd_max"] == "0.0120"
    for confirm in (None, {"ai_calls": True, "ai_usd_max": "0", "google_pages": 0},
                    {"ai_calls": 0, "ai_usd_max": "lots", "google_pages": 0},
                    {"ai_calls": 0, "ai_usd_max": "-1", "google_pages": 0}):
        with pytest.raises(CanseeException) as exc:
            runs.create_run(website, user, "fake_kind", {}, confirm)
        assert exc.value.details["field"] == "confirm"
    assert not InsightRun.objects.exists()


def test_an_inline_run_counts_every_unit_and_ends_done(website, user, kind):
    run = runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)

    assert (run.status, run.units_total, run.units_done, run.units_running) == ("done", 3, 3, 0)
    assert run.started_at and run.finished_at and run.created_by == user
    payload = runs.run_payload(run)
    assert payload["kind"] == "fake_kind" and payload["kind_label"] == "Fake kind"
    assert payload["progress"] == {"total": 3, "queued": 0, "running": 0, "done": 3, "failed": 0,
                                   "skipped": 0, "cancelled": 0}
    assert payload["cost"] == {"ai_usd": "0.0000", "google_pages": 0, "scraperapi_credits": None}
    assert payload["confirmed"] == CONFIRM_FREE
    assert payload["created_by_name"] == "Fixture Owner"
    assert payload["summary"] == "3 fake units" and payload["error"] is None
    assert payload["duration_ms"] is not None and payload["result"] == {}


def test_ai_cost_sums_the_ledger_rows_tagged_with_the_run(website, user, monkeypatch):
    def spend(ctx, index):
        record_usage(module="insights", model_name="claude-haiku-5-5", input_tokens=1000,
                     output_tokens=200, user=ctx.user, website=ctx.website,
                     metadata={"audit_id": ctx.audit_id, "role": "answer_analysis"},
                     idempotency_key=f"insights:test:{index}")
        return "done"

    install(monkeypatch, fake_kind(units=2, item=spend, calls=2, usd="0.0120"))
    record_usage(module="insights", model_name="claude-haiku-5-5", input_tokens=1000,
                 output_tokens=200, user=user, website=website,
                 metadata={"audit_id": "insights-run:someone-else"})
    run = runs.create_run(website, user, "fake_kind", {},
                          {"ai_calls": 2, "ai_usd_max": "0.0120", "google_pages": 0})
    assert run.status == "done"
    tagged = AITokenUsage.objects.filter(metadata__audit_id=run.audit_id)
    assert tagged.count() == 2 and AITokenUsage.objects.count() == 3
    assert run.ai_cost_usd > 0
    assert run.ai_cost_usd == sum(r.estimated_cost_usd for r in tagged)
    assert runs.run_payload(run)["cost"]["ai_usd"] == runs.usd4(run.ai_cost_usd)


def test_some_failed_is_partial_and_none_done_is_failed_with_the_common_error(website, user,
                                                                            monkeypatch):
    install(monkeypatch, fake_kind(
        units=3, item=lambda ctx, i: "done" if i == 0 else ("failed", "serp_failed")))
    run = runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)
    assert (run.status, run.units_done, run.units_failed) == ("partial", 1, 2)

    install(monkeypatch, fake_kind(
        units=3, item=lambda ctx, i: ("failed", "rate_limited" if i else "serp_failed")))
    run = runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)
    assert run.status == "failed"
    assert (run.error_code, run.error_message) == ("rate_limited",
                                                   "The model was busy or rate limited.")
    assert runs.run_payload(run)["error"] == {"code": "rate_limited",
                                              "message": "The model was busy or rate limited."}


def test_an_item_that_raises_or_never_ends_is_failed_by_finalize(website, user, monkeypatch):
    def boom(ctx, index):
        if index == 1:
            raise RuntimeError("bug")
        if index == 2:
            return None  # started, never ended
        return "done"

    install(monkeypatch, fake_kind(units=3, item=boom))
    run = runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)
    assert (run.status, run.units_done, run.units_failed, run.units_running) == ("partial", 1, 2, 0)


def test_a_kind_that_raises_ends_failed(website, user, monkeypatch):
    k = fake_kind()

    def explode(ctx):
        raise RuntimeError("bug")

    install(monkeypatch, dataclasses.replace(k, execute=explode))
    run = runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)
    assert (run.status, run.units_failed) == ("failed", 3)
    assert run.error_code == "internal_error"


def test_stop_mid_run_cancels_the_rest(website, user, monkeypatch):
    monkeypatch.setattr(runs, "CANCEL_POLL_SECONDS", 0)

    def stop_after_first(ctx, index):
        InsightRun.objects.filter(id=ctx.run.id).update(cancel_requested=True)
        return "done"

    install(monkeypatch, fake_kind(units=4, item=stop_after_first))
    run = runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)
    assert (run.status, run.units_done, run.units_cancelled) == ("cancelled", 1, 3)


def test_one_active_run_per_kind_and_website_but_other_kinds_may_run(website, user, monkeypatch):
    install(monkeypatch, fake_kind("kind_a", label="Kind A"))
    install(monkeypatch, fake_kind("kind_b", label="Kind B"))
    InsightRun.objects.create(website=website, kind="kind_a", status="queued")
    with pytest.raises(CanseeException) as exc:
        runs.create_run(website, user, "kind_a", {}, CONFIRM_FREE)
    assert exc.value.message == "Kind A is already running for this project."
    assert runs.create_run(website, user, "kind_b", {}, CONFIRM_FREE).status == "done"


def test_cancel_of_a_queued_run_ends_it_and_its_items_at_once(website, user, kind):
    bp = track(website, "best notes app")
    result = answer(bp, "gpt4", timezone.now())
    run = InsightRun.objects.create(website=website, kind="fake_kind", status="queued",
                                    units_total=2, created_by=user)
    item = AnswerAnalysis.objects.create(
        website=website, result=result, run=run, version="1", engine="chatgpt",
        answered_at=result.created_at,
    )
    run = runs.cancel_run(run)
    assert (run.status, run.units_cancelled, run.cancel_requested) == ("cancelled", 2, True)
    item.refresh_from_db()
    assert (item.status, item.error_code) == ("cancelled", "cancelled")
    assert runs.cancel_run(run).status == "cancelled"  # idempotent
    # A run that is no longer queued is not executed by a late worker.
    runs.execute_run(run.id)
    run.refresh_from_db()
    assert run.units_done == 0


def test_the_sweep_interrupts_runs_without_a_heartbeat(website, user, kind, settings):
    old = timezone.now() - timedelta(minutes=settings.INSIGHTS_RUN_STALE_MINUTES + 1)
    stale = InsightRun.objects.create(website=website, kind="fake_kind", status="running",
                                      units_total=3, units_done=1, units_running=1,
                                      heartbeat_at=old)
    fresh = InsightRun.objects.create(website=website, kind="fake_kind", status="running",
                                      units_total=3, heartbeat_at=timezone.now())
    InsightRun.objects.filter(id=stale.id).update(created_at=old)
    assert runs.sweep_stale(website) == 1
    stale.refresh_from_db()
    fresh.refresh_from_db()
    assert (stale.status, stale.units_failed, stale.units_running) == ("interrupted", 2, 0)
    assert (stale.error_code, stale.error_message) == ("interrupted",
                                                       "The run stopped before it finished.")
    assert fresh.status == "running"


def test_a_dispatch_failure_fails_the_run(website, user, kind, settings, monkeypatch):
    settings.INSIGHTS_RUN_MODE = "celery"

    def broken(*args, **kwargs):
        raise RuntimeError("broker down")

    monkeypatch.setattr("apps.insights.tasks.run_insight.apply_async", broken)
    run = InsightRun.objects.create(website=website, kind="fake_kind", status="queued",
                                    units_total=3)
    runs.dispatch(run.id)
    run.refresh_from_db()
    assert (run.status, run.error_code, run.units_failed) == ("failed", "internal_error", 3)
    assert run.error_message == "The run could not be started."


def test_celery_dispatch_uses_the_kind_queue(website, kind, settings, monkeypatch):
    settings.INSIGHTS_RUN_MODE = "celery"
    sent = []
    monkeypatch.setattr("apps.insights.tasks.run_insight.apply_async",
                        lambda args, queue: sent.append((args, queue)))
    run = InsightRun.objects.create(website=website, kind="fake_kind", status="queued")
    runs.dispatch(run.id)
    assert sent == [([str(run.id)], "ai")]


def test_finalize_takes_the_error_counter_when_no_item_rows_exist(website):
    run = InsightRun.objects.create(website=website, kind="fake_kind", status="running",
                                    units_total=2, units_failed=2)
    run = runs.finalize(run.id, errors=Counter({"timeout": 2}))
    assert (run.status, run.error_code, run.error_message) == (
        "failed", "timeout", "The page took too long to load.")


# -- context helpers ----------------------------------------------------------------


def test_google_pages_draw_on_the_daily_quota_and_billed_pages_are_counted(
        website, user, settings, cache_clear, monkeypatch):
    settings.INSIGHTS_DAILY_GOOGLE_PAGES = 2
    seen = []

    def item(ctx, index):
        seen.append(ctx.google_page())
        ctx.billed_page()
        return "done"

    install(monkeypatch, fake_kind(units=3, item=item))
    run = runs.create_run(website, user, "fake_kind", {}, CONFIRM_FREE)
    assert seen == [True, True, False]
    assert run.google_pages == 3
    assert runs.google_quota().remaining(str(website.id)) == 0


def test_scraperapi_credits_follow_the_kind(website):
    run = InsightRun.objects.create(website=website, kind="fanout_google", status="done",
                                    google_pages=4, google_provider="scraperapi")
    assert runs.run_payload(run)["cost"]["scraperapi_credits"] == 100
    run = InsightRun.objects.create(website=website, kind="shopping_check", status="done",
                                    google_pages=2, google_provider="scraperapi")
    assert runs.run_payload(run)["cost"]["scraperapi_credits"] == 50
    run = InsightRun.objects.create(website=website, kind="fanout_google", status="done",
                                    google_pages=2, google_provider="serpapi")
    assert runs.run_payload(run)["cost"]["scraperapi_credits"] is None


def test_options(website, user, kind, monkeypatch):
    allowance(monkeypatch, cap=5.0, spent=0.92)
    InsightRun.objects.create(website=website, kind="fake_kind", status="done")
    opts = runs.options(website, user, "fake_kind")
    assert opts["kind"] == "fake_kind" and opts["enabled"] is True
    assert opts["configured"]["google"] is False and opts["configured"]["shopping"] is False
    assert opts["allowance"] == {"unlimited": False, "cap_usd": "5.00", "spent_usd": "0.92",
                                 "left_usd": "4.08"}
    assert opts["google_daily"] == {"limit": 60, "used": 0, "left": 60, "credits_per_page": None}
    assert opts["choices"] == {"fake": True} and opts["limits"] == {}
    assert opts["active_run"] is None and opts["last_run"]["status"] == "done"


def test_the_thread_pool_keeps_order_and_contains_failures():
    def work(n):
        if n == 2:
            raise RuntimeError("bug")
        return n * 10

    with runs.Pool(3, inline=False) as pool:
        assert pool.map(work, range(4)) == [0, 10, None, 30]
        assert pool.submit(work, 5).result() == 50
    assert runs.Pool(2, inline=True).map(work, [1, 2]) == [10, None]


def test_usd_helpers():
    assert runs.usd4(Decimal("0.00005")) == "0.0001"
    assert runs.usd2(Decimal("4.089"), rounding=runs.ROUND_DOWN) == "4.08"


# -- API --------------------------------------------------------------------------


def test_runs_api(client, website, kind):
    base = {"website_id": website.id}
    opts = client.get(reverse("insights-run-options", kwargs=base), {"kind": "fake_kind"})
    assert opts.status_code == 200 and opts.json()["data"]["kind"] == "fake_kind"

    est = client.post(reverse("insights-run-estimate", kwargs=base),
                      {"kind": "fake_kind", "params": {}}, format="json")
    assert est.status_code == 200
    confirm = est.json()["data"]["confirm"]

    created = client.post(reverse("insights-runs", kwargs=base),
                          {"kind": "fake_kind", "params": {}, "confirm": confirm}, format="json")
    assert created.status_code == 202
    run = created.json()["data"]
    assert run["status"] == "done"

    listed = client.get(reverse("insights-runs", kwargs=base), {"kind": "fake_kind"})
    assert [r["id"] for r in listed.json()["data"]] == [run["id"]]
    one = client.get(reverse("insights-run", kwargs={**base, "run_id": run["id"]}))
    assert one.json()["data"]["id"] == run["id"]
    stopped = client.post(reverse("insights-run-cancel", kwargs={**base, "run_id": run["id"]}),
                          {}, format="json")
    assert stopped.status_code == 200 and stopped.json()["data"]["status"] == "done"

    bad = client.get(reverse("insights-run-options", kwargs=base), {"kind": "nope"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid"


def test_runs_api_tenancy_and_switch(client, website, stranger, kind, settings):
    from apps.websites.models import Website

    other = Website.objects.create(user=stranger, url="https://other.example", name="Other")
    run = InsightRun.objects.create(website=other, kind="fake_kind", status="done")
    resp = client.get(reverse("insights-runs", kwargs={"website_id": other.id}))
    assert resp.status_code == 404
    resp = client.get(reverse("insights-run", kwargs={"website_id": website.id, "run_id": run.id}))
    assert resp.status_code == 404 and resp.json()["error"]["code"] == "not_found"

    settings.INSIGHTS_ENABLED = False
    resp = client.get(reverse("insights-runs", kwargs={"website_id": website.id}))
    assert resp.status_code == 503
    assert resp.json()["error"] == {"code": "insights_disabled",
                                    "message": "Insights are turned off on this server."}
