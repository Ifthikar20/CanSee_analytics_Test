"""design/agent_contract.md and design/swarm_contract.md as data, for the
contract and end-to-end suites (tests only). Keys are the minimum each
object must carry; the contract allows extra fields."""
from __future__ import annotations

API = "/api/v1/agent/"
WID = "0b9f6c34-1d2e-4f50-8a6b-7c8d9e0f1a2b"
CID = "6f1c1f1e-35b1-4a3e-9d3e-1c2b3a4d5e6f"
MID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"
AID = "9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b"
RID = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"
SID = "5d0c6a1e-8b0f-4d0e-9a3e-0b3e2a6f9c11"
FID = "f9e8d7c6-b5a4-4f3e-8d2c-1b0a9f8e7d6c"
EID = "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d"
REF = "7c6b5a49-3827-4161-9f0e-d1c2b3a49586"
DID = "d4c3b2a1-0f9e-4d8c-8b7a-695847362514"

# (url name, reverse kwargs, path under /api/v1/agent/, methods), section 1.
ROUTES = [
    ("agent-status", {}, "status/", {"GET"}),
    ("agent-catalog", {}, "agents/", {"GET"}),
    ("agent-report-templates", {}, "report-templates/", {"GET"}),
    ("agent-chats", {"website_id": WID}, f"websites/{WID}/chats/", {"GET", "POST"}),
    ("agent-chat-detail", {"website_id": WID, "chat_id": CID},
     f"websites/{WID}/chats/{CID}/", {"GET", "PATCH", "DELETE"}),
    ("agent-message-feedback", {"website_id": WID, "message_id": MID},
     f"websites/{WID}/messages/{MID}/feedback/", {"POST"}),
    ("agent-artifacts", {"website_id": WID}, f"websites/{WID}/artifacts/", {"GET"}),
    ("agent-artifact-detail", {"website_id": WID, "artifact_id": AID},
     f"websites/{WID}/artifacts/{AID}/", {"GET", "PATCH", "DELETE"}),
    ("agent-artifact-versions", {"website_id": WID, "artifact_id": AID},
     f"websites/{WID}/artifacts/{AID}/versions/", {"GET"}),
    ("agent-artifact-version", {"website_id": WID, "artifact_id": AID, "number": 2},
     f"websites/{WID}/artifacts/{AID}/versions/2/", {"GET"}),
    ("agent-reports", {"website_id": WID}, f"websites/{WID}/reports/", {"POST"}),
    # design/p2_contract.md 11b: the context (PUT context/ is gone).
    ("agent-context", {"website_id": WID}, f"websites/{WID}/context/", {"GET"}),
    ("agent-context-entries", {"website_id": WID}, f"websites/{WID}/context/entries/",
     {"POST"}),
    ("agent-context-review", {"website_id": WID}, f"websites/{WID}/context/entries/review/",
     {"POST"}),
    ("agent-context-entry", {"website_id": WID, "entry_id": EID},
     f"websites/{WID}/context/entries/{EID}/", {"PATCH", "DELETE"}),
    ("agent-context-references", {"website_id": WID, "entry_id": EID},
     f"websites/{WID}/context/entries/{EID}/references/", {"POST"}),
    ("agent-context-reference", {"website_id": WID, "reference_id": REF},
     f"websites/{WID}/context/references/{REF}/", {"DELETE"}),
    ("agent-context-documents", {"website_id": WID}, f"websites/{WID}/context/documents/",
     {"GET", "POST"}),
    ("agent-context-document", {"website_id": WID, "document_id": DID},
     f"websites/{WID}/context/documents/{DID}/", {"GET", "PATCH", "DELETE"}),
    # 13c: reviews.
    ("agent-artifact-review", {"website_id": WID, "artifact_id": AID},
     f"websites/{WID}/artifacts/{AID}/review/", {"GET", "POST"}),
    ("agent-artifact-review-comments", {"website_id": WID, "artifact_id": AID},
     f"websites/{WID}/artifacts/{AID}/review/comments/", {"POST"}),
    ("agent-reviews", {"website_id": WID}, f"websites/{WID}/reviews/", {"GET"}),
    ("agent-team", {"website_id": WID}, f"websites/{WID}/team/", {"GET"}),
    # 14b: the usage dashboard.
    ("agent-command-center", {}, "command-center/", {"GET"}),
    ("agent-suggestions", {"website_id": WID}, f"websites/{WID}/suggestions/", {"GET"}),
    ("agent-activity", {"website_id": WID}, f"websites/{WID}/activity/", {"GET"}),
    ("agent-live-send", {"website_id": WID, "chat_id": CID},
     f"live/websites/{WID}/chats/{CID}/messages/", {"POST"}),
    ("agent-live-regenerate", {"website_id": WID, "message_id": MID},
     f"live/websites/{WID}/messages/{MID}/regenerate/", {"POST"}),
    ("agent-live-edit", {"website_id": WID, "message_id": MID},
     f"live/websites/{WID}/messages/{MID}/edit/", {"POST"}),
    ("agent-live-continue", {"website_id": WID, "message_id": MID},
     f"live/websites/{WID}/messages/{MID}/continue/", {"POST"}),
    ("agent-live-cancel", {"run_id": RID}, f"live/runs/{RID}/cancel/", {"POST"}),
    ("agent-live-stream", {"run_id": RID}, f"live/runs/{RID}/stream/", {"GET"}),
    ("agent-live-events", {"run_id": RID}, f"live/runs/{RID}/events/", {"GET"}),
    ("agent-live-browse", {"website_id": WID}, f"live/websites/{WID}/browse/", {"POST"}),
    # Swarm contract section 6.
    ("agent-swarm-detail", {"website_id": WID, "swarm_id": SID},
     f"websites/{WID}/swarms/{SID}/", {"GET"}),
    ("agent-swarm-version", {"website_id": WID, "swarm_id": SID, "number": 2},
     f"websites/{WID}/swarms/{SID}/versions/2/", {"GET"}),
    ("agent-findings", {"website_id": WID}, f"websites/{WID}/findings/", {"GET", "POST"}),
    ("agent-finding-detail", {"website_id": WID, "finding_id": FID},
     f"websites/{WID}/findings/{FID}/", {"PATCH", "DELETE"}),
    ("agent-live-swarm-rerun", {"website_id": WID, "swarm_id": SID},
     f"live/websites/{WID}/swarms/{SID}/rerun/", {"POST"}),
]

# Section 2: every event carries the envelope plus its payload.
EVENT_ENVELOPE = {"v", "seq", "type", "run_id", "message_id", "ts"}
EVENT_PAYLOADS = {
    "run.started": {"chat_id", "user_message_id", "model"},
    "run.retrying": {"attempt", "reason", "delay_ms"},
    "run.usage": {"requests", "input_tokens", "output_tokens", "cache_read_tokens",
                  "cache_write_tokens", "web_search_requests", "cost_usd"},
    "chat.updated": {"chat_id", "title"},
    "turn.reset": {"request"},
    "run.completed": {"status", "stop_reason", "parts_seq", "duration_ms"},
    "run.failed": {"error"},
    "run.cancelled": set(),
    "run.interrupted": {"reason"},
    "resync": {"reason"},
    "part.added": {"part"},
    "part.delta": {"part_id", "field", "append"},
    "part.updated": {"part_id", "patch"},
    "artifact.started": {"artifact_id", "kind", "title", "agent_key", "base_version"},
    "artifact.delta": {"artifact_id", "append"},
    "artifact.snapshot": {"artifact_id", "content"},
    "artifact.completed": {"artifact_id", "version", "title", "summary", "warnings"},
    "artifact.failed": {"artifact_id", "error"},
    "browser.open": {"tab", "activate"},
    "browser.update": {"tab_id", "patch"},
    # Swarm contract section 4a.
    "task.started": {"part_id", "task_id", "rev", "patch"},
    "task.progress": {"part_id", "task_id", "rev", "patch"},
    "task.finished": {"part_id", "task_id", "rev", "patch"},
    "research.recorded": {"kind", "capture_id", "capture", "task_id"},
}
TERMINAL_EVENTS = {"run.completed", "run.failed", "run.cancelled", "run.interrupted"}
TASK_EVENTS = {"task.started", "task.progress", "task.finished"}

TAB_SPEC = {"id", "kind", "title", "status", "data"}
TAB_STATUSES = {"loading", "ready", "error"}
SERP_CAPTURE = {"capture_id", "query", "page", "start", "location", "captured_at", "brand",
                "brand_positions", "results", "ai_overview", "people_also_ask", "error"}
SERP_RESULT = {"position", "title", "url", "display_url", "domain", "snippet", "is_yours",
               "is_competitor"}
AI_OVERVIEW = {"shown", "mentions_you", "cites_you", "references"}
PAGE_CAPTURE = {"capture_id", "url", "final_url", "captured_at", "frameable", "status_code",
                "seo", "reader", "error"}

# Section 3: each part has {id, type, request} plus its own fields.
PART_BASE = {"id", "type", "request"}
PART_FIELDS = {
    "thinking": {"text", "started_at", "ended_at", "duration_ms"},
    "text": {"text", "citations"},
    "tool": {"name", "label", "status", "summary", "error"},
    "web_search": {"query", "status", "results", "error_code"},
    "web_fetch": {"url", "status", "title", "error_code"},
    "serp": {"query", "page", "location", "status", "tab_id", "brand_positions",
             "result_count", "ai_overview_shown", "error"},
    "page_inspect": {"url", "status", "tab_id", "title", "summary", "error"},
    "engine_check": {"prompt_id", "prompt_text", "engine", "engine_label", "status",
                     "mentioned", "rank", "sentiment", "error"},
    "agent_call": {"agent", "agent_name", "status", "artifact_id", "version", "title", "kind",
                   "summary", "error"},
    "chart": {"spec"},
    "browser_open": {"url", "title", "requires_confirmation"},
    "notice": {"level", "code", "message"},
    # Swarm contract section 5.
    "swarm": {"swarm_id", "version", "title", "scope", "scope_label", "status", "started_at",
              "ended_at", "duration_ms", "categories", "tasks", "table_version", "error",
              "limits"},
    "swarm_table": {"swarm_id", "version", "title", "status", "generated_at", "table"},
}
PART_STATUSES = {
    "tool": {"preparing", "running", "done", "error"},
    "engine_check": {"queued", "running", "done", "error", "unavailable"},
    "agent_call": {"preparing", "planning", "drafting", "validating", "done", "error",
                   "cancelled"},
    "swarm": {"planning", "running", "done", "partial", "error", "cancelled", "interrupted"},
    "swarm_table": {"done", "partial", "cancelled"},
}

# Section 4: shapes.
MESSAGE = {"id", "chat_id", "parent_id", "role", "status", "parts", "parts_seq", "created_at",
           "started_at", "finished_at", "duration_ms", "model", "error_code", "error_message",
           "feedback", "sibling_ids", "run_id", "saved_report_id"}
MESSAGE_STATUSES = {"complete", "streaming", "truncated", "refused", "cancelled", "failed",
                    "interrupted"}
RUN = {"id", "chat_id", "message_id", "status", "last_seq"}
CHAT_SUMMARY = {"id", "title", "preview", "created_at", "last_message_at", "active_run_id"}
CHAT_DETAIL = {"id", "title", "title_source", "created_at", "last_message_at",
               "current_leaf_id", "messages", "active_run"}
ACTIVE_RUN = {"id", "status", "message_id", "last_seq"}
ARTIFACT_SUMMARY = {"id", "kind", "title", "agent_key", "latest_version", "created_at",
                    "updated_at", "created_by_name", "source_chat_id", "review"}
ARTIFACT_REVIEW = {"state", "effective_state", "version", "reviewer_name", "updated_at"}
ARTIFACT_DETAIL = ARTIFACT_SUMMARY | {"content", "content_type", "data", "version", "warnings",
                                      "summary"}
ARTIFACT_VERSION_SUMMARY = {"version", "created_at", "summary", "source", "size_bytes"}
REPORT_DATA = {"serp", "pages", "engines", "gaps", "swarm", "template", "header"}
# data.header of a report (report templates).
REPORT_HEADER = {"template", "project", "captured_at", "data", "engines", "locations",
                 "prompts", "competitors", "compared"}
# design/p2_contract.md 11b.
CONTEXT_OVERVIEW = {"sections", "entries", "documents", "facts", "competitors", "totals",
                    "build", "can_edit"}
CONTEXT_SECTION = {"key", "label", "help", "entries", "suggested", "references"}
CONTEXT_ENTRY = {"id", "section", "title", "body", "status", "origin", "position", "revision",
                 "updated_at", "updated_by_name", "build_run_id", "references"}
CONTEXT_REFERENCE = {"id", "kind", "label", "url", "quote", "fact_id", "document_id",
                     "competitor_domain", "state", "checked_at"}
CONTEXT_DOCUMENT = {"id", "title", "chars", "cited_by", "updated_at", "updated_by_name"}
CONTEXT_BUILD = {"available", "reason", "active_run", "last_run"}
STATUS = {"enabled", "live_available", "model", "engines", "serp_configured",
          "web_tools_enabled", "allowance", "writers", "swarm", "limits"}
STATUS_WRITER = {"available", "needs_usd", "max_usd"}
# 13c.
REVIEW = {"artifact_id", "state", "effective_state", "version", "latest_version",
          "updated_since_request", "reviewer", "requested_by", "requested_at", "decided_by",
          "decided_at", "revision", "sole_writer", "can", "events"}
REVIEW_CAN = {"request", "approve", "request_changes", "withdraw", "reopen", "comment"}
REVIEW_EVENT = {"id", "kind", "actor_name", "reviewer_name", "version", "body", "email",
                "created_at"}
TEAM_MEMBER = {"id", "name", "email", "role", "is_you"}
# 14b.
COMMAND_CENTER = {"scope", "scopes", "window", "filters", "websites", "empty_reason", "totals",
                  "runs_series", "active_users_series", "spend_series", "spend_by_category",
                  "by_agent", "by_team", "top_users"}
STATUS_SWARM = {"enabled", "max_agents", "worker_model"}

# Swarm contract: tasks, the table, swarm reads, re-runs, findings, reports.
SWARM_CATEGORY = {"key", "label", "notes", "subcategories"}
SWARM_TASK = {"id", "category", "subcategory", "worker", "label", "target", "status", "step",
              "result", "tone", "depends_on", "started_at", "ended_at", "duration_ms",
              "attempt", "error", "pane", "detail", "rev"}
TASK_STATUSES = {"queued", "running", "done", "failed", "skipped", "stopped"}
TERMINAL_TASK_STATUSES = {"done", "failed", "skipped", "stopped"}
SWARM_CATEGORIES = ["google", "engines", "competitors", "site", "sources"]
SWARM_WORKERS = {"serp_page": "google", "engine_answer": "engines",
                 "page_inspect": ("competitors", "site"), "content_gap": "site",
                 "citations": "sources"}
TASK_TONES = {"good", "warn", "bad", "muted", None}
# Section 5c: the codes of Task.error.
TASK_ERROR_CODES = {"not_configured", "not_selected", "daily_limit", "browse_limit",
                    "fetch_failed", "blocked_url", "timeout", "deadline", "upstream_error",
                    "rate_limited", "allowance_exceeded", "refused", "invalid_output",
                    "nothing_to_analyze", "dependency_failed", "prompt_missing", "stopped",
                    "interrupted", "internal_error"}
# Section 5b: category notes.
SWARM_NOTE = {"level", "code", "text"}
NOTE_CODES = {"serp_not_configured", "engines_not_configured", "engines_not_selected",
              "variant_not_compared", "competitor_dropped", "reused_captures", "carried",
              "trimmed"}
# Section 3g: the error codes of a refused research (the swarm part's error).
SWARM_REFUSAL_CODES = {"swarm_disabled", "nothing_to_measure", "too_many_agents",
                       "insufficient_allowance", "allowance_exceeded", "prompt_not_found",
                       "needs_confirmation", "swarm_not_found", "swarm_busy", "version_limit"}
# Section 5d: Task.detail per worker (every field always present).
TASK_DETAIL = {
    "serp_page": {"query", "page", "location", "provider", "captured_at", "reused",
                  "result_count", "brand_positions", "top", "ai_overview", "people_also_ask"},
    "engine_answer": {"engine", "engine_label", "variant", "model_id", "prompt_text",
                      "answered_at", "mentioned", "rank", "sentiment", "brands", "brands_above",
                      "snippet", "citations", "analysis", "analysis_error", "result_id"},
    "page_inspect": {"role", "url", "final_url", "status_code", "domain", "competitor_name",
                     "position", "chosen_because", "title", "seo", "excerpt", "reused_from"},
    "content_gap": {"compared", "headline", "gaps", "analysis_error"},
    "citations": {"total_citations", "you_cited", "overview_references", "sources", "analysis",
                  "analysis_error"},
}
DETAIL_SERP_TOP = {"position", "title", "url", "domain", "is_yours", "is_competitor",
                   "competitor_name"}
DETAIL_OVERVIEW = {"shown", "content_captured", "mentions_you", "cites_you", "references"}
DETAIL_BRAND = {"name", "position"}
DETAIL_CITATION = {"url", "domain", "is_yours"}
DETAIL_ANALYSIS = {"summary", "reasons", "opportunity"}
DETAIL_SEO = {"title", "title_length", "meta_description", "meta_description_length", "h1",
              "h2", "word_count", "structured_data", "canonical", "robots", "links", "images"}
DETAIL_COMPARED = {"role", "url", "title"}
DETAIL_GAP = {"issue", "evidence", "fix", "target", "severity"}
DETAIL_SOURCE = {"domain", "citations", "engines", "is_yours", "is_competitor",
                 "competitor_name", "example_url"}
DETAIL_SOURCES_ANALYSIS = {"headline", "opportunities"}
DETAIL_OPPORTUNITY = {"domain", "why", "action"}
DETAIL_MAX_CHARS = 6144
SWARM_TABLE = {"swarm_id", "version", "title", "status", "generated_at", "previous_version",
               "counts", "notes", "changes", "sheets"}
SWARM_COUNTS = {"total", "done", "failed", "skipped", "stopped"}
SWARM_SHEET = {"key", "title", "columns", "rows"}
SWARM_COLUMN = {"key", "label", "kind", "align", "sortable"}
COLUMN_KINDS = {"text", "rank", "status", "class", "number", "link"}
SWARM_ROW = {"key", "cells", "task_ids", "finding", "links"}
SWARM_CELL = {"text", "v", "state", "tone", "note", "task_id", "version", "previous"}
CELL_STATES = {"ok", "not_found", "not_measured", "not_configured", "not_selected", "failed",
               "skipped", "stopped"}
CELL_TONES = {"good", "warn", "bad", "muted", None}
SWARM_CHANGE = {"sheet", "row", "column", "label", "from", "to"}
FINDING_DRAFT = {"title", "detail", "category", "severity", "prompt_text", "evidence"}
EVIDENCE = {"kind", "label", "tab_id", "url"}
EVIDENCE_KINDS = {"serp", "page", "link", "answer"}
PROMPT_COLUMNS = ["prompt", "google", "ai_overview", "chatgpt", "claude", "gemini", "grok",
                  "perplexity", "ahead", "cited", "gap", "finding"]
GAP_COLUMNS = ["prompt", "issue", "fix", "page", "severity", "evidence"]
SOURCE_COLUMNS = ["domain", "citations", "engines", "prompts", "yours", "competitor", "action"]
SWARM_TOOL_RESULT = {"swarm_id", "version", "title", "status", "duration_s", "agents", "google",
                     "engines_asked", "engines_not_configured", "prompts", "notes", "table_shown"}
SWARM_TOOL_PROMPT = {"prompt_id", "text", "location", "google", "engines", "competitor_pages",
                     "gap", "problems"}
SWARM_DETAIL = {"id", "title", "chat_id", "message_id", "created_at", "latest_version",
                "prompts", "categories", "tasks", "versions"}
SWARM_DETAIL_VERSION = {"version", "scope", "scope_label", "status", "counts", "started_at",
                        "finished_at", "duration_ms", "message_id", "run_id", "has_table"}
SWARM_VERSION = {"swarm_id", "version", "scope", "scope_label", "status", "counts",
                 "started_at", "finished_at", "duration_ms", "message_id", "table"}
RERUN_RESPONSE = {"user_message", "assistant_message", "run", "swarm_version"}
RERUN_VERSION = {"swarm_id", "version", "scope", "scope_key", "task_ids"}
FINDING = {"id", "title", "detail", "category", "category_label", "severity", "status",
           "prompt_text", "evidence", "source", "created_at", "updated_at", "created_by_name",
           "status_changed_at", "status_changed_by_name"}
FINDING_SOURCE = {"swarm_id", "swarm_title", "version", "sheet", "row_key", "task_ids",
                  "chat_id", "message_id"}
FINDINGS_LIST = {"results", "next_cursor", "counts", "can_edit"}
FINDING_COUNTS = {"open", "done", "dismissed"}
REPORT_SWARM = {"swarm_id", "version", "title", "status", "duration_ms", "counts",
                "categories", "table"}
STATUS_ENGINE = {"key", "label", "configured"}
ALLOWANCE = {"cap_usd", "spent_usd", "exceeded", "warning"}
AGENT_ENTRY = {"key", "name", "description", "output_kind", "starter", "teams"}
SUGGESTION = {"label", "prompt", "agent"}
BROWSE_RESULT = {"url", "final_url", "status_code", "frameable", "title", "captured_at", "seo",
                 "reader", "error"}
SEO_FACTS = {"title", "title_length", "meta_description", "meta_description_length",
             "canonical", "robots", "lang", "h1", "h2", "word_count", "links", "images",
             "structured_data", "open_graph", "hreflang", "bytes", "fetch_ms"}
READER = {"title", "blocks", "links"}


def missing(expected: set, obj: dict) -> set:
    """Contract keys ``obj`` lacks (empty when it has them all)."""
    return set(expected) - set(obj)


def assert_event(event: dict) -> None:
    """The envelope and the payload keys of one event."""
    assert not missing(EVENT_ENVELOPE, event), (event["type"], missing(EVENT_ENVELOPE, event))
    assert event["v"] == 1
    expected = EVENT_PAYLOADS[event["type"]]
    assert not missing(expected, event), (event["type"], missing(expected, event))
    if event["type"] == "part.added":
        assert_part(event["part"])
    elif event["type"] == "browser.open":
        tab = event["tab"]
        assert not missing(TAB_SPEC, tab), missing(TAB_SPEC, tab)
        assert tab["kind"] in ("serp", "page") and tab["id"].startswith(tab["kind"] + ":")
        assert tab["status"] in TAB_STATUSES
    elif event["type"] == "browser.update":
        kind = event["tab_id"].split(":", 1)[0]
        expected = SERP_CAPTURE if kind == "serp" else PAGE_CAPTURE
        assert not missing(expected, event["patch"]), missing(expected, event["patch"])
    elif event["type"] in TASK_EVENTS:
        assert not {"rev", "id"} & set(event["patch"]), event["patch"]
        if event["type"] == "task.finished":
            assert event["patch"]["status"] in TASK_STATUSES - {"queued", "running"}
    elif event["type"] == "research.recorded":
        assert event["kind"] in ("serp", "page")
        expected = SERP_CAPTURE if event["kind"] == "serp" else PAGE_CAPTURE - {"reader"}
        assert not missing(expected, event["capture"]), missing(expected, event["capture"])
        assert "reader" not in event["capture"]


def assert_part(part: dict) -> None:
    """The base and type fields of one part, and its status vocabulary."""
    assert not missing(PART_BASE, part), missing(PART_BASE, part)
    fields = PART_FIELDS[part["type"]]
    assert not missing(fields, part), (part["type"], missing(fields, part))
    statuses = PART_STATUSES.get(part["type"])
    if statuses is not None:
        assert part["status"] in statuses, (part["type"], part["status"])
    if part["type"] == "swarm":
        for category in part["categories"]:
            assert not missing(SWARM_CATEGORY, category), missing(SWARM_CATEGORY, category)
        for task in part["tasks"]:
            assert not missing(SWARM_TASK, task), missing(SWARM_TASK, task)
            assert task["status"] in TASK_STATUSES
    elif part["type"] == "swarm_table":
        assert_table(part["table"])


def _keys(expected: set, obj, where: str) -> None:
    assert isinstance(obj, dict), (where, obj)
    assert not missing(expected, obj), (where, missing(expected, obj))


def assert_category(category: dict) -> None:
    """A Category (swarm contract 5b) and its notes."""
    _keys(SWARM_CATEGORY, category, "category")
    assert category["key"] in SWARM_CATEGORIES, category["key"]
    for note in category["notes"]:
        _keys(SWARM_NOTE, note, "note")
        assert note["level"] in ("info", "warning") and note["code"] in NOTE_CODES, note
        assert isinstance(note["text"], str) and note["text"], note
    for sub in category["subcategories"]:
        _keys({"key", "label"}, sub, "subcategory")
        assert sub["key"] in {f"p{i}" for i in range(1, 6)} and sub["label"], sub


def assert_task_detail(task: dict) -> None:
    """Task.detail of a done task (swarm contract 5d): every field of its
    worker, the nested shapes and the list and text limits."""
    import json as _json

    worker, detail = task["worker"], task["detail"]
    _keys(TASK_DETAIL[worker], detail, f"{task['id']}.detail")
    assert len(_json.dumps(detail)) <= DETAIL_MAX_CHARS, task["id"]
    if worker == "serp_page":
        assert len(detail["top"]) <= 5 and len(detail["people_also_ask"]) <= 5
        for row in detail["top"]:
            _keys(DETAIL_SERP_TOP, row, "serp top")
        if detail["ai_overview"] is not None:
            _keys(DETAIL_OVERVIEW, detail["ai_overview"], "ai_overview")
            assert len(detail["ai_overview"]["references"]) <= 5
            for ref in detail["ai_overview"]["references"]:
                _keys({"domain", "url"}, ref, "ai_overview reference")
    elif worker == "engine_answer":
        assert detail["engine"] in ("chatgpt", "claude", "gemini", "grok", "perplexity")
        assert len(detail["brands"]) <= 10 and len(detail["brands_above"]) <= 6
        assert len(detail["citations"]) <= 8 and len(detail["snippet"]) <= 400
        for brand in [*detail["brands"], *detail["brands_above"]]:
            _keys(DETAIL_BRAND, brand, "brand")
        for citation in detail["citations"]:
            _keys(DETAIL_CITATION, citation, "citation")
        if detail["analysis"] is not None:
            _keys(DETAIL_ANALYSIS, detail["analysis"], "analysis")
            assert len(detail["analysis"]["reasons"]) <= 3
        elif detail["analysis_error"] is not None:
            _keys({"code", "message"}, detail["analysis_error"], "analysis_error")
        if not detail["mentioned"]:
            assert detail["snippet"] == "" and detail["rank"] is None
    elif worker == "page_inspect":
        assert detail["role"] in ("own", "competitor")
        _keys(DETAIL_SEO, detail["seo"], "seo")
        assert len(detail["seo"]["h2"]) <= 8 and len(detail["excerpt"]) <= 600
    elif worker == "content_gap":
        assert len(detail["gaps"]) <= 4
        urls = set()
        for page in detail["compared"]:
            _keys(DETAIL_COMPARED, page, "compared")
            urls.add(page["url"])
        for gap in detail["gaps"]:
            _keys(DETAIL_GAP, gap, "gap")
            assert gap["target"] in urls | {""} and gap["severity"] in ("high", "medium", "low")
    elif worker == "citations":
        assert len(detail["sources"]) <= 15
        domains = set()
        for source in detail["sources"]:
            _keys(DETAIL_SOURCE, source, "source")
            domains.add(source["domain"])
        if detail["analysis"] is not None:
            _keys(DETAIL_SOURCES_ANALYSIS, detail["analysis"], "sources analysis")
            assert len(detail["analysis"]["opportunities"]) <= 3
            for item in detail["analysis"]["opportunities"]:
                _keys(DETAIL_OPPORTUNITY, item, "opportunity")
                assert item["domain"] in domains, item


def assert_task(task: dict) -> None:
    """A Task (swarm contract 5c): fields, vocabularies, limits, and the
    detail of a done task (5d)."""
    import re as _re

    _keys(SWARM_TASK, task, "task")
    assert _re.fullmatch(r"[a-z0-9_.:-]{1,80}", task["id"]), task["id"]
    assert task["worker"] in SWARM_WORKERS and task["category"] in SWARM_CATEGORIES
    assert task["status"] in TASK_STATUSES and task["tone"] in TASK_TONES, task
    assert isinstance(task["rev"], int) and task["rev"] >= 1
    assert len(task["step"]) <= 80 and len(task["result"]) <= 140
    if task["status"] != "running":
        assert task["step"] == "", task
    if task["status"] == "queued":
        assert (task["result"], task["attempt"], task["started_at"]) == ("", 0, None), task
    if task["status"] in TERMINAL_TASK_STATUSES:
        assert task["ended_at"] and isinstance(task["duration_ms"], int), task
    if task["status"] in ("failed", "skipped", "stopped"):
        _keys({"code", "message"}, task["error"], f"{task['id']}.error")
        assert task["error"]["code"] in TASK_ERROR_CODES, task["error"]
        assert task["error"]["message"], task["error"]
    elif task["status"] == "done":
        assert task["error"] is None and task["result"], task
        assert_task_detail(task)
    if task["pane"] is not None:
        _keys({"kind", "tab_id"}, task["pane"], "pane")
        assert task["pane"]["kind"] in ("serp", "page")
        assert task["pane"]["tab_id"].startswith(task["pane"]["kind"] + ":")


def assert_table(table: dict) -> None:
    """A SwarmTable (swarm contract 5e): every sheet, column, row and cell."""
    assert not missing(SWARM_TABLE, table), missing(SWARM_TABLE, table)
    assert not missing(SWARM_COUNTS, table["counts"])
    keys = [s["key"] for s in table["sheets"]]
    assert keys[0] == "prompts" and keys == [k for k in ("prompts", "gaps", "sources")
                                            if k in keys]
    for change in table["changes"]:
        assert not missing(SWARM_CHANGE, change), missing(SWARM_CHANGE, change)
    for sheet in table["sheets"]:
        assert not missing(SWARM_SHEET, sheet), missing(SWARM_SHEET, sheet)
        columns = [c["key"] for c in sheet["columns"]]
        assert columns == {"prompts": PROMPT_COLUMNS, "gaps": GAP_COLUMNS,
                           "sources": SOURCE_COLUMNS}[sheet["key"]]
        for column in sheet["columns"]:
            assert not missing(SWARM_COLUMN, column) and column["kind"] in COLUMN_KINDS
        for row in sheet["rows"]:
            assert not missing(SWARM_ROW, row), missing(SWARM_ROW, row)
            assert set(row["cells"]) == set(columns), (sheet["key"], row["key"])
            for cell in row["cells"].values():
                assert not missing(SWARM_CELL, cell), missing(SWARM_CELL, cell)
                assert cell["state"] in CELL_STATES and cell["tone"] in CELL_TONES
                assert cell["text"] not in (None, ""), (sheet["key"], row["key"], cell)
            if row["finding"] is not None:
                assert not missing(FINDING_DRAFT, row["finding"])
                assert len(row["finding"]["evidence"]) <= 10
            for item in [*row["links"], *((row["finding"] or {}).get("evidence") or [])]:
                assert not missing(EVIDENCE, item) and item["kind"] in EVIDENCE_KINDS
