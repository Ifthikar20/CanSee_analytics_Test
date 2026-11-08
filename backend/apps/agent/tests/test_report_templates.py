"""Report templates: the code-defined registry, the catalog endpoint, a
template applied to a send (and kept by regenerate, edit and continue),
and the template and header a saved report carries."""
from __future__ import annotations

import json

import pytest

from apps.agent import report_templates
from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime import wire
from apps.agent.tests.api_support import add_message, add_run, client_for, data, error
from apps.agent.tests.fakes import message, text
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import send

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title")]

API = "/api/v1/agent"
KEYS = ("executive_summary", "google_ai_gap", "competitor_comparison", "prompt_deep_dive",
        "sources_citations", "brand_accuracy", "change_log")


def _note_of(user_message) -> str:
    """The system note a user message carries."""
    notes = [block["text"] for m in wire.loads(user_message.wire) if m["role"] == "system"
             for block in m["content"]]
    return "\n\n".join(notes)


# ── The registry ──────────────────────────────────────────────────────────


def test_the_registry_is_the_seven_owner_templates_in_order():
    assert report_templates.KEYS == KEYS
    names = [report_templates.TEMPLATES[k].name for k in KEYS]
    assert names == ["Executive summary", "Google vs AI gap", "Competitor comparison",
                     "Prompt deep dive", "Sources and citations", "Brand accuracy",
                     "Change log since the last run"]


@pytest.mark.parametrize("key", KEYS)
def test_every_template_is_complete_and_names_real_tools(key):
    from apps.agent.tools.registry import TOOLS

    template = report_templates.TEMPLATES[key]
    assert template.purpose and template.requirement_note and template.rules
    assert template.sections[-1].title == "Method"
    assert all(s.title and s.shows and s.source for s in template.sections)
    assert set(template.tools) | set(template.required_tools) <= set(TOOLS)
    assert set(template.sheets) <= {"prompts", "gaps", "sources"}
    for copy in (template.name, template.purpose, *template.rules,
                 *(f"{s.title} {s.shows} {s.source}" for s in template.sections)):
        assert all(ord(ch) < 0x2190 for ch in copy), "no emojis or pictographs"


def test_brand_accuracy_is_perception_and_fact_check_only():
    template = report_templates.TEMPLATES["brand_accuracy"]
    assert [s.title for s in template.sections] == [
        "Coverage", "How the engines describe the brand", "Contradicted claims",
        "Corrections to request", "Method"]
    assert "leave out brand security alerts" in " ".join(template.rules)
    assert template.required_tools == ("get_brand_perception",) and template.needs_insights


def test_change_log_compares_with_the_last_run_and_has_no_schedule():
    template = report_templates.TEMPLATES["change_log"]
    assert template.required_tools == ("get_visibility_history",)
    assert "compared" in template.header_fields
    assert "weekly" not in template.name.lower() and "schedule" not in " ".join(template.rules)


def test_only_sources_and_citations_keeps_the_sources_sheet():
    keeps = [k for k in KEYS if "sources" in report_templates.TEMPLATES[k].sheets]
    assert keeps == ["sources_citations"]


# ── The catalog endpoint ──────────────────────────────────────────────────


def _catalog(user):
    resp = client_for(user).get(f"{API}/report-templates/")
    assert resp.status_code == 200, resp.content
    return {item["id"]: item for item in data(resp)}


def test_the_catalog_lists_every_template_with_its_outline(user, settings):
    settings.INSIGHTS_ENABLED = True
    catalog = _catalog(user)
    assert list(catalog) == list(KEYS)
    item = catalog["executive_summary"]
    assert set(item) == {"id", "name", "purpose", "header_fields", "sections", "requirements",
                         "available", "unavailable", "limitations"}
    assert item["header_fields"] == ["template", "project", "captured_at", "data", "engines",
                                     "locations"]
    assert [s["title"] for s in item["sections"]] == [
        "Key numbers", "Gap mix", "Who AI recommends", "Biggest gaps", "Top fixes", "Method"]
    assert set(item["sections"][0]) == {"title", "shows", "source", "repeat"}
    assert item["requirements"] == {
        "google": "saved", "engines": "saved", "research_agents": False, "runs_checks": False,
        "note": "Uses data already measured. Runs no new Google searches or AI engine questions.",
    }
    assert catalog["google_ai_gap"]["sections"][2]["repeat"] == "prompt"
    assert catalog["competitor_comparison"]["header_fields"][-1] == "competitors"
    assert catalog["prompt_deep_dive"]["header_fields"][-1] == "prompts"
    assert catalog["change_log"]["header_fields"][-1] == "compared"


def test_the_catalog_matches_the_registry(user):
    catalog = _catalog(user)
    for key, template in report_templates.TEMPLATES.items():
        assert catalog[key]["name"] == template.name
        assert [s["title"] for s in catalog[key]["sections"]] == [s.title for s in
                                                                  template.sections]


def test_a_template_the_workspace_cannot_run_says_why_in_plain_words(user, settings):
    settings.INSIGHTS_ENABLED = False
    settings.DEBUG = False
    item = _catalog(user)["brand_accuracy"]
    assert item["available"] is False
    assert item["unavailable"] == {
        "code": "insights_off",
        "message": "Brand accuracy needs the Sentiment and Fact check analysis, which isn't "
                   "turned on for this workspace.",
    }


@pytest.mark.parametrize("who", ["staff", "debug"])
def test_staff_and_debug_also_see_the_setting(user, settings, who):
    settings.INSIGHTS_ENABLED = False
    settings.DEBUG = who == "debug"
    if who == "staff":
        user.is_staff = True
        user.save(update_fields=["is_staff"])
    assert _catalog(user)["brand_accuracy"]["unavailable"]["setting"] == "INSIGHTS_ENABLED"


def test_missing_engine_keys_are_limitations_with_plain_text(user, settings):
    settings.DEBUG = False
    settings.OPENAI_API_KEY = ""
    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = ""
    settings.ANTHROPIC_API_KEY = "test-key"
    catalog = _catalog(user)
    gap = catalog["google_ai_gap"]
    assert gap["available"] is True
    messages = [n["message"] for n in gap["limitations"]]
    assert "ChatGPT isn't set up on this workspace." in messages
    assert ("Google search isn't set up on this workspace, so Google results show as not "
            "configured.") in messages
    assert not any("setting" in n for n in gap["limitations"])
    # Data already measured needs no key, so no limitation is listed.
    assert catalog["executive_summary"]["limitations"] == []
    # A deep dive cannot work without Google search.
    deep = catalog["prompt_deep_dive"]
    assert deep["available"] is False
    assert deep["unavailable"]["message"] == "Google search isn't set up on this workspace."

    user.is_staff = True
    user.save(update_fields=["is_staff"])
    gap = _catalog(user)["google_ai_gap"]
    settings_named = {n["message"]: n.get("setting") for n in gap["limitations"]}
    assert settings_named["ChatGPT isn't set up on this workspace."] == "OPENAI_API_KEY"


def test_the_catalog_needs_a_signed_in_user():
    from rest_framework.test import APIClient

    assert APIClient().get(f"{API}/report-templates/").status_code == 401


# ── Applying a template to a reply ────────────────────────────────────────


def test_a_send_with_a_template_carries_its_outline_and_labels_the_reply(fake_anthropic, chat):
    fake_anthropic.queue(message(text("# Northwind status")))
    started = send(chat, "Write the summary", template="executive_summary")

    note = _note_of(started.user_message)
    assert ("For this message the user chose the Executive summary report template "
            "(executive_summary).") in note
    titles = ["1. Key numbers:", "2. Gap mix:", "3. Who AI recommends:", "4. Biggest gaps:",
              "5. Top fixes:", "6. Method:"]
    positions = [note.index(t) for t in titles]
    assert positions == sorted(positions)
    assert "- Do not call google_search, check_ai_engines or research_swarm" in note
    # The model reads the note in the same request.
    assert "(executive_summary). Its outline replaces" in json.dumps(
        fake_anthropic.requests[0].json)
    started.assistant_message.refresh_from_db()
    assert started.assistant_message.research["template"] == "executive_summary"


def test_a_template_can_apply_to_the_next_reply_only(fake_anthropic, chat):
    fake_anthropic.queue(message(text("Hello.")), message(text("# Sources")),
                         message(text("Plain answer.")))
    first = send(chat, "Hi")
    second = send(chat, "Now the sources report", template="sources_citations")
    third = send(chat, "Thanks")

    assert "report template" not in _note_of(first.user_message)
    assert "Sources and citations report template (sources_citations)" in _note_of(
        second.user_message)
    assert "report template" not in _note_of(third.user_message)
    for started, expected in ((first, None), (second, "sources_citations"), (third, None)):
        started.assistant_message.refresh_from_db()
        assert started.assistant_message.research.get("template") == expected


def test_an_unknown_template_is_400_and_starts_nothing(chat, website, user):
    resp = client_for(user).post(
        f"{API}/live/websites/{website.id}/chats/{chat.id}/messages/",
        {"text": "Go", "template": "weekly_digest"}, format="json")
    assert resp.status_code == 400
    assert (error(resp)["code"], error(resp)["message"]) == ("invalid", "Unknown report template.")
    assert not AgentRun.objects.exists() and not AgentMessage.objects.exists()


def test_the_send_endpoint_accepts_a_template(fake_anthropic, chat, website, user):
    fake_anthropic.queue(message(text("# Report")))
    resp = client_for(user).post(
        f"{API}/live/websites/{website.id}/chats/{chat.id}/messages/",
        {"text": "Go", "template": "google_ai_gap"}, format="json")
    assert resp.status_code == 202, resp.content
    assert data(resp)["assistant_message"]["research"]["template"] == "google_ai_gap"


def test_an_unavailable_template_is_refused_with_its_reason(chat, settings):
    from apps.agent.services.runs import TemplateUnavailable

    settings.INSIGHTS_ENABLED = False
    with pytest.raises(TemplateUnavailable) as caught:
        send(chat, "How do engines describe us?", template="brand_accuracy")
    assert caught.value.code == "template_unavailable"
    assert "Sentiment and Fact check" in caught.value.message
    assert not AgentRun.objects.exists()


def test_a_chat_pinned_to_a_snapshot_without_the_tool_must_start_over(user, website, snapshot):
    from apps.agent.models import AgentChat
    from apps.agent.services.runs import TemplateUnavailable

    old = AgentChat.objects.create(website=website, user=user, entry_agent="gap_analyst",
                                   snapshot=snapshot)
    with pytest.raises(TemplateUnavailable) as caught:
        send(old, "What changed?", template="change_log")
    assert caught.value.message == ("The Change log since the last run template needs a newer "
                                    "chat. Start a new chat to use it.")


def test_regenerate_and_continue_keep_the_template(fake_anthropic, chat, user, website,
                                                    settings):
    from apps.agent.services.runs import start_continue, start_regenerate

    settings.SERPAPI_KEY = "serp-test"

    fake_anthropic.queue(message(text("# Cut"), stop_reason="max_tokens"),
                         message(text(" and the rest.")), message(text("# Another take")))
    first = send(chat, "Deep dive please", template="prompt_deep_dive")
    cont = start_continue(user=user, website=website, message_id=first.assistant_message.id)
    regen = start_regenerate(user=user, website=website, message_id=first.assistant_message.id)

    assert cont.assistant_message.research["template"] == "prompt_deep_dive"
    # The continue note does not repeat the outline; the history has it.
    assert "report template" not in _note_of(cont.user_message)
    assert regen.assistant_message.research["template"] == "prompt_deep_dive"
    assert regen.assistant_message.parent_id == first.user_message.id


def test_regenerate_reads_the_template_from_the_user_note_when_research_lost_it(
        fake_anthropic, chat, user, website):
    from apps.agent.services.runs import start_regenerate

    fake_anthropic.queue(message(text("# One")), message(text("# Two")))
    first = send(chat, "Go", template="competitor_comparison")
    AgentMessage.objects.filter(id=first.assistant_message.id).update(research={})
    regen = start_regenerate(user=user, website=website, message_id=first.assistant_message.id)
    assert regen.assistant_message.research["template"] == "competitor_comparison"


def test_edit_keeps_changes_or_drops_the_template(fake_anthropic, chat, user, website):
    from apps.agent.services.runs import start_edit

    fake_anthropic.queue(*(message(text(f"# Reply {n}")) for n in range(4)))
    first = send(chat, "Go", template="executive_summary")
    kept = start_edit(user=user, website=website, message_id=first.user_message.id, text="Go!")
    changed = start_edit(user=user, website=website, message_id=first.user_message.id,
                         text="Go!", template="sources_citations")
    dropped = start_edit(user=user, website=website, message_id=first.user_message.id,
                         text="Go!", template=None)

    assert kept.assistant_message.research["template"] == "executive_summary"
    assert "(executive_summary)" in _note_of(kept.user_message)
    assert changed.assistant_message.research["template"] == "sources_citations"
    assert "(sources_citations)" in _note_of(changed.user_message)
    assert dropped.assistant_message.research == {}
    assert "report template" not in _note_of(dropped.user_message)


def test_the_edit_endpoint_takes_a_template(fake_anthropic, chat, website, user):
    fake_anthropic.queue(message(text("# A")), message(text("# B")))
    first = send(chat, "Go", template="executive_summary")
    resp = client_for(user).post(
        f"{API}/live/websites/{website.id}/messages/{first.user_message.id}/edit/",
        {"text": "Go again", "template": ""}, format="json")
    assert resp.status_code == 202, resp.content
    assert data(resp)["assistant_message"]["research"] == {}


def test_the_orchestrator_prompt_lets_the_note_replace_the_outline():
    from apps.agent.prompts import orchestrator

    assert orchestrator.VERSION == "2026-11-08.1"
    assert ("# Report templates\nWhen a system message says the user chose a report template "
            "for a message, its outline replaces the report outlines below for that reply"
            ) in orchestrator.SYSTEM_PROMPT
    for tool in ("get_brand_perception", "get_visibility_history"):
        assert f"- {tool}: when the user asks" in orchestrator.SYSTEM_PROMPT


# ── Saving a templated reply ──────────────────────────────────────────────


def _reply(user, website, snapshot, *, parts, research):
    chat = make_chat_with(user, website, snapshot)
    question = add_message(chat, text="Write it")
    reply = add_message(chat, parent=question, role="assistant", parts=parts, status="complete",
                        research=research)
    add_run(chat, question, reply, status="completed")
    return reply


def make_chat_with(user, website, snapshot):
    from apps.agent.tests.api_support import make_chat as api_chat

    return api_chat(user, website, snapshot, title="Report")


def _save(user, website, reply):
    resp = client_for(user).post(f"{API}/websites/{website.id}/reports/",
                                 {"message_id": str(reply.id)}, format="json")
    assert resp.status_code == 201, resp.content
    return data(resp)


ENGINE_PARTS = [
    {"id": "e1", "type": "engine_check", "request": 2, "prompt_id": "p1",
     "prompt_text": "best e-bike battery", "engine": "claude", "engine_label": "Claude",
     "status": "done", "mentioned": True, "rank": 3, "sentiment": "positive", "error": None},
    {"id": "e2", "type": "engine_check", "request": 2, "prompt_id": "p1",
     "prompt_text": "best e-bike battery", "engine": "grok", "engine_label": "Grok",
     "status": "unavailable", "mentioned": None, "rank": None, "sentiment": None,
     "error": "XAI_API_KEY is not set"},
    {"id": "e3", "type": "engine_check", "request": 2, "prompt_id": "p1",
     "prompt_text": "best e-bike battery", "engine": "gemini", "engine_label": "Gemini",
     "status": "unavailable", "mentioned": None, "rank": None, "sentiment": None,
     "error": "Not in this prompt's model selection"},
]
SERP = {"capture_id": "cap1", "query": "best e-bike battery", "page": 1, "location": "us",
        "captured_at": "2026-11-02T10:00:00Z", "results": [], "ai_overview": None,
        "error": None}
GAP = {"prompt": {"id": "p1", "text": "best e-bike battery", "location": "us"},
       "gap": {"class": "ai_ahead", "value": 71}}


def test_a_templated_report_saves_its_template_and_header(user, website, snapshot, settings):
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.OPENAI_API_KEY = "sk-test"
    settings.XAI_API_KEY = ""
    website.competitors = [{"name": "Alpha", "domain": "alpha.example"}, "not a dict"]
    website.save(update_fields=["competitors"])
    parts = [
        {"id": "t0", "type": "tool", "request": 1, "name": "get_cited_sources",
         "label": "Cited sources", "status": "done", "summary": "3 sources", "error": None},
        {"id": "t9", "type": "tool", "request": 1, "name": "get_ai_answers",
         "label": "AI engine answers", "status": "error", "summary": "", "error": "x"},
        {"id": "s1", "type": "serp", "request": 1, "query": "best e-bike battery", "page": 1,
         "status": "done", "tab_id": "serp:cap1"},
        *ENGINE_PARTS,
        {"id": "t1", "type": "text", "request": 3, "text": "No heading here.", "citations": []},
    ]
    reply = _reply(user, website, snapshot, parts=parts, research={
        "template": "sources_citations", "serp": {"cap1": SERP}, "gaps": [GAP]})
    body = _save(user, website, reply)

    assert body["title"].startswith("Sources and citations · Northwind · ")
    stored = body["data"]
    assert stored["template"] == "sources_citations"
    header = stored["header"]
    assert set(header) == {"template", "project", "captured_at", "data", "engines", "locations",
                           "prompts", "competitors", "compared"}
    assert header["template"] == {"id": "sources_citations", "name": "Sources and citations"}
    assert header["project"] == {"name": "Northwind", "url": "https://northwind.example"}
    assert [(d["key"], d["window_days"]) for d in header["data"]] == [
        ("citations", 120), ("tracked_data", 120), ("google", None), ("engine_checks", None)]
    engines = {e["key"]: (e["status"], e["configured"]) for e in header["engines"]}
    assert engines["claude"] == ("asked", True)
    assert engines["grok"] == ("not_configured", False)
    assert engines["gemini"][0] == "not_selected"
    assert engines["chatgpt"] == ("not_asked", True)
    assert header["locations"] == ["US"]
    assert header["prompts"] == [{"prompt_id": "p1", "text": "best e-bike battery",
                                  "location": "US"}]
    assert header["competitors"] == [{"name": "Alpha", "domain": "alpha.example"}]
    assert header["compared"] is None


def test_a_report_without_a_template_stays_unlabelled(user, website, snapshot):
    parts = [{"id": "t1", "type": "text", "request": 1, "text": "Plain text.", "citations": []}]
    body = _save(user, website, _reply(user, website, snapshot, parts=parts, research={}))
    assert body["data"]["template"] is None
    assert body["data"]["header"]["template"] is None
    assert body["data"]["header"]["data"] == []
    assert body["title"].startswith("SEO and GEO report · Northwind · ")


def test_a_change_log_header_names_the_checks_compared(user, website, snapshot):
    history = {"window_days": 90, "latest_check_at": "2026-11-07T09:00:00+00:00",
               "previous_check_at": "2026-11-01T09:00:00+00:00", "counts": {}}
    parts = [
        {"id": "t0", "type": "tool", "request": 1, "name": "get_visibility_history",
         "label": "Visibility history", "status": "done", "summary": "", "error": None},
        {"id": "t1", "type": "text", "request": 2, "text": "# Changes", "citations": []},
    ]
    body = _save(user, website, _reply(user, website, snapshot, parts=parts, research={
        "template": "change_log", "history": {"visibility": history}}))
    header = body["data"]["header"]
    assert header["compared"] == {"kind": "engine_checks", "window_days": 90,
                                  "latest_check_at": "2026-11-07T09:00:00+00:00",
                                  "previous_check_at": "2026-11-01T09:00:00+00:00"}
    assert header["data"] == [{"key": "visibility_history", "label": "Visibility history",
                               "window_days": 90}]
    assert body["title"] == "Changes"


def test_the_sources_template_keeps_the_sources_sheet_in_the_appendix(user, website, chat):
    from apps.agent.tests.test_reports_swarm import swarm_parts
    from apps.agent.tests.test_swarm_tables import contract_table

    _, _, _, table = contract_table()
    assert any(s["key"] == "sources" for s in table["sheets"]), "fixture has a sources sheet"
    body_parts = [*swarm_parts(),
                  {"id": "p4", "type": "text", "request": 2, "text": "# Sources",
                   "citations": []}]
    question = add_message(chat, role="user", text="Sources")
    templated = add_message(chat, parent=question, role="assistant", parts=body_parts,
                            status="complete", research={"template": "sources_citations"})
    add_run(chat, question, templated, status="completed")
    plain_q = add_message(chat, role="user", text="Again")
    plain = add_message(chat, parent=plain_q, role="assistant", parts=body_parts,
                        status="complete")
    add_run(chat, plain_q, plain, status="completed")

    assert "### Sources\n\n| Domain |" in _save(user, website, templated)["content"]
    assert "### Sources" not in _save(user, website, plain)["content"]


def test_a_research_header_uses_the_plan_and_the_table(user, website, chat):
    from apps.agent.models import AgentSwarm
    from apps.agent.tests.test_reports_swarm import swarm_parts

    parts = [*swarm_parts(), {"id": "p4", "type": "text", "request": 2, "text": "# Gap",
                              "citations": []}]
    table = parts[1]["table"]
    # The swarm the table came from, as research_swarm saved it.
    AgentSwarm.objects.create(
        id=table["swarm_id"], website=website, chat=chat, user=user, title="Research Notion",
        plan={"prompts": [{"key": "p1", "prompt_id": None, "text": "best note app",
                           "location": "gb"}],
              "competitors": ["evernote.com"]},
    )
    question = add_message(chat, role="user", text="Research")
    reply = add_message(chat, parent=question, role="assistant", parts=parts,
                        status="complete", research={"template": "google_ai_gap"})
    add_run(chat, question, reply, status="completed")
    header = _save(user, website, reply)["data"]["header"]

    assert header["captured_at"] == "2026-11-04T10:17:18.880Z"
    assert header["prompts"][0] == {"prompt_id": None, "text": "best note app", "location": "GB"}
    assert header["locations"] == ["GB"]
    assert header["competitors"] == [{"name": "evernote.com", "domain": "evernote.com"}]
    assert ("research_agents", None) in [(d["key"], d["window_days"]) for d in header["data"]]
    statuses = {e["key"]: e["status"] for e in header["engines"]}
    # The contract table: ChatGPT answered (not named), Claude failed, the rest not configured.
    assert statuses["chatgpt"] == "asked" and statuses["claude"] == "failed"
    assert statuses["gemini"] == "not_configured"
