"""Defects found in the wave 2 review of the workspace half, each pinned by
a test that failed before its fix."""
import json

import pytest

from apps.agent.services import context
from apps.agent.tools.data import brand_facts

pytestmark = pytest.mark.django_db


def _brand_block(website) -> str:
    # As subagents.base.build_user_content writes the <brand> block.
    return json.dumps(brand_facts(website), ensure_ascii=False, indent=1, sort_keys=True)


def test_the_brand_block_stays_within_the_writers_input_bound(user, website):
    # 40 Offerings entries of 4,000 characters each: the context water-fills
    # them into its 24,000 characters, and the offerings mirror used to repeat
    # every body in full (about 165,000 more characters), so a writer request
    # cost far more than the max_usd the status shows (WRITER_INPUT_USD_MAX is
    # an 80,000-character user turn, of which <brand> is about 33,000).
    for i in range(40):
        context.create_entry(
            website, user, section="offerings", title=f"Plan {i}", body=f"{i} " + "x" * 3990,
            references=[{"kind": "page", "url": f"https://northwind.example/plans/{i}"}],
        )

    facts = brand_facts(website)

    assert len(_brand_block(website)) < 40_000
    offerings = facts["offerings"]
    # Every name and URL the ad campaign prompt may use is still there.
    assert [o["name"] for o in offerings][:3] == ["Plan 0", "Plan 1", "Plan 2"]
    assert offerings[0]["url"] == "https://northwind.example/plans/0"
    assert all(o["description"].startswith(o["name"].split()[1] + " ") for o in offerings)


def test_a_long_extra_urls_list_is_refused_without_reading_it_all(user, website, settings,
                                                                  monkeypatch):
    # De-duplicating rebuilt a set of every kept URL for each one sent, so the
    # 150,000 URLs a 2.5 MB body holds took hours on the estimate endpoint.
    from apps.agent.services import context_build
    from apps.insights.services import runs

    settings.ANTHROPIC_API_KEY = "test-key"
    calls = []
    real_key = context.url_key

    def counted(url):
        calls.append(url)
        return real_key(url)

    monkeypatch.setattr(context, "url_key", counted)
    params = {"synthesize": True, "document_ids": None,
              "extra_urls": [f"https://northwind.example/p{i}" for i in range(2_000)]}

    estimate = runs.estimate(website, user, context_build.KEY, params)

    assert estimate["blockers"][0]["code"] == "too_many"
    assert len(calls) < 100


def test_short_offerings_are_mirrored_whole(user, website):
    context.create_entry(website, user, section="offerings", title="Fleet packs", body="48V.",
                         references=[{"kind": "page", "url": "https://northwind.example/fleet"}])

    assert brand_facts(website)["offerings"] == [
        {"name": "Fleet packs", "description": "48V.", "url": "https://northwind.example/fleet"},
    ]
