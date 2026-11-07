"""Ask AI runs: create, ask, stop, finish, sweep (contract 4, backend 3b)."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.llm_ranking.services.ranking_service import wilson_ci
from apps.prompt_box import tasks
from apps.prompt_box.models import PromptBoxAnswer, PromptBoxRun
from apps.prompt_box.services import runs
from apps.prompt_box.tests.support import *  # noqa: F403
from apps.prompt_box.tests.support import (
    BRAND,
    QUESTION,
    answer,
    body,
    confirm_of,
    failure,
    ledger_rows,
    make_prompt,
    named,
    unnamed,
)
from core.exceptions import CanseeException

pytestmark = pytest.mark.django_db


def ask(website, user, data=None) -> PromptBoxRun:
    data = data or body()
    return runs.create_run(website, user, data, confirm_of(runs.estimate(website, user, data)))


def _raises(fn, *args) -> CanseeException:
    with pytest.raises(CanseeException) as exc:
        fn(*args)
    return exc.value


def _pct(value: float) -> float:
    return round(value * 100, 1)


def test_a_run_asks_every_engine_bare_and_interleaved(website, user, engines, extraction):
    engines.enable("chatgpt", "claude")
    engines.script("claude", named(2), named(1), unnamed())
    run = ask(website, user)

    assert run.status == "done"
    assert [c["provider"] for c in engines.calls] == ["gpt4", "claude"] * 3
    assert {c["prompt"] for c in engines.calls} == {QUESTION}
    assert {c["system_prompt"] for c in engines.calls} == {""}
    assert (run.answers_total, run.answers_done, run.answers_failed) == (6, 6, 0)
    assert {k["brand_name"] for k in extraction.calls} == {BRAND}
    assert {k["audit_id"] for k in extraction.calls} == {f"prompt-box:{run.id}"}

    payload = runs.run_payload(run)
    chatgpt, claude = payload["engines"]
    low, high = wilson_ci(0, 3)
    assert {k: v for k, v in chatgpt.items() if k != "answers"} == {
        "key": "chatgpt", "label": "ChatGPT", "asked": 3, "answered": 3, "named": 0,
        "share_pct": 0.0, "share_low_pct": _pct(low), "share_high_pct": _pct(high),
        "avg_rank": None,
    }
    assert (claude["named"], claude["share_pct"], claude["avg_rank"]) == (2, 66.7, 1.5)
    first = claude["answers"][0]
    assert {k: v for k, v in first.items() if k != "id"} == {
        "sample": 1, "status": "done", "mentioned": True, "rank": 2, "sentiment": "positive",
        "excerpt": "Northwind CRM - for small teams.",
        "brands": [{"name": "Acme CRM", "position": 1}, {"name": "Contoso CRM", "position": 3},
                   {"name": "Fabrikam CRM", "position": 4}],
        "citations": 0, "error": None,
    }
    last = claude["answers"][2]
    assert (last["mentioned"], last["rank"], last["sentiment"]) == (False, None, None)
    assert last["excerpt"] == "1. Acme CRM - pipelines.\n2. Contoso CRM - small teams."
    assert "answer_text" not in last
    assert payload["progress"] == {"total": 6, "done": 6, "failed": 0, "running": 0}
    assert (payload["samples"], payload["status"], payload["text"]) == (3, "done", QUESTION)
    assert payload["error"] is None
    assert runs.daily_quota().remaining(str(website.id)) == 94


def test_the_contract_range_for_two_of_two(website, user, engines, extraction):
    engines.enable("claude")
    engines.script("claude", named(1), named(2))
    claude = runs.run_payload(ask(website, user, body(samples=2)))["engines"][0]
    assert (claude["share_pct"], claude["share_low_pct"], claude["share_high_pct"],
            claude["avg_rank"]) == (100.0, 34.2, 100.0, 1.5)


def test_answers_and_extractions_are_tagged_and_priced_from_the_ledger(
        website, user, engines, extraction):
    engines.enable("chatgpt")
    run = ask(website, user)
    rows = list(ledger_rows(run))
    answers = [r for r in rows if r.metadata.get("role") == "prompt_box"]
    assert len(answers) == 3 and len(rows) == 6
    assert all(r.metadata["actor"] == "user" and r.metadata["feature"] == "prompt_box"
               for r in answers)
    assert all(r.user_id == user.id and r.module == "llm_ranking" for r in rows)
    total = sum(r.estimated_cost_usd for r in rows)
    assert total > 0 and run.ai_cost_usd == total
    assert runs.run_payload(run)["cost"] == {"ai_usd": runs.usd4(total)}


def test_an_empty_or_failed_answer_is_never_not_named(website, user, engines, extraction):
    engines.enable("chatgpt", "claude")
    engines.script("chatgpt", answer(""), failure("refusal: no", billed=True), named(1))
    engines.script("claude", failure("refusal: no", billed=True),
                   failure("rate limit exceeded"), failure("rate limit exceeded"),
                   failure("Request timed out"), failure("Request timed out"))
    run = ask(website, user)
    assert run.status == "partial"

    chatgpt, claude = runs.run_payload(run)["engines"]
    assert (chatgpt["asked"], chatgpt["answered"], chatgpt["named"]) == (3, 1, 1)
    assert [a["status"] for a in chatgpt["answers"]] == ["failed", "failed", "done"]
    assert chatgpt["answers"][0]["mentioned"] is None
    assert chatgpt["answers"][0]["error"] == {
        "code": "engine_error", "message": "The engine returned an error."}
    assert chatgpt["answers"][1]["error"] == {
        "code": "refused", "message": "The engine declined to answer this prompt."}
    low, _ = wilson_ci(1, 1)
    assert (chatgpt["share_pct"], chatgpt["share_low_pct"], chatgpt["share_high_pct"]) == (
        100.0, _pct(low), 100.0)
    # No answer came back: every share is null, not 0.
    assert (claude["asked"], claude["answered"], claude["named"]) == (3, 0, 0)
    assert (claude["share_pct"], claude["share_low_pct"], claude["share_high_pct"],
            claude["avg_rank"]) == (None, None, None, None)
    assert [a["error"]["code"] for a in claude["answers"]] == ["refused", "rate_limited", "timeout"]
    assert {a["mentioned"] for a in claude["answers"]} == {None}
    assert runs.run_payload(run)["progress"] == {"total": 6, "done": 1, "failed": 5, "running": 0}


def test_a_run_with_no_answer_fails_with_the_most_common_error(website, user, engines, extraction):
    engines.enable("chatgpt")
    engines.script("chatgpt", answer(""), answer(""), failure("refusal: no", billed=True))
    run = ask(website, user)
    assert run.status == "failed"
    assert runs.run_payload(run)["error"] == {
        "code": "engine_error", "message": "The engine returned an error."}


def test_a_lower_confirm_is_estimate_changed(website, user, engines, extraction):
    engines.enable("chatgpt")
    exc = _raises(runs.create_run, website, user, body(), {"answers": 3, "ai_usd_max": "0.0500"})
    assert (exc.code, exc.status_code) == ("estimate_changed", 409)
    assert exc.message == "The cost changed. Check the new estimate and confirm again."
    assert exc.details["estimate"]["confirm"] == {"answers": 3, "ai_usd_max": "0.0900"}
    exc = _raises(runs.create_run, website, user, body(), {"answers": 2, "ai_usd_max": "0.0900"})
    assert exc.code == "estimate_changed"
    for confirm in (None, {}, {"answers": True, "ai_usd_max": "1"}, {"answers": 3},
                    {"answers": 3, "ai_usd_max": "lots"}, {"answers": 3, "ai_usd_max": "-1"}):
        exc = _raises(runs.create_run, website, user, body(), confirm)
        assert (exc.code, exc.message) == ("invalid", "Confirm the estimate before running.")
    assert PromptBoxRun.objects.count() == 0
    # Confirming more than needed is fine: the bound is what may be spent.
    run = runs.create_run(website, user, body(), {"answers": 10, "ai_usd_max": "1.0000"})
    assert run.status == "done"


def test_create_raises_the_first_blocker(website, user, engines, extraction, settings,
                                         monkeypatch):
    exc = _raises(runs.create_run, website, user, body(), {"answers": 0, "ai_usd_max": "0"})
    assert (exc.code, exc.status_code, exc.message) == (
        "not_configured", 400, "AI engines aren't available yet.")
    engines.enable("chatgpt")
    settings.PROMPT_BOX_DAILY_ANSWERS = 2
    exc = _raises(runs.create_run, website, user, body(), {"answers": 3, "ai_usd_max": "1"})
    assert (exc.code, exc.status_code, exc.details) == ("daily_limit", 409, {"left": 2, "need": 3})
    settings.PROMPT_BOX_DAILY_ANSWERS = 100
    monkeypatch.setattr("core.ai_tracking.month_to_date_cost", lambda u: 1.0)
    exc = _raises(runs.create_run, website, user, body(), {"answers": 3, "ai_usd_max": "1"})
    assert (exc.code, exc.status_code) == ("allowance_exceeded", 403)
    assert PromptBoxRun.objects.count() == 0


def test_one_question_at_a_time(website, user, engines, extraction):
    engines.enable("chatgpt")
    current = PromptBoxRun.objects.create(website=website, text="earlier", samples=1,
                                          engines=["chatgpt"], status="running")
    exc = _raises(runs.create_run, website, user, body(), {"answers": 3, "ai_usd_max": "1"})
    assert (exc.code, exc.status_code, exc.details) == (
        "run_in_progress", 409, {"run_id": str(current.id)})
    current.status = "done"
    current.save(update_fields=["status"])
    assert ask(website, user).status == "done"


def test_stop_ends_the_remaining_answers(website, user, engines, extraction):
    engines.enable("chatgpt")

    def stop(call):
        PromptBoxRun.objects.update(cancel_requested=True)
        return named(1)

    engines.script("chatgpt", stop)
    run = ask(website, user, body(samples=4))
    assert run.status == "cancelled"
    assert list(run.answers.order_by("sample").values_list("status", "error_code")) == [
        ("done", ""), ("cancelled", "cancelled"), ("cancelled", "cancelled"),
        ("cancelled", "cancelled")]
    assert len(engines.calls) == 1
    # Stopped answers took no daily unit.
    assert runs.daily_quota().remaining(str(website.id)) == 99


def test_stopping_a_queued_run_ends_it_at_once(website, user, engines, settings):
    engines.enable("chatgpt")
    settings.PROMPT_BOX_RUN_MODE = "thread"  # dispatch waits for a commit that never comes
    run = ask(website, user)
    assert run.status == "queued"
    run = runs.cancel_run(run)
    assert run.status == "cancelled"
    assert set(run.answers.values_list("status", flat=True)) == {"cancelled"}
    assert runs.cancel_run(run).status == "cancelled"
    assert engines.calls == []


def test_each_answer_takes_a_daily_unit_first(website, user, engines, extraction, settings):
    engines.enable("chatgpt")
    settings.PROMPT_BOX_DAILY_ANSWERS = 4

    def another_tab_spends_two(call):
        runs.daily_quota().consume(str(website.id), 2)
        return named(1)

    engines.script("chatgpt", another_tab_spends_two)
    run = ask(website, user)
    assert list(run.answers.order_by("sample").values_list("status", "error_code")) == [
        ("done", ""), ("done", ""), ("skipped", "daily_limit")]
    assert run.status == "partial"
    skipped = runs.run_payload(run)["engines"][0]["answers"][2]
    assert skipped["error"] == {"code": "daily_limit",
                                "message": "This project used its Ask AI answers for today."}
    assert len(engines.calls) == 2


def test_grounded_gemini_links_are_not_kept(website, user, engines, extraction, settings,
                                           monkeypatch):
    engines.enable("chatgpt", "gemini")
    settings.LLM_WEBSEARCH_ENABLED = True
    monkeypatch.setattr("core.ai_tracking.effective_ai_cap", lambda u: 50.0)
    engines.script("gemini", answer("1. Northwind CRM - best.", citations=["https://a.example/x"]))
    engines.script("chatgpt", answer("1. Northwind CRM - best.",
                                     citations=["https://b.example/y"], queries=["crm  for plumbers"]))
    run = ask(website, user, body(samples=1))
    rows = {a.engine: a for a in run.answers.all()}
    assert rows["gemini"].citations == []
    assert rows["chatgpt"].citations == ["https://b.example/y"]
    assert (rows["chatgpt"].search_queries, rows["chatgpt"].web_searches) == (["crm for plumbers"], 1)
    assert (rows["gemini"].search_queries, rows["gemini"].web_searches) == (None, None)

    full = runs.run_payload(run, full=True)
    chatgpt = next(e for e in full["engines"] if e["key"] == "chatgpt")["answers"][0]
    assert (chatgpt["citations"], chatgpt["citation_urls"]) == (1, ["https://b.example/y"])
    assert chatgpt["search_queries"] == ["crm for plumbers"]
    assert chatgpt["answer_text"] == "1. Northwind CRM - best."


def test_tracked_follows_the_project(website, user, engines, extraction):
    engines.enable("chatgpt")
    run = ask(website, user)
    assert runs.run_payload(run)["tracked"] == {"prompt_id": None, "brand_prompt_id": None}
    bp = make_prompt(website, QUESTION)
    assert runs.run_payload(run)["tracked"] == {
        "prompt_id": str(bp.prompt_id), "brand_prompt_id": str(bp.id)}


def test_a_run_that_stopped_reporting_is_interrupted(website, user):
    stale = PromptBoxRun.objects.create(website=website, text=QUESTION, samples=1,
                                        engines=["chatgpt"], status="running")
    PromptBoxAnswer.objects.create(run=stale, engine="chatgpt", provider="gpt4", sample=1,
                                   status="running")
    alive = PromptBoxRun.objects.create(website=website, text="still going", samples=1,
                                        engines=["chatgpt"], status="running",
                                        heartbeat_at=timezone.now())
    old = timezone.now() - timedelta(minutes=11)
    PromptBoxRun.objects.filter(id=stale.id).update(created_at=old, started_at=old, heartbeat_at=old)

    assert runs.sweep_stale(website) == 1
    stale.refresh_from_db()
    assert (stale.status, stale.error_code, stale.error_message) == (
        "interrupted", "interrupted", "The run stopped before it finished.")
    assert stale.answers.get().error_code == "interrupted"
    assert (stale.answers_total, stale.answers_failed) == (1, 1)
    alive.refresh_from_db()
    assert alive.status == "running"


def test_dispatch_queues_on_the_ai_queue_or_fails_the_run(website, user, engines, settings,
                                                          monkeypatch):
    engines.enable("chatgpt")
    settings.PROMPT_BOX_RUN_MODE = "celery"
    run = ask(website, user)
    sent = []
    monkeypatch.setattr(tasks.run_prompt_box, "apply_async",
                        lambda args, queue: sent.append((args, queue)))
    runs.dispatch(run.id)
    assert sent == [([str(run.id)], "ai")]

    def boom(*args, **kwargs):
        raise ConnectionError("broker down")

    monkeypatch.setattr(tasks.run_prompt_box, "apply_async", boom)
    runs.dispatch(run.id)
    run.refresh_from_db()
    assert (run.status, run.error_code, run.error_message) == (
        "failed", "internal_error", "The run could not be started.")
    assert set(run.answers.values_list("error_code", flat=True)) == {"internal_error"}


@pytest.mark.django_db(transaction=True)
def test_the_celery_path_asks_on_worker_threads(user, website, engines, extraction, settings):
    # Eager Celery runs the task in-process; its pool asks on worker threads.
    settings.PROMPT_BOX_RUN_MODE = "celery"
    engines.enable("chatgpt", "claude")
    run = ask(website, user, body(samples=2))
    assert run.status == "done"
    assert run.answers.filter(status="done").count() == 4
    assert len(engines.calls) == 4
