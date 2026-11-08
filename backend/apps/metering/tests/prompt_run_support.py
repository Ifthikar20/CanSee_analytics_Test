"""Helpers for tests that need a paid account or a free account with its
prompt runs used (apps.metering.services.prompt_runs)."""
from apps.billing.models import Subscription
from apps.metering.models import UsageCounter
from apps.metering.services import prompt_runs
from core.utils.constants import Plan, SubscriptionStatus


def make_paid(user, plan=Plan.PROMPTS_100):
    """Give ``user`` an active paid subscription (unlimited prompt runs).
    Creating the row through the user instance refreshes its cached
    ``subscription``, so objects holding this instance see it."""
    sub, _ = Subscription.objects.update_or_create(
        user=user, defaults={"plan": plan, "status": SubscriptionStatus.ACTIVE},
    )
    user.subscription = sub
    return user


def use_runs(user, n, website=None):
    """Mark ``n`` of the account's prompt runs as used this period."""
    account = prompt_runs.account_for(user, website)
    counter, _ = UsageCounter.objects.get_or_create(
        meter=UsageCounter.METER_PROMPT_RUNS, account_key=account.key,
        period_key=account.period_key,
    )
    UsageCounter.objects.filter(pk=counter.pk).update(value=n)
    return account
