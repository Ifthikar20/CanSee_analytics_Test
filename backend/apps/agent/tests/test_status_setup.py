"""GET status/: the engines with whether each has its key, the Google
results provider, the prompt runs, whether the research agents can run and
the setup issues in plain words. Setting names are shown to staff and on a
DEBUG server only."""
import pytest
from django.core.cache import cache
from django.test import override_settings

from apps.agent.tests.api_support import client_for, data, error, make_user
from apps.metering.tests.prompt_run_support import make_paid, use_runs

pytestmark = pytest.mark.django_db

URL = "/api/v1/agent/status/"

NOTHING = dict(
    AGENT_ENABLED=False, AGENT_SWARM_ENABLED=False, ANTHROPIC_API_KEY="", OPENAI_API_KEY="",
    GEMINI_API_KEY="", PERPLEXITY_API_KEY="", XAI_API_KEY="", SERPAPI_KEY="", SCRAPERAPI_KEY="",
    SERP_PROVIDER="", DEBUG=False,
)
READY = dict(
    NOTHING, AGENT_ENABLED=True, AGENT_SWARM_ENABLED=True, ANTHROPIC_API_KEY="sk-ant-test",
    OPENAI_API_KEY="sk-test", SERPAPI_KEY="serp-test",
)


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


def _status(user, query=""):
    resp = client_for(user).get(URL + query)
    assert resp.status_code == 200, resp.content
    return data(resp)


def _codes(body):
    return [i["code"] for i in body["setup"]["issues"]]


@override_settings(**NOTHING)
def test_nothing_set_up_reads_as_plain_issues_for_a_customer(user):
    body = _status(user)
    engine = body["engines"][0]
    assert engine == {"key": "chatgpt", "provider": "gpt4", "label": "ChatGPT",
                      "configured": False, "key_setting": "", "reason": "not_configured"}
    assert body["google"] == {"configured": False, "provider": "", "label": "",
                              "key_settings": [], "reliable_pages": 0}
    assert _codes(body) == [
        "agent_disabled", "agent_not_configured", "research_disabled",
        "engine_not_configured", "engine_not_configured", "engine_not_configured",
        "engine_not_configured", "engine_not_configured", "no_engines", "google_not_configured",
    ]
    issues = body["setup"]["issues"]
    chatgpt = next(i for i in issues if i["engine"] == "chatgpt")
    assert chatgpt == {
        "code": "engine_not_configured", "severity": "limited", "subject": "engine",
        "engine": "chatgpt", "setting": None, "title": "ChatGPT isn't set up on this workspace.",
        "action": "ChatGPT is skipped; the other engines still answer.",
    }
    # No setting name and no dollar amount reaches a customer.
    assert all(i["setting"] is None for i in issues)
    assert not any("_KEY" in i["title"] + i["action"] for i in issues)
    assert body["setup"]["ready"] is False
    assert next(i for i in issues if i["code"] == "no_engines")["severity"] == "blocking"
    assert body["research"] == {"available": False, "reason": "agent_disabled",
                                "message": "The AI agent is turned off on this workspace."}


@override_settings(**NOTHING)
def test_staff_see_the_setting_names(django_user_model):
    staff = make_user(django_user_model, "staff@example.com", "Staff")
    staff.is_staff = True
    staff.save(update_fields=["is_staff"])
    body = _status(staff)
    assert body["engines"][0]["key_setting"] == "OPENAI_API_KEY"
    assert body["google"]["key_settings"] == ["SERPAPI_KEY", "SCRAPERAPI_KEY"]
    settings_by_code = {(i["code"], i["engine"]): i["setting"] for i in body["setup"]["issues"]}
    assert settings_by_code[("engine_not_configured", "chatgpt")] == "OPENAI_API_KEY"
    assert settings_by_code[("agent_not_configured", None)] == "ANTHROPIC_API_KEY"
    assert settings_by_code[("google_not_configured", None)] == "SERPAPI_KEY or SCRAPERAPI_KEY"


@override_settings(**{**NOTHING, "DEBUG": True})
def test_a_debug_server_shows_the_setting_names_to_everyone(user):
    body = _status(user)
    assert body["engines"][0]["key_setting"] == "OPENAI_API_KEY"


@override_settings(**READY)
def test_a_ready_workspace(user):
    body = _status(user)
    assert body["google"] == {"configured": True, "provider": "serpapi", "label": "SerpAPI",
                              "key_settings": [], "reliable_pages": body["google"]["reliable_pages"]}
    assert body["setup"]["ready"] is True
    # Only the three engines without a key are reported, as limits (Claude
    # shares the agent's Anthropic key).
    assert _codes(body) == ["engine_not_configured"] * 3
    assert body["research"] == {"available": True, "reason": None, "message": ""}
    runs = body["prompt_runs"]
    assert (runs["unlimited"], runs["limit"], runs["remaining"]) == (False, 20, 20)
    assert body["allowance"]["show_usd"] is False


@override_settings(**{**READY, "SERPAPI_KEY": "", "SCRAPERAPI_KEY": "scraper-test"})
def test_scraperapi_reads_page_one_only(user):
    body = _status(user)
    assert body["google"]["provider"] == "scraperapi"
    issue = next(i for i in body["setup"]["issues"] if i["subject"] == "google")
    assert (issue["code"], issue["severity"]) == ("google_page_one_only", "info")


@override_settings(**{**READY, "OPENAI_API_KEY": "", "ANTHROPIC_API_KEY": ""})
def test_google_without_engines_is_a_limit_not_a_block(user):
    body = _status(user)
    issue = next(i for i in body["setup"]["issues"] if i["code"] == "no_engines")
    assert issue["severity"] == "limited"
    assert issue["action"] == "AI answers can't be checked until one is added."


@override_settings(**READY)
def test_the_prompt_runs_issues(user, website):
    use_runs(user, 16, website)
    body = _status(user)
    low = next(i for i in body["setup"]["issues"] if i["subject"] == "prompt_runs")
    assert (low["code"], low["severity"], low["title"]) == (
        "prompt_runs_low", "info", "4 of your 20 free prompt runs are left this month.")
    # The caller says how many it needs: 3 fit, 5 do not.
    assert "prompt_runs_low" not in _codes(_status(user, "?runs_needed=3"))
    assert "prompt_runs_low" in _codes(_status(user, "?runs_needed=5"))
    use_runs(user, 20, website)
    body = _status(user, f"?website_id={website.id}")
    assert "prompt_runs_exhausted" in _codes(body)
    assert body["prompt_runs"]["remaining"] == 0


@override_settings(**READY)
def test_a_paid_account_has_no_runs_issue_and_sees_dollars(user):
    make_paid(user)
    body = _status(user)
    assert body["prompt_runs"]["unlimited"] is True
    assert not [i for i in body["setup"]["issues"] if i["subject"] == "prompt_runs"]
    assert body["allowance"]["show_usd"] is True


@override_settings(**READY, AI_FREE_MONTHLY_CAP_USD=0.10)
def test_a_used_up_allowance_blocks_without_dollars(user):
    from apps.accounts.models import AITokenUsage

    AITokenUsage.objects.create(user=user, module="agent", provider="anthropic",
                                model_name="claude-opus-5-5", estimated_cost_usd=0.20)
    body = _status(user)
    issue = next(i for i in body["setup"]["issues"] if i["code"] == "allowance_exceeded")
    assert (issue["severity"], issue["title"]) == (
        "blocking", "This month's free AI allowance is used up.")
    assert "$" not in issue["title"] + issue["action"]
    assert body["research"]["reason"] == "allowance_exceeded"
    assert body["setup"]["ready"] is False


@override_settings(**READY, AGENT_PROCESS=False)
def test_an_agent_process_that_is_down(user):
    body = _status(user)
    assert "agent_unavailable" in _codes(body)
    assert body["research"]["reason"] == "agent_unavailable"


@override_settings(**READY)
def test_bad_query_values(user, django_user_model):
    stranger = make_user(django_user_model, "stranger@example.com", "Stranger")
    from apps.websites.models import Website

    site = Website.objects.create(user=stranger, url="https://other.example", name="Other")
    resp = client_for(user).get(f"{URL}?website_id={site.id}")
    assert resp.status_code == 404
    resp = client_for(user).get(f"{URL}?runs_needed=lots")
    assert resp.status_code == 400 and error(resp)["code"] == "invalid"
