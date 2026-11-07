"""
Grounded brand-profile extraction and the logo lookup in the onboarding scan.

Claude is replaced by ``FakeClaude`` (patched over the module's
``ClaudeUtility``), which answers per ``role`` and records every call, so
the suite never reaches the network. ``scan_domain`` is patched at its
source module and the logo crawler at its source too, because the
orchestrator imports both lazily.
"""
import json
from unittest.mock import patch

import pytest

from apps.onboarding.services import onboarding_service
from apps.onboarding.services.onboarding_service import (
    AUDIENCE_MAX,
    INDUSTRY_MAX,
    OFFERING_MAX,
    OFFERINGS_MAX,
    VOICE_MAX,
    run_onboarding_scan,
    to_dict,
)
from core.llm import ProviderResult

SCAN_DOMAIN = "apps.llm_ranking.services.domain_scanner.scan_domain"
FETCH_LOGO = "apps.prompt_library.services.logo_crawler.fetch_site_logo"

PAGE_TEXT = (
    "Title: TutorNote - AI lesson notes for tutors\n"
    "Description: TutorNote turns every tutoring session into clear lesson "
    "notes for parents.\n"
    "Heading: Built for independent tutors and tutoring centres\n"
    "Heading: Session Recorder\n"
    "Heading: Parent Reports\n"
    "Spend less time on admin and more time teaching. No jargon, no fuss."
)

# A JavaScript-rendered site: the heuristic scan found a name and a
# description but no industry and no products.
_THIN_SCAN = {
    "success": True,
    "business_name": "TutorNote",
    "industry": "",
    "domain": "tutornote.ai",
    "description": "TutorNote turns every tutoring session into clear lesson notes for parents.",
    "products": [],
    "features": [],
    "selling_points": [],
    "page_text": PAGE_TEXT,
}

_GROUNDED = {
    "industry": {"value": "Education technology for tutors",
                 "evidence": "AI lesson notes for tutors"},
    "offerings": ["Session Recorder", "Parent Reports"],
    "audience": {"value": "Independent tutors and tutoring centres.",
                 "evidence": "Built for independent tutors and tutoring centres"},
    "voice": {"value": "Plain-spoken and practical",
              "evidence": "No jargon, no fuss."},
}


def _ok(text):
    return ProviderResult(succeeded=True, text=text, input_tokens=10, output_tokens=10)


class FakeClaude:
    """Stand-in for ``core.llm.ClaudeUtility``; answers by ``role``."""

    responses: dict = {}
    calls: list = []
    configured = True

    def __init__(self, *, model, max_tokens=1024):
        self.model = model
        self.max_tokens = max_tokens

    def is_configured(self):
        return self.configured

    def query(self, prompt, system_prompt="", **kwargs):
        role = kwargs.get("role")
        FakeClaude.calls.append({"prompt": prompt, "system_prompt": system_prompt, **kwargs})
        answer = FakeClaude.responses.get(role)
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, ProviderResult):
            return answer
        if answer is None:
            return ProviderResult(succeeded=False, error="no fake answer")
        return _ok(answer)


@pytest.fixture(autouse=True)
def _no_llm(settings):
    settings.ANTHROPIC_API_KEY = ""


@pytest.fixture
def fake_claude():
    FakeClaude.responses = {}
    FakeClaude.calls = []
    FakeClaude.configured = True
    with patch.object(onboarding_service, "ClaudeUtility", FakeClaude):
        yield FakeClaude


@pytest.fixture
def no_competitors():
    with patch.object(onboarding_service, "_safe_discover_competitors", return_value=[]):
        yield


@pytest.fixture
def logo():
    with patch(FETCH_LOGO, return_value="https://tutornote.ai/apple-touch-icon.png") as m:
        yield m


def _scan(scan=_THIN_SCAN, user=None):
    with patch(SCAN_DOMAIN, return_value=scan):
        return run_onboarding_scan("https://tutornote.ai", user=user)


def _profile_calls(fake):
    return [c for c in fake.calls if c.get("role") == "brand_profile"]


@pytest.mark.usefixtures("no_competitors", "logo")
class TestProfileFillsEmptyFields:
    def test_grounded_answer_fills_missing_fields(self, fake_claude):
        fake_claude.responses = {"brand_profile": json.dumps(_GROUNDED)}
        payload = _scan()
        assert payload.success is True
        assert payload.industry == "Education technology for tutors"
        assert payload.products == ["Session Recorder", "Parent Reports"]
        assert payload.audience == "Independent tutors and tutoring centres."
        assert payload.voice == "Plain-spoken and practical"

    def test_answer_wrapped_in_prose_is_parsed(self, fake_claude):
        fake_claude.responses = {
            "brand_profile": "Here you go:\n```json\n" + json.dumps(_GROUNDED) + "\n```",
        }
        payload = _scan()
        assert payload.industry == "Education technology for tutors"
        assert payload.voice == "Plain-spoken and practical"

    def test_one_call_with_page_text_isolated_as_untrusted(self, fake_claude):
        fake_claude.responses = {"brand_profile": json.dumps(_GROUNDED)}
        _scan()
        calls = _profile_calls(fake_claude)
        assert len(calls) == 1
        call = calls[0]
        assert call["module"] == "onboarding"
        # The page text rides in the nonce-tagged untrusted block, not the
        # user prompt.
        assert "Session Recorder" in call["system_prompt"]
        assert "UNTRUSTED" in call["system_prompt"]
        assert "Session Recorder" not in call["prompt"]
        # The prompt demands evidence and empty values otherwise.
        assert "evidence" in call["prompt"]
        assert "empty" in call["prompt"]

    def test_usage_is_attributed_to_the_user(self, fake_claude):
        fake_claude.responses = {"brand_profile": json.dumps(_GROUNDED)}
        user = object()
        _scan(user=user)
        calls = _profile_calls(fake_claude)
        assert calls and all(c["user"] is user for c in calls)

    def test_extracted_industry_feeds_later_steps(self, fake_claude):
        fake_claude.responses = {"brand_profile": json.dumps(_GROUNDED)}
        _scan()
        topic_calls = [c for c in fake_claude.calls if c.get("role") == "topic_generation"]
        assert topic_calls
        assert "Education technology for tutors" in topic_calls[0]["prompt"]

    def test_no_page_text_makes_no_call(self, fake_claude):
        fake_claude.responses = {"brand_profile": json.dumps(_GROUNDED)}
        payload = _scan({**_THIN_SCAN, "page_text": ""})
        assert _profile_calls(fake_claude) == []
        assert payload.industry == ""
        assert payload.audience == ""
        assert payload.voice == ""


@pytest.mark.usefixtures("no_competitors", "logo")
class TestHeuristicValuesKept:
    def test_heuristic_industry_and_products_are_not_replaced(self, fake_claude):
        fake_claude.responses = {"brand_profile": json.dumps(_GROUNDED)}
        scan = {**_THIN_SCAN, "industry": "EdTech", "products": ["Lesson Notes"]}
        payload = _scan(scan)
        assert payload.industry == "EdTech"
        assert payload.products == ["Lesson Notes"]
        # Audience and voice have no heuristic source; they still fill.
        assert payload.audience == "Independent tutors and tutoring centres."
        assert payload.voice == "Plain-spoken and practical"


@pytest.mark.usefixtures("no_competitors", "logo")
class TestUngroundedOrInvalidOutput:
    def test_values_without_a_quote_from_the_page_are_dropped(self, fake_claude):
        invented = {
            "industry": {"value": "Online marketplaces", "evidence": "the leading marketplace"},
            "offerings": ["Session Recorder", "Homework Helper Pro", "Exam Bank"],
            "audience": {"value": "Fortune 500 enterprises", "evidence": ""},
            "voice": {"value": "Bold", "evidence": "We disrupt everything"},
        }
        fake_claude.responses = {"brand_profile": json.dumps(invented)}
        payload = _scan()
        assert payload.industry == ""
        assert payload.audience == ""
        assert payload.voice == ""
        # Only the offering the page actually names survives.
        assert payload.products == ["Session Recorder"]

    def test_offerings_must_be_whole_words_and_not_the_brand(self, fake_claude):
        answer = {**_GROUNDED, "offerings": ["Note", "TutorNote", "lesson", "Parent Reports"]}
        fake_claude.responses = {"brand_profile": json.dumps(answer)}
        payload = _scan()
        # "Note" only occurs inside "TutorNote" / "notes"; the brand name
        # is not an offering; "lesson" is a whole word on the page.
        assert payload.products == ["lesson", "Parent Reports"]

    def test_too_short_evidence_is_rejected(self, fake_claude):
        answer = {**_GROUNDED, "voice": {"value": "Warm", "evidence": "AI"}}
        fake_claude.responses = {"brand_profile": json.dumps(answer)}
        assert _scan().voice == ""

    def test_wrong_types_are_dropped(self, fake_claude):
        answer = {
            "industry": "Education",            # not an object
            "offerings": "Session Recorder",    # not a list
            "audience": {"value": ["tutors"], "evidence": "independent tutors"},
            "voice": {"value": 7, "evidence": "No jargon, no fuss."},
        }
        fake_claude.responses = {"brand_profile": json.dumps(answer)}
        payload = _scan()
        assert payload.industry == ""
        assert payload.products == []
        assert payload.audience == ""
        assert payload.voice == ""

    def test_long_values_are_clipped_to_ui_limits(self, fake_claude):
        long_offering = "Session Recorder"
        page = PAGE_TEXT + "\n" + " ".join(f"Plan{i}" for i in range(30)) + " " + ("x" * 150)
        answer = {
            "industry": {"value": "word " * 60, "evidence": "AI lesson notes for tutors"},
            "offerings": [long_offering] + [f"Plan{i}" for i in range(30)] + ["x" * 150],
            "audience": {"value": "tutors " * 200,
                         "evidence": "Built for independent tutors"},
            "voice": {"value": "calm " * 100, "evidence": "No jargon, no fuss."},
        }
        fake_claude.responses = {"brand_profile": json.dumps(answer)}
        payload = _scan({**_THIN_SCAN, "page_text": page})
        assert 0 < len(payload.industry) <= INDUSTRY_MAX
        assert 0 < len(payload.audience) <= AUDIENCE_MAX
        assert 0 < len(payload.voice) <= VOICE_MAX
        assert len(payload.products) == OFFERINGS_MAX
        assert all(len(p) <= OFFERING_MAX for p in payload.products)
        assert "x" * 150 not in payload.products

    def test_caps_match_the_wizard_limits(self):
        assert (INDUSTRY_MAX, OFFERING_MAX, AUDIENCE_MAX, VOICE_MAX) == (100, 100, 600, 300)
        assert OFFERINGS_MAX <= 20

    @pytest.mark.parametrize("text", ["not json at all", "{broken json", "[1, 2, 3]", ""])
    def test_bad_json_leaves_fields_empty(self, fake_claude, text):
        fake_claude.responses = {"brand_profile": text}
        payload = _scan()
        assert payload.success is True
        assert (payload.industry, payload.products, payload.audience, payload.voice) == (
            "", [], "", "",
        )


@pytest.mark.usefixtures("no_competitors", "logo")
class TestFailuresNeverFailTheScan:
    def test_no_key_leaves_fields_empty_and_scan_succeeds(self):
        # The real ClaudeUtility with a blank key (autouse fixture).
        payload = _scan()
        assert payload.success is True
        assert payload.business_name == "TutorNote"
        assert payload.industry == ""
        assert payload.products == []
        assert payload.audience == ""
        assert payload.voice == ""
        assert payload.missing_keys == ["ANTHROPIC_API_KEY"]

    def test_unconfigured_fake_makes_no_profile_call(self, fake_claude):
        fake_claude.configured = False
        fake_claude.responses = {"brand_profile": json.dumps(_GROUNDED)}
        payload = _scan()
        assert payload.success is True
        assert fake_claude.calls == []
        assert payload.audience == ""

    def test_failed_call_leaves_fields_empty(self, fake_claude):
        fake_claude.responses = {
            "brand_profile": ProviderResult(succeeded=False, error="timeout"),
        }
        payload = _scan()
        assert payload.success is True
        assert (payload.industry, payload.audience, payload.voice) == ("", "", "")

    def test_raising_call_leaves_fields_empty(self, fake_claude):
        fake_claude.responses = {"brand_profile": TimeoutError("read timed out")}
        payload = _scan()
        assert payload.success is True
        assert (payload.industry, payload.audience, payload.voice) == ("", "", "")
        assert payload.products == []


@pytest.mark.usefixtures("no_competitors")
class TestLogo:
    def test_logo_url_is_returned(self, logo):
        payload = _scan()
        assert payload.logo_url == "https://tutornote.ai/apple-touch-icon.png"
        logo.assert_called_once_with("tutornote.ai")

    def test_logo_failure_gives_empty_string(self):
        with patch(FETCH_LOGO, side_effect=RuntimeError("dns down")):
            payload = _scan()
        assert payload.success is True
        assert payload.logo_url == ""

    def test_non_string_logo_gives_empty_string(self):
        with patch(FETCH_LOGO, return_value=None):
            assert _scan().logo_url == ""

    def test_failed_scan_does_not_look_up_a_logo(self, logo):
        with patch(SCAN_DOMAIN, return_value={"success": False, "error": "nope"}):
            payload = run_onboarding_scan("https://tutornote.ai")
        assert payload.success is False
        assert payload.logo_url == ""
        logo.assert_not_called()


@pytest.mark.usefixtures("no_competitors", "logo")
def test_payload_dict_carries_new_fields(fake_claude):
    fake_claude.responses = {"brand_profile": json.dumps(_GROUNDED)}
    data = to_dict(_scan())
    assert data["audience"] == "Independent tutors and tutoring centres."
    assert data["voice"] == "Plain-spoken and practical"
    assert data["logo_url"] == "https://tutornote.ai/apple-touch-icon.png"
    assert data["industry"] == "Education technology for tutors"
    assert data["products"] == ["Session Recorder", "Parent Reports"]
