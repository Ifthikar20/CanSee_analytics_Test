"""Who gets the daily text, and when (contract 5c): only the project's
verified, consenting number, outside quiet hours, once a day, retried once
only when Twilio answered 429 or 5xx; superseded, consent_needed, no_access,
opted_out and the allowance notice once per billing period."""

from datetime import UTC, datetime, time, timedelta

import pytest
import requests
from django.utils import timezone

from apps.autopilot.models import Autopilot, AutopilotRun
from apps.autopilot.services import pipeline, text
from apps.autopilot.services import settings as autopilot_settings
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import (
    BRAND,
    join_org,
    make_autopilot,
    make_prompt,
    make_run,
    make_user,
    verified_number,
)
from apps.notifications.models import SmsSubscription
from apps.notifications.services import sms_service

pytestmark = pytest.mark.django_db

PHONE = "+14155550123"
BODY = f"Cansee daily, {BRAND}: 9 prompts, 2 engines. AI $0.36. Reply STOP to end"


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


@pytest.fixture
def number(user):
    return verified_number(user, PHONE, consented_at=timezone.now() - timedelta(days=2))


@pytest.fixture
def texting(website, number, twilio):
    """Autopilot with the daily text on to the owner's number, agreed now."""
    return make_autopilot(
        website, sms_digest=True, sms_subscription=number, sms_consented_at=timezone.now(),
        sms_consent_version="digest-v1", timezone="America/New_York",
        quiet_start=time(21, 0), quiet_end=time(8, 0),
    )


def waiting_run(website, due, **fields) -> AutopilotRun:
    values = {"text_status": "waiting", "text_due_at": due, "text_body": BODY,
              "text_template": "A", "text_segments": 1}
    values.update(fields)
    return make_run(website, **values)


def state(run) -> tuple:
    run.refresh_from_db()
    return run.text_status, run.text_reason


# -- delivery -------------------------------------------------------------------------------


def test_a_due_text_goes_to_the_number_once(website, texting, twilio):
    now = utc(2026, 11, 4, 15, 0)              # 10:00 in New York
    run = waiting_run(website, now)
    assert text.deliver_text(run.id, now=now) == "sent"
    assert state(run) == ("sent", "")
    run.refresh_from_db()
    assert run.text_sent_at is not None and run.text_attempts == 1
    assert twilio.sent == [{"url": twilio.sent[0]["url"], "to": PHONE, "body": BODY}]
    # A second worker finds it taken.
    assert text.deliver_text(run.id, now=now) == "not_due"
    assert len(twilio.sent) == 1


def test_a_text_not_yet_due_waits(website, texting, twilio):
    now = utc(2026, 11, 4, 15, 0)
    run = waiting_run(website, now + timedelta(minutes=1))
    assert text.deliver_text(run.id, now=now) == "not_due"
    assert state(run) == ("waiting", "") and twilio.sent == []


def test_quiet_hours_hold_the_text_until_they_end(website, texting, twilio):
    early = utc(2026, 11, 4, 12, 30)           # 07:30 in New York, quiet until 08:00
    run = waiting_run(website, early)
    assert text.deliver_text(run.id, now=early) == "waiting"
    run.refresh_from_db()
    assert run.text_status == "waiting" and run.text_due_at == utc(2026, 11, 4, 13, 0)
    assert twilio.sent == [] and run.text_attempts == 0
    assert text.deliver_text(run.id, now=utc(2026, 11, 4, 13, 0)) == "sent"
    late = utc(2026, 11, 5, 3, 0)              # 22:00: waits for 08:00 the next morning
    other = waiting_run(website, late, local_date=late.date() + timedelta(days=1))
    Autopilot.objects.filter(id=texting.id).update(quiet_start=time(21, 0))
    text.deliver_text(other.id, now=late)
    other.refresh_from_db()
    assert other.text_due_at == utc(2026, 11, 5, 13, 0)


def test_quiet_hours_within_one_day(website, texting):
    texting.quiet_start, texting.quiet_end = time(12, 0), time(13, 30)
    assert autopilot_settings.in_quiet_hours(texting, utc(2026, 11, 4, 17, 15))
    assert not autopilot_settings.in_quiet_hours(texting, utc(2026, 11, 4, 18, 30))
    assert autopilot_settings.quiet_end_after(texting, utc(2026, 11, 4, 17, 15)) == \
        utc(2026, 11, 4, 18, 30)


def test_a_newer_run_supersedes_a_waiting_text(website, texting, twilio):
    now = utc(2026, 11, 4, 15, 0)
    run = waiting_run(website, now, local_date=now.date() - timedelta(days=1),
                      created_at=timezone.now() - timedelta(days=1))
    make_run(website, local_date=now.date())
    assert text.deliver_text(run.id, now=now) == "skipped"
    assert state(run) == ("skipped", "superseded") and twilio.sent == []


@pytest.mark.parametrize(("answers", "outcome", "posts"), [
    ([500, 201], "sent", 2),
    ([429, 429], "failed", 2),
    ([503, 400], "failed", 2),
    ([400], "failed", 1),
    ([requests.Timeout("slow")], "failed", 1),
    ([requests.ConnectionError("lost")], "failed", 1),
])
def test_a_send_is_retried_once_only_on_429_or_5xx(website, texting, twilio, answers, outcome,
                                                   posts):
    now = utc(2026, 11, 4, 15, 0)
    run = waiting_run(website, now)
    twilio.statuses = list(answers)
    first = text.deliver_text(run.id, now=now)
    if len(answers) > 1 and answers[0] in (429, 500, 503):
        assert first == "waiting"
        run.refresh_from_db()
        assert run.text_status == "waiting"
        assert run.text_due_at == now + timedelta(minutes=5)
        later = run.text_due_at
        text.deliver_text(run.id, now=later)
    assert state(run)[0] == outcome
    assert len(twilio.sent) == posts
    run.refresh_from_db()
    assert run.text_attempts == posts <= 2


@pytest.mark.parametrize(("change", "reason"), [
    ({"status": SmsSubscription.Status.OPTED_OUT}, "opted_out"),
    ({"status": SmsSubscription.Status.PENDING}, "not_verified"),
])
def test_a_number_that_cannot_be_texted(website, texting, twilio, number, change, reason):
    SmsSubscription.objects.filter(id=number.id).update(**change)
    now = utc(2026, 11, 4, 15, 0)
    run = waiting_run(website, now)
    text.deliver_text(run.id, now=now)
    assert state(run) == ("skipped", reason) and twilio.sent == []


def test_sms_off_on_the_server(website, texting, twilio, settings):
    settings.SMS_ENABLED = False
    now = utc(2026, 11, 4, 15, 0)
    run = waiting_run(website, now)
    text.deliver_text(run.id, now=now)
    assert state(run) == ("skipped", "unavailable") and twilio.sent == []


def test_a_number_verified_again_needs_a_new_agreement(website, texting, twilio, number):
    SmsSubscription.objects.filter(id=number.id).update(
        consented_at=texting.sms_consented_at + timedelta(minutes=5))
    now = utc(2026, 11, 4, 15, 0)
    run = waiting_run(website, now)
    text.deliver_text(run.id, now=now)
    assert state(run) == ("skipped", "consent_needed")
    # START keeps consented_at, so it resumes the text.
    SmsSubscription.objects.filter(id=number.id).update(consented_at=texting.sms_consented_at)
    number.refresh_from_db()
    sms_service.handle_keyword([number], "STOP")
    sms_service.handle_keyword([number], "START")
    other = waiting_run(website, now, local_date=now.date() + timedelta(days=1))
    assert text.deliver_text(other.id, now=now) == "sent"


def test_the_owner_of_the_number_must_still_open_the_project(website, user, twilio):
    member = make_user("member@example.com")
    org = join_org(website, user, {member: "viewer"})
    sub = verified_number(member, "+14155550999")
    make_autopilot(website, sms_digest=True, sms_subscription=sub,
                   sms_consented_at=timezone.now(), timezone="UTC",
                   quiet_start=time(0, 0), quiet_end=time(0, 15))
    now = utc(2026, 11, 4, 15, 0)
    run = waiting_run(website, now)
    assert text.deliver_text(run.id, now=now) == "sent"
    org.members.filter(user=member).delete()
    other = waiting_run(website, now, local_date=now.date() + timedelta(days=1))
    text.deliver_text(other.id, now=now)
    assert state(other) == ("skipped", "no_access")


def test_logs_carry_the_run_but_not_the_body_or_the_number(website, texting, twilio, caplog):
    import logging

    now = utc(2026, 11, 4, 15, 0)
    run = waiting_run(website, now)
    apps_logger = logging.getLogger("apps")
    apps_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level("INFO", logger="apps"):
            text.deliver_text(run.id, now=now)
    finally:
        apps_logger.removeHandler(caplog.handler)
    assert str(run.id) in caplog.text and "segments" in caplog.text
    assert BODY not in caplog.text and PHONE not in caplog.text


# -- the state a finished run's text gets -------------------------------------------------


def test_a_finished_run_texts_after_it_ends(website, texting, twilio, engines, monkeypatch):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    monkeypatch.setattr(autopilot_settings, "in_quiet_hours", lambda autopilot, now=None: False)
    est = pipeline.run_estimate(website, website.user)
    run = pipeline.create_manual_run(website, website.user, est["confirm"])
    run.refresh_from_db()
    assert (run.status, run.text_status) == ("done", "sent")
    assert twilio.sent[-1]["body"] == run.text_body
    assert run.text_body.startswith(f"Cansee daily, {BRAND}, first run:")
    assert run.text_segments == sms_service.segments(run.text_body)
    detail = pipeline.run_detail(run)
    assert detail["text_body"] == run.text_body and detail["text"]["status"] == "sent"


def test_no_text_without_the_digest_or_with_no_text(website, engines):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    est = pipeline.run_estimate(website, website.user)
    run = pipeline.create_manual_run(website, website.user, est["confirm"])
    run.refresh_from_db()
    assert run.text_status == "not_requested" and run.text_body


def test_the_allowance_notice_goes_once_per_billing_period(website, texting, twilio, user,
                                                           monkeypatch, engines):
    from decimal import Decimal

    from apps.accounts.models import AITokenUsage

    engines.enable("claude")
    monkeypatch.setattr(autopilot_settings, "in_quiet_hours", lambda autopilot, now=None: False)
    make_prompt(website, "best notes app")
    AITokenUsage.objects.create(user=user, module="llm_ranking", model_name="x",
                                estimated_cost_usd=Decimal("2.00"), metadata={})
    first = AutopilotRun.objects.create(website=website, local_date=timezone.now().date(),
                                        status="running", started_at=timezone.now())
    pipeline.drive(first.id)
    first.refresh_from_db()
    assert (first.status, first.text_template, first.text_status) == ("skipped", "D", "sent")
    texting.refresh_from_db()
    period = autopilot_settings.allowance_state(user)["period"]
    assert texting.allowance_notice_period == period.key
    second = AutopilotRun.objects.create(
        website=website, local_date=timezone.now().date() + timedelta(days=1), status="running",
        started_at=timezone.now(),
    )
    pipeline.drive(second.id)
    assert state(second) == ("skipped", "notice_sent")
    assert len(twilio.sent) == 1


def test_a_text_too_long_is_never_sent(website, texting, twilio, monkeypatch):
    run = make_run(website, answers_answered=1, answers_named=1, prompts_done=1,
                   prompts_planned=1)

    def too_long(run):
        raise text.TextTooLong("301 septets")

    monkeypatch.setattr(text, "build_text", too_long)
    text.prepare_text(run)
    assert state(run) == ("failed", "")
    assert twilio.sent == []
