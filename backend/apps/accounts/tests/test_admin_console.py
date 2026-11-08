"""Internal ops API, console endpoints: token usage, plans and seats must be
exact and must reconcile with each other.

Fixture (time frozen at 2026-11-15 12:00 UTC, so the month starts
2026-11-01 00:00 UTC):

  Acme (200 prompts, 5 seats): alice (owner), bob, carol; one live invite
  Solo Co (100 prompts, 1 seat): dave (owner)
  erin: no org, active 100-prompt subscription
  frank: no org, no subscription (Free)
  one unattributed ledger row (a pre-signup onboarding scan)
"""
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.urls import get_resolver
from freezegun import freeze_time
from rest_framework.test import APIClient

from apps.accounts.api.v1.admin_views import InternalAdminView
from apps.accounts.models import (
    AITokenUsage,
    Invitation,
    Organization,
    OrganizationMember,
)
from apps.accounts.tests.factories import UserFactory
from apps.billing.models import Subscription
from core.utils.constants import Plan, SubscriptionStatus

OVERVIEW = "/api/v1/internal/admin/overview/"
USERS = "/api/v1/internal/admin/users/"
ACCOUNTS = "/api/v1/internal/admin/accounts/"
KEY = "test-ops-key"

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
MONTH_START = datetime(2026, 11, 1, tzinfo=UTC)

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def ops_settings(settings):
    settings.ADMIN_OPS_KEY = KEY
    settings.ADMIN_OPS_ALLOWED_CIDRS = ["127.0.0.0/8"]
    settings.ORG_FEATURES_ENABLED = True
    InternalAdminView._requests.clear()
    yield settings
    InternalAdminView._requests.clear()


@pytest.fixture(autouse=True)
def frozen():
    # Load the URLconf (and every view module it imports) before freezing:
    # pydantic cannot build schemas for freezegun's FakeDatetime.
    get_resolver().url_patterns  # noqa: B018
    with freeze_time(NOW):
        yield


def _get(path, **params):
    client = APIClient()
    client.credentials(HTTP_X_ADMIN_KEY=KEY)
    resp = client.get(path, params)
    assert resp.status_code == 200, resp.content
    return resp.json()["data"]


def _row(user, inp, out, when, cost="0", **fields):
    row = AITokenUsage.objects.create(
        user=user, module="llm_ranking", model_name="claude-sonnet-4-5",
        input_tokens=inp, output_tokens=out, total_tokens=inp + out,
        estimated_cost_usd=Decimal(cost), **fields,
    )
    AITokenUsage.objects.filter(pk=row.pk).update(created_at=when)
    return row


def _usage(m_in, m_out, m_req, a_in, a_out, a_req):
    return {
        "month": {"input": m_in, "output": m_out, "total": m_in + m_out, "requests": m_req},
        "all_time": {"input": a_in, "output": a_out, "total": a_in + a_out, "requests": a_req},
    }


ZERO = _usage(0, 0, 0, 0, 0, 0)


@pytest.fixture
def world():
    marker = uuid.uuid4().hex[:8]

    def user(name, **kw):
        return UserFactory(email=f"{name}-{marker}@example.com", full_name=name.title(), **kw)

    alice, bob, carol, dave = user("alice"), user("bob"), user("carol"), user("dave")
    erin, frank = user("erin"), user("frank", is_active=False, is_email_verified=False)

    acme = Organization.objects.create(
        name=f"Acme {marker}", slug=f"acme-{marker}", owner=alice, plan=Plan.PROMPTS_200,
    )
    solo_co = Organization.objects.create(
        name=f"Solo Co {marker}", slug=f"solo-{marker}", owner=dave, plan=Plan.PROMPTS_100,
    )
    OrganizationMember.objects.create(organization=acme, user=alice, role="owner")
    OrganizationMember.objects.create(organization=acme, user=bob, role="member")
    OrganizationMember.objects.create(organization=acme, user=carol, role="viewer")
    OrganizationMember.objects.create(organization=solo_co, user=dave, role="owner")
    Invitation.objects.create(
        organization=acme, email=f"gina-{marker}@example.com", role="member",
        token_hash=uuid.uuid4().hex, expires_at=NOW + timedelta(days=3),
    )
    # An expired and a revoked invite hold no seat.
    Invitation.objects.create(
        organization=acme, email=f"old-{marker}@example.com", role="member",
        token_hash=uuid.uuid4().hex, expires_at=NOW - timedelta(days=1),
    )
    Invitation.objects.create(
        organization=acme, email=f"gone-{marker}@example.com", role="member",
        token_hash=uuid.uuid4().hex, expires_at=NOW + timedelta(days=3), revoked_at=NOW,
    )
    Subscription.objects.create(user=erin, plan=Plan.PROMPTS_100, status=SubscriptionStatus.ACTIVE)
    # Alice is an org member: her own lapsed subscription does not set her plan.
    Subscription.objects.create(user=alice, plan=Plan.PRO, status=SubscriptionStatus.CANCELED)

    # alice: two calls this month, one exactly at the month start (counts),
    # one last month.
    _row(alice, 100, 50, NOW - timedelta(days=1), cost="0.100000")
    _row(alice, 100, 50, NOW - timedelta(days=2), cost="0.100000")
    _row(alice, 7, 3, MONTH_START, cost="0.000500")
    _row(alice, 1000, 500, datetime(2026, 10, 20, tzinfo=UTC), cost="1.250000")
    # bob: one microsecond before the month start -> last month only.
    _row(bob, 11, 9, MONTH_START - timedelta(microseconds=1), cost="0.000020")
    # dave: this month and a previous year.
    _row(dave, 40, 2, NOW - timedelta(hours=1), cost="0.004200")
    _row(dave, 5, 5, datetime(2025, 9, 3, tzinfo=UTC), cost="0.000100")
    # erin: through the real ledger writer, replayed under the same key
    # (a Celery retry): one row, not two.
    from core.ai_tracking import record_usage

    for _ in range(2):
        record_usage(
            module="llm_ranking", model_name="claude-sonnet-4-5",
            input_tokens=300, output_tokens=30, user=erin,
            idempotency_key=f"console-test-{marker}",
        )
    # Pre-signup onboarding scan: no user.
    _row(None, 999, 1, NOW - timedelta(hours=2), cost="0.010000")

    # A derived rollup that must never be added to the ledger numbers.
    from apps.llm_ranking.models import LLMRankingAudit
    from apps.websites.tests.factories import WebsiteFactory

    LLMRankingAudit.objects.create(
        website=WebsiteFactory(user=alice), created_by=alice, business_name="X",
        industry="saas", total_tokens=1_000_000,
    )
    return {
        "marker": marker, "alice": alice, "bob": bob, "carol": carol, "dave": dave,
        "erin": erin, "frank": frank, "acme": acme, "solo_co": solo_co,
    }


EXPECTED = {
    "alice": _usage(207, 103, 3, 1207, 603, 4),
    "bob": _usage(0, 0, 0, 11, 9, 1),
    "carol": ZERO,
    "dave": _usage(40, 2, 1, 45, 7, 2),
    "erin": _usage(300, 30, 1, 300, 30, 1),
    "frank": ZERO,
}


def _users_by_name(world):
    rows = _get(USERS, search=world["marker"], limit=200)["rows"]
    return {r["full_name"].lower(): r for r in rows}


class TestUsers:
    def test_token_usage_per_user_is_exact(self, world):
        rows = _users_by_name(world)
        assert set(rows) == set(EXPECTED)
        for name, expected in EXPECTED.items():
            assert rows[name]["tokens"] == expected, name
            assert rows[name]["tokens_total"] == expected["all_time"]["total"]

    def test_cost_is_a_separate_exact_field(self, world):
        rows = _users_by_name(world)
        assert rows["alice"]["cost_usd"] == {"month": "0.200500", "all_time": "1.450500"}
        assert rows["bob"]["cost_usd"] == {"month": "0.000000", "all_time": "0.000020"}
        assert rows["carol"]["cost_usd"] == {"month": "0.000000", "all_time": "0.000000"}

    def test_identity_plan_and_organization(self, world):
        rows = _users_by_name(world)
        alice = rows["alice"]
        assert alice["id"] == str(world["alice"].id)
        assert alice["email"] == world["alice"].email
        assert alice["joined"] and alice["last_login"] is None
        assert (alice["active"], alice["verified"]) == (True, True)
        assert (alice["plan"], alice["plan_name"], alice["plan_source"]) == (
            "prompts_200", "200 prompts", "organization")
        assert alice["organization"] == {
            "id": str(world["acme"].id), "name": world["acme"].name, "role": "owner"}
        assert rows["carol"]["organization"]["role"] == "viewer"
        assert rows["dave"]["plan"] == "prompts_100"
        erin = rows["erin"]
        assert (erin["plan"], erin["plan_source"], erin["organization"]) == (
            "prompts_100", "subscription", None)
        frank = rows["frank"]
        assert (frank["plan"], frank["plan_name"]) == ("free", "Free")
        assert (frank["active"], frank["verified"]) == (False, False)

    def test_org_plan_needs_org_features(self, world, ops_settings):
        ops_settings.ORG_FEATURES_ENABLED = False
        alice = _users_by_name(world)["alice"]
        # The flag off, members get what their own subscription grants.
        assert (alice["plan"], alice["plan_source"]) == ("free", "subscription")
        assert alice["organization"]["name"] == world["acme"].name

    def test_search_by_exact_id(self, world):
        body = _get(USERS, search=str(world["bob"].id))
        assert body["total"] == 1
        assert body["rows"][0]["email"] == world["bob"].email
        assert _get(USERS, search=str(uuid.uuid4()))["total"] == 0

    def test_pagination(self, world):
        first = _get(USERS, search=world["marker"], limit=4, offset=0)
        second = _get(USERS, search=world["marker"], limit=4, offset=4)
        assert first["total"] == second["total"] == 6
        assert (len(first["rows"]), len(second["rows"])) == (4, 2)
        ids = [r["id"] for r in first["rows"] + second["rows"]]
        assert len(set(ids)) == 6

    def test_period_is_the_utc_calendar_month(self, world):
        period = _get(USERS, search=world["marker"])["period"]
        assert datetime.fromisoformat(period["month_start"]) == MONTH_START
        assert datetime.fromisoformat(period["as_of"]) == NOW


class TestAccounts:
    def _accounts(self, world, **params):
        return _get(ACCOUNTS, search=world["marker"], limit=100, **params)

    def test_organization_seats_and_usage(self, world):
        body = self._accounts(world)
        acme = next(r for r in body["rows"] if r["id"] == str(world["acme"].id))
        assert acme["type"] == "organization"
        assert (acme["plan"], acme["plan_name"]) == ("prompts_200", "200 prompts")
        assert (acme["seat_limit"], acme["seats_used"], acme["pending_invites"]) == (5, 3, 1)
        assert (acme["seats_available"], acme["over_limit"]) == (1, False)
        assert acme["seat_limit_source"] == "plan"
        assert acme["owner"]["id"] == str(world["alice"].id)
        assert [s["email"] for s in acme["seats"]] == [
            world["alice"].email, world["bob"].email, world["carol"].email]
        assert [s["role"] for s in acme["seats"]] == ["owner", "member", "viewer"]
        for seat, name in zip(acme["seats"], ("alice", "bob", "carol"), strict=True):
            assert seat["user_id"] == str(world[name].id)
            assert seat["tokens"] == EXPECTED[name]
        # The account total is the sum of its seats, exactly.
        assert acme["tokens"] == _usage(207, 103, 3, 1218, 612, 5)
        assert acme["cost_usd"] == {"month": "0.200500", "all_time": "1.450520"}

    def test_one_seat_plan_organization(self, world):
        body = self._accounts(world, type="organization")
        solo = next(r for r in body["rows"] if r["id"] == str(world["solo_co"].id))
        assert (solo["seat_limit"], solo["seats_used"], solo["seats_available"]) == (1, 1, 0)
        assert solo["tokens"] == EXPECTED["dave"]

    def test_users_without_an_org_are_one_seat_accounts(self, world):
        body = self._accounts(world, type="individual")
        rows = {r["owner"]["email"]: r for r in body["rows"]}
        assert set(rows) == {world["erin"].email, world["frank"].email}
        erin = rows[world["erin"].email]
        assert (erin["type"], erin["id"], erin["plan"]) == (
            "individual", str(world["erin"].id), "prompts_100")
        assert (erin["seat_limit"], erin["seats_used"], erin["seats_available"]) == (1, 1, 0)
        assert [s["user_id"] for s in erin["seats"]] == [str(world["erin"].id)]
        assert erin["tokens"] == erin["seats"][0]["tokens"] == EXPECTED["erin"]
        frank = rows[world["frank"].email]
        assert (frank["plan"], frank["seat_limit"]) == ("free", 1)

    def test_every_user_is_in_exactly_one_account(self, world):
        body = self._accounts(world)
        assert (body["total"], body["organizations"], body["individual_accounts"]) == (4, 2, 2)
        seat_ids = [s["user_id"] for r in body["rows"] for s in r["seats"]]
        assert sorted(seat_ids) == sorted(
            str(world[n].id) for n in ("alice", "bob", "carol", "dave", "erin", "frank"))
        # Organizations come first, then individual accounts.
        assert [r["type"] for r in body["rows"]] == [
            "organization", "organization", "individual", "individual"]

    def test_pagination_runs_across_both_kinds(self, world):
        pages = [
            _get(ACCOUNTS, search=world["marker"], limit=3, offset=0),
            _get(ACCOUNTS, search=world["marker"], limit=3, offset=3),
        ]
        rows = pages[0]["rows"] + pages[1]["rows"]
        assert [len(p["rows"]) for p in pages] == [3, 1]
        assert len({(r["type"], r["id"]) for r in rows}) == 4

    def test_search_by_member_email_or_id_finds_the_org(self, world):
        body = _get(ACCOUNTS, search=world["bob"].email)
        assert [r["id"] for r in body["rows"]] == [str(world["acme"].id)]
        body = _get(ACCOUNTS, search=str(world["acme"].id))
        assert [r["id"] for r in body["rows"]] == [str(world["acme"].id)]
        body = _get(ACCOUNTS, search=str(world["erin"].id))
        assert [r["id"] for r in body["rows"]] == [str(world["erin"].id)]

    def test_contract_seat_count_and_over_limit(self, world):
        Organization.objects.filter(pk=world["acme"].pk).update(seat_limit=2)
        body = self._accounts(world, type="organization")
        acme = next(r for r in body["rows"] if r["id"] == str(world["acme"].id))
        assert (acme["seat_limit"], acme["seat_limit_source"]) == (2, "contract")
        assert (acme["seats_used"], acme["seats_available"], acme["over_limit"]) == (3, 0, True)

    def test_unlimited_seats(self, world):
        Organization.objects.filter(pk=world["acme"].pk).update(plan=Plan.BUSINESS)
        body = self._accounts(world, type="organization")
        acme = next(r for r in body["rows"] if r["id"] == str(world["acme"].id))
        assert (acme["seat_limit"], acme["seats_available"], acme["over_limit"]) == (-1, -1, False)


class TestTotalsReconcile:
    def test_overview_totals_match_the_ledger_and_the_lists(self, world):
        totals = _get(OVERVIEW)["totals"]

        # Ground truth straight from the tables (the shared test DB may hold
        # other rows, so compare with the whole ledger, not the fixture).
        from apps.accounts.models import User

        ledger = list(AITokenUsage.objects.values(
            "user_id", "input_tokens", "output_tokens", "total_tokens", "created_at"))

        def summed(rows):
            month = [r for r in rows if r["created_at"] >= MONTH_START]
            return {
                period: {
                    "input": sum(r["input_tokens"] for r in sel),
                    "output": sum(r["output_tokens"] for r in sel),
                    "total": sum(r["total_tokens"] for r in sel),
                    "requests": len(sel),
                }
                for period, sel in (("month", month), ("all_time", rows))
            }

        assert totals["tokens"] == summed([r for r in ledger if r["user_id"]])
        assert totals["unattributed"]["tokens"] == summed([r for r in ledger if not r["user_id"]])
        assert totals["users"] == User.objects.count()
        assert totals["organizations"] == Organization.objects.count()
        solo = User.objects.filter(org_memberships__isnull=True).count()
        assert totals["individual_accounts"] == solo
        assert totals["accounts"] == Organization.objects.count() + solo
        assert totals["seats_used"] == OrganizationMember.objects.count() + solo
        assert datetime.fromisoformat(totals["period"]["month_start"]) == MONTH_START

    def test_users_and_accounts_add_up_to_the_totals(self, world):
        totals = _get(OVERVIEW)["totals"]

        def every(path):
            rows, offset = [], 0
            while True:
                page = _get(path, limit=100, offset=offset)
                rows += page["rows"]
                offset += 100
                if offset >= page["total"]:
                    return rows

        users, accounts = every(USERS), every(ACCOUNTS)

        def add(rows):
            out = {p: dict.fromkeys(("input", "output", "total", "requests"), 0)
                   for p in ("month", "all_time")}
            for r in rows:
                for p in out:
                    for f in out[p]:
                        out[p][f] += r["tokens"][p][f]
            return out

        assert len(users) == totals["users"]
        assert add(users) == totals["tokens"]
        assert add(accounts) == totals["tokens"]
        assert sum(a["seats_used"] for a in accounts) == totals["seats_used"]
        assert len(accounts) == totals["accounts"]
        for period in ("month", "all_time"):
            cost = sum(Decimal(u["cost_usd"][period]) for u in users)
            assert cost == Decimal(totals["cost_usd"][period])
            cost = sum(Decimal(a["cost_usd"][period]) for a in accounts)
            assert cost == Decimal(totals["cost_usd"][period])


class TestBoundedQueries:
    def _count(self, path, **params):
        with CaptureQueriesContext(connection) as ctx:
            _get(path, **params)
        return len(ctx.captured_queries)

    def test_query_count_does_not_grow_with_rows(self, world):
        users_small = self._count(USERS, search=world["marker"], limit=1)
        # Three rows: both organizations and one individual account, so
        # every grouped query runs on both sides of the comparison.
        accounts_small = self._count(ACCOUNTS, search=world["marker"], limit=3)
        for i in range(6):
            extra = UserFactory(email=f"extra{i}-{world['marker']}@example.com")
            OrganizationMember.objects.create(organization=world["acme"], user=extra)
            _row(extra, 1, 1, NOW)
        assert self._count(USERS, search=world["marker"], limit=200) == users_small
        assert self._count(ACCOUNTS, search=world["marker"], limit=100) == accounts_small
