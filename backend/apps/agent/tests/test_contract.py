"""The shared contract from the backend side: every route, event type,
part type and response shape the frontend relies on, and that every
module of the app imports."""
import importlib
import pkgutil

import pytest
from django.urls import resolve, reverse
from rest_framework.test import APIClient

import apps.agent
from apps.agent.constants import TERMINAL_EVENT_TYPES, EventType, PartType
from apps.agent.tests import contract_support as contract
from apps.agent.tests.api_support import client_for, data
from apps.agent.tests.runtime_support import make_prompt

# ── Routes ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name, kwargs, path, methods", contract.ROUTES,
                         ids=[r[0] for r in contract.ROUTES])
def test_every_contract_route_reverses_resolves_and_has_its_methods(name, kwargs, path,
                                                                     methods):
    url = contract.API + path
    assert reverse(name, kwargs=kwargs) == url
    match = resolve(url)
    assert match.url_name == name
    view_class = getattr(match.func, "view_class", None)
    if view_class is None:
        # The SSE stream is a plain view limited to GET.
        assert methods == {"GET"} and name == "agent-live-stream"
        return
    handlers = {m.upper() for m in ("get", "post", "put", "patch", "delete")
                if hasattr(view_class, m)}
    assert handlers == methods


def test_the_contract_lists_every_agent_route():
    from apps.agent.api.v1 import urls

    assert {p.name for p in urls.urlpatterns} == {r[0] for r in contract.ROUTES}


@pytest.mark.django_db
@pytest.mark.parametrize("name, kwargs, path, methods", contract.ROUTES,
                         ids=[r[0] for r in contract.ROUTES])
def test_every_route_needs_a_signed_in_user(name, kwargs, path, methods):
    client = APIClient()
    for method in methods:
        resp = getattr(client, method.lower())(contract.API + path)
        assert resp.status_code == 401, (method, path, resp.status_code)


def test_agent_endpoints_stay_out_of_the_openapi_schema():
    """Their shapes are the contract's, which the generator cannot read."""
    from drf_spectacular.generators import SchemaGenerator

    paths = SchemaGenerator().get_schema(request=None, public=True)["paths"]
    assert paths and not [p for p in paths if p.startswith(contract.API)]


@pytest.mark.django_db
def test_live_stream_refuses_other_methods(user):
    from rest_framework_simplejwt.tokens import AccessToken

    url = contract.API + f"live/runs/{contract.RID}/stream/"
    auth = {"HTTP_AUTHORIZATION": f"Bearer {AccessToken.for_user(user)}"}
    assert APIClient().post(url, **auth).status_code == 405


# ── Vocabulary ────────────────────────────────────────────────────────────


def test_event_types_match_the_contract():
    values = {v for k, v in vars(EventType).items() if k.isupper()}
    assert values == set(contract.EVENT_PAYLOADS)
    assert set(TERMINAL_EVENT_TYPES) == contract.TERMINAL_EVENTS


def test_part_types_match_the_contract():
    values = {v for k, v in vars(PartType).items() if k.isupper()}
    assert values == set(contract.PART_FIELDS)


# ── Modules ───────────────────────────────────────────────────────────────


def _agent_modules() -> list[str]:
    names = []
    for info in pkgutil.walk_packages(apps.agent.__path__, prefix="apps.agent."):
        if ".tests" in info.name:
            continue
        names.append(info.name)
    return sorted(names)


AGENT_MODULES = _agent_modules()


def test_the_module_walk_found_the_app():
    for name in ("apps.agent.runtime.runner", "apps.agent.api.v1.live_views",
                 "apps.agent.services.browse", "apps.agent.migrations.0001_initial",
                 "apps.agent.management.commands.agent_smoke"):
        assert name in AGENT_MODULES


@pytest.mark.parametrize("name", AGENT_MODULES)
def test_every_agent_module_imports(name):
    importlib.import_module(name)


# ── Shapes ────────────────────────────────────────────────────────────────


@pytest.fixture
def api_env(settings):
    settings.ANTHROPIC_API_KEY = "test-key"


@pytest.mark.django_db
@pytest.mark.usefixtures("api_env")
def test_gunicorn_responses_follow_the_contract_shapes(user, website):
    api = client_for(user)
    site = f"{contract.API}websites/{website.id}/"

    status = data(api.get(contract.API + "status/"))
    assert not contract.missing(contract.STATUS, status)
    assert not contract.missing(contract.ALLOWANCE, status["allowance"])
    assert status["engines"] and all(
        not contract.missing(contract.STATUS_ENGINE, e) for e in status["engines"])

    assert all(not contract.missing(contract.STATUS_WRITER, w)
               for w in status["writers"].values())
    assert status["limits"] == {"run_cost_usd": "3.00"}

    agents = data(api.get(contract.API + "agents/"))
    assert [a["key"] for a in agents] == [
        "gap_analyst", "page_optimizer", "aeo_article", "llms_txt", "comparison_page",
        "landing_page", "ad_campaign", "social_posts", "pr_writer", "messaging_brief"]
    assert [a["output_kind"] for a in agents] == [
        "report", "document", "document", "document", "document", "page", "sheet",
        "document", "document", "document"]
    assert all(not contract.missing(contract.AGENT_ENTRY, a) for a in agents)
    assert all(set(t) == {"key", "label"} for a in agents for t in a["teams"])

    created = api.post(site + "chats/", {}, format="json")
    assert created.status_code == 201
    chat = data(created)
    assert not contract.missing(contract.CHAT_DETAIL, chat)
    assert chat["messages"] == [] and chat["active_run"] is None

    listing = data(api.get(site + "chats/"))
    assert set(listing) == {"results", "next_cursor"}

    context = data(api.get(site + "context/"))
    assert not contract.missing(contract.CONTEXT_OVERVIEW, context)
    assert all(not contract.missing(contract.CONTEXT_SECTION, s) for s in context["sections"])
    assert not contract.missing(contract.CONTEXT_BUILD, context["build"])
    assert context["entries"] == [] and context["totals"]["entries"] == 0
    assert api.put(site + "context/", {}, format="json").status_code == 405

    # No tracked prompts: no suggestions, never invented ones.
    assert data(api.get(site + "suggestions/")) == []
    make_prompt(website, "best crm for startups")
    suggestions = data(api.get(site + "suggestions/"))
    assert all(not contract.missing(contract.SUGGESTION, s) for s in suggestions)

    assert data(api.get(site + "activity/")) == []
    assert data(api.get(site + "artifacts/")) == []
