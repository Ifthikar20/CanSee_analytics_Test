"""Autopilot settings (contract 3a and 3b): the payload, every validation
word, the plan gate, the consent record of the daily text (only the number's
owner turns it on for their number, anyone can turn it off), and template F
at most once in 24 hours."""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import AITokenUsage
from apps.autopilot.models import Autopilot
from apps.autopilot.services import settings as autopilot_settings
from apps.autopilot.services import text
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import (
    BRAND,
    client_for,
    data,
    error,
    join_org,
    make_autopilot,
    make_prompt,
    make_run,
    make_user,
    verified_number,
)
from apps.metering.services.periods import billing_period_for
from apps.notifications.models import SmsSubscription

pytestmark = pytest.mark.django_db

CONSENT = (
    "I agree to receive one automated text a day from Cansee about Notion at this number. "
    "Msg & data rates may apply. Reply STOP to cancel or HELP for help. Consent is not a "
    "condition of purchase."
)


@pytest.fixture
def url(website):
    return reverse("autopilot-settings", kwargs={"website_id": website.id})


def put(api, url, body):
    return api.put(url, body, format="json")


def refused(resp, status=400) -> dict:
    assert resp.status_code == status, resp.content
    return error(resp)


# -- the payload ------------------------------------------------------------------------


def test_nothing_saved_answers_the_defaults(api, url, website, user):
    assert url == f"/api/v1/autopilot/websites/{website.id}/"
    got = data(api.get(url))
    period = billing_period_for(user)
    assert got["available"] is True and got["saved"] is False
    assert got["plan"] == {"id": "business", "name": "Business", "autopilot": True,
                           "sms_digest": True}
    assert got["tracked"] == {"limit": -1, "used": 0, "over_limit": 0}
    assert got["settings"] == {
        "enabled": False, "run_time": "07:00", "timezone": "UTC", "run_engines": True,
        "run_google": True, "google_cadence": "weekly", "run_analysis": True,
        "sms_digest": False, "sms_subscription_id": None, "quiet_start": "21:00",
        "quiet_end": "08:00", "paused_reason": "",
    }
    assert [e["key"] for e in got["engines"]] == ["chatgpt", "claude", "gemini", "grok",
                                                  "perplexity"]
    assert not any(e["configured"] for e in got["engines"])
    assert got["google"] == {"configured": False, "provider_label": None,
                             "credits_per_page": None}
    assert got["sms"] == {"available": False, "numbers": [], "recipient": None,
                          "consent_text": CONSENT, "consent_version": "digest-v1"}
    assert got["allowance"] == {
        "unlimited": False, "cap_usd": "1.00", "spent_usd": "0.00", "left_usd": "1.00",
        "reserve_pct": 10, "resets_on": period.end.date().isoformat(),
    }
    assert got["cost"] == {"last_run": None, "month_projection_usd": None,
                           "runs_out_on": None,
                           "bound": {"ai_usd_max": "0.0000", "google_pages_max": 0}}
    assert (got["next_run_at"], got["today_run"], got["runs"]) == (None, None, [])


def test_the_google_cadence_default_is_one_setting(api, url, settings):
    settings.AUTOPILOT_GOOGLE_CADENCE = "daily"
    assert data(api.get(url))["settings"]["google_cadence"] == "daily"


def test_cost_lines_from_the_last_run(api, url, website, user, engines, serp):
    engines.enable("chatgpt", "claude")
    make_prompt(website, "best notes app")
    make_prompt(website, "best wiki app")
    bound = data(api.get(url))["cost"]["bound"]
    assert bound == {"ai_usd_max": "0.1200", "google_pages_max": 2}
    make_run(website, ai_cost_usd=Decimal("0.0500"), answers_asked=4, google_pages=2,
             plan={"google_provider": "scraperapi"})
    AITokenUsage.objects.create(user=user, module="llm_ranking", model_name="x",
                                estimated_cost_usd=Decimal("0.80"), metadata={})
    cost = data(api.get(url))["cost"]
    days = round((billing_period_for(user).end - billing_period_for(user).start).days)
    assert cost["last_run"] == {"ai_usd": "0.0500", "answers": 4, "google_pages": 2,
                                "credits": 50}
    assert cost["month_projection_usd"] == str((Decimal("0.05") * days).quantize(Decimal("0.01")))
    # $0.10 left under the line at $0.05 a day: out in 2 days, unless the
    # allowance resets first.
    out = timezone.now().date() + timedelta(days=2)
    expected = out.isoformat() if out < billing_period_for(user).end.date() else None
    assert cost["runs_out_on"] == expected


def test_runs_and_todays_run_in_the_payload(api, url, website):
    autopilot = make_autopilot(website, timezone="UTC")
    today = autopilot_settings.local_today(autopilot)
    for days in range(9):
        make_run(website, local_date=today - timedelta(days=days),
                 created_at=timezone.now() - timedelta(days=days))
    got = data(api.get(url))
    assert got["saved"] is True and len(got["runs"]) == 7
    assert got["today_run"]["local_date"] == today.isoformat()
    assert got["runs"][0]["id"] == got["today_run"]["id"]


# -- validation ---------------------------------------------------------------------------


@pytest.mark.parametrize(("body", "field", "message"), [
    ({"run_time": "07:10"}, "run_time", "Choose a time on the quarter hour, like 07:00."),
    ({"run_time": "7am"}, "run_time", "Choose a time on the quarter hour, like 07:00."),
    ({"quiet_start": "24:00"}, "quiet_start", "Choose a time on the quarter hour, like 07:00."),
    ({"quiet_end": None}, "quiet_end", "Choose a time on the quarter hour, like 07:00."),
    ({"timezone": "Mars/Olympus"}, "timezone", "Choose a time zone from the list."),
    ({"timezone": 5}, "timezone", "Choose a time zone from the list."),
    ({"google_cadence": "hourly"}, "google_cadence", "Choose every day or once a week."),
    ({"quiet_start": "08:00", "quiet_end": "08:00"}, "quiet_end",
     "Quiet hours need a start and an end that differ."),
    ({"enabled": True, "run_engines": False, "run_google": False, "run_analysis": False},
     "enabled", "Choose at least one thing for Autopilot to run."),
    ({"enabled": "yes"}, "enabled", "enabled must be true or false."),
    ({"sms_digest": True}, "sms_subscription_id", "Choose a mobile number you verified."),
])
def test_every_invalid_field_is_refused_in_the_contract_words(api, url, sms_on, body, field,
                                                              message):
    err = refused(put(api, url, body))
    assert (err["code"], err["message"]) == ("invalid", message)
    assert err["details"] == {"field": field, "message": message}
    assert not Autopilot.objects.exists()


def test_a_valid_save_answers_the_payload(api, url, website, user):
    got = data(put(api, url, {
        "enabled": True, "run_time": "06:45", "timezone": "Europe/Paris",
        "google_cadence": "daily", "run_analysis": False, "quiet_start": "22:00",
        "quiet_end": "07:15",
    }))
    assert got["saved"] is True
    assert got["settings"] | {} == {
        "enabled": True, "run_time": "06:45", "timezone": "Europe/Paris", "run_engines": True,
        "run_google": True, "google_cadence": "daily", "run_analysis": False,
        "sms_digest": False, "sms_subscription_id": None, "quiet_start": "22:00",
        "quiet_end": "07:15", "paused_reason": "",
    }
    autopilot = Autopilot.objects.get(website=website)
    assert autopilot.updated_by == user
    assert got["next_run_at"] is not None


def test_turning_it_on_needs_the_plan(api, url, settings):
    settings.PAYWALL_ENABLED = True
    err = refused(put(api, url, {"enabled": True}), 403)
    assert (err["code"], err["message"]) == (
        "plan_required", "Autopilot is part of the 100 and 200 prompt plans.")
    # Saving it off is fine.
    assert data(put(api, url, {"run_time": "08:00"}))["settings"]["enabled"] is False


def test_turning_it_back_on_after_a_pause_starts_again(api, url, website):
    make_autopilot(website, enabled=False, paused_reason="failures", consecutive_failures=3)
    got = data(put(api, url, {"enabled": True}))
    assert got["settings"]["paused_reason"] == ""
    assert Autopilot.objects.get(website=website).consecutive_failures == 0


# -- the daily text -----------------------------------------------------------------------


def test_the_text_needs_sms_on_the_server(api, url, user):
    number = verified_number(user)
    err = refused(put(api, url, {"sms_digest": True, "sms_subscription_id": str(number.id),
                                 "sms_consent": True}), 503)
    assert (err["code"], err["message"]) == (
        "sms_unavailable", "Text messaging isn't configured on this deployment.")


def test_the_text_needs_the_agreement(api, url, user, twilio):
    number = verified_number(user)
    err = refused(put(api, url, {"sms_digest": True, "sms_subscription_id": str(number.id)}))
    assert err["details"] == {
        "field": "sms_consent",
        "message": "Agree to the text message terms to turn on the daily text.",
    }
    assert twilio.sent == []


def test_turning_the_text_on_stores_the_consent_and_texts_f_once(
        api, url, website, user, twilio, django_capture_on_commit_callbacks):
    number = verified_number(user)
    body = {"sms_digest": True, "sms_subscription_id": str(number.id), "sms_consent": True}
    with django_capture_on_commit_callbacks(execute=True):
        got = data(put(api, url, body))
    autopilot = Autopilot.objects.get(website=website)
    assert (autopilot.sms_subscription_id, autopilot.sms_consent_version) == (number.id,
                                                                              "digest-v1")
    assert autopilot.sms_consented_at is not None and autopilot.sms_consent_ip == "127.0.0.1"
    assert autopilot.sms_optin_sent_at is not None
    assert [m["body"] for m in twilio.sent] == [text.optin_text(website)]
    assert got["sms"]["recipient"] == {"id": str(number.id), "phone_masked": "•••-•••-0123",
                                       "status": "verified", "set_by_name": "Ifthikar"}
    assert got["sms"]["numbers"] == [{"id": str(number.id), "phone_masked": "•••-•••-0123",
                                      "yours": True}]

    # Off and on again within 24 hours: a new consent record, no second F.
    with django_capture_on_commit_callbacks(execute=True):
        data(put(api, url, {"sms_digest": False}))
    with django_capture_on_commit_callbacks(execute=True):
        data(put(api, url, body))
    again = Autopilot.objects.get(website=website)
    assert again.sms_consented_at > autopilot.sms_consented_at
    assert len(twilio.sent) == 1

    # A day later F goes again.
    Autopilot.objects.filter(id=again.id).update(
        sms_optin_sent_at=timezone.now() - timedelta(hours=25))
    with django_capture_on_commit_callbacks(execute=True):
        data(put(api, url, {"sms_digest": False}))
    with django_capture_on_commit_callbacks(execute=True):
        data(put(api, url, body))
    assert len(twilio.sent) == 2


def test_a_new_number_clears_the_opt_in_and_texts_f_to_it(
        api, url, website, user, twilio, django_capture_on_commit_callbacks):
    first = verified_number(user)
    second = verified_number(user, "+14155550777")
    # Each request commits on its own.
    with django_capture_on_commit_callbacks(execute=True):
        data(put(api, url, {"sms_digest": True, "sms_subscription_id": str(first.id),
                            "sms_consent": True}))
    with django_capture_on_commit_callbacks(execute=True):
        data(put(api, url, {"sms_subscription_id": str(second.id), "sms_consent": True}))
    assert [m["to"] for m in twilio.sent] == ["+14155550123", "+14155550777"]
    # Changing the number while the text is on needs the agreement again.
    err = refused(put(api, url, {"sms_subscription_id": str(first.id)}))
    assert err["details"]["field"] == "sms_consent"


def test_only_your_own_verified_number(api, url, user, twilio):
    other = make_user("other@example.com")
    theirs = verified_number(other, "+14155550555")
    pending = verified_number(user, "+14155550666", status=SmsSubscription.Status.PENDING)
    for number in (theirs, pending):
        err = refused(put(api, url, {"sms_digest": True, "sms_subscription_id": str(number.id),
                                     "sms_consent": True}))
        assert err["details"] == {"field": "sms_subscription_id",
                                  "message": "Choose a mobile number you verified."}
    err = refused(put(api, url, {"sms_digest": True, "sms_subscription_id": "not-a-uuid",
                                 "sms_consent": True}))
    assert err["details"]["field"] == "sms_subscription_id"


def test_another_member_can_turn_the_text_off_but_not_on(
        url, website, user, twilio, django_capture_on_commit_callbacks):
    member = make_user("member@example.com", "Maya")
    viewer = make_user("viewer@example.com")
    join_org(website, user, {member: "member", viewer: "viewer"})
    owner_number = verified_number(user)
    member_number = verified_number(member, "+14155550444")
    owner, mate = client_for(user), client_for(member)
    with django_capture_on_commit_callbacks(execute=True):
        data(put(owner, url, {"sms_digest": True, "sms_subscription_id": str(owner_number.id),
                              "sms_consent": True}))

    # Someone else's number is shown, not offered.
    got = data(mate.get(url))
    assert got["sms"]["recipient"]["set_by_name"] == "Ifthikar"
    assert [n["id"] for n in got["sms"]["numbers"]] == [str(member_number.id)]
    # Other settings save without touching the recipient.
    assert data(put(mate, url, {"run_time": "09:00"}))["settings"]["sms_digest"] is True
    # Off: allowed. On again for the owner's number: refused.
    assert data(put(mate, url, {"sms_digest": False}))["settings"]["sms_digest"] is False
    err = refused(put(mate, url, {"sms_digest": True, "sms_consent": True}))
    assert err["details"]["message"] == "Choose a mobile number you verified."
    # On for their own number, with their own agreement.
    with django_capture_on_commit_callbacks(execute=True):
        got = data(put(mate, url, {"sms_digest": True,
                                   "sms_subscription_id": str(member_number.id),
                                   "sms_consent": True}))
    assert got["sms"]["recipient"]["set_by_name"] == "Maya"
    assert twilio.sent[-1]["to"] == "+14155550444"
    # A viewer reads but cannot write (403); a stranger gets 404.
    assert client_for(viewer).get(url).status_code == 200
    assert put(client_for(viewer), url, {"sms_digest": False}).status_code == 403
    assert client_for(make_user("x@example.com")).get(url).status_code == 404


def test_the_owner_agrees_again_after_verifying_the_number_anew(
        api, url, website, user, twilio, django_capture_on_commit_callbacks):
    number = verified_number(user)
    with django_capture_on_commit_callbacks(execute=True):
        data(put(api, url, {"sms_digest": True, "sms_subscription_id": str(number.id),
                            "sms_consent": True}))
    first = Autopilot.objects.get(website=website).sms_consented_at
    SmsSubscription.objects.filter(id=number.id).update(consented_at=timezone.now())
    with django_capture_on_commit_callbacks(execute=True):
        data(put(api, url, {"sms_consent": True}))
    assert Autopilot.objects.get(website=website).sms_consented_at > first


def test_the_test_text(website, user, twilio):
    url = reverse("autopilot-text-test", kwargs={"website_id": website.id})
    api = client_for(user)
    err = refused(api.post(url), 400)
    assert (err["code"], err["message"]) == ("not_verified", "Verify this number first.")
    number = verified_number(user)
    make_autopilot(website, sms_digest=True, sms_subscription=number,
                   sms_consented_at=timezone.now())
    got = data(api.post(url))
    assert got == {"sent": True, "phone_masked": "•••-•••-0123"}
    assert twilio.sent[-1]["body"] == text.trial_text(website)
    err = refused(api.post(url), 429)
    assert (err["code"], err["message"]) == (
        "too_many_tests", "You can send another test text in a few minutes.")
    assert len(twilio.sent) == 1


def test_a_failed_test_text_can_be_tried_again(website, user, twilio):
    url = reverse("autopilot-text-test", kwargs={"website_id": website.id})
    number = verified_number(user)
    make_autopilot(website, sms_digest=True, sms_subscription=number)
    twilio.statuses = [500]
    err = refused(client_for(user).post(url), 502)
    assert err["code"] == "send_failed"
    assert data(client_for(user).post(url))["sent"] is True


def test_the_test_text_needs_sms_on_the_server(website, user):
    url = reverse("autopilot-text-test", kwargs={"website_id": website.id})
    number = verified_number(user)
    make_autopilot(website, sms_digest=True, sms_subscription=number)
    err = refused(client_for(user).post(url), 503)
    assert err["code"] == "sms_unavailable"


def test_the_consent_text_names_the_project(website):
    assert autopilot_settings.consent_text(website) == CONSENT.replace("Notion", BRAND)
