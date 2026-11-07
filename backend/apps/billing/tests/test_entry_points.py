"""Every place a prompt becomes tracked refuses past the cap, all or nothing
(backend 2d). Paywall on: an account without a subscription is Free (5)."""
from types import SimpleNamespace

import pytest
from django.urls import reverse

from apps.billing.tests.support import *  # noqa: F403
from apps.billing.tests.support import (
    Plan,
    client_for,
    data,
    error,
    fresh,
    make_prompt,
    make_website,
    org_with,
    subscribe,
    track,
)
from apps.prompt_library.models import BrandPrompt, Industry, Prompt
from core.exceptions import CanseeException

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("paywall")]

FULL = "Your plan tracks up to 5 prompts and 5 are tracked. " \
       "Archive some or choose the 100 or 200 prompt plan."


def _refused(resp, adding: int, used: int = 5):
    assert resp.status_code == 403, resp.content
    err = error(resp)
    assert err["code"] == "tracked_prompt_limit"
    assert err["details"] == {"limit": 5, "used": used, "adding": adding}
    return err


def _active(website) -> int:
    return BrandPrompt.objects.filter(website=website, is_archived=False).count()


# -- brand prompts (add one by id) ------------------------------------------------


def test_add_by_id(user, website):
    track(website, 5)
    new = make_prompt("best crm for a dental practice")
    url = reverse("prompt-library-brand-prompts", kwargs={"website_id": website.id})
    client = client_for(user)

    err = _refused(client.post(url, {"prompt_id": str(new.id)}, format="json"), adding=1)
    assert err["message"] == FULL
    assert not BrandPrompt.objects.filter(website=website, prompt=new).exists()

    # Already tracked, or archived (get_or_create leaves it archived): adds nothing.
    tracked = BrandPrompt.objects.filter(website=website).first()
    assert client.post(url, {"prompt_id": str(tracked.prompt_id)}, format="json").status_code == 200
    archived = track(website, 1, archived=True)[0]
    resp = client.post(url, {"prompt_id": str(archived.prompt_id)}, format="json")
    assert resp.status_code == 200 and data(resp)["is_archived"] is True


# -- the Add prompts create endpoint ----------------------------------------------------


def _create_url(website):
    return reverse("prompt-library-website-prompts", kwargs={"website_id": website.id})


def test_create_is_all_or_nothing(user, website):
    track(website, 4)
    prompts_before, industries_before = Prompt.objects.count(), Industry.objects.count()
    resp = client_for(user).post(_create_url(website), {
        "text": "best crm for plumbers\ncrm with whatsapp inbox", "topic": "Brand new topic",
    }, format="json")
    _refused(resp, adding=2, used=4)
    assert _active(website) == 4
    assert (Prompt.objects.count(), Industry.objects.count()) == (prompts_before, industries_before)


def test_create_counts_only_new_prompts(user, website, monkeypatch):
    rows = track(website, 4)
    calls = []
    monkeypatch.setattr(
        "apps.prompt_library.api.v1.views.WebsitePromptCreateView._trigger_scan",
        staticmethod(lambda *a, **k: calls.append(a) or ("audit-id", None)),
    )
    existing = rows[0].prompt.text
    resp = client_for(user).post(_create_url(website), {
        "text": f"{existing}\n{existing.upper()}?\nbest crm for florists",
    }, format="json")
    assert resp.status_code == 201
    assert _active(website) == 5
    assert data(resp)["scan_audit_id"] == "audit-id" and len(calls) == 1


def test_scan_false_tracks_without_a_scan(user, website, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "apps.prompt_library.api.v1.views.WebsitePromptCreateView._trigger_scan",
        staticmethod(lambda *a, **k: calls.append(a) or ("audit-id", None)),
    )
    resp = client_for(user).post(_create_url(website), {
        "text": "best crm for florists", "scan": False,
    }, format="json")
    assert resp.status_code == 201
    body = data(resp)
    assert (body["scan_audit_id"], body["scan_error"], body["created_count"]) == (None, None, 1)
    assert calls == []
    assert BrandPrompt.objects.filter(website=website, prompt__text="best crm for florists").exists()


def test_create_counts_re_adding_an_archived_prompt(user, website, monkeypatch):
    # The create view un-archives a re-added prompt, so at the cap it must
    # refuse just as restoring through the archive toggle does.
    monkeypatch.setattr(
        "apps.prompt_library.api.v1.views.WebsitePromptCreateView._trigger_scan",
        staticmethod(lambda *a, **k: ("audit-id", None)),
    )
    track(website, 5)
    (archived,) = track(website, 1, archived=True)
    resp = client_for(user).post(_create_url(website), {
        "text": archived.prompt.text, "scan": False,
    }, format="json")
    _refused(resp, adding=1)
    archived.refresh_from_db()
    assert archived.is_archived is True
    assert _active(website) == 5


def test_create_re_adds_an_archived_prompt_within_the_cap(user, website, monkeypatch):
    monkeypatch.setattr(
        "apps.prompt_library.api.v1.views.WebsitePromptCreateView._trigger_scan",
        staticmethod(lambda *a, **k: ("audit-id", None)),
    )
    track(website, 4)
    (archived,) = track(website, 1, archived=True)
    resp = client_for(user).post(_create_url(website), {
        "text": archived.prompt.text, "scan": False,
    }, format="json")
    assert resp.status_code == 201, resp.content
    archived.refresh_from_db()
    assert archived.is_archived is False
    assert _active(website) == 5


# -- archive and restore ------------------------------------------------------------------


def test_restoring_counts_and_archiving_never_refuses(user, website):
    track(website, 5)
    archived = track(website, 1, archived=True)[0]
    client = client_for(user)
    url = reverse("prompt-library-brand-prompt-detail", kwargs={"brand_prompt_id": archived.id})

    _refused(client.patch(url, {"is_archived": False}, format="json"), adding=1)
    archived.refresh_from_db()
    assert archived.is_archived is True

    active = BrandPrompt.objects.filter(website=website, is_archived=False).first()
    other = reverse("prompt-library-brand-prompt-detail", kwargs={"brand_prompt_id": active.id})
    assert client.patch(other, {"is_archived": True}, format="json").status_code == 200
    resp = client.patch(url, {"is_archived": False}, format="json")
    assert resp.status_code == 200 and data(resp)["is_archived"] is False
    # Leaving an active prompt active is not adding one.
    assert client.patch(url, {"is_archived": False}, format="json").status_code == 200


# -- suggestions ------------------------------------------------------------------------------


def test_accepting_a_suggestion(user, website):
    track(website, 5)
    suggestion = make_prompt("crm for a small bakery")
    client = client_for(user)
    url = reverse("prompt-library-website-suggestion-action", kwargs={
        "website_id": website.id, "prompt_id": suggestion.id, "action": "accept"})
    _refused(client.post(url), adding=1)
    assert not BrandPrompt.objects.filter(website=website, prompt=suggestion).exists()
    reject = reverse("prompt-library-website-suggestion-action", kwargs={
        "website_id": website.id, "prompt_id": suggestion.id, "action": "reject"})
    assert client.post(reject).status_code == 200


def test_bulk_accept_is_all_or_nothing(user, website):
    track(website, 3)
    picks = [make_prompt(f"crm question for bulk {n}") for n in range(3)]
    url = reverse("prompt-library-website-suggestion-bulk", kwargs={
        "website_id": website.id, "action": "accept"})
    client = client_for(user)
    _refused(client.post(url, {"prompt_ids": [str(p.id) for p in picks]}, format="json"),
             adding=3, used=3)
    assert _active(website) == 3
    resp = client.post(url, {"prompt_ids": [str(p.id) for p in picks[:2]]}, format="json")
    assert resp.status_code == 200 and data(resp) == {"accepted": 2}
    assert _active(website) == 5


# -- generated samples ---------------------------------------------------------------------------


def test_generated_samples_link_only_what_fits(user, website, monkeypatch):
    from apps.prompt_library.services import sample_prompts

    track(website, 3)
    items = [{"text": f"generated crm question {n}", "type": "category"} for n in range(4)]
    monkeypatch.setattr(sample_prompts, "build_sample_prompts",
                        lambda website, count, user: {"items": items, "source": "description"})
    url = reverse("prompt-library-generate-samples", kwargs={"website_id": website.id})
    resp = client_for(user).post(url, {"count": 4}, format="json")
    assert resp.status_code == 201
    body = data(resp)
    assert (body["limited"], body["created_count"], body["total"]) == (True, 2, 4)
    assert _active(website) == 5

    # Nothing left out: limited is false.
    monkeypatch.setattr(sample_prompts, "build_sample_prompts",
                        lambda website, count, user: {"items": items[:1], "source": "description"})
    body = data(client_for(user).post(url, {"count": 1}, format="json"))
    assert body["limited"] is False


def test_the_registrar_never_raises_and_keeps_its_signature(user, website):
    from apps.llm_ranking.services.prompt_registrar import (
        register_generated_prompts,
        register_within_plan,
    )

    track(website, 4)
    # One fits; the second is left out; the repeat is already linked; "" is skipped.
    items = [{"text": "registrar question one"}, {"text": "registrar question two"},
             {"text": "registrar question one"}, {"text": ""}]
    assert register_within_plan(items, website) == (1, 1)
    assert _active(website) == 5
    assert register_generated_prompts([{"text": "registrar question one"}], website) == 0
    assert register_within_plan([], website) == (0, 0)


# -- the agent and prompt research ---------------------------------------------------------------


def _agent_track(website, texts, monkeypatch):
    from apps.agent.tools import research
    from apps.agent.tools.schemas import TrackPromptsInput

    monkeypatch.setattr(research, "_shown_to_user",
                        lambda ctx: research.query_key(" ".join(texts)))
    args = TrackPromptsInput(prompts=[{"text": t} for t in texts])
    return research.track_prompts(SimpleNamespace(website=website), args)


def test_the_agent_tracks_nothing_past_the_cap(website, monkeypatch):
    from apps.agent.tools.context import ToolError

    track(website, 4)
    archived = track(website, 1, archived=True)[0]
    texts = ["agent crm question one", archived.prompt.text]
    with pytest.raises(ToolError) as exc:
        _agent_track(website, texts, monkeypatch)
    # Restoring the archived prompt counts as adding one.
    assert exc.value.message == (
        "Your plan tracks up to 5 prompts and 4 are tracked. "
        "Archive some or choose the 100 or 200 prompt plan.")
    assert _active(website) == 4
    assert not Prompt.objects.filter(text="agent crm question one").exists()

    result = _agent_track(website, texts[:1], monkeypatch)
    assert result.is_error is False
    assert _active(website) == 5


def test_tracking_a_prompt_idea_past_the_cap(user, website, settings):
    from apps.insights.models import PromptIdea
    from apps.insights.services import prompt_ideas
    from apps.insights.services.text import idea_key

    settings.OPENAI_API_KEY = "sk-test"
    settings.ANTHROPIC_API_KEY = "test-key"
    track(website, 5)
    idea = PromptIdea.objects.create(
        website=website, text="notes app pricing", text_key=idea_key("notes app pricing"),
        sources=["paa"],
    )
    with pytest.raises(CanseeException) as exc:
        prompt_ideas.track(website, user, idea, {"ai_usd_max": "0.0600"})
    assert (exc.value.code, exc.value.status_code) == ("tracked_prompt_limit", 403)
    assert exc.value.message == FULL
    assert not Prompt.objects.filter(text="notes app pricing").exists()


# -- whose plan ------------------------------------------------------------------------------------


def test_a_member_adding_to_the_owners_project_uses_the_owners_plan(make_user, settings):
    # Org features off, so each account resolves its own subscription.
    settings.ORG_FEATURES_ENABLED = False
    owner, member = make_user(), make_user()
    org = org_with(owner, member, plan=Plan.BUSINESS)
    subscribe(member, Plan.PROMPTS_200)
    website = make_website(owner, organization=org)
    track(website, 5)
    url = reverse("prompt-library-brand-prompts", kwargs={"website_id": website.id})
    new = make_prompt("crm for a law firm")

    _refused(client_for(fresh(member)).post(url, {"prompt_id": str(new.id)}, format="json"),
             adding=1)
    subscribe(owner, Plan.PROMPTS_100)
    resp = client_for(fresh(member)).post(url, {"prompt_id": str(new.id)}, format="json")
    assert resp.status_code == 201
