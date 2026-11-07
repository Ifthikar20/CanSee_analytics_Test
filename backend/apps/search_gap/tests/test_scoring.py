import pytest

from apps.search_gap.services.scoring import (
    AI_AHEAD,
    EVEN,
    GOOGLE_AHEAD,
    INVISIBLE_BOTH,
    NO_DATA,
    STRONG_BOTH,
    Answer,
    ai_score,
    classify,
    classify_range,
    google_page,
    overall,
    overall_range,
    rank_weight,
    search_score,
    search_score_ceiling,
)


@pytest.mark.parametrize("position, score", [
    (1, 100), (3, 100), (4, 80), (10, 80), (11, 55), (20, 55),
    (21, 30), (50, 30), (51, 15), (100, 15), (101, 0), (None, 0), (0, 0),
])
def test_search_score_bands(position, score):
    assert search_score(position) == score


@pytest.mark.parametrize("position, page", [(1, 1), (10, 1), (11, 2), (94, 10), (None, None)])
def test_google_page(position, page):
    assert google_page(position) == page


@pytest.mark.parametrize("rank, weight", [
    (1, 100), (3, 100), (4, 80), (5, 80), (6, 55), (10, 55), (11, 30), (None, 55),
])
def test_rank_weight(rank, weight):
    assert rank_weight(rank) == weight


def test_ai_score_is_none_without_answers():
    assert ai_score([]) is None


def test_ai_score_is_zero_when_never_mentioned():
    assert ai_score([Answer(False), Answer(False)]) == 0


def test_ai_score_weights_share_by_rank():
    # Mentioned in 4 of 5 answers, always top 3: 0.8 x 100.
    answers = [Answer(True, 2), Answer(True, 3), Answer(True, 1), Answer(True, 2), Answer(False)]
    assert ai_score(answers) == 80


def test_owner_example_is_ai_ahead():
    """Google page 10 (#94) but Claude lists the brand #3."""
    google = search_score(94)
    claude = ai_score([Answer(True, 3)] * 3)
    assert (google, claude) == (15, 100)
    assert classify(claude, google) == AI_AHEAD


def test_google_page_one_without_ai_mention_is_google_ahead():
    assert classify(0, search_score(4)) == GOOGLE_AHEAD


def test_both_strong():
    assert classify(100, search_score(5)) == STRONG_BOTH


def test_page_two_against_ai_top_three_is_still_a_gap():
    # Strong on both scores, but page two is where clicks die: the gap wins.
    assert classify(100, search_score(15)) == AI_AHEAD


def test_invisible_in_both():
    assert classify(0, search_score(None)) == INVISIBLE_BOTH


def test_even():
    assert classify(40, search_score(12)) == EVEN


def test_unchecked_google_is_no_data_not_ai_ahead():
    assert classify(100, None) == NO_DATA
    assert classify(None, 80) == NO_DATA


def test_overall_uses_mean_of_engines_that_answered():
    result = overall([100, 60, None], search_score(94))
    assert result == {"ai_score": 80, "search_score": 15, "value": 65, "class": AI_AHEAD}


def test_overall_without_answers():
    assert overall([None, None], 80)["class"] == NO_DATA


@pytest.mark.parametrize("depth, ceiling", [(10, 55), (20, 30), (30, 30), (50, 15), (100, 0), (None, 0), (0, 0)])
def test_a_miss_within_a_depth_can_still_score_up_to_the_next_band(depth, ceiling):
    assert search_score_ceiling(depth) == ceiling


def test_a_range_gives_a_class_only_when_both_ends_agree():
    # Named #1 everywhere (AI 100) against Google past the top 10 (0 to 55):
    # AI ahead either way, by at least 45.
    sure = overall_range([100, 100], 55)
    assert (sure["class"], sure["definite"], sure["value"], sure["value_min"]) == (AI_AHEAD, True, None, 45)
    assert (sure["search_score"], sure["search_score_max"]) == (None, 55)
    # AI 62: AI ahead if Google is past #20, strong in both if it is #11-20.
    unsure = overall_range([62], 55)
    assert (unsure["class"], unsure["definite"], unsure["value_min"]) == (NO_DATA, False, None)
    # AI 28: even at both ends.
    assert overall_range([28], 55)["class"] == EVEN
    assert overall_range([None], 55)["class"] == NO_DATA
    assert (classify_range(100, 55), classify_range(62, 55), classify_range(None, 55)) == (AI_AHEAD, NO_DATA, NO_DATA)

