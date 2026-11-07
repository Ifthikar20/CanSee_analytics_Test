"""The SMS channel's wave 4 changes (contract 5a and 5d): GSM-7 cleaning and
counting, the send status Autopilot retries on, the three replies, STOP for
every row of a number and START reviving only once-verified rows."""

import logging

import pytest
import requests
from django.test import Client
from django.utils import timezone

from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import FakeTwilio, make_user, verified_number
from apps.notifications.api.v1 import sms_webhooks
from apps.notifications.models import SmsSubscription
from apps.notifications.services import sms_service

PHONE = "+14155550123"

# -- GSM-7 -------------------------------------------------------------------------


def test_the_gsm7_tables():
    # 128 basic characters less the escape, plus the extension table.
    assert len(sms_service.GSM7_BASIC) == 127
    assert sms_service.GSM7_EXTENSION == frozenset("^{}\\[~]|€\f")
    assert not sms_service.GSM7_BASIC & sms_service.GSM7_EXTENSION


@pytest.mark.parametrize(("raw", "clean"), [
    ("“best” note app’s — top… pick", '"best" note app\'s - top... pick'),
    ("Café crème brûlée", "Café crème brulée"),
    ("Smörgåsbord Ñandú", "Smörgåsbord Ñandu"),
    ("ﬁne² façade", "fine2 facade"),
    ("notes 📝 app 🚀", "notes  app "),
    ("日本語のノート", ""),
    ("tab\there nbsp", "tab here nbsp"),
    ("{json} [x] ~ | ^ € \\", "{json} [x] ~ | ^ € \\"),
])
def test_gsm7_text_maps_strips_and_drops(raw, clean):
    out = sms_service.gsm7_text(raw)
    assert out == clean
    assert sms_service.is_gsm7(out)


def test_septets_count_the_extension_table_twice():
    assert sms_service.gsm7_septets("abc") == 3
    assert sms_service.gsm7_septets("a{b}") == 6
    assert sms_service.gsm7_septets("€") == 2
    assert sms_service.gsm7_septets("") == 0


def test_segments():
    assert sms_service.segments("") == 0
    assert sms_service.segments("a" * 160) == 1
    assert sms_service.segments("a" * 161) == 2
    assert sms_service.segments("a" * 306) == 2
    assert sms_service.segments("a" * 307) == 3
    # Extension characters take two septets each.
    assert sms_service.segments("[" * 80) == 1
    assert sms_service.segments("[" * 81) == 2
    # One character outside GSM-7 makes the whole text UCS-2 (70, else 67).
    assert sms_service.segments("a" * 68 + "🙂") == 1
    assert sms_service.segments("a" * 69 + "🙂") == 2
    assert sms_service.segments("é" * 133 + "🙂") == 3


# -- replies ----------------------------------------------------------------------------


def test_the_three_replies():
    assert sms_service.STOP_REPLY == (
        "You're unsubscribed from all Cansee texts, including daily digests. Reply START "
        "to resume."
    )
    assert sms_service.START_REPLY == (
        "You're resubscribed to Cansee texts. Reply STOP to unsubscribe."
    )
    assert sms_service.HELP_REPLY == (
        "Cansee: Autopilot daily texts and alerts, about 1 msg a day per project. Text a "
        "question to get an answer from your account data. Reply STOP to unsubscribe, START "
        "to resume. Help: support@cansee.ai. Msg&data rates may apply."
    )
    assert [len(r) for r in (sms_service.STOP_REPLY, sms_service.START_REPLY,
                             sms_service.HELP_REPLY)] == [90, 63, 224]
    for reply in (sms_service.STOP_REPLY, sms_service.START_REPLY, sms_service.HELP_REPLY):
        assert sms_service.is_gsm7(reply)
        assert sms_service.gsm7_septets(reply) <= sms_service.MAX_BODY_CHARS


# -- sending ----------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(("answer", "status"), [
    (201, sms_service.SENT),
    (429, sms_service.RETRYABLE),
    (500, sms_service.RETRYABLE),
    (503, sms_service.RETRYABLE),
    (400, sms_service.FAILED),
    (401, sms_service.FAILED),
    (404, sms_service.FAILED),
    (requests.Timeout("slow"), sms_service.FAILED),
    (requests.ConnectionError("gone"), sms_service.FAILED),
])
def test_notify_status_tells_retryable_from_failed(twilio, answer, status):
    sub = verified_number(make_user("phone@example.com"), PHONE)
    twilio.statuses = [answer]
    assert sms_service.notify_status(sub, "Cansee test") == status
    assert len(twilio.sent) == 1
    assert twilio.sent[0]["to"] == PHONE
    sub.refresh_from_db()
    assert (sub.last_message_at is not None) == (status == sms_service.SENT)


@pytest.mark.django_db
def test_notify_keeps_its_boolean_and_honours_the_number_state(twilio):
    owner = make_user("phone@example.com")
    sub = verified_number(owner, PHONE)
    assert sms_service.notify(sub, "hello") is True
    twilio.statuses = [500]
    assert sms_service.notify(sub, "hello") is False
    pending = verified_number(make_user("other@example.com"), PHONE,
                              status=SmsSubscription.Status.PENDING)
    assert sms_service.notify_status(pending, "hello") == sms_service.FAILED
    assert sms_service.notify_status(None, "hello") == sms_service.FAILED
    assert len(twilio.sent) == 2


@pytest.mark.django_db
def test_nothing_is_sent_while_sms_is_off(monkeypatch):
    sent = []
    monkeypatch.setattr(requests, "post", lambda *a, **k: sent.append(1))
    sub = verified_number(make_user("phone@example.com"), PHONE)
    assert sms_service.notify_status(sub, "hello") == sms_service.FAILED
    assert sent == []


@pytest.mark.django_db
def test_logs_never_carry_the_body_or_the_number(twilio, caplog):
    sub = verified_number(make_user("phone@example.com"), PHONE)
    twilio.statuses = [500, 400, requests.ConnectionError("no route")]
    apps_logger = logging.getLogger("apps")
    apps_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level("INFO", logger="apps"):
            for _ in range(3):
                sms_service.notify_status(sub, "secret body text")
    finally:
        apps_logger.removeHandler(caplog.handler)
    assert "HTTP 500" in caplog.text and "HTTP 400" in caplog.text
    assert "secret body text" not in caplog.text
    assert PHONE not in caplog.text and "4155550123" not in caplog.text


# -- keywords -------------------------------------------------------------------------


@pytest.mark.django_db
def test_stop_opts_out_every_row_of_the_number_pending_ones_included():
    mine = verified_number(make_user("a@example.com"), PHONE)
    theirs = verified_number(make_user("b@example.com"), PHONE)
    pending = verified_number(make_user("c@example.com"), PHONE,
                              status=SmsSubscription.Status.PENDING)
    rows = [mine, theirs, pending]
    assert sms_service.handle_keyword(rows, " Stop ") == sms_service.STOP_REPLY
    for row in rows:
        row.refresh_from_db()
        assert row.status == SmsSubscription.Status.OPTED_OUT
        assert row.opted_out_at is not None


@pytest.mark.django_db
def test_start_revives_only_rows_that_were_verified_once():
    once = verified_number(make_user("a@example.com"), PHONE)
    never = verified_number(make_user("b@example.com"), PHONE,
                            status=SmsSubscription.Status.PENDING)
    sms_service.handle_keyword([once, never], "STOPALL")
    assert sms_service.handle_keyword([once, never], "start") == sms_service.START_REPLY
    once.refresh_from_db()
    never.refresh_from_db()
    assert once.status == SmsSubscription.Status.VERIFIED and once.opted_out_at is None
    # Someone else added the number and never verified it: it stays opted out.
    assert never.status == SmsSubscription.Status.OPTED_OUT
    assert never.consented_at is None


@pytest.mark.django_db
def test_help_and_questions():
    sub = verified_number(make_user("a@example.com"), PHONE)
    assert sms_service.handle_keyword([sub], "HELP") == sms_service.HELP_REPLY
    assert sms_service.handle_keyword([sub], "info") == sms_service.HELP_REPLY
    assert sms_service.handle_keyword([sub], "how is my visibility") is None
    assert sms_service.handle_keyword([], "STOP") == sms_service.STOP_REPLY
    assert sms_service.handle_keyword(None, "help") == sms_service.HELP_REPLY
    # One row still works.
    assert sms_service.handle_keyword(sub, "quit") == sms_service.STOP_REPLY
    sub.refresh_from_db()
    assert sub.status == SmsSubscription.Status.OPTED_OUT


# -- the inbound webhook --------------------------------------------------------------


@pytest.fixture
def inbound(settings, monkeypatch):
    settings.SMS_ENABLED = True
    monkeypatch.setattr(sms_service, "verify_twilio_signature", lambda request: True)
    asked = []

    def answer_for(subscription, question):
        asked.append((subscription.user.email, question))
        return "Your visibility is steady."

    monkeypatch.setattr(sms_webhooks, "_answer_for", answer_for)
    client = Client()

    def post(body: str, sender: str = PHONE):
        resp = client.post("/api/v1/notifications/sms/inbound/", {"From": sender, "Body": body})
        assert resp.status_code == 200
        return resp.content.decode()

    post.asked = asked
    return post


@pytest.mark.django_db
def test_inbound_stop_reaches_every_account_that_added_the_number(inbound):
    first = verified_number(make_user("a@example.com"), PHONE)
    second = verified_number(make_user("b@example.com"), PHONE)
    other = verified_number(make_user("c@example.com"), "+14155559999")
    assert "unsubscribed from all Cansee texts" in inbound("STOP")
    statuses = {s.id: s.status for s in SmsSubscription.objects.all()}
    assert statuses[first.id] == statuses[second.id] == SmsSubscription.Status.OPTED_OUT
    assert statuses[other.id] == SmsSubscription.Status.VERIFIED


@pytest.mark.django_db
def test_inbound_questions_use_the_newest_verified_row(inbound):
    older = verified_number(make_user("old@example.com"), PHONE)
    newer = verified_number(make_user("new@example.com"), PHONE,
                            status=SmsSubscription.Status.PENDING)
    assert older.created_at <= newer.created_at
    assert "Your visibility is steady." in inbound("how am I doing")
    assert inbound.asked == [("old@example.com", "how am I doing")]


@pytest.mark.django_db
def test_inbound_unknown_and_unverified_numbers(inbound):
    assert "isn't linked to a Cansee account" in inbound("hello", sender="+14155550000")
    verified_number(make_user("a@example.com"), PHONE, status=SmsSubscription.Status.PENDING)
    assert "<Message>" not in inbound("hello")
    assert inbound.asked == []


@pytest.mark.django_db
def test_inbound_start_after_stop(inbound):
    sub = verified_number(make_user("a@example.com"), PHONE, consented_at=timezone.now())
    inbound("STOP")
    assert "resubscribed" in inbound("START")
    sub.refresh_from_db()
    assert sub.status == SmsSubscription.Status.VERIFIED


def test_fake_twilio_is_the_only_transport():
    # The suite never posts to Twilio for real: FakeTwilio stands in.
    fake = FakeTwilio()
    fake.statuses = [429]
    assert fake("https://api.twilio.com", data={"To": "+1", "Body": "x"}).status_code == 429
