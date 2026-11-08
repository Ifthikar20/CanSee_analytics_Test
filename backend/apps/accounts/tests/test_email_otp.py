"""Email verification codes cannot be brute-forced.

Only the newest code is valid, wrong guesses are limited per account
(whatever IP they come from), verify-email has the auth throttle, a new
code is emailed at most once a minute per account, and the anonymous burst
and sustained throttles keep separate histories.
"""
from unittest.mock import patch

import pytest
from django.contrib.auth.models import AnonymousUser
from django.core.cache import cache
from rest_framework.request import Request
from rest_framework.test import APIClient, APIRequestFactory

from apps.accounts.api.v1.views import VerifyEmailView
from apps.accounts.models import EmailVerificationOTP
from apps.accounts.services import auth_service
from apps.accounts.services.auth_service import AuthService
from apps.accounts.tests.factories import UserFactory
from core.interceptors.throttling import (
    AuthRateThrottle,
    BurstRateThrottle,
    SustainedRateThrottle,
)

pytestmark = pytest.mark.django_db

VERIFY = "/api/v1/auth/verify-email/"
RESEND = "/api/v1/auth/resend-verification/"


@pytest.fixture
def user():
    return UserFactory(email="new@example.com", is_email_verified=False)


def _verify(code, email="new@example.com"):
    return APIClient().post(VERIFY, {"email": email, "otp": code}, format="json")


def _wrong(code):
    return "000000" if code != "000000" else "111111"


def test_a_new_code_retires_the_earlier_ones(user):
    first = AuthService.generate_email_otp(user=user)
    second = AuthService.generate_email_otp(user=user)
    assert EmailVerificationOTP.objects.filter(user=user, used=False).count() == 1
    if first != second:
        assert _verify(first).status_code == 400
    assert _verify(second).status_code == 200
    user.refresh_from_db()
    assert user.is_email_verified


def test_too_many_wrong_codes_lock_the_account(user):
    code = AuthService.generate_email_otp(user=user)
    for _ in range(auth_service.OTP_MAX_FAILURES - 1):
        assert _verify(_wrong(code)).status_code == 400
    locked = _verify(_wrong(code))
    assert locked.status_code == 429
    assert locked.json()["error"]["code"] == "otp_attempts_exceeded"
    # The live code was retired and the right code is now refused too.
    assert not EmailVerificationOTP.objects.filter(user=user, used=False).exists()
    assert _verify(code).status_code == 429
    user.refresh_from_db()
    assert not user.is_email_verified


def test_a_new_code_does_not_reset_the_lock(user):
    code = AuthService.generate_email_otp(user=user)
    for _ in range(auth_service.OTP_MAX_FAILURES):
        _verify(_wrong(code))
    fresh = AuthService.generate_email_otp(user=user)
    assert _verify(fresh).status_code == 429

    # Once the window ends, the newest code works.
    cache.delete(auth_service._otp_failures_key(user))
    assert _verify(fresh).status_code == 200


def test_failures_are_counted_per_account_across_ips(user):
    code = AuthService.generate_email_otp(user=user)
    for n in range(auth_service.OTP_MAX_FAILURES):
        APIClient(REMOTE_ADDR=f"203.0.113.{n + 1}").post(
            VERIFY, {"email": user.email, "otp": _wrong(code)}, format="json")
    assert _verify(code).status_code == 429


def test_a_correct_code_clears_the_count(user):
    code = AuthService.generate_email_otp(user=user)
    for _ in range(auth_service.OTP_MAX_FAILURES - 1):
        _verify(_wrong(code))
    assert _verify(code).status_code == 200
    assert cache.get(auth_service._otp_failures_key(user)) is None


def test_verify_email_has_the_auth_throttle():
    assert VerifyEmailView.throttle_classes == [AuthRateThrottle]


def test_resend_emails_at_most_once_a_minute(user):
    with patch("apps.accounts.tasks.send_verification_email.delay") as send:
        for _ in range(3):
            resp = APIClient().post(RESEND, {"email": user.email}, format="json")
            assert resp.status_code == 200
    assert send.call_count == 1

    cache.delete(f"email_otp_resend:{user.pk}")
    with patch("apps.accounts.tasks.send_verification_email.delay") as send:
        APIClient().post(RESEND, {"email": user.email}, format="json")
    assert send.call_count == 1


def test_anonymous_burst_and_sustained_throttles_use_separate_keys():
    request = APIRequestFactory().post("/api/v1/auth/verify-email/", REMOTE_ADDR="198.51.100.7")
    drf_request = Request(request)
    drf_request.user = AnonymousUser()
    burst = BurstRateThrottle().get_cache_key(drf_request, None)
    sustained = SustainedRateThrottle().get_cache_key(drf_request, None)
    assert burst != sustained
    assert "burst" in burst and "sustained" in sustained
    assert burst.endswith("198.51.100.7") and sustained.endswith("198.51.100.7")
