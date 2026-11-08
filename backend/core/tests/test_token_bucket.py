"""TokenBucket keeps its state long enough to enforce its steady rate.

The state lives in the cache. If it expired before the bucket had refilled,
a missing key would read as a full bucket and every pause longer than the
cache timeout would hand out a fresh burst.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from django.core.cache import cache

from core.resilience import TokenBucket


@pytest.fixture(autouse=True)
def _clean_cache():
    cache.clear()
    yield
    cache.clear()


class _Clock:
    """Stands in for time.time so the locmem cache expiry follows it too."""

    def __init__(self, start: float = 1_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock():
    c = _Clock()
    with patch("time.time", c):
        yield c


def _drain(bucket: TokenBucket) -> int:
    granted = 0
    while bucket.try_acquire():
        granted += 1
        assert granted <= bucket.capacity, "bucket never ran out"
    return granted


def test_slow_bucket_does_not_refill_fully_after_a_short_pause(clock):
    # 5 tokens, one every 180 s: a full refill takes 900 s, longer than the
    # 300 s minimum the state used to be kept for.
    bucket = TokenBucket("test:slow", capacity=5, refill_per_second=20 / 3600.0)
    assert _drain(bucket) == 5

    clock.now += 360  # six minutes: two tokens' worth
    assert _drain(bucket) == 2


def test_slow_bucket_rate_over_an_hour_of_bursts(clock):
    bucket = TokenBucket("test:hourly", capacity=5, refill_per_second=20 / 3600.0)
    granted = _drain(bucket)
    for _ in range(10):  # an attempt burst every six minutes for an hour
        clock.now += 360
        granted += _drain(bucket)
    # The first burst of 5 plus 20 an hour, never a fresh burst per pause.
    assert granted == 25


def test_state_is_kept_for_a_full_refill():
    assert TokenBucket("a", capacity=5, refill_per_second=20 / 3600.0)._state_ttl == 900
    # Fast buckets keep the 300 s minimum.
    assert TokenBucket("b", capacity=30, refill_per_second=0.5)._state_ttl == 300
    # A bucket that never refills does not divide by zero.
    assert TokenBucket("c", capacity=3, refill_per_second=0)._state_ttl == 300


def test_full_refill_after_long_idle(clock):
    bucket = TokenBucket("test:idle", capacity=5, refill_per_second=20 / 3600.0)
    _drain(bucket)
    clock.now += 3600
    assert _drain(bucket) == 5
