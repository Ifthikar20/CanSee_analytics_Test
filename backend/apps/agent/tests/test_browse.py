"""Browse service and endpoint: SEO facts, reader view, framing, errors.

HTTP is mocked with ``responses``; DNS is pinned so hostnames resolve to a
public address (IP literals keep their own address).
"""
import ipaddress

import pytest
import requests
import responses
from bs4 import BeautifulSoup
from django.core.cache import cache
from django.test import override_settings
from freezegun import freeze_time

from apps.agent.services import browse
from apps.agent.services.browse import fetch_page, is_frameable, reader_view
from apps.agent.tests.api_support import (
    client_for,
    data,
    error,
    join_org,
    make_user,
    stand_in_missing_live_modules,
)

stand_in_missing_live_modules()

PAGE_URL = "https://www.northwind.test/batteries"
HTML = """<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>  Northwind Batteries | Fleet power  </title>
<meta name="Description" content="48V packs for delivery fleets.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="/batteries">
<link rel="alternate" hreflang="de" href="/de/batteries">
<link rel="alternate" hreflang="x-default" href="https://www.northwind.test/batteries">
<meta property="og:title" content="Northwind fleet batteries">
<meta property="og:description" content="Packs for fleets">
<meta property="og:image" content="/img/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","name":"Northwind"},{"@type":["WebPage","FAQPage"]}]}</script>
<script type="application/ld+json">[{"@type":"Product"},{"@type":"http://schema.org/Offer"}]</script>
<script type="application/ld+json">{not json</script>
<style>.x { color: red }</style>
</head>
<body>
<header><nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav><h1>Site banner</h1></header>
<main>
<h1>Fleet batteries</h1>
<p>Our <strong>48V</strong> packs power <a href="/fleet">delivery fleets</a>.</p>
<div>Loose text in a div.</div>
<h2>Why Northwind</h2>
<ul><li>Two-year warranty</li><li>Swap in <em>minutes</em></li></ul>
<ol><li>Order</li><li>Install</li></ol>
<blockquote>Best batteries we tried.</blockquote>
<pre>  code line 1
  code line 2</pre>
<table><tr><th>Model</th><th>Range</th></tr><tr><td>NW-48</td><td>80 km</td></tr></table>
<h2>FAQ</h2>
<p hidden>Hidden text</p>
<div style="display: none">Also hidden</div>
<img src="/a.png" alt="Battery pack"><img src="/b.png"><img src="/c.png" alt="  ">
<p>See <a href="https://other.example/review">an independent review</a> and <a href="#top">top</a>.</p>
<aside>Related posts</aside>
<script>var x = "script text";</script>
</main>
<footer><a href="/privacy">Privacy</a> Copyright</footer>
</body>
</html>
"""


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    """Every hostname resolves to one public address; IP literals to themselves."""
    def resolve(hostname):
        try:
            return [ipaddress.ip_address(hostname.strip("[]"))]
        except ValueError:
            return [ipaddress.ip_address("93.184.216.34")]

    monkeypatch.setattr("core.validators.url_safety._resolve_addresses", resolve)


@pytest.fixture
def mocked():
    with responses.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        yield rsps


def html_response(rsps, url=PAGE_URL, body=HTML, status=200, headers=None,
                  content_type="text/html; charset=utf-8"):
    rsps.add(responses.GET, url, body=body, status=status, headers=headers or {},
             content_type=content_type)


# ── a page that loads ─────────────────────────────────────────────────────


def test_fetch_page_returns_seo_facts_reader_and_frameability(mocked):
    html_response(mocked)
    result = fetch_page(PAGE_URL)

    assert result["error"] is None
    assert (result["url"], result["final_url"], result["status_code"]) == (PAGE_URL, PAGE_URL, 200)
    assert result["frameable"] is True
    assert result["title"] == "Northwind Batteries | Fleet power"
    assert result["captured_at"].endswith("Z")

    seo = result["seo"]
    assert seo["title"] == "Northwind Batteries | Fleet power" and seo["title_length"] == 33
    assert seo["meta_description"] == "48V packs for delivery fleets."
    assert seo["meta_description_length"] == 30
    assert seo["canonical"] == "https://www.northwind.test/batteries"
    assert seo["robots"] == "index, follow"
    assert seo["lang"] == "en-GB"
    assert seo["h1"] == ["Site banner", "Fleet batteries"]
    assert seo["h2"] == ["Why Northwind", "FAQ"]
    assert seo["word_count"] == 56
    assert seo["links"] == {"internal": 5, "external": 1}
    assert seo["images"] == {"count": 3, "missing_alt": 2}
    assert seo["structured_data"] == ["Organization", "WebPage", "FAQPage", "Product", "Offer"]
    assert seo["open_graph"] == {
        "title": "Northwind fleet batteries", "description": "Packs for fleets",
        "image": "https://www.northwind.test/img/og.png",
    }
    assert seo["hreflang"] == [
        {"lang": "de", "url": "https://www.northwind.test/de/batteries"},
        {"lang": "x-default", "url": "https://www.northwind.test/batteries"},
    ]
    assert seo["bytes"] == len(HTML.encode())
    assert isinstance(seo["fetch_ms"], int)

    reader = result["reader"]
    assert reader["title"] == "Northwind Batteries | Fleet power"
    assert reader["blocks"] == [
        {"type": "heading", "level": 1, "text": "Fleet batteries"},
        {"type": "paragraph", "text": "Our 48V packs power delivery fleets."},
        {"type": "paragraph", "text": "Loose text in a div."},
        {"type": "heading", "level": 2, "text": "Why Northwind"},
        {"type": "list", "ordered": False, "items": ["Two-year warranty", "Swap in minutes"]},
        {"type": "list", "ordered": True, "items": ["Order", "Install"]},
        {"type": "quote", "text": "Best batteries we tried."},
        {"type": "code", "text": "  code line 1\n  code line 2"},
        {"type": "table", "rows": [["Model", "Range"], ["NW-48", "80 km"]]},
        {"type": "heading", "level": 2, "text": "FAQ"},
        {"type": "paragraph", "text": "See an independent review and top."},
    ]
    assert reader["links"] == [
        {"text": "delivery fleets", "href": "https://www.northwind.test/fleet"},
        {"text": "an independent review", "href": "https://other.example/review"},
    ]


def test_sent_headers_identify_the_fetcher(mocked):
    html_response(mocked)
    fetch_page(PAGE_URL)
    sent = mocked.calls[0].request.headers
    assert sent["User-Agent"].startswith("Mozilla/5.0 (compatible; CanseeAgent/1.0")
    assert "text/html" in sent["Accept"]
    assert "Cookie" not in sent


def test_reader_keeps_an_articles_own_header_and_drops_the_page_chrome():
    soup = BeautifulSoup(
        "<body><header><p>Menu</p></header><article><header><h1>Post title</h1></header>"
        "<p>Body text.</p><footer><p>By Ann</p></footer></article>"
        "<footer><p>Site footer</p></footer></body>",
        "html.parser",
    )
    blocks = reader_view(soup, PAGE_URL)["blocks"]
    assert blocks == [
        {"type": "heading", "level": 1, "text": "Post title"},
        {"type": "paragraph", "text": "Body text."},
        {"type": "paragraph", "text": "By Ann"},
    ]


def test_reader_caps_blocks_and_survives_deep_nesting():
    many = BeautifulSoup("<body>" + "<p>x</p>" * 500 + "</body>", "html.parser")
    assert len(reader_view(many, PAGE_URL)["blocks"]) == browse.MAX_READER_BLOCKS
    deep = BeautifulSoup("<body>" + "<div>" * 3000 + "<p>deep</p>" + "</div>" * 3000 + "</body>",
                         "html.parser")
    assert reader_view(deep, PAGE_URL)["blocks"] == [{"type": "paragraph", "text": "deep"}]


def test_layout_tables_are_read_as_content():
    soup = BeautifulSoup(
        "<body><table><tr><td><h2>Section</h2><p>Text in a layout table.</p></td></tr></table>"
        "</body>",
        "html.parser",
    )
    assert reader_view(soup, PAGE_URL)["blocks"] == [
        {"type": "heading", "level": 2, "text": "Section"},
        {"type": "paragraph", "text": "Text in a layout table."},
    ]


def test_charset_from_header_or_meta(mocked):
    body = "<html><head><title>Café crème</title></head><body><p>ok</p></body></html>"
    html_response(mocked, body=body.encode("cp1252"), content_type="text/html; charset=cp1252")
    assert fetch_page(PAGE_URL)["title"] == "Café crème"

    other = "https://www.northwind.test/meta"
    meta_body = (
        '<html><head><meta charset="utf-8"><title>Café</title></head><body></body></html>'
    )
    html_response(mocked, url=other, body=meta_body.encode("utf-8"), content_type="text/html")
    assert fetch_page(other)["title"] == "Café"


def test_missing_content_type_is_sniffed(mocked):
    html_response(mocked, body="<!DOCTYPE html><html><title>Sniffed</title></html>",
                  content_type=None)
    assert fetch_page(PAGE_URL)["title"] == "Sniffed"
    pdf = "https://www.northwind.test/file"
    mocked.add(responses.GET, pdf, body=b"%PDF-1.7 binary", content_type=None)
    assert fetch_page(pdf)["error"]["code"] == "not_html"


def test_an_http_error_page_is_still_read(mocked):
    html_response(mocked, status=404, body="<html><title>Not found</title><p>Gone</p></html>")
    result = fetch_page(PAGE_URL)
    assert result["error"] is None
    assert result["status_code"] == 404
    assert result["seo"]["title"] == "Not found"


# ── framing ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("url, headers, expected", [
    ("https://a.test/", {}, True),
    ("http://a.test/", {}, False),
    ("https://a.test/", {"X-Frame-Options": "DENY"}, False),
    ("https://a.test/", {"x-frame-options": "sameorigin"}, False),
    ("https://a.test/", {"X-Frame-Options": "ALLOW-FROM https://cansee.ai"}, True),
    ("https://a.test/", {"Content-Security-Policy": "frame-ancestors 'none'"}, False),
    ("https://a.test/", {"Content-Security-Policy": "frame-ancestors 'self'"}, False),
    ("https://a.test/", {"Content-Security-Policy": "default-src 'self'; frame-ancestors *",
                         "X-Frame-Options": "DENY"}, True),
    ("https://a.test/", {"Content-Security-Policy": "frame-ancestors https:"}, True),
    ("https://a.test/", {"Content-Security-Policy": "frame-ancestors https://partner.test"},
     False),
    ("https://a.test/", {"Content-Security-Policy": "default-src 'self'",
                         "X-Frame-Options": "SAMEORIGIN"}, False),
    ("https://a.test/", {"Content-Security-Policy": "default-src 'self'"}, True),
    ("https://a.test/", {"Content-Security-Policy": "frame-ancestors *, frame-ancestors 'self'"},
     False),
])
def test_frameable_table(url, headers, expected):
    assert is_frameable(url, headers) is expected


def test_framing_headers_come_from_the_final_response(mocked):
    html_response(mocked, headers={"X-Frame-Options": "DENY"})
    assert fetch_page(PAGE_URL)["frameable"] is False


# ── failures come back inside the result ──────────────────────────────────


@pytest.mark.parametrize("url", [
    "http://100.64.0.1/",          # carrier-grade NAT: not global
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:10.0.0.1]/",
    "https://www.northwind.test:8000/",  # port outside 80/443/8080/8443
    "ftp://www.northwind.test/file",
    "javascript:alert(1)",
])
def test_blocked_urls(url, mocked):
    result = fetch_page(url)
    assert result["error"]["code"] == "blocked_url"
    assert "only public web pages" in result["error"]["message"]
    assert (result["seo"], result["reader"], result["frameable"]) == (None, None, False)
    assert len(mocked.calls) == 0


def test_allowed_alternative_ports(mocked):
    html_response(mocked, url="https://www.northwind.test:8443/x")
    assert fetch_page("https://www.northwind.test:8443/x")["error"] is None


def test_redirects_are_followed_and_revalidated(mocked):
    mocked.add(responses.GET, PAGE_URL, status=301,
               headers={"Location": "https://cdn.northwind.test/batteries"})
    html_response(mocked, url="https://cdn.northwind.test/batteries")
    result = fetch_page(PAGE_URL)
    assert result["error"] is None
    assert result["final_url"] == "https://cdn.northwind.test/batteries"

    evil = "https://evil.test/start"
    mocked.add(responses.GET, evil, status=302,
               headers={"Location": "http://169.254.169.254/latest/meta-data/"})
    assert fetch_page(evil)["error"]["code"] == "blocked_url"

    sideways = "https://evil.test/port"
    mocked.add(responses.GET, sideways, status=302,
               headers={"Location": "https://www.northwind.test:6379/"})
    assert fetch_page(sideways)["error"]["code"] == "blocked_url"


def test_not_html(mocked):
    mocked.add(responses.GET, PAGE_URL, body=b"%PDF", content_type="application/pdf")
    result = fetch_page(PAGE_URL)
    assert result["error"] == {"code": "not_html", "message": "This address is not a web page."}


def test_too_large(mocked):
    html_response(mocked, body="<p>" + "x" * browse.MAX_BYTES + "</p>")
    assert fetch_page(PAGE_URL)["error"]["code"] == "too_large"


def test_network_failure_and_timeout(mocked):
    mocked.add(responses.GET, PAGE_URL, body=requests.exceptions.ConnectionError("refused"))
    assert fetch_page(PAGE_URL)["error"]["code"] == "fetch_failed"
    slow = "https://www.northwind.test/slow"
    mocked.add(responses.GET, slow, body=requests.exceptions.ReadTimeout("read timed out"))
    result = fetch_page(slow)
    assert result["error"] == {
        "code": "timeout", "message": "The page took longer than 12 seconds to load.",
    }


# ── the endpoint ──────────────────────────────────────────────────────────


@pytest.fixture
def browse_url(website):
    return f"/api/v1/agent/live/websites/{website.id}/browse/"


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.mark.django_db
def test_endpoint_returns_the_browse_result(user, browse_url, mocked):
    html_response(mocked)
    resp = client_for(user).post(browse_url, {"url": PAGE_URL}, format="json")
    assert resp.status_code == 200
    assert data(resp)["seo"]["title"] == "Northwind Batteries | Fleet power"


@pytest.mark.django_db
def test_endpoint_reports_fetch_errors_with_200(user, browse_url, mocked):
    resp = client_for(user).post(browse_url, {"url": "http://10.0.0.1/"}, format="json")
    assert resp.status_code == 200
    assert data(resp)["error"]["code"] == "blocked_url"


@pytest.mark.django_db
def test_endpoint_validates_input(user, browse_url):
    resp = client_for(user).post(browse_url, {}, format="json")
    assert resp.status_code == 400 and error(resp)["code"] == "invalid"


@pytest.mark.django_db
@override_settings(AGENT_PROCESS=False)
def test_endpoint_only_runs_in_the_agent_process(user, browse_url):
    resp = client_for(user).post(browse_url, {"url": PAGE_URL}, format="json")
    assert resp.status_code == 503
    assert error(resp)["code"] == "agent_unavailable"


@pytest.mark.django_db
@override_settings(AGENT_BROWSE_DAILY_LIMIT=2)
def test_endpoint_daily_limit(user, browse_url):
    api = client_for(user)
    for _ in range(2):
        assert api.post(browse_url, {"url": "http://10.0.0.1/"}, format="json").status_code == 200
    resp = api.post(browse_url, {"url": "http://10.0.0.1/"}, format="json")
    assert resp.status_code == 429
    assert error(resp)["code"] == "browse_limit_reached"


@pytest.mark.django_db
def test_endpoint_burst_limit(user, browse_url):
    api = client_for(user)
    # Frozen clock: the bucket cannot refill between requests.
    with freeze_time("2026-11-02 12:00:00"):
        codes = [
            api.post(browse_url, {"url": "http://10.0.0.1/"}, format="json").status_code
            for _ in range(31)
        ]
    assert codes[:30] == [200] * 30
    assert codes[30] == 429


@pytest.mark.django_db
def test_viewers_may_browse_but_outsiders_may_not(user, website, browse_url, django_user_model):
    viewer = make_user(django_user_model, "viewer@example.com")
    join_org(website, user, {viewer: "viewer"})
    ok = client_for(viewer).post(browse_url, {"url": "http://10.0.0.1/"}, format="json")
    assert ok.status_code == 200
    outsider = client_for(make_user(django_user_model, "outsider@example.com"))
    assert outsider.post(browse_url, {"url": PAGE_URL}, format="json").status_code == 404
