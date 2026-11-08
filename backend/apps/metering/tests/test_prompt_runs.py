"""Prompt runs: the free plan's 20 engine answers a month.

One prompt answered by one engine is one run; it counts only for a
successful, non-empty answer, is shared by every project of the account,
is counted once however often a call is retried, and can never pass the
limit under concurrent workers."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import DatabaseError, connection
from django.utils import timezone

from apps.metering.models import PromptRun, UsageCounter
from apps.metering.services import prompt_runs
from apps.metering.tests.prompt_run_support import make_paid, use_runs
from apps.websites.models import Website
from core.exceptions import CanseeException
from core.llm import ProviderResult

pytestmark = pytest.mark.django_db


def _user(email="owner@example.com"):
    return get_user_model().objects.create_user(
        email=email, password="x" * 16, full_name="Site Owner", is_email_verified=True,
    )


@pytest.fixture
def user():
    return _user()


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://northwind.example", name="Northwind")


def answer(text="1. Northwind"):
    return ProviderResult(succeeded=True, text=text)


def _counter(account):
    return UsageCounter.objects.get(meter="prompt_runs", account_key=account.key,
                                    period_key=account.period_key).value


# -- limits and accounts ----------------------------------------------------------


def test_the_free_plan_gets_20_and_paid_plans_are_unlimited(user, website):
    assert prompt_runs.limit_for(user, website) == 20
    assert prompt_runs.is_limited(user, website) is True
    make_paid(user)
    assert prompt_runs.limit_for(user, website) == -1
    assert prompt_runs.is_limited(user, website) is False


def test_the_free_number_is_a_setting(user, settings):
    settings.FREE_MONTHLY_PROMPT_RUNS = 7
    assert prompt_runs.limit_for(user) == 7
    assert prompt_runs.status(user)["limit"] == 7


def test_the_paywall_switch_does_not_lift_the_limit(user, settings):
    # The runs follow the AI allowance's plan, as the dollar wall does.
    settings.PAYWALL_ENABLED = False
    assert prompt_runs.limit_for(user) == 20


def test_runs_are_shared_by_every_project_of_the_owner(user, website):
    second = Website.objects.create(user=user, url="https://second.example", name="Second")
    prompt_runs.guard(answer, user=user, website=website, engine="gpt4", feature="audit")
    prompt_runs.guard(answer, user=user, website=second, engine="claude", feature="audit")
    assert prompt_runs.status(user)["used"] == 2
    assert prompt_runs.status(user, second)["remaining"] == 18


def test_an_answer_on_a_shared_project_counts_on_the_owner(user, website):
    teammate = _user("teammate@example.com")
    prompt_runs.guard(answer, user=teammate, website=website, engine="gpt4", feature="prompt_crawl")
    assert prompt_runs.status(user)["used"] == 1
    assert prompt_runs.status(teammate)["used"] == 0
    assert PromptRun.objects.get().user == teammate


def test_an_unattributed_call_is_not_counted():
    result = prompt_runs.guard(answer, user=None, website=None, engine="gpt4", feature="audit")
    assert result.succeeded and PromptRun.objects.count() == 0


# -- what counts ------------------------------------------------------------------------


def test_only_a_successful_non_empty_answer_counts(user, website):
    outcomes = [
        answer(),
        ProviderResult(succeeded=False, error="rate limit exceeded"),
        ProviderResult(succeeded=True, text="   "),
        ProviderResult(succeeded=False, error="refusal: declined"),
        None,  # every attempt raised
    ]
    for outcome in outcomes:
        prompt_runs.guard(lambda o=outcome: o, user=user, website=website, engine="gpt4",
                          feature="audit")
    status = prompt_runs.status(user, website)
    assert (status["used"], status["reserved"], status["remaining"]) == (1, 0, 19)
    assert sorted(PromptRun.objects.values_list("status", flat=True)) == [
        "counted", "released", "released", "released", "released"]


def test_a_call_that_raises_gives_its_run_back(user, website):
    def boom():
        raise RuntimeError("worker died")

    with pytest.raises(RuntimeError):
        prompt_runs.guard(boom, user=user, website=website, engine="gpt4", feature="audit")
    assert prompt_runs.status(user, website)["remaining"] == 20


def test_with_none_left_the_engine_is_not_asked(user, website):
    use_runs(user, 20, website)
    asked = []
    result = prompt_runs.guard(lambda: asked.append(1) or answer(), user=user, website=website,
                               engine="gpt4", feature="audit")
    assert asked == []
    assert (result.succeeded, result.error) == (False, prompt_runs.DENIAL)
    assert prompt_runs.is_denial(result.error)
    # The denial is not read as the dollar wall by the engine error mappers.
    assert "allowance" not in prompt_runs.DENIAL


def test_the_last_run_is_granted_and_the_next_is_denied(user, website):
    use_runs(user, 19, website)
    first = prompt_runs.guard(answer, user=user, website=website, engine="gpt4", feature="audit")
    second = prompt_runs.guard(answer, user=user, website=website, engine="gpt4", feature="audit")
    assert first.succeeded is True and second.error == prompt_runs.DENIAL
    assert prompt_runs.status(user, website)["remaining"] == 0


def test_paid_accounts_are_recorded_but_never_denied(user, website):
    make_paid(user)
    for _ in range(25):
        assert prompt_runs.guard(answer, user=user, website=website, engine="gpt4",
                                 feature="audit").succeeded
    status = prompt_runs.status(user, website)
    assert (status["unlimited"], status["used"], status["remaining"], status["limit"]) == (
        True, 25, None, None)


# -- retries and concurrency ---------------------------------------------------------------


def test_a_retried_call_is_counted_once(user, website):
    for _ in range(3):
        prompt_runs.guard(answer, user=user, website=website, engine="gpt4", feature="audit",
                          key="audit:1:cell:0:gpt4")
    assert prompt_runs.status(user, website)["used"] == 1
    assert PromptRun.objects.count() == 1


def test_a_retry_of_a_failed_call_counts_when_it_answers(user, website):
    key = "audit:1:cell:0:gpt4"
    prompt_runs.guard(lambda: ProviderResult(succeeded=False, error="busy"), user=user,
                      website=website, engine="gpt4", feature="audit", key=key)
    assert prompt_runs.status(user, website)["used"] == 0
    prompt_runs.guard(answer, user=user, website=website, engine="gpt4", feature="audit", key=key)
    status = prompt_runs.status(user, website)
    assert (status["used"], status["remaining"]) == (1, 19)


def test_a_replay_still_reserved_does_not_take_a_second_run(user, website):
    key = "scan:1:gpt4"
    first = prompt_runs.reserve(user=user, website=website, engine="gpt4", feature="audit",
                                idempotency_key=key)
    again = prompt_runs.reserve(user=user, website=website, engine="gpt4", feature="audit",
                                idempotency_key=key)
    assert first.granted and again.granted and first.run_id == again.run_id
    assert prompt_runs.status(user, website)["remaining"] == 19


@pytest.mark.django_db(transaction=True)
def test_concurrent_workers_never_pass_the_limit():
    owner = _user("race@example.com")
    site = Website.objects.create(user=owner, url="https://race.example", name="Race")
    use_runs(owner, 17, site)

    def take(_):
        try:
            return prompt_runs.reserve(user=owner, website=site, engine="gpt4",
                                       feature="audit").granted
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=8) as pool:
        granted = list(pool.map(take, range(12)))
    assert granted.count(True) == 3
    account = prompt_runs.account_for(owner, site)
    assert _counter(account) == 20


@pytest.mark.django_db(transaction=True)
def test_concurrent_replays_of_one_key_take_one_run():
    owner = _user("replay@example.com")

    def take(_):
        try:
            return prompt_runs.reserve(user=owner, engine="gpt4", feature="audit",
                                       idempotency_key="audit:race:cell:0:gpt4").run_id
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=6) as pool:
        ids = set(pool.map(take, range(6)))
    assert len(ids) == 1
    assert _counter(prompt_runs.account_for(owner)) == 1


# -- the stale sweep -------------------------------------------------------------------------


def test_the_sweep_gives_back_runs_left_reserved(user, website, settings):
    settings.PROMPT_RUN_STALE_MINUTES = 30
    old = prompt_runs.reserve(user=user, website=website, engine="gpt4", feature="audit")
    fresh = prompt_runs.reserve(user=user, website=website, engine="claude", feature="audit")
    PromptRun.objects.filter(id=old.run_id).update(created_at=timezone.now() - timedelta(hours=1))

    from apps.metering.tasks import release_stale_prompt_runs

    assert release_stale_prompt_runs() == {"released": 1}
    assert PromptRun.objects.get(id=old.run_id).status == "released"
    assert PromptRun.objects.get(id=fresh.run_id).status == "reserved"
    assert prompt_runs.status(user, website)["remaining"] == 19
    # A second sweep finds nothing; the unit is never given back twice.
    assert release_stale_prompt_runs() == {"released": 0}
    assert prompt_runs.status(user, website)["remaining"] == 19


def test_an_answer_that_arrives_after_the_sweep_is_still_counted(user, website):
    reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4", feature="audit")
    PromptRun.objects.filter(id=reservation.run_id).update(
        created_at=timezone.now() - timedelta(hours=1))
    prompt_runs.release_stale()
    reservation.settle(answered=True)
    status = prompt_runs.status(user, website)
    assert (status["used"], status["remaining"]) == (1, 19)


def test_settle_twice_changes_nothing(user, website):
    reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4", feature="audit")
    reservation.settle(answered=False)
    reservation.settle(answered=False)
    prompt_runs.settle(reservation.run_id, answered=False)
    assert prompt_runs.status(user, website)["remaining"] == 20


def test_the_sweep_is_scheduled():
    from config.celery import app

    entry = app.conf.beat_schedule["release-stale-prompt-runs"]
    assert entry["task"] == "apps.metering.tasks.release_stale_prompt_runs"


# -- failures ---------------------------------------------------------------------------


def test_a_database_error_denies_a_free_account(user, website):
    with patch.object(prompt_runs, "_take_unit", side_effect=DatabaseError("down")):
        reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                          feature="audit")
    assert reservation.granted is False
    assert reservation.denial.startswith("prompt_runs_check_failed")


def test_a_database_error_lets_a_paid_account_through(user, website):
    make_paid(user)
    with patch.object(prompt_runs, "_take_unit", side_effect=DatabaseError("down")):
        reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                          feature="audit")
    assert reservation.granted is True


# -- the block, the estimate and the refusals ----------------------------------------------


def test_the_status_block(user, website):
    prompt_runs.guard(answer, user=user, website=website, engine="gpt4", feature="audit")
    prompt_runs.guard(answer, user=user, website=website, engine="gpt4", feature="prompt_box")
    prompt_runs.guard(answer, user=user, website=website, engine="claude", feature="audit")
    prompt_runs.reserve(user=user, website=website, engine="gemini", feature="audit")
    status = prompt_runs.status(user, website)
    assert status == {
        "unlimited": False, "limit": 20, "used": 3, "reserved": 1, "remaining": 16,
        "plan": "free", "scope": "account",
        "period_start": status["period_start"], "resets_at": status["resets_at"],
        "by_engine": {"chatgpt": 2, "claude": 1},
        "by_feature": {"audit": 2, "prompt_box": 1},
    }
    assert status["resets_at"] > status["period_start"]


def test_shortfall_and_require(user, website):
    assert prompt_runs.shortfall(user, website, 20) is None
    use_runs(user, 15, website)
    short = prompt_runs.shortfall(user, website, 6)
    assert short["code"] == "insufficient_prompt_runs" and short["status"] == 403
    assert short["message"] == ("This needs 6 free prompt runs and 5 of your 20 are left this "
                                "month. Choose fewer prompts or engines.")
    assert (short["details"]["needed"], short["details"]["remaining"],
            short["details"]["limit"]) == (6, 5, 20)
    use_runs(user, 20, website)
    with pytest.raises(CanseeException) as caught:
        prompt_runs.require(user, website, 1)
    assert (caught.value.code, caught.value.status_code) == ("prompt_runs_exhausted", 403)
    assert caught.value.message.startswith("You have used this month's 20 free prompt runs. "
                                           "They renew on ")
    assert caught.value.details["resets_at"]
    # Nothing needed is never refused.
    prompt_runs.require(user, website, 0)


def test_paid_accounts_are_never_short(user, website):
    make_paid(user)
    assert prompt_runs.shortfall(user, website, 500) is None
    assert prompt_runs.estimate_block(user, website, 500) == {
        "needed": 500, "remaining": None, "limit": None, "unlimited": True, "enough": True,
        "resets_at": None,
    }
