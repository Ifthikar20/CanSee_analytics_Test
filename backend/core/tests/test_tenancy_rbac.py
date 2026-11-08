"""The role ladder every tenancy check uses (core.permissions.rbac)."""
import pytest

from core.permissions.rbac import (
    ROLE_HIERARCHY,
    denied_message,
    min_role_for_method,
    role_at_least,
)

LADDER = ["viewer", "member", "admin", "owner"]


@pytest.mark.parametrize("held", LADDER)
@pytest.mark.parametrize("required", LADDER)
def test_role_at_least_follows_the_ladder(held, required):
    assert role_at_least(held, required) is (LADDER.index(held) >= LADDER.index(required))


def test_editor_is_the_legacy_name_of_member():
    assert ROLE_HIERARCHY["editor"] == ROLE_HIERARCHY["member"]
    assert role_at_least("editor", "member")
    assert role_at_least("member", "editor")
    assert not role_at_least("editor", "admin")
    assert role_at_least("editor", "viewer")


@pytest.mark.parametrize("held", ["", "superuser", "Owner", None])
def test_unknown_held_roles_are_denied(held):
    assert not role_at_least(held, "viewer")


@pytest.mark.parametrize("method", ["GET", "get", "HEAD", "head", "OPTIONS", "Options"])
def test_reads_need_viewer(method):
    assert min_role_for_method(method) == "viewer"


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "delete", "TRACE", "", None])
def test_everything_else_needs_member(method):
    assert min_role_for_method(method) == "member"


def test_denied_messages():
    admin_only = "Only organization admins can do this."
    read_only = "Your organization role can view this project but not change it."
    assert denied_message("admin") == admin_only
    assert denied_message("owner") == admin_only
    assert denied_message("member") == read_only
    assert denied_message("viewer") == read_only
