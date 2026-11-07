"""How each engine is localized for a country: the planned method, the
method an answer actually had (ProviderResult.searched), the region
instruction exactly once per engine, and the providers' searched flags.
The SDK clients are stubs; Perplexity's HTTP call goes through responses."""
import json
from types import SimpleNamespace

import pytest
import responses

from apps.llm_ranking.providers.claude import DEFAULT_SYSTEM, ClaudeProvider
from apps.llm_ranking.providers.grok import GrokProvider
from apps.llm_ranking.providers.openai import OpenAIProvider
from apps.llm_ranking.providers.perplexity import PerplexityProvider
from apps.llm_ranking.services import regions
from apps.search_gap.tests.country_support import *  # noqa: F403
from core.llm.base import ProviderResult

GB_INSTRUCTION = regions.region_system_instruction("gb")


class _Create:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.result


def _claude_reply(searches: int):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text="1. Northwind CRM\n2. Acme CRM", citations=None)],
        usage=SimpleNamespace(
            input_tokens=40, output_tokens=20,
            server_tool_use=SimpleNamespace(web_search_requests=searches),
        ),
        stop_reason="end_turn",
    )


def _chat_reply(text="1. Northwind CRM"):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text), finish_reason="stop")],
        usage=SimpleNamespace(prompt_tokens=30, completion_tokens=10),
    )


@pytest.fixture
def anthropic_stub(monkeypatch):
    import anthropic

    def build(searches=0):
        messages = _Create(_claude_reply(searches))
        monkeypatch.setattr(anthropic, "Anthropic", lambda **kwargs: SimpleNamespace(messages=messages))
        return messages

    return build


@pytest.fixture
def openai_stub(monkeypatch):
    import openai

    def build(*, output=None, chat_text="1. Northwind CRM"):
        reply = SimpleNamespace(
            output=output or [], output_text="1. Northwind CRM",
            usage=SimpleNamespace(input_tokens=30, output_tokens=10),
        )
        client = SimpleNamespace(
            responses=_Create(reply),
            chat=SimpleNamespace(completions=_Create(_chat_reply(chat_text))),
        )
        monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: client)
        return client

    return build


def test_planned_methods_follow_web_search(settings):
    settings.LLM_WEBSEARCH_ENABLED = False
    keys = ("gpt4", "claude", "gemini", "grok", "perplexity")
    assert {k: regions.planned_country_method(k) for k in keys} == {
        "gpt4": "asked", "claude": "asked", "gemini": "asked", "grok": "asked", "perplexity": "searched",
    }
    settings.LLM_WEBSEARCH_ENABLED = True
    assert regions.planned_country_method("gpt4") == "searched"
    assert regions.planned_country_method("claude") == "searched"
    # Their search takes no location, so they are still asked.
    assert regions.planned_country_method("gemini") == "asked"
    assert regions.planned_country_method("grok") == "asked"


def test_answer_method_comes_from_the_result():
    assert ProviderResult(succeeded=True).searched is False
    searched = ProviderResult(succeeded=True, searched=True)
    assert regions.answer_country_method("claude", searched) == "searched"
    assert regions.answer_country_method("perplexity", searched) == "searched"
    assert regions.answer_country_method("gpt4", ProviderResult(succeeded=True)) == "asked"
    # Gemini's search has no location even when it searched.
    assert regions.answer_country_method("gemini", searched) == "asked"
    assert regions.answer_country_method("grok", object()) == "asked"


@pytest.mark.parametrize("provider", ["claude", "gpt4", "perplexity"])
def test_located_engines_get_the_instruction_in_the_system_prompt(provider):
    prompt = regions.country_system_prompt(provider, "gb")
    assert prompt.startswith(DEFAULT_SYSTEM)
    assert prompt.count(GB_INSTRUCTION) == 1
    assert regions.country_system_prompt(provider, "uk") == prompt


@pytest.mark.parametrize("provider", ["gemini", "grok"])
def test_self_instructed_engines_add_it_themselves(provider):
    assert regions.country_system_prompt(provider, "gb") == DEFAULT_SYSTEM


def test_grok_ends_up_with_the_instruction_once(settings, openai_stub):
    settings.LLM_WEBSEARCH_ENABLED = False
    client = openai_stub()

    GrokProvider()._call(
        prompt="best crm", system_prompt=regions.country_system_prompt("grok", "gb"),
        region=regions.region_for_country("gb"),
    )

    system = client.chat.completions.calls[0]["messages"][0]["content"]
    assert system.count(GB_INSTRUCTION) == 1


def test_claude_ends_up_with_the_instruction_once(settings, anthropic_stub):
    settings.LLM_WEBSEARCH_ENABLED = False
    messages = anthropic_stub()

    ClaudeProvider()._call(
        prompt="best crm", system_prompt=regions.country_system_prompt("claude", "gb"),
        region=regions.region_for_country("gb"),
    )

    assert messages.calls[0]["system"].count(GB_INSTRUCTION) == 1


def test_engine_method_labels():
    assert regions.engine_method_label("searched", "gb") == "Searched from GB"
    assert regions.engine_method_label("asked", "gb") == "Asked to answer for GB"
    assert regions.engine_method_label("searched", None) == "Searched from each country"
    assert regions.engine_method_label("asked", None) == "Asked to answer for each country"


def test_claude_searched_when_its_web_search_ran(settings, anthropic_stub):
    settings.LLM_WEBSEARCH_ENABLED = True
    messages = anthropic_stub(searches=2)

    result = ClaudeProvider()._call(prompt="best crm", system_prompt="", region="gb")

    assert result.succeeded and result.searched is True
    tool = messages.calls[0]["tools"][0]
    assert tool["user_location"] == {"type": "approximate", "country": "GB"}

    anthropic_stub(searches=0)
    assert ClaudeProvider()._call(prompt="best crm", system_prompt="", region="gb").searched is False


def test_openai_searched_when_the_output_has_a_web_search_call(settings, openai_stub):
    settings.LLM_WEBSEARCH_ENABLED = True
    message = {"type": "message", "content": [{"type": "output_text", "annotations": []}]}
    client = openai_stub(output=[{"type": "web_search_call", "status": "completed"}, message])

    result = OpenAIProvider()._call(prompt="best crm", system_prompt="", region="gb")

    assert result.succeeded and result.searched is True
    assert client.responses.calls[0]["tools"][0]["user_location"]["country"] == "GB"

    openai_stub(output=[SimpleNamespace(type="message", content=[])])
    assert OpenAIProvider()._call(prompt="best crm", system_prompt="", region="gb").searched is False


def test_openai_chat_answers_never_searched(settings, openai_stub):
    settings.LLM_WEBSEARCH_ENABLED = False
    openai_stub()

    result = OpenAIProvider()._call(prompt="best crm", system_prompt="", region="gb")

    assert result.succeeded and result.searched is False


PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions"


def _sonar(**extra):
    return {"choices": [{"message": {"content": "1. Northwind CRM"}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10}, **extra}


@responses.activate
def test_perplexity_searched_when_it_returned_sources(settings):
    settings.PERPLEXITY_API_KEY = "pplx-test"
    responses.post(PERPLEXITY_URL, json=_sonar(search_results=[{"url": "https://g2.example/crm"}]))
    responses.post(PERPLEXITY_URL, json=_sonar(citations=["https://g2.example/crm"]))
    responses.post(PERPLEXITY_URL, json=_sonar())

    first = PerplexityProvider()._call(prompt="best crm", system_prompt="", region="gb")
    second = PerplexityProvider()._call(prompt="best crm", system_prompt="", region="gb")
    third = PerplexityProvider()._call(prompt="best crm", system_prompt="", region="gb")

    assert (first.searched, second.searched, third.searched) == (True, True, False)
    sent = json.loads(responses.calls[0].request.body)
    assert sent["web_search_options"] == {"user_location": {"country": "GB"}}
