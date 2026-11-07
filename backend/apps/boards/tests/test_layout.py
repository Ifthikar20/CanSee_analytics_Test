"""The widget catalog against board contract 3, and the layout rules of
contract 6: what a save may send, what a read keeps, and the payload."""

from datetime import UTC, datetime

import pytest

from apps.boards.layout import (
    DEFAULT_LAYOUT,
    SIZES,
    WIDGETS,
    default_widgets,
    payload,
    read_widgets,
    validate_version,
    validate_widgets,
)
from apps.boards.models import BoardLayout
from core.exceptions import CanseeException

# Board contract 3 with wave 4's two keys first (wave 4 contract 6), in
# catalog order: each key and its default size. The frontend's
# src/lib/board/widgets.js is tested against the same table.
CONTRACT_WIDGETS = [
    ("prompt-box", "full"),
    ("ranking", "full"),
    ("summary", "full"),
    ("prompts", "full"),
    ("countries", "half"),
    ("traffic", "half"),
    ("visibility", "half"),
    ("by-engine", "third"),
    ("who-recommends", "third"),
    ("share-of-voice", "third"),
    ("sentiment", "third"),
    ("fact-check", "third"),
    ("citations", "half"),
    ("ai-traffic", "third"),
    ("ai-crawlers", "third"),
    ("crawler-access", "third"),
    ("pages", "half"),
    ("fan-outs", "half"),
    ("prompt-research", "half"),
    ("competitors", "half"),
    ("products", "half"),
]
# Ask AI and Prompt ranking (wave 4 contract 6).
DEFAULT = [{"key": "prompt-box", "size": "full"}, {"key": "ranking", "size": "full"}]


def refused(raw) -> dict:
    with pytest.raises(CanseeException) as caught:
        validate_widgets(raw)
    error = caught.value
    assert (error.code, error.status_code) == ("invalid", 400)
    assert error.message == error.details["message"]
    return error.details


# -- catalog ---------------------------------------------------------------------


def test_the_catalog_is_the_contract_table():
    assert list(WIDGETS.items()) == CONTRACT_WIDGETS
    assert len(WIDGETS) == 21
    assert SIZES == ("third", "half", "full")
    assert set(WIDGETS.values()) <= set(SIZES)


def test_the_default_layout():
    assert list(DEFAULT_LAYOUT) == DEFAULT
    # Each default widget sits at its own default size.
    assert all(WIDGETS[w["key"]] == w["size"] for w in DEFAULT_LAYOUT)
    copies = default_widgets()
    copies[0]["size"] = "half"
    copies.append({"key": "pages", "size": "half"})
    assert list(DEFAULT_LAYOUT) == DEFAULT and default_widgets() == DEFAULT


# -- reading a stored list -----------------------------------------------------------


def test_read_drops_unknown_and_repeated_keys_and_fixes_sizes():
    stored = [
        {"key": "traffic", "size": "full"},
        {"key": "retired-widget", "size": "half"},
        {"key": "traffic", "size": "third"},
        {"key": "ai-crawlers", "size": "huge"},
        {"key": "pages", "size": None},
        {"key": "pages", "size": "full"},
        {"size": "half"},
        {"key": ["summary"], "size": "full"},
        "summary",
        None,
        {"key": "summary", "size": "half", "extra": 1},
    ]
    assert read_widgets(stored) == [
        {"key": "traffic", "size": "full"},
        {"key": "ai-crawlers", "size": "third"},
        {"key": "pages", "size": "half"},
        {"key": "summary", "size": "half"},
    ]
    assert read_widgets([]) == []
    assert read_widgets(None) == [] and read_widgets({"key": "summary"}) == []


# -- validating a save -------------------------------------------------------------


def test_a_valid_list_comes_back_clean():
    sent = [{"key": "countries", "size": "full"}, {"key": "by-engine", "size": "half"}]
    widgets = validate_widgets(sent)
    assert widgets == sent and widgets[0] is not sent[0]
    assert validate_widgets([]) == []
    every = [{"key": key, "size": size} for key, size in CONTRACT_WIDGETS]
    assert validate_widgets(every) == every


@pytest.mark.parametrize("raw", [None, "summary", {"key": "summary", "size": "full"}, 3])
def test_widgets_must_be_a_list(raw):
    assert refused(raw) == {"field": "widgets", "message": "Send a list of widgets."}


@pytest.mark.parametrize("item", [
    "summary",
    ["summary", "full"],
    None,
    {"key": "summary"},
    {"size": "full"},
    {},
    {"key": "summary", "size": "full", "pinned": True},
])
def test_each_widget_is_exactly_key_and_size(item):
    assert refused([{"key": "prompts", "size": "full"}, item]) == {
        "field": "widgets[1]", "message": "Each widget is {key, size}."}


def test_unknown_keys_are_named():
    assert refused([{"key": "overview", "size": "full"}]) == {
        "field": "widgets[0].key", "message": "Unknown widget: overview."}
    assert refused([{"key": 5, "size": "full"}]) == {
        "field": "widgets[0].key", "message": "Unknown widget: 5."}
    assert refused([{"key": None, "size": "full"}])["message"] == "Unknown widget: null."
    # A long key is quoted only in part.
    assert refused([{"key": "x" * 500, "size": "full"}])["message"] == (
        f"Unknown widget: {'x' * 64}...."
    )


def test_a_key_can_be_on_the_board_once():
    sent = [{"key": "summary", "size": "full"}, {"key": "traffic", "size": "half"},
            {"key": "summary", "size": "half"}]
    assert refused(sent) == {
        "field": "widgets[2].key", "message": "Each widget can be on the board once."}


@pytest.mark.parametrize("size", ["quarter", "Full", "", None, 6, ["half"]])
def test_sizes_are_third_half_or_full(size):
    assert refused([{"key": "traffic", "size": size}]) == {
        "field": "widgets[0].size", "message": "Choose a size of third, half or full."}


def test_any_global_size_passes_even_one_the_widget_does_not_offer():
    # Per-widget sizes are the client's; it clamps them on read.
    assert validate_widgets([{"key": "by-engine", "size": "full"}]) == [
        {"key": "by-engine", "size": "full"}]


def test_the_version_is_a_non_negative_integer():
    assert validate_version(0) == 0 and validate_version(3) == 3
    for raw in (None, -1, True, False, "3", 3.0, [3]):
        with pytest.raises(CanseeException) as caught:
            validate_version(raw)
        assert caught.value.code == "invalid", raw
        assert caught.value.details == {"field": "version", "message": "Send the version you loaded."}


# -- payload ---------------------------------------------------------------------------


def test_payload_without_a_saved_layout_is_the_default():
    assert payload(None) == {"saved": False, "version": 0, "updated_at": None, "widgets": DEFAULT}


def test_payload_of_a_saved_layout():
    row = BoardLayout(
        version=3,
        widgets=[{"key": "countries", "size": "full"}, {"key": "gone", "size": "half"}],
        updated_at=datetime(2026, 11, 4, 10, 12, tzinfo=UTC),
    )
    assert payload(row) == {
        "saved": True, "version": 3, "updated_at": "2026-11-04T10:12:00Z",
        "widgets": [{"key": "countries", "size": "full"}],
    }
    row.updated_at = datetime(2026, 11, 4, 10, 12, 0, 123456, tzinfo=UTC)
    row.widgets = []
    assert payload(row)["updated_at"] == "2026-11-04T10:12:00.123Z"
    assert payload(row)["widgets"] == []
