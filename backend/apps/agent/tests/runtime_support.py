"""Fixtures and helpers shared by the runtime suites (tests only).

Import the fixtures a module needs: ``from apps.agent.tests.runtime_support
import *``. Fixtures with autouse apply to every test of that module.
"""
from __future__ import annotations

import json

import pytest
from django.core.cache import cache

from apps.agent.runtime import events as events_module
from apps.agent.runtime.events import MemoryEventStore, set_event_store
from apps.agent.runtime.registry import reset_registry

__all__ = [
    "agent_env", "store", "no_title", "fast_retries", "make_chat", "send", "run_events",
    "event_types", "tool_results_of", "make_prompt", "chat",
]


@pytest.fixture(autouse=True)
def agent_env(settings):
    """A configured agent and a clean cache (circuit breaker, buckets, quotas)."""
    settings.ANTHROPIC_API_KEY = "test-key"
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def store():
    """A fresh event store and run registry per test."""
    fresh = MemoryEventStore()
    set_event_store(fresh)
    reset_registry()
    yield fresh
    set_event_store(None)
    reset_registry()


@pytest.fixture
def no_title(monkeypatch):
    """Skip the model title request (most suites script only the turn)."""
    monkeypatch.setattr("apps.agent.runtime.title.generate_title", lambda run, emitter=None: None)


@pytest.fixture
def fast_retries(monkeypatch):
    monkeypatch.setattr("apps.agent.runtime.runner.RETRY_DELAYS", (0.0, 0.0))


def make_chat(user, website, *, entry_agent="gap_analyst"):
    from apps.agent.llm.snapshot import get_or_create_snapshot
    from apps.agent.models import AgentChat

    return AgentChat.objects.create(
        website=website, user=user, entry_agent=entry_agent,
        snapshot=get_or_create_snapshot(entry_agent),
    )


@pytest.fixture
def chat(user, website):
    return make_chat(user, website)


def send(chat, text="How do we rank for best crm?", **kwargs):
    """Start a send and run it inline; returns services.runs.StartedRun."""
    from apps.agent.services.runs import start_send

    return start_send(user=chat.user, chat=chat, text=text, **kwargs)


def run_events(run) -> list[dict]:
    return events_module.get_event_store().read(run.id, 0, limit=100000).events


def event_types(run) -> list[str]:
    return [e["type"] for e in run_events(run)]


def tool_results_of(request_json: dict) -> list[dict]:
    """The tool_result blocks of a request's last message."""
    last = request_json["messages"][-1]
    return [b for b in last["content"] if b.get("type") == "tool_result"]


def make_prompt(website, text: str, *, location: str = ""):
    """A tracked prompt (Industry, Prompt, BrandPrompt) for ``website``."""
    from apps.prompt_library.models import BrandPrompt, Industry, Prompt
    from apps.prompt_library.services._hash import text_hash

    industry, _ = Industry.objects.get_or_create(
        slug="software", defaults={"name": "Software", "is_active": True},
    )
    prompt = Prompt.objects.create(
        industry=industry, text=text, template_text=text, intent_bucket="category",
        source="manual", text_hash=text_hash(text),
    )
    return BrandPrompt.objects.create(website=website, prompt=prompt, location=location)


def loads(text: str):
    return json.loads(text)
