"""What one page may cost the agent process to read: tags counted before a
tree is built (in any encoding), a bounded number of parses at a time,
bounded heading reads, and the tree taken apart once read."""
import ipaddress
import threading

import pytest
import responses
from bs4 import BeautifulSoup

from apps.agent.services import browse
from apps.agent.services.browse import fetch_page

PAGE_URL = "https://www.northwind.test/page"


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr("core.validators.url_safety._resolve_addresses",
                        lambda host: [ipaddress.ip_address("93.184.216.34")])


@pytest.fixture
def mocked():
    with responses.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        yield rsps


def _page(rsps, body, content_type="text/html; charset=utf-8"):
    rsps.add(responses.GET, PAGE_URL, body=body, status=200, content_type=content_type)


def test_a_page_with_too_many_tags_is_refused_before_it_is_parsed(mocked, monkeypatch):
    monkeypatch.setattr(browse, "MAX_TAGS", 100)
    built = []
    real = browse.BeautifulSoup
    monkeypatch.setattr(browse, "BeautifulSoup", lambda *a, **k: built.append(1) or real(*a, **k))

    _page(mocked, "<html><body><p>" + "<b>w</b> " * 60 + "</p></body></html>")
    result = fetch_page(PAGE_URL)

    assert result["error"]["code"] == "too_complex"
    assert "too many to read here" in result["error"]["message"]
    assert (result["seo"], result["reader"], result["status_code"]) == (None, None, 200)
    assert built == []

    small = PAGE_URL + "?small"
    mocked.add(responses.GET, small, body="<html><body>" + "<b>w</b> " * 40 + "</body></html>",
               content_type="text/html")
    assert fetch_page(small)["error"] is None


def test_tags_are_counted_in_the_pages_own_encoding(mocked, monkeypatch):
    # UTF-16 hides every "<" from a count over the raw bytes.
    monkeypatch.setattr(browse, "MAX_TAGS", 100)
    body = ("<html><body>" + "<b>w</b> " * 60 + "</body></html>").encode("utf-16")
    _page(mocked, body, content_type="text/html; charset=utf-16")

    assert fetch_page(PAGE_URL)["error"]["code"] == "too_complex"


def test_parses_wait_for_a_free_slot_and_give_up_politely(mocked, monkeypatch):
    monkeypatch.setattr(browse, "PARSE_WAIT_SECONDS", 0.05)
    _page(mocked, "<html><title>Busy</title><body><p>x</p></body></html>")
    taken = [browse._parse_slots.acquire(timeout=1) for _ in range(browse.PARSE_SLOTS)]
    try:
        assert all(taken)
        result = fetch_page(PAGE_URL)
        assert result["error"]["code"] == "busy"
        assert result["seo"] is None
    finally:
        for _ in taken:
            browse._parse_slots.release()
    assert fetch_page(PAGE_URL)["seo"]["title"] == "Busy"


def test_the_slot_comes_back_and_the_tree_is_taken_apart(mocked, monkeypatch):
    decomposed = []
    real = BeautifulSoup.decompose
    monkeypatch.setattr(BeautifulSoup, "decompose",
                        lambda self: decomposed.append(1) or real(self))
    _page(mocked, "<html><title>Ok</title><body><h1>Hi</h1></body></html>")

    assert fetch_page(PAGE_URL)["seo"]["h1"] == ["Hi"]
    assert decomposed == [1]

    def broken(soup, base_url):
        raise RuntimeError("boom")

    monkeypatch.setattr(browse, "seo_facts", broken)
    with pytest.raises(RuntimeError):
        fetch_page(PAGE_URL)
    assert decomposed == [1, 1]
    # Every slot is free again: as many parses as there are slots can start.
    taken = [browse._parse_slots.acquire(timeout=0) for _ in range(browse.PARSE_SLOTS)]
    assert all(taken)
    for _ in taken:
        browse._parse_slots.release()


def test_nested_headings_do_not_each_reread_the_page(monkeypatch):
    # 60 h1, each inside the one before, over a page of empty elements:
    # every heading's text read in full would walk the whole page again.
    filler = "<i></i>" * 5000
    soup = BeautifulSoup("<body>" + "<h1>a" * 60 + filler + "</body>", "html.parser")
    visits = []
    real = browse._skipped
    monkeypatch.setattr(browse, "_skipped", lambda el, inside: visits.append(1) or real(el, inside))
    monkeypatch.setattr(browse, "MAX_HEADING_NODES", 200)

    headings = browse._texts(soup, "h1", browse.MAX_H1)

    assert len(headings) == browse.MAX_H1 and headings[0].startswith("a a a")
    assert len(visits) <= 60 * 200


def test_a_text_limit_gives_the_same_text_as_reading_everything():
    html = ("<div>  lead <b>bold</b>\n\n" + "<span> word </span>" * 2000
            + "<p hidden>gone</p><br>tail</div>")
    el = BeautifulSoup(html, "html.parser").div
    whole = browse._clean(browse._visible_text(el))
    for limit in (1, 7, 50, 300):
        part = browse._visible_text(el, limit=limit)
        assert browse._clean(part)[:limit] == whole[:limit]
        assert len(part) < len(browse._visible_text(el))
    code = BeautifulSoup("<pre>\n\n  a\x00b  \n" + "<span>tok </span>" * 3000 + "</pre>",
                         "html.parser").pre
    full = browse._strip_nul(browse._visible_text(code, keep_space=True)).strip("\n")
    cut = browse._strip_nul(browse._visible_text(code, keep_space=True, limit=40)).strip("\n")
    assert cut[:40] == full[:40]


def test_readers_in_threads_share_two_slots(mocked, monkeypatch):
    """At most PARSE_SLOTS pages are parsed at the same moment."""
    _page(mocked, "<html><body><p>x</p></body></html>")
    inside = []
    peak = []
    lock = threading.Lock()
    gate = threading.Event()
    real = browse.seo_facts

    def slow(soup, base_url):
        with lock:
            inside.append(1)
            peak.append(len(inside))
        gate.wait(1)
        with lock:
            inside.pop()
        return real(soup, base_url)

    monkeypatch.setattr(browse, "seo_facts", slow)
    threads = [threading.Thread(target=fetch_page, args=(PAGE_URL,)) for _ in range(5)]
    for t in threads:
        t.start()
    threading.Timer(0.3, gate.set).start()
    for t in threads:
        t.join(5)
    assert max(peak) <= browse.PARSE_SLOTS
