"""Running a country check: Google cells through find_rank's injectable
search, engine cells through the real LLMProvider.query around fake
engines, then finalize, Stop, the stale sweep, the Celery task and the
dispatch modes. COUNTRY_CHECK_RUN_MODE is inline unless a test says so."""
import signal
import threading
import time
from datetime import timedelta
from decimal import Decimal

import pytest
from celery.exceptions import SoftTimeLimitExceeded
from django.db.models import Sum
from django.utils import timezone

from apps.accounts.models import AITokenUsage
from apps.llm_ranking.models import LLMRankingResult
from apps.llm_ranking.services import regions
from apps.search_gap.models import CountryCheckResult, CountryCheckRun, GoogleRankCheck
from apps.search_gap.services import country_checks, country_matrix
from apps.search_gap.services.country_checks import create_run, estimate, validate_request
from apps.search_gap.tasks import run_country_check
from apps.search_gap.tests.country_support import *  # noqa: F403
from apps.search_gap.tests.country_support import (
    BRAND,
    answer,
    body_for,
    failure,
    fake_extract,
    make_prompt,
    organic_page,
    serp_error,
    start_queued,
)

pytestmark = pytest.mark.django_db

OWN = "northwind-crm.example"


@pytest.fixture
def prompts(website):
    return [make_prompt(website, "Best CRM  for startups?"), make_prompt(website, "crm for teams")]


@pytest.fixture
def ready(fake_serp, engines, extraction):
    engines.enable("chatgpt", "claude", "gemini", "perplexity")
    return fake_serp


def run_check(website, user, prompts, countries=("gb",), engine_keys=("chatgpt",), **extra):
    plan = validate_request(website, body_for(prompts, countries, engine_keys, **extra))
    est = estimate(website, user, plan)
    assert est["can_run"], est["blockers"]
    confirm = dict(est["confirm"], ai_usd_max=Decimal(est["confirm"]["ai_usd_max"]))
    return create_run(website, user, plan, confirm)


def cell(run, engine="chatgpt", bp=None, country="gb"):
    cells = CountryCheckResult.objects.filter(run=run, engine=engine, country=country)
    if bp is not None:
        cells = cells.filter(brand_prompt=bp)
    return cells.order_by("created_at").first()


# -- Google ------------------------------------------------------------------


def test_google_found_on_page_one(website, user, prompts, ready):
    ready.page("gb", 0, organic_page(0, ["acme-crm.example", "result-1.example", OWN], deferred=True))

    run = run_check(website, user, prompts[:1], engine_keys=[])

    google = cell(run, "google")
    assert (google.status, google.position, google.depth, google.pages_fetched) == ("done", 3, 10, 1)
    assert google.url == f"https://www.{OWN}/page"
    assert (google.method, google.proxy_country, google.provider) == ("google_setting", "us", "scraperapi")
    assert [(r["position"], r["is_yours"], r["is_competitor"]) for r in google.top_results] == [
        (1, False, True), (2, False, False), (3, True, False)]
    # ScraperAPI only marks a shown overview: nothing about it was read.
    assert google.ai_overview == {"shown": True, "content_captured": False, "mentions_you": None,
                                  "cites_you": None, "references": []}
    assert ready.calls == [{"query": "Best CRM for startups?", "start": 0, "country": "gb", "gl": ""}]
    run.refresh_from_db()
    assert (run.status, run.google_pages_fetched) == ("done", 1)
    assert country_matrix.cell_payload(google)["state"] == "ok"


def test_google_not_found_within_depth(website, user, prompts, ready, serpapi):
    # SerpAPI: ScraperAPI is read on page one only (the next test).
    run = run_check(website, user, prompts, engine_keys=[], google_pages=2)

    google = cell(run, "google", prompts[0])
    assert (google.status, google.position, google.depth, google.pages_fetched) == ("done", None, 20, 2)
    assert google.url == "" and len(google.top_results) == 10
    assert country_matrix.cell_payload(google)["state"] == "not_found"
    assert [c["start"] for c in ready.calls] == [0, 10, 0, 10]
    run.refresh_from_db()
    assert run.google_pages_fetched == 4
    cost = country_matrix.run_payload(run)["cost"]
    assert (cost["scraperapi_credits"], cost["google_usd"]) == (None, "0.0600")


def test_scraperapi_measures_the_top_10_only(website, user, prompts, ready, settings):
    # Its page two answers another query, so a miss is "not in the top 10",
    # even for a check created for two pages before the cap.
    run = start_queued(website, user, body_for(prompts[:1], ["gb"], []), settings)
    CountryCheckRun.objects.filter(id=run.id).update(google_pages=2)
    run.refresh_from_db()

    country_checks.execute_run(run.id)

    google = cell(run, "google")
    assert (google.status, google.position, google.depth, google.pages_fetched) == ("done", None, 10, 1)
    assert [c["start"] for c in ready.calls] == [0]
    run.refresh_from_db()
    assert run.google_pages_fetched == 1


@pytest.mark.parametrize("code, calls, message", [
    ("network", 2, "Google search could not be reached."),
    ("http_503", 2, "Google search failed (HTTP 503)."),
    ("empty_results", 2, "Google's results page came back empty, so this search could not be read."),
    ("http_401", 1, "Google search failed (HTTP 401)."),
])
def test_google_error_after_one_retry(website, user, prompts, ready, code, calls, message):
    ready.page("gb", 0, serp_error(code))

    run = run_check(website, user, prompts[:1], engine_keys=[])

    google = cell(run, "google")
    assert (google.status, google.error_code, google.error_message) == ("failed", "serp_failed", message)
    assert (google.pages_fetched, google.depth, google.ai_overview) == (0, None, {})
    assert len(ready.calls) == calls
    assert country_checks.google_quota().remaining(str(website.id)) == 100 - calls
    run.refresh_from_db()
    assert (run.status, run.error_code, run.error_message) == ("failed", "serp_failed", message)


def test_a_retried_google_page_can_recover(website, user, prompts, ready):
    ready.page("gb", 0, serp_error("http_429"), organic_page(0, [OWN]))

    run = run_check(website, user, prompts[:1], engine_keys=[])

    assert (cell(run, "google").status, cell(run, "google").position) == ("done", 1)
    assert len(ready.calls) == 2


def test_daily_limit_reached_mid_run(website, user, prompts, ready, settings):
    settings.COUNTRY_CHECK_DAILY_GOOGLE_PAGES = 2

    def another_check_spends_the_rest(call):
        country_checks.google_quota().consume(str(website.id))

    ready.on_call = another_check_spends_the_rest

    run = run_check(website, user, prompts, engine_keys=[])

    first, second = cell(run, "google", prompts[0]), cell(run, "google", prompts[1])
    assert first.status == "done"
    assert (second.status, second.error_code, second.error_message) == (
        "skipped", "daily_limit", "This project used its Google pages for today.")
    assert len(ready.calls) == 1
    run.refresh_from_db()
    assert run.status == "partial"


# -- engines -----------------------------------------------------------------


def test_an_engine_that_names_you(website, user, prompts, ready, engines, extraction):
    engines.script("chatgpt", answer(f"1. Acme CRM - pipelines.\n2. {BRAND} - small teams.",
                                     citations=["https://www.g2.example/crm"]))

    run = run_check(website, user, prompts[:1], include_google=False)

    result = cell(run)
    assert (result.status, result.mentioned, result.rank, result.sentiment) == ("done", True, 2, "positive")
    assert result.brands == [{"name": "Acme CRM", "position": 1}]
    assert result.citations == ["https://www.g2.example/crm"]
    assert (result.method, result.provider, result.model_id) == ("asked", "gpt4", "fake-gpt4")
    assert result.extraction_model == "claude-haiku-4-5"
    assert result.answer_text.startswith("1. Acme CRM")
    assert country_matrix.cell_payload(result)["state"] == "ok"

    call = engines.calls[0]
    assert (call["prompt"], call["region"]) == ("Best CRM  for startups?", "gb")
    assert call["system_prompt"].count(regions.region_system_instruction("gb")) == 1
    sent = extraction.calls[0]
    assert (sent["brand_name"], sent["audit_id"], sent["user"]) == (BRAND, f"country-run:{run.id}", user)
    assert sent["keywords"] == [BRAND, "crm", "Acme CRM"]


def test_an_engine_that_does_not_name_you(website, user, prompts, ready):
    run = run_check(website, user, prompts[:1], include_google=False)

    result = cell(run)
    assert (result.status, result.mentioned, result.rank, result.sentiment) == ("done", False, None, "")
    assert result.brands == [{"name": "Acme CRM", "position": 1}, {"name": "Contoso CRM", "position": 2}]
    assert country_matrix.cell_payload(result)["state"] == "not_found"


def test_searched_and_asked_answers_are_labelled(website, user, prompts, ready, engines):
    engines.script("perplexity", answer("1. Acme CRM", searched=True))

    run = run_check(website, user, prompts[:1], engine_keys=["gemini", "perplexity"],
                    include_google=False)

    assert country_matrix.cell_payload(cell(run, "perplexity"))["method_label"] == "Searched from GB"
    assert country_matrix.cell_payload(cell(run, "gemini"))["method_label"] == "Asked to answer for GB"
    gemini = next(c for c in engines.calls if c["provider"] == "gemini")
    # Gemini adds the instruction itself, from the region.
    assert gemini["region"] == "gb"
    assert regions.region_system_instruction("gb") not in gemini["system_prompt"]


@pytest.mark.parametrize("script, calls, status, code, message", [
    ([failure("refusal: Claude declined to answer")], 1, "failed", "refused",
     "The engine declined to answer this prompt."),
    ([failure("monthly_ai_allowance_exceeded: the account has used its $1.00 monthly AI allowance")],
     1, "failed", "allowance_exceeded", "The monthly AI allowance is used up."),
    ([failure("gpt4 rate limit exceeded; try again shortly")] * 2, 2, "failed", "rate_limited",
     "The engine was busy or rate limited."),
    ([failure("Request timed out"), failure("Request timed out")], 2, "failed", "timeout",
     "The engine did not respond in time."),
    ([failure("max_tokens: the answer was cut off", billed=True)] * 2, 2, "failed", "cut_off",
     "The engine's answer was cut off before it finished."),
    ([RuntimeError("boom"), RuntimeError("boom")], 2, "failed", "engine_error",
     "The engine returned an error."),
    ([answer("   ")], 1, "failed", "engine_error", "The engine returned an error."),
    ([failure("Request timed out"), answer("1. Acme CRM")], 2, "done", "", ""),
])
def test_engine_failures(website, user, prompts, ready, engines, script, calls, status, code, message):
    engines.script("chatgpt", *script)

    run = run_check(website, user, prompts[:1], include_google=False)

    result = cell(run)
    assert (result.status, result.error_code, result.error_message) == (status, code, message)
    assert len(engines.calls) == calls
    if status == "failed":
        assert result.method == "" and result.mentioned is None
        assert country_matrix.cell_payload(result)["error"] == {"code": code, "message": message}


def test_an_engine_without_a_key_is_skipped(website, user, prompts, ready, settings):
    run = start_queued(website, user, body_for(prompts[:1], ["gb"], ["chatgpt"], include_google=False),
                       settings)
    settings.OPENAI_API_KEY = ""

    country_checks.execute_run(run.id)

    result = cell(run)
    assert (result.status, result.error_code, result.error_message) == (
        "skipped", "not_configured", "The engine is not configured.")
    run.refresh_from_db()
    assert (run.status, run.error_code) == ("failed", "not_configured")


def test_an_extraction_fallback_is_recorded(website, user, prompts, ready, extraction):
    extraction.state["fn"] = lambda **kwargs: {**fake_extract(**kwargs), "extraction_model": "heuristic"}

    run = run_check(website, user, prompts[:1], include_google=False)

    assert cell(run).extraction_model == "heuristic"


def test_usage_rows_carry_the_run(website, user, prompts, ready):
    run = run_check(website, user, prompts[:1], engine_keys=["chatgpt", "claude"], include_google=False)

    rows = AITokenUsage.objects.filter(user=user)
    assert rows.count() == 2
    for row in rows:
        assert row.module == "llm_ranking" and row.website_id == website.id
        assert row.metadata["audit_id"] == f"country-run:{run.id}"
        assert (row.metadata["role"], row.metadata["feature"], row.metadata["country"],
                row.metadata["actor"]) == ("country_check", "country_checks", "gb", "user")
    total = rows.aggregate(total=Sum("estimated_cost_usd"))["total"]
    run.refresh_from_db()
    assert run.ai_cost_usd == total > 0
    assert country_matrix.run_payload(run)["cost"]["ai_usd"] == country_checks.usd4(total)


def test_country_answers_stay_out_of_the_global_numbers(website, user, prompts, ready):
    run_check(website, user, prompts, countries=["gb", "de"], engine_keys=["chatgpt", "claude"])

    assert CountryCheckResult.objects.count() == 2 * 2 * 3
    assert not LLMRankingResult.objects.exists()
    assert not GoogleRankCheck.objects.exists()


# -- finishing, Stop, the sweep ------------------------------------------------


def test_every_cell_done_is_a_done_run(website, user, prompts, ready):
    run = run_check(website, user, prompts, countries=["gb", "de"], engine_keys=["chatgpt"])

    run.refresh_from_db()
    assert run.status == "done" and run.error_code == ""
    assert run.country_status == {"gb": "done", "de": "done"}
    assert run.started_at <= run.finished_at and run.heartbeat_at is not None


def test_stop_mid_run_cancels_the_rest(website, user, prompts, ready, engines):
    def press_stop(call):
        CountryCheckRun.objects.filter(website=website).update(cancel_requested=True)
        return answer("1. Acme CRM")

    engines.script("chatgpt", press_stop)

    run = run_check(website, user, prompts, include_google=False)

    first, second = cell(run, bp=prompts[0]), cell(run, bp=prompts[1])
    assert first.status == "done"
    assert (second.status, second.error_code) == ("cancelled", "cancelled")
    assert len(engines.calls) == 1
    run.refresh_from_db()
    assert run.status == "cancelled"
    progress = country_matrix.run_payload(run)["progress"]
    assert (progress["done"], progress["cancelled"]) == (1, 1)


def test_stop_between_google_pages(website, user, prompts, ready, serpapi):
    # SerpAPI: ScraperAPI is read on page one only, so there is no page between.
    def press_stop(call):
        CountryCheckRun.objects.filter(website=website).update(cancel_requested=True)

    ready.on_call = press_stop

    run = run_check(website, user, prompts[:1], engine_keys=[], google_pages=2)

    # Page one was read; the second page was never fetched.
    google = cell(run, "google")
    assert (google.status, google.depth, google.pages_fetched) == ("done", 10, 1)
    assert len(ready.calls) == 1


def test_sweep_interrupts_checks_that_stopped_reporting(website, user, prompts, ready, settings, api):
    stale = start_queued(website, user, body_for(prompts[:1], ["gb"], ["chatgpt"]), settings)
    CountryCheckResult.objects.filter(run=stale, engine="google").update(status="running")
    old = timezone.now() - timedelta(minutes=21)
    CountryCheckRun.objects.filter(id=stale.id).update(created_at=old, heartbeat_at=old)

    data_ = api.get(f"/api/v1/search-gap/websites/{website.id}/countries/options/").json()["data"]

    stale.refresh_from_db()
    assert stale.status == "interrupted" and stale.finished_at is not None
    assert (stale.error_code, stale.error_message) == ("interrupted", "The check stopped before it finished.")
    assert set(CountryCheckResult.objects.filter(run=stale).values_list("status", "error_code")) == {
        ("failed", "interrupted")}
    assert data_["active_run"] is None and data_["last_run"]["status"] == "interrupted"

    fresh = start_queued(website, user, body_for(prompts[1:], ["gb"], ["chatgpt"]), settings)
    assert country_checks.sweep_stale(website) == 0
    fresh.refresh_from_db()
    assert fresh.status == "queued"


# -- the Celery task and dispatch ------------------------------------------------


def test_the_country_task_runs_one_country(website, user, prompts, ready, settings):
    run = start_queued(website, user, body_for(prompts[:1], ["gb", "de"], ["chatgpt"]), settings)

    assert run_country_check(str(run.id), "gb") == {"run_id": str(run.id), "country": "gb"}

    run.refresh_from_db()
    assert run.status == "running" and run.country_status == {"gb": "done", "de": "queued"}
    run_country_check(str(run.id), "de")
    run.refresh_from_db()
    assert run.status == "done"


def test_a_country_that_runs_out_of_time(website, user, prompts, ready, settings, monkeypatch):
    run = start_queued(website, user, body_for(prompts[:1], ["gb"], ["chatgpt"]), settings)

    def too_slow(run_id, country):
        CountryCheckResult.objects.filter(run_id=run_id, engine="chatgpt").update(status="running")
        raise SoftTimeLimitExceeded()

    monkeypatch.setattr(country_checks, "execute_country", too_slow)

    assert run_country_check(str(run.id), "gb")["error"] == "timeout"

    assert (cell(run).status, cell(run).error_code) == ("failed", "timeout")
    assert cell(run, "google").error_code == "interrupted"
    run.refresh_from_db()
    assert run.status == "failed"


@pytest.mark.django_db(transaction=True)
def test_a_soft_time_limit_while_cells_run_ends_the_country(website, user, prompts, ready, engines,
                                                           settings, monkeypatch):
    """Celery delivers the soft time limit as an exception in the task's own
    thread, which is waiting on the cell workers. The country stops there:
    no further cell starts, its unfinished cells fail and the run finishes,
    instead of every queued cell running on until the hard limit kills the
    worker (and the run waits 20 minutes for the stale sweep)."""
    settings.COUNTRY_CHECK_RUN_MODE = "thread"
    settings.COUNTRY_CHECK_ENGINE_CONCURRENCY = 1
    monkeypatch.setattr(country_checks, "dispatch", lambda run_id: None)
    release, worker = threading.Event(), {}

    def hangs(call):
        # The soft limit fires while this answer is still being written.
        worker["thread"] = threading.current_thread()
        signal.setitimer(signal.ITIMER_REAL, 0.3)
        release.wait(5)
        return answer("1. Northwind CRM")

    engines.script("chatgpt", hangs)
    run = run_check(website, user, prompts, engine_keys=["chatgpt"], include_google=False)

    def soft_time_limit(signum, frame):
        raise SoftTimeLimitExceeded()

    previous = signal.signal(signal.SIGALRM, soft_time_limit)
    try:
        outcome = run_country_check(str(run.id), "gb")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        release.set()
        if "thread" in worker:
            worker["thread"].join(10)

    assert outcome.get("error") == "timeout"
    # The second prompt's answer was never asked for.
    assert len(engines.calls) == 1
    # The answer that arrived after the country timed out does not reopen its cell.
    assert sorted(run.results.values_list("status", "error_code")) == [
        ("failed", "timeout"), ("failed", "timeout")]
    run.refresh_from_db()
    assert (run.status, run.error_code) == ("failed", "timeout")


def test_a_cell_the_sweep_ended_keeps_that_end(website, user, prompts, ready, engines):
    def swept_meanwhile(call):
        # The stale sweep ends the run while this answer is still on its way.
        CountryCheckResult.objects.filter(engine="chatgpt", status="running").update(
            status="failed", error_code="interrupted")
        CountryCheckRun.objects.filter(website=website).update(status="interrupted")
        return answer("1. Northwind CRM")

    engines.script("chatgpt", swept_meanwhile)

    run = run_check(website, user, prompts[:1], include_google=False)

    assert (cell(run).status, cell(run).error_code) == ("failed", "interrupted")


def test_concurrent_google_pages_never_pass_the_daily_quota(settings, monkeypatch):
    """Country workers take pages from the quota on several threads (and
    Celery processes) at once: every page counts, and the cap holds."""
    from core import quota as quota_module

    settings.COUNTRY_CHECK_DAILY_GOOGLE_PAGES = 5
    real = quota_module.cache

    class SlowReads:
        """The project cache, with the gap between a read and the write
        after it widened, as on a busy Redis."""

        def __getattr__(self, name):
            return getattr(real, name)

        def get(self, *args, **kwargs):
            value = real.get(*args, **kwargs)
            time.sleep(0.05)
            return value

    monkeypatch.setattr(quota_module, "cache", SlowReads())
    quota = country_checks.google_quota()
    start, taken = threading.Barrier(8), []

    def worker():
        start.wait(5)
        taken.append(quota.consume("website-1"))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)

    assert taken.count(True) == 5 and taken.count(False) == 3
    assert quota.remaining("website-1") == 0
    assert quota.consume("website-1") is False


class _Recorder:
    def __init__(self):
        self.calls = []
        self.event = threading.Event()

    def __call__(self, *args):
        self.calls.append(args)
        self.event.set()


def test_create_hands_the_run_over_after_commit(website, user, prompts, ready, settings, monkeypatch,
                                                django_capture_on_commit_callbacks):
    settings.COUNTRY_CHECK_RUN_MODE = "thread"
    worker = _Recorder()
    monkeypatch.setattr(country_checks, "execute_run_safely", worker)

    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        run = run_check(website, user, prompts[:1])

    assert len(callbacks) == 1 and run.status == "queued"
    assert worker.event.wait(5)
    assert worker.calls == [(str(run.id),)]


@pytest.mark.parametrize("mode, eager, path", [
    ("thread", False, "thread"), ("auto", True, "thread"),
    ("auto", False, "celery"), ("celery", True, "celery"),
])
def test_dispatch_modes(website, user, prompts, ready, settings, monkeypatch, mode, eager, path):
    run = start_queued(website, user, body_for(prompts[:1], ["gb", "de"], ["chatgpt"]), settings)
    settings.COUNTRY_CHECK_RUN_MODE = mode
    settings.CELERY_TASK_ALWAYS_EAGER = eager
    worker, delayed = _Recorder(), []
    monkeypatch.setattr(country_checks, "execute_run_safely", worker)
    monkeypatch.setattr(run_country_check, "delay", lambda *args: delayed.append(args))

    country_checks.dispatch(run.id)

    if path == "thread":
        assert worker.event.wait(5) and delayed == []
    else:
        assert delayed == [(str(run.id), "gb"), (str(run.id), "de")] and worker.calls == []


def test_a_run_that_cannot_be_handed_over_fails_at_once(website, user, prompts, ready, settings,
                                                        monkeypatch):
    run = start_queued(website, user, body_for(prompts[:1], ["gb"], ["chatgpt"]), settings)
    settings.COUNTRY_CHECK_RUN_MODE = "celery"

    def broker_down(*args):
        raise ConnectionError("broker unreachable")

    monkeypatch.setattr(run_country_check, "delay", broker_down)

    country_checks.dispatch(run.id)

    run.refresh_from_db()
    assert (run.status, run.error_code) == ("failed", "internal_error")
    assert country_checks.active_run(website) is None


@pytest.mark.django_db(transaction=True)
def test_thread_mode_runs_cells_on_worker_threads(website, user, prompts, ready, settings, monkeypatch):
    settings.COUNTRY_CHECK_RUN_MODE = "thread"
    settings.COUNTRY_CHECK_SERP_CONCURRENCY = 2
    settings.COUNTRY_CHECK_ENGINE_CONCURRENCY = 3
    monkeypatch.setattr(country_checks, "dispatch", lambda run_id: None)
    ready.page("gb", 0, organic_page(0, [OWN]))

    run = run_check(website, user, prompts, countries=["gb", "de"], engine_keys=["chatgpt", "claude"])
    country_checks.execute_run(run.id)

    run.refresh_from_db()
    assert run.status == "done", list(run.results.values_list("status", "error_code"))
    assert run.results.filter(status="done").count() == 12
    assert run.google_pages_fetched == 4
    assert cell(run, "google", prompts[0]).position == 1
