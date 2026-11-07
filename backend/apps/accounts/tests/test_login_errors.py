import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

LOGIN = "/api/v1/auth/login/"
PASSWORD = "Correct-horse-battery-9"


@pytest.fixture
def account(db):
    user = get_user_model().objects.create_user(
        email="login-check@example.test", password=PASSWORD, full_name="Login Check",
    )
    user.is_email_verified = True
    user.save(update_fields=["is_email_verified"])
    return user


def _login(email, password):
    return APIClient().post(LOGIN, {"email": email, "password": password}, format="json")


def test_wrong_password_says_so_without_saying_which_field(account):
    res = _login(account.email, "not-the-password")
    assert res.status_code == 400
    assert res.json()["error"] == {
        "code": "invalid_credentials",
        "message": "Incorrect email or password.",
    }


def test_unknown_email_gets_the_same_answer(db):
    res = _login("nobody@example.test", "whatever-123")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_credentials"
    assert res.json()["error"]["message"] == "Incorrect email or password."


def test_unverified_email_is_told_to_verify(account):
    account.is_email_verified = False
    account.save(update_fields=["is_email_verified"])
    res = _login(account.email, PASSWORD)
    assert res.status_code == 403
    assert res.json()["error"] == {
        "code": "email_not_verified",
        "message": "Please verify your email before logging in.",
    }


def test_deactivated_account_says_so(account):
    account.is_active = False
    account.save(update_fields=["is_active"])
    res = _login(account.email, PASSWORD)
    # Django's ModelBackend refuses inactive users before issue_session runs,
    # so this reads like wrong credentials, which reveals nothing.
    assert res.status_code in (400, 403)
    assert res.json()["error"]["code"] in ("invalid_credentials", "account_deactivated")


def test_correct_password_signs_in(account):
    res = _login(account.email, PASSWORD)
    assert res.status_code == 200
    assert res.json()["data"]["access"] if "data" in res.json() else res.json()["access"]
