"""The writers' building blocks without the model loop: post lengths, the
run_agent input rules, sourcing helpers, the validators of each new
writer (contract 12c-12f) and their budgets."""
import json
from decimal import Decimal
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from apps.agent.subagents import comparison_page, llms_txt, page_optimizer, pr_writer, social_posts
from apps.agent.subagents import sourcing
from apps.agent.subagents.base import WRITER_BLOCK_CHARS, Inputs, LinkFacts
from apps.agent.subagents.markdown_checks import check_markdown
from apps.agent.subagents.post_length import X_LIMIT, linkedin_length, x_length
from apps.agent.tools.schemas import RunAgentInput

BASE = {"title": "Draft", "brief": "Write it."}


# ── Post lengths (contract 12f) ─────────────────────────────────────────


def test_x_counts_links_as_23_and_heavy_characters_as_2():
    assert x_length("hello") == 5
    assert x_length("Read https://northwind.example/a/very/long/path?with=query") == 5 + 23
    assert x_length("See https://a.example. Then https://b.example/x!") == 4 + 23 + 7 + 23 + 1
    # Latin, punctuation in 8192-8205 and the 8242-8247 primes weigh 1; CJK weighs 2.
    assert x_length("é ′") == 3
    assert x_length("日本") == 4
    # Combining marks are normalized (NFC) first: e + acute is one character.
    assert x_length("é") == 1
    assert linkedin_length("é" * 3) == 3
    assert x_length("a" * 280) == X_LIMIT


# ── run_agent inputs (contract 12c) ─────────────────────────────────────


@pytest.mark.parametrize(("args", "message"), [
    ({"agent": "aeo_article", "url": "https://northwind.example/x"},
     "url is used only by page_optimizer and comparison_page."),
    ({"agent": "page_optimizer", "url": "https://northwind.example/x", "competitor": "x.com"},
     "competitor is used only by comparison_page."),
    ({"agent": "landing_page", "channels": ["x"]}, "channels is used only by social_posts."),
    ({"agent": "aeo_article", "source_artifact_id": "6f1c1f1e-35b1-4a3e-9d3e-1c2b3a4d5e6f"},
     "source_artifact_id is used only by social_posts."),
    ({"agent": "social_posts", "format": "press_release"}, "format is used only by pr_writer."),
    ({"agent": "messaging_brief", "claim_key": "abc|contradicted"},
     "claim_key is used only by pr_writer."),
    ({"agent": "page_optimizer"}, "page_optimizer needs url"),
    ({"agent": "page_optimizer", "url": "ftp://northwind.example/x"}, "url must be an http"),
    ({"agent": "comparison_page"}, "comparison_page needs competitor"),
    ({"agent": "pr_writer"}, "pr_writer needs format"),
    ({"agent": "pr_writer", "format": "correction_request"}, "needs claim_key"),
    ({"agent": "pr_writer", "format": "press_release", "claim_key": "k"},
     "claim_key goes with format correction_request only."),
    ({"agent": "social_posts", "channels": ["x", "x"]}, "channels lists each network once."),
    ({"agent": "social_posts", "channels": []}, "at least 1 item"),
    ({"agent": "social_posts", "channels": ["x", "linkedin", "x_thread", "x"]}, "at most 3"),
    ({"agent": "social_posts", "channels": ["instagram"]}, "Input should be"),
    ({"agent": "pr_writer", "format": "correction_request", "claim_key": "k" * 41},
     "at most 40 characters"),
])
def test_each_writer_takes_only_its_own_inputs(args, message):
    with pytest.raises(ValidationError) as exc:
        RunAgentInput.model_validate({**BASE, **args})
    assert message in str(exc.value)


def test_valid_writer_inputs():
    ok = [
        {"agent": "page_optimizer", "url": "https://northwind.example/pricing"},
        {"agent": "comparison_page", "competitor": "evernote.com",
         "url": "https://evernote.com/compare"},
        {"agent": "social_posts"},
        {"agent": "social_posts", "channels": ["x_thread"],
         "source_artifact_id": "6f1c1f1e-35b1-4a3e-9d3e-1c2b3a4d5e6f"},
        {"agent": "pr_writer", "format": "media_pitch"},
        {"agent": "pr_writer", "format": "correction_request", "claim_key": "9f2c|contradicted"},
        {"agent": "llms_txt"}, {"agent": "messaging_brief"},
    ]
    for args in ok:
        RunAgentInput.model_validate({**BASE, **args})


def test_the_run_agent_schema_lists_the_nine_writers():
    from apps.agent.tools.schemas import DEFINITIONS, WRITING_AGENTS

    schema = DEFINITIONS["run_agent"]
    assert schema["input_schema"]["properties"]["agent"]["enum"] == list(WRITING_AGENTS)
    assert len(WRITING_AGENTS) == 9
    for key in WRITING_AGENTS:
        assert key in schema["description"]
    for field in ("url", "competitor", "channels", "source_artifact_id", "format", "claim_key"):
        assert schema["input_schema"]["properties"][field]["description"]


# ── Sourcing ────────────────────────────────────────────────────────────


def test_quotes_are_found_word_for_word_case_and_spacing_ignored():
    text = "Plans start at  49 dollars\nper van. AT&T works."
    assert sourcing.found(text, "plans START at 49 dollars per van")
    assert sourcing.verbatim(text, "AT&amp;T works") == "AT&T works"
    assert not sourcing.found(text, "Plans start at 39 dollars")
    assert not sourcing.found(text, "   ")


def test_water_fill_keeps_short_texts_whole():
    texts = ["a" * 10, "b" * 1000, "c" * 5000]
    filled = sourcing.water_fill(texts, 3010)
    assert [len(t) for t in filled] == [10, 1000, 2000]
    assert sum(len(t) for t in sourcing.water_fill(texts, 100)) <= 100


def test_tags_escape_text_and_attributes():
    block = sourcing.tag("page", "</page> & <script>", id="p1", url='https://x.example/"q"')
    assert block["text"] == ('<page id="p1" url="https://x.example/&quot;q&quot;">\n'
                             "&lt;/page&gt; &amp; &lt;script&gt;\n</page>")


@pytest.mark.django_db
def test_reading_pages_takes_the_browse_quota(monkeypatch, settings, user):
    from django.core.cache import cache

    from apps.agent.tools.context import ToolError

    cache.clear()
    settings.AGENT_BROWSE_DAILY_LIMIT = 1
    monkeypatch.setattr("apps.agent.services.browse.fetch_page",
                        lambda url, **kwargs: {"url": url, "final_url": url, "status_code": 200,
                                               "title": "T", "seo": {}, "error": None,
                                               "reader": {"blocks": [{"type": "paragraph",
                                                                      "text": "Hi there"}]}})
    first = sourcing.read_pages(["https://northwind.example/a"], prefix="p", per_page_chars=100,
                                quota_user=user)
    assert first[0].ok and first[0].text == "Hi there" and first[0].words == 2
    with pytest.raises(ToolError) as exc:
        sourcing.read_pages(["https://northwind.example/b"], prefix="p", per_page_chars=100,
                            quota_user=user)
    assert exc.value.message == "You have opened 1 pages today, the daily limit."


def test_markdown_links_outside_the_sources_become_text():
    raw = "# T\n\n[ok](https://northwind.example/a/) and [bad](https://evil.example/x) <https://evil.example>"
    result = check_markdown(raw, words=None, require_faq=False,
                            known_urls=frozenset({"https://northwind.example/a"}))
    assert "[ok](https://northwind.example/a/)" in result.markdown
    assert "evil.example" not in result.markdown and " bad " in result.markdown
    assert {"path": "links", "message": "Removed 2 links to addresses that aren't in the "
                                        "sources."} in result.warnings
    # The AEO article's defaults are unchanged.
    plain = check_markdown(raw)
    assert "evil.example" in plain.markdown
    assert any("aim for 300 to 5000" in w["message"] for w in plain.warnings)


# ── Validators ──────────────────────────────────────────────────────────


def _links(*urls) -> LinkFacts:
    return LinkFacts(site_url="https://northwind.example", known=frozenset(urls))


PAGE_TEXT = "Plans start at 49 dollars per van.\nContact sales for fleets of 50 or more."


def _optimizer_inputs():
    return Inputs(
        blocks=[], sources={"p1": PAGE_TEXT}, link_urls=frozenset(),
        data={"source": {"url": "https://northwind.example/pricing"},
              "current": {"title": "Pricing - Northwind", "meta_description": "", "h1": "Pricing",
                          "structured_data": []},
              "signals": [{"id": "s1", "kind": "google", "text": "Google position 4"}]},
        checks={"path": "/pricing"},
    )


def _revision(**overrides):
    out = {
        "summary": "Answer-first pricing.", "title": "Fleet battery pricing",
        "meta_description": "Prices per van.", "h1": "Fleet battery pricing",
        "changes": [
            {"kind": "rewrite", "section": "Intro", "before": "plans start at 49 DOLLARS per van.",
             "after": "From $49 per van.", "reason": "Answer first.", "signal_ids": ["s1", "s9"]},
            {"kind": "remove", "section": "Intro", "before": "Words that are not there.",
             "after": "", "reason": "x", "signal_ids": []},
            {"kind": "metadata", "section": "Title", "before": "Pricing - Northwind",
             "after": "Fleet battery pricing", "reason": "No signal applies.", "signal_ids": []},
            {"kind": "metadata", "section": "Meta", "before": "An invented description",
             "after": "x", "reason": "x", "signal_ids": []},
            {"kind": "metadata", "section": "Meta", "before": "", "after": "Prices per van.",
             "reason": "Missing today.", "signal_ids": []},
            {"kind": "add", "section": "FAQ", "before": "", "after": "Q and A.", "reason": "x",
             "signal_ids": []},
        ],
        "page_markdown": "# Fleet battery pricing\n\n" + "From $49 per van. " * 40,
    }
    out.update(overrides)
    return json.dumps(out)


def test_page_revision_keeps_only_changes_that_quote_the_page():
    validated = page_optimizer.validate(_revision(), "end_turn", links=_links(),
                                        inputs=_optimizer_inputs())
    changes = validated.data["changes"]
    assert [(c["id"], c["kind"], c["before"]) for c in changes] == [
        ("c1", "rewrite", "plans start at 49 DOLLARS per van."),
        ("c2", "metadata", "Pricing - Northwind"),
        ("c3", "metadata", ""),
        ("c4", "add", ""),
    ]
    assert changes[0]["signal_ids"] == ["s1"]
    assert {"path": "changes", "message": page_optimizer.DROPPED} in validated.warnings
    assert validated.data["proposed"] == {"title": "Fleet battery pricing",
                                          "meta_description": "Prices per van.",
                                          "h1": "Fleet battery pricing"}
    assert validated.content.startswith("# Fleet battery pricing")
    assert validated.summary.startswith("4 changes to /pricing.")
    with pytest.raises(ValueError, match="has to start with its H1"):
        page_optimizer.validate(_revision(page_markdown="No heading here."), "end_turn",
                                links=_links(), inputs=_optimizer_inputs())
    with pytest.raises(ValueError, match="cut off"):
        page_optimizer.validate(_revision(), "max_tokens", links=_links(),
                                inputs=_optimizer_inputs())


def test_page_revision_keeps_at_most_twenty_changes():
    many = [{"kind": "add", "section": f"S{i}", "before": "", "after": "x", "reason": "x",
             "signal_ids": []} for i in range(25)]
    validated = page_optimizer.validate(_revision(changes=many), "end_turn", links=_links(),
                                        inputs=_optimizer_inputs())
    assert len(validated.data["changes"]) == 20
    assert any("more than 20 changes" in w["message"] for w in validated.warnings)


def test_comparison_claims_need_a_quote_from_their_own_side():
    inputs = Inputs(
        blocks=[], link_urls=frozenset(),
        sources={"c1": "Evernote Personal costs 14.99 a month.", "p1": "Northwind is free."},
        data={"competitor": {"name": "Evernote", "domain": "evernote.com"}, "sources": []},
        checks={"owners": {"c1": "competitor", "p1": "you"},
                "names": {"you": "Northwind", "competitor": "Evernote"}},
    )
    raw = json.dumps({"summary": "s", "markdown": "# Northwind vs Evernote\n\n" + "Word " * 450,
                      "claims": [
                          {"about": "competitor", "text": "Evernote costs 14.99",
                           "source_id": "c1", "quote": "costs 14.99 a month"},
                          {"about": "competitor", "text": "Evernote is free",
                           "source_id": "p1", "quote": "Northwind is free"},
                          {"about": "you", "text": "Northwind is free", "source_id": "p1",
                           "quote": "Northwind is free"},
                          {"about": "you", "text": "Northwind is fast", "source_id": "p1",
                           "quote": "fast"},
                      ]})
    validated = comparison_page.validate(raw, "end_turn", links=_links(), inputs=inputs)
    assert [c["verified"] for c in validated.data["claims"]] == [True, False, True, False]
    messages = [w["message"] for w in validated.warnings]
    assert "This statement about Evernote isn't backed by a quote from its source." in messages
    assert "This statement about Northwind isn't backed by a quote from its source." in messages
    assert validated.summary.endswith("2 of 4 claims verified")


def test_social_posts_are_counted_flagged_and_kept():
    inputs = Inputs(blocks=[], sources={}, link_urls=frozenset(), data={"source": None},
                    checks={"channels": ["x", "x_thread"], "title": "Spring launch"})
    raw = json.dumps({"summary": "s", "posts": [
        {"channel": "linkedin", "parts": ["Not asked for."], "link_url": ""},
        {"channel": "x", "parts": ["日" * 141], "link_url": "https://evil.example/x"},
        {"channel": "x_thread", "parts": ["One https://northwind.example/spring", "Two"],
         "link_url": "https://northwind.example/spring"},
    ]})
    validated = social_posts.validate(raw, "end_turn",
                                      links=_links("https://northwind.example/spring"),
                                      inputs=inputs)
    posts = validated.data["posts"]
    assert [(p["id"], p["channel"], p["link_url"]) for p in posts] == [
        ("p1", "x", ""), ("p2", "x_thread", "https://northwind.example/spring")]
    assert posts[0]["parts"] == [{"text": "日" * 141, "length": 282, "limit": 280,
                                  "over": True}]
    assert posts[1]["parts"][0]["length"] == 4 + 23
    messages = [w["message"] for w in validated.warnings]
    assert "A post for a network that wasn't asked for was left out." in messages
    assert "X post 1 has 282 characters; the limit is 280." in messages
    assert any("isn't in the sources" in m for m in messages)
    assert validated.content.startswith("# Social posts: Spring launch\n\n## X\n")
    assert "## X thread\n\n1. One https://northwind.example/spring\n2. Two" in validated.content
    assert validated.summary == "2 posts: 1 X, 1 X thread; 1 over the limit"


def _correction_inputs():
    return Inputs(
        blocks=[], link_urls=frozenset(),
        sources={"t1": "G2 says Notion Plus costs $8 per user.", "t2": "Nothing about prices."},
        data={"claim": {"key": "k|contradicted", "text": "Plus costs $8", "engines": ["chatgpt"],
                        "answers": 3, "evidence": {"kind": "page",
                                                   "url": "https://northwind.example/pricing",
                                                   "quote": "Plus $10"}}},
        checks={"format": "correction_request", "known_text": "", "targets": [
            {"id": "t1", "url": "https://g2.com/notion", "publisher": "g2.com",
             "read_at": "2026-11-05T10:00:00Z", "ok": True, "reason": ""},
            {"id": "t2", "url": "https://capterra.com/notion", "publisher": "capterra.com",
             "read_at": "2026-11-05T10:00:00Z", "ok": True, "reason": ""},
            {"id": "t3", "url": "https://blog.example/notion", "publisher": "blog.example",
             "read_at": "2026-11-05T10:00:00Z", "ok": False,
             "reason": "The page answered with HTTP 404."},
        ]},
    )


def test_correction_letters_need_the_claim_on_their_page():
    raw = json.dumps({"summary": "s", "markdown": "", "targets": [
        {"source_id": "t1", "quote": "Notion Plus costs $8 per user",
         "letter_markdown": "Hello,\n\nOur [pricing page](https://northwind.example/pricing) "
                            "says Plus $10."},
        {"source_id": "t2", "quote": "Notion Plus costs $8", "letter_markdown": "Hello"},
    ]})
    validated = pr_writer.validate(raw, "end_turn",
                                   links=_links("https://northwind.example/pricing"),
                                   inputs=_correction_inputs())
    data = validated.data
    assert data["type"] == "corrections"
    assert [(t["id"], t["publisher"], t["quote"]) for t in data["targets"]] == [
        ("t1", "g2.com", "Notion Plus costs $8 per user")]
    assert data["targets"][0]["letter"].startswith("Hello,")
    assert data["not_repeating"] == [{"url": "https://capterra.com/notion",
                                      "publisher": "capterra.com"}]
    assert data["unreadable"] == [{"url": "https://blog.example/notion",
                                   "publisher": "blog.example",
                                   "reason": "The page answered with HTTP 404."}]
    assert validated.warnings == []
    assert validated.content.startswith('# Correction requests: "Plus costs $8"\n\n## g2.com\n')
    assert "## Pages that don't repeat the claim" in validated.content
    assert "## Pages that couldn't be read" in validated.content

    unlinked = json.dumps({"summary": "s", "markdown": "", "targets": [
        {"source_id": "t1", "quote": "Notion Plus costs $8 per user", "letter_markdown": "Hi"}]})
    warned = pr_writer.validate(unlinked, "end_turn", links=_links(),
                                inputs=_correction_inputs())
    assert warned.warnings == [{"path": "targets",
                                "message": "This letter doesn't link your evidence."}]


def test_a_release_quote_must_come_from_the_brief_or_the_context():
    inputs = Inputs(blocks=[], sources={}, link_urls=frozenset(), data={"format": "press_release"},
                    checks={"format": "press_release",
                            "known_text": 'Brief: CEO Ana said "We built this for fleets of every size".'})
    said = json.dumps({"summary": "s", "targets": [], "markdown": (
        "# Northwind launches packs\n\n" + "News. " * 210 +
        '"We built this for fleets of every size," said Ana.')})
    ok = pr_writer.validate(said, "end_turn", links=_links(), inputs=inputs)
    assert ok.data == {"type": "press", "format": "press_release"}
    assert pr_writer.QUOTE_WARNING not in [w["message"] for w in ok.warnings]
    invented = json.dumps({"summary": "s", "targets": [], "markdown": (
        "# Northwind launches packs\n\n" + "News. " * 210 +
        '"This is the best battery ever made," said Ana.')})
    warned = pr_writer.validate(invented, "end_turn", links=_links(), inputs=inputs)
    assert pr_writer.QUOTE_WARNING in [w["message"] for w in warned.warnings]


def test_llms_txt_needs_a_title_and_links_to_known_pages_only():
    inputs = Inputs(blocks=[], sources={}, link_urls=frozenset(),
                    data={"origin": "https://northwind.example"},
                    checks={"site_urls": frozenset({"https://northwind.example/pricing",
                                                    "https://northwind.example/docs"})})
    raw = ("```markdown\n# Northwind\n\n> Batteries for fleets.\n\n## Product\n\n"
           "- [Pricing](https://northwind.example/pricing): Plans\n"
           "- [Elsewhere](https://evil.example/x): no\n\n## Optional\n\n"
           "- [Docs](https://northwind.example/docs): Guides\n```")
    validated = llms_txt.validate(raw, "end_turn", links=_links(), inputs=inputs)
    assert validated.data == {"type": "llms_txt", "origin": "https://northwind.example",
                              "links": 2, "sections": 2}
    assert "evil.example" not in validated.content and "- Elsewhere: no" in validated.content
    messages = [w["message"] for w in validated.warnings]
    assert "Removed a code fence around the file." in messages
    with pytest.raises(ValueError, match=r"needs a title line \(# Name\)"):
        llms_txt.validate("> No title", "end_turn", links=_links(), inputs=inputs)


# ── Budgets ─────────────────────────────────────────────────────────────


@pytest.mark.django_db
def test_budgets_follow_each_writers_own_limit(user, settings):
    from apps.agent.services.catalog import writers
    from apps.agent.subagents.base import WRITER_INPUT_USD_MAX, writer_budget

    settings.AI_FREE_MONTHLY_CAP_USD = 0.20
    assert WRITER_INPUT_USD_MAX == Decimal("0.13")
    # $0.20 pays for 10,000 output tokens: enough for an 8,000-token writer only.
    assert writer_budget(user, 8000) == (8000, 8000, 0.2, 0.0)
    assert writer_budget(user, 24000)[:2] == (10000, 16000)
    status = writers(user)
    assert status["social_posts"] == {"available": True, "needs_usd": 0.16, "max_usd": "0.29"}
    assert status["page_optimizer"] == {"available": False, "needs_usd": 0.32,
                                        "max_usd": "0.61"}


@pytest.mark.django_db
def test_the_blocks_writers_read_stay_within_their_room(monkeypatch, settings, user):
    """Five long pages are water-filled into WRITER_BLOCK_CHARS together."""
    from django.core.cache import cache

    cache.clear()
    settings.AGENT_BROWSE_DAILY_LIMIT = 50
    website = SimpleNamespace(url="https://northwind.example", name="Northwind",
                              competitors=[{"name": "Evernote", "domain": "evernote.com"}])
    monkeypatch.setattr("apps.agent.services.browse.fetch_page", lambda url, **kw: {
        "url": url, "final_url": url, "status_code": 200, "title": "T", "seo": {}, "error": None,
        "reader": {"blocks": [{"type": "paragraph", "text": "word " * 20000}]}})
    monkeypatch.setattr("apps.agent.services.measured.competitor_benchmark",
                        lambda website, competitor: {"answers": 3})
    monkeypatch.setattr("apps.agent.services.context.offering_urls",
                        lambda website: ["https://northwind.example/a",
                                         "https://northwind.example/b"])
    ctx = SimpleNamespace(website=website, user=user)
    args = SimpleNamespace(competitor="Evernote", url="https://evernote.com/compare")
    extra = comparison_page.inputs(ctx, args, lambda line: None)
    assert len(extra.blocks) == 6
    assert sum(len(b["text"]) for b in extra.blocks) <= WRITER_BLOCK_CHARS
    assert [s["id"] for s in extra.data["sources"]] == ["c1", "c2", "p1", "p2", "p3"]


# ── Measurements for writers (services.measured) ────────────────────────

PID = "6f1c1f1e-35b1-4a3e-9d3e-1c2b3a4d5e6f"
ROW = {
    "url": "https://northwind.example/pricing", "path": "/pricing", "signals": 5,
    "google": {"best_position": 3, "prompts": [
        {"prompt_id": PID, "text": "notion pricing", "position": 3,
         "checked_at": "2026-11-04T08:00:00Z"}]},
    "citations": {"citations": 6, "cited_in_text": 4, "answers": 4,
                  "engines": ["chatgpt", "claude"]},
    "ai_visits": {"sessions": 12, "by_assistant": {"chatgpt": 12}},
    "crawler_requests": {"requests": 30, "state": "ok"},
    "audit": {"passed": 7, "total": 9, "failed": ["meta_description", "text_without_js"],
              "audited_at": "2026-11-05T10:05:00Z", "words": 120},
    "sources": {"ai_visits": {"state": "ok", "source": "pixel", "source_label": "Cansee pixel"}},
}


@pytest.fixture
def insights_on(settings):
    settings.INSIGHTS_ENABLED = True


@pytest.mark.django_db
@pytest.mark.usefixtures("insights_on")
def test_page_signals_name_each_measurement_and_its_date(monkeypatch, website):
    from apps.agent.services import measured

    asked = {}
    monkeypatch.setattr("apps.insights.services.pages.page_row",
                        lambda website, url, period="30d": ROW)
    monkeypatch.setattr(measured, "_cited_prompts", lambda website, url: [PID, "other"])

    def queries(website, prompt_ids, *, period="30d", limit=10):
        asked["prompts"] = list(prompt_ids)
        return [{"prompt_id": PID, "prompt_text": "notion pricing", "query": "notion pricing 2026",
                 "engines": ["chatgpt", "claude"], "answers": 2,
                 "last_seen_at": "2026-11-04T09:00:00Z", "google": {}}]

    monkeypatch.setattr("apps.insights.services.fanouts.queries_for_prompts", queries)
    signals = measured.page_signals(website, "https://northwind.example/pricing")
    assert asked["prompts"] == [PID, "other"]
    assert signals == [
        {"id": "s1", "kind": "google",
         "text": 'Google position 3 for "notion pricing" (checked 2026-11-04)'},
        {"id": "s2", "kind": "citations",
         "text": "Cited 6 times in 4 AI answers (ChatGPT, Claude) in the last 30 days; 4 in the "
                 "answer text"},
        {"id": "s3", "kind": "fanout",
         "text": 'ChatGPT and Claude searched "notion pricing 2026" while answering '
                 '"notion pricing" (2026-11-04)'},
        {"id": "s4", "kind": "ai_visits",
         "text": "12 visits from AI assistants in the last 30 days (Cansee pixel)"},
        {"id": "s5", "kind": "crawler", "text": "30 AI crawler requests in the last 7 days "
                                                "(Cloudflare)"},
        {"id": "s6", "kind": "audit",
         "text": "Audit 2026-11-05: 7 of 9 checks pass; failing: Has a meta description, Text "
                 "without JavaScript; 120 words readable without JavaScript"},
    ]


@pytest.mark.django_db
@pytest.mark.usefixtures("insights_on")
def test_a_source_without_data_sends_no_line(monkeypatch, website):
    from apps.agent.services import measured

    row = {**ROW, "google": {"best_position": None, "prompts": []},
           "citations": {"citations": 3, "cited_in_text": 0, "answers": 2, "engines": ["claude"]},
           "ai_visits": {"sessions": 0, "by_assistant": {}},
           "crawler_requests": {"requests": None, "state": "not_in_top"},
           "audit": {"passed": None, "total": None, "state": "not_audited"}}
    monkeypatch.setattr("apps.insights.services.pages.page_row", lambda *a, **k: row)
    monkeypatch.setattr(measured, "_cited_prompts", lambda website, url: [])
    monkeypatch.setattr("apps.insights.services.fanouts.queries_for_prompts",
                        lambda *a, **k: [])
    assert measured.page_signals(website, "https://northwind.example/pricing") == [
        {"id": "s1", "kind": "retrieved_not_cited",
         "text": "Retrieved by AI engines 3 times in the last 30 days but never cited in the "
                 "answer text"}]


@pytest.mark.django_db
def test_measurements_are_empty_when_insights_are_off_or_fail(monkeypatch, website, settings):
    from apps.agent.services import measured

    settings.INSIGHTS_ENABLED = False
    assert measured.page_signals(website, "https://northwind.example/") == []
    assert measured.correction_claim(website, "k|contradicted") is None
    assert measured.perception(website)["themes"] == []
    settings.INSIGHTS_ENABLED = True

    def boom(*args, **kwargs):
        raise RuntimeError("down")

    monkeypatch.setattr("apps.insights.services.pages.page_row", boom)
    monkeypatch.setattr("apps.insights.services.competitors.build", boom)
    assert measured.page_signals(website, "https://northwind.example/") == []
    assert measured.competitor_benchmark(website, {"name": "Evernote",
                                                   "domain": "evernote.com"}) is None


def test_the_benchmark_keeps_both_sides_of_one_competitor():
    from apps.agent.services.measured import _benchmark

    payload = {
        "brands": [{"key": "you", "name": "Northwind", "domain": "northwind.example",
                    "is_you": True},
                   {"key": "b1", "name": "Evernote", "domain": "evernote.com", "is_you": False}],
        "ai": {"answers": 120, "brands": {
            "you": {"named": 40, "visibility_pct": 33.3, "avg_rank": 2.4, "first_place": 12,
                    "series": [40.0]},
            "b1": {"named": 20, "visibility_pct": 16.7, "avg_rank": 3.1, "first_place": 2,
                   "series": [10.0]}}},
        "head_to_head": [{"key": "b1", "both_named": 25, "you_ahead": 10, "they_ahead": 13,
                          "no_order": 2}],
        "citations": {"has_data": False, "brands": None},
        "google": {"configured": True, "prompts_checked": 0, "brands": None},
        "by_prompt": [{"prompt_id": PID, "text": "best notes app", "answers": 12,
                       "ai": {"you": 25.0, "b1": 50.0}, "google_state": "not_checked",
                       "google": None}],
        "site": {"you": {"checks_passed": 7}, "b1": None},
    }
    bench = _benchmark(payload, {"name": "Evernote", "domain": "www.evernote.com"})
    assert bench["named"] == {
        "you": {"named": 40, "visibility_pct": 33.3, "avg_rank": 2.4, "first_place": 12},
        "competitor": {"named": 20, "visibility_pct": 16.7, "avg_rank": 3.1, "first_place": 2}}
    assert bench["head_to_head"] == {"both_named": 25, "you_ahead": 10, "they_ahead": 13,
                                     "no_order": 2}
    assert bench["citations"] is None and bench["google"] is None
    assert bench["prompts"] == [{"prompt": "best notes app", "answers": 12,
                                 "named_pct": {"you": 25.0, "competitor": 50.0},
                                 "google": None}]
    assert _benchmark(payload, {"name": "Obsidian", "domain": "obsidian.md"}) is None


@pytest.mark.django_db
def test_site_pages_are_the_sites_own_pages_once(website, user, settings):
    from apps.agent.services import measured
    from apps.agent.services.context import create_entry
    from apps.agent.subagents.sourcing import SourcePage

    settings.INSIGHTS_ENABLED = False
    create_entry(website, user, section="offerings", title="Fleet packs", references=[
        {"kind": "page", "url": "https://northwind.example/fleet"}])
    home = SourcePage(id="p1", url="https://northwind.example",
                      final_url="https://northwind.example/", title="Northwind", text="",
                      state="ok", status_code=200, words=0,
                      links=[{"url": "https://www.northwind.example/pricing", "text": "Pricing"},
                             {"url": "https://northwind.example/pricing/", "text": "Prices"},
                             {"url": "https://elsewhere.example/", "text": "Partner"},
                             {"url": "https://northwind.example/fleet", "text": ""}])
    assert measured.site_pages(website, home=home) == [
        {"url": "https://northwind.example/", "title": "Northwind"},
        {"url": "https://www.northwind.example/pricing", "title": "Pricing"},
        {"url": "https://northwind.example/fleet", "title": "Fleet packs"},
    ]
