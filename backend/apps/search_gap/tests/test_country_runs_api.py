"""The country check endpoints: create (202, one cell per prompt x country x
engine), the 2h errors, tenancy, the runs list and detail, Stop, a cell's
detail, options, and the feature switch."""
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.search_gap.models import CountryCheckResult, CountryCheckRun
from apps.search_gap.services import country_checks
from apps.search_gap.tests.country_support import *  # noqa: F403
from apps.search_gap.tests.country_support import (
    BRAND,
    answer,
    body_for,
    data,
    make_cell,
    make_prompt,
    make_run,
    start_queued,
)

pytestmark = pytest.mark.django_db


def url(name, website, **kwargs):
    return reverse(name, kwargs={"website_id": website.id, **kwargs})


@pytest.fixture
def prompts(website):
    return [make_prompt(website, "best crm for startups"), make_prompt(website, "crm for teams")]


@pytest.fixture
def ready(fake_serp, engines, extraction):
    engines.enable("chatgpt", "claude")
    return engines


def _confirmed(api, website, body):
    resp = api.post(url("search-gap-country-estimate", website), body, format="json")
    assert resp.status_code == 200, resp.json()
    return {**body, "confirm": data(resp)["confirm"]}


def _error(resp, status, code):
    assert resp.status_code == status, resp.json()
    error = resp.json()["error"]
    assert error["code"] == code
    return error


def test_url_names(website):
    base = f"/api/v1/search-gap/websites/{website.id}/countries/"
    rid = "0b8e8c5e-1d7a-4c8e-9a1c-2f0d5f8a9b10"
    assert url("search-gap-countries", website) == base
    assert url("search-gap-country-options", website) == f"{base}options/"
    assert url("search-gap-country-estimate", website) == f"{base}estimate/"
    assert url("search-gap-country-runs", website) == f"{base}runs/"
    assert url("search-gap-country-run", website, run_id=rid) == f"{base}runs/{rid}/"
    assert url("search-gap-country-run-cancel", website, run_id=rid) == f"{base}runs/{rid}/cancel/"
    assert url("search-gap-country-result", website, result_id=rid) == f"{base}results/{rid}/"


def test_create_runs_every_cell_and_answers_202(api, website, user, prompts, ready):
    body = _confirmed(api, website, body_for(prompts, ["gb", "de"], ["chatgpt", "claude"]))

    resp = api.post(url("search-gap-country-runs", website), body, format="json")

    assert resp.status_code == 202, resp.json()
    run = data(resp)
    assert run["status"] == "done"
    assert run["progress"] == {"total": 12, "queued": 0, "running": 0, "done": 12, "failed": 0,
                               "skipped": 0, "cancelled": 0}
    assert run["countries"] == [
        {"country": "gb", "name": "United Kingdom", "status": "done", "google_method": "google_setting",
         "google_method_label": "Google set to GB, US connection"},
        {"country": "de", "name": "Germany", "status": "done", "google_method": "google_setting",
         "google_method_label": "Google set to DE, US connection"},
    ]
    assert run["prompts"] == [{"prompt_id": str(bp.prompt_id), "text": bp.prompt.text} for bp in prompts]
    assert run["engines"] == [
        {"key": "chatgpt", "label": "ChatGPT", "method": "asked",
         "method_label": "Asked to answer for each country"},
        {"key": "claude", "label": "Claude", "method": "asked",
         "method_label": "Asked to answer for each country"},
    ]
    assert (run["include_google"], run["google_pages"], run["provider"]) == (True, 1, "scraperapi")
    assert run["confirmed"] == {"google_pages": 4, "engine_answers": 8, "ai_usd_max": "0.2400"}
    assert run["cost"]["google_pages_fetched"] == 4 and run["cost"]["scraperapi_credits"] == 100
    assert run["cost"]["google_usd"] == "0.0000"
    assert run["cost"]["ai_usd"] != "0.0000"
    assert run["created_by_name"] == "Site Owner"
    assert run["cancel_requested"] is False and run["error"] is None
    assert isinstance(run["duration_ms"], int)
    assert run["created_at"].endswith("Z") and run["finished_at"].endswith("Z")
    assert "results" not in run

    saved = CountryCheckRun.objects.get(id=run["id"])
    assert saved.created_by == user and saved.countries == ["gb", "de"]
    assert saved.prompt_ids == [str(bp.prompt_id) for bp in prompts]
    cells = CountryCheckResult.objects.filter(run=saved)
    assert cells.count() == 12
    assert set(cells.values_list("engine", flat=True)) == {"google", "chatgpt", "claude"}


def test_a_larger_confirmation_is_accepted(api, website, prompts, ready):
    body = _confirmed(api, website, body_for(prompts, ["gb"], ["chatgpt"]))
    body["confirm"] = {"google_pages": 10, "engine_answers": 10, "ai_usd_max": "1.00"}

    assert api.post(url("search-gap-country-runs", website), body, format="json").status_code == 202


def test_estimate_changed(api, website, prompts, ready):
    body = _confirmed(api, website, body_for(prompts, ["gb", "de"], ["chatgpt", "claude"]))
    for change in ({"engine_answers": 7}, {"google_pages": 3}, {"ai_usd_max": "0.1599"}):
        changed = {**body, "confirm": {**body["confirm"], **change}}

        error = _error(api.post(url("search-gap-country-runs", website), changed, format="json"),
                       409, "estimate_changed")

        assert error["message"] == "The cost changed. Check the new estimate and confirm again."
        assert error["details"]["estimate"]["confirm"] == body["confirm"]
    assert not CountryCheckRun.objects.exists()


def test_a_confirmation_is_required(api, website, prompts, ready):
    resp = api.post(url("search-gap-country-runs", website), body_for(prompts), format="json")

    assert _error(resp, 400, "invalid")["details"]["field"] == "confirm"


@pytest.mark.parametrize("amount", ["1e30", 1e30, "Infinity", "-0.01"])
def test_a_confirmation_that_is_no_amount_is_invalid(api, website, prompts, ready, amount):
    # 1e30 passes "at least the estimate" but cannot be kept at 4 places:
    # a 400, not a server error.
    body = _confirmed(api, website, body_for(prompts, ["gb"], ["chatgpt"]))
    body["confirm"] = {**body["confirm"], "ai_usd_max": amount}

    resp = api.post(url("search-gap-country-runs", website), body, format="json")

    assert _error(resp, 400, "invalid")["details"]["field"] == "confirm"
    assert not CountryCheckRun.objects.exists()


def test_one_active_check_per_website(api, website, user, prompts, ready):
    body = _confirmed(api, website, body_for(prompts, ["gb"], ["chatgpt"]))
    active = make_run(website, user, status="running")

    error = _error(api.post(url("search-gap-country-runs", website), body, format="json"),
                   409, "run_in_progress")

    assert error["details"] == {"run_id": str(active.id)}
    assert error["message"] == "A country check is running for this project."


def test_daily_limit(api, website, prompts, ready):
    body = _confirmed(api, website, body_for(prompts, ["gb", "de"], ["chatgpt"]))
    country_checks.google_quota().consume(str(website.id), 99)

    error = _error(api.post(url("search-gap-country-runs", website), body, format="json"),
                   409, "daily_limit")

    assert error["details"] == {"left": 1, "need": 4}


def test_allowance_errors(api, website, prompts, ready, monkeypatch):
    from core import ai_tracking

    body = _confirmed(api, website, body_for(prompts, ["gb", "de"], ["chatgpt", "claude"]))
    monkeypatch.setattr(ai_tracking, "effective_ai_cap", lambda user: 5.0)
    monkeypatch.setattr(ai_tracking, "month_to_date_cost", lambda user: 4.9)

    error = _error(api.post(url("search-gap-country-runs", website), body, format="json"),
                   403, "insufficient_allowance")
    assert error["details"] == {"need_usd": "0.2400", "left_usd": "0.10", "cap_usd": "5.00"}

    monkeypatch.setattr(ai_tracking, "month_to_date_cost", lambda user: 5.0)
    _error(api.post(url("search-gap-country-runs", website), body, format="json"),
           403, "allowance_exceeded")
    assert not CountryCheckRun.objects.exists()


def test_caps_and_an_empty_check_are_400(api, website, prompts, ready, settings):
    settings.COUNTRY_CHECK_MAX_ENGINE_ANSWERS = 3
    body = {**body_for(prompts, ["gb", "de"], ["chatgpt"]),
            "confirm": {"google_pages": 4, "engine_answers": 4, "ai_usd_max": "0.08"}}
    _error(api.post(url("search-gap-country-runs", website), body, format="json"),
           400, "too_many_answers")

    settings.COUNTRY_CHECK_MAX_GOOGLE_PAGES = 3
    _error(api.post(url("search-gap-country-runs", website), body, format="json"),
           400, "too_many_google_pages")

    empty = {**body_for(prompts, ["gb"], []), "include_google": False,
             "confirm": {"google_pages": 0, "engine_answers": 0, "ai_usd_max": "0"}}
    _error(api.post(url("search-gap-country-runs", website), empty, format="json"),
           400, "nothing_to_check")


def test_viewers_and_strangers_get_404(website, user, prompts, ready, django_user_model):
    run = make_run(website, user, prompts=prompts)
    cell = make_cell(run, prompts[0], "gb", "chatgpt", mentioned=True)
    org = Organization.objects.create(name="Acme", slug="acme", owner=user)
    website.organization = org
    website.save(update_fields=["organization"])
    viewer = django_user_model.objects.create_user(email="viewer@example.com", password="x" * 16)
    OrganizationMember.objects.create(organization=org, user=viewer, role="viewer")
    stranger = get_user_model().objects.create_user(email="stranger@example.com", password="x" * 16)

    requests = [
        ("get", url("search-gap-countries", website)),
        ("get", url("search-gap-country-options", website)),
        ("post", url("search-gap-country-estimate", website)),
        ("get", url("search-gap-country-runs", website)),
        ("post", url("search-gap-country-runs", website)),
        ("get", url("search-gap-country-run", website, run_id=run.id)),
        ("post", url("search-gap-country-run-cancel", website, run_id=run.id)),
        ("get", url("search-gap-country-result", website, result_id=cell.id)),
    ]
    for person in (viewer, stranger):
        client = APIClient()
        client.force_authenticate(person)
        for method, path in requests:
            resp = getattr(client, method)(path, body_for(prompts), format="json")
            assert resp.status_code == 404, (person.email, path)


def test_runs_list_newest_first_at_most_20(api, website, user):
    now = timezone.now()
    for age in range(22):
        run = make_run(website, user)
        CountryCheckRun.objects.filter(id=run.id).update(created_at=now - timedelta(minutes=age))

    rows = data(api.get(url("search-gap-country-runs", website)))

    assert len(rows) == 20
    created = [r["created_at"] for r in rows]
    assert created == sorted(created, reverse=True)
    assert "prompts" not in rows[0] and "engines" not in rows[0]
    assert set(rows[0]) >= {"id", "status", "countries", "progress", "cost", "error"}


def test_run_detail_lists_its_cells(api, website, prompts, ready):
    body = _confirmed(api, website, body_for(prompts, ["gb"], ["chatgpt"]))
    run_id = data(api.post(url("search-gap-country-runs", website), body, format="json"))["id"]

    run = data(api.get(url("search-gap-country-run", website, run_id=run_id)))

    assert run["id"] == run_id and run["status"] == "done"
    assert [(c["prompt_id"], c["engine"]) for c in run["results"]] == [
        (str(prompts[0].prompt_id), "google"), (str(prompts[0].prompt_id), "chatgpt"),
        (str(prompts[1].prompt_id), "google"), (str(prompts[1].prompt_id), "chatgpt"),
    ]
    google = run["results"][0]
    assert google["state"] == "not_found" and google["depth"] == 10
    assert google["method_label"] == "Google set to GB, US connection"
    engine = run["results"][1]
    assert (engine["method"], engine["method_label"]) == ("asked", "Asked to answer for GB")
    assert engine["position"] is None and engine["pages_fetched"] == 0

    missing = url("search-gap-country-run", website, run_id="0b8e8c5e-1d7a-4c8e-9a1c-2f0d5f8a9b10")
    assert _error(api.get(missing), 404, "not_found")


def test_cancel_is_idempotent(api, website, user, prompts, ready, settings):
    run = start_queued(website, user, body_for(prompts, ["gb"], ["chatgpt"]), settings)
    path = url("search-gap-country-run-cancel", website, run_id=run.id)

    first = data(api.post(path, {}, format="json"))
    again = data(api.post(path, {}, format="json"))

    assert first["status"] == again["status"] == "cancelled"
    assert first["cancel_requested"] is True
    assert first["progress"]["cancelled"] == first["progress"]["total"] == 4
    assert first["finished_at"] == again["finished_at"]
    cell = CountryCheckResult.objects.filter(run=run).first()
    assert (cell.error_code, cell.error_message) == ("cancelled", "Stopped before it ran.")

    done = make_run(website, user)
    assert data(api.post(url("search-gap-country-run-cancel", website, run_id=done.id), {},
                         format="json"))["status"] == "done"


def test_cell_detail(api, website, prompts, ready, engines):
    engines.script("chatgpt", answer(f"1. Acme CRM - pipelines.\n2. {BRAND} - small teams.",
                                     citations=["https://www.g2.example/crm"]))
    body = _confirmed(api, website, body_for(prompts[:1], ["gb"], ["chatgpt"]))
    run_id = data(api.post(url("search-gap-country-runs", website), body, format="json"))["id"]
    google = CountryCheckResult.objects.get(run_id=run_id, engine="google")
    chatgpt = CountryCheckResult.objects.get(run_id=run_id, engine="chatgpt")

    detail = data(api.get(url("search-gap-country-result", website, result_id=chatgpt.id)))

    assert detail["state"] == "ok" and detail["rank"] == 2 and detail["mentioned"] is True
    assert detail["answer_text"].startswith("1. Acme CRM")
    assert detail["brands"] == [{"name": "Acme CRM", "position": 1}]
    assert detail["citations"] == ["https://www.g2.example/crm"]
    assert (detail["model_id"], detail["extraction_model"]) == ("fake-gpt4", "claude-haiku-4-5")
    assert (detail["prompt_text"], detail["country_name"]) == ("best crm for startups", "United Kingdom")
    assert detail["top_results"] is None

    detail = data(api.get(url("search-gap-country-result", website, result_id=google.id)))
    assert len(detail["top_results"]) == 10 and detail["answer_text"] is None
    assert detail["ai_overview"] == {"shown": False, "content_captured": True,
                                     "mentions_you": False, "cites_you": False}


def test_options(api, website, user, prompts, engines):
    engines.enable("chatgpt", "perplexity")
    make_prompt(website, "an archived prompt", archived=True)
    last = make_run(website, user, prompts=prompts)

    options = data(api.get(url("search-gap-country-options", website)))

    assert options["enabled"] is True
    assert options["limits"] == {"max_countries": 5, "max_prompts": 10, "max_pages": 2,
                                 "max_google_pages": 50, "max_engine_answers": 100}
    # No Google key on this server.
    assert options["google"] == {"configured": False, "provider": None, "provider_label": None,
                                 "credits_per_page": None, "usd_per_page": None,
                                 "daily": {"limit": 100, "used": 0, "left": 100}}
    assert [e["key"] for e in options["engines"]] == ["chatgpt", "claude", "gemini", "grok", "perplexity"]
    chatgpt, perplexity = options["engines"][0], options["engines"][4]
    assert chatgpt == {"key": "chatgpt", "label": "ChatGPT", "configured": True, "method": "asked",
                       "method_label": "Asked to answer for each country", "usd_per_answer_max": "0.0300"}
    assert (perplexity["method"], perplexity["usd_per_answer_max"]) == ("searched", "0.0300")
    assert options["engines"][1]["configured"] is False
    assert len(options["countries"]) == 73
    names = [c["name"] for c in options["countries"]]
    assert names == sorted(names)
    assert {"country": "gb", "name": "United Kingdom", "google_method": None,
            "google_method_label": None} in options["countries"]
    assert options["prompts"] == [
        {"prompt_id": str(bp.prompt_id), "text": bp.prompt.text, "location": ""} for bp in prompts
    ]
    assert options["allowance"] == {"unlimited": False, "cap_usd": "1.00", "spent_usd": "0.00",
                                    "left_usd": "1.00"}
    assert options["active_run"] is None and options["last_run"]["id"] == str(last.id)


def test_options_with_scraperapi(api, website, scraperapi):
    country_checks.google_quota().consume(str(website.id), 12)

    google = data(api.get(url("search-gap-country-options", website)))["google"]

    assert google == {"configured": True, "provider": "scraperapi", "provider_label": "ScraperAPI",
                      "credits_per_page": 25, "usd_per_page": "0.0000",
                      "daily": {"limit": 100, "used": 12, "left": 88}}


def test_turned_off(api, website, user, prompts, ready, settings):
    run = make_run(website, user, prompts=prompts)
    cell = make_cell(run, prompts[0], "gb", "chatgpt", mentioned=False)
    settings.COUNTRY_CHECKS_ENABLED = False

    assert data(api.get(url("search-gap-country-options", website)))["enabled"] is False
    for method, path in (
        ("post", url("search-gap-country-estimate", website)),
        ("post", url("search-gap-country-runs", website)),
        ("post", url("search-gap-country-run-cancel", website, run_id=run.id)),
        ("get", url("search-gap-country-result", website, result_id=cell.id)),
    ):
        error = _error(getattr(api, method)(path, body_for(prompts), format="json"),
                       503, "country_checks_disabled")
        assert error["message"] == "Country checks are turned off on this server."
    assert api.get(url("search-gap-country-runs", website)).status_code == 200
    assert api.get(url("search-gap-countries", website)).status_code == 200
    assert api.get(url("search-gap-country-run", website, run_id=run.id)).status_code == 200
