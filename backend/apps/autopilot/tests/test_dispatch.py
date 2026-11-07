"""The dispatcher (backend 4e): when a project's run is due across time
zones and clock changes, one run per local day under a race, manual runs
waiting for a slot, the analysis wait, resume and sweep, texts due,
``next_run_at``, and ``covers()`` with the two older dispatchers it guards."""

from datetime import UTC, datetime, time, timedelta

import pytest
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.autopilot import tasks
from apps.autopilot.models import AutopilotRun
from apps.autopilot.services import pipeline
from apps.autopilot.services import settings as autopilot_settings
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import make_autopilot, make_prompt, make_run, make_user
from apps.insights.models import InsightRun
from apps.websites.models import Website

pytestmark = pytest.mark.django_db

Run = AutopilotRun


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


@pytest.fixture
def queued(monkeypatch, settings, django_capture_on_commit_callbacks):
    """Celery mode with every task's delay recorded, on-commit callbacks
    run: ``tick(now)`` is one dispatcher tick."""
    settings.AUTOPILOT_RUN_MODE = "celery"
    sent: list[tuple] = []
    for name in ("start_run", "run_engines", "run_google", "finalize_run", "deliver_text"):
        task = getattr(tasks, name)
        monkeypatch.setattr(task, "delay", lambda run_id, _n=name: sent.append((_n, run_id)))

    def tick(now=None):
        with django_capture_on_commit_callbacks(execute=True):
            out = pipeline.dispatch_tick(now)
        return out

    tick.sent = sent
    return tick


def runs_of(website) -> list:
    return list(Run.objects.filter(website=website).order_by("created_at"))


# -- due -----------------------------------------------------------------------------------


def test_a_run_is_due_at_the_local_run_time(website, queued):
    make_autopilot(website, timezone="America/New_York", run_time=time(7, 0))
    # 06:59 in New York (EST, UTC-5).
    assert queued(utc(2026, 11, 4, 11, 59))["started"] == 0
    assert runs_of(website) == []
    out = queued(utc(2026, 11, 4, 12, 0))
    assert out["started"] == 1
    (run,) = runs_of(website)
    assert (run.trigger, run.status, run.stage) == ("schedule", "running", "plan")
    assert str(run.local_date) == "2026-11-04"
    assert queued.sent == [("start_run", str(run.id))]
    # The same local day starts nothing more.
    assert queued(utc(2026, 11, 4, 18, 0))["started"] == 0
    assert len(runs_of(website)) == 1


def test_the_local_date_follows_the_project_zone(website, queued):
    make_autopilot(website, timezone="Asia/Tokyo", run_time=time(7, 0))
    # 22:00 UTC on Nov 3 is 07:00 on Nov 4 in Tokyo.
    queued(utc(2026, 11, 3, 22, 0))
    (run,) = runs_of(website)
    assert str(run.local_date) == "2026-11-04"


def test_an_unknown_zone_reads_as_utc(website, queued):
    make_autopilot(website, timezone="Mars/Olympus", run_time=time(7, 0))
    assert queued(utc(2026, 11, 4, 6, 59))["started"] == 0
    assert queued(utc(2026, 11, 4, 7, 0))["started"] == 1


def test_spring_forward_runs_once_the_skipped_time_has_passed(website, queued):
    # 2026-03-08 in New York: 02:00 EST jumps to 03:00 EDT.
    make_autopilot(website, timezone="America/New_York", run_time=time(2, 30))
    assert queued(utc(2026, 3, 8, 6, 59))["started"] == 0     # 01:59 EST
    assert queued(utc(2026, 3, 8, 7, 0))["started"] == 1      # 03:00 EDT
    assert [str(r.local_date) for r in runs_of(website)] == ["2026-03-08"]


def test_fall_back_runs_once_although_the_time_happens_twice(website, queued):
    # 2026-11-01 in New York: 01:59 EDT goes back to 01:00 EST.
    make_autopilot(website, timezone="America/New_York", run_time=time(1, 30))
    assert queued(utc(2026, 11, 1, 5, 30))["started"] == 1    # 01:30 EDT
    assert queued(utc(2026, 11, 1, 6, 30))["started"] == 0    # 01:30 EST again
    assert len(runs_of(website)) == 1


def test_a_day_the_dispatcher_never_saw_is_not_made_up(website, queued):
    make_autopilot(website, run_time=time(7, 0))
    queued(utc(2026, 11, 6, 8, 0))
    assert [str(r.local_date) for r in runs_of(website)] == ["2026-11-06"]


@pytest.mark.parametrize("change", [
    {"enabled": False},
    {"paused_reason": "failures"},
])
def test_off_or_paused_projects_do_not_run(website, queued, change):
    make_autopilot(website, run_time=time(7, 0), **change)
    assert queued(utc(2026, 11, 4, 8, 0))["started"] == 0


def test_deleted_and_inactive_projects_do_not_run(website, queued, user):
    make_autopilot(website, run_time=time(7, 0))
    Website.objects.filter(id=website.id).update(is_active=False)
    assert queued(utc(2026, 11, 4, 8, 0))["started"] == 0
    Website.objects.filter(id=website.id).update(is_active=True, is_deleted=True)
    assert queued(utc(2026, 11, 4, 8, 0))["started"] == 0


def test_a_plan_without_autopilot_does_not_run(website, queued, settings):
    settings.PAYWALL_ENABLED = True   # the owner has no subscription: Free
    make_autopilot(website, run_time=time(7, 0))
    assert queued(utc(2026, 11, 4, 8, 0))["started"] == 0


def test_the_deployment_switch(website, queued, settings):
    settings.AUTOPILOT_ENABLED = False
    make_autopilot(website, run_time=time(7, 0))
    assert queued(utc(2026, 11, 4, 8, 0)) == {"skipped": "disabled"}
    assert runs_of(website) == []


def test_a_tick_still_running_skips_the_next(website, queued):
    make_autopilot(website, run_time=time(7, 0))
    cache.add(pipeline.DISPATCH_LOCK, 1, 240)
    assert queued(utc(2026, 11, 4, 8, 0)) == {"skipped": "busy"}
    cache.delete(pipeline.DISPATCH_LOCK)
    assert queued(utc(2026, 11, 4, 8, 0))["started"] == 1


# -- one run per local day ------------------------------------------------------------------


def test_the_database_allows_one_run_per_project_and_local_day(website):
    make_run(website, local_date=timezone.now().date())
    with pytest.raises(IntegrityError), transaction.atomic():
        Run.objects.create(website=website, local_date=timezone.now().date())


def test_a_racing_get_or_create_starts_nothing_twice(website, queued, monkeypatch):
    autopilot = make_autopilot(website, run_time=time(7, 0))
    manager = Run.objects
    real = manager.get_or_create

    def racing(**kwargs):
        # Another dispatcher (or Run now) inserts the row first.
        Run.objects.create(website_id=autopilot.website_id, local_date=kwargs["local_date"],
                           trigger="manual", status="queued")
        return real(**kwargs)

    monkeypatch.setattr(manager, "get_or_create", racing)
    out = queued(utc(2026, 11, 4, 8, 0))
    assert out["started"] == 0
    (run,) = runs_of(website)
    assert run.trigger == "manual"
    assert [name for name, _id in queued.sent] == []


def test_a_manual_run_counts_as_todays_run(website, queued, user, engines):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    autopilot = make_autopilot(website, run_time=time(7, 0))
    est = pipeline.run_estimate(website, user)
    day = autopilot_settings.local_today(autopilot)
    manual = pipeline.create_manual_run(website, user, est["confirm"])
    assert manual.status == "running"
    now = datetime.combine(day, time(8, 0), tzinfo=UTC)
    assert queued(now)["started"] == 0
    assert len(runs_of(website)) == 1


# -- slots ---------------------------------------------------------------------------------


def test_manual_runs_wait_for_a_slot_and_go_first(website, user, queued, settings, engines):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    settings.AUTOPILOT_MAX_ACTIVE_RUNS = 1
    other_owner = make_user("other@example.com")
    other = Website.objects.create(user=other_owner, url="https://other.example", name="Other")
    make_autopilot(other, run_time=time(0, 0))
    busy = make_run(other, local_date=timezone.now().date() - timedelta(days=3),
                    status="running", stage="engines", heartbeat_at=timezone.now())

    est = pipeline.run_estimate(website, user)
    manual = pipeline.create_manual_run(website, user, est["confirm"])
    assert manual.status == "queued"
    assert pipeline.run_summary(manual)["status"] == "queued"
    # The slot is taken: nothing starts.
    queued()
    manual.refresh_from_db()
    assert manual.status == "queued" and queued.sent == []

    Run.objects.filter(id=busy.id).update(status="done", stage="finished")
    out = queued()
    manual.refresh_from_db()
    assert manual.status == "running" and out["started"] == 1
    assert queued.sent == [("start_run", str(manual.id))]
    # The scheduled project waits for the next free slot.
    assert Run.objects.filter(website=other).exclude(id=busy.id).count() == 0


def test_runs_waiting_for_their_analysis_hold_no_slot(website, settings):
    settings.AUTOPILOT_MAX_ACTIVE_RUNS = 1
    make_run(website, local_date=timezone.now().date() - timedelta(days=1), status="running",
             stage="analysis")
    assert pipeline.active_count() == 0
    make_run(website, local_date=timezone.now().date() - timedelta(days=2), status="running",
             stage="engines")
    assert pipeline.active_count() == 1


# -- analysis wait, resume, sweep, texts ----------------------------------------------------


def test_a_finished_analysis_releases_its_run(website, queued, settings):
    insight = InsightRun.objects.create(website=website, kind="answer_analysis", status="done")
    run = make_run(website, status="running", stage="analysis", analysis_status="running",
                   analysis_run=insight, heartbeat_at=timezone.now())
    queued()
    run.refresh_from_db()
    assert run.stage == "finalize"
    assert queued.sent == [("finalize_run", str(run.id))]


def test_an_analysis_past_the_wait_releases_its_run(website, queued, settings):
    settings.AUTOPILOT_ANALYSIS_WAIT_MINUTES = 15
    insight = InsightRun.objects.create(website=website, kind="answer_analysis", status="running")
    run = make_run(website, status="running", stage="analysis", analysis_status="running",
                   analysis_run=insight, heartbeat_at=timezone.now())
    queued()
    run.refresh_from_db()
    assert run.stage == "analysis"
    InsightRun.objects.filter(id=insight.id).update(
        created_at=timezone.now() - timedelta(minutes=16))
    queued()
    run.refresh_from_db()
    assert run.stage == "finalize"


def test_a_silent_stage_is_resumed_then_interrupted(website, queued):
    quiet = timezone.now() - timedelta(minutes=11)
    run = make_run(website, status="running", stage="engines", heartbeat_at=quiet,
                   started_at=quiet)
    out = queued()
    run.refresh_from_db()
    assert out["resumed"] == 1 and run.resumes == 1
    assert queued.sent == [("run_engines", str(run.id))]
    Run.objects.filter(id=run.id).update(heartbeat_at=quiet, resumes=3)
    out = queued()
    run.refresh_from_db()
    assert out["interrupted"] == 1
    assert (run.status, run.error_code) == ("interrupted", "interrupted")


def test_a_run_silent_past_the_stale_window_is_interrupted(website, queued, settings):
    settings.AUTOPILOT_STALE_MINUTES = 30
    dead = timezone.now() - timedelta(minutes=31)
    run = make_run(website, status="running", stage="google", heartbeat_at=dead,
                   started_at=dead)
    queued()
    run.refresh_from_db()
    assert run.status == "interrupted"


def test_the_views_end_runs_nobody_reports_on(website):
    dead = timezone.now() - timedelta(minutes=45)
    run = make_run(website, status="running", stage="engines", heartbeat_at=dead)
    waiting = make_run(website, local_date=timezone.now().date() - timedelta(days=1),
                       status="queued", stage="plan")
    assert pipeline.sweep_stale(website) == 1
    run.refresh_from_db()
    waiting.refresh_from_db()
    assert run.status == "interrupted" and waiting.status == "queued"


def test_texts_due_go_out_on_the_tick(website, queued):
    due = make_run(website, text_status="waiting", text_due_at=timezone.now(),
                   text_body="x")
    make_run(website, local_date=timezone.now().date() - timedelta(days=1),
             text_status="waiting", text_due_at=timezone.now() + timedelta(hours=1),
             text_body="y")
    out = queued()
    assert out["texts"] == 1
    assert queued.sent == [("deliver_text", str(due.id))]


# -- next_run_at ---------------------------------------------------------------------------


def test_next_run_at(website):
    autopilot = make_autopilot(website, timezone="America/New_York", run_time=time(7, 0))
    before = utc(2026, 11, 4, 11, 0)       # 06:00 local
    assert autopilot_settings.next_run_at(autopilot, website, before) == utc(2026, 11, 4, 12, 0)
    after = utc(2026, 11, 4, 12, 7, 30)    # past 07:00, no run yet: the next tick
    assert autopilot_settings.next_run_at(autopilot, website, after) == utc(2026, 11, 4, 12, 10)
    make_run(website, local_date=datetime(2026, 11, 4).date())
    assert autopilot_settings.next_run_at(autopilot, website, after) == utc(2026, 11, 5, 12, 0)
    autopilot.enabled = False
    assert autopilot_settings.next_run_at(autopilot, website, after) is None


# -- covers() and the guards ----------------------------------------------------------------


def test_covers(website, settings):
    assert autopilot_settings.covers(website) == frozenset()
    autopilot = make_autopilot(website)
    assert autopilot_settings.covers(website) == {"engines", "google"}
    autopilot.run_google = False
    autopilot.save()
    assert autopilot_settings.covers(website) == {"engines"}
    autopilot.run_engines, autopilot.run_google = False, True
    autopilot.save()
    assert autopilot_settings.covers(website) == {"google"}
    autopilot.run_engines = True
    autopilot.paused_reason = "failures"
    autopilot.save()
    assert autopilot_settings.covers(website) == frozenset()
    autopilot.paused_reason, autopilot.enabled = "", False
    autopilot.save()
    assert autopilot_settings.covers(website) == frozenset()
    autopilot.enabled = True
    autopilot.save()
    settings.AUTOPILOT_ENABLED = False
    assert autopilot_settings.covers(website) == frozenset()
    settings.AUTOPILOT_ENABLED = True
    settings.PAYWALL_ENABLED = True
    assert autopilot_settings.covers(website) == frozenset()


@pytest.fixture
def prompt_schedule(website, user, engines, monkeypatch, settings):
    from apps.prompt_library import tasks as prompt_tasks
    from apps.prompt_library.models import PromptSchedule
    from apps.search_gap import tasks as gap_tasks

    engines.enable("claude")
    settings.SCRAPERAPI_KEY = "scraper-test-key"
    bp = make_prompt(website, "best notes app")
    due = timezone.now() - timedelta(minutes=1)
    schedule = PromptSchedule.objects.create(brand_prompt=bp, created_by=user, next_run_at=due,
                                             frequency="daily")
    sent = []
    monkeypatch.setattr(prompt_tasks.crawl_prompt_for_website, "delay",
                        lambda *a: sent.append("crawl"))
    monkeypatch.setattr(gap_tasks.check_google_rank, "delay", lambda *a: sent.append("google"))
    return schedule, sent


@pytest.mark.parametrize(("autopilot", "expected", "advanced"), [
    (None, ["crawl", "google"], True),
    ({"run_engines": True, "run_google": False}, ["google"], True),
    ({"run_engines": False, "run_google": True}, ["crawl"], True),
    ({"run_engines": True, "run_google": True}, [], False),
    ({"enabled": False}, ["crawl", "google"], True),
])
def test_the_prompt_schedule_skips_only_what_autopilot_covers(website, prompt_schedule,
                                                              autopilot, expected, advanced):
    from apps.prompt_library.tasks import dispatch_scheduled_prompt_scans

    schedule, sent = prompt_schedule
    if autopilot is not None:
        make_autopilot(website, **autopilot)
    dispatch_scheduled_prompt_scans()
    schedule.refresh_from_db()
    assert sent == expected
    assert schedule.next_run_at > timezone.now()
    # The success path records a run; a bump does not.
    assert (schedule.last_run_at is not None) is advanced


@pytest.mark.parametrize(("autopilot", "audits"), [
    (None, 1),
    ({"run_engines": True}, 0),
    ({"run_engines": False}, 1),
    ({"paused_reason": "failures"}, 1),
])
def test_the_audit_schedule_skips_when_autopilot_asks_the_engines(website, user, engines,
                                                                 monkeypatch, autopilot, audits):
    from apps.llm_ranking import tasks as llm_tasks
    from apps.llm_ranking.models import LLMRankingAudit, LLMRankingSchedule

    engines.enable("claude")
    make_prompt(website, "best notes app")
    schedule = LLMRankingSchedule.objects.create(
        website=website, created_by=user, business_name="Notion", industry="Notes",
        next_run_at=timezone.now() - timedelta(minutes=1),
    )
    queued_audits = []
    monkeypatch.setattr(llm_tasks.run_llm_ranking_audit, "delay",
                        lambda **kw: queued_audits.append(kw))
    if autopilot is not None:
        make_autopilot(website, **autopilot)
    llm_tasks.dispatch_scheduled_audits()
    schedule.refresh_from_db()
    assert LLMRankingAudit.objects.count() == audits == len(queued_audits)
    assert schedule.next_run_at > timezone.now()


# -- the Celery chain ------------------------------------------------------------------


@pytest.fixture
def celery_chain(settings, django_capture_on_commit_callbacks):
    """Celery mode, tasks run eagerly (the suite's CELERY_TASK_ALWAYS_EAGER),
    one worker per step: other threads cannot see a test transaction."""
    settings.AUTOPILOT_RUN_MODE = "celery"
    settings.AUTOPILOT_PROMPT_CONCURRENCY = 1
    settings.AUTOPILOT_GOOGLE_CONCURRENCY = 1
    return django_capture_on_commit_callbacks


def test_the_celery_chain_runs_every_stage(website, user, engines, serp, analysis,
                                           celery_chain):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    make_prompt(website, "best wiki app")
    make_autopilot(website, google_cadence="daily")
    est = pipeline.run_estimate(website, user)
    with celery_chain(execute=True):
        run = pipeline.create_manual_run(website, user, est["confirm"])
    run.refresh_from_db()
    assert (run.status, run.stage, run.prompts_done) == ("done", "finished", 2)
    assert (run.google_status, run.analysis_status) == ("done", "done")
    assert run.text_body.startswith("Cansee daily, Notion, first run:")


def test_a_waiting_analysis_is_finished_by_the_tick(website, user, engines, analysis,
                                                    celery_chain):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    analysis["status"] = "running"
    est = pipeline.run_estimate(website, user)
    with celery_chain(execute=True):
        run = pipeline.create_manual_run(website, user, est["confirm"])
    run.refresh_from_db()
    assert (run.status, run.stage, run.analysis_status) == ("running", "analysis", "running")
    InsightRun.objects.filter(id=run.analysis_run_id).update(status="done")
    with celery_chain(execute=True):
        out = pipeline.dispatch_tick()
    run.refresh_from_db()
    assert out["finalized"] == 1
    assert (run.status, run.analysis_status) == ("done", "done")
