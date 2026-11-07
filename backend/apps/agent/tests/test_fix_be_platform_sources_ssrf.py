"""The sources service's SSRF guard matches core.validators (finding K3).

services/sources/{url_safety,safe_http}.py are Django-free copies of the
core modules. Every check here runs against both copies, so hardening
added to one and not the other fails the suite.
"""
import importlib
import inspect
import ipaddress
import time

import pytest
import requests
import responses

COPIES = {
    "core": ("core.validators.url_safety", "core.validators.safe_http"),
    "sources": ("services.sources.url_safety", "services.sources.safe_http"),
}


class Copy:
    def __init__(self, safety_path, http_path):
        self.safety_path = safety_path
        self.safety = importlib.import_module(safety_path)
        self.http = importlib.import_module(http_path)


@pytest.fixture(params=sorted(COPIES))
def copy(request):
    return Copy(*COPIES[request.param])


@pytest.fixture
def public_dns(copy, monkeypatch):
    def resolve(hostname):
        try:
            return [ipaddress.ip_address(hostname.strip("[]"))]
        except ValueError:
            return [ipaddress.ip_address("93.184.216.34")]

    monkeypatch.setattr(f"{copy.safety_path}._resolve_addresses", resolve)
    return copy


@pytest.fixture
def mocked(public_dns):
    with responses.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        yield public_dns, rsps


class FakeSocket:
    def __init__(self, peer):
        self.peer = peer
        self.closed = False

    def getpeername(self):
        if isinstance(self.peer, Exception):
            raise self.peer
        return self.peer

    def close(self):
        self.closed = True

    def shutdown(self, how):
        self.closed = True


def test_both_copies_expose_the_same_guard():
    core = Copy(*COPIES["core"])
    sources = Copy(*COPIES["sources"])
    for name in ("assert_url_safe", "is_url_safe", "assert_peer_public"):
        assert inspect.signature(getattr(core.safety, name)) == inspect.signature(
            getattr(sources.safety, name)
        ), name
    assert inspect.signature(core.http.safe_get) == inspect.signature(sources.http.safe_get)
    assert core.http.ALLOWED_CONTENT_TYPES == sources.http.ALLOWED_CONTENT_TYPES
    assert core.http._CREDENTIAL_HEADERS == sources.http._CREDENTIAL_HEADERS


@pytest.mark.parametrize("host", [
    "100.64.0.1", "100.127.255.254",   # carrier-grade NAT (not private, not global)
    "198.18.0.1",                       # benchmarking
    "192.0.0.8",                        # IETF protocol assignments
    "240.0.0.1", "10.1.2.3", "127.0.0.1", "169.254.169.254", "0.0.0.0",
    "[::1]", "[fe80::1]", "[2001:db8::1]", "[::ffff:100.64.0.1]",
])
def test_non_global_addresses_are_refused(copy, host):
    with pytest.raises(copy.safety.UnsafeURLError):
        copy.safety.assert_url_safe(f"http://{host}/")
    assert not copy.safety.is_url_safe(f"http://{host}/")


@pytest.mark.parametrize("url", ["ftp://a.test/x", "ftp:a.test/x", "javascript:alert(1)",
                                 "mailto:a@b.test", "file:///etc/passwd"])
def test_other_schemes_cannot_hide_behind_the_https_default(public_dns, url):
    with pytest.raises(public_dns.safety.UnsafeURLError, match="scheme"):
        public_dns.safety.assert_url_safe(url)


def test_schemeless_host_and_port_still_default_to_https(public_dns):
    assert public_dns.safety.assert_url_safe("a.test:8443/x") == "https://a.test:8443/x"


def test_port_allowlist_is_opt_in(copy):
    ports = (80, 443, 8080, 8443)
    assert copy.safety.assert_url_safe("https://1.1.1.1:8000/") == "https://1.1.1.1:8000/"
    assert copy.safety.assert_url_safe("http://1.1.1.1:8080/", allowed_ports=ports)
    for url in ("https://1.1.1.1:8000/", "http://1.1.1.1:6379/"):
        with pytest.raises(copy.safety.UnsafeURLError):
            copy.safety.assert_url_safe(url, allowed_ports=ports)


@pytest.mark.parametrize("peer, allowed", [
    (("93.184.216.34", 443), True),
    (("10.0.0.5", 443), False),
    (("100.64.0.9", 80), False),
    (("::ffff:127.0.0.1", 80, 0, 0), False),
    (OSError("not connected"), False),
])
def test_connected_peer_check(copy, peer, allowed):
    sock = FakeSocket(peer)
    if allowed:
        assert copy.safety.assert_peer_public(sock) is None
    else:
        with pytest.raises(copy.safety.UnsafeURLError):
            copy.safety.assert_peer_public(sock)


def test_a_name_that_rebinds_to_a_private_address_is_refused_at_connect(public_dns, monkeypatch):
    opened = []

    def connect(address, timeout=None, source_address=None, socket_options=None):
        sock = FakeSocket(("10.0.0.7", address[1]))
        opened.append(sock)
        return sock

    monkeypatch.setattr("urllib3.util.connection.create_connection", connect)
    with pytest.raises(public_dns.http.FetchError) as caught:
        public_dns.http.safe_get("http://rebind.test/")
    assert caught.value.code == "blocked_url"
    assert len(opened) == 1 and opened[0].closed


def test_sessions_ignore_environment_proxies(copy, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://10.0.0.1:3128")
    session = copy.http._new_session()
    assert session.trust_env is False
    adapter = session.get_adapter("https://a.test/")
    assert isinstance(adapter, copy.http._PublicPeerAdapter)
    for pool in adapter.poolmanager.pool_classes_by_scheme.values():
        assert issubclass(pool.ConnectionCls, copy.http._PublicPeerMixin)


def test_credentials_are_dropped_once_a_redirect_leaves_the_origin(mocked):
    copy, rsps = mocked
    rsps.add(responses.GET, "https://a.test/start", status=302,
             headers={"Location": "/next", "Set-Cookie": "sid=1; Path=/"})
    rsps.add(responses.GET, "https://a.test/next", status=302,
             headers={"Location": "https://b.test/final"})
    rsps.add(responses.GET, "https://b.test/final", body="<p>ok</p>", content_type="text/html")

    resp = copy.http.safe_get(
        "https://a.test/start",
        headers={"Authorization": "Bearer t0ken", "Cookie": "pref=1", "User-Agent": "UA/1"},
    )

    assert resp.final_url == "https://b.test/final" and resp.text == "<p>ok</p>"
    first, second, third = (call.request.headers for call in rsps.calls)
    assert first["Authorization"] == second["Authorization"] == "Bearer t0ken"
    assert second["Cookie"] == "pref=1"
    assert "Authorization" not in third and "Cookie" not in third
    assert third["User-Agent"] == "UA/1"


def test_redirect_to_a_private_address_is_refused(mocked):
    copy, rsps = mocked
    rsps.add(responses.GET, "https://a.test/", status=301,
             headers={"Location": "http://100.64.0.1/latest/meta-data/"})
    with pytest.raises(copy.http.FetchError) as caught:
        copy.http.safe_get("https://a.test/")
    assert caught.value.code == "blocked_url"
    assert str(caught.value).startswith("redirect refused:")


def test_body_cap_and_content_type_keep_their_codes(mocked):
    copy, rsps = mocked
    rsps.add(responses.GET, "https://a.test/big", body="x" * 50, content_type="text/plain")
    rsps.add(responses.GET, "https://a.test/pdf", body=b"%PDF", content_type="application/pdf")
    with pytest.raises(copy.http.FetchError) as big:
        copy.http.safe_get("https://a.test/big", max_bytes=10)
    with pytest.raises(copy.http.FetchError) as pdf:
        copy.http.safe_get("https://a.test/pdf")
    assert (big.value.code, pdf.value.code) == ("too_large", "content_type")
    assert copy.http.safe_get("https://a.test/big", max_bytes=10, truncate=True).text == "x" * 10


def test_deadline_bounds_the_whole_fetch(mocked):
    copy, rsps = mocked

    def slow(request):
        time.sleep(0.3)
        return 200, {"Content-Type": "text/html"}, "<p>late</p>"

    rsps.add_callback(responses.GET, "https://a.test/slow", callback=slow)
    started = time.monotonic()
    with pytest.raises(copy.http.FetchError) as caught:
        copy.http.safe_get("https://a.test/slow", deadline=0.1)
    assert caught.value.code == "timeout"
    assert time.monotonic() - started < 2


def test_network_errors_are_classified(mocked):
    copy, rsps = mocked
    rsps.add(responses.GET, "https://a.test/down", body=requests.exceptions.ConnectionError("x"))
    with pytest.raises(copy.http.FetchError) as down:
        copy.http.safe_get("https://a.test/down")
    assert down.value.code == "fetch_failed"


# ── through the sources service's readers ────────────────────────────────


def test_the_sources_reader_refuses_a_carrier_grade_nat_address():
    from services.sources import logic

    out = logic.read_url("http://100.64.0.1/admin")
    assert out["status"] == "error" and out["kind"] == "page"
    assert out["detail"].startswith("unsafe URL:")


def test_the_sources_readers_bound_every_fetch(monkeypatch):
    from services.sources import logic

    calls = []

    def fake_get(url, **kwargs):
        calls.append(kwargs)
        raise logic.FetchError("timed out (deadline reached)", code="timeout")

    monkeypatch.setattr(logic, "safe_get", fake_get)
    logic.read_url("https://example.com/page")
    logic.read_url("https://www.reddit.com/r/x/comments/abc/title/")
    assert [c["deadline"] for c in calls] == [logic.PAGE_DEADLINE, logic.PAGE_DEADLINE]
    assert logic.PAGE_DEADLINE < logic.PAGE_TIMEOUT + 10
