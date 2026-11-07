"""The six new writers end to end through run_agent (design/p2_backend.md
12): what the server reads first, the blocks the writer gets, streamed
snapshots with the parts read before writing, the saved version's data,
and the errors that stop a call before any artifact exists. Pages and
measurements are fakes; the model is the fake Anthropic client."""
import json

import pytest
from django.core.cache import cache

from apps.accounts.models import AITokenUsage
from apps.agent.models import AgentArtifact, AgentArtifactVersion, AgentMessage
from apps.agent.services import context
from apps.agent.tests.fakes import message, text, tool_use
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import run_events, send, tool_results_of

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("no_title", "allowance")]

SITE = "https://northwind.example"


@pytest.fixture
def allowance(settings):
    settings.AI_FREE_MONTHLY_CAP_USD = 100.0


def browse_result(url, paragraphs, *, status=200, title="Pricing - Northwind", links=None,
                  meta=None, h1=("Pricing",), types=("Organization",)):
    result = {
        "url": url, "final_url": url, "status_code": status, "frameable": True, "title": title,
        "captured_at": "2026-11-05T10:00:00Z",
        "seo": {"title": title, "meta_description": meta, "h1": list(h1),
                "structured_data": list(types)},
        "reader": {"title": title, "links": [],
                   "blocks": [{"type": "paragraph", "text": p} for p in paragraphs]},
        "error": None,
    }
    if links is not None:
        result["links"] = [{"url": u, "text": t} for u, t in links]
    return result


class Pages(dict):
    """Fake pages by URL, and every URL fetched (``calls``)."""

    calls: list


@pytest.fixture
def pages(monkeypatch):
    found, calls = Pages(), []

    def fetch_page(url, *, with_headers=False, with_links=False):
        calls.append(url)
        if url in found:
            result = dict(found[url])
            if not with_links:
                result.pop("links", None)
            return result
        return {"url": url, "final_url": url, "status_code": None, "frameable": False,
                "title": None, "captured_at": "2026-11-05T10:00:00Z", "seo": None,
                "reader": None, "error": {"code": "timeout",
                                          "message": "The page took longer than 12 seconds to "
                                                     "load."}}

    monkeypatch.setattr("apps.agent.services.browse.fetch_page", fetch_page)
    found.calls = calls
    return found


@pytest.fixture(autouse=True)
def _fresh_quota():
    cache.clear()


def _agent_call(args, *, id="toolu_writer"):
    return message(text("Handing this to the writer."), tool_use("run_agent", args, id=id),
                   stop_reason="tool_use")


def _run(fake_anthropic, chat, args, writer_output, *, chunks=4):
    fake_anthropic.queue(
        _agent_call({"title": "Draft", "brief": "Use the measurements.", **args}),
        message(text(writer_output, chunks=chunks), output_tokens=900),
        message(text("Saved the draft.")),
    )
    started = send(chat, "Write it")
    result = tool_results_of(fake_anthropic.requests[-1].json)[0]
    return started, result


def _part(started):
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    return next(p for p in msg.parts if p["type"] == "agent_call")


def _heads(request_json):
    return [b["text"].split(">", 1)[0].split(" ", 1)[0].rstrip(">") + ">"
            for b in request_json["messages"][0]["content"]]


REVISION = {
    "summary": "Pricing answers first.",
    "title": "Fleet battery pricing", "meta_description": "From $49 per van.",
    "h1": "Fleet battery pricing",
    "changes": [
        {"kind": "rewrite", "section": "Intro", "before": "Plans start at 49 dollars per van.",
         "after": "From $49 per van.", "reason": "Engines search for prices.",
         "signal_ids": ["s1", "s7"]},
        {"kind": "remove", "section": "Intro", "before": "A sentence the page never had.",
         "after": "", "reason": "x", "signal_ids": []},
    ],
    "page_markdown": ("# Fleet battery pricing\n\nFrom $49 per van. See "
                      "[plans](https://northwind.example/pricing) and "
                      "[elsewhere](https://evil.example/). " + "Batteries for fleets. " * 60),
}


def test_page_optimizer_reads_the_page_and_saves_a_revision(fake_anthropic, chat, website,
                                                            pages, monkeypatch, user):
    from core.quota import DailyQuota

    url = f"{SITE}/pricing"
    pages[url] = browse_result(url, ["Plans start at 49 dollars per van.",
                                     "Contact sales for fleets."])
    signals = [{"id": "s1", "kind": "fanout",
                "text": 'ChatGPT searched "fleet battery price" while answering "fleet batteries" '
                        "(2026-11-04)"}]
    monkeypatch.setattr("apps.agent.services.measured.page_signals",
                        lambda website, page_url: signals)
    quota = DailyQuota(namespace="agent_browse", setting_name="AGENT_BROWSE_DAILY_LIMIT",
                       default_limit=300)
    before = quota.remaining(str(user.id))

    started, result = _run(fake_anthropic, chat, {"agent": "page_optimizer", "url": url},
                           json.dumps(REVISION))

    assert result.get("is_error") is not True, result
    assert quota.remaining(str(user.id)) == before - 1
    artifact = AgentArtifact.objects.get()
    assert (artifact.kind, artifact.agent_key) == ("document", "page_optimizer")
    version = AgentArtifactVersion.objects.get()
    assert version.content.startswith("# Fleet battery pricing")
    assert "evil.example" not in version.content
    data = version.data
    assert data["type"] == "page_revision"
    assert data["source"]["url"] == url and data["source"]["words"] == 11
    assert data["current"] == {"title": "Pricing - Northwind", "meta_description": "",
                               "h1": "Pricing", "structured_data": ["Organization"]}
    assert [(c["id"], c["kind"], c["signal_ids"]) for c in data["changes"]] == [
        ("c1", "rewrite", ["s1"])]
    assert data["signals"] == signals
    messages = [w["message"] for w in version.warnings]
    assert "A change quoted text that isn't on the page, so it was left out." in messages
    assert "Removed 1 links to addresses that aren't in the sources." in messages

    writer = fake_anthropic.requests[1].json
    assert _heads(writer) == ["<brand>", "<current_page>", "<signals>", "<brief>",
                              "<output_contract>"]
    page_block = writer["messages"][0]["content"][1]["text"]
    assert 'url="https://northwind.example/pricing"' in page_block
    assert 'structured_data="Organization"' in page_block
    assert writer["output_config"]["format"]["type"] == "json_schema"
    assert writer["system"][0]["text"].rstrip().endswith("the other data blocks or the brief.")

    events = run_events(started.run)
    snapshots = [e["content"] for e in events if e["type"] == "artifact.snapshot"]
    assert snapshots[0]["drafting"] is True and snapshots[0]["type"] == "page_revision"
    assert snapshots[0]["source"]["url"] == url and snapshots[0]["signals"] == signals
    assert snapshots[-1] == data
    assert _part(started)["status"] == "done"
    roles = set(AITokenUsage.objects.values_list("metadata__role", flat=True))
    assert "subagent:page_optimizer" in roles


@pytest.mark.parametrize(("setup", "url", "expected"), [
    (None, "https://elsewhere.example/pricing", "page_optimizer needs a page of northwind.example."),
    (None, f"{SITE}/missing", "The page could not be loaded: The page took longer than 12 "
                              "seconds to load."),
    ("404", f"{SITE}/gone", "The page answered with HTTP 404."),
])
def test_page_optimizer_stops_before_writing(fake_anthropic, chat, pages, monkeypatch, setup,
                                            url, expected):
    monkeypatch.setattr("apps.agent.services.measured.page_signals", lambda w, u: [])
    if setup == "404":
        pages[url] = browse_result(url, ["Not found"], status=404)
    fake_anthropic.queue(_agent_call({"agent": "page_optimizer", "url": url, "title": "x",
                                      "brief": "y"}),
                         message(text("It could not run.")))
    started = send(chat, "Optimize it")
    result = tool_results_of(fake_anthropic.requests[1].json)[0]
    assert result["is_error"] is True and result["content"] == expected
    assert len(fake_anthropic.requests) == 2
    assert _part(started)["status"] == "error"
    assert not AgentArtifact.objects.exists()
    assert "artifact.started" not in [e["type"] for e in run_events(started.run)]


def test_comparison_page_reads_both_sides(fake_anthropic, chat, website, pages, monkeypatch,
                                          user):
    website.competitors = [{"name": "Evernote", "domain": "evernote.com"}]
    website.save(update_fields=["competitors"])
    context.create_entry(website, user, section="offerings", title="Plans", references=[
        {"kind": "page", "url": f"{SITE}/pricing"}])
    pages["https://evernote.com/"] = browse_result("https://evernote.com/",
                                                   ["Evernote Personal costs 14.99 a month."],
                                                   title="Evernote")
    pages[SITE] = browse_result(SITE, ["Northwind batteries for fleets."], title="Northwind")
    pages[f"{SITE}/pricing"] = browse_result(f"{SITE}/pricing", ["Packs from 49 dollars."])
    monkeypatch.setattr("apps.agent.services.measured.competitor_benchmark",
                        lambda website, competitor: {"answers": 12, "named": {"you": 4}})
    output = json.dumps({
        "summary": "A fair comparison.",
        "markdown": "# Northwind vs Evernote\n\n" + "Fair words. " * 220,
        "claims": [
            {"about": "competitor", "text": "Personal costs 14.99", "source_id": "c1",
             "quote": "Personal costs 14.99 a month"},
            {"about": "you", "text": "Packs from 49", "source_id": "p2",
             "quote": "Packs from 49 dollars"},
            {"about": "competitor", "text": "It is slow", "source_id": "c1", "quote": "slow"},
        ],
    })
    started, result = _run(fake_anthropic, chat,
                           {"agent": "comparison_page", "competitor": "https://www.evernote.com"},
                           output)
    assert result.get("is_error") is not True, result
    data = AgentArtifactVersion.objects.get().data
    assert data["type"] == "comparison"
    assert data["competitor"] == {"name": "Evernote", "domain": "evernote.com"}
    assert [(s["id"], s["owner"], s["state"]) for s in data["sources"]] == [
        ("c1", "competitor", "ok"), ("p1", "you", "ok"), ("p2", "you", "ok")]
    assert [c["verified"] for c in data["claims"]] == [True, True, False]
    writer = fake_anthropic.requests[1].json
    assert _heads(writer) == ["<brand>", "<competitor_page>", "<your_page>", "<your_page>",
                              "<benchmark>", "<brief>", "<output_contract>"]
    benchmark = writer["messages"][0]["content"][4]["text"]
    assert ("Internal measurements: use them to choose which questions the page answers; never "
            "put them on the page.") in benchmark


def test_comparison_page_refuses_untracked_or_unreadable_competitors(fake_anthropic, chat,
                                                                    website, pages):
    website.competitors = [{"name": "Evernote", "domain": "evernote.com"}]
    website.save(update_fields=["competitors"])
    fake_anthropic.queue(
        _agent_call({"agent": "comparison_page", "competitor": "notion.so", "title": "x",
                     "brief": "y"}),
        message(text("No.")),
        _agent_call({"agent": "comparison_page", "competitor": "Evernote", "title": "x",
                     "brief": "y"}, id="toolu_2"),
        message(text("No again.")),
    )
    send(chat, "Compare")
    first = tool_results_of(fake_anthropic.requests[1].json)[0]
    assert first["content"] == "notion.so isn't one of the competitors this project tracks."
    send(chat, "Compare again")
    second = tool_results_of(fake_anthropic.requests[3].json)[0]
    assert second["content"] == "None of Evernote's pages could be read."
    assert not AgentArtifact.objects.exists()


def test_social_posts_promote_a_draft(fake_anthropic, chat, website, pages, user):
    from apps.agent.services.artifacts import add_version

    article = AgentArtifact.objects.create(website=website, kind="document", agent_key="aeo_article",
                                           title="Spring launch", created_by=user)
    add_version(article, content="# Spring launch\n\nRead [it](https://northwind.example/spring).")
    output = json.dumps({"summary": "Posts.", "posts": [
        {"channel": "linkedin", "parts": ["Our spring packs are here: "
                                          "https://northwind.example/spring"],
         "link_url": "https://northwind.example/spring"},
        {"channel": "x_thread", "parts": ["One", "Two", "Three"], "link_url": ""},
    ]})
    started, result = _run(fake_anthropic, chat, {
        "agent": "social_posts", "channels": ["linkedin", "x_thread"],
        "source_artifact_id": str(article.id)}, output)
    assert result.get("is_error") is not True, result
    saved = AgentArtifact.objects.exclude(id=article.id).get()
    version = saved.versions.get()
    assert version.data["source"] == {"artifact_id": str(article.id), "title": "Spring launch",
                                      "version": 1}
    assert [p["link_url"] for p in version.data["posts"]] == [
        "https://northwind.example/spring", ""]
    assert version.content.startswith("# Social posts: Draft\n\n## LinkedIn\n")
    writer = fake_anthropic.requests[1].json
    assert _heads(writer) == ["<brand>", "<channels>", "<source_artifact>", "<brief>",
                              "<output_contract>"]
    assert "linkedin, x_thread" in writer["messages"][0]["content"][1]["text"]
    snapshots = [e["content"] for e in run_events(started.run) if e["type"] == "artifact.snapshot"]
    assert snapshots[0]["type"] == "social_posts" and snapshots[0]["drafting"] is True
    assert snapshots[-1] == version.data


def test_a_writer_never_overwrites_another_writers_draft(fake_anthropic, chat, website, user):
    from apps.agent.services.artifacts import add_version

    article = AgentArtifact.objects.create(website=website, kind="document", agent_key="aeo_article",
                                           title="Article", created_by=user)
    add_version(article, content="# Article")
    fake_anthropic.queue(
        _agent_call({"agent": "messaging_brief", "title": "x", "brief": "y",
                     "artifact_id": str(article.id)}),
        message(text("No.")),
    )
    send(chat, "Revise it")
    result = tool_results_of(fake_anthropic.requests[1].json)[0]
    assert result["is_error"] is True
    assert result["content"] == (f"Artifact {article.id} was written by the AEO Article Agent; "
                                 "ask that agent to revise it.")
    assert article.versions.count() == 1


def test_pr_writer_corrections_quote_each_page(fake_anthropic, chat, website, pages, monkeypatch):
    claim = {"key": "9f2c|contradicted", "text": "Plus costs $8", "verdict": "contradicted",
             "engines": ["chatgpt"], "answers": 3,
             "occurrences": [{"quote": "Plus at $8 per user"}],
             "evidence": {"kind": "page", "url": f"{SITE}/pricing", "quote": "Plus $10"},
             "cited_urls": [{"url": "https://www.g2.com/notion", "domain": "g2.com", "answers": 2},
                            {"url": f"{SITE}/blog", "domain": "northwind.example", "answers": 1},
                            {"url": "https://capterra.com/notion", "domain": "capterra.com",
                             "answers": 1}]}
    monkeypatch.setattr("apps.agent.services.measured.correction_claim",
                        lambda website, key: claim if key == claim["key"] else None)
    pages["https://www.g2.com/notion"] = browse_result("https://www.g2.com/notion",
                                                      ["Notion Plus costs $8 per user."],
                                                      title="G2")
    output = json.dumps({"summary": "One letter.", "markdown": "", "targets": [
        {"source_id": "t1", "quote": "Notion Plus costs $8 per user",
         "letter_markdown": f"Hello,\n\nOur [pricing]({SITE}/pricing) says Plus $10. "
                            "Could you correct it?"},
    ]})
    started, result = _run(fake_anthropic, chat, {
        "agent": "pr_writer", "format": "correction_request", "claim_key": claim["key"]}, output)
    assert result.get("is_error") is not True, result
    data = AgentArtifactVersion.objects.get().data
    assert data["type"] == "corrections"
    assert data["claim"]["evidence"] == {"kind": "page", "url": f"{SITE}/pricing",
                                         "quote": "Plus $10"}
    assert [(t["id"], t["publisher"]) for t in data["targets"]] == [("t1", "g2.com")]
    assert data["targets"][0]["letter"].startswith("Hello,")
    assert data["unreadable"] == [{"url": "https://capterra.com/notion",
                                   "publisher": "capterra.com",
                                   "reason": "The page took longer than 12 seconds to load."}]
    assert f"{SITE}/blog" not in pages.calls
    writer = fake_anthropic.requests[1].json
    assert _heads(writer) == ["<brand>", "<format>", "<claim>", "<evidence>",
                              "<third_party_page>", "<brief>", "<output_contract>"]
    snapshots = [e["content"] for e in run_events(started.run) if e["type"] == "artifact.snapshot"]
    assert snapshots[0]["type"] == "corrections" and snapshots[0]["claim"]["key"] == claim["key"]


@pytest.mark.parametrize(("found", "expected"), [
    (None, "No Fact check claim abc|supported in this project."),
    ({"verdict": "supported", "cited_urls": []},
     "Correction requests are for claims your evidence contradicts."),
])
def test_pr_writer_needs_a_contradicted_claim(fake_anthropic, chat, monkeypatch, found,
                                             expected):
    monkeypatch.setattr("apps.agent.services.measured.correction_claim", lambda w, k: found)
    fake_anthropic.queue(_agent_call({"agent": "pr_writer", "format": "correction_request",
                                      "claim_key": "abc|supported", "title": "x", "brief": "y"}),
                         message(text("No.")))
    send(chat, "Correct it")
    result = tool_results_of(fake_anthropic.requests[1].json)[0]
    assert result["is_error"] is True and result["content"] == expected


def test_a_press_release_is_a_plain_draft(fake_anthropic, chat):
    output = json.dumps({"summary": "Release.", "targets": [],
                         "markdown": "# Northwind launches fleet packs\n\n" + "News. " * 220})
    started, result = _run(fake_anthropic, chat, {"agent": "pr_writer", "format": "press_release"},
                           output)
    assert result.get("is_error") is not True, result
    version = AgentArtifactVersion.objects.get()
    assert version.data == {"type": "press", "format": "press_release"}
    assert version.content.startswith("# Northwind launches fleet packs")
    snapshots = [e["content"] for e in run_events(started.run) if e["type"] == "artifact.snapshot"]
    assert snapshots[0]["type"] == "press" and snapshots[0]["format"] == "press_release"


def test_llms_txt_links_only_to_known_pages(fake_anthropic, chat, website, pages, settings):
    settings.INSIGHTS_ENABLED = False
    pages[SITE] = browse_result(SITE, ["Northwind"], title="Northwind",
                                links=[(f"{SITE}/pricing", "Pricing"), (f"{SITE}/docs", "Docs"),
                                       ("https://elsewhere.example/", "Partner")])
    output = (f"# Northwind\n\n> Batteries for fleets.\n\n## Product\n\n- [Pricing]({SITE}/pricing): "
              "Plans\n- [Partner](https://elsewhere.example/): no\n\n## Optional\n\n"
              f"- [Docs]({SITE}/docs): Guides\n")
    started, result = _run(fake_anthropic, chat, {"agent": "llms_txt"}, output)
    assert result.get("is_error") is not True, result
    version = AgentArtifactVersion.objects.get()
    assert version.data == {"type": "llms_txt", "origin": SITE, "links": 2, "sections": 2}
    assert "elsewhere.example" not in version.content
    writer = fake_anthropic.requests[1].json
    site_pages = json.loads(writer["messages"][0]["content"][1]["text"].split("\n", 1)[1]
                            .rsplit("\n", 1)[0])
    assert [p["url"] for p in site_pages] == [SITE, f"{SITE}/pricing", f"{SITE}/docs"]
    events = run_events(started.run)
    assert "".join(e["append"] for e in events if e["type"] == "artifact.delta") == output
    assert [e["content"] for e in events if e["type"] == "artifact.snapshot"] == [version.data]

    fake_anthropic.queue(_agent_call({"agent": "llms_txt", "title": "x", "brief": "y"},
                                     id="toolu_again"),
                         message(text("> No title line")), message(text("Failed.")))
    again = send(chat, "Again")
    failed = [e for e in run_events(again.run) if e["type"] == "artifact.failed"]
    assert failed[0]["error"] == {"code": "invalid_output",
                                  "message": "The file needs a title line (# Name)."}


def test_messaging_brief_reads_how_engines_describe_the_brand(fake_anthropic, chat,
                                                              monkeypatch):
    perception = {"period": "last 90 days", "themes": [
        {"label": "easy to set up", "tone": "positive", "answers": 9, "engines": ["chatgpt"],
         "quote": "takes minutes"}], "contradicted": []}
    monkeypatch.setattr("apps.agent.services.measured.perception", lambda website: perception)
    output = "# Messaging brief\n\n## Positioning\n\n" + "Plain words. " * 160
    started, result = _run(fake_anthropic, chat, {"agent": "messaging_brief"}, output)
    assert result.get("is_error") is not True, result
    version = AgentArtifactVersion.objects.get()
    assert version.data is None and version.content.startswith("# Messaging brief")
    writer = fake_anthropic.requests[1].json
    assert _heads(writer) == ["<brand>", "<perception>", "<brief>", "<output_contract>"]
    assert json.loads(writer["messages"][0]["content"][1]["text"].split("\n", 1)[1]
                      .rsplit("\n", 1)[0]) == perception
    assert not [e for e in run_events(started.run) if e["type"] == "artifact.snapshot"]
