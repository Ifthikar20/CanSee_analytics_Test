"""Deployment wiring: SPA security headers, maintenance on the agent routes,
the deploy script's nginx and agent decisions, the agent ASGI settings, dev
settings and the env example (findings be-infra-1..7, fe-security-3)."""
import json
import os
import re
import subprocess
import sys

import pytest
import yaml
from django.conf import settings

NGINX_CONFS = ["nginx.prod.conf", "nginx.http.conf"]
NONCE_SOURCE = "'nonce-$request_id'"
# Locations that serve an HTML document: the SPA shell and the
# prerendered blog pages (docker/nginx, ``location ^~ /blog``).
DOCUMENT_LOCATIONS = ("= /index.html", "^~ /blog")
SUB_FILTER = """sub_filter '<script>' '<script nonce="$request_id">';"""


def _conf(name):
    return (settings.BASE_DIR / "docker" / "nginx" / name).read_text(encoding="utf-8")


def _block(text, start):
    """The brace-matched block whose header starts at ``start``."""
    depth = 0
    for i in range(text.index("{", start), len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise AssertionError("unbalanced block")


def _add_headers(block):
    return [line.strip() for line in block.splitlines() if line.strip().startswith("add_header ")]


def _server_headers(text):
    """The main server's own add_header lines (server level, 8-space indent)."""
    return [line.strip() for line in text.splitlines() if re.match(r"^ {8}add_header ", line)]


def _spa_locations(text):
    spa = _block(text, text.rindex("        location / {"))
    return {
        m.group(1).strip(): _block(spa, m.start() + 1)
        for m in re.finditer(r"\n {12}location ([^{\n]+)\{", spa)
    }


# ── SPA security headers (be-infra-1, fe-security-3) ─────────────────────


@pytest.mark.parametrize("name", NGINX_CONFS)
def test_spa_locations_repeat_every_server_security_header(name):
    text = _conf(name)
    server = _server_headers(text)
    assert any(h.startswith("add_header Content-Security-Policy") for h in server)
    assert any(h.startswith("add_header X-Frame-Options DENY") for h in server)
    locations = _spa_locations(text)
    assert set(locations) == {
        *DOCUMENT_LOCATIONS, r"~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$",
    }

    for where, block in locations.items():
        headers = _add_headers(block)
        assert headers, where
        for header in server:
            if where in DOCUMENT_LOCATIONS and header.startswith("add_header Content-Security-Policy"):
                header = header.replace("script-src 'self' ", f"script-src 'self' {NONCE_SOURCE} ", 1)
            assert header in headers, (where, header)


@pytest.mark.parametrize("name", NGINX_CONFS)
@pytest.mark.parametrize("where", DOCUMENT_LOCATIONS)
def test_the_spa_document_nonces_its_own_inline_scripts(name, where):
    text = _conf(name)
    document = _spa_locations(text)[where]
    csp = next(h for h in _add_headers(document) if "Content-Security-Policy" in h)

    assert SUB_FILTER in document and "sub_filter_once off;" in document
    assert f"script-src 'self' {NONCE_SOURCE} https://consent.cookiebot.com" in csp
    assert "'unsafe-inline'" not in csp.split("script-src", 1)[1].split(";", 1)[0]
    assert "frame-ancestors 'none'" in csp and "frame-src https:" in csp
    assert 'add_header Cache-Control "no-cache, no-store, must-revalidate";' in document


@pytest.mark.parametrize("name", NGINX_CONFS)
def test_the_nonce_appears_only_in_document_locations(name):
    # The nonce is per response and never cached: exactly once in each
    # location that serves an HTML document, and nowhere else.
    text = _conf(name)
    locations = _spa_locations(text)
    assert text.count(NONCE_SOURCE) == len(DOCUMENT_LOCATIONS)
    for where in DOCUMENT_LOCATIONS:
        assert locations[where].count(NONCE_SOURCE) == 1, where


def test_hsts_reaches_the_spa_only_on_the_tls_config():
    assert "Strict-Transport-Security" in _spa_locations(_conf("nginx.prod.conf"))["= /index.html"]
    assert not [h for h in _add_headers(_conf("nginx.http.conf")) if "Strict-Transport" in h]


# ── Maintenance on the agent routes (be-infra-4) ─────────────────────────


@pytest.mark.parametrize("name", NGINX_CONFS)
def test_maintenance_on_the_live_routes_answers_the_json_envelope(name):
    text = _conf(name)
    live = _block(text, text.index("location ^~ /api/v1/agent/live/"))
    assert "if (-f /etc/nginx/maintenance.on) { return 503; }" in live
    # The location's own error_page hides the server-level 503 page.
    assert "error_page 503 = @agent_maintenance;" in live

    named = _block(text, text.index("location @agent_maintenance"))
    assert "default_type application/json;" in named
    assert "add_header Retry-After 120 always;" in named
    body = json.loads(re.search(r"return 503 '(.+)';", named).group(1))
    assert body["success"] is False
    assert body["error"]["code"] == "maintenance" and body["error"]["message"]


# ── scripts/deploy.sh (be-infra-2, be-infra-3) ───────────────────────────

SERVICES = "db redis frontend web intelligence sources celery nginx"
TARGET = "a" * 40

# dep_deploy as written, with the remote side stubbed: every ssh/compose
# call is logged, and the fakes decide what the host answers. (A Windows
# checkout may carry CRLF line endings; bash needs them stripped.)
_HARNESS = r"""
set -euo pipefail
eval "$(sed -n '/^dep_deploy() {/,/^}/p' "$DEPLOY_SH" | tr -d '\r')"
step() { :; }; ok() { :; }; warn() { :; }; err() { :; }
die() { echo "DIE $*" >> "$LOG"; exit 1; }
dep_reclaim_disk() { :; }
ssh_remote() {
  echo "SSH $*" >> "$LOG"
  case "$*" in
    *"git rev-parse HEAD"*) echo "$TARGET_SHA" ;;
    *"rev-list --count"*) echo 7 ;;
    *"NGINX_CONF"*) printf '%s\n' "$FAKE_NGINX_CONF" ;;
    *"cat /etc/nginx/nginx.conf"*) return "$FAKE_CONF_DIFFERS" ;;
  esac
}
remote_compose() {
  echo "COMPOSE $*" >> "$LOG"
  case "$*" in
    "config --services") printf '%s\n' $FAKE_SERVICES ;;
    "--profile agent ps -a -q agent") printf '%s' "$FAKE_AGENT_CONTAINER" ;;
  esac
}
REMOTE_DIR=/opt/cansee BRANCH=main COMPOSE_FILE=docker/docker-compose.prod.yml
SKIP_BUILD=0 CLEAN=0 PAYWALL_ENABLED=""
dep_deploy
"""


def _deploy(tmp_path, *, prior=TARGET, conf_differs=False, nginx_conf="", services=SERVICES,
            agent_container=""):
    log = tmp_path / "calls.log"
    log.write_text("")
    env = {
        **os.environ,
        "DEPLOY_SH": str(settings.BASE_DIR / "scripts" / "deploy.sh"),
        "LOG": str(log),
        "TARGET_SHA": TARGET,
        "PRIOR_SHA": prior,
        "FAKE_CONF_DIFFERS": "1" if conf_differs else "0",
        "FAKE_NGINX_CONF": nginx_conf,
        "FAKE_SERVICES": services,
        "FAKE_AGENT_CONTAINER": agent_container,
    }
    out = subprocess.run(["bash", "-c", _HARNESS], env=env, capture_output=True, text=True,
                         timeout=60)
    assert out.returncode == 0, out.stderr
    return log.read_text().splitlines()


def test_a_redeploy_of_the_same_sha_restarts_an_nginx_holding_an_old_config(tmp_path):
    """The run after a deploy that failed past the pull: HEAD already moved,
    so git sees no change under docker/nginx, but the container still holds
    the old nginx.conf."""
    calls = _deploy(tmp_path, prior=TARGET, conf_differs=True)

    assert "COMPOSE restart nginx" in calls
    assert not any("nginx -s reload" in c for c in calls)
    assert not any("git diff" in c for c in calls)


def test_an_up_to_date_nginx_is_only_reloaded(tmp_path):
    calls = _deploy(tmp_path, prior="b" * 40, conf_differs=False)

    assert "COMPOSE exec -T nginx nginx -s reload" in calls
    assert "COMPOSE restart nginx" not in calls


@pytest.mark.parametrize("env_value, conf", [
    ("", "nginx.prod.conf"),
    ('"nginx.http.conf"', "nginx.http.conf"),
    ("nginx.http.conf\r", "nginx.http.conf"),
])
def test_the_running_config_is_compared_with_the_selected_file(tmp_path, env_value, conf):
    calls = _deploy(tmp_path, nginx_conf=env_value)

    compare = next(c for c in calls if "cat /etc/nginx/nginx.conf" in c)
    assert compare.endswith(f"| cmp -s - docker/nginx/{conf}")
    # Compared after `up -d nginx`, which may have recreated the container.
    assert calls.index("COMPOSE up -d nginx") < calls.index(compare)


def test_with_the_profile_off_a_leftover_agent_container_is_removed(tmp_path):
    calls = _deploy(tmp_path, agent_container="3f2a9c")

    removal = calls.index("COMPOSE --profile agent rm -s -f agent")
    assert removal < calls.index("COMPOSE up -d web celery intelligence sources")
    assert not any("up -d --no-deps agent" in c for c in calls)


def test_with_the_profile_off_and_no_container_nothing_is_removed(tmp_path):
    calls = _deploy(tmp_path, agent_container="")

    assert not any(" rm -s -f agent" in c for c in calls)


def test_with_the_profile_on_the_agent_is_recreated_not_removed(tmp_path):
    calls = _deploy(tmp_path, services=SERVICES + " agent", agent_container="3f2a9c")

    assert "COMPOSE up -d --no-deps agent" in calls
    assert not any("ps -a -q agent" in c or " rm -s -f agent" in c for c in calls)


def test_the_readme_says_how_to_turn_the_agent_off():
    readme = (settings.BASE_DIR / "README.md").read_text(encoding="utf-8")
    section = readme[readme.index("**Turning it off.**"):readme.index("## Deploy")]
    assert "COMPOSE_PROFILES" in section and "AGENT_ENABLED=false" in section
    assert "--profile agent rm -s -f agent" in section


# ── Agent ASGI settings (be-infra-5) and dev settings (be-infra-7) ───────


def _python(code, **env_changes):
    env = {k: v for k, v in os.environ.items() if k != "DJANGO_SETTINGS_MODULE"}
    env.update(env_changes)
    for key, value in env_changes.items():
        if value is None:
            env.pop(key)
    out = subprocess.run([sys.executable, "-c", code], cwd=settings.BASE_DIR, env=env,
                         capture_output=True, text=True, timeout=180)
    assert out.returncode == 0, out.stderr[-2000:]
    return out.stdout.split()


def test_the_agent_asgi_module_runs_on_the_agent_settings_without_the_variable():
    code = (
        "import sys, types\n"
        "sys.modules['apps.agent.runtime.registry'] = "
        "types.SimpleNamespace(start_process_services=lambda: None)\n"
        "import config.agent_asgi\n"
        "from django.conf import settings\n"
        "print(settings.SETTINGS_MODULE, settings.AGENT_PROCESS,"
        " settings.DATABASES['default']['CONN_MAX_AGE'])\n"
    )
    assert _python(code) == ["config.settings.agent", "True", "0"]


@pytest.mark.parametrize("value, expected", [(None, "True"), ("false", "False")])
def test_dev_settings_read_agent_process_from_the_environment(value, expected):
    code = "from django.conf import settings\nprint(settings.AGENT_PROCESS)\n"
    out = _python(code, DJANGO_SETTINGS_MODULE="config.settings.dev", AGENT_PROCESS=value)
    assert out == [expected]


def test_the_gunicorn_convenience_stack_has_no_agent_process():
    compose = yaml.safe_load(
        (settings.BASE_DIR / "docker" / "docker-compose.yml").read_text(encoding="utf-8")
    )["services"]
    web = compose["web"]
    assert "command" not in web  # the image's gunicorn CMD with several workers
    assert web["environment"]["AGENT_PROCESS"] == "false"


# ── .env.prod.example (be-infra-6) ───────────────────────────────────────


def test_the_env_example_carries_the_agent_switch_and_its_defaults():
    lines = (settings.BASE_DIR / ".env.prod.example").read_text(encoding="utf-8").splitlines()
    assert "AGENT_ENABLED=false" in lines
    # Set keys must never be blank AGENT_* values (a blank is not a default).
    assert not [ln for ln in lines if re.match(r"^AGENT_[A-Z_]+=\s*$", ln)]
    overrides = dict(
        ln[2:].split("=", 1) for ln in lines if re.match(r"^# AGENT_[A-Z_]+=", ln)
    )
    assert set(overrides) >= {"AGENT_MODEL", "AGENT_MAX_CONCURRENT_RUNS",
                              "AGENT_RUN_MAX_COST_USD", "AGENT_CHAT_RETENTION_DAYS"}
    for key, value in overrides.items():
        assert str(getattr(settings, key)) == value, key
    anthropic = next(i for i, ln in enumerate(lines) if ln.startswith("ANTHROPIC_API_KEY="))
    assert "agent" in " ".join(lines[anthropic - 2:anthropic]).lower()
    serpapi = next(i for i, ln in enumerate(lines) if ln.startswith("SERPAPI_KEY="))
    assert "agent" in " ".join(lines[serpapi - 2:serpapi]).lower()
