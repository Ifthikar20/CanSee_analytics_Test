"""Where the free plan's prompt runs are shown: GET billing/prompt-runs/,
the usage endpoints, and the AI spend backstop's dollar-free denial."""
import pytest
from django.urls import reverse

from apps.billing.tests.support import *  # noqa: F403
from apps.billing.tests.support import client_for, data, make_website, subscribe
from apps.metering.services import prompt_runs
from apps.metering.tests.prompt_run_support import use_runs
from core.llm import ProviderResult
from core.utils.constants import Plan

pytestmark = pytest.mark.django_db

URL = "/api/v1/billing/prompt-runs/"


def test_the_endpoint_reports_used_and_remaining(user):
    website = make_website(user)
    prompt_runs.guard(lambda: ProviderResult(succeeded=True, text="answer"), user=user,
                      website=website, engine="gpt4", feature="prompt_box")
    body = data(client_for(user).get(URL))
    assert (body["unlimited"], body["limit"], body["used"], body["remaining"]) == (
        False, 20, 1, 19)
    assert body["by_feature"] == {"prompt_box": 1} and body["by_engine"] == {"chatgpt": 1}
    assert reverse("billing-prompt-runs") == URL


def test_a_shared_project_reads_its_owners_runs(user, make_user):
    from apps.billing.tests.support import org_with

    owner = make_user()
    # A free organization: its members share the owner's count.
    org = org_with(owner, user, plan=Plan.FREE)
    website = make_website(owner, organization=org)
    use_runs(owner, 12, website)
    body = data(client_for(user).get(f"{URL}?website_id={website.id}"))
    assert (body["remaining"], body["scope"]) == (8, "organization")
    # The member's own account is the same organization count.
    assert data(client_for(user).get(URL))["remaining"] == 8


def test_a_project_you_cannot_see_is_not_found(user, make_user):
    stranger_site = make_website(make_user())
    assert client_for(user).get(f"{URL}?website_id={stranger_site.id}").status_code == 404


def test_signed_out_is_refused(client):
    assert client.get(URL).status_code == 401


def test_paid_plans_are_unlimited(user):
    subscribe(user, Plan.PROMPTS_200)
    body = data(client_for(user).get(URL))
    assert (body["unlimited"], body["limit"], body["remaining"]) == (True, None, None)


def test_the_usage_endpoints_carry_the_runs(user):
    website = make_website(user)
    client = client_for(user)
    first = data(client.get(reverse("auth-ai-usage")))
    assert first["prompt_runs"]["used"] == 0
    use_runs(user, 5, website)
    # The usage summary is cached for a minute; the runs are always fresh.
    assert data(client.get(reverse("auth-ai-usage")))["prompt_runs"]["remaining"] == 15
    assert data(client.get(reverse("billing-token-usage")))["prompt_runs"]["remaining"] == 15


def test_the_free_backstop_denies_without_dollars(user, settings):
    from core.llm.base import allowance_denial

    settings.AI_FREE_MONTHLY_CAP_USD = 0.5
    from apps.accounts.models import AITokenUsage

    AITokenUsage.objects.create(user=user, module="agent", provider="anthropic",
                                model_name="claude-opus-5-5", estimated_cost_usd=0.6)
    denial = allowance_denial(user)
    assert denial == ("monthly_ai_allowance_exceeded: the account has used this month's free "
                      "AI allowance")
    assert "$" not in denial


def test_a_paid_denial_keeps_its_amount(user):
    from apps.accounts.models import AITokenUsage
    from core.llm.base import allowance_denial

    subscribe(user, Plan.PROMPTS_100)
    AITokenUsage.objects.create(user=user, module="agent", provider="anthropic",
                                model_name="claude-opus-5-5", estimated_cost_usd=60)
    from apps.billing.tests.support import fresh

    assert allowance_denial(fresh(user)) == (
        "monthly_ai_allowance_exceeded: the account has used its $52.00 monthly AI allowance")


def test_the_free_backstop_defaults_to_three_dollars(monkeypatch):
    import importlib

    import config.settings.base as base

    monkeypatch.delenv("AI_FREE_MONTHLY_CAP_USD", raising=False)
    monkeypatch.delenv("FREE_MONTHLY_PROMPT_RUNS", raising=False)
    reloaded = importlib.reload(base)
    assert reloaded.AI_FREE_MONTHLY_CAP_USD == 3.0
    assert reloaded.FREE_MONTHLY_PROMPT_RUNS == 20
    assert reloaded.PROMPT_RUN_STALE_MINUTES == 30
