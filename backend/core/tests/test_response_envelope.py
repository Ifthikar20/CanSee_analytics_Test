"""EnvelopeRenderer unpacks pages, not every payload with a `results` key."""
import json

from rest_framework.response import Response

from core.interceptors.pagination import CursorBasedPagination, StandardPagination
from core.interceptors.response_envelope import EnvelopeRenderer, PageResponse


def _render(data, response=None):
    response = response if response is not None else Response(data)
    body = EnvelopeRenderer().render(data, renderer_context={"response": response})
    return json.loads(body)


def test_detail_payload_with_results_key_is_left_whole():
    audit = {"id": "a1", "overall_score": 72, "results": [{"provider": "claude"}]}
    assert _render(audit) == {"success": True, "data": audit}


def test_results_that_are_not_a_list_are_left_whole():
    payload = {"state": "done", "results": 12}
    assert _render(payload) == {"success": True, "data": payload}


def test_drf_page_shape_is_unpacked():
    page = {"count": 2, "next": None, "previous": None, "results": [1, 2], "stats": {"a": 1}}
    assert _render(page) == {
        "success": True,
        "data": [1, 2],
        "meta": {"count": 2, "next": None, "previous": None, "stats": {"a": 1}},
    }


def test_hand_built_page_is_unpacked_when_marked():
    data = {"results": [1], "page": 1, "page_size": 50, "total": 1}
    body = _render(data, PageResponse(data))
    assert body["data"] == [1]
    assert body["meta"]["total"] == 1
    assert body["meta"]["page_size"] == 50


def test_explicit_flag_false_wins_over_the_shape():
    data = {"results": [1], "next": None, "previous": None}
    response = Response(data)
    response.paginated = False
    assert _render(data, response) == {"success": True, "data": data}


def test_paginators_mark_their_responses():
    for paginator_cls in (StandardPagination, CursorBasedPagination):
        paginator = paginator_cls()
        # Stub the state a real request would set up.
        paginator.page = type("Page", (), {"paginator": type("P", (), {"count": 0})()})()
        paginator.get_next_link = lambda: None
        paginator.get_previous_link = lambda: None
        assert paginator.get_paginated_response([]).paginated is True
