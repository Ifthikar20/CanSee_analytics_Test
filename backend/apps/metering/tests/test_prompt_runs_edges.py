"""Prompt runs at their edges: the limit setting, the month turning over in
UTC, organizations sharing one count, retries and late answers, the stale
sweep racing a settle, and the refusal wording at zero, one and the limit."""
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.utils import timezone
from freezegun import freeze_time

from apps.accounts.models import Organization, OrganizationMember
from apps.billing.models import Subscription
from apps.metering.models import PromptRun, UsageCounter
from apps.metering.services import prompt_runs
from apps.metering.tests.prompt_run_support import make_paid, use_runs
from apps.websites.models import Website
from core.exceptions import CanseeException
from core.llm import ProviderResult
from core.utils.constants import Plan, SubscriptionStatus

pytestmark = pytest.mark.django_db


def _user(email):
    return get_user_model().objects.create_user(
        email=email, password="x" * 16, full_name="Site Owner", is_email_verified=True,
    )


@pytest.fixture
def user():
    return _user("owner@example.com")


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://northwind.example", name="Northwind")


def answer(text="1. Northwind"):
    return ProviderResult(succeeded=True, text=text)


def failure():
    return ProviderResult(succeeded=False, error="busy")


def ask(user, website, call=answer, *, engine="gpt4", feature="audit", key=None):
    return prompt_runs.guard(call, user=user, website=website, engine=engine, feature=feature,
                             key=key)


def counter_value(account):
    return (UsageCounter.objects.filter(
        meter="prompt_runs", account_key=account.key, period_key=account.period_key,
    ).values_list("value", flat=True).first() or 0)


def _org(owner, *members, plan=Plan.FREE):
    org = Organization.objects.create(name="Acme", slug=f"acme-{owner.pk}", owner=owner,
                                      plan=plan)
    OrganizationMember.objects.create(organization=org, user=owner, role="owner")
    for member in members:
        OrganizationMember.objects.create(organization=org, user=member, role="member")
    return org


def _fresh(user):
    return type(user).objects.get(pk=user.pk)


# -- the limit setting ----------------------------------------------------------------


def test_a_zero_allowance_denies_the_first_run(user, website, settings):
    settings.FREE_MONTHLY_PROMPT_RUNS = 0
    asked = []
    result = ask(user, website, lambda: asked.append(1) or answer())
    assert (asked, result.succeeded, result.error) == ([], False, prompt_runs.DENIAL)
    status = prompt_runs.status(user, website)
    assert (status["limit"], status["remaining"], status["unlimited"]) == (0, 0, False)
    with pytest.raises(CanseeException) as caught:
        prompt_runs.require(user, website, 1)
    assert caught.value.code == "prompt_runs_exhausted"


def test_a_negative_allowance_reads_as_zero(user, settings):
    settings.FREE_MONTHLY_PROMPT_RUNS = -5
    assert prompt_runs.limit_for(user) == 0
    assert prompt_runs.is_limited(user) is True


def test_an_unreadable_allowance_setting_falls_back_to_20(user, settings):
    settings.FREE_MONTHLY_PROMPT_RUNS = "twenty"
    assert prompt_runs.limit_for(user) == 20
    settings.FREE_MONTHLY_PROMPT_RUNS = None
    assert prompt_runs.limit_for(user) == 20


def test_a_one_run_allowance_takes_one_then_refuses(user, website, settings):
    settings.FREE_MONTHLY_PROMPT_RUNS = 1
    assert ask(user, website).succeeded is True
    assert ask(user, website, engine="claude").error == prompt_runs.DENIAL
    with pytest.raises(CanseeException) as caught:
        prompt_runs.require(user, website, 1)
    # The singular, and no dollar amount.
    assert caught.value.message.startswith(
        "You have used this month's 1 free prompt run. They renew on ")
    assert "$" not in caught.value.message


def test_the_singular_in_the_shortfall(user, website, settings):
    settings.FREE_MONTHLY_PROMPT_RUNS = 3
    use_runs(user, 3, website)
    settings.FREE_MONTHLY_PROMPT_RUNS = 4
    short = prompt_runs.shortfall(user, website, 1)
    assert short is None
    short = prompt_runs.shortfall(user, website, 2)
    assert short["message"] == ("This needs 2 free prompt runs and 1 of your 4 are left this "
                                "month. Choose fewer prompts or engines.")
    settings.FREE_MONTHLY_PROMPT_RUNS = 3
    short = prompt_runs.shortfall(user, website, 1)
    assert short["code"] == "prompt_runs_exhausted"
    assert short["message"].startswith("You have used this month's 3 free prompt runs.")


def test_a_paid_plan_ignores_the_free_setting(user, settings):
    settings.FREE_MONTHLY_PROMPT_RUNS = 0
    make_paid(user, Plan.PROMPTS_200)
    assert prompt_runs.limit_for(user) == -1
    assert prompt_runs.reserve(user=user, engine="gpt4", feature="audit").granted is True


def test_a_paid_plan_with_a_number_of_runs_is_limited_without_the_word_free(
        user, website, monkeypatch):
    from core.utils.constants import PLAN_LIMITS

    monkeypatch.setitem(PLAN_LIMITS[Plan.PROMPTS_100], "monthly_prompt_runs", 2)
    make_paid(user, Plan.PROMPTS_100)
    assert prompt_runs.limit_for(user) == 2
    assert ask(user, website).succeeded and ask(user, website).succeeded
    assert ask(user, website).error == prompt_runs.DENIAL
    with pytest.raises(CanseeException) as caught:
        prompt_runs.require(user, website, 1)
    assert caught.value.message.startswith("You have used this month's 2 prompt runs.")
    monkeypatch.setitem(PLAN_LIMITS[Plan.PROMPTS_100], "monthly_prompt_runs", "2")
    assert prompt_runs.limit_for(user) == -1


# -- the month in UTC ------------------------------------------------------------------


def test_the_month_turns_over_at_midnight_utc(user, website):
    with freeze_time("2026-11-30 23:59:59"):
        for _ in range(20):
            assert ask(user, website).succeeded
        assert ask(user, website).error == prompt_runs.DENIAL
        status = prompt_runs.status(user, website)
        assert (status["period_start"], status["resets_at"]) == (
            "2026-11-01T00:00:00+00:00", "2026-12-01T00:00:00+00:00")
        assert (status["used"], status["remaining"]) == (20, 0)
    with freeze_time("2026-12-01 00:00:00"):
        status = prompt_runs.status(user, website)
        assert (status["period_start"], status["resets_at"]) == (
            "2026-12-01T00:00:00+00:00", "2027-01-01T00:00:00+00:00")
        assert (status["used"], status["remaining"], status["by_engine"]) == (0, 20, {})
        assert ask(user, website).succeeded is True
        assert prompt_runs.status(user, website)["remaining"] == 19


def test_the_month_follows_utc_whatever_the_server_time_zone(user, website, settings):
    settings.TIME_ZONE = "America/Los_Angeles"
    # 03:00 UTC on 1 December is still 30 November in Los Angeles.
    with freeze_time("2026-12-01 03:00:00"):
        status = prompt_runs.status(user, website)
        assert status["period_start"] == "2026-12-01T00:00:00+00:00"
        assert prompt_runs.account_for(user, website).period_key == "2026-12-01"


def test_a_run_reserved_before_midnight_counts_on_its_own_month(user, website):
    with freeze_time("2026-11-30 23:59:59"):
        reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                          feature="audit")
    with freeze_time("2026-12-01 00:00:05"):
        reservation.settle(answered=True)
        december = prompt_runs.status(user, website)
        assert (december["used"], december["remaining"]) == (0, 20)
    with freeze_time("2026-11-30 23:59:59"):
        november = prompt_runs.status(user, website)
        assert (november["used"], november["remaining"]) == (1, 19)


def test_a_retry_in_the_next_month_counts_on_the_next_month(user, website):
    key = "audit:9:cell:0:gpt4"
    with freeze_time("2026-11-30 23:59:00"):
        ask(user, website, failure, key=key)
        assert prompt_runs.status(user, website)["remaining"] == 20
    with freeze_time("2026-12-01 00:01:00"):
        assert ask(user, website, key=key).succeeded is True
        december = prompt_runs.status(user, website)
        assert (december["used"], december["remaining"]) == (1, 19)
        assert PromptRun.objects.get(idempotency_key=key).period_key == "2026-12-01"
    with freeze_time("2026-11-30 23:59:00"):
        assert prompt_runs.status(user, website)["remaining"] == 20


def test_a_free_account_ends_its_month_at_midnight_utc(user, website):
    with freeze_time("2026-02-14 10:00:00"):
        block = prompt_runs.estimate_block(user, website, 3)
        assert block == {"needed": 3, "remaining": 20, "limit": 20, "unlimited": False,
                         "enough": True, "resets_at": "2026-03-01T00:00:00+00:00"}
        short = prompt_runs.shortfall(user, website, 21)
        assert short["details"]["resets_at"] == "2026-03-01T00:00:00+00:00"
        use_runs(user, 20, website)
        assert "They renew on March 1." in prompt_runs.shortfall(user, website, 1)["message"]


# -- organizations ------------------------------------------------------------------------


def test_an_organization_shares_one_count_across_members_projects_and_engines():
    owner, member = _user("boss@example.com"), _user("member@example.com")
    _org(owner, member)
    own_site = Website.objects.create(user=owner, url="https://boss.example", name="Boss")
    member_site = Website.objects.create(user=member, url="https://member.example", name="Mem")
    for engine in ("gpt4", "claude", "gemini"):
        assert ask(owner, own_site, engine=engine).succeeded
    for engine in ("perplexity", "grok"):
        assert ask(member, member_site, engine=engine).succeeded
    assert prompt_runs.account_key_for(owner) == prompt_runs.account_key_for(member)
    status = prompt_runs.status(_fresh(member))
    assert (status["scope"], status["used"], status["remaining"]) == ("organization", 5, 15)
    assert sum(status["by_engine"].values()) == 5
    use_runs(owner, 20, own_site)
    assert ask(member, member_site).error == prompt_runs.DENIAL


def test_an_organization_counts_by_calendar_month_even_for_a_member_with_a_cycle():
    owner = _user("cycle@example.com")
    _org(owner)
    with freeze_time("2026-11-20 12:00:00"):
        Subscription.objects.create(
            user=owner, plan=Plan.PROMPTS_100, status=SubscriptionStatus.ACTIVE,
            current_period_start=timezone.now() - timedelta(days=5),
            current_period_end=timezone.now() + timedelta(days=25),
        )
        account = prompt_runs.account_for(_fresh(owner))
        # The organization's free plan, not the member's own subscription.
        assert (account.scope, account.limit, account.plan) == ("organization", 20, "free")
        assert account.period_key == "2026-11-01"
        assert account.period_end.isoformat() == "2026-12-01T00:00:00+00:00"


def test_a_paid_organization_is_unlimited_for_its_members():
    owner, member = _user("paidorg@example.com"), _user("paidmember@example.com")
    _org(owner, member, plan=Plan.BUSINESS)
    for _ in range(25):
        assert prompt_runs.reserve(user=member, engine="gpt4", feature="audit").granted
    status = prompt_runs.status(_fresh(member))
    assert (status["unlimited"], status["limit"], status["remaining"], status["reserved"]) == (
        True, None, None, 25)


def test_with_organization_features_off_each_person_has_their_own_count(settings):
    settings.ORG_FEATURES_ENABLED = False
    owner, member = _user("off-owner@example.com"), _user("off-member@example.com")
    _org(owner, member, plan=Plan.BUSINESS)
    account = prompt_runs.account_for(member)
    assert (account.key, account.scope, account.limit) == (f"user:{member.pk}", "account", 20)


def _org_site(creator, org, name="Org project"):
    return Website.objects.create(user=creator, organization=org,
                                  url=f"https://{org.slug}.example", name=name)


def _leave(org, person):
    OrganizationMember.objects.filter(organization=org, user=person).delete()


def test_a_business_project_stays_unlimited_after_its_creator_leaves():
    creator, member = _user("creator@example.com"), _user("stays@example.com")
    org = _org(creator, member, plan=Plan.BUSINESS)
    site = _org_site(creator, org)
    _leave(org, creator)
    member = _fresh(member)
    for _ in range(21):
        assert ask(member, site).succeeded is True
    status = prompt_runs.status(member, site)
    assert (status["unlimited"], status["scope"], status["plan"]) == (
        True, "organization", "business")
    # Dollars stay visible to a paying organization.
    assert prompt_runs.is_limited(member, site) is False
    assert prompt_runs.shortfall(member, site, 500) is None


def test_a_free_organizations_project_counts_on_the_organization_after_its_creator_leaves():
    creator, member = _user("gone@example.com"), _user("left-behind@example.com")
    org = _org(creator, member, plan=Plan.FREE)
    site = _org_site(creator, org)
    _leave(org, creator)
    member, creator = _fresh(member), _fresh(creator)
    ask(member, site)
    ask(member, site, engine="claude")
    assert prompt_runs.account_key_for(member, site) == f"org:{org.id}"
    # The organization's one count, the same with or without the project...
    assert prompt_runs.status(member)["used"] == 2
    assert prompt_runs.status(member, site)["used"] == 2
    # ...and not the personal count of the person who left.
    assert prompt_runs.status(creator)["used"] == 0


def test_an_organization_project_follows_its_organization_not_the_creators_first_one():
    creator = _user("two-orgs@example.com")
    first = _org(creator, plan=Plan.FREE)
    second = Organization.objects.create(name="Beta", slug="beta-org", owner=creator,
                                         plan=Plan.BUSINESS)
    OrganizationMember.objects.create(organization=second, user=creator, role="owner")
    site = _org_site(creator, second)
    account = prompt_runs.account_for(_fresh(creator), site)
    assert (account.key, account.unlimited) == (f"org:{second.id}", True)
    # Without a project the creator's first organization still applies.
    assert prompt_runs.account_for(_fresh(creator)).key == f"org:{first.id}"


def test_an_organization_projects_plan_maps_legacy_and_unknown_values():
    creator = _user("legacy@example.com")
    org = _org(creator, plan=Plan.BUSINESS)
    site = _org_site(creator, org)
    Organization.objects.filter(id=org.id).update(plan="enterprise")
    account = prompt_runs.account_for(creator, Website.objects.get(id=site.id))
    assert (account.plan, account.unlimited) == ("business", True)
    Organization.objects.filter(id=org.id).update(plan="mystery")
    account = prompt_runs.account_for(creator, Website.objects.get(id=site.id))
    # An unrecognised plan grants nothing beyond the free plan.
    assert (account.plan, account.limit) == ("free", 20)


def test_with_organization_features_off_an_org_project_counts_on_its_creator(settings):
    settings.ORG_FEATURES_ENABLED = False
    creator = _user("off-creator@example.com")
    org = _org(creator, plan=Plan.BUSINESS)
    site = _org_site(creator, org)
    account = prompt_runs.account_for(creator, site)
    assert (account.key, account.scope, account.limit) == (f"user:{creator.pk}", "account", 20)


# -- what counts ---------------------------------------------------------------------------


def test_a_failure_that_carries_text_is_not_counted(user, website):
    ask(user, website, lambda: ProviderResult(succeeded=False, text="partial", error="cut off"))
    status = prompt_runs.status(user, website)
    assert (status["used"], status["remaining"]) == (0, 20)


def test_answered_reads_only_success_with_text():
    assert prompt_runs.answered(answer()) is True
    assert prompt_runs.answered(ProviderResult(succeeded=True, text="\n\t ")) is False
    assert prompt_runs.answered(ProviderResult(succeeded=True, text=None)) is False
    assert prompt_runs.answered(ProviderResult(succeeded=False, text="x")) is False
    assert prompt_runs.answered(None) is False


def test_is_denial_reads_only_the_prefix():
    assert prompt_runs.is_denial(prompt_runs.DENIAL) is True
    assert prompt_runs.is_denial("  PROMPT_RUNS_EXHAUSTED: used up") is True
    assert prompt_runs.is_denial("upstream said prompt_runs_exhausted") is False
    assert prompt_runs.is_denial(prompt_runs.CHECK_FAILED) is False
    assert prompt_runs.is_denial("") is False
    assert prompt_runs.is_denial(None) is False


def test_a_counted_run_is_never_given_back(user, website):
    reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                      feature="audit")
    prompt_runs.settle(reservation.run_id, answered=True)
    prompt_runs.settle(reservation.run_id, answered=False)
    assert PromptRun.objects.get(id=reservation.run_id).status == "counted"
    status = prompt_runs.status(user, website)
    assert (status["used"], status["remaining"]) == (1, 19)


def test_a_second_answered_settle_does_not_count_twice(user, website):
    reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                      feature="audit")
    prompt_runs.settle(reservation.run_id, answered=True)
    prompt_runs.settle(reservation.run_id, answered=True)
    assert counter_value(prompt_runs.account_for(user, website)) == 1


def test_settling_an_unknown_run_does_nothing(user, website):
    import uuid

    prompt_runs.settle(uuid.uuid4(), answered=True)
    prompt_runs.settle(uuid.uuid4(), answered=False)
    assert UsageCounter.objects.count() == 0


def test_a_release_never_takes_the_counter_below_zero(user, website):
    reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                      feature="audit")
    account = prompt_runs.account_for(user, website)
    UsageCounter.objects.filter(account_key=account.key).update(value=0)  # an operator reset
    prompt_runs.settle(reservation.run_id, answered=False)
    assert counter_value(account) == 0
    assert PromptRun.objects.get(id=reservation.run_id).status == "released"


def test_a_settle_that_fails_never_raises(user, website):
    reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                      feature="audit")
    with patch.object(prompt_runs, "settle", side_effect=RuntimeError("db gone")):
        reservation.settle(answered=True)
    # The reservation stays out until the sweep gives it back.
    assert prompt_runs.status(user, website)["reserved"] == 1


def test_the_engine_and_feature_are_stored_in_their_public_form(user, website):
    ask(user, website, engine="gpt4:gpt-5.5", feature="x" * 40)
    run = PromptRun.objects.get()
    assert (run.engine, run.feature, run.user, run.website) == ("chatgpt", "x" * 32, user, website)


# -- retries ---------------------------------------------------------------------------------


def test_a_retry_of_a_failed_call_is_refused_when_none_are_left(user, website):
    key = "audit:2:cell:0:gpt4"
    ask(user, website, failure, key=key)
    use_runs(user, 20, website)
    asked = []
    result = ask(user, website, lambda: asked.append(1) or answer(), key=key)
    assert (asked, result.error) == ([], prompt_runs.DENIAL)
    assert PromptRun.objects.get(idempotency_key=key).status == "released"
    assert counter_value(prompt_runs.account_for(user, website)) == 20


def test_a_retry_of_a_failed_call_takes_a_new_unit(user, website):
    key = "audit:3:cell:0:gpt4"
    ask(user, website, failure, key=key)
    assert counter_value(prompt_runs.account_for(user, website)) == 0
    reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                      feature="audit", idempotency_key=key)
    assert reservation.granted is True
    assert counter_value(prompt_runs.account_for(user, website)) == 1
    run = PromptRun.objects.get(idempotency_key=key)
    assert (run.status, run.settled_at) == ("reserved", None)


def test_a_retry_of_a_counted_call_is_free_even_with_none_left(user, website):
    key = "audit:4:cell:0:gpt4"
    ask(user, website, key=key)
    use_runs(user, 20, website)
    assert ask(user, website, key=key).succeeded is True
    assert prompt_runs.status(user, website)["used"] == 1


def test_a_long_key_is_cut_to_fit_and_still_counted_once(user, website):
    key = "audit:" + "a" * 300
    for _ in range(3):
        assert ask(user, website, key=key).succeeded is True
    run = PromptRun.objects.get()
    assert run.idempotency_key == key[:128]
    assert prompt_runs.status(user, website)["used"] == 1


def test_an_empty_key_is_no_key(user, website):
    ask(user, website, key="")
    ask(user, website, key="")
    assert prompt_runs.status(user, website)["used"] == 2
    assert list(PromptRun.objects.values_list("idempotency_key", flat=True)) == [None, None]


# -- the stale sweep ---------------------------------------------------------------------------


def _age(reservation, minutes):
    PromptRun.objects.filter(id=reservation.run_id).update(
        created_at=timezone.now() - timedelta(minutes=minutes))


def test_the_sweep_takes_its_window_from_the_argument(user, website, settings):
    settings.PROMPT_RUN_STALE_MINUTES = 30
    ten = prompt_runs.reserve(user=user, website=website, engine="gpt4", feature="audit")
    _age(ten, 10)
    assert prompt_runs.release_stale() == 0
    assert prompt_runs.release_stale(older_than_minutes=5) == 1
    assert prompt_runs.status(user, website)["remaining"] == 20


def test_a_zero_stale_window_still_spares_a_call_just_made(user, website, settings):
    settings.PROMPT_RUN_STALE_MINUTES = 0
    assert prompt_runs.stale_minutes() == 1
    prompt_runs.reserve(user=user, website=website, engine="gpt4", feature="audit")
    assert prompt_runs.release_stale() == 0
    assert prompt_runs.status(user, website)["reserved"] == 1


def test_a_run_answered_while_the_sweep_runs_is_not_given_back(user, website):
    reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                      feature="audit")
    _age(reservation, 60)
    real_atomic = transaction.atomic
    raced = []

    def atomic_after_the_answer(*args, **kwargs):
        # The answer settles between the sweep's listing and its lock.
        if not raced:
            raced.append(1)
            prompt_runs.settle(reservation.run_id, answered=True)
        return real_atomic(*args, **kwargs)

    with patch.object(transaction, "atomic", atomic_after_the_answer):
        released = prompt_runs.release_stale()
    assert released == 0
    assert PromptRun.objects.get(id=reservation.run_id).status == "counted"
    status = prompt_runs.status(user, website)
    assert (status["used"], status["remaining"]) == (1, 19)


def test_a_late_answer_past_the_limit_is_counted_and_remaining_stays_at_zero(user, website):
    use_runs(user, 19, website)
    late = prompt_runs.reserve(user=user, website=website, engine="gpt4", feature="audit")
    _age(late, 60)
    assert prompt_runs.release_stale() == 1
    # The unit the sweep gave back is taken by another call...
    other = prompt_runs.reserve(user=user, website=website, engine="claude", feature="audit")
    assert other.granted is True
    # ...and then the late answer arrives: it is real, so it counts.
    late.settle(answered=True)
    account = prompt_runs.account_for(user, website)
    assert counter_value(account) == 21
    status = prompt_runs.status(user, website)
    assert (status["used"], status["reserved"], status["remaining"]) == (1, 1, 0)
    assert prompt_runs.available(user, website, 1) == (False, 0)
    block = prompt_runs.estimate_block(user, website, 1)
    assert (block["remaining"], block["enough"]) == (0, False)
    assert prompt_runs.shortfall(user, website, 1)["details"]["remaining"] == 0


# -- the pre-checks at the limit -----------------------------------------------------------------


def test_available_and_enough_at_exactly_the_runs_left(user, website):
    use_runs(user, 17, website)
    assert prompt_runs.available(user, website, 3) == (True, 3)
    assert prompt_runs.available(user, website, 4) == (False, 3)
    assert prompt_runs.available(user, website, 0) == (True, 3)
    assert prompt_runs.available(user, website, -2) == (True, 3)
    assert prompt_runs.estimate_block(user, website, 3)["enough"] is True
    assert prompt_runs.estimate_block(user, website, 4)["enough"] is False
    assert prompt_runs.shortfall(user, website, 3) is None
    assert prompt_runs.shortfall(user, website, 4)["code"] == "insufficient_prompt_runs"


def test_nothing_needed_is_never_short_even_with_none_left(user, website):
    use_runs(user, 20, website)
    assert prompt_runs.shortfall(user, website, 0) is None
    assert prompt_runs.shortfall(user, website, -3) is None
    assert prompt_runs.available(user, website, 0) == (True, 0)


def test_require_carries_the_details(user, website):
    use_runs(user, 18, website)
    with pytest.raises(CanseeException) as caught:
        prompt_runs.require(user, website, 5)
    err = caught.value
    assert (err.code, err.status_code) == ("insufficient_prompt_runs", 403)
    assert err.details == {"needed": 5, "remaining": 2, "limit": 20,
                           "resets_at": prompt_runs.account_for(user, website)
                           .period_end.isoformat()}


# -- unattributed and failing lookups ---------------------------------------------------------------


def test_an_unattributed_account_reads_as_unlimited():
    assert prompt_runs.account_for(None) is None
    assert prompt_runs.limit_for(None) == -1
    assert prompt_runs.account_key_for(None) == ""
    assert prompt_runs.is_limited(None) is False
    assert prompt_runs.available(None) == (True, None)
    assert prompt_runs.shortfall(None, None, 50) is None
    prompt_runs.require(None, None, 50)
    status = prompt_runs.status(None)
    assert {k: status[k] for k in ("unlimited", "limit", "used", "reserved", "remaining",
                                   "plan", "scope", "by_engine", "by_feature")} == {
        "unlimited": True, "limit": None, "used": 0, "reserved": 0, "remaining": None,
        "plan": "", "scope": "account", "by_engine": {}, "by_feature": {},
    }
    assert status["period_start"] and status["resets_at"]


def test_a_project_without_an_owner_counts_on_the_caller(user):
    site = Website(url="https://orphan.example", name="Orphan")
    assert prompt_runs.owner_for(user, site) == user
    assert prompt_runs.account_key_for(user, site) == f"user:{user.pk}"


def test_a_failed_account_lookup_denies_the_engine_call(user, website):
    with patch.object(prompt_runs, "account_for", side_effect=RuntimeError("db gone")):
        asked = []
        result = ask(user, website, lambda: asked.append(1) or answer())
        assert (asked, result.succeeded) == ([], False)
        assert result.error == prompt_runs.CHECK_FAILED
        assert prompt_runs.is_limited(user, website) is False


def test_a_reserve_that_keeps_colliding_is_denied(user, website):
    # Both attempts lose the race on the key and find no winner to reuse.
    with patch.object(PromptRun.objects, "create", side_effect=IntegrityError("dup")):
        reservation = prompt_runs.reserve(user=user, website=website, engine="gpt4",
                                          feature="audit", idempotency_key="k:1")
    assert (reservation.granted, reservation.denial) == (False, prompt_runs.CHECK_FAILED)
    # The units the two attempts took were rolled back with them.
    assert counter_value(prompt_runs.account_for(user, website)) == 0


def test_a_database_error_on_a_paid_account_is_not_recorded(user, website):
    from django.db import DatabaseError

    make_paid(user)
    with patch.object(prompt_runs, "_take_unit", side_effect=DatabaseError("down")):
        result = ask(user, website)
    assert result.succeeded is True
    assert PromptRun.objects.count() == 0


def test_the_rows_name_themselves(user, website):
    ask(user, website)
    run = PromptRun.objects.get()
    counter = UsageCounter.objects.get(meter="prompt_runs")
    assert str(run) == f"PromptRun(counted chatgpt audit user:{user.pk})"
    assert str(counter) == f"UsageCounter(prompt_runs user:{user.pk} {counter.period_key}=1)"


def test_a_subscription_that_cannot_be_read_falls_back_to_the_calendar_month():
    from types import SimpleNamespace

    from apps.metering.services.periods import billing_period_for

    class Broken:
        status = SubscriptionStatus.ACTIVE

        @property
        def current_period_start(self):
            raise RuntimeError("db gone")

    with freeze_time("2026-11-20 12:00:00"):
        period = billing_period_for(SimpleNamespace(subscription=Broken()))
    assert (period.source, period.key) == ("calendar", "2026-11-01")
