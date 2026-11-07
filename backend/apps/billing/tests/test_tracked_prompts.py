"""The tracked-prompt cap: counting, wording, the runnable list (backend 2c)."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.billing.services import tracked_prompts
from apps.billing.tests.support import *  # noqa: F403
from apps.billing.tests.support import (
    Plan,
    fresh,
    make_prompt,
    make_website,
    org_with,
    subscribe,
    track,
)
from apps.prompt_library.models import BrandPrompt
from apps.prompt_library.services._hash import text_hash
from core.exceptions import CanseeException

pytestmark = pytest.mark.django_db


def _refusal(website, adding) -> CanseeException:
    with pytest.raises(CanseeException) as exc:
        tracked_prompts.check_capacity(website, adding)
    return exc.value


def test_paywall_off_is_unlimited(user):
    website = make_website(user)
    track(website, 7)
    assert tracked_prompts.capacity(user) == {"limit": -1, "used": 7}
    tracked_prompts.check_capacity(website, 500)


def test_used_counts_active_prompts_on_every_project_of_the_account(user, make_user, paywall):
    track(make_website(user), 2)
    track(make_website(user), 1)
    track(make_website(user), 4, archived=True)
    track(make_website(make_user()), 3)  # someone else's
    assert tracked_prompts.capacity(fresh(user)) == {"limit": 5, "used": 3}


def test_a_soft_deleted_project_does_not_count(user, paywall):
    gone = make_website(user)
    track(gone, 3)
    gone.soft_delete()
    assert tracked_prompts.used_by(user) == 0


def test_an_organization_counts_as_one_tenant(make_user, paywall):
    owner, member = make_user(), make_user()
    org = org_with(owner, member, plan=Plan.FREE)
    track(make_website(owner, organization=org), 2)
    track(make_website(member, organization=org), 2)
    assert tracked_prompts.used_by(fresh(owner)) == 4
    assert tracked_prompts.used_by(fresh(member)) == 4


@pytest.mark.parametrize(("plan", "limit", "next_step"), [
    (None, 5, "Archive some or choose the 100 or 200 prompt plan."),
    (Plan.PROMPTS_100, 100, "Archive some or move to 200 prompts."),
    (Plan.PRO, 100, "Archive some or move to 200 prompts."),
    (Plan.PROMPTS_200, 200, "Archive some to add more."),
])
def test_the_403_wording_per_plan(user, paywall, plan, limit, next_step):
    if plan:
        subscribe(user, plan)
    website = make_website(fresh(user))
    track(website, limit)
    exc = _refusal(website, 2)
    assert (exc.code, exc.status_code) == ("tracked_prompt_limit", 403)
    assert exc.message == (
        f"Your plan tracks up to {limit} prompts and {limit} are tracked. {next_step}")
    assert exc.details == {"limit": limit, "used": limit, "adding": 2}


def test_the_403_wording_in_the_singular(user, paywall):
    website = make_website(user)
    track(website, 1)
    exc = _refusal(website, 5)
    assert exc.message == (
        "Your plan tracks up to 5 prompts and 1 is tracked. "
        "Archive some or choose the 100 or 200 prompt plan.")
    assert exc.details == {"limit": 5, "used": 1, "adding": 5}


def test_up_to_the_limit_passes_and_nothing_to_add_never_refuses(user, paywall):
    website = make_website(user)
    track(website, 3)
    tracked_prompts.check_capacity(website, 2)
    track(website, 2)
    tracked_prompts.check_capacity(website, 0)
    exc = _refusal(website, 1)
    assert exc.details == {"limit": 5, "used": 5, "adding": 1}


def test_the_project_owners_plan_is_the_cap(make_user, paywall):
    owner, other = make_user(), make_user()
    subscribe(other, Plan.PROMPTS_200)
    website = make_website(owner)
    track(website, 5)
    # Only the project's owner (a Free account) decides; nobody else's plan does.
    exc = _refusal(website, 1)
    assert exc.details["limit"] == 5
    subscribe(owner, Plan.PROMPTS_100)
    website.user = fresh(owner)
    tracked_prompts.check_capacity(website, 1)


def test_adding_count(user):
    website = make_website(user)
    active, archived = track(website, 1)[0], track(website, 1, archived=True)[0]
    fresh_prompt = make_prompt("a prompt nobody tracks yet")
    other_site = make_website(user)
    track(other_site, 1)

    count = tracked_prompts.adding_count
    assert count(website) == 0
    assert count(website, prompt_ids=[active.prompt_id]) == 0
    # get_or_create leaves an archived row archived: it adds nothing...
    assert count(website, prompt_ids=[archived.prompt_id]) == 0
    # ...unless the entry point restores it.
    assert count(website, prompt_ids=[archived.prompt_id], restore=True) == 1
    assert count(website, prompt_ids=[fresh_prompt.id, fresh_prompt.id]) == 1
    hashes = [text_hash(active.prompt.text), text_hash("brand new question"),
              text_hash("Brand  new question?")]
    assert count(website, text_hashes=hashes) == 1
    assert count(website, text_hashes=[text_hash(archived.prompt.text)], restore=True) == 1


def test_runnable_prompts_keep_the_accounts_oldest_within_the_cap(user, paywall):
    start = timezone.now() - timedelta(days=3)
    first, second = make_website(user), make_website(user)
    old = track(first, 3, start=start)
    newer = track(second, 4, start=start + timedelta(days=1))
    newest = track(first, 2, start=start + timedelta(days=2))
    track(first, 2, archived=True, start=start - timedelta(days=1))

    runnable, over = tracked_prompts.runnable_brand_prompts(first)
    assert [bp.id for bp in runnable] == [bp.id for bp in old]
    assert over == 2  # its two newest fall outside the account's oldest 5
    assert all(bp.prompt.text for bp in runnable)

    runnable, over = tracked_prompts.runnable_brand_prompts(second)
    assert [bp.id for bp in runnable] == [bp.id for bp in newer[:2]]
    assert over == 2
    assert newest[0].id not in {bp.id for bp in runnable}


def test_runnable_prompts_when_unlimited(user):
    website = make_website(user)
    rows = track(website, 8)
    runnable, over = tracked_prompts.runnable_brand_prompts(website)
    assert [bp.id for bp in runnable] == [bp.id for bp in rows]
    assert over == 0


def test_ties_on_created_at_are_ordered_by_id(user, paywall):
    website = make_website(user)
    rows = track(website, 7)
    same = timezone.now() - timedelta(days=2)
    BrandPrompt.objects.filter(id__in=[bp.id for bp in rows]).update(created_at=same)
    runnable, over = tracked_prompts.runnable_brand_prompts(website)
    assert [bp.id for bp in runnable] == sorted(bp.id for bp in rows)[:5]
    assert over == 2
