"""Properties of the two nginx configs that must not drift apart.

There is no nginx harness in this project, and `nginx -t` needs Docker. These
are text assertions instead -- cheap, and they catch the two failure modes
that make a plaintext deployment break silently:

  * hardcoding `X-Forwarded-Proto https` makes Django believe every request
    is secure, so it marks every cookie Secure, the browser discards them on
    an http:// origin, and login returns 200 with the session gone on reload;
  * emitting HSTS or a 301-to-https from the plaintext config pins visitors'
    browsers to a scheme this deployment cannot serve, with no server-side
    undo.

Real validation is still a manual step, documented in DEPLOY.md:
  docker run --rm -v "$PWD/docker/nginx/nginx.http.conf:/etc/nginx/nginx.conf:ro" \
      nginx:alpine nginx -t
"""
from pathlib import Path

import pytest

_NGINX = Path(__file__).resolve().parents[2] / "docker" / "nginx"
_PROD = _NGINX / "nginx.prod.conf"
_HTTP = _NGINX / "nginx.http.conf"


def _read(path):
    assert path.is_file(), f"missing nginx config: {path}"
    return path.read_text(encoding="utf-8")


def _directives(path):
    """The config with comment lines stripped.

    Both files carry comments that name the very directives their config
    must not contain -- nginx.http.conf explains at length why it has no
    ssl_certificate and no Strict-Transport-Security. Asserting against the
    raw text would match that prose, so these checks read directives only.
    """
    return "\n".join(
        line for line in _read(path).splitlines() if not line.lstrip().startswith("#")
    )


@pytest.mark.parametrize("path", [_PROD, _HTTP], ids=["prod", "http"])
def test_forwarded_proto_is_never_hardcoded(path):
    """Failure mode A, as a one-line assertion.

    Inside the TLS server block $scheme already evaluates to "https", so
    using the variable is identical to the literal there -- and correct in
    the plaintext config, where the literal would be a lie.
    """
    text = _directives(path)
    assert "X-Forwarded-Proto https" not in text
    assert "X-Forwarded-Proto $scheme" in text


@pytest.mark.parametrize("path", [_PROD, _HTTP], ids=["prod", "http"])
def test_host_header_is_never_hardcoded(path):
    # `proxy_set_header Host cansee.ai` existed only because ALLOWED_HOSTS
    # did not contain the IP. It breaks any other deployment.
    assert "proxy_set_header Host cansee.ai" not in _directives(path)


class TestPlaintextConfig:
    def test_declares_no_tls(self):
        # nginx refuses to start when a declared certificate file is absent,
        # which is exactly the state of a freshly provisioned box.
        text = _directives(_HTTP)
        assert "ssl_certificate" not in text
        assert "listen 443" not in text

    def test_never_redirects_to_https(self):
        # The redirect target does not exist in this deployment. The CSP does
        # legitimately name https:// origins (Cookiebot, Google Fonts), so
        # this asserts on the redirect directive rather than the substring.
        assert "return 301 https://" not in _directives(_HTTP)

    def test_emits_no_hsts(self):
        # The one header with a persistent client-side effect and no undo.
        assert "Strict-Transport-Security" not in _directives(_HTTP)

    def test_allows_plaintext_websockets_in_csp(self):
        # The SPA opens ws:, not wss:, when the page itself is http.
        assert "connect-src 'self' ws: wss:" in _read(_HTTP)

    def test_is_the_default_server(self):
        # The box is reached by a bare IP. default_server matches it without
        # the IP having to be hardcoded, as the old config did.
        text = _read(_HTTP)
        assert "listen 80 default_server;" in text
        assert "server_name _;" in text


class TestBothConfigsStayInSync:
    @pytest.mark.parametrize(
        "location",
        [
            "/static/", "/health/", "/api/", "^~ /api/v1/agent/live/", "= /p.js", "/pixel/",
            # Django admin is proxied only at the unguessable ADMIN_URL path;
            # a plain /admin/ falls through to the SPA. There is no /ws/:
            # websockets were removed from the app.
            "/ops-ed4aaf863d969e541d/",
            # The prerendered blog pages (dist/blog/<slug>/index.html).
            "^~ /blog",
        ],
    )
    def test_every_route_exists_in_both(self, location):
        # A route added to one and forgotten in the other is the drift this
        # guards: the plaintext box would 404 on something prod serves.
        assert f"location {location}" in _read(_PROD)
        assert f"location {location}" in _read(_HTTP)

    def test_both_proxy_to_the_same_upstream(self):
        for path in (_PROD, _HTTP):
            assert "upstream django" in _read(path)
            assert "server web:8000;" in _read(path)

    def test_compose_selects_the_config_by_variable(self):
        compose = (_NGINX.parents[0] / "docker-compose.prod.yml").read_text(encoding="utf-8")
        # The :- form treats an empty value as unset, so a blank NGINX_CONF in
        # docker/.env still resolves rather than producing a directory mount.
        assert "${NGINX_CONF:-nginx.prod.conf}" in compose


def _block(text, header):
    """The body of the `{ ... }` block opened by `header`, braces balanced."""
    start = text.index(header)
    open_at = text.index("{", start)
    depth = 0
    for i in range(open_at, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_at + 1 : i]
    raise AssertionError(f"unbalanced braces after {header!r}")


def _directive_lines(block):
    """Directive lines of a block, comments and blank lines dropped."""
    lines = [line.strip() for line in block.splitlines()]
    return [line for line in lines if line and not line.startswith("#")]


@pytest.mark.parametrize("path", [_PROD, _HTTP], ids=["prod", "http"])
class TestPrerenderedBlogPages:
    """The UI build writes /blog/index.html and /blog/<slug>/index.html.

    `$uri/` alone would answer /blog/<slug> with a redirect to
    /blog/<slug>/ (the canonical URL has no trailing slash). And try_files
    serves a found file inside the location it runs in, so these pages never
    reach the `location = /index.html` block: without a location of their own
    they would go out with no CSP, no framing header and no script nonce,
    which the theme bootstrap <script> in the shell needs to run.
    """

    def test_serves_the_prerendered_file_before_the_spa_fallback(self, path):
        blog = _block(_directives(path), "location ^~ /blog {")
        assert "try_files $uri $uri/index.html /index.html;" in blog

    def test_sits_inside_the_spa_location(self, path):
        spa = _block(_directives(path), "location / {\n            if (-f /etc/nginx/maintenance.on)")
        assert "location ^~ /blog {" in spa

    def test_honours_maintenance_mode(self, path):
        # Rewrite-phase directives are not inherited by nested locations.
        blog = _block(_directives(path), "location ^~ /blog {")
        assert "if (-f /etc/nginx/maintenance.on) { return 503; }" in blog

    def test_headers_match_the_index_html_block(self, path):
        text = _directives(path)
        index = _directive_lines(_block(text, "location = /index.html {"))
        blog = _directive_lines(_block(text, "location ^~ /blog {"))
        # Everything the shell gets (nonce, no-cache, CSP and the other
        # security headers), in the same order and spelling.
        assert [line for line in blog if not line.startswith(("try_files", "if "))] == index
        assert "sub_filter '<script>' '<script nonce=\"$request_id\">';" in blog
        assert any(line.startswith("add_header Content-Security-Policy") for line in blog)

