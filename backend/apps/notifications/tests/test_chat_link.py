"""Workspace linking service (apps.notifications.services.chat_link):
codes, the failure limit's exact edge, re-linking, inactive holders and
blank workspace ids."""
import re

import pytest
from django.core.cache import cache
from django.utils import timezone

from apps.accounts.tests.factories import UserFactory
from apps.notifications.models import IntegrationConnection
from apps.notifications.services.chat_link import (
    LINK_MAX_FAILURES,
    create_link_code,
    link_workspace,
    resolve_connection,
)

pytestmark = pytest.mark.django_db

URLS = {
    "slack": "https://hooks.slack.com/services/T0/B0/xyz",
    "discord": "https://discord.com/api/webhooks/1/abc",
}
LINKED = "now linked to Cansee"
INVALID = "not valid or has expired"
TOO_MANY = "Too many link attempts"
TAKEN = "already linked to another Cansee account"


@pytest.fixture(autouse=True)
def clean_cache():
    cache.clear()
    yield
    cache.clear()


def conn(platform="slack", team="", *, verified=None, active=True):
    verified = bool(team) if verified is None else verified
    return IntegrationConnection.objects.create(
        user=UserFactory(), platform=platform, webhook_url=URLS[platform],
        external_team_id=team, is_active=active,
        external_team_verified_at=timezone.now() if verified else None,
    )


def link(connection, team, code=None):
    code = code or create_link_code(connection)["code"]
    return link_workspace(platform=connection.platform, team_id=team, code=code)


def test_code_shape():
    payload = create_link_code(conn())
    assert re.fullmatch(r"[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}", payload["code"])
    assert payload["command"] == f"/cansee link {payload['code']}"


def test_codes_are_case_and_dash_insensitive():
    c = conn()
    code = create_link_code(c)["code"]
    assert LINKED in link_workspace(platform="slack", team_id="T1",
                                    code=code.lower().replace("-", " "))
    c.refresh_from_db()
    assert c.external_team_id == "T1"


def test_a_slack_code_does_not_work_on_discord():
    c = conn("slack")
    code = create_link_code(c)["code"]
    assert INVALID in link_workspace(platform="discord", team_id="G1", code=code)
    c.refresh_from_db()
    assert c.external_team_id == ""


@pytest.mark.parametrize("team", ["", "   ", None])
def test_a_blank_workspace_id_links_nothing(team):
    c = conn()
    code = create_link_code(c)["code"]
    reply = link_workspace(platform="slack", team_id=team, code=code)
    assert reply == "Run this command inside the Slack workspace you want to link."
    c.refresh_from_db()
    assert (c.external_team_id, c.external_team_verified_at) == ("", None)
    # The code was not spent.
    assert LINKED in link_workspace(platform="slack", team_id="T1", code=code)


def test_empty_code_counts_as_a_failure():
    assert INVALID in link_workspace(platform="slack", team_id="T1", code="")
    assert cache.get("chat_link_failures:slack:T1") == 1


def test_one_below_the_failure_limit_still_links():
    c = conn()
    for _ in range(LINK_MAX_FAILURES - 1):
        assert INVALID in link_workspace(platform="slack", team_id="T1", code="AAAAA-AAAAA")
    assert LINKED in link(c, "T1")


def test_at_the_failure_limit_even_a_good_code_is_refused():
    c = conn()
    for _ in range(LINK_MAX_FAILURES):
        link_workspace(platform="slack", team_id="T1", code="AAAAA-AAAAA")
    assert TOO_MANY in link(c, "T1")
    c.refresh_from_db()
    assert c.external_team_id == ""


def test_failures_are_per_workspace():
    c = conn()
    for _ in range(LINK_MAX_FAILURES):
        link_workspace(platform="slack", team_id="T-noisy", code="AAAAA-AAAAA")
    assert LINKED in link(c, "T-quiet")


def test_success_clears_the_failure_count_and_relinking_yourself_is_allowed():
    c = conn()
    for _ in range(LINK_MAX_FAILURES - 1):
        link_workspace(platform="slack", team_id="T1", code="AAAAA-AAAAA")
    assert LINKED in link(c, "T1")
    link_workspace(platform="slack", team_id="T1", code="AAAAA-AAAAA")
    # The connection that holds T1 may link it again with a new code.
    assert LINKED in link(c, "T1")
    c.refresh_from_db()
    assert c.external_team_id == "T1"


def test_an_inactive_holder_does_not_block_and_is_released():
    old = conn(team="T1", active=False)
    new = conn()
    assert LINKED in link(new, "T1")
    old.refresh_from_db()
    new.refresh_from_db()
    assert (old.external_team_id, old.external_team_verified_at) == ("", None)
    assert new.external_team_id == "T1"
    assert resolve_connection(platform="slack", team_id="T1") == new


def test_an_active_verified_holder_blocks_and_keeps_the_workspace():
    holder = conn(team="T1")
    other = conn()
    assert TAKEN in link(other, "T1")
    assert resolve_connection(platform="slack", team_id="T1") == holder


def test_the_same_team_id_on_another_platform_is_independent():
    conn("slack", "SAME")
    d = conn("discord")
    assert LINKED in link(d, "SAME")
    assert resolve_connection(platform="discord", team_id="SAME") == d


class TestResolve:
    def test_only_active_verified_rows_resolve(self):
        conn(team="T-unverified", verified=False)
        conn(team="T-inactive", active=False)
        good = conn(team="T-good")
        assert resolve_connection(platform="slack", team_id="T-unverified") is None
        assert resolve_connection(platform="slack", team_id="T-inactive") is None
        assert resolve_connection(platform="slack", team_id=" T-good ") == good
        assert resolve_connection(platform="discord", team_id="T-good") is None

    @pytest.mark.parametrize("team", ["", "  ", None])
    def test_blank_never_resolves(self, team):
        conn(team="", verified=True)
        assert resolve_connection(platform="slack", team_id=team) is None


def test_a_link_that_loses_a_race_to_the_same_workspace_is_refused(monkeypatch):
    """Another connection verifies T1 between the holder check and the
    write: the database constraint refuses the second link, and the reply
    says the workspace is taken instead of failing."""
    loser = conn()
    winner = conn()
    code = create_link_code(loser)["code"]
    real_save = IntegrationConnection.save

    def save_after_a_competitor(self, *args, **kwargs):
        if self.pk == loser.pk:
            IntegrationConnection.objects.filter(pk=winner.pk).update(
                external_team_id="T1", external_team_verified_at=timezone.now())
        return real_save(self, *args, **kwargs)

    monkeypatch.setattr(IntegrationConnection, "save", save_after_a_competitor)
    reply = link_workspace(platform="slack", team_id="T1", code=code)

    assert TAKEN in reply
    loser.refresh_from_db()
    assert (loser.external_team_id, loser.external_team_verified_at) == ("", None)
    # (The competitor's write shares this test's transaction here, so it is
    # rolled back with the refused link; in production it is its own.)
