"""Routes, beat schedule, security headers and the production wiring files."""
import re
import sys

import pytest
import yaml
from django.conf import settings
from django.http import HttpResponse, StreamingHttpResponse
from django.urls import resolve, reverse

from apps.agent.tests.api_support import LIVE_MODULES, stand_in_missing_live_modules
from core.middleware.security_headers import SecurityHeadersMiddleware

stand_in_missing_live_modules()

RUN = "6f1c1f1e-35b1-4a3e-9d3e-1c2b3a4d5e6f"
SITE = "0b9f6c34-1d2e-4f50-8a6b-7c8d9e0f1a2b"


def _headers(response):
    return SecurityHeadersMiddleware(lambda request: response)(None)


def test_event_streams_keep_no_transform():
    stream = StreamingHttpResponse(iter([b": ping\n\n"]), content_type="text/event-stream; charset=utf-8")
    stream["Cache-Control"] = "no-store, no-transform"
    cache_control = _headers(stream)["Cache-Control"]
    assert "no-transform" in cache_control and "no-store" in cache_control
    assert _headers(HttpResponse("{}", content_type="application/json"))["Cache-Control"] == (
        "no-store, no-cache, must-revalidate, private"
    )


def test_beat_sweeps_stale_agent_runs_every_minute_on_the_default_queue():
    from config.celery import app

    entry = app.conf.beat_schedule["sweep-stale-agent-runs"]
    assert entry["task"] == "apps.agent.tasks.sweep_stale_agent_runs"
    assert entry["schedule"].minute == set(range(60))
    assert entry["schedule"].hour == set(range(24))
    for pattern in app.conf.task_routes:
        regex = "^" + re.escape(pattern).replace(r"\*", ".*") + "$"
        assert not re.match(regex, entry["task"]), pattern


@pytest.mark.parametrize("name, kwargs, path", [
    ("agent-status", {}, "/api/v1/agent/status/"),
    ("agent-catalog", {}, "/api/v1/agent/agents/"),
    ("agent-chats", {"website_id": SITE}, f"/api/v1/agent/websites/{SITE}/chats/"),
    ("agent-artifact-version", {"website_id": SITE, "artifact_id": RUN, "number": 3},
     f"/api/v1/agent/websites/{SITE}/artifacts/{RUN}/versions/3/"),
    ("agent-reports", {"website_id": SITE}, f"/api/v1/agent/websites/{SITE}/reports/"),
    ("agent-live-send", {"website_id": SITE, "chat_id": RUN},
     f"/api/v1/agent/live/websites/{SITE}/chats/{RUN}/messages/"),
    ("agent-live-stream", {"run_id": RUN}, f"/api/v1/agent/live/runs/{RUN}/stream/"),
    ("agent-live-events", {"run_id": RUN}, f"/api/v1/agent/live/runs/{RUN}/events/"),
    ("agent-live-cancel", {"run_id": RUN}, f"/api/v1/agent/live/runs/{RUN}/cancel/"),
    ("agent-live-browse", {"website_id": SITE}, f"/api/v1/agent/live/websites/{SITE}/browse/"),
])
def test_routes_follow_the_contract(name, kwargs, path):
    assert reverse(name, kwargs=kwargs) == path
    assert resolve(path).url_name == name


def test_live_routes_are_served_by_the_runtime_views():
    """Fails until the runtime role's live_views.py and stream.py exist."""
    from apps.agent.api.v1 import urls

    stood_in = [name for name in LIVE_MODULES if getattr(sys.modules[name], "STAND_IN", False)]
    assert stood_in == [], f"missing runtime modules: {stood_in}"
    views = {p.name: p.callback for p in urls.urlpatterns}
    live = sys.modules["apps.agent.api.v1.live_views"]
    assert views["agent-live-send"].view_class is live.SendMessageView
    assert views["agent-live-events"].view_class is live.RunEventsView


# ── production wiring ─────────────────────────────────────────────────────


def _compose():
    path = settings.BASE_DIR / "docker" / "docker-compose.prod.yml"
    return yaml.safe_load(path.read_text(encoding="utf-8"))["services"]


def test_agent_service_runs_the_web_image_behind_a_profile():
    services = _compose()
    web, agent = services["web"], services["agent"]
    assert web["image"] == agent["image"] == "cansee.local/web:latest"
    assert agent["profiles"] == ["agent"] and agent["pull_policy"] == "never"
    assert agent["command"][:2] == ["uvicorn", "config.agent_asgi:application"]
    assert "--workers" in agent["command"] and agent["command"][agent["command"].index("--workers") + 1] == "1"
    assert agent["environment"]["DJANGO_SETTINGS_MODULE"] == "config.settings.agent"
    for key in ("DB_HOST", "REDIS_URL", "CELERY_BROKER_URL"):
        assert agent["environment"][key] == web["environment"][key]
    assert agent["env_file"] == web["env_file"]
    assert agent["stop_grace_period"] == "30s"
    assert agent["deploy"]["resources"]["limits"]["memory"] == "512M"
    assert "uvicorn==0.32.*" in (settings.BASE_DIR / "requirements" / "prod.txt").read_text()


def test_agent_asgi_is_plain_django_and_starts_the_process_services(monkeypatch):
    import importlib

    from django.core.handlers.asgi import ASGIHandler

    calls = []
    monkeypatch.setattr("apps.agent.runtime.registry.start_process_services",
                        lambda: calls.append("started"))
    sys.modules.pop("config.agent_asgi", None)
    try:
        module = importlib.import_module("config.agent_asgi")
    finally:
        sys.modules.pop("config.agent_asgi", None)
    assert type(module.application) is ASGIHandler
    assert calls == ["started"]


def _live_block(name):
    text = (settings.BASE_DIR / "docker" / "nginx" / name).read_text(encoding="utf-8")
    start = text.index("location ^~ /api/v1/agent/live/")
    end = text.index("# ── API Proxy ──")
    return text[start:end], text


@pytest.mark.parametrize("name", ["nginx.prod.conf", "nginx.http.conf"])
def test_nginx_routes_live_requests_to_the_agent(name):
    block, text = _live_block(name)
    assert text.index("location ^~ /api/v1/agent/live/") < text.index("location /api/ {")
    for line in (
        "proxy_pass $agent_upstream;", "proxy_buffering off;", "gzip off;",
        "proxy_read_timeout 300s;", "proxy_http_version 1.1;",
        "error_page 502 504 = @agent_unavailable;", "resolver 127.0.0.11 valid=10s ipv6=off;",
        '"code":"agent_unavailable"',
    ):
        assert line in block


@pytest.mark.parametrize("name", ["nginx.prod.conf", "nginx.http.conf"])
def test_the_spa_csp_lets_the_browser_pane_frame_https_pages(name):
    text = (settings.BASE_DIR / "docker" / "nginx" / name).read_text(encoding="utf-8")
    csp = next(line for line in text.splitlines() if "Content-Security-Policy" in line
               and "add_header" in line)
    directives = {d.strip().split(" ", 1)[0]: d.strip() for d in csp.split('"')[1].split(";")}
    assert directives["frame-src"] == "frame-src https:"
    assert directives["frame-ancestors"] == "frame-ancestors 'none'"


def test_both_nginx_configs_carry_the_same_agent_block():
    assert _live_block("nginx.prod.conf")[0] == _live_block("nginx.http.conf")[0]
