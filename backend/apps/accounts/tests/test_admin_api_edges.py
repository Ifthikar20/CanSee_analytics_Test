"""Internal admin API edges: paging bounds, seat arithmetic at the cap,
read-only on every verb, the sliding rate window, and the 30/7-day
overview windows."""
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.api.v1 import admin_views
from apps.accounts.api.v1.admin_views import InternalAdminView
from apps.accounts.models import (
    AITokenUsage,
    Invitation,
    Organization,
    OrganizationMember,
    User,
)
from apps.accounts.services.token_usage import (
    add_usage,
    empty_usage,
    month_start_utc,
    usage_by_user,
    usage_totals,
)
from apps.accounts.tests.factories import UserFactory
from apps.billing.models import Subscription
from core.utils.constants import Plan, SubscriptionStatus

OVERVIEW = "/api/v1/internal/admin/overview/"
USERS = "/api/v1/internal/admin/users/"
ACCOUNTS = "/api/v1/internal/admin/accounts/"
ENDPOINTS = [OVERVIEW, USERS, ACCOUNTS]
KEY = "edge-ops-key"

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def ops(settings):
    settings.ADMIN_OPS_KEY = KEY
    settings.ADMIN_OPS_ALLOWED_CIDRS = ["127.0.0.0/8"]
    settings.ORG_FEATURES_ENABLED = True
    InternalAdminView._requests.clear()
    yield settings
    InternalAdminView._requests.clear()


def _client(key=KEY):
    client = APIClient()
    if key is not None:
        client.credentials(HTTP_X_ADMIN_KEY=key)
    return client


def _get(path, **params):
    resp = _client().get(path, params)
    assert resp.status_code == 200, resp.content
    return resp.json()["data"]


@pytest.fixture
def marker():
    return uuid.uuid4().hex[:10]


def _org(owner, *members, plan=Plan.PROMPTS_200, **fields):
    org = Organization.objects.create(
        name=f"Org {uuid.uuid4().hex[:6]}", slug=uuid.uuid4().hex[:12], owner=owner,
        plan=plan, **fields,
    )
    OrganizationMember.objects.create(organization=org, user=owner, role="owner")
    for m in members:
        OrganizationMember.objects.create(organization=org, user=m, role="member")
    return org


# ── Read-only and the gate ─────────────────────────────────────────


@pytest.mark.parametrize("path", ENDPOINTS)
@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
class TestReadOnly:
    def test_every_write_verb_is_refused_and_writes_nothing(self, path, method):
        users, orgs = User.objects.count(), Organization.objects.count()
        resp = getattr(_client(), method)(path, {"email": "x@example.com"}, format="json")
        assert resp.status_code == 405
        assert (User.objects.count(), Organization.objects.count()) == (users, orgs)

    def test_without_the_key_a_write_is_404_not_405(self, path, method):
        resp = getattr(_client(key=None), method)(path, {}, format="json")
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize("path", ENDPOINTS)
def test_ipv6_allow_list_entry(ops, path):
    ops.ADMIN_OPS_ALLOWED_CIDRS = ["::1/128"]
    assert _client().get(path, REMOTE_ADDR="::1").status_code == 200
    assert _client().get(path, REMOTE_ADDR="127.0.0.1").status_code == 404


def test_denied_and_allowed_requests_are_audited(monkeypatch):
    events = []
    monkeypatch.setattr(admin_views, "audit_log",
                        lambda event, **kw: events.append((event, kw["metadata"]["ip"])))
    _client(key="wrong").get(OVERVIEW)
    _client().get(OVERVIEW)
    assert events == [("admin_ops.denied", "127.0.0.1"), ("admin_ops.request", "127.0.0.1")]


class TestRateWindow:
    def test_the_window_slides(self, monkeypatch):
        clock = {"t": 1000.0}
        monkeypatch.setattr(admin_views.time, "monotonic", lambda: clock["t"])
        client = _client()
        for _ in range(InternalAdminView._MAX_PER_WINDOW):
            assert client.get(OVERVIEW).status_code == 200
        assert client.get(OVERVIEW).status_code == 429
        clock["t"] += InternalAdminView._WINDOW_S  # exactly 60 s: still inside
        assert client.get(OVERVIEW).status_code == 429
        clock["t"] += 0.001
        assert client.get(OVERVIEW).status_code == 200

    def test_a_refused_request_does_not_use_the_window(self):
        for _ in range(InternalAdminView._MAX_PER_WINDOW + 5):
            assert _client(key="wrong").get(OVERVIEW).status_code == 404
        assert _client().get(OVERVIEW).status_code == 200


# ── Paging ──────────────────────────────────────────────────────────


class TestPaging:
    @pytest.mark.parametrize("path, maximum", [(USERS, 200), (ACCOUNTS, 100)])
    def test_limit_is_clamped(self, path, maximum):
        assert _get(path, limit=10_000)["limit"] == maximum
        assert _get(path, limit=0)["limit"] == 1
        assert _get(path, limit=-5)["limit"] == 1

    @pytest.mark.parametrize("path, default", [(USERS, 50), (ACCOUNTS, 25)])
    def test_garbage_falls_back_to_defaults(self, path, default):
        body = _get(path, limit="ten", offset="x")
        assert (body["limit"], body["offset"]) == (default, 0)

    @pytest.mark.parametrize("path", [USERS, ACCOUNTS])
    def test_negative_offset_is_zero(self, path, marker):
        UserFactory(email=f"a-{marker}@example.com")
        body = _get(path, search=marker, offset=-3)
        assert body["offset"] == 0
        assert len(body["rows"]) == 1

    def test_a_one_row_page_returns_one_row(self, marker):
        for i in range(3):
            UserFactory(email=f"p{i}-{marker}@example.com")
        assert len(_get(USERS, search=marker, limit=1)["rows"]) == 1

    def test_search_is_trimmed(self, marker):
        UserFactory(email=f"trim-{marker}@example.com")
        assert _get(USERS, search=f"   {marker}  ")["total"] == 1
        assert _get(ACCOUNTS, search=f"  {marker} ")["total"] == 1

    def test_individual_only_and_organization_only(self, marker):
        solo = UserFactory(email=f"solo-{marker}@example.com")
        boss = UserFactory(email=f"boss-{marker}@example.com")
        org = _org(boss)
        orgs = _get(ACCOUNTS, search=marker, type="organization")
        assert [r["id"] for r in orgs["rows"]] == [str(org.id)]
        assert (orgs["organizations"], orgs["individual_accounts"]) == (1, 0)
        solos = _get(ACCOUNTS, search=marker, type="individual")
        assert [r["id"] for r in solos["rows"]] == [str(solo.id)]
        assert (solos["organizations"], solos["individual_accounts"]) == (0, 1)


# ── Seats ───────────────────────────────────────────────────────────


class TestSeatArithmetic:
    def _row(self, org, marker):
        body = _get(ACCOUNTS, search=marker, type="organization")
        return next(r for r in body["rows"] if r["id"] == str(org.id))

    def test_exactly_at_the_cap_is_full_but_not_over(self, marker):
        owner = UserFactory(email=f"o-{marker}@example.com")
        org = _org(owner, plan=Plan.PROMPTS_100)
        row = self._row(org, marker)
        assert (row["seat_limit"], row["seats_used"], row["seats_available"]) == (1, 1, 0)
        assert row["over_limit"] is False

    def test_one_over_the_cap_is_over(self, marker):
        owner = UserFactory(email=f"o-{marker}@example.com")
        org = _org(owner, UserFactory(), plan=Plan.PROMPTS_100)
        row = self._row(org, marker)
        assert (row["seats_used"], row["seats_available"], row["over_limit"]) == (2, 0, True)

    def test_pending_invites_take_available_seats(self, marker):
        owner = UserFactory(email=f"o-{marker}@example.com")
        org = _org(owner, UserFactory(), plan=Plan.PROMPTS_200)
        for i in range(2):
            Invitation.objects.create(
                organization=org, email=f"i{i}@example.com", token_hash=uuid.uuid4().hex,
                expires_at=timezone.now() + timedelta(days=1),
            )
        row = self._row(org, marker)
        assert (row["seat_limit"], row["seats_used"], row["pending_invites"]) == (5, 2, 2)
        assert row["seats_available"] == 1
        assert row["over_limit"] is False

    @pytest.mark.parametrize("plan, limit, available", [
        (Plan.FREE, 1, 0), (Plan.PROMPTS_100, 1, 0), (Plan.PROMPTS_200, 5, 4),
        (Plan.BUSINESS, -1, -1),
    ])
    def test_individual_account_seats_follow_the_subscription(self, marker, plan, limit,
                                                              available):
        user = UserFactory(email=f"ind-{marker}@example.com")
        if plan != Plan.FREE:
            Subscription.objects.create(user=user, plan=plan, status=SubscriptionStatus.ACTIVE)
        row = _get(ACCOUNTS, search=marker, type="individual")["rows"][0]
        assert (row["plan"], row["seat_limit"], row["seats_available"]) == (
            plan, limit, available)
        assert (row["seats_used"], row["pending_invites"], row["over_limit"]) == (1, 0, False)

    def test_users_row_uses_the_earliest_membership(self, marker):
        """Plan resolution takes the first membership; the directory agrees."""
        user = UserFactory(email=f"two-{marker}@example.com")
        first = _org(UserFactory(), plan=Plan.PROMPTS_100)
        second = _org(UserFactory(), plan=Plan.BUSINESS)
        OrganizationMember.objects.create(organization=first, user=user, role="viewer")
        later = OrganizationMember.objects.create(organization=second, user=user, role="admin")
        OrganizationMember.objects.filter(pk=later.pk).update(
            created_at=timezone.now() + timedelta(minutes=5))
        row = _get(USERS, search=f"two-{marker}")["rows"][0]
        assert row["organization"]["id"] == str(first.id)
        assert (row["organization"]["role"], row["plan"]) == ("viewer", "prompts_100")


# ── Overview windows ────────────────────────────────────────────────


class TestOverviewWindows:
    def test_new_users_7d_and_30d(self):
        before = _get(OVERVIEW)["users"]
        recent = UserFactory()
        older = UserFactory()
        User.objects.filter(pk=older.pk).update(created_at=timezone.now() - timedelta(days=10))
        ancient = UserFactory()
        User.objects.filter(pk=ancient.pk).update(created_at=timezone.now() - timedelta(days=40))
        after = _get(OVERVIEW)["users"]
        assert after["total"] - before["total"] == 3
        assert after["new_30d"] - before["new_30d"] == 2
        assert after["new_7d"] - before["new_7d"] == 1
        assert recent

    def test_ai_usage_is_the_last_30_days(self):
        before = _get(OVERVIEW)["ai_usage"]
        user = UserFactory()
        for days, tokens, cost in ((1, 100, "0.5"), (29, 10, "0.25"), (31, 5000, "9")):
            row = AITokenUsage.objects.create(
                user=user, module="rag", model_name="m", total_tokens=tokens,
                estimated_cost_usd=Decimal(cost),
            )
            AITokenUsage.objects.filter(pk=row.pk).update(
                created_at=timezone.now() - timedelta(days=days))
        after = _get(OVERVIEW)["ai_usage"]
        assert after["tokens_30d"] - before["tokens_30d"] == 110
        assert after["cost_30d_usd"] - before["cost_30d_usd"] == pytest.approx(0.75)

    def test_pending_invites_total_counts_live_invites_only(self):
        before = _get(OVERVIEW)["totals"]["pending_invites"]
        org = _org(UserFactory())
        now = timezone.now()
        for i, fields in enumerate((
            {"expires_at": now + timedelta(days=1)},
            {"expires_at": now - timedelta(seconds=1)},
            {"expires_at": now + timedelta(days=1), "revoked_at": now},
            {"expires_at": now + timedelta(days=1), "accepted_at": now},
        )):
            Invitation.objects.create(organization=org, email=f"t{i}@example.com",
                                      token_hash=uuid.uuid4().hex, **fields)
        assert _get(OVERVIEW)["totals"]["pending_invites"] - before == 1

    def test_subscription_status_counts(self):
        before = _get(OVERVIEW)["subscriptions"]
        for status in (SubscriptionStatus.TRIALING, SubscriptionStatus.PAST_DUE,
                       SubscriptionStatus.CANCELED, SubscriptionStatus.CANCELED):
            Subscription.objects.create(user=UserFactory(), plan=Plan.PRO, status=status)
        after = _get(OVERVIEW)["subscriptions"]
        assert {k: after[k] - before[k] for k in after} == {
            "active": 0, "trialing": 1, "past_due": 1, "canceled": 2}


# ── Token usage service ─────────────────────────────────────────────


class TestTokenUsageService:
    def test_month_start_is_computed_in_utc(self):
        from zoneinfo import ZoneInfo

        # 00:30 on 1 December in Berlin is still 30 November in UTC.
        berlin = datetime(2026, 12, 1, 0, 30, tzinfo=ZoneInfo("Europe/Berlin"))
        assert month_start_utc(berlin) == datetime(2026, 11, 1, tzinfo=UTC)
        # 20:00 on 31 January in New York is already 1 February in UTC.
        ny = datetime(2026, 1, 31, 20, 0, tzinfo=ZoneInfo("America/New_York"))
        assert month_start_utc(ny) == datetime(2026, 2, 1, tzinfo=UTC)
        assert month_start_utc(ny).tzinfo == UTC

    def test_month_start_defaults_to_now(self):
        now = datetime.now(UTC)
        start = month_start_utc()
        assert start.tzinfo == UTC
        assert (start.year, start.month, start.day, start.hour) == (now.year, now.month, 1, 0)

    def test_empty_inputs(self):
        assert usage_by_user([], month_start_utc()) == {}
        assert add_usage([]) == empty_usage()
        assert empty_usage()["cost_usd"] == {"month": "0.000000", "all_time": "0.000000"}

    def test_each_ledger_row_is_one_request_and_fields_stay_separate(self):
        user = UserFactory()
        for inp, out in ((10, 1), (20, 2), (30, 3)):
            AITokenUsage.objects.create(user=user, module="rag", model_name="m",
                                        input_tokens=inp, output_tokens=out,
                                        total_tokens=inp + out,
                                        estimated_cost_usd=Decimal("0.000001"))
        block = usage_by_user([user.id], month_start_utc())[user.id]
        assert block["tokens"]["month"] == {"input": 60, "output": 6, "total": 66, "requests": 3}
        assert block["tokens"]["all_time"] == block["tokens"]["month"]
        assert block["cost_usd"]["all_time"] == "0.000003"

    def test_totals_split_attributed_and_unattributed(self):
        before = usage_totals(month_start_utc())
        AITokenUsage.objects.create(user=UserFactory(), module="rag", model_name="m",
                                    input_tokens=5, output_tokens=5, total_tokens=10,
                                    estimated_cost_usd=Decimal("0.1"))
        AITokenUsage.objects.create(user=None, module="onboarding", model_name="m",
                                    input_tokens=7, output_tokens=0, total_tokens=7,
                                    estimated_cost_usd=Decimal("0.2"))
        after = usage_totals(month_start_utc())
        for side, total, cost in (("attributed", 10, "0.1"), ("unattributed", 7, "0.2")):
            delta = (after[side]["tokens"]["all_time"]["total"]
                     - before[side]["tokens"]["all_time"]["total"])
            assert delta == total, side
            assert (Decimal(after[side]["cost_usd"]["month"])
                    - Decimal(before[side]["cost_usd"]["month"])) == Decimal(cost)

    def test_add_usage_is_exact(self):
        a = usage_by_user([], month_start_utc())
        assert a == {}
        block = empty_usage()
        block["tokens"]["month"]["input"] = 3
        block["cost_usd"]["month"] = "0.100000"
        other = empty_usage()
        other["tokens"]["month"]["input"] = 4
        other["cost_usd"]["month"] = "0.200000"
        summed = add_usage([block, other])
        assert summed["tokens"]["month"]["input"] == 7
        assert summed["cost_usd"]["month"] == "0.300000"
