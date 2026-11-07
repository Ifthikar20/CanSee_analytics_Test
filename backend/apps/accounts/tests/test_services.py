import pytest
from django.test import RequestFactory

from apps.accounts.services.auth_service import AuthService
from apps.accounts.tests.factories import UserFactory
from core.exceptions import LoginRefused


def _login_request():
    # django-axes (AxesStandaloneBackend) throttles by request, so every
    # password sign-in must carry one; LoginView passes its own.
    return RequestFactory().post("/api/v1/auth/login/", REMOTE_ADDR="127.0.0.1")


@pytest.mark.django_db
class TestAuthService:
    def test_register_creates_user(self):
        user = AuthService.register(
            email="test@example.com",
            password="SecurePass123!",
            full_name="Test User",
        )
        assert user.email == "test@example.com"
        assert user.is_email_verified is False
        assert user.check_password("SecurePass123!")

    def test_register_duplicate_email_raises(self):
        UserFactory(email="taken@example.com")
        with pytest.raises(ValueError, match="already exists"):
            AuthService.register(
                email="taken@example.com",
                password="SecurePass123!",
                full_name="Another User",
            )

    def test_login_returns_tokens(self):
        user = UserFactory(email="login@test.com", is_email_verified=True)
        user.set_password("MyPass123!")
        user.save()

        result = AuthService.login(
            email="login@test.com",
            password="MyPass123!",
            ip_address="127.0.0.1",
            user_agent="test-agent",
            request=_login_request(),
        )

        assert "access" in result
        assert "refresh" in result
        assert result["user"]["email"] == "login@test.com"

    def test_login_wrong_password_raises(self):
        UserFactory(email="wrong@test.com", is_email_verified=True)
        with pytest.raises(LoginRefused, match="Incorrect email or password") as exc:
            AuthService.login(
                email="wrong@test.com",
                password="WrongPassword",
                ip_address="127.0.0.1",
                user_agent="test-agent",
                request=_login_request(),
            )
        assert exc.value.code == "invalid_credentials"
        assert exc.value.status_code == 400

    def test_login_unverified_email_raises(self):
        user = UserFactory(email="unverified@test.com", is_email_verified=False)
        user.set_password("Pass123!")
        user.save()

        with pytest.raises(LoginRefused, match="verify your email") as exc:
            AuthService.login(
                email="unverified@test.com",
                password="Pass123!",
                ip_address="127.0.0.1",
                user_agent="test-agent",
                request=_login_request(),
            )
        assert exc.value.code == "email_not_verified"
        assert exc.value.status_code == 403

    def test_change_password_success(self):
        user = UserFactory(email="change@test.com")
        user.set_password("OldPass123!")
        user.save()

        AuthService.change_password(
            user=user, old_password="OldPass123!", new_password="NewStrongPass456!"
        )
        user.refresh_from_db()
        assert user.check_password("NewStrongPass456!")

    def test_change_password_rejects_weak(self):
        # The configured validators (length/common/numeric) are enforced
        # on every password write, not just at serializer length checks.
        user = UserFactory(email="weak@test.com")
        user.set_password("OldPass123!")
        user.save()
        with pytest.raises(ValueError):
            AuthService.change_password(
                user=user, old_password="OldPass123!", new_password="123456789012",
            )

    def test_change_password_wrong_old_raises(self):
        user = UserFactory()
        user.set_password("OldPass123!")
        user.save()

        with pytest.raises(ValueError, match="incorrect"):
            AuthService.change_password(
                user=user, old_password="WrongOld!", new_password="NewPass456!"
            )
