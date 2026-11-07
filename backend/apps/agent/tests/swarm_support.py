"""Helpers for the research agents ("swarm") suites (tests only).

- ``RoutedFakeAnthropic``: the scripted Anthropic backend, plus canned
  answers for the analysis model (claude-haiku-5-5) by purpose. Analysis
  requests never take a scripted response from the queue and are kept in
  ``haiku_requests``, so ``requests`` stays the orchestrator's.
- ``fake_serp`` / ``fake_fetch`` / ``fake_engine_scan``: Google results,
  page fetches and engine answers without the network.
- ``plan_prompts``, ``make_run``, ``make_swarm``, ``tool_context``: rows and
  the ToolContext an execution runs with.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

import httpx2
import pytest
from django.utils import timezone

from apps.agent.runtime.swarm.prompts import ENGINE_SYSTEM, GAP_SYSTEM, SOURCES_SYSTEM
from apps.agent.tests.fakes import (
    FakeAnthropic,
    RecordedRequest,
    ScriptedHTTPError,
    ScriptedMessage,
    message,
    text,
)
from apps.agent.tests.runtime_support import make_prompt

__all__ = [
    "HAIKU", "RoutedFakeAnthropic", "purpose_of", "default_haiku", "routed_anthropic",
    "swarm_limits", "serp_payload", "organic", "fake_serp", "browse_result", "fake_fetch",
    "engine_answer", "fake_engine_scan", "plan_prompts", "make_run", "make_swarm",
    "tool_context", "catalog", "wait_for_swarm_threads", "UsageLog",
]

HAIKU = "claude-haiku-5-5"
_PURPOSES = {
    ENGINE_SYSTEM.splitlines()[0]: "engine_answer",
    GAP_SYSTEM.splitlines()[0]: "content_gap",
    SOURCES_SYSTEM.splitlines()[0]: "citations",
}


# ── Anthropic ────────────────────────────────────────────────────────────


def purpose_of(request_json: dict) -> str:
    """The analysis an analysis request asks for, from its system text."""
    system = request_json.get("system")
    if isinstance(system, list):
        system = "".join(b.get("text") or "" for b in system if isinstance(b, dict))
    first = str(system or "").splitlines()[0] if system else ""
    return _PURPOSES.get(first, "unknown")


def default_haiku(purpose: str) -> dict:
    """Canned analyses (test data)."""
    if purpose == "engine_answer":
        return {"summary": "The answer recommends HubSpot and does not name Northwind.",
                "reasons": ["Free tier", "Large app marketplace"],
                "opportunity": "Publish a page that compares free tiers."}
    if purpose == "content_gap":
        return {"headline": "The competitor page answers the question directly.",
                "gaps": [{"issue": "No comparison table", "evidence": "Competitor H2 'Compare'",
                          "fix": "Add a comparison table.", "target": "", "severity": "high"}]}
    if purpose == "citations":
        return {"headline": "Review sites dominate the sources.", "opportunities": []}
    return {}


class RoutedFakeAnthropic(FakeAnthropic):
    """FakeAnthropic that answers analysis requests itself: ``haiku(purpose)``
    returns a dict (sent as the JSON text), a str (sent as is), or a
    ScriptedMessage / ScriptedHTTPError for full control."""

    def __init__(self, *responses, haiku=None):
        super().__init__(*responses)
        self.haiku = haiku or default_haiku
        self.haiku_requests: list[RecordedRequest] = []

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        request.read()
        body = json.loads(request.content) if request.content else {}
        if not str(body.get("model") or "").startswith(HAIKU):
            return super().handler(request)
        recorded = RecordedRequest(
            method=request.method, path=request.url.path, query="",
            headers={k.lower(): v for k, v in request.headers.items()}, json=body,
        )
        with self._lock:
            self.haiku_requests.append(recorded)
        answer = self.haiku(purpose_of(body))
        if isinstance(answer, ScriptedHTTPError):
            return httpx2.Response(
                answer.status, headers={"request-id": answer.request_id},
                json={"type": "error",
                      "error": {"type": answer.error_type, "message": answer.message}},
            )
        if not isinstance(answer, ScriptedMessage):
            raw = answer if isinstance(answer, str) else json.dumps(answer)
            answer = message(text(raw), model=HAIKU, input_tokens=1000, output_tokens=200)
        return httpx2.Response(200, headers={"request-id": answer.request_id},
                               json=answer.as_json())


@pytest.fixture
def routed_anthropic():
    from apps.agent.llm.client import set_client_factory

    fake = RoutedFakeAnthropic().install()
    yield fake
    set_client_factory(None)


@pytest.fixture
def swarm_limits():
    """Fresh process-wide limits, sized from this test's settings."""
    from apps.agent.runtime.swarm import limits

    limits.reset_limits()
    yield limits
    wait_for_swarm_threads()
    limits.reset_limits()


def wait_for_swarm_threads(timeout: float = 10.0) -> None:
    """Wait for task threads a test left running (a timed-out task)."""
    end = time.monotonic() + timeout
    for thread in threading.enumerate():
        if thread.name.startswith("agent-swarm-"):
            thread.join(max(0.0, end - time.monotonic()))


# ── Google, pages and engines ────────────────────────────────────────────


def organic(rows, *, start: int = 0) -> list[dict]:
    """serp_google organic rows from (url, title) pairs."""
    from apps.agent.tools.shaping import host_of

    return [{"position": start + i + 1, "url": url, "domain": host_of(url), "title": title,
             "snippet": f"About {title}"} for i, (url, title) in enumerate(rows)]


def serp_payload(rows=(), *, start: int = 0, overview: dict | None = None,
                 questions=(), error: str = "", provider: str = "serpapi") -> dict:
    """One serp_google.search payload."""
    return {
        "configured": True, "provider": provider, "error": error,
        "organic": [] if error else organic(rows, start=start),
        "discussions": [], "questions": [{"question": q} for q in questions],
        "related_searches": [], "ai_overview": overview or {}, "ai_overview_deferred": False,
        "knowledge_graph": {},
    }


def fake_serp(monkeypatch, pages) -> list[dict]:
    """serp_google with a key and scripted pages: ``pages`` maps a page
    number to a payload (or a list of payloads, one per call), or is a
    callable (query, page) -> payload. Returns the calls made."""
    from apps.citations.services import serp_google

    calls: list[dict] = []
    queues = {k: list(v) if isinstance(v, list) else v for k, v in
              (pages.items() if isinstance(pages, dict) else [])}

    def search(query, *, max_results=10, timeout=None, start=0, gl="", hl=""):
        page = start // 10 + 1
        calls.append({"query": query, "page": page, "gl": gl, "hl": hl})
        if callable(pages):
            return pages(query, page)
        found = queues.get(page)
        if isinstance(found, list):
            return found.pop(0) if found else serp_payload()
        return found if found is not None else serp_payload()

    monkeypatch.setattr(serp_google, "provider", lambda: "serpapi")
    monkeypatch.setattr(serp_google, "cost_per_search_usd", lambda: Decimal("0.01"))
    monkeypatch.setattr(serp_google, "search", search)
    return calls


def browse_result(url: str, *, title: str = "A page", words: int = 900, h1=("Heading",),
                  h2=("Section",), schema=("Organization",), text_blocks=("Body text.",),
                  error: dict | None = None) -> dict:
    """One services.browse.fetch_page result."""
    if error:
        return {"url": url, "final_url": url, "status_code": None, "frameable": False,
                "title": None, "captured_at": "2026-11-04T10:00:00.000Z", "seo": None,
                "reader": None, "error": error}
    return {
        "url": url, "final_url": url, "status_code": 200, "frameable": True, "title": title,
        "captured_at": "2026-11-04T10:00:00.000Z",
        "seo": {"title": title, "title_length": len(title), "meta_description": "About it",
                "meta_description_length": 8, "canonical": url, "robots": None, "lang": "en",
                "h1": list(h1), "h2": list(h2), "word_count": words,
                "links": {"internal": 10, "external": 2}, "images": {"count": 3, "missing_alt": 1},
                "structured_data": list(schema),
                "open_graph": {"title": None, "description": None, "image": None},
                "hreflang": [], "bytes": 1000, "fetch_ms": 20},
        "reader": {"title": title, "links": [],
                   "blocks": [{"type": "paragraph", "text": t} for t in text_blocks]},
        "error": None,
    }


def fake_fetch(monkeypatch, pages_by_url: dict) -> list[str]:
    """services.browse.fetch_page from ``pages_by_url`` (url -> result, or
    a callable url -> result); unknown URLs fail to load."""
    calls: list[str] = []

    def fetch(url):
        calls.append(url)
        found = pages_by_url.get(url)
        if callable(found):
            return found(url)
        if found is None:
            return browse_result(url, error={"code": "fetch_failed",
                                             "message": "The page could not be loaded."})
        return found

    monkeypatch.setattr("apps.agent.services.browse.fetch_page", fetch)
    return calls


def engine_answer(*, mentioned=False, rank=None, sentiment=None, brands=(), text="An answer.",
                  citations=(), model_id="gpt-4o-mini", context="", error="", succeeded=True,
                  stopped=False, not_configured=False):
    """An EngineAnswer as EngineScan.ask returns it (test data)."""
    from apps.prompt_library.services.prompt_crawler import EngineAnswer

    return EngineAnswer(
        succeeded=succeeded and not error, error=error, response_text=text if succeeded else "",
        analysis={
            "is_mentioned": mentioned, "mention_rank": rank,
            "sentiment": sentiment or ("positive" if mentioned else "not_mentioned"),
            "mention_context": context, "competitors_mentioned": [
                {"name": name, "position": position} for name, position in brands],
            "confidence_score": None, "is_linked": False, "primary_recommendation": "",
            "citations": [], "extraction_model": "", "extraction_version": "",
        },
        citations=list(citations), model_id=model_id, result_id="result-1",
        created_at=timezone.now(), stopped=stopped, not_configured=not_configured,
    )


def fake_engine_scan(monkeypatch, answers: dict) -> dict:
    """EngineScan.ask answering from ``answers`` (provider -> EngineAnswer or
    callable(provider, variant, should_stop, on_step) -> EngineAnswer), and
    EngineScan.finish recording its calls. Returns {"asked", "finished"}."""
    from apps.prompt_library.services.prompt_crawler import CrawlOutcome, EngineScan

    record = {"asked": [], "finished": []}
    lock = threading.Lock()

    def ask(self, provider_key, variant, *, should_stop=None, on_step=None):
        with lock:
            record["asked"].append((self.prompt.text, provider_key, variant))
        found = answers.get(provider_key)
        if callable(found):
            return found(provider_key, variant, should_stop, on_step)
        if on_step is not None:
            on_step("extracting")
        return found if found is not None else engine_answer(error="Provider failed")

    def finish(self, *, stopped=False):
        with lock:
            record["finished"].append((self.prompt.text, stopped))
        return CrawlOutcome(fanouts=[], responses=0, errors=[], stopped=stopped)

    monkeypatch.setattr(EngineScan, "ask", ask)
    monkeypatch.setattr(EngineScan, "finish", finish)
    return record


# ── Rows and contexts ────────────────────────────────────────────────────


def catalog(configured=("chatgpt", "claude")) -> list[dict]:
    """An engine catalog like research.engine_catalog(), with ``configured``."""
    rows = [("gpt4", "chatgpt", "ChatGPT", "OPENAI_API_KEY"),
            ("claude", "claude", "Claude", "ANTHROPIC_API_KEY"),
            ("gemini", "gemini", "Gemini", "GEMINI_API_KEY"),
            ("grok", "grok", "Grok", "XAI_API_KEY"),
            ("perplexity", "perplexity", "Perplexity", "PERPLEXITY_API_KEY")]
    return [{"provider": p, "key": k, "label": label, "configured": k in configured,
             "key_setting": setting} for p, k, label, setting in rows]


def _tracked(website, prompt_text: str, location: str):
    """The website's tracked prompt with this text (created once)."""
    from apps.prompt_library.models import BrandPrompt
    from apps.prompt_library.services._hash import text_hash

    found = (BrandPrompt.objects.select_related("prompt")
             .filter(website=website, prompt__text_hash=text_hash(prompt_text)).first())
    return found or make_prompt(website, prompt_text, location=location)


def plan_prompts(website, n: int = 1, *, texts=None, location: str = "us",
                 model_variants=None) -> list:
    """``n`` tracked prompts as ResolvedPrompts p1..pn."""
    from apps.agent.runtime.swarm.plan import ResolvedPrompt

    texts = list(texts or [f"best crm for team {i + 1}" for i in range(n)])
    out = []
    for i, prompt_text in enumerate(texts):
        bp = _tracked(website, prompt_text, location)
        if model_variants:
            bp.model_variants = list(model_variants)
            bp.save(update_fields=["model_variants"])
        out.append(ResolvedPrompt(
            key=f"p{i + 1}", prompt_id=str(bp.prompt_id), brand_prompt_id=str(bp.id),
            text=prompt_text, location=location, model_variants=tuple(model_variants or ()),
            tracked_now=False,
        ))
    return out


def make_run(chat, *, trigger: str = "send", status: str = "running", parent=None):
    """A user message, an assistant message and a run for them."""
    from apps.agent.models import AgentMessage, AgentRun

    user_message = AgentMessage.objects.create(
        chat=chat, parent=parent, role="user", depth=(parent.depth + 1) if parent else 0,
        parts=[{"id": "p1", "type": "text", "text": "Research the brand"}],
        wire=json.dumps([{"role": "user", "content": [{"type": "text",
                                                       "text": "Research the brand"}]}]),
    )
    reply = AgentMessage.objects.create(chat=chat, parent=user_message, role="assistant",
                                        depth=user_message.depth + 1, status="streaming")
    return AgentRun.objects.create(
        chat=chat, user=chat.user, website=chat.website, user_message=user_message,
        assistant_message=reply, trigger=trigger, status=status,
    )


def make_swarm(chat, run, prompts, *, engines=None, serp_configured: bool = True,
               options=None, version: int = 1, scope: str = "all", scope_key: str = "",
               task_ids=None, version_status: str = "running"):
    """An AgentSwarm planned from ``prompts`` and one version of it."""
    from apps.agent.models import AgentSwarm, AgentSwarmVersion
    from apps.agent.runtime.events import now_iso
    from apps.agent.runtime.swarm.plan import PlanOptions, build_expansion

    expansion = build_expansion(chat.website, prompts, options or PlanOptions(title="Research"),
                                engines=engines or catalog(), serp_configured=serp_configured,
                                now_iso=now_iso())
    swarm = AgentSwarm.objects.create(
        website=chat.website, chat=chat, user=chat.user, message=run.assistant_message, run=run,
        title=expansion.plan["title"], plan=expansion.plan, categories=expansion.categories,
        tasks=expansion.tasks,
    )
    row = AgentSwarmVersion.objects.create(
        swarm=swarm, version=version, scope=scope, scope_key=scope_key,
        task_ids=list(task_ids if task_ids is not None else [t["id"] for t in swarm.tasks]),
        status=version_status, run=run, message=run.assistant_message,
    )
    return swarm, row


@dataclass
class UsageLog:
    """A ToolContext.add_usage that records what it got and on which thread."""

    calls: list = field(default_factory=list)

    def __call__(self, totals) -> None:
        self.calls.append((threading.current_thread().name, totals))

    @property
    def cost(self) -> Decimal:
        return sum((t.cost_usd for _, t in self.calls), Decimal("0"))


def tool_context(run, *, inline: bool = True, emitter=None, active=None, usage=None,
                 run_started: float | None = None, request: int = 1, part_id=None):
    """The ToolContext of ``run``, as the runner builds it."""
    from apps.agent.runtime.emitter import RunEmitter
    from apps.agent.runtime.events import get_event_store
    from apps.agent.runtime.registry import ActiveRun
    from apps.agent.tools.context import ToolContext

    get_event_store().open(str(run.id))
    extra = {} if run_started is None else {"run_started": run_started}
    return ToolContext(
        run=run, chat=run.chat, website=run.website, user=run.user,
        emitter=emitter or RunEmitter(run, run.assistant_message), active=active or ActiveRun(run.id),
        request=request, tool_use_id="toolu_test", part_id=part_id,
        add_usage=usage if usage is not None else UsageLog(), inline=inline, extra=extra,
    )


def recent(minutes: int = 5) -> str:
    """An ISO timestamp ``minutes`` ago."""
    return (timezone.now() - timedelta(minutes=minutes)).isoformat()
