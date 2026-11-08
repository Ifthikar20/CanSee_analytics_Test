"""Local agent setup works with scripts/run-local.sh plus keys in .env: the
.env it writes lists the agent's keys (commented, so nothing is set by
accident), and the dev settings keep the agent on unless .env turns it
off."""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "run-local.sh"

AGENT_KEYS = ("ANTHROPIC_API_KEY", "SERPAPI_KEY", "SCRAPERAPI_KEY", "OPENAI_API_KEY",
              "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY",
              "AI_FREE_MONTHLY_CAP_USD", "AGENT_ENABLED")


@pytest.fixture
def written_env(tmp_path) -> list[str]:
    """The .env lines run-local.sh would write (a dry run in a copy)."""
    if shutil.which("bash") is None:
        pytest.skip("bash is not available")
    (tmp_path / "scripts").mkdir()
    shutil.copy(SCRIPT, tmp_path / "scripts" / "run-local.sh")
    result = subprocess.run(
        ["bash", "scripts/run-local.sh", "--dry-run", "--no-ui"], cwd=tmp_path,
        capture_output=True, text=True, timeout=30, check=True,
    )
    assert not (tmp_path / ".env").exists()
    out = result.stdout
    block = out[out.index("+ write .env:"):].splitlines()[1:]
    lines = []
    for line in block:
        if not line.startswith("    "):
            break
        lines.append(line[4:])
    return lines


def test_the_written_env_lists_every_agent_key_commented_out(written_env):
    for key in AGENT_KEYS:
        assert f"# {key}=" in "\n".join(written_env), key
    # Nothing is set by default: every agent key line is a comment.
    settings_lines = [line for line in written_env if not line.startswith("#")]
    assert not [line for line in settings_lines if line.split("=", 1)[0] in AGENT_KEYS]
    # A commented key line carries no inline note that uncommenting would
    # turn into the key's value.
    for line in written_env:
        match = re.fullmatch(r"# ([A-Z_]+)=(.*)", line)
        if match and match.group(1) in AGENT_KEYS:
            assert re.fullmatch(r"[\w.]*", match.group(2)), line


def test_dev_settings_keep_the_agent_on_unless_env_turns_it_off():
    source = (ROOT / "config" / "settings" / "dev.py").read_text()
    assert 'AGENT_ENABLED = env.bool("AGENT_ENABLED", default=True)' in source
    assert 'AGENT_PROCESS = env.bool("AGENT_PROCESS", default=True)' in source
    assert 'AGENT_RUN_MODE = "thread"' in source
