"""manage.py create_user: the operator path for provisioning accounts."""

import pytest
from django.core.management import CommandError, call_command

from apps.accounts.models import Organization, OrganizationMember, User

pytestmark = pytest.mark.django_db

PASSWORD = "correct-horse-battery-staple-91"


@pytest.fixture
def password_env(monkeypatch):
    monkeypatch.setenv("NEW_USER_PASSWORD", PASSWORD)
    return "NEW_USER_PASSWORD"


def test_creates_a_verified_user_from_the_environment(password_env):
    call_command("create_user", "Jane@Acme.com", "Jane Doe", password_env=password_env)

    user = User.objects.get(email="jane@acme.com")
    assert user.full_name == "Jane Doe"
    assert user.is_email_verified is True
    assert user.check_password(PASSWORD)
    assert not user.org_memberships.exists()


def test_refuses_an_existing_email(password_env):
    User.objects.create_user(email="jane@acme.com", password=PASSWORD, full_name="Jane")

    with pytest.raises(CommandError, match="already exists"):
        call_command("create_user", "JANE@acme.com", "Jane Doe", password_env=password_env)


def test_refuses_a_password_the_validators_reject(monkeypatch):
    monkeypatch.setenv("NEW_USER_PASSWORD", "short")

    with pytest.raises(CommandError):
        call_command("create_user", "jane@acme.com", "Jane Doe", password_env="NEW_USER_PASSWORD")
    assert not User.objects.filter(email="jane@acme.com").exists()


def test_refuses_an_unset_password_variable(monkeypatch):
    monkeypatch.delenv("NEW_USER_PASSWORD", raising=False)

    with pytest.raises(CommandError, match="not set"):
        call_command("create_user", "jane@acme.com", "Jane Doe", password_env="NEW_USER_PASSWORD")


def test_does_not_prompt_without_a_terminal():
    # pytest captures stdin, so there is no TTY to prompt on.
    with pytest.raises(CommandError, match="No terminal"):
        call_command("create_user", "jane@acme.com", "Jane Doe")
    assert not User.objects.filter(email="jane@acme.com").exists()


def test_refuses_an_invalid_email(password_env):
    with pytest.raises(CommandError, match="not a valid email"):
        call_command("create_user", "not-an-email", "Jane Doe", password_env=password_env)


def _org(seat_limit=None):
    owner = User.objects.create_user(email="owner@acme.com", password=PASSWORD, full_name="Owner")
    org = Organization.objects.create(name="Acme", slug="acme", owner=owner, seat_limit=seat_limit)
    OrganizationMember.objects.create(organization=org, user=owner, role="owner", joined_via="founder")
    return org


def test_adds_the_user_to_an_organization_as_a_member(password_env):
    org = _org()

    call_command("create_user", "jane@acme.com", "Jane Doe", org="acme", password_env=password_env)

    member = OrganizationMember.objects.get(organization=org, user__email="jane@acme.com")
    assert member.role == "member"
    assert member.joined_via == "admin"


def test_refuses_an_unknown_organization(password_env):
    with pytest.raises(CommandError, match="No organization"):
        call_command("create_user", "jane@acme.com", "Jane Doe", org="nope", password_env=password_env)
    assert not User.objects.filter(email="jane@acme.com").exists()


def test_refuses_a_full_organization(password_env):
    _org(seat_limit=1)

    with pytest.raises(CommandError, match="no free seats"):
        call_command("create_user", "jane@acme.com", "Jane Doe", org="acme", password_env=password_env)
    assert not User.objects.filter(email="jane@acme.com").exists()
