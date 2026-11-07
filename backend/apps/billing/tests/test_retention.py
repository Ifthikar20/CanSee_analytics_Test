"""prune_llm_results applies the published windows to Ask AI answers (backend 3d)."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.analytics.tasks import prune_llm_results
from apps.billing.tests.support import *  # noqa: F403
from apps.prompt_box.models import PromptBoxAnswer, PromptBoxRun

pytestmark = pytest.mark.django_db


def _run(website, days_old: int, engines=("chatgpt", "gemini")) -> PromptBoxRun:
    run = PromptBoxRun.objects.create(
        website=website, text="best crm for florists", samples=1, engines=list(engines),
        status=PromptBoxRun.STATUS_DONE,
    )
    PromptBoxRun.objects.filter(id=run.id).update(
        created_at=timezone.now() - timedelta(days=days_old),
    )
    for engine in engines:
        PromptBoxAnswer.objects.create(
            run=run, engine=engine, provider="gpt4" if engine == "chatgpt" else engine,
            sample=1, status="done", mentioned=True, answer_text="1. Northwind CRM",
        )
    return run


@pytest.fixture
def windows(settings):
    settings.LLM_RESULT_RETENTION_DAYS = 730
    settings.GROUNDED_RESULT_MAX_RETENTION_DAYS = 30
    return settings


def test_old_runs_go_with_their_answers_and_grounded_gemini_answers_after_30_days(
        website, windows):
    windows.LLM_WEBSEARCH_ENABLED = True
    ancient, month_old, fresh_run = _run(website, 800), _run(website, 40), _run(website, 1)

    counts = prune_llm_results(dry_run=True)
    assert (counts["prompt_box_runs"], counts["prompt_box_answers_gemini"]) == (1, 2)
    assert PromptBoxRun.objects.count() == 3

    counts = prune_llm_results()
    assert counts["prompt_box_runs"] == 1
    assert not PromptBoxRun.objects.filter(id=ancient.id).exists()
    assert not PromptBoxAnswer.objects.filter(run_id=ancient.id).exists()
    assert list(month_old.answers.values_list("engine", flat=True)) == ["chatgpt"]
    assert sorted(fresh_run.answers.values_list("engine", flat=True)) == ["chatgpt", "gemini"]


def test_ungrounded_gemini_answers_keep_the_general_window(website, windows):
    windows.LLM_WEBSEARCH_ENABLED = False
    month_old = _run(website, 40)
    counts = prune_llm_results()
    assert (counts["prompt_box_runs"], counts["prompt_box_answers_gemini"]) == (0, 0)
    assert month_old.answers.count() == 2
