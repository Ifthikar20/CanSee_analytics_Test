"""SSRF hardening in core.validators (url_safety, safe_http)."""
import ipaddress
import socket
import time

import pytest
import requests
import responses

from core.validators import safe_http
from core.validators.safe_http import FetchError, safe_get
from core.validators.url_safety import (
    UnsafeURLError,
    assert_peer_public,
    assert_url_safe,
    is_url_safe,
)


@pytest.fixture
def public_dns(monkeypatch):
    def resolve(hostname):
        try:
            return [ipaddress.ip_address(hostname.strip("[]"))]
        except ValueError:
            return [ipaddress.ip_address("93.184.216.34")]

    monkeypatch.setattr("core.validators.url_safety._resolve_addresses", resolve)


@pytest.fixture
def mocked(public_dns):
    with responses.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        yield rsps


# ── address rules ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("host", [
    "100.64.0.1", "100.127.255.254",   # carrier-grade NAT (not private, not global)
    "198.18.0.1",                       # benchmarking
    "192.0.0.8",                        # IETF protocol assignments
    "240.0.0.1",                        # reserved
    "10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "0.0.0.0",
    "[::1]", "[fe80::1]", "[fc00::1]", "[2001:db8::1]", "[::ffff:100.64.0.1]",
    "[::ffff:10.0.0.1]",
])
def test_non_global_addresses_are_refused(host):
    with pytest.raises(UnsafeURLError):
        assert_url_safe(f"http://{host}/")
    assert not is_url_safe(f"http://{host}/")


@pytest.mark.parametrize("host", ["93.184.216.34", "1.1.1.1", "[2606:4700:4700::1111]"])
def test_public_addresses_pass(host):
    assert assert_url_safe(f"https://{host}/x") == f"https://{host}/x"


def test_port_allowlist_is_opt_in():
    assert assert_url_safe("https://1.1.1.1:8000/") == "https://1.1.1.1:8000/"
    ports = (80, 443, 8080, 8443)
    assert assert_url_safe("https://1.1.1.1/", allowed_ports=ports)
    assert assert_url_safe("http://1.1.1.1/", allowed_ports=ports)
    assert assert_url_safe("http://1.1.1.1:8080/", allowed_ports=ports)
    for url in ("https://1.1.1.1:8000/", "http://1.1.1.1:6379/", "https://1.1.1.1:99999/"):
        with pytest.raises(UnsafeURLError):
            assert_url_safe(url, allowed_ports=ports)


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


@pytest.mark.parametrize("peer, allowed", [
    (("93.184.216.34", 443), True),
    (("2606:4700:4700::1111", 443, 0, 0), True),
    (("10.0.0.5", 443), False),
    (("100.64.0.9", 80), False),
    (("fe80::1%eth0", 443, 0, 2), False),
    (("::ffff:127.0.0.1", 80, 0, 0), False),
    (OSError("not connected"), False),
])
def test_connected_peer_check(peer, allowed):
    sock = FakeSocket(peer)
    if allowed:
        assert assert_peer_public(sock) is None
    else:
        with pytest.raises(UnsafeURLError):
            assert_peer_public(sock)


def test_a_name_that_rebinds_to_a_private_address_is_refused_at_connect(public_dns, monkeypatch):
    """DNS said public at check time; the socket connected to a private
    address. The connection is closed before any request bytes are sent."""
    opened = []

    def connect(address, timeout=None, source_address=None, socket_options=None):
        sock = FakeSocket(("10.0.0.7", address[1]))
        opened.append(sock)
        return sock

    monkeypatch.setattr("urllib3.util.connection.create_connection", connect)
    with pytest.raises(FetchError) as caught:
        safe_get("http://rebind.test/")
    assert caught.value.code == "blocked_url"
    assert "unsafe URL" in str(caught.value)
    assert len(opened) == 1 and opened[0].closed


def test_sessions_ignore_environment_proxies(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://10.0.0.1:3128")
    session = safe_http._new_session()
    assert session.trust_env is False
    for url in ("https://a.test/", "http://a.test/"):
        adapter = session.get_adapter(url)
        assert isinstance(adapter, safe_http._PublicPeerAdapter)
        for pool in adapter.poolmanager.pool_classes_by_scheme.values():
            assert issubclass(pool.ConnectionCls, safe_http._PublicPeerMixin)


# ── redirects and headers ─────────────────────────────────────────────────


def test_credentials_are_dropped_once_a_redirect_leaves_the_origin(mocked):
    mocked.add(responses.GET, "https://a.test/start", status=302,
               headers={"Location": "/next", "Set-Cookie": "sid=1; Path=/"})
    mocked.add(responses.GET, "https://a.test/next", status=302,
               headers={"Location": "https://b.test/final"})
    mocked.add(responses.GET, "https://b.test/final", body="<p>ok</p>",
               content_type="text/html")
    resp = safe_get(
        "https://a.test/start",
        headers={"Authorization": "Bearer t0ken", "Cookie": "pref=1", "User-Agent": "UA/1"},
    )
    assert resp.final_url == "https://b.test/final"
    first, second, third = (call.request.headers for call in mocked.calls)
    assert first["Authorization"] == "Bearer t0ken" and second["Authorization"] == "Bearer t0ken"
    assert second["Cookie"] == "pref=1"  # the caller's, never the server's sid=1
    assert "Authorization" not in third and "Cookie" not in third
    assert third["User-Agent"] == "UA/1"


def test_redirect_to_a_private_address_is_refused(mocked):
    mocked.add(responses.GET, "https://a.test/", status=301,
               headers={"Location": "http://169.254.169.254/latest/meta-data/"})
    with pytest.raises(FetchError) as caught:
        safe_get("https://a.test/")
    assert caught.value.code == "blocked_url"
    assert str(caught.value).startswith("redirect refused:")


def test_redirect_loops_stop(mocked):
    mocked.add(responses.GET, "https://a.test/loop", status=302,
               headers={"Location": "https://a.test/loop"})
    with pytest.raises(FetchError, match="too many redirects"):
        safe_get("https://a.test/loop")


# ── body, type and deadline ───────────────────────────────────────────────


def test_existing_callers_keep_their_behaviour(mocked):
    mocked.add(responses.GET, "https://a.test/page", body="<p>café</p>",
               content_type="text/html; charset=utf-8", headers={"X-Thing": "1"})
    resp = safe_get("https://a.test/page")
    assert (resp.status_code, resp.final_url, resp.content_type) == (
        200, "https://a.test/page", "text/html",
    )
    assert resp.text == "<p>café</p>"
    assert resp.content == "<p>café</p>".encode()
    assert resp.headers["X-Thing"] == "1"

    mocked.add(responses.GET, "https://a.test/pdf", body=b"%PDF", content_type="application/pdf")
    with pytest.raises(FetchError, match="disallowed content-type: application/pdf"):
        safe_get("https://a.test/pdf")

    mocked.add(responses.GET, "https://a.test/big", body="x" * 50, content_type="text/plain")
    with pytest.raises(FetchError, match="response body exceeds 10 bytes") as caught:
        safe_get("https://a.test/big", max_bytes=10)
    assert caught.value.code == "too_large"
    assert safe_get("https://a.test/big", max_bytes=10, truncate=True).text == "x" * 10

    with pytest.raises(FetchError, match="unsafe URL"):
        safe_get("http://127.0.0.1/")


def test_deadline_bounds_the_whole_fetch(mocked):
    def slow(request):
        time.sleep(0.3)
        return 200, {"Content-Type": "text/html"}, "<p>late</p>"

    mocked.add_callback(responses.GET, "https://a.test/slow", callback=slow)
    started = time.monotonic()
    with pytest.raises(FetchError) as caught:
        safe_get("https://a.test/slow", deadline=0.1)
    assert caught.value.code == "timeout"
    assert time.monotonic() - started < 2
    # Without a deadline the same response is fine.
    assert safe_get("https://a.test/slow").text == "<p>late</p>"


def test_watchdog_wakes_a_blocked_read():
    reader, writer = socket.socketpair()
    reader.settimeout(5)
    try:
        watchdog = safe_http._Watchdog(0.2)
        watchdog.track(reader)
        started = time.monotonic()
        try:
            data = reader.recv(1)
        except OSError:
            data = b""
        assert data == b""
        assert time.monotonic() - started < 2
        assert watchdog.expired
    finally:
        reader.close()
        writer.close()


def test_a_socket_opened_after_the_deadline_is_shut_at_once():
    watchdog = safe_http._Watchdog(0.0)
    waited = time.monotonic()
    while not watchdog._fired and time.monotonic() - waited < 2:
        time.sleep(0.01)
    sock = FakeSocket(("93.184.216.34", 443))
    watchdog.track(sock)
    assert sock.closed and watchdog.expired


def test_network_errors_are_classified(mocked):
    mocked.add(responses.GET, "https://a.test/down", body=requests.exceptions.ConnectionError("x"))
    mocked.add(responses.GET, "https://a.test/slow", body=requests.exceptions.ConnectTimeout("t"))
    with pytest.raises(FetchError) as down:
        safe_get("https://a.test/down")
    with pytest.raises(FetchError) as slow:
        safe_get("https://a.test/slow")
    assert (down.value.code, slow.value.code) == ("fetch_failed", "timeout")
