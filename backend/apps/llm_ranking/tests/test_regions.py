"""Tests for the region catalog helpers."""
from apps.llm_ranking.services.regions import (
    REGION_GLOBAL,
    get_region,
)


class TestRegionLookup:
    def test_known_region(self):
        r = get_region("us")
        assert r.code == "us"
        assert r.label == "United States"
        assert r.perplexity_country == "US"

    def test_unknown_falls_back_to_global(self):
        assert get_region("zz").code == REGION_GLOBAL
        assert get_region("").code == REGION_GLOBAL
        assert get_region(None).code == REGION_GLOBAL

    def test_uk_maps_to_perplexity_gb(self):
        # UK is the audit-side region code, but Perplexity expects GB.
        assert get_region("uk").perplexity_country == "GB"

    def test_global_has_no_country(self):
        assert get_region(REGION_GLOBAL).perplexity_country == ""


class TestCountryMapping:
    def test_region_for_country(self):
        from apps.llm_ranking.services.regions import region_for_country
        assert region_for_country("US") == "us"
        assert region_for_country("RU") == "ru"
        assert region_for_country("UA") == "ua"
        assert region_for_country("GB") == "gb"
        assert region_for_country("uk") == "gb"
        assert region_for_country("ZZ") == "global"
        assert region_for_country("") == "global"
        assert region_for_country(None) == "global"

    def test_supported_countries(self):
        from apps.llm_ranking.services.regions import supported_countries
        cs = supported_countries()
        codes = {c["code"] for c in cs}
        assert {"US", "RU", "UA", "IN", "GB"} <= codes
        assert "global" not in codes and "" not in codes
        # sorted by name, each has code + name
        assert all(c["code"] and c["name"] for c in cs)
