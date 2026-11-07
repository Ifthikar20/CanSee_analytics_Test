"""robots.txt as RFC 9309 reads it (p2 backend 5a): parsing, group choice,
rule matching and the fetch states. Nothing reaches the network:
``safe_get`` is replaced."""

from types import SimpleNamespace

import pytest

from apps.insights.services import robots
from core.validators.safe_http import FetchError


def allowed(text: str, token: str, path: str) -> bool:
    _agents, rules = robots.rules_for(robots.parse(text), token)
    return robots.is_allowed(rules, path)[0]


# ── parsing and groups ────────────────────────────────────────────────────


def test_the_product_token_matches_case_insensitively_and_ignores_versions():
    text = "User-agent: gptbot/1.2\nDisallow: /private\n"

    assert not allowed(text, "GPTBot", "/private/x")
    assert allowed(text, "ClaudeBot", "/private/x")
    agents, _rules = robots.rules_for(robots.parse(text), "GPTBot")
    assert agents == ["gptbot/1.2"]


def test_every_group_naming_the_token_is_combined():
    text = (
        "User-agent: GPTBot\nDisallow: /a\n\n"
        "User-agent: *\nDisallow: /\n\n"
        "User-agent: GPTBot\nDisallow: /b\n"
    )

    assert not allowed(text, "GPTBot", "/a")
    assert not allowed(text, "GPTBot", "/b")
    # The * group does not apply once a group names the bot.
    assert allowed(text, "GPTBot", "/c")


def test_consecutive_user_agents_share_one_group():
    text = "User-agent: GPTBot\n\nUser-agent: ClaudeBot\nDisallow: /\n"

    parsed = robots.parse(text)
    assert len(parsed.groups) == 1 and parsed.groups[0].agents == ["GPTBot", "ClaudeBot"]
    assert not allowed(text, "GPTBot", "/") and not allowed(text, "ClaudeBot", "/")


def test_star_groups_apply_when_no_group_names_the_bot():
    text = "User-agent: *\nDisallow: /tmp\nUser-agent: *\nDisallow: /cgi\n"

    assert not allowed(text, "CCBot", "/tmp/x") and not allowed(text, "CCBot", "/cgi")
    assert robots.rules_for(robots.parse(text), "CCBot")[0] == ["*"]


def test_no_matching_group_allows_everything():
    text = "User-agent: Googlebot\nDisallow: /\n"

    assert allowed(text, "GPTBot", "/anything")
    assert robots.rules_for(robots.parse(text), "GPTBot") == ([], [])


def test_rules_before_any_user_agent_are_ignored():
    text = "Disallow: /\nUser-agent: *\nAllow: /x\n"

    assert allowed(text, "GPTBot", "/")


def test_comments_empty_rules_unknown_lines_and_sitemaps():
    text = (
        "# a comment\nSitemap: https://example.com/sitemap.xml\n"
        "User-agent: * # everyone\nDisallow:\nDisallow: /secret # hidden\n"
        "Crawl-delay: 10\nnonsense line\nSitemap: https://example.com/news.xml\n"
    )

    parsed = robots.parse(text)
    assert parsed.sitemaps == ["https://example.com/sitemap.xml", "https://example.com/news.xml"]
    assert parsed.groups[0].rules == [("disallow", "/secret")]
    assert allowed(text, "GPTBot", "/") and not allowed(text, "GPTBot", "/secret")


def test_a_byte_order_mark_and_carriage_returns_are_read():
    text = "﻿User-agent: *\r\nDisallow: /a\rDisallow: /b\r\n"

    assert not allowed(text, "GPTBot", "/a") and not allowed(text, "GPTBot", "/b")


def test_only_the_first_512000_bytes_are_parsed():
    filler = "# " + "x" * (robots.MAX_BYTES - 40) + "\n"
    text = "User-agent: *\nDisallow: /early\n" + filler + "Disallow: /late\n"

    assert len(text.encode()) > robots.MAX_BYTES
    assert not allowed(text, "GPTBot", "/early")
    assert allowed(text, "GPTBot", "/late")


# ── rule matching ─────────────────────────────────────────────────────────


def test_the_longest_match_wins():
    text = "User-agent: *\nDisallow: /a\nAllow: /a/b\n"

    assert allowed(text, "GPTBot", "/a/b/c")
    assert not allowed(text, "GPTBot", "/a/x")


def test_allow_wins_a_tie():
    text = "User-agent: *\nDisallow: /page\nAllow: /page\n"

    assert allowed(text, "GPTBot", "/page")


def test_wildcards_and_the_end_anchor():
    text = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=\n"

    assert not allowed(text, "GPTBot", "/files/report.pdf")
    assert allowed(text, "GPTBot", "/files/report.pdf?download=1")
    assert allowed(text, "GPTBot", "/files/report.pdfx")
    assert not allowed(text, "GPTBot", "/search/results?q=notes")


def test_paths_include_the_query():
    text = "User-agent: *\nDisallow: /*?\n"

    assert not allowed(text, "GPTBot", robots.url_path("https://example.com/p?x=1"))
    assert allowed(text, "GPTBot", robots.url_path("https://example.com/p"))
    assert robots.url_path("https://example.com") == "/"


def test_percent_encoding_is_normalized_on_both_sides():
    text = "User-agent: *\nDisallow: /caf%c3%a9\nDisallow: /%7Ejoe\nDisallow: /a%2fb\n"

    assert not allowed(text, "GPTBot", "/café/menu")
    assert not allowed(text, "GPTBot", "/~joe/page")
    assert not allowed(text, "GPTBot", "/a%2Fb")
    # An encoded slash is not the same path as a real one.
    assert allowed(text, "GPTBot", "/a/b")


def test_robots_txt_itself_is_always_allowed():
    text = "User-agent: *\nDisallow: /\n"

    assert allowed(text, "GPTBot", "/robots.txt")
    assert not allowed(text, "GPTBot", "/robots.txt.bak")


def test_the_deciding_rule_is_reported_as_written():
    _agents, rules = robots.rules_for(
        robots.parse("User-agent: *\nDisallow: /private\nAllow: /private/open\n"), "GPTBot",
    )

    assert robots.is_allowed(rules, "/private/x") == (False, "Disallow: /private")
    assert robots.is_allowed(rules, "/private/open/y") == (True, "Allow: /private/open")
    assert robots.is_allowed(rules, "/public") == (True, None)


# ── fetch states ──────────────────────────────────────────────────────────


def response(status: int, body: bytes = b"", content_type: str = "text/plain"):
    return SimpleNamespace(status_code=status, content=body, content_type=content_type,
                           headers={"Content-Type": content_type}, final_url="https://example.com/robots.txt")


@pytest.fixture
def fetched(monkeypatch):
    calls = []

    def fake(answer):
        def safe_get(url, **kwargs):
            calls.append((url, kwargs))
            if isinstance(answer, Exception):
                raise answer
            return answer

        monkeypatch.setattr(robots, "safe_get", safe_get)
        return robots.fetch("https://example.com")

    fake.calls = calls
    return fake


def test_a_2xx_file_is_found_and_parsed(fetched):
    body = b"User-agent: *\nDisallow: /x\nSitemap: https://example.com/s.xml\n"

    result = fetched(response(200, body))

    assert result.info == {"state": "found", "url": "https://example.com/robots.txt",
                           "status_code": 200, "groups": 1, "sitemaps": 1, "bytes": len(body)}
    assert result.robots is not None and result.text == body.decode()
    url, kwargs = fetched.calls[0]
    assert url == "https://example.com/robots.txt"
    assert (kwargs["max_bytes"], kwargs["truncate"], kwargs["max_redirects"]) == (512_000, True, 5)
    assert kwargs["allowed_content_types"] == ()
    assert kwargs["allowed_ports"] == (80, 443, 8080, 8443)
    assert kwargs["deadline"] == 10 and kwargs["timeout"] == (5, 10)
    assert "CanseeAgent" in kwargs["headers"]["User-Agent"]


def test_a_4xx_file_is_missing(fetched):
    result = fetched(response(404, b"<html>Not found</html>", "text/html"))

    assert (result.state, result.info["status_code"], result.robots) == ("missing", 404, None)
    assert result.info["groups"] is None


@pytest.mark.parametrize("answer", [
    response(503),
    FetchError("timed out", code="timeout"),
    FetchError("connection refused", code="fetch_failed"),
])
def test_server_errors_and_network_errors_are_unreachable(fetched, answer):
    assert fetched(answer).state == "unreachable"


def test_more_than_five_redirects_reads_as_missing(fetched):
    assert fetched(FetchError(robots.TOO_MANY_REDIRECTS, code="fetch_failed")).state == "missing"


def test_an_address_cansee_may_not_fetch_is_failed(fetched):
    result = fetched(FetchError("unsafe URL: private address", code="blocked_url"))

    assert result.info == {"state": "failed", "url": "https://example.com/robots.txt",
                           "status_code": None, "groups": None, "sitemaps": None, "bytes": None}
