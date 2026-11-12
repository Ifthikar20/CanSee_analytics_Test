"""Board layout API (board contract 6): the default, saves and their
versions, conflicts both ways, every 400, Reset board, access, and two
users on one project."""

import uuid
from datetime import datetime

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

from apps.accounts.models import Organization, OrganizationMember
from apps.boards.api.v1 import views
from apps.boards.layout import payload
from apps.boards.models import BoardLayout
from apps.websites.models import Website

pytestmark = pytest.mark.django_db

# Ask AI and Prompt ranking (wave 4 contract 6).
DEFAULT = [
    {"key": "watch", "size": "third"},
    {"key": "asked-answered", "size": "third"},
    {"key": "answer-rank", "size": "third"},
    {"key": "visibility-score", "size": "third"},
    {"key": "prompt-box", "size": "full"},
    {"key": "ranking", "size": "full"},
]
DEFAULT_PAYLOAD = {"saved": False, "version": 0, "updated_at": None, "widgets": DEFAULT}
CONFLICT_MESSAGE = "Your board changed in another window."


def make_user(email: str):
    return get_user_model().objects.create_user(
        email=email, password="x" * 16, full_name=email.split("@")[0], is_email_verified=True,
    )


def client_for(user=None) -> APIClient:
    api = APIClient()
    if user is not None:
        api.force_authenticate(user)
    return api


def join_org(website, owner, members: dict) -> None:
    """Move ``website`` into an organization with ``members`` ({user: role})."""
    org = Organization.objects.create(
        name="Northwind Team", slug=f"northwind-{uuid.uuid4().hex[:8]}", owner=owner,
    )
    OrganizationMember.objects.create(organization=org, user=owner, role="owner")
    for member, role in members.items():
        OrganizationMember.objects.create(organization=org, user=member, role=role)
    website.organization = org
    website.save(update_fields=["organization"])


@pytest.fixture
def user():
    return make_user("owner@example.com")


@pytest.fixture
def website(user):
    return Website.objects.create(user=user, url="https://notes.example", name="Notes")


@pytest.fixture
def url(website):
    return reverse("boards-layout", kwargs={"website_id": website.id})


@pytest.fixture
def api(user):
    return client_for(user)


def data(resp) -> dict:
    body = resp.json()
    assert body["success"] is True, body
    return body["data"]


def error(resp) -> dict:
    body = resp.json()
    assert body["success"] is False, body
    return body["error"]


def put(api, url, version, widgets):
    return api.put(url, {"version": version, "widgets": widgets}, format="json")


def when(stamp: str) -> datetime:
    assert stamp.endswith("Z"), stamp
    return datetime.fromisoformat(stamp)


# -- default, save, bump ---------------------------------------------------------


def test_the_url(url, website):
    assert url == f"/api/v1/boards/websites/{website.id}/layout/"


def test_nothing_saved_answers_the_default(api, url):
    resp = api.get(url)
    assert resp.status_code == 200
    assert data(resp) == DEFAULT_PAYLOAD
    assert not BoardLayout.objects.exists()


def test_a_first_save_creates_version_1_and_each_save_bumps_it(api, url, user, website):
    first = [{"key": "countries", "size": "full"}, {"key": "ai-crawlers", "size": "third"}]
    resp = put(api, url, 0, first)
    assert resp.status_code == 200
    saved = data(resp)
    assert (saved["saved"], saved["version"], saved["widgets"]) == (True, 1, first)
    assert data(api.get(url)) == saved

    second = [{"key": "share-of-voice", "size": "half"}]
    again = data(put(api, url, 1, second))
    assert (again["saved"], again["version"], again["widgets"]) == (True, 2, second)
    assert when(again["updated_at"]) >= when(saved["updated_at"])
    assert data(api.get(url)) == again

    # An empty board is a layout like any other.
    empty = data(put(api, url, 2, []))
    assert (empty["version"], empty["widgets"]) == (3, [])
    row = BoardLayout.objects.get()
    assert (row.user, row.website, row.version, row.widgets) == (user, website, 3, [])


# -- conflicts ------------------------------------------------------------------------


def assert_conflict(resp, expected_layout):
    assert resp.status_code == 409
    err = error(resp)
    assert (err["code"], err["message"]) == ("layout_conflict", CONFLICT_MESSAGE)
    assert err["details"] == {"layout": expected_layout}


def test_a_stale_or_unknown_version_conflicts_both_ways(api, url):
    # Nothing saved: only version 0 is current.
    assert_conflict(put(api, url, 1, []), DEFAULT_PAYLOAD)
    assert not BoardLayout.objects.exists()

    current = data(put(api, url, 0, [{"key": "pages", "size": "full"}]))
    current = data(put(api, url, 1, [{"key": "pages", "size": "half"}]))
    assert current["version"] == 2
    # Behind: another window saved since this one loaded.
    assert_conflict(put(api, url, 1, [{"key": "products", "size": "half"}]), current)
    # Ahead: a version this board never had.
    assert_conflict(put(api, url, 3, [{"key": "products", "size": "half"}]), current)
    # A first save from a window that never saw the saved board.
    assert_conflict(put(api, url, 0, [{"key": "products", "size": "half"}]), current)
    assert data(api.get(url)) == current


def test_two_first_saves_racing_answer_409(api, url, user, website, monkeypatch):
    """The second insert hits the unique constraint: it gets the winner's
    layout, like any other stale save."""
    winner = BoardLayout.objects.create(
        user=user, website=website, widgets=[{"key": "sentiment", "size": "third"}],
    )
    real_row = views._row
    # This request read "nothing saved" before the winner committed.
    monkeypatch.setattr(views, "_row", lambda u, w, lock=False: None if lock else real_row(u, w))

    resp = put(api, url, 0, [{"key": "fact-check", "size": "third"}])

    assert_conflict(resp, payload(winner))
    assert payload(winner)["widgets"] == [{"key": "sentiment", "size": "third"}]
    assert list(BoardLayout.objects.values_list("id", flat=True)) == [winner.id]


# -- 400s -------------------------------------------------------------------------------


@pytest.mark.parametrize(("body", "field", "message"), [
    ({"widgets": []}, "version", "Send the version you loaded."),
    ({"version": None, "widgets": []}, "version", "Send the version you loaded."),
    ({"version": -1, "widgets": []}, "version", "Send the version you loaded."),
    ({"version": True, "widgets": []}, "version", "Send the version you loaded."),
    ({"version": "0", "widgets": []}, "version", "Send the version you loaded."),
    ({"version": 0.5, "widgets": []}, "version", "Send the version you loaded."),
    ([{"key": "summary", "size": "full"}], "version", "Send the version you loaded."),
    ({"version": 0}, "widgets", "Send a list of widgets."),
    ({"version": 0, "widgets": {"key": "summary", "size": "full"}}, "widgets",
     "Send a list of widgets."),
    ({"version": 0, "widgets": ["summary"]}, "widgets[0]", "Each widget is {key, size}."),
    ({"version": 0, "widgets": [{"key": "summary"}]}, "widgets[0]",
     "Each widget is {key, size}."),
    ({"version": 0, "widgets": [{"key": "summary", "size": "full", "order": 1}]}, "widgets[0]",
     "Each widget is {key, size}."),
    ({"version": 0, "widgets": [{"key": "summary", "size": "full"},
                                {"key": "overview", "size": "full"}]},
     "widgets[1].key", "Unknown widget: overview."),
    ({"version": 0, "widgets": [{"key": "traffic", "size": "half"},
                                {"key": "traffic", "size": "full"}]},
     "widgets[1].key", "Each widget can be on the board once."),
    ({"version": 0, "widgets": [{"key": "traffic", "size": "wide"}]}, "widgets[0].size",
     "Choose a size of third, half or full."),
])
def test_every_invalid_save_is_refused(api, url, body, field, message):
    resp = api.put(url, body, format="json")
    assert resp.status_code == 400
    err = error(resp)
    assert (err["code"], err["message"]) == ("invalid", message)
    assert err["details"] == {"field": field, "message": message}
    assert not BoardLayout.objects.exists()


def test_an_invalid_save_leaves_the_saved_board_alone(api, url):
    saved = data(put(api, url, 0, [{"key": "citations", "size": "full"}]))
    resp = put(api, url, 1, [{"key": "citations", "size": "huge"}])
    assert resp.status_code == 400
    assert data(api.get(url)) == saved


# -- reset -------------------------------------------------------------------------------


def test_reset_rewrites_the_row_and_bumps_the_version(api, url):
    saved = data(put(api, url, 0, [{"key": "ai-crawlers", "size": "half"}]))
    row_id = BoardLayout.objects.get().id

    resp = api.delete(url)

    assert resp.status_code == 200
    reset = data(resp)
    assert (reset["saved"], reset["version"], reset["widgets"]) == (True, 2, DEFAULT)
    assert when(reset["updated_at"]) >= when(saved["updated_at"])
    assert list(BoardLayout.objects.values_list("id", flat=True)) == [row_id]
    assert data(api.get(url)) == reset
    # A window still holding version 1 cannot overwrite the reset board.
    assert_conflict(put(api, url, 1, [{"key": "ai-crawlers", "size": "half"}]), reset)
    assert data(put(api, url, 2, [{"key": "summary", "size": "half"}]))["version"] == 3


def test_reset_with_nothing_saved_changes_nothing(api, url):
    resp = api.delete(url)
    assert resp.status_code == 200
    assert data(resp) == DEFAULT_PAYLOAD
    assert not BoardLayout.objects.exists()


# -- reading -----------------------------------------------------------------------------


def test_unknown_keys_are_dropped_on_read(api, url, user, website):
    BoardLayout.objects.create(user=user, website=website, version=4, widgets=[
        {"key": "summary", "size": "full"},
        {"key": "engine-heatmap", "size": "full"},
        {"key": "summary", "size": "half"},
        {"key": "traffic", "size": "enormous"},
        "countries",
    ])
    got = data(api.get(url))
    assert (got["saved"], got["version"]) == (True, 4)
    assert got["widgets"] == [{"key": "summary", "size": "full"}, {"key": "traffic", "size": "half"}]


# -- access -------------------------------------------------------------------------------


def test_a_viewer_arranges_their_own_board(user, website, url):
    viewer = make_user("viewer@example.com")
    join_org(website, user, {viewer: "viewer"})
    api = client_for(viewer)

    assert data(api.get(url)) == DEFAULT_PAYLOAD
    saved = data(put(api, url, 0, [{"key": "competitors", "size": "full"}]))
    assert (saved["version"], saved["widgets"]) == (1, [{"key": "competitors", "size": "full"}])
    assert data(api.delete(url))["version"] == 2
    assert BoardLayout.objects.get().user == viewer


def test_outsiders_get_404_and_signed_out_callers_401(user, website, url):
    stranger = make_user("stranger@example.com")
    for api, status in ((client_for(stranger), 404), (client_for(), 401)):
        assert api.get(url).status_code == status
        assert put(api, url, 0, DEFAULT).status_code == status
        assert api.delete(url).status_code == status
    assert error(client_for(stranger).get(url))["code"] == "not_found"
    missing = reverse("boards-layout", kwargs={"website_id": uuid.uuid4()})
    assert client_for(user).get(missing).status_code == 404
    assert not BoardLayout.objects.exists()


def test_an_org_member_of_another_project_gets_404(user, website, url):
    other_owner = make_user("other@example.com")
    other_site = Website.objects.create(user=other_owner, url="https://other.example", name="Other")
    member = make_user("member@example.com")
    join_org(other_site, other_owner, {member: "member"})
    assert client_for(member).get(url).status_code == 404


def test_two_users_on_one_project_stay_apart(user, website, url):
    teammate = make_user("teammate@example.com")
    join_org(website, user, {teammate: "member"})
    mine, theirs = client_for(user), client_for(teammate)

    put(mine, url, 0, [{"key": "products", "size": "half"}])
    put(mine, url, 1, [{"key": "products", "size": "full"}])
    # The teammate's first save starts at version 0, whatever the owner did.
    their_board = data(put(theirs, url, 0, [{"key": "fan-outs", "size": "half"}]))
    assert (their_board["version"], their_board["widgets"]) == (
        1, [{"key": "fan-outs", "size": "half"}])

    my_board = data(mine.get(url))
    assert (my_board["version"], my_board["widgets"]) == (2, [{"key": "products", "size": "full"}])
    assert data(theirs.get(url)) == their_board

    # Resetting one board leaves the other alone.
    assert data(theirs.delete(url))["widgets"] == DEFAULT
    assert data(mine.get(url)) == my_board
    assert BoardLayout.objects.count() == 2
