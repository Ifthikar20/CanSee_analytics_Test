"""Migration agent/0003: the old brand context becomes context entries
(design/p2_contract.md 11d), and the reverse removes what it made."""
import importlib

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

from apps.agent.tests.api_support import make_user

BEFORE = [("agent", "0002_swarm_findings")]
AFTER = [("agent", "0003_context_reviews")]
LONG_RULE = ("Never promise a delivery date to a customer before the warehouse confirms the "
             "stock, the carrier and the address, because late deliveries are our top complaint.")

migration = importlib.import_module("apps.agent.migrations.0003_context_reviews")


def _migrate(targets):
    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(targets)
    return executor.loader.project_state(targets).apps


@pytest.fixture
def at_0002():
    apps = _migrate(BEFORE)
    yield apps
    _migrate(AFTER)


@pytest.mark.django_db(transaction=True)
def test_the_old_context_becomes_entries_and_goes_back(at_0002, django_user_model):
    owner = make_user(django_user_model, "owner@example.com", "Site Owner")
    Website = at_0002.get_model("websites", "Website")
    Context = at_0002.get_model("agent", "AgentBrandContext")
    site = Website.objects.create(user_id=owner.id, url="https://www.northwind.example",
                                  name="Northwind")
    Context.objects.create(
        website_id=site.id, audience="Small fleet operators", voice="Plain, practical",
        rules=["Never say cheap.", LONG_RULE, ""],
        offerings=[
            {"name": "Fleet batteries", "description": "48V packs",
             "url": "https://shop.northwind.example/fleet"},
            {"name": "Chargers", "description": "", "url": "https://partner.example/chargers"},
            {"name": "Service", "description": "Yearly checks", "url": ""},
        ],
        revision=3, updated_by_id=owner.id,
    )
    empty = Website.objects.create(user_id=owner.id, url="https://empty.example", name="Empty")
    Context.objects.create(website_id=empty.id, revision=1)

    apps = _migrate(AFTER)
    Entry = apps.get_model("agent", "AgentContextEntry")
    entries = list(Entry.objects.filter(website_id=site.id).order_by("section", "position"))
    rows = [(e.section, e.position, e.title, e.body, e.origin, e.status, e.revision)
            for e in entries]
    clipped = migration._clip_at_word(LONG_RULE, 120)
    assert len(clipped) <= 120 and LONG_RULE.startswith(clipped) and not clipped.endswith(" ")
    assert rows == [
        ("audience", 0, "Audience", "Small fleet operators", "migrated", "active", 1),
        ("execution", 0, "Voice", "Plain, practical", "migrated", "active", 1),
        ("execution", 1, "Never say cheap.", "", "migrated", "active", 1),
        ("execution", 2, clipped, LONG_RULE, "migrated", "active", 1),
        ("offerings", 0, "Fleet batteries", "48V packs", "migrated", "active", 1),
        ("offerings", 1, "Chargers", "Link: https://partner.example/chargers", "migrated",
         "active", 1),
        ("offerings", 2, "Service", "Yearly checks", "migrated", "active", 1),
    ]
    assert {(e.created_by_id, e.updated_by_id) for e in entries} == {(owner.id, owner.id)}
    Reference = apps.get_model("agent", "AgentContextReference")
    refs = list(Reference.objects.filter(website_id=site.id))
    assert [(r.kind, r.url, r.state, r.entry.title) for r in refs] == [
        ("page", "https://shop.northwind.example/fleet", "unchecked", "Fleet batteries")]
    assert not Entry.objects.filter(website_id=empty.id).exists()

    # Running it again changes nothing: a website with entries is skipped.
    Entry.objects.create(website_id=empty.id, section="company", title="Added by hand")
    migration.migrate_context(apps, None)
    assert Entry.objects.filter(website_id=site.id).count() == 7
    assert Entry.objects.filter(website_id=empty.id).count() == 1

    migration.unmigrate_context(apps, None)
    assert not Entry.objects.filter(origin="migrated").exists()
    assert Entry.objects.filter(website_id=empty.id).count() == 1


def test_the_apex_helper_matches_the_apps():
    from apps.citations.services.url_normalizer import extract_apex_domain

    for url, host in (("https://www.northwind.example/x", "www.northwind.example"),
                      ("https://shop.example.co.uk", "shop.example.co.uk"),
                      ("northwind.example", "northwind.example")):
        assert migration._apex(url) == extract_apex_domain(host)
