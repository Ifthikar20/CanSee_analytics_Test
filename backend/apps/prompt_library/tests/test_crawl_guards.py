"""Check now and the scans that saving prompts starts: only a tracked
prompt is crawled, a crawl in flight refuses a second one, the monthly
prompt allowance and the prompt runs are checked first, onboarding's engine
choice limits the first scan, and the schedule skips a crawl the owner has
no runs for."""
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.llm_ranking.models import LLMRankingAudit
from apps.metering.tests.prompt_run_support import make_paid, use_runs
from apps.prompt_library.models import (
    BrandPrompt,
    Industry,
    Prompt,
    PromptCrawlRun,
    PromptSchedule,
    PromptSource,
)
from apps.prompt_library.services._hash import text_hash
from apps.websites.models import Website
from core.utils.constants import Plan

pytestmark = pytest.mark.django_db


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Site Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://northwind.example", name="Northwind")


@pytest.fixture
def api(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def keys(settings):
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    for name in ("GEMINI_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY"):
        setattr(settings, name, "")
    return settings


@pytest.fixture
def queued():
    with patch("apps.prompt_library.tasks.crawl_prompt_for_website.delay") as delay:
        yield delay


def _prompt(text="best crm for a small team", website=None):
    industry, _ = Industry.objects.get_or_create(
        slug="fixture-crm", defaults={"name": "CRM (fixture)", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, text_hash=text_hash(text),
        intent_bucket="category", style="question", source=PromptSource.MANUAL,
    )
    if website is not None:
        BrandPrompt.objects.create(website=website, prompt=prompt)
    return prompt


def _crawl_url(website, prompt):
    return reverse("prompt-library-website-prompt-crawl",
                   kwargs={"website_id": website.id, "prompt_id": prompt.id})


def _error(resp) -> dict:
    body = resp.json()
    err = body.get("error")
    return err if isinstance(err, dict) else body


# -- Check now ---------------------------------------------------------------------------


def test_check_now_queues_a_tracked_prompt(api, website, keys, queued):
    prompt = _prompt(website=website)
    resp = api.post(_crawl_url(website, prompt), {"mode": "missing"}, format="json")
    assert resp.status_code == 200
    queued.assert_called_once()


def test_a_prompt_not_tracked_here_is_not_found(api, website, keys, queued):
    stray = _prompt("a prompt of another project")
    resp = api.post(_crawl_url(website, stray), {}, format="json")
    assert resp.status_code == 404
    queued.assert_not_called()


def test_a_crawl_in_flight_refuses_a_second(api, website, keys, queued):
    prompt = _prompt(website=website)
    PromptCrawlRun.objects.create(website=website, prompt=prompt,
                                  status=PromptCrawlRun.STATUS_RUNNING, started_at=timezone.now())
    resp = api.post(_crawl_url(website, prompt), {}, format="json")
    assert resp.status_code == 409
    assert _error(resp)["error"] == "crawl_in_progress"
    queued.assert_not_called()


def test_a_second_click_before_the_worker_starts_is_refused(api, website, keys, queued):
    prompt = _prompt(website=website)
    first = api.post(_crawl_url(website, prompt), {}, format="json")
    assert first.status_code == 200
    # The task is only queued: no worker has created anything yet.
    run = PromptCrawlRun.objects.get(website=website, prompt=prompt)
    assert run.status == PromptCrawlRun.STATUS_PENDING
    assert queued.call_args.kwargs["crawl_run_id"] == str(run.id)

    second = api.post(_crawl_url(website, prompt), {}, format="json")
    assert second.status_code == 409
    assert _error(second)["error"] == "crawl_in_progress"
    assert queued.call_count == 1
    assert PromptCrawlRun.objects.filter(website=website, prompt=prompt).count() == 1


def test_a_refused_check_now_holds_no_slot(api, user, website, keys, queued):
    prompt = _prompt(website=website)
    use_runs(user, 20, website)
    assert api.post(_crawl_url(website, prompt), {}, format="json").status_code == 403
    assert not PromptCrawlRun.objects.filter(website=website, prompt=prompt).exists()


def test_a_task_whose_project_is_gone_frees_its_slot(website):
    import uuid

    from apps.prompt_library.tasks import crawl_prompt_for_website

    prompt = _prompt(website=website)
    run = PromptCrawlRun.objects.create(website=website, prompt=prompt,
                                        status=PromptCrawlRun.STATUS_PENDING)
    result = crawl_prompt_for_website.run(str(website.id), str(uuid.uuid4()),
                                          crawl_run_id=str(run.id))
    assert result["ok"] is False
    run.refresh_from_db()
    assert run.status == PromptCrawlRun.STATUS_FAILED


def test_a_crawl_left_running_past_the_stale_window_does_not_block(api, website, keys, queued):
    prompt = _prompt(website=website)
    run = PromptCrawlRun.objects.create(website=website, prompt=prompt,
                                        status=PromptCrawlRun.STATUS_RUNNING)
    PromptCrawlRun.objects.filter(id=run.id).update(created_at=timezone.now() - timedelta(hours=1))
    assert api.post(_crawl_url(website, prompt), {}, format="json").status_code == 200


def test_check_now_needs_a_prompt_run_left(api, user, website, keys, queued):
    prompt = _prompt(website=website)
    use_runs(user, 20, website)
    resp = api.post(_crawl_url(website, prompt), {}, format="json")
    assert resp.status_code == 403
    err = _error(resp)
    assert err["code"] == "prompt_runs_exhausted"
    assert (err["details"]["remaining"], err["details"]["limit"]) == (0, 20)
    queued.assert_not_called()


def test_check_now_spends_the_monthly_prompt_allowance(api, user, website, keys, queued, settings):
    # Pro (kept for its subscribers) has 100 prompts a month.
    settings.PAYWALL_ENABLED = True
    make_paid(user, Plan.PRO)
    for _ in range(4):
        LLMRankingAudit.objects.create(website=website, created_by=user, business_name="N",
                                       prompts=["p"] * 25, providers_queried=["gpt4"])
    resp = api.post(_crawl_url(website, _prompt(website=website)), {}, format="json")
    assert resp.status_code == 403
    assert _error(resp)["code"] == "prompt_allowance_exceeded"
    queued.assert_not_called()


# -- the scan saving prompts starts --------------------------------------------------------


def _add(api, website, **body):
    url = reverse("prompt-library-website-prompts", kwargs={"website_id": website.id})
    return api.post(url, {"text": "best crm for a small team\ncrm for startups", **body},
                    format="json")


def test_onboarding_engines_limit_the_first_scan(api, website, keys):
    with patch("apps.llm_ranking.services.scan_dispatch.dispatch_scan"):
        resp = _add(api, website, engines=["claude"])
    assert resp.status_code == 201
    body = resp.json().get("data", resp.json())
    audit = LLMRankingAudit.objects.get(id=body["scan_audit_id"])
    assert audit.providers_queried == ["claude"]
    # Nothing about the choice is saved on the prompts.
    assert all(not v for v in BrandPrompt.objects.values_list("model_variants", flat=True))


def test_an_unknown_engine_is_refused(api, website, keys):
    with patch("apps.llm_ranking.services.scan_dispatch.dispatch_scan") as dispatch:
        assert _add(api, website, engines=["deepthought"]).status_code == 400
    dispatch.assert_not_called()


def test_the_scan_needs_a_run_per_prompt_and_engine(api, user, website, keys):
    use_runs(user, 17, website)
    with patch("apps.llm_ranking.services.scan_dispatch.dispatch_scan") as dispatch:
        resp = _add(api, website)
    assert resp.status_code == 201  # the prompts are saved either way
    body = resp.json().get("data", resp.json())
    assert body["scan_audit_id"] is None
    assert body["scan_error"]["error"] == "insufficient_prompt_runs"
    assert body["scan_error"]["details"] == {
        "needed": 4, "remaining": 3, "limit": 20,
        "resets_at": body["scan_error"]["details"]["resets_at"]}
    dispatch.assert_not_called()
    # Limited to one engine at onboarding, the two prompts fit in the three runs.
    with patch("apps.llm_ranking.services.scan_dispatch.dispatch_scan"):
        body = _add(api, website, engines=["chatgpt"]).json()
    body = body.get("data", body)
    assert body["scan_error"] is None and body["scan_audit_id"]


def test_the_crawl_branch_checks_its_runs(api, user, website, keys, queued):
    use_runs(user, 19, website)
    with patch("apps.llm_ranking.providers.list_model_variants", return_value=[
        {"id": "gpt4:gpt-4o", "provider": "gpt4", "configured": True},
        {"id": "claude:sonnet", "provider": "claude", "configured": True},
    ]):
        resp = _add(api, website, models=["gpt4:gpt-4o", "claude:sonnet"])
    body = resp.json().get("data", resp.json())
    assert body["scan_error"]["error"] == "insufficient_prompt_runs"
    queued.assert_not_called()


# -- the schedule ------------------------------------------------------------------------------


def test_the_schedule_skips_a_crawl_the_owner_has_no_runs_for(user, website, keys, queued):
    from apps.prompt_library.tasks import dispatch_scheduled_prompt_scans

    teammate = get_user_model().objects.create_user(
        email="teammate@example.com", password="x" * 16, full_name="Teammate",
        is_email_verified=True,
    )
    prompt = _prompt(website=website)
    bp = BrandPrompt.objects.get(prompt=prompt)
    schedule = PromptSchedule.objects.create(
        brand_prompt=bp, created_by=teammate, frequency="daily",
        next_run_at=timezone.now() - timedelta(minutes=1), is_enabled=True,
    )
    # The crawl spends the owner's runs, not the schedule creator's.
    use_runs(user, 20, website)
    dispatch_scheduled_prompt_scans()
    queued.assert_not_called()
    schedule.refresh_from_db()
    assert schedule.next_run_at > timezone.now()

    use_runs(user, 0, website)
    PromptSchedule.objects.filter(id=schedule.id).update(
        next_run_at=timezone.now() - timedelta(minutes=1))
    dispatch_scheduled_prompt_scans()
    queued.assert_called_once()
