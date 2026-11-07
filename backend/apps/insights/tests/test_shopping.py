"""Products (p2 backend 9, contract 9): product validation and the limit,
Google Shopping parsing (``serp_google.shopping_search``), matching and list
ranks, the ``shopping_check`` estimate, caps and blockers, a run with a fake
Google Shopping and fake engines whose usage rows carry the run, and the
products and product detail payloads. Nothing reaches the network."""

from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache

from apps.accounts.models import AITokenUsage
from apps.citations.services import serp_google
from apps.insights.models import ShoppingResult, TrackedProduct
from apps.insights.services import runs, shopping
from apps.llm_ranking import providers
from apps.llm_ranking.models import LLMRankingResult
from apps.websites.models import Website
from core.exceptions import CanseeException
from core.llm.base import LLMProvider, ProviderResult

pytestmark = pytest.mark.django_db

QUESTION = "best running shoes for flat feet"
STORED_SHAPE = {
    "search_information": {"query_displayed": QUESTION},
    "shopping_results": [
        {"position": 1, "title": "Generic Runner 2", "source": "Walmart", "price": "$39.00",
         "extracted_price": 39.0, "rating": 4.1},
        {"position": 2, "title": "Trail Pro", "source": "REI", "price": "$59.00",
         "extracted_price": 59},
        {"position": 3, "title": "Acme X200 running shoe", "source": "Acme", "price": "$89.99",
         "extracted_price": 89.99},
        {"position": 4, "title": "acme  x200 (wide)", "source": "Zappos", "price": "$95.00"},
        {"position": 5, "title": "", "source": "Nobody"},
    ],
}
ANSWER = (
    "Here are good picks:\n\n1. Brooks Adrenaline - stable.\n"
    "2. Acme Sports\n   The X200 has arch support.\n3. Hoka Bondi - cushioned.\n"
)


@pytest.fixture(autouse=True)
def fresh(settings, monkeypatch):
    cache.clear()
    settings.SERPAPI_KEY = ""
    settings.SCRAPERAPI_KEY = "scraper-test"
    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    settings.GEMINI_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.PERPLEXITY_API_KEY = ""
    settings.LLM_WEBSEARCH_ENABLED = True
    monkeypatch.setattr(shopping, "RETRY_SECONDS", 0)
    yield
    cache.clear()


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        email="owner@example.com", password="x" * 16, full_name="Fixture Owner",
        is_email_verified=True,
    )


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://acme.example", name="Acme")


def product(website, user, **data) -> TrackedProduct:
    body = {"name": "Acme X200 running shoe", "match_terms": ["X200", "acme"],
            "queries": [QUESTION], **data}
    return shopping.create_product(website, user, body)


# ── products ──────────────────────────────────────────────────────────────


def test_a_product_gets_its_defaults(website, user):
    made = shopping.create_product(website, user, {
        "name": "  Acme   X200 ", "queries": ["  best shoes  for   flat feet ", "Best shoes for flat feet"],
    })

    assert (made.name, made.match_terms, made.queries, made.own_sellers, made.url) == (
        "Acme X200", ["acme x200"], ["best shoes for flat feet"], ["Acme"], "")
    assert made.created_by == user


@pytest.mark.parametrize("data, field", [
    ({"name": ""}, "name"),
    ({"name": "x" * 121}, "name"),
    ({"match_terms": ["a" * 41]}, "match_terms"),
    ({"match_terms": ["a", "b", "c", "d", "e", "f"]}, "match_terms"),
    ({"match_terms": "x200"}, "match_terms"),
    ({"url": "ftp://acme.example/x"}, "url"),
    ({"url": "javascript:alert(1)"}, "url"),
    ({"queries": []}, "queries"),
    ({"queries": ["ab"]}, "queries"),
    ({"queries": ["one q", "two q", "three q", "four q"]}, "queries"),
    ({"own_sellers": ["a"] * 0 + ["s1", "s2", "s3", "s4", "s5", "s6"]}, "own_sellers"),
    ({"own_sellers": ["x" * 81]}, "own_sellers"),
])
def test_invalid_fields_name_their_field(website, user, data, field):
    with pytest.raises(CanseeException) as err:
        product(website, user, **data)
    assert (err.value.code, err.value.status_code, err.value.details["field"]) == (
        "invalid", 400, field)


def test_a_long_name_needs_shorter_match_words(website, user):
    with pytest.raises(CanseeException) as err:
        shopping.create_product(website, user, {"name": "x" * 60, "queries": [QUESTION]})
    assert err.value.details["field"] == "match_terms"


def test_at_most_ten_active_products(website, user, settings):
    settings.SHOPPING_MAX_PRODUCTS = 2
    first = product(website, user)
    product(website, user)

    with pytest.raises(CanseeException) as err:
        product(website, user)
    assert err.value.message == "You can track up to 2 products."

    shopping.archive_product(first)
    assert product(website, user).is_archived is False


def test_patch_changes_only_what_is_sent(website, user):
    made = product(website, user, url="https://acme.example/x200", own_sellers=["Acme", "Acme Outlet"])

    shopping.update_product(made, {"queries": [QUESTION, "trail shoes with arch support"]})
    made.refresh_from_db()

    assert made.queries == [QUESTION, "trail shoes with arch support"]
    assert (made.name, made.match_terms, made.url) == (
        "Acme X200 running shoe", ["x200", "acme"], "https://acme.example/x200")
    assert made.own_sellers == ["Acme", "Acme Outlet"]
    shopping.update_product(made, {"own_sellers": []})
    made.refresh_from_db()
    assert made.own_sellers == []


# ── Google Shopping ───────────────────────────────────────────────────────


class FakeResponse:
    def __init__(self, status=200, data=None, text=None):
        self.status_code = status
        self._data, self._text = data, text

    def json(self):
        if self._text is not None:
            raise ValueError("not JSON")
        return self._data


@pytest.fixture
def scraperapi(monkeypatch):
    calls = []
    answers = []

    def get(url, params=None, timeout=None):
        calls.append((url, dict(params or {}), timeout))
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr("requests.get", get)
    return SimpleNamespace(calls=calls, answers=answers)


def test_shopping_search_reads_the_stored_shape(scraperapi):
    scraperapi.answers.append(FakeResponse(data=STORED_SHAPE))

    found = serp_google.shopping_search(f"  {QUESTION} ")

    url, params, timeout = scraperapi.calls[0]
    assert url == "https://api.scraperapi.com/structured/google/shopping"
    assert params == {"api_key": "scraper-test", "query": QUESTION, "country_code": "us"}
    assert timeout == serp_google.SCRAPERAPI_TIMEOUT
    assert (found["configured"], found["provider"], found["error"]) == (True, "scraperapi", "")
    assert found["results"][2] == {"position": 3, "title": "Acme X200 running shoe",
                                   "seller": "Acme", "price": "$89.99", "price_value": 89.99}
    assert found["results"][3]["price_value"] is None
    assert len(found["results"]) == 4


@pytest.mark.parametrize("answer, error", [
    (FakeResponse(status=429), "http_429"),
    (FakeResponse(text="<html>"), "decode"),
    (FakeResponse(data={"shopping_results": []}), "empty_results"),
    (RuntimeError("connection reset"), "network"),
])
def test_shopping_search_errors(scraperapi, answer, error):
    scraperapi.answers.append(answer)

    assert serp_google.shopping_search(QUESTION)["error"] == error


def test_shopping_needs_scraperapi(settings, scraperapi):
    settings.SERPAPI_KEY = "serp-test"
    settings.SERP_PROVIDER = "serpapi"

    found = serp_google.shopping_search(QUESTION)

    assert (found["configured"], found["error"], found["results"]) == (False, "not_configured", [])
    assert scraperapi.calls == []


# ── matching ──────────────────────────────────────────────────────────────


def test_matching_ignores_case_and_spacing():
    assert shopping.match("The ACME  x200 shoe", ["x200", "acme"])
    assert not shopping.match("The X2000 by someone", ["x200", "acme"])
    assert not shopping.match("anything", [])


def test_the_list_rank_is_the_first_item_naming_the_product():
    assert shopping.list_rank(ANSWER, ["x200", "acme"]) == 2
    assert shopping.list_rank("Acme X200 is great.", ["x200"]) is None
    assert shopping.list_rank("1) Acme X200\n2) Other", ["x200"]) == 1


def test_the_excerpt_surrounds_the_first_match():
    text = "a" * 300 + " Acme X200 " + "b" * 300

    found = shopping.excerpt(text, ["x200"])

    assert "Acme X200" in found and len(found) <= shopping.EXCERPT_CHARS


# ── kind shopping_check ───────────────────────────────────────────────────


def params(*products, engines=("chatgpt", "claude"), google=True):
    return {"product_ids": [str(p.id) for p in products], "engines": list(engines),
            "google_shopping": google}


def test_the_estimate_counts_pages_and_answers(website, user, settings):
    made = product(website, user, queries=[QUESTION, "trail shoes with arch support"])

    est = runs.estimate(website, user, "shopping_check", params(made))

    assert est["units"] == {"products": 1, "google_pages": 2, "answers": 4}
    assert est["ai"]["calls_max"] == 4 and est["ai"]["usd_max"] == "0.3200"
    assert (est["google"]["pages_max"], est["google"]["credits_max"]) == (2, 50)
    assert est["summary"] == "1 product: 2 Google Shopping pages and 4 engine answers"
    assert [w["code"] for w in est["warnings"]] == ["upper_bound"]

    settings.LLM_WEBSEARCH_ENABLED = False
    off = runs.estimate(website, user, "shopping_check", params(made))
    assert off["ai"]["usd_max"] == "0.1200"
    assert [w["code"] for w in off["warnings"]] == ["web_search_off", "upper_bound"]


def test_blockers_and_caps(website, user, settings):
    made = product(website, user)

    def blocker(body):
        est = runs.estimate(website, user, "shopping_check", body)
        return [(b["code"], b["message"]) for b in est["blockers"]]

    assert blocker(params(made, engines=(), google=False)) == [(
        "nothing_to_run", "Choose at least one product and Google Shopping or an engine.")]
    assert blocker({"product_ids": [], "engines": ["chatgpt"]})[0][0] == "nothing_to_run"
    settings.SHOPPING_MAX_ENGINE_ANSWERS = 1
    assert blocker(params(made)) == [("too_many", "This run is over the limit of 1 answers.")]
    settings.SHOPPING_MAX_ENGINE_ANSWERS = 30
    settings.SCRAPERAPI_KEY = ""
    assert blocker(params(made, engines=())) == [(
        "not_configured", "Google Shopping results need ScraperAPI on this server.")]
    with pytest.raises(CanseeException) as err:
        runs.estimate(website, user, "shopping_check", params(made, engines=("grok",)))
    assert err.value.message == "Grok isn't configured on this server."
    other = Website.objects.create(user=user, url="https://other.example", name="Other")
    foreign = product(other, user)
    with pytest.raises(CanseeException) as err:
        runs.estimate(website, user, "shopping_check", params(foreign))
    assert err.value.details["field"] == "product_ids"


def test_more_than_five_products_is_too_many(website, user, settings):
    settings.SHOPPING_MAX_PRODUCTS_PER_RUN = 1
    first, second = product(website, user), product(website, user)

    est = runs.estimate(website, user, "shopping_check", params(first, second))

    assert [b["code"] for b in est["blockers"]] == ["too_many"]
    assert est["blockers"][0]["message"] == "This run is over the limit of 1 products."


class FakeEngine(LLMProvider):
    """A configured engine answering from a script, through the real query()
    (allowance wall, usage ledger)."""

    name = "gpt4"
    model = "gpt-4o-mini"
    api_key_setting = "OPENAI_API_KEY"
    script: dict = {}
    calls: list = []

    def _call(self, *, prompt, system_prompt, region=""):
        FakeEngine.calls.append((self.name, prompt, system_prompt))
        answer = FakeEngine.script.get(self.name, ANSWER)
        if isinstance(answer, Exception):
            raise answer
        return ProviderResult(succeeded=True, text=answer, input_tokens=120, output_tokens=60)


class FakeClaude(FakeEngine):
    name = "claude"
    model = "claude-haiku-4-5"
    api_key_setting = "ANTHROPIC_API_KEY"


@pytest.fixture
def engines(monkeypatch):
    FakeEngine.script = {}
    FakeEngine.calls = []
    monkeypatch.setitem(providers.PROVIDERS, "gpt4", FakeEngine)
    monkeypatch.setitem(providers.PROVIDERS, "claude", FakeClaude)
    return FakeEngine


def test_a_run_checks_google_shopping_and_asks_the_engines(website, user, scraperapi, engines):
    made = product(website, user, own_sellers=["ACME"])
    engines.script = {"claude": "I would pick Brooks or Hoka."}
    scraperapi.answers.append(FakeResponse(data=STORED_SHAPE))
    body = params(made)
    est = runs.estimate(website, user, "shopping_check", body)

    run = runs.create_run(website, user, "shopping_check", body, est["confirm"])

    assert run.status == "done", run.error_message
    assert (run.units_total, run.units_done, run.google_pages) == (3, 3, 1)
    google_row = ShoppingResult.objects.get(run=run, engine="google_shopping")
    assert (google_row.state, google_row.position, google_row.results_count) == ("found", 3, 4)
    assert google_row.sold_by_you is True and google_row.sellers == ["Acme", "Zappos"]
    assert google_row.lowest == {"title": "Generic Runner 2", "seller": "Walmart", "price": "$39.00"}
    assert [m["seller"] for m in google_row.matches] == ["Acme", "Zappos"]
    assert [t["is_match"] for t in google_row.top] == [False, False, True, True]
    chatgpt = ShoppingResult.objects.get(run=run, engine="chatgpt")
    assert (chatgpt.state, chatgpt.rank, chatgpt.model_id) == ("named", 2, "gpt-4o-mini")
    assert "X200" in chatgpt.excerpt
    claude = ShoppingResult.objects.get(run=run, engine="claude")
    assert (claude.state, claude.rank, claude.excerpt) == ("not_named", None, "")
    assert sorted(c[0] for c in engines.calls) == ["claude", "gpt4"]
    assert all(c[1] == QUESTION for c in engines.calls)
    rows = AITokenUsage.objects.filter(user=user)
    assert rows.count() == 2
    assert {r.metadata["audit_id"] for r in rows} == {run.audit_id}
    assert {(r.module, r.metadata["role"], r.metadata["feature"]) for r in rows} == {
        ("insights", "shopping_answer", "shopping")}
    assert run.ai_cost_usd == sum((r.estimated_cost_usd for r in rows), Decimal("0"))
    assert not LLMRankingResult.objects.exists()


def test_failures_are_kept_with_their_reason(website, user, scraperapi, engines):
    made = product(website, user)
    engines.script = {"gpt4": RuntimeError("Request timed out"), "claude": RuntimeError("boom")}
    scraperapi.answers.extend([FakeResponse(status=503), FakeResponse(status=404)])
    body = params(made)

    run = runs.create_run(website, user, "shopping_check", body,
                          runs.estimate(website, user, "shopping_check", body)["confirm"])

    assert run.status == "failed"
    google_row = ShoppingResult.objects.get(run=run, engine="google_shopping")
    assert (google_row.status, google_row.state, google_row.error_code) == (
        "failed", "failed", "serp_failed")
    assert google_row.error_message == "Google search failed (HTTP 404)."
    # The 503 was not billed and was retried; the 404 was billed.
    assert len(scraperapi.calls) == 2 and run.google_pages == 1
    chatgpt = ShoppingResult.objects.get(run=run, engine="chatgpt")
    assert (chatgpt.state, chatgpt.error_code) == ("failed", "engine_error")
    assert chatgpt.error_message == "The engine did not respond in time."
    assert run.error_code in ("engine_error", "serp_failed")
    # Each engine was asked once more after its first failure.
    assert len(engines.calls) == 4


def test_the_allowance_wall_stops_an_answer(website, user, scraperapi, engines, monkeypatch):
    made = product(website, user)
    body = params(made, google=False, engines=("chatgpt",))
    confirm = runs.estimate(website, user, "shopping_check", body)["confirm"]
    monkeypatch.setattr("core.llm.base.allowance_denial",
                        lambda user: "monthly_ai_allowance_exceeded: used up")

    run = runs.create_run(website, user, "shopping_check", body, confirm)

    row = ShoppingResult.objects.get(run=run)
    assert (row.status, row.error_code) == ("failed", "allowance_exceeded")
    assert engines.calls == []


# ── payloads ──────────────────────────────────────────────────────────────


def test_products_payload_before_and_after_a_check(website, user, scraperapi, engines):
    made = product(website, user, url="https://acme.example/x200")
    before = shopping.products_payload(website)

    assert before["limits"] == {"max_products": 10, "max_queries": 3, "max_terms": 5}
    assert before["shopping"] == {"configured": True, "provider_label": "ScraperAPI",
                                  "credits_per_page": 25}
    assert [(e["key"], e["configured"]) for e in before["engines"]] == [
        ("chatgpt", True), ("claude", True), ("gemini", False), ("grok", False),
        ("perplexity", False)]
    assert before["products"][0]["latest"] is None
    assert shopping.product_detail(made)["queries"] == [{
        "query": QUESTION,
        "google": {"state": "not_checked", "position": None, "results": None, "checked_at": None,
                   "error": None, "matches": [], "lowest": None, "top": []},
        "engines": [],
    }]

    scraperapi.answers.append(FakeResponse(data=STORED_SHAPE))
    body = params(made)
    run = runs.create_run(website, user, "shopping_check", body,
                          runs.estimate(website, user, "shopping_check", body)["confirm"])

    latest = shopping.products_payload(website)["products"][0]["latest"]
    assert latest["google"] == {"state": "found", "queries_checked": 1, "queries_found": 1,
                                "best_position": 3, "sold_by_you": True, "sellers": 2}
    assert latest["engines"] == {"answers": 2, "named": 2, "by_engine": {
        "chatgpt": {"answers": 1, "named": 1, "rank": 2},
        "claude": {"answers": 1, "named": 1, "rank": 2}}}
    detail = shopping.product_detail(made)
    query = detail["queries"][0]
    assert (query["google"]["state"], query["google"]["position"], query["google"]["results"]) == (
        "found", 3, 4)
    assert query["google"]["lowest"]["price"] == "$39.00"
    assert [e["key"] for e in query["engines"]] == ["chatgpt", "claude"]
    assert query["engines"][0]["answer_text"] == ANSWER.strip()
    assert detail["history"] == [{"checked_at": detail["history"][0]["checked_at"],
                                  "google_best_position": 3, "engines_named": 2,
                                  "engines_answers": 2}]
    assert detail["latest"] == shopping.products_payload(website)["products"][0]["latest"]
    assert shopping.products_payload(website)["last_run"]["id"] == str(run.id)


def test_without_scraperapi_google_shopping_reads_not_configured(website, user, settings):
    made = product(website, user)
    settings.SCRAPERAPI_KEY = ""

    payload = shopping.products_payload(website)

    assert payload["shopping"] == {"configured": False, "provider_label": None,
                                   "credits_per_page": None}
    assert shopping.product_detail(made)["queries"][0]["google"]["state"] == "not_configured"
