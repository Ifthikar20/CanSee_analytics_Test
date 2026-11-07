"""browse.fetch_page's ``with_headers`` and ``with_links`` (p2 backend 2c):
the response headers the crawler audit reads, and every link of the
document, menus, header and footer included. Existing callers get the
result they always got. ``safe_get`` is replaced; nothing reaches the
network."""

from types import SimpleNamespace

import pytest

from apps.agent.services import browse
from core.validators.safe_http import FetchError

PAGE = """<!doctype html><html><head><title>Notion</title></head><body>
<header><a href="/">Home</a><a href="https://notion.so/pricing#plans">Pricing</a></header>
<nav><a href="/about">About</a><a href="/about#team">Team</a>
  <a href="/product" aria-label="Product tour"><svg></svg></a>
  <a href="/docs" title="Documentation"></a></nav>
<main><h1>Write, plan, share</h1><p>Text <a href="https://evernote.com/x">a rival</a>.</p>
  <a href="mailto:hi@notion.so">Mail</a><a href="javascript:void(0)">Nothing</a>
  <a href="#top">Top</a></main>
<footer><a href="/security">Security</a><a href="/pricing">Pricing again</a></footer>
</body></html>"""


def response(body: str = PAGE, headers: dict | None = None, content_type: str = "text/html",
             status: int = 200):
    headers = {"Content-Type": f"{content_type}; charset=utf-8", **(headers or {})}
    return SimpleNamespace(status_code=status, final_url="https://notion.so/", headers=headers,
                           content_type=content_type, content=body.encode())


@pytest.fixture
def serve(monkeypatch):
    def install(answer):
        def safe_get(url, **kwargs):
            if isinstance(answer, Exception):
                raise answer
            return answer

        monkeypatch.setattr(browse, "safe_get", safe_get)

    return install


def test_existing_callers_get_neither_key(serve):
    serve(response())

    result = browse.fetch_page("https://notion.so/")

    assert result["error"] is None
    assert "headers" not in result and "links" not in result


def test_links_cover_the_whole_document_in_order(serve):
    serve(response())

    links = browse.fetch_page("https://notion.so/", with_links=True)["links"]

    assert links == [
        {"url": "https://notion.so/", "text": "Home"},
        {"url": "https://notion.so/pricing", "text": "Pricing"},
        {"url": "https://notion.so/about", "text": "About"},
        {"url": "https://notion.so/product", "text": "Product tour"},
        {"url": "https://notion.so/docs", "text": "Documentation"},
        {"url": "https://evernote.com/x", "text": "a rival"},
        {"url": "https://notion.so/security", "text": "Security"},
    ]
    # The reader view still leaves the menu out.
    reader = browse.fetch_page("https://notion.so/")["reader"]["links"]
    assert all("about" not in link["href"] for link in reader)


def test_links_are_capped_and_their_text_clipped(serve):
    anchors = "".join(f'<a href="/p{i}">{"word " * 40}</a>' for i in range(400))
    serve(response(f"<html><body>{anchors}</body></html>"))

    links = browse.fetch_page("https://notion.so/", with_links=True)["links"]

    assert len(links) == browse.MAX_DOCUMENT_LINKS == 300
    assert all(len(link["text"]) <= 120 for link in links)
    assert links[0]["url"] == "https://notion.so/p0"


def test_headers_are_read_lower_cased_and_clipped(serve):
    serve(response(headers={"X-Robots-Tag": "GPTBot: noindex, " + "x" * 400}))

    headers = browse.fetch_page("https://notion.so/", with_headers=True)["headers"]

    assert set(headers) == {"x-robots-tag", "content-type"}
    assert headers["x-robots-tag"].startswith("GPTBot: noindex, ")
    assert len(headers["x-robots-tag"]) == 300
    assert headers["content-type"] == "text/html; charset=utf-8"


def test_a_missing_header_is_an_empty_string(serve):
    serve(response())

    assert browse.fetch_page("https://notion.so/", with_headers=True)["headers"]["x-robots-tag"] == ""


def test_a_failed_fetch_still_answers_both_keys(serve):
    serve(FetchError("timed out", code="timeout"))

    result = browse.fetch_page("https://notion.so/", with_headers=True, with_links=True)

    assert result["error"]["code"] == "timeout"
    assert result["headers"] == {"x-robots-tag": "", "content-type": ""}
    assert result["links"] == []


def test_a_page_that_is_not_html_keeps_its_headers(serve):
    serve(response("%PDF-1.7", headers={"X-Robots-Tag": "noindex"}, content_type="application/pdf"))

    result = browse.fetch_page("https://notion.so/a.pdf", with_headers=True, with_links=True)

    assert result["error"]["code"] == "not_html"
    assert result["headers"]["x-robots-tag"] == "noindex"
    assert result["links"] == []


def test_an_error_status_page_is_parsed_with_its_links(serve):
    serve(response('<html><body><a href="/">Back home</a></body></html>', status=404))

    result = browse.fetch_page("https://notion.so/gone", with_links=True)

    assert (result["status_code"], result["error"]) == (404, None)
    assert result["links"] == [{"url": "https://notion.so/", "text": "Back home"}]
