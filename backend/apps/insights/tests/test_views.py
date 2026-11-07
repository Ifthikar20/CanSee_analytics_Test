"""The insights API wiring (contract 1b, 5-9): every route, the switch, the
envelope, filter validation, 404s for another project's rows, and the calls
into the crawler, pages, fan-out and product services (stubbed here; their
own tests cover them)."""

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.insights.models import PromptIdea, TrackedProduct
from apps.insights.tests.support import *  # noqa: F403 - fixtures
from apps.insights.tests.support import track

pytestmark = pytest.mark.django_db

UUID = "6f1c0c6e-0000-4000-8000-000000000000"
ROUTES = (
    ("insights-run-options", {}), ("insights-run-estimate", {}), ("insights-runs", {}),
    ("insights-run", {"run_id": UUID}), ("insights-run-cancel", {"run_id": UUID}),
    ("insights-sentiment", {}), ("insights-fact-check", {}), ("insights-competitors", {}),
    ("insights-citations", {}), ("insights-crawler-access", {}), ("insights-pages", {}),
    ("insights-prompt-ideas", {}), ("insights-prompt-idea", {"idea_id": UUID}),
    ("insights-prompt-idea-track", {"idea_id": UUID}), ("insights-fan-outs", {}),
    ("insights-products", {}), ("insights-product", {"product_id": UUID}),
)


def url(name, website, **kwargs):
    return reverse(name, kwargs={"website_id": website.id, **kwargs})


@pytest.mark.parametrize(("name", "kwargs"), ROUTES)
def test_every_route_answers_503_when_insights_are_off(client, website, settings, name, kwargs):
    settings.INSIGHTS_ENABLED = False
    resp = client.generic("GET" if "track" not in name else "POST", url(name, website, **kwargs))
    assert resp.status_code in (503, 405)
    if resp.status_code == 503:
        assert resp.json()["error"]["code"] == "insights_disabled"


def test_routes_need_a_signed_in_member(website, stranger):
    anonymous = APIClient()
    assert anonymous.get(url("insights-sentiment", website)).status_code in (401, 403)
    other = APIClient()
    other.force_authenticate(stranger)
    assert other.get(url("insights-sentiment", website)).status_code == 404


def test_crawler_access_and_pages_call_their_services(client, website, monkeypatch):
    calls = []
    monkeypatch.setattr("apps.insights.services.site_audit.crawler_access",
                        lambda w: calls.append(("crawler", w.id)) or {"you": None})
    monkeypatch.setattr("apps.insights.services.pages.build",
                        lambda w, *, period, filter: calls.append(("pages", period, filter))
                        or {"pages": []})
    resp = client.get(url("insights-crawler-access", website))
    assert resp.status_code == 200 and resp.json() == {"success": True, "data": {"you": None}}
    assert client.get(url("insights-pages", website)).json()["data"] == {"pages": []}
    client.get(url("insights-pages", website), {"period": "7d", "filter": "cited"})
    assert calls == [("crawler", website.id), ("pages", "30d", "all"), ("pages", "7d", "cited")]
    bad = client.get(url("insights-pages", website), {"filter": "popular"})
    assert bad.status_code == 400 and bad.json()["error"]["details"]["field"] == "filter"


def test_fan_outs_validate_the_prompt(client, website, monkeypatch):
    calls = []
    monkeypatch.setattr("apps.insights.services.fanouts.build",
                        lambda w, *, period, engine, prompt_id:
                        calls.append((period, engine, prompt_id)) or {"prompts": []})
    bp = track(website, "best notes app for teams")
    ok = client.get(url("insights-fan-outs", website),
                    {"engine": "claude", "prompt_id": str(bp.prompt_id)})
    assert ok.status_code == 200 and calls == [("30d", "claude", str(bp.prompt_id))]
    assert client.get(url("insights-fan-outs", website), {"prompt_id": UUID}).status_code == 404
    assert client.get(url("insights-fan-outs", website), {"engine": "bing"}).status_code == 400


def test_products_routes(client, website, stranger, monkeypatch):
    from apps.websites.models import Website

    def create(w, user, data):
        return TrackedProduct.objects.create(website=w, name=data["name"], created_by=user)

    def update(product, data):
        product.name = data["name"]
        product.save()
        return product

    monkeypatch.setattr("apps.insights.services.shopping.products_payload",
                        lambda w: {"products": [str(p.id) for p in w.trackedproduct_set.all()]})
    monkeypatch.setattr("apps.insights.services.shopping.product_detail",
                        lambda p: {"id": str(p.id), "name": p.name})
    monkeypatch.setattr("apps.insights.services.shopping.create_product", create)
    monkeypatch.setattr("apps.insights.services.shopping.update_product", update)
    monkeypatch.setattr("apps.insights.services.shopping.archive_product",
                        lambda p: TrackedProduct.objects.filter(id=p.id).update(is_archived=True))

    created = client.post(url("insights-products", website), {"name": "X200"}, format="json")
    assert created.status_code == 201
    pid = created.json()["data"]["id"]
    assert client.get(url("insights-products", website)).json()["data"] == {"products": [pid]}
    one = client.get(url("insights-product", website, product_id=pid))
    assert one.json()["data"] == {"id": pid, "name": "X200"}
    patched = client.patch(url("insights-product", website, product_id=pid), {"name": "X300"},
                           format="json")
    assert patched.json()["data"]["name"] == "X300"
    gone = client.delete(url("insights-product", website, product_id=pid))
    assert gone.status_code == 204 and gone.content == b""
    assert client.get(url("insights-product", website, product_id=pid)).status_code == 404

    other = Website.objects.create(user=stranger, url="https://other.example", name="Other")
    foreign = TrackedProduct.objects.create(website=other, name="Theirs")
    assert client.get(url("insights-product", website,
                          product_id=foreign.id)).status_code == 404


def test_another_projects_idea_is_not_found(client, website, stranger):
    from apps.websites.models import Website

    other = Website.objects.create(user=stranger, url="https://other.example", name="Other")
    idea = PromptIdea.objects.create(website=other, text="x", text_key="x")
    resp = client.patch(url("insights-prompt-idea", website, idea_id=idea.id),
                        {"status": "dismissed"}, format="json")
    assert resp.status_code == 404
    resp = client.post(url("insights-prompt-idea-track", website, idea_id=idea.id),
                       {"confirm": {"ai_usd_max": "1"}}, format="json")
    assert resp.status_code == 404


def test_a_body_that_is_not_an_object_is_invalid(client, website):
    resp = client.post(url("insights-run-estimate", website), ["kind"], format="json")
    assert resp.status_code == 400 and resp.json()["error"]["code"] == "invalid"
