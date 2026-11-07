"""The management command (backend 4g): --dry-run writes nothing, a run goes
through every stage inline, today's run existing exits with code 1, and
--dispatch is one dispatcher tick."""

import json
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.accounts.models import AITokenUsage
from apps.autopilot.models import AutopilotRun, AutopilotRunPrompt
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import BRAND, make_prompt
from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult

pytestmark = pytest.mark.django_db


def run_command(*args) -> str:
    out = StringIO()
    call_command("run_autopilot", *args, stdout=out)
    return out.getvalue()


def test_dry_run_prints_the_estimate_and_writes_nothing(website, engines):
    engines.enable("chatgpt", "claude")
    make_prompt(website, "best notes app")
    printed = json.loads(run_command("--website", str(website.id), "--dry-run"))
    assert printed["estimate"]["prompts"] == 1 and printed["estimate"]["answers_max"] == 2
    assert printed["plan"] == {"engines": ["ChatGPT", "Claude"], "ask": ["best notes app"],
                               "wait": [], "over_limit": 0, "google": False, "skip": None}
    assert engines.calls == []
    assert not AutopilotRun.objects.exists() and not AutopilotRunPrompt.objects.exists()
    assert not LLMRankingAudit.objects.exists() and not LLMRankingResult.objects.exists()
    assert not AITokenUsage.objects.exists()


def test_a_run_goes_through_every_stage_inline(website, engines, settings):
    settings.AUTOPILOT_RUN_MODE = "celery"     # the command runs inline whatever this says
    engines.enable("claude")
    make_prompt(website, "best notes app")
    printed = json.loads(run_command("--website", str(website.id), "--no-text"))
    run = AutopilotRun.objects.get()
    assert printed["run"]["id"] == str(run.id)
    assert (run.status, run.trigger, run.text_status) == ("done", "manual", "not_requested")
    assert printed["text"] == run.text_body
    assert printed["text"].startswith(f"Cansee daily, {BRAND}, first run:")
    assert len(engines.calls) == 1


def test_todays_run_existing_is_an_error(website, engines):
    engines.enable("claude")
    make_prompt(website, "best notes app")
    run_command("--website", str(website.id))
    with pytest.raises(CommandError) as caught:
        run_command("--website", str(website.id))
    assert str(caught.value) == "Today's run already happened. The next one is tomorrow at 07:00."
    assert AutopilotRun.objects.count() == 1


def test_bad_arguments(website):
    with pytest.raises(CommandError):
        run_command()
    with pytest.raises(CommandError):
        run_command("--website", "not-a-project")


def test_dispatch_is_one_tick(website):
    printed = json.loads(run_command("--dispatch"))
    assert printed == {"started": 0, "finalized": 0, "resumed": 0, "interrupted": 0,
                       "texts": 0}
