"""The run, stage by stage (backend 4c): the plan (rotation, limited_by,
the allowance line), the engines through EngineScan (tags on the ledger,
model variants, the reserve stop), Google page one (reuse, both quotas, the
retry), the analysis (created, skipped, the reserve), finalize (statuses,
change, auto-pause) and the text it builds."""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.core.cache import cache
from django.utils import timezone

from apps.accounts.models import AITokenUsage
from apps.autopilot.models import AutopilotRun, AutopilotRunPrompt
from apps.autopilot.services import pipeline
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import (
    BRAND,
    answer,
    failure,
    make_autopilot,
    make_prompt,
    make_run,
    other_answer,
)
from apps.billing.services import tracked_prompts
from apps.billing.services.org_entitlements import prompts_used_this_month
from apps.insights.models import AnswerAnalysis, AnswerClaim, InsightRun
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult
from apps.search_gap.models import GoogleRankCheck

pytestmark = pytest.mark.django_db

Run = AutopilotRun
Row = AutopilotRunPrompt


def run_now(website, user=None) -> Run:
    """Run now, confirmed with its own estimate (inline: every stage runs)."""
    est = pipeline.run_estimate(website, user or website.user)
    assert est["can_run"], est["blockers"]
    run = pipeline.create_manual_run(website, user or website.user, est["confirm"])
    return Run.objects.select_related("analysis_run").get(id=run.id)


def prompts(website, n: int, start: int = 0) -> list:
    base = timezone.now() - timedelta(days=30)
    return [
        make_prompt(website, f"best note taking app number {i}", created_at=base + timedelta(minutes=i))
        for i in range(start, start + n)
    ]


def rows(run) -> list:
    return list(Row.objects.filter(run=run).order_by("position"))


# -- a whole run ------------------------------------------------------------------------


def test_a_run_asks_every_prompt_of_every_engine_then_google_then_texts(
        website, engines, serp, extraction):
    engines.enable("chatgpt", "claude")
    bps = prompts(website, 3)
    serp.positions[bps[0].prompt.text] = 4
    make_autopilot(website, run_google=True, google_cadence="daily")

    run = run_now(website)

    assert (run.status, run.stage, run.trigger) == ("done", "finished", "manual")
    assert (run.prompts_planned, run.prompts_done, run.prompts_failed) == (3, 3, 0)
    assert (run.answers_asked, run.answers_answered, run.answers_named) == (6, 6, 6)
    assert sorted(c["provider"] for c in engines.calls) == ["claude"] * 3 + ["gpt4"] * 3
    # The bare question: no system prompt, no fan-out request.
    assert all(c["system_prompt"] == "" for c in engines.calls)
    assert [r.status for r in rows(run)] == ["done"] * 3
    first = rows(run)[0]
    assert first.engines == {
        "chatgpt": {"asked": 1, "answered": 1, "named": 1, "rank": 1},
        "claude": {"asked": 1, "answered": 1, "named": 1, "rank": 1},
    }
    assert first.audit is not None and first.audit.prompts == [bps[0].prompt.text]
    # Google page one, read once per prompt at depth 10, with no rolling cap.
    assert [c["max_depth"] for c in serp.calls] == [10, 10, 10]
    assert (run.google_status, run.google_checked, run.google_reused) == ("done", 3, 0)
    assert (run.google_measured, run.google_page_one, run.google_pages) == (3, 1, 3)
    assert run.text_template == "E" and run.text_status == "not_requested"
    assert run.text_body.startswith(f"Cansee daily, {BRAND}, first run: 3 prompts, 2 engines.")
    assert "Google page 1: 1/3." in run.text_body
    assert run.text_body.endswith(f"https://cansee.ai/r/{run.link_code} Reply STOP to end")
    summary = pipeline.run_summary(run)
    assert summary["google"]["credits"] == 75
    assert summary["answers"]["share_pct"] == 100.0
    assert summary["analysis"]["status"] == "skipped"


def test_engine_scan_tags_reach_the_ledger_and_make_the_run_cost(website, engines):
    engines.enable("chatgpt", "claude")
    prompts(website, 2)
    run = run_now(website)

    usage = list(AITokenUsage.objects.filter(metadata__autopilot_run=str(run.id)))
    assert len(usage) == 4
    audits = {str(r.audit_id) for r in rows(run)}
    for row in usage:
        assert row.metadata["feature"] == "autopilot"
        assert row.metadata["actor"] == "system"
        assert row.metadata["audit_id"] in audits
        assert row.user_id == website.user_id and row.module == "prompt_library"
    total = sum(u.estimated_cost_usd for u in usage)
    assert run.ai_cost_usd == total > 0
    assert pipeline.run_summary(run)["cost"]["ai_usd"] == str(total.quantize(Decimal("0.0001")))
    # Spend outside the run is not its cost.
    AITokenUsage.objects.create(user=website.user, module="llm_ranking", model_name="x",
                                estimated_cost_usd=Decimal("5"), metadata={"audit_id": "other"})
    assert pipeline.ledger_cost(run) == total


def test_autopilot_audits_are_left_out_of_prompts_used_this_month(website, engines):
    engines.enable("claude")
    prompts(website, 2)
    LLMRankingAudit.objects.create(
        website=website, created_by=website.user, business_name=BRAND,
        prompts=["one manual prompt"], providers_queried=["claude"],
    )
    run_now(website)
    assert LLMRankingAudit.objects.filter(created_by=website.user).count() == 3
    assert LLMRankingAudit.objects.filter(autopilot_rows__isnull=False).count() == 2
    assert prompts_used_this_month(website.user) == 1


def test_model_variants_are_honoured(website, engines):
    engines.enable("chatgpt", "claude")
    make_prompt(website, "best wiki app", variants=["claude:claude-opus-5", "gemini:gemini-2.5-flash"])
    run = run_now(website)
    assert [(c["provider"], c["model"]) for c in engines.calls] == [("claude", "claude-opus-5")]
    assert rows(run)[0].engines == {"claude": {"asked": 1, "answered": 1, "named": 1, "rank": 1}}


def test_failed_engines_and_a_prompt_with_no_answer(website, engines):
    engines.enable("chatgpt", "claude")
    a, b = prompts(website, 2)
    # Prompt a: ChatGPT fails twice (one retry); prompt b: both fail.
    engines.script("chatgpt", failure("busy"), failure("busy"), failure("busy"), failure("busy"))
    engines.script("claude", answer(f"1. {BRAND}"), failure("busy"), failure("busy"))
    run = run_now(website)
    assert [r.status for r in rows(run)] == ["done", "failed"]
    assert rows(run)[1].error_code == "engine_error"
    assert (run.answers_asked, run.answers_answered) == (4, 1)
    assert run.status == "partial"


def test_a_run_where_no_engine_answers_fails_and_three_pause_autopilot(website, engines):
    engines.enable("claude")
    prompts(website, 1)
    autopilot = make_autopilot(website)
    engines.default = lambda: failure("upstream down")
    today = timezone.now().date()
    for day in range(3):
        if day:
            Run.objects.filter(local_date=today).update(local_date=today - timedelta(days=day))
        run = run_now(website)
        assert run.status == "failed" and run.error_code == "no_answers"
        assert run.error_message == "No engine answered."
        autopilot.refresh_from_db()
        assert autopilot.consecutive_failures == day + 1
    assert (autopilot.enabled, autopilot.paused_reason) == (False, "failures")
    assert run.text_template == "C" and run.plan.get("paused") is True
    assert "Autopilot is paused after 3 failed runs." in run.text_body
    assert "No engine answered (1 error)." in run.text_body
    # A good run resets the count (the failures opened the engine's breaker).
    cache.clear()
    engines.default = lambda: answer(f"1. {BRAND}")
    Run.objects.filter(local_date=today).update(local_date=today - timedelta(days=9))
    autopilot.enabled = True
    autopilot.save()
    assert run_now(website).status == "done"
    autopilot.refresh_from_db()
    assert autopilot.consecutive_failures == 0


# -- the plan ---------------------------------------------------------------------------


def test_nothing_tracked_and_no_engine_are_blockers(website, engines):
    est = pipeline.run_estimate(website, website.user)
    assert est["blockers"] == [{"code": "nothing_to_run", "message": "Track a prompt first."}]
    prompts(website, 1)
    est = pipeline.run_estimate(website, website.user)
    assert est["blockers"] == [{"code": "not_configured",
                                "message": "AI engines aren't available yet."}]
    assert est["can_run"] is False


def test_the_estimate(website, engines, serp):
    engines.enable("chatgpt", "claude")
    prompts(website, 9)
    est = pipeline.run_estimate(website, website.user)
    assert est == {
        "prompts": 9, "over_limit": 0, "limited_by": None,
        "engines": [{"key": "chatgpt", "label": "ChatGPT"}, {"key": "claude", "label": "Claude"}],
        "answers_max": 18, "usd_max": "0.5400", "usd_expected": None,
        "pages_max": 9, "credits_max": 225,
        "allowance": {"unlimited": False, "cap_usd": "1.00", "left_usd": "1.00",
                      "reserve_pct": 10, "usable_usd": "0.90"},
        "blockers": [], "can_run": True,
        "confirm": {"answers": 18, "ai_usd_max": "0.5400", "google_pages": 9},
    }


def test_the_expected_cost_comes_from_a_measured_run_of_five_prompts(website, engines):
    engines.enable("claude")
    prompts(website, 6)
    make_run(website, local_date=timezone.now().date() - timedelta(days=1),
             prompts_done=4, ai_cost_usd=Decimal("0.40"))
    assert pipeline.run_estimate(website, website.user)["usd_expected"] is None
    make_run(website, local_date=timezone.now().date() - timedelta(days=2),
             created_at=timezone.now() + timedelta(seconds=1),
             prompts_done=5, ai_cost_usd=Decimal("0.50"))
    assert pipeline.run_estimate(website, website.user)["usd_expected"] == "0.6000"


def test_the_allowance_fits_part_of_the_prompts_and_rotation_moves_on(website, engines, user):
    engines.enable("chatgpt", "claude")
    bps = prompts(website, 5)
    user.monthly_ai_cost_cap_usd = Decimal("0.15")   # line 0.135: two prompts at 0.06
    user.save()
    autopilot = make_autopilot(website, prompt_offset=4)
    est = pipeline.run_estimate(website, user)
    assert (est["prompts"], est["limited_by"], est["answers_max"]) == (2, "allowance", 4)
    assert est["allowance"]["usable_usd"] == "0.13"

    run = run_now(website)
    asked = [r.brand_prompt_id for r in rows(run) if r.status == "done"]
    # Starts at the offset and wraps around.
    assert asked == [bps[0].id, bps[4].id] or set(asked) == {bps[4].id, bps[0].id}
    skipped = [r for r in rows(run) if r.status == "skipped"]
    assert {r.error_code for r in skipped} == {"reserve_reached"} and len(skipped) == 3
    assert run.status == "partial" and run.plan["limited_by"] == "allowance"
    autopilot.refresh_from_db()
    assert autopilot.prompt_offset == 1
    assert run.text_template == "E"


def test_a_used_up_allowance_skips_the_run_with_the_d_text(website, engines, user, settings):
    engines.enable("claude")
    prompts(website, 2)
    AITokenUsage.objects.create(user=user, module="llm_ranking", model_name="x",
                                estimated_cost_usd=Decimal("1.00"), metadata={})
    est = pipeline.run_estimate(website, user)
    assert est["blockers"] == [{"code": "allowance_exceeded",
                                "message": "You have used your monthly AI allowance."}]
    run = Run.objects.create(website=website, local_date=timezone.now().date(),
                             status="running", started_at=timezone.now())
    pipeline.drive(run.id)
    run.refresh_from_db()
    assert (run.status, run.error_code) == ("skipped", "allowance_exceeded")
    assert run.text_template == "D" and engines.calls == []
    assert run.text_body.startswith(f"Cansee daily, {BRAND}: skipped today. Your $1.00 AI "
                                    "allowance for this month is used up. Runs resume ")


def test_the_reserve_line_skips_with_its_own_words(website, engines, user):
    engines.enable("claude")
    prompts(website, 2)
    AITokenUsage.objects.create(user=user, module="llm_ranking", model_name="x",
                                estimated_cost_usd=Decimal("0.95"), metadata={})
    est = pipeline.run_estimate(website, user)
    assert est["blockers"][0]["code"] == "reserve_reached"
    assert est["blockers"][0]["message"].startswith(
        "Autopilot keeps the last 10% of your AI allowance for your own questions. Runs resume "
    )
    run = Run.objects.create(website=website, local_date=timezone.now().date(),
                             status="running", started_at=timezone.now())
    pipeline.drive(run.id)
    run.refresh_from_db()
    assert (run.status, run.error_code, run.text_template) == ("skipped", "reserve_reached", "D")
    assert ": paused. 90% of your $1.00 AI allowance is used; the rest is kept for your own " \
           "questions. Runs resume" in run.text_body


def test_the_engines_step_stops_at_the_line(website, engines, user):
    engines.enable("claude")
    prompts(website, 4)
    # Each answer costs about $0.50 at the default price: the line ($0.90)
    # passes after the second prompt.
    engines.default = _expensive
    run = run_now(website)
    statuses = [r.status for r in rows(run)]
    assert statuses[:2] == ["done", "done"]
    assert statuses[2:] == ["skipped", "skipped"]
    assert {r.error_code for r in rows(run)[2:]} == {"reserve_reached"}
    assert run.status == "partial"
    assert "allowance reserve reached" not in run.text_body  # template E for a first run


def _expensive():
    from core.llm.base import ProviderResult

    return ProviderResult(succeeded=True, text=f"1. {BRAND}", input_tokens=50_000,
                          output_tokens=23_000)


def test_over_the_cap_runs_the_oldest_prompts(website, engines, monkeypatch):
    engines.enable("claude")
    bps = prompts(website, 4)
    monkeypatch.setattr(tracked_prompts, "limit_for", lambda user: 2)
    est = pipeline.run_estimate(website, website.user)
    assert (est["prompts"], est["over_limit"]) == (2, 2)
    run = run_now(website)
    assert [r.brand_prompt_id for r in rows(run)] == [bps[0].id, bps[1].id]
    assert run.over_limit == 2 and pipeline.run_summary(run)["prompts"]["over_limit"] == 2


def test_engines_off_runs_google_only(website, engines, serp):
    engines.enable("claude")
    prompts(website, 2)
    make_autopilot(website, run_engines=False, google_cadence="daily")
    run = run_now(website)
    assert engines.calls == [] and len(serp.calls) == 2
    assert (run.status, run.google_status, run.answers_asked) == ("done", "done", 0)
    assert {r.status for r in rows(run)} == {"skipped"}
    assert run.text_template == "C"
    assert "no AI answers today. AI engines are off in Autopilot. Google page 1: 0/2." \
           in run.text_body


# -- Google -----------------------------------------------------------------------------


def _check(bp, *, hours_ago: float, error: str = "", position=None):
    return GoogleRankCheck.objects.create(
        website=bp.website, brand_prompt=bp, query=bp.prompt.text, depth=10,
        position=position, error=error,
        checked_at=timezone.now() - timedelta(hours=hours_ago),
    )


def test_weekly_cadence_reuses_a_recent_check(website, engines, serp):
    engines.enable("claude")
    a, b, c = prompts(website, 3)
    reused = _check(a, hours_ago=100, position=3)
    _check(b, hours_ago=170, position=2)          # older than the weekly window
    _check(c, hours_ago=1, error="http_429")      # a failed check is never reused
    make_autopilot(website, google_cadence="weekly")
    run = run_now(website)
    assert [call["query"] for call in serp.calls] == [b.prompt.text, c.prompt.text]
    first = rows(run)[0]
    assert (first.google_status, first.google_check_id, first.google_pages) == (
        "reused", reused.id, 0)
    assert (run.google_checked, run.google_reused, run.google_page_one) == (2, 1, 1)
    assert run.google_pages == 2
    assert "Google page 1 (this week): 1/3." in run.text_body


def test_daily_cadence_rechecks_a_day_old_check(website, engines, serp):
    engines.enable("claude")
    (a,) = prompts(website, 1)
    _check(a, hours_ago=21, position=3)
    make_autopilot(website, google_cadence="daily")
    run_now(website)
    assert len(serp.calls) == 1


def test_both_page_quotas_bound_the_google_step(website, engines, serp, settings):
    engines.enable("claude")
    prompts(website, 3)
    settings.AUTOPILOT_GOOGLE_PAGES_PER_PROJECT = 2
    make_autopilot(website, google_cadence="daily")
    run = run_now(website)
    assert [r.google_status for r in rows(run)] == ["checked", "checked", "skipped"]
    assert (run.google_status, run.status) == ("partial", "partial")
    assert "Google page 1: 0/2." in run.text_body

    cache.clear()
    GoogleRankCheck.objects.all().delete()
    settings.AUTOPILOT_GOOGLE_PAGES_PER_PROJECT = 200
    settings.AUTOPILOT_GOOGLE_PAGES_PER_DAY = 1
    other = Run.objects.create(website=website, local_date=timezone.now().date() - timedelta(days=1),
                               status="running", started_at=timezone.now())
    pipeline.drive(other.id)
    other.refresh_from_db()
    assert [r.google_status for r in rows(other)] == ["checked", "skipped", "skipped"]
    # A refused deployment page gives the project's unit back.
    assert pipeline._quotas()[0].remaining(str(website.id)) == 199


def test_nothing_google_checked_reads_not_checked(website, engines, serp, settings):
    engines.enable("claude")
    prompts(website, 2)
    settings.AUTOPILOT_GOOGLE_PAGES_PER_PROJECT = 0
    make_autopilot(website, google_cadence="daily")
    run = run_now(website)
    assert (run.google_status, run.google_measured) == ("skipped", 0)
    assert "Google not checked." in run.text_body


def test_a_transient_google_error_is_retried_once_with_its_own_units(website, engines, serp,
                                                                       settings):
    engines.enable("claude")
    a, b, c = prompts(website, 3)
    serp.errors[a.prompt.text] = ["http_429"]
    serp.errors[b.prompt.text] = ["network", "empty_results"]
    serp.errors[c.prompt.text] = ["http_403"]
    make_autopilot(website, google_cadence="daily")
    run = run_now(website)
    assert [r.google_status for r in rows(run)] == ["checked", "failed", "failed"]
    queries = [call["query"] for call in serp.calls]
    assert queries.count(a.prompt.text) == 2 and queries.count(b.prompt.text) == 2
    assert queries.count(c.prompt.text) == 1
    assert pipeline._quotas()[0].remaining(str(website.id)) == 200 - 5
    assert run.google_status == "partial"


# -- analysis ---------------------------------------------------------------------------


def test_the_analysis_runs_over_the_new_named_answers(website, engines, analysis):
    engines.enable("claude")
    prompts(website, 2)
    run = run_now(website)
    kinds = [call[0] for call in analysis["calls"]]
    assert kinds == ["estimate", "create"]
    _kind, name, params, owner = analysis["calls"][0]
    assert (name, params, owner) == ("answer_analysis",
                                     {"period": "7d", "autopilot_run": str(run.id)}, website.user)
    assert analysis["calls"][1][3] == {"ai_calls": 2, "ai_usd_max": "0.0100", "google_pages": 0}
    assert run.analysis_run is not None and run.analysis_status == "done"
    assert run.new_contradicted == 0
    assert pipeline.run_summary(run)["analysis"] == {
        "status": "done", "answers": 3, "new_contradicted": 0}


def test_new_contradicted_counts_only_claims_not_seen_before(website, engines, analysis,
                                                            monkeypatch):
    engines.enable("claude")
    (bp,) = prompts(website, 1)
    earlier = InsightRun.objects.create(website=website, kind="answer_analysis", status="done")
    result = LLMRankingResult.objects.create(
        audit=LLMRankingAudit.objects.create(website=website, created_by=website.user,
                                             business_name=BRAND, prompts=["x"]),
        provider="claude", prompt="x",
    )

    def claim(run, key):
        found = AnswerAnalysis.objects.create(
            website=website, result=result, run=run, version=f"t{AnswerAnalysis.objects.count()}",
            status="done", engine="claude", answered_at=timezone.now(),
        )
        AnswerClaim.objects.create(analysis=found, website=website, engine="claude",
                                   answered_at=timezone.now(), text="claim", text_key=key,
                                   topic="pricing", quote="q", verdict="contradicted")

    claim(earlier, "old")

    def create_run(website_, user, kind, params, confirm):
        insight = InsightRun.objects.create(website=website_, created_by=user, kind=kind,
                                            status="done", params=params, units_total=2)
        claim(insight, "old")
        claim(insight, "new")
        claim(insight, "new")
        return insight

    from apps.insights.services import runs as insights_runs

    monkeypatch.setattr(insights_runs, "create_run", create_run)
    run = run_now(website)
    assert run.new_contradicted == 1


def test_analysis_skipped_when_it_would_pass_the_line(website, engines, analysis):
    engines.enable("claude")
    prompts(website, 1)
    analysis["usd_max"] = "0.9000"
    run = run_now(website)
    assert [call[0] for call in analysis["calls"]] == ["estimate"]
    assert run.analysis_status == "skipped" and run.plan["analysis_skip"] == "reserve_reached"


def test_analysis_skipped_by_its_blocker_and_when_off(website, engines, analysis):
    engines.enable("claude")
    prompts(website, 1)
    analysis["can_run"] = False
    analysis["blockers"] = [{"code": "nothing_to_run", "message": "..."}]
    run = run_now(website)
    assert (run.analysis_status, run.plan["analysis_skip"]) == ("skipped", "nothing_to_run")
    Run.objects.update(local_date=timezone.now().date() - timedelta(days=1))
    make_autopilot(website, run_analysis=False)
    run = run_now(website)
    assert run.analysis_status == "off" and pipeline.run_summary(run)["analysis"]["answers"] is None


def test_no_named_answer_means_no_analysis(website, engines, analysis):
    engines.enable("claude")
    prompts(website, 1)
    engines.default = other_answer
    run = run_now(website)
    assert run.analysis_status == "skipped" and analysis["calls"] == []
    assert "Claims" not in run.text_body


def test_a_pending_analysis_waits_then_the_text_says_pending(website, engines, analysis,
                                                            settings):
    engines.enable("claude")
    prompts(website, 1)
    make_run(website, local_date=timezone.now().date() - timedelta(days=1),
             created_at=timezone.now() - timedelta(days=1), answers_answered=1,
             answers_named=1, prompts_done=1, prompts_planned=1)
    settings.AUTOPILOT_ANALYSIS_WAIT_MINUTES = 0
    analysis["status"] = "running"
    run = run_now(website)
    assert run.analysis_status == "pending" and run.new_contradicted is None
    assert run.text_template == "A" and "Claims pending." in run.text_body


# -- finalize ------------------------------------------------------------------------------


def test_change_compares_the_pairs_answered_in_both_runs(website, engines):
    engines.enable("chatgpt", "claude")
    a, b = prompts(website, 2)
    yesterday = make_run(website, local_date=timezone.now().date() - timedelta(days=1),
                         created_at=timezone.now() - timedelta(days=1), answers_answered=4,
                         answers_named=1, prompts_done=2, prompts_planned=2)
    Row.objects.create(run=yesterday, brand_prompt=a, status="done", engines={
        "chatgpt": {"asked": 1, "answered": 1, "named": 0},
        "claude": {"asked": 1, "answered": 1, "named": 1},
    })
    # Only in yesterday's run: not compared.
    Row.objects.create(run=yesterday, brand_prompt=b, status="done", engines={
        "gemini": {"asked": 1, "answered": 1, "named": 0},
    })
    run = run_now(website)
    # Today both engines name the brand for prompt a: 100% against 50%.
    assert run.change_pts == 50.0
    assert run.text_template == "A" and ", up 50 pts." in run.text_body
    assert pipeline.change_pts(run, None) is None


def test_a_first_run_has_no_change(website, engines):
    engines.enable("claude")
    prompts(website, 1)
    run = run_now(website)
    assert run.change_pts is None and run.text_template == "E"
    assert pipeline.run_summary(run)["change_pts"] is None


def test_stop_ends_a_queued_run_without_a_text(website, engines, settings):
    engines.enable("claude")
    prompts(website, 1)
    settings.AUTOPILOT_MAX_ACTIVE_RUNS = 1
    Run.objects.create(website=website, local_date=timezone.now().date() - timedelta(days=5),
                       status="running", stage="engines", heartbeat_at=timezone.now())
    est = pipeline.run_estimate(website, website.user)
    run = pipeline.create_manual_run(website, website.user, est["confirm"])
    assert run.status == "queued"
    run = pipeline.cancel_run(run)
    assert run.status == "cancelled"
    assert (run.text_status, run.text_reason) == ("skipped", "cancelled")
    assert engines.calls == []


def test_a_stopped_running_run_asks_no_further_prompt(website, engines):
    engines.enable("claude")
    prompts(website, 3)
    run = Run.objects.create(website=website, local_date=timezone.now().date(),
                             status="running", started_at=timezone.now())
    pipeline.start_run(run.id)
    calls = []

    def stop_after_first(call):
        calls.append(call)
        Run.objects.filter(id=run.id).update(cancel_requested=True)
        return answer(f"1. {BRAND}")

    engines.default = lambda: stop_after_first
    pipeline.drive(run.id)
    run.refresh_from_db()
    assert len(calls) == 1
    assert run.status == "cancelled" and run.text_status == "skipped"
    assert [r.status for r in rows(run)] == ["done", "skipped", "skipped"]
    assert {r.error_code for r in rows(run)[1:]} == {"cancelled"}


def test_a_crashed_row_is_given_back_once_then_fails(website, engines):
    engines.enable("claude")
    a, b = prompts(website, 2)
    run = Run.objects.create(website=website, local_date=timezone.now().date(),
                             status="running", started_at=timezone.now())
    pipeline.start_run(run.id)
    old = timezone.now() - timedelta(minutes=11)
    Row.objects.filter(run=run, brand_prompt=a).update(status="running", started_at=old,
                                                       attempts=1)
    Row.objects.filter(run=run, brand_prompt=b).update(status="running", started_at=old,
                                                       attempts=2)
    pipeline.drive(run.id)
    run.refresh_from_db()
    assert [r.status for r in rows(run)] == ["done", "failed"]
    assert rows(run)[1].error_code == "interrupted"
    assert run.status == "partial"


def test_interrupted_runs_end_with_their_text(website, engines):
    engines.enable("claude")
    prompts(website, 2)
    run = Run.objects.create(website=website, local_date=timezone.now().date(),
                             status="running", started_at=timezone.now())
    pipeline.start_run(run.id)
    pipeline.finalize_run(run.id, interrupted=True)
    run.refresh_from_db()
    assert (run.status, run.error_code) == ("interrupted", "interrupted")
    assert {r.status for r in rows(run)} == {"failed"}
    assert run.text_template == "C" and "The run stopped early." in run.text_body
