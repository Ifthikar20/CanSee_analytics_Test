"""ask_haiku_standalone (backend 1e): the request, the ledger rows tagged
with the caller's run, Stop and the allowance before anything is sent, and
the failure codes. Every request goes to a FakeAnthropic."""

import pytest
from pydantic import BaseModel

from apps.accounts.models import AITokenUsage
from apps.agent.llm.worker import ask_haiku_standalone
from apps.agent.tests.fakes import http_error, message, refusal, text
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import HAIKU, haiku

pytestmark = pytest.mark.django_db

SCHEMA = {"type": "object", "properties": {"label": {"type": "string"}},
          "required": ["label"], "additionalProperties": False}
CONTENT = [{"type": "text", "text": "<answer>\nFixture Notes is easy to set up.\n</answer>"}]


class Out(BaseModel):
    label: str


def ask(user, website, **kwargs):
    args = {
        "user": user, "website": website, "system": "You read one answer.", "content": CONTENT,
        "schema": SCHEMA, "output_model": Out, "timeout": 30, "audit_id": "insights-run:abc",
        "role": "answer_analysis", "step": "run1:result1:extract",
    }
    args.update(kwargs)
    return ask_haiku_standalone(**args)


def test_the_request_and_its_ledger_row(user, website, fake_anthropic):
    fake_anthropic.queue(haiku({"label": "easy to set up"}, input_tokens=1000, output_tokens=200))

    result = ask(user, website, max_tokens=3000)

    assert result.ok and result.data.label == "easy to set up"
    body = fake_anthropic.last_request.json
    assert body == {
        "model": HAIKU,
        "max_tokens": 3000,
        "system": [{"type": "text", "text": "You read one answer."}],
        "thinking": {"type": "disabled"},
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        "messages": [{"role": "user", "content": CONTENT}],
    }
    row = AITokenUsage.objects.get()
    assert (row.module, row.model_name, row.user, row.website) == ("insights", HAIKU, user, website)
    assert (row.input_tokens, row.output_tokens) == (1000, 200)
    assert row.metadata["audit_id"] == "insights-run:abc"
    assert row.metadata["role"] == "answer_analysis"
    assert row.metadata["iteration"] == "request"
    assert row.idempotency_key == "insights:run1:result1:extract:0"
    assert row.estimated_cost_usd > 0


def test_default_max_tokens_and_another_module(user, website, fake_anthropic):
    fake_anthropic.queue(haiku({"label": "x"}))
    ask(user, website, module="agent", role="context_build", step="r:who")
    assert fake_anthropic.last_request.json["max_tokens"] == 2048
    row = AITokenUsage.objects.get()
    assert (row.module, row.idempotency_key) == ("agent", "agent:r:who:0")


def test_a_long_step_is_shortened_to_a_digest(user, website, fake_anthropic):
    fake_anthropic.queue(haiku({"label": "x"}))
    ask(user, website, step="s" * 200)
    key = AITokenUsage.objects.get().idempotency_key
    assert len(key) <= 120 and key.startswith("insights:") and key.endswith(":0")


def test_stop_and_the_allowance_send_nothing(user, website, fake_anthropic, monkeypatch):
    result = ask(user, website, should_stop=lambda: True)
    assert (result.ok, result.code) == (False, "cancelled")

    monkeypatch.setattr("apps.agent.llm.worker.allowance_denial",
                        lambda u: "monthly_ai_allowance_exceeded")
    result = ask(user, website)
    assert (result.ok, result.code, result.message) == (
        False, "allowance_exceeded", "The monthly AI allowance is used up.")
    assert fake_anthropic.requests == []
    assert not AITokenUsage.objects.exists()


@pytest.mark.parametrize(("scripted", "code"), [
    (lambda: refusal(text("No.")), "refused"),
    (lambda: message(text('{"label": "cut'), stop_reason="max_tokens"), "invalid_output"),
    (lambda: message(text("not json")), "invalid_output"),
    (lambda: http_error(529), "rate_limited"),
    (lambda: http_error(500, "api_error", "Internal"), "upstream_error"),
])
def test_failures_have_codes_and_never_raise(user, website, fake_anthropic, scripted, code):
    fake_anthropic.queue(scripted())
    result = ask(user, website)
    assert (result.ok, result.code) == (False, code)
    assert result.message


def test_no_client_is_an_upstream_error_not_an_exception(user, website):
    # The autouse fixture installs a client that refuses every request.
    result = ask(user, website)
    assert (result.ok, result.code) == (False, "upstream_error")
