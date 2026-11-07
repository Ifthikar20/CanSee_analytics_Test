"""llms.txt and llms-full.txt (p2 backend 5b): found, invalid, missing and
failed, the parsed counts, and pages that answer every address with HTML.
``safe_get`` is replaced; nothing reaches the network."""

from types import SimpleNamespace

import pytest

from apps.insights.services import llms_txt
from core.validators.safe_http import FetchError

LLMS = (
    "# Notion\n\n> The connected workspace.\n\n"
    "## Docs\n- [Guide](https://notion.so/guide): getting started\n"
    "- [API](https://developers.notion.com/)\n"
    "Plain text with [a link](https://notion.so/x) is not a list item.\n\n"
    "## Optional\n* [Blog](https://notion.so/blog)\n"
)


def response(status: int, body: str = "", content_type: str = "text/plain"):
    return SimpleNamespace(status_code=status, content=body.encode(), content_type=content_type,
                           headers={"Content-Type": content_type})


@pytest.fixture
def site(monkeypatch):
    """Answers /llms.txt and /llms-full.txt from a dict; records each call."""
    answers: dict = {}
    calls: list = []

    def safe_get(url, **kwargs):
        calls.append((url, kwargs))
        answer = answers.get(url.rsplit("/", 1)[-1], response(404))
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(llms_txt, "safe_get", safe_get)
    return SimpleNamespace(answers=answers, calls=calls)


def test_a_file_with_a_title_line_is_found_with_its_counts(site):
    site.answers["llms.txt"] = response(200, "﻿\n\n" + LLMS)
    site.answers["llms-full.txt"] = response(200, "#")

    result = llms_txt.fetch("https://notion.so/")

    assert result == {"state": "found", "url": "https://notion.so/llms.txt", "status_code": 200,
                      "title": "Notion", "sections": 2, "links": 3, "full": "found"}
    (url, main), (full_url, full) = site.calls
    assert (url, main["max_bytes"], main["truncate"]) == ("https://notion.so/llms.txt", 200_000, True)
    assert main["allowed_content_types"] == () and "CanseeAgent" in main["headers"]["User-Agent"]
    assert (full_url, full["max_bytes"], full["truncate"]) == (
        "https://notion.so/llms-full.txt", 1, True)


def test_the_title_is_clipped():
    assert llms_txt.parse("# " + "T" * 200)["title"] == "T" * llms_txt.MAX_TITLE


def test_a_file_without_the_title_line_is_invalid(site):
    site.answers["llms.txt"] = response(200, "Notion\n## Docs\n- [Guide](https://notion.so/g)\n")

    result = llms_txt.fetch("https://notion.so")

    assert (result["state"], result["title"], result["sections"], result["links"]) == (
        "invalid", None, None, None)
    assert result["full"] == "missing"


def test_a_4xx_is_missing(site):
    result = llms_txt.fetch("https://notion.so")

    assert (result["state"], result["status_code"], result["full"]) == ("missing", 404, "missing")


def test_an_html_page_for_every_address_is_no_llms_txt(site):
    page = "<!doctype html><html><head><title>Notion</title></head><body># Not this</body></html>"
    site.answers["llms.txt"] = response(200, page, "text/html")
    site.answers["llms-full.txt"] = response(200, "<", "text/html")

    result = llms_txt.fetch("https://notion.so")

    assert (result["state"], result["full"]) == ("missing", "missing")


def test_an_html_body_served_as_text_is_missing_too(site):
    site.answers["llms.txt"] = response(200, "<!DOCTYPE html>\n<html><body>hi</body></html>")

    assert llms_txt.fetch("https://notion.so")["state"] == "missing"


@pytest.mark.parametrize("answer", [
    response(500), response(302),
    FetchError("timed out", code="timeout"),
    FetchError("unsafe URL", code="blocked_url"),
])
def test_other_answers_are_failed(site, answer):
    site.answers["llms.txt"] = answer
    site.answers["llms-full.txt"] = answer

    result = llms_txt.fetch("https://notion.so")

    assert (result["state"], result["full"]) == ("failed", "failed")
    assert result["title"] is None
