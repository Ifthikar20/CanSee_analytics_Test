from types import SimpleNamespace

from apps.llm_ranking.providers.claude import ClaudeProvider
from apps.llm_ranking.providers.openai import OpenAIProvider


class _FakeCompletions:
    def __init__(self, finish_reason, content):
        self.finish_reason = finish_reason
        self.content = content
        self.sent = None

    def create(self, **kwargs):
        self.sent = kwargs
        return SimpleNamespace(
            choices=[SimpleNamespace(
                finish_reason=self.finish_reason,
                message=SimpleNamespace(content=self.content),
            )],
            usage=SimpleNamespace(prompt_tokens=12, completion_tokens=34),
        )


def _run_openai(monkeypatch, settings, finish_reason, content):
    import openai

    settings.LLM_WEBSEARCH_ENABLED = False
    completions = _FakeCompletions(finish_reason, content)
    monkeypatch.setattr(openai, "OpenAI", lambda api_key=None: SimpleNamespace(
        chat=SimpleNamespace(completions=completions)))
    provider = OpenAIProvider.__new__(OpenAIProvider)
    provider.api_key = "test"
    provider.model = "gpt-4o-mini"
    return provider._call(prompt="best note app", system_prompt=""), completions.sent


def test_answers_get_room_for_a_full_list():
    assert ClaudeProvider.ANSWER_MAX_TOKENS == 4096
    assert OpenAIProvider.ANSWER_MAX_TOKENS == 4096


def test_a_complete_chatgpt_answer_is_kept(monkeypatch, settings):
    result, sent = _run_openai(monkeypatch, settings, "stop", " 1. Notion\n2. Coda ")
    assert sent["max_tokens"] == 4096
    assert result.succeeded is True
    assert result.text == "1. Notion\n2. Coda"
    assert (result.input_tokens, result.output_tokens) == (12, 34)


def test_a_cut_off_chatgpt_answer_is_not_kept_as_an_answer(monkeypatch, settings):
    result, _ = _run_openai(monkeypatch, settings, "length", "1. Notion\n2. Co")
    assert result.succeeded is False
    assert result.text == ""
    assert result.error == "max_tokens: the answer was cut off at the 4096-token limit"
    # The tokens were still billed, so they are still reported.
    assert result.output_tokens == 34
