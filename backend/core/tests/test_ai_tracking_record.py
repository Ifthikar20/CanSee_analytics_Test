"""record_usage never breaks the call it records, and says when spend has
no account to count on; the free plan's hidden dollar backstop prices the
account's plan, never a paid tier's."""
from unittest.mock import patch

import pytest

from apps.accounts.models import AITokenUsage
from apps.accounts.tests.factories import UserFactory
from core import ai_tracking

pytestmark = pytest.mark.django_db


def _record(**kwargs):
    defaults = dict(module="llm_ranking", model_name="gpt-4o-mini", input_tokens=100,
                    output_tokens=50, provider="openai")
    defaults.update(kwargs)
    ai_tracking.record_usage(**defaults)


def _warnings(warn):
    return [call.args[0] % call.args[1:] for call in warn.call_args_list]


def test_unattributed_spend_outside_onboarding_is_logged():
    with patch.object(ai_tracking.logger, "warning") as warn:
        _record(user=None)
    assert "Unattributed AI usage recorded: module=llm_ranking model=gpt-4o-mini" in _warnings(warn)
    assert AITokenUsage.objects.filter(user=None).count() == 1


def test_unattributed_onboarding_spend_is_expected():
    with patch.object(ai_tracking.logger, "warning") as warn:
        _record(user=None, module="onboarding")
    assert warn.call_count == 0
    assert AITokenUsage.objects.filter(user=None, module="onboarding").count() == 1


def test_a_broken_ledger_never_breaks_the_call():
    with patch.object(AITokenUsage.objects, "get_or_create", side_effect=RuntimeError("db")), \
            patch.object(ai_tracking.logger, "warning") as warn:
        assert _record(user=UserFactory()) is None
    assert "Failed to record AI token usage: db" in _warnings(warn)
    assert AITokenUsage.objects.count() == 0


def test_a_replayed_key_is_recorded_once_and_bumps_spend_once():
    user = UserFactory()
    with patch("apps.metering.services.spend_counter.bump") as bump:
        _record(user=user, idempotency_key="cell:1")
        _record(user=user, idempotency_key="cell:1")
    assert AITokenUsage.objects.filter(idempotency_key="cell:1").count() == 1
    assert bump.call_count == 1


def test_the_free_backstop_is_the_setting_and_a_manual_cap_raises_it(settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 3.0
    user = UserFactory()
    assert ai_tracking.ai_allowance_plan(user) == "free"
    assert ai_tracking.effective_ai_cap(user) == 3.0
    user.monthly_ai_cost_cap_usd = 10
    assert ai_tracking.effective_ai_cap(user) == 10.0
    assert ai_tracking.effective_ai_cap(None) == 0.0
