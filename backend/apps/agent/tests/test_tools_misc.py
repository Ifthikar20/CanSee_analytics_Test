"""Smaller tools, the snapshot, pricing rows and error classes."""

import json
from decimal import Decimal

import anthropic
import httpx2
import pytest

from apps.agent.llm.errors import classify
from apps.agent.llm.pricing import cost_for, usage_rows
from apps.agent.llm.snapshot import get_or_create_snapshot, snapshot_payload
from apps.agent.models import AgentMessage
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, send, tool_results_of
from apps.agent.tools.actions import parse_chart_spec

pytestmark = pytest.mark.usefixtures("no_title")


def test_chart_spec_rules_match_the_old_ui():
    spec = parse_chart_spec({
        "type": "pie", "title": "x" * 200, "unit": "percent",
        "labels": [f"L{i}" for i in range(20)],
        "datasets": [
            {"label": "Google", "data": [1, "2.5", None, "n/a", float("nan")]},
            {"label": "Empty", "data": [None, "x"]},
            {"label": "B", "data": [3]}, {"label": "C", "data": [4]}, {"label": "D", "data": [5]},
        ],
    })
    assert spec["type"] == "bar"
    assert len(spec["title"]) == 120 and spec["unit"] == "percent"[:8]
    assert len(spec["labels"]) == 12
    assert [d["label"] for d in spec["datasets"]] == ["Google", "B"]
    assert spec["datasets"][0]["data"] == [1, 2.5, None, None, None]
    assert parse_chart_spec({"labels": [], "datasets": [{"data": [1]}]}) is None
    assert parse_chart_spec({"labels": ["a"], "datasets": [{"data": [None]}]}) is None


def _tool_round(fake_anthropic, chat, name, args, text_in="Go"):
    fake_anthropic.queue(message(tool_use(name, args, id="toolu_t"), stop_reason="tool_use"),
                         message(text("Done.")))
    started = send(chat, text_in)
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    return msg, tool_results_of(fake_anthropic.requests[-1].json)[0]


@pytest.mark.django_db
def test_show_chart_adds_a_chart_part(fake_anthropic, chat):
    msg, result = _tool_round(fake_anthropic, chat, "show_chart", {"spec": {
        "type": "line", "title": "Rank by week", "labels": ["W1", "W2"],
        "datasets": [{"label": "Google", "data": [14, 9]}]}})
    chart = next(p for p in msg.parts if p["type"] == "chart")
    assert chart["spec"]["type"] == "line" and chart["spec"]["datasets"][0]["data"] == [14, 9]
    assert json.loads(result["content"])["shown"] is True

    _, bad = _tool_round(fake_anthropic, chat, "show_chart",
                         {"spec": {"type": "bar", "labels": [], "datasets": []}})
    assert bad["is_error"] is True


@pytest.mark.django_db
def test_open_in_browser_asks_before_opening_unknown_urls(fake_anthropic, chat, website):
    website.competitors = [{"name": "HubSpot", "domain": "hubspot.com"}]
    website.save(update_fields=["competitors"])

    msg, _ = _tool_round(fake_anthropic, chat, "open_in_browser",
                         {"url": "https://www.hubspot.com/pricing"})
    assert next(p for p in msg.parts if p["type"] == "browser_open")["requires_confirmation"] is False

    msg, _ = _tool_round(fake_anthropic, chat, "open_in_browser",
                         {"url": "https://unknown.example/page"})
    assert next(p for p in msg.parts if p["type"] == "browser_open")["requires_confirmation"] is True

    msg, _ = _tool_round(fake_anthropic, chat, "open_in_browser",
                         {"url": "https://mentioned.example/a"},
                         text_in="Look at https://mentioned.example/a")
    assert next(p for p in msg.parts if p["type"] == "browser_open")["requires_confirmation"] is False

    _, bad = _tool_round(fake_anthropic, chat, "open_in_browser", {"url": "javascript:alert(1)"})
    assert bad["is_error"] is True


@pytest.mark.django_db
def test_data_tools_read_the_project(fake_anthropic, chat, website, settings):
    settings.OPENAI_API_KEY = ""
    make_prompt(website, "best crm for startups")

    _, overview = _tool_round(fake_anthropic, chat, "get_project_overview", {})
    data = json.loads(overview["content"])
    assert data["kpis"]["prompts"] == 1 and data["prompts_total"] == 1
    assert data["prompts"][0]["text"] == "best crm for startups"

    _, listed = _tool_round(fake_anthropic, chat, "list_tracked_prompts",
                            {"gap_class": "ai_ahead"})
    assert json.loads(listed["content"])["total"] == 0

    _, brand = _tool_round(fake_anthropic, chat, "get_brand_context", {})
    brand_data = json.loads(brand["content"])
    assert brand_data["name"] == "Northwind" and brand_data["knowledge"] == []
    assert brand_data["knowledge_note"].endswith("OPENAI_API_KEY is not set.")

    _, answers = _tool_round(fake_anthropic, chat, "get_ai_answers",
                             {"prompt_id": "00000000-0000-0000-0000-000000000000"})
    assert answers["is_error"] is True and "list_tracked_prompts" in answers["content"]


@pytest.mark.django_db
def test_get_ai_answers_marks_answers_as_untrusted(fake_anthropic, chat, website):
    from apps.llm_ranking.models import LLMRankingAudit, LLMRankingResult

    bp = make_prompt(website, "best crm for startups")
    audit = LLMRankingAudit.objects.create(website=website, created_by=website.user)
    LLMRankingResult.objects.create(audit=audit, provider="claude", prompt=bp.prompt.text,
                                    source_prompt=bp.prompt, response_text="Try Northwind.",
                                    is_mentioned=True, mention_rank=1, sentiment="positive")

    _, result = _tool_round(fake_anthropic, chat, "get_ai_answers",
                            {"prompt_id": str(bp.prompt_id)})
    answer = json.loads(result["content"])["answers"][0]
    assert answer["engine"] == "claude" and answer["rank"] == 1
    assert answer["answer"] == {"untrusted": True, "source": "Claude answer",
                                "text": "Try Northwind."}


@pytest.mark.django_db
def test_snapshot_is_content_addressed_and_stable(settings):
    first = get_or_create_snapshot()
    again = get_or_create_snapshot()
    assert first.id == again.id and len(first.id) == 64
    tools = json.loads(first.tools_json)
    assert [t["name"] for t in tools] == sorted(t["name"] for t in tools)
    assert {"web_search", "web_fetch"} <= {t["name"] for t in tools}
    assert first.config["model"] == "claude-opus-5-5"
    assert first.config["thinking"] == {"type": "adaptive", "display": "summarized"}

    settings.AGENT_WEB_TOOLS_ENABLED = False
    without_web = get_or_create_snapshot()
    assert without_web.id != first.id
    assert "web_search" not in without_web.tools_json
    assert snapshot_payload()["system"] == first.system_text


def test_usage_rows_split_iterations_and_cache_ttls():
    rows = usage_rows("claude-opus-5-5", {
        "input_tokens": 10, "output_tokens": 5,
        "cache_creation_input_tokens": 300,
        "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 0},
        "server_tool_use": {"web_search_requests": 2},
    })
    assert len(rows) == 1
    assert (rows[0].cache_write_5m, rows[0].cache_write_1h) == (100, 200)
    assert rows[0].web_search_requests == 2
    expected = Decimal(str(round((10 * 4 + 5 * 20 + 100 * 5 + 200 * 8) / 1e6 + 0.02, 6)))
    assert cost_for("claude-opus-5-5", {
        "input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 300,
        "cache_creation": {"ephemeral_5m_input_tokens": 100},
        "server_tool_use": {"web_search_requests": 2},
    }) == expected

    rows = usage_rows("claude-opus-5-5", {
        "input_tokens": 999, "output_tokens": 999,
        "server_tool_use": {"web_search_requests": 1},
        "iterations": [
            {"type": "message", "input_tokens": 10, "output_tokens": 1,
             "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            {"type": "fallback_message", "model": "claude-opus-5", "input_tokens": 20,
             "output_tokens": 2, "cache_read_input_tokens": 5,
             "cache_creation_input_tokens": 0},
        ],
    })
    assert [(r.model, r.kind, r.input_tokens) for r in rows] == [
        ("claude-opus-5-5", "message", 10), ("claude-opus-5", "fallback_message", 20)]
    assert [r.web_search_requests for r in rows] == [0, 1]


def _status_error(status, error_type, message="m"):
    request = httpx2.Request("POST", "http://anthropic.test/v1/messages")
    response = httpx2.Response(status, request=request)
    body = {"type": "error", "error": {"type": error_type, "message": message}}
    return anthropic.APIStatusError(message, response=response, body=body)


def test_error_classes():
    assert classify(_status_error(200, "overloaded_error")).code == "upstream_overloaded"
    assert classify(_status_error(200, "api_error")).retry_in_run is True
    assert classify(_status_error(400, "invalid_request_error", "prompt is too long")).code == (
        "context_too_long")
    assert classify(_status_error(400, "invalid_request_error")).code == "bad_request"
    assert classify(RuntimeError("x")).code == "internal_error"
    request = httpx2.Request("POST", "http://anthropic.test/v1/messages")
    assert classify(anthropic.APIConnectionError(request=request)).code == "upstream_unreachable"


@pytest.mark.django_db
def test_smoke_command_checks_the_cache_and_refuses_without_a_key(fake_anthropic, settings):
    from io import StringIO

    from django.core.management import CommandError, call_command

    fake_anthropic.queue(message(text("ready"), cache_write_1h=4000),
                         message(text("ready"), cache_read=4000))
    out = StringIO()
    call_command("agent_smoke", stdout=out)
    assert "cache_read > 0 on the second request (4000)" in out.getvalue()
    assert all(r.streamed for r in fake_anthropic.requests)
    assert fake_anthropic.requests[0].json["system"] == fake_anthropic.requests[1].json["system"]

    fake_anthropic.queue(message(text("ready")), message(text("ready")))
    with pytest.raises(CommandError, match="did not read the prompt cache"):
        call_command("agent_smoke", stdout=StringIO())

    settings.ANTHROPIC_API_KEY = ""
    with pytest.raises(CommandError, match="ANTHROPIC_API_KEY is not set"):
        call_command("agent_smoke", stdout=StringIO())
