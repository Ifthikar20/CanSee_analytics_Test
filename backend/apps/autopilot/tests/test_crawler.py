"""The EngineScan edit (backend 4h): ``actor`` and ``usage_tags`` reach each
answer's usage row, ``audit_id`` is known once an engine was asked, and a
caller that passes nothing (the agent's swarm) is tagged exactly as before."""

import pytest

from apps.accounts.models import AITokenUsage
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import make_prompt
from apps.llm_ranking.models import LLMRankingAudit
from apps.prompt_library.services import prompt_crawler
from apps.prompt_library.services.prompt_crawler import EngineScan

pytestmark = pytest.mark.django_db


def test_a_scan_with_no_tags_is_tagged_as_before(website, engines):
    engines.enable("claude")
    bp = make_prompt(website, "best notes app")
    scan = EngineScan(website, bp.prompt, acting_user=website.user)
    assert scan.audit_id is None
    answer = scan.ask("claude", None)
    assert answer.succeeded
    assert scan.audit_id == str(LLMRankingAudit.objects.get().id)
    scan.finish()
    (row,) = AITokenUsage.objects.all()
    assert row.metadata == {"role": "upstream", "audit_id": scan.audit_id, "actor": "user"}


def test_actor_and_usage_tags_reach_the_ledger(website, engines):
    engines.enable("claude")
    bp = make_prompt(website, "best notes app")
    scan = EngineScan(website, bp.prompt, acting_user=website.user, actor="system",
                      usage_tags={"feature": "autopilot", "autopilot_run": "run-1",
                                  "actor": "spoofed"})
    scan.ask("claude", "claude:claude-opus-5")
    scan.finish()
    (row,) = AITokenUsage.objects.all()
    assert row.metadata == {"role": "upstream", "audit_id": scan.audit_id, "actor": "system",
                            "feature": "autopilot", "autopilot_run": "run-1"}
    assert row.model_name == "claude-opus-5" and row.user_id == website.user_id


def test_query_with_retry_merges_the_tags_on_every_attempt(website):
    seen = []

    class Flaky:
        def query(self, prompt, **kwargs):
            seen.append(kwargs["extra_metadata"])
            raise RuntimeError("down")

    assert prompt_crawler._query_with_retry(Flaky(), "q", extra_metadata={"feature": "x"}) is None
    assert seen == [{"feature": "x", "actor": "system"}] * 2
    seen.clear()
    prompt_crawler._query_with_retry(Flaky(), "q", actor="user")
    assert seen == [{"actor": "user"}] * 2
