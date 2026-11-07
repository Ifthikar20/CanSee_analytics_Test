"""The daily text (contract 5a and 5b): the templates word for word, every
template within 300 septets on the reviewer's worst cases with 32- and
60-character links, the shrink and drop order, the GSM-7 fallbacks, and
every unmeasured state (null change, unranked prompts, each claims state)."""

from datetime import date, datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest

from apps.autopilot.models import AutopilotRun
from apps.autopilot.services import ranking as ranking_service
from apps.autopilot.services import settings as ap
from apps.autopilot.services import text
from apps.autopilot.tests.support import *  # noqa: F403
from apps.autopilot.tests.support import BRAND, SITE
from apps.notifications.services import sms_service
from apps.websites.models import Website

NAME_24 = "Northwind Notes Software"
LONG_TOP = "all in one workspace for notes and docs and wikis"
LONG_WEAK = "best wiki software for a fast growing remote team"
BASE_32 = "https://app.cansee.ai"            # 21 + "/r/" + 8 = 32
BASE_60 = "https://" + "x" * 38 + ".ai"     # 49 + "/r/" + 8 = 60
FIVE = [{"key": k, "label": k, "provider": k} for k in ("a", "b", "c", "d", "e")]


def septets(body: str) -> int:
    return sms_service.gsm7_septets(body)


def site(name: str = NAME_24, url: str = SITE) -> Website:
    from django.contrib.auth import get_user_model

    return Website(name=name, url=url, user=get_user_model()(email="owner@example.com"))


def worst_run(**fields) -> AutopilotRun:
    """The reviewer's worst case: a 24-character name, answers 1000/1000,
    other counts 3 digits, down 100 pts, 999 new contradicted, AI $123.45."""
    values = {
        "website": site(), "local_date": date(2026, 11, 4), "link_code": "k3v9x2qa",
        "status": AutopilotRun.STATUS_DONE, "prompts_planned": 999, "prompts_done": 999,
        "answers_asked": 1000, "answers_answered": 1000, "answers_named": 1000,
        "change_pts": -100.0, "google_status": "done", "google_measured": 999,
        "google_page_one": 999, "analysis_status": "done", "new_contradicted": 999,
        "ai_cost_usd": Decimal("123.45"), "error_code": "",
        "plan": {"google": True, "cadence": "daily", "engines": FIVE, "run_engines": True,
                 "ask": True},
    }
    values.update(fields)
    return AutopilotRun(**values)


def worst_top_weak(run=None) -> list:
    return [
        text.Part("top", 'Top: "{q}" 999/999.', quoted=LONG_TOP),
        text.Part("weak", 'Weakest: "{q}" 999/999{note}.', quoted=LONG_WEAK,
                  note=" (+999 at 0)"),
    ]


def worst_rows() -> list:
    prompt = SimpleNamespace(text=LONG_TOP)
    return [SimpleNamespace(
        answers_named=999, answers_answered=999, position=0,
        brand_prompt=SimpleNamespace(created_at=datetime(2026, 1, 1), prompt=prompt),
    )] + [
        SimpleNamespace(answers_named=0, answers_answered=1, position=i,
                        brand_prompt=SimpleNamespace(created_at=datetime(2026, 1, 2),
                                                     prompt=SimpleNamespace(text="x")))
        for i in range(1, 1000)
    ]


@pytest.fixture
def worst(monkeypatch):
    """Template choice and the database-backed pieces, fixed to the worst case."""
    state = {"template": "A"}
    monkeypatch.setattr(text, "choose_template", lambda run: state["template"])
    monkeypatch.setattr(text, "_engines_asked", lambda run: 5)
    monkeypatch.setattr(text, "_top_and_weakest", worst_top_weak)
    monkeypatch.setattr(text, "_partial_why", lambda run: "allowance reserve reached")
    monkeypatch.setattr(text, "_first_run_parts", lambda run: text.first_run_parts(worst_rows()))
    monkeypatch.setattr(ap, "allowance_state", lambda user: {
        "cap": Decimal("500.00"), "reserve_pct": 10, "resets_on": date(2026, 9, 30),
        "unlimited": False,
    })
    return state


def build(template: str, run, state) -> str:
    state["template"] = template
    body, chosen = text.build_text(run)
    assert chosen == template
    assert sms_service.is_gsm7(body)
    return body


def unshrunk(monkeypatch, template, run, state) -> int:
    monkeypatch.setattr(text, "MAX_SEPTETS", 10_000)
    try:
        return septets(build(template, run, state))
    finally:
        monkeypatch.setattr(text, "MAX_SEPTETS", 300)


# -- worst cases (contract 5b) ---------------------------------------------------------


@pytest.mark.parametrize(("base", "before", "after"), [(BASE_32, 339, 291), (BASE_60, 367, 295)])
def test_a_normal_worst_case(settings, monkeypatch, worst, base, before, after):
    settings.FRONTEND_URL = base
    run = worst_run()
    assert unshrunk(monkeypatch, "A", run, worst) == before
    body = build("A", run, worst)
    assert septets(body) == after <= 300
    assert body.startswith(f"Cansee daily, {NAME_24}:") and body.endswith("Reply STOP to end")
    assert "(+999 at 0)" not in body
    assert ('999 prompts, 5 engines.' in body) is (base == BASE_32)
    assert "Claims: 999 new contradicted." in body and "AI $123.45." in body
    assert f"{base}/r/k3v9x2qa" in body


@pytest.mark.parametrize(("base", "before", "after"), [(BASE_32, 327, 299), (BASE_60, 355, 295)])
def test_b_partial_worst_case(settings, monkeypatch, worst, base, before, after):
    settings.FRONTEND_URL = base
    run = worst_run(prompts_done=998)
    assert unshrunk(monkeypatch, "B", run, worst) == before
    body = build("B", run, worst)
    assert septets(body) == after <= 300
    assert "partial, 998/999 prompts (allowance reserve reached)." in body
    assert ("Google page 1: 999/999." in body) is (base == BASE_32)
    assert "Claims" not in body and "(+" not in body


@pytest.mark.parametrize(("base", "length"), [(BASE_32, 221), (BASE_60, 249)])
def test_c_nothing_measured_worst_case(settings, worst, base, length):
    settings.FRONTEND_URL = base
    run = worst_run(answers_answered=0, answers_named=0, answers_asked=999,
                    status=AutopilotRun.STATUS_FAILED,
                    plan={**worst_run().plan, "paused": True})
    body = build("C", run, worst)
    assert septets(body) == length
    assert body == (
        f"Cansee daily, {NAME_24}: no AI answers today. No engine answered (999 errors). "
        f"Google page 1: 999/999. AI $123.45. Autopilot is paused after 3 failed runs. "
        f"{base}/r/k3v9x2qa Reply STOP to end"
    )


@pytest.mark.parametrize(("base", "allowance", "reserve"), [(BASE_32, 178, 201),
                                                            (BASE_60, 206, 229)])
def test_d_allowance_worst_case(settings, worst, base, allowance, reserve):
    settings.FRONTEND_URL = base
    used = build("D", worst_run(status="skipped", error_code="allowance_exceeded"), worst)
    assert used == (
        f"Cansee daily, {NAME_24}: skipped today. Your $500.00 AI allowance for this month "
        f"is used up. Runs resume Sep 30. {base}/r/k3v9x2qa Reply STOP to end"
    )
    kept = build("D", worst_run(status="skipped", error_code="reserve_reached"), worst)
    assert kept == (
        f"Cansee daily, {NAME_24}: paused. 90% of your $500.00 AI allowance is used; the rest "
        f"is kept for your own questions. Runs resume Sep 30. {base}/r/k3v9x2qa Reply STOP "
        "to end"
    )
    assert (septets(used), septets(kept)) == (allowance, reserve)


@pytest.mark.parametrize(("base", "before", "after"), [(BASE_32, 276, 276), (BASE_60, 304, 300)])
def test_e_first_run_worst_case(settings, monkeypatch, worst, base, before, after):
    settings.FRONTEND_URL = base
    run = worst_run(change_pts=None)
    assert unshrunk(monkeypatch, "E", run, worst) == before
    body = build("E", run, worst)
    assert septets(body) == after <= 300
    assert body.startswith(f"Cansee daily, {NAME_24}, first run: 999 prompts, 5 engines. "
                           "Named in 1000/1000 answers (100%). Named most: ")
    assert "Never named: 999 prompts." in body


def test_f_and_g_are_one_segment(settings):
    website = site()
    optin = text.optin_text(website)
    assert optin == (
        f"Cansee: you'll get 1 text a day about {NAME_24} after Autopilot runs. Msg&data "
        "rates may apply. Reply HELP for help, STOP to cancel."
    )
    trial = text.trial_text(website)
    assert trial == (
        f"Cansee test: Autopilot texts for {NAME_24} will reach this number. Reply STOP to "
        "cancel."
    )
    assert (len(optin), len(trial)) == (147, 103)
    assert sms_service.segments(optin) == sms_service.segments(trial) == 1


@pytest.mark.parametrize("base", [BASE_32, BASE_60])
@pytest.mark.parametrize("template", ["A", "B", "C", "E"])
def test_extension_characters_count_twice_and_still_fit(settings, worst, monkeypatch, base,
                                                        template):
    # A name and quotes made of the extension table take two septets each.
    settings.FRONTEND_URL = base
    monkeypatch.setattr(text, "_top_and_weakest", lambda run: [
        text.Part("top", 'Top: "{q}" 999/999.', quoted="[" * 40),
        text.Part("weak", 'Weakest: "{q}" 999/999{note}.', quoted="{" * 40, note=" (+999 at 0)"),
    ])
    run = worst_run(website=site(name="A" + "€" * 29),
                    prompts_done=998 if template == "B" else 999,
                    answers_answered=0 if template == "C" else 1000,
                    plan={**worst_run().plan, "paused": True})
    body = build(template, run, worst)
    assert septets(body) <= 300
    name = "A" + "€" * 23
    head = f"Cansee daily, {name}, first run:" if template == "E" else f"Cansee daily, {name}:"
    assert body.startswith(head)
    assert body.endswith("Reply STOP to end")


def test_a_body_still_too_long_raises(monkeypatch):
    with pytest.raises(text.TextTooLong):
        text.assemble("Cansee daily, X:", [text.Part("why", "x" * 400)])


# -- the drop order ---------------------------------------------------------------------


def test_quotes_shrink_first_then_parts_drop_in_order(monkeypatch):
    parts = [
        text.Part("size", "9 prompts, 2 engines."),
        text.Part("top", 'Top: "{q}" 1/1.', quoted="a" * 40),
        text.Part("weak", 'Weakest: "{q}" 0/1{note}.', quoted="b" * 40, note=" (+3 at 0)"),
        text.Part("google", "Google page 1: 0/9."),
        text.Part("claims", "Claims pending."),
        text.Part("link", "https://cansee.ai/r/k3v9x2qa"),
    ]
    full = text.assemble("Cansee daily, X:", parts)
    assert '"' + "a" * 27 + '..."' in full and "(+3 at 0)" in full
    seen = []
    for budget in range(len(full), 20, -1):
        monkeypatch.setattr(text, "MAX_SEPTETS", budget)
        try:
            body = text.assemble("Cansee daily, X:", parts)
        except text.TextTooLong:
            break
        assert septets(body) <= budget
        marks = {
            "note": "(+3 at 0)" in body, "size": "9 prompts" in body,
            "claims": "Claims" in body, "google": "Google" in body, "weak": "Weakest" in body,
            "top": "Top:" in body, "link": "https://" in body,
        }
        gone = [k for k in text.DROP_ORDER if not marks[k]]
        if gone and (not seen or seen[-1] != gone[-1]):
            seen.append(gone[-1])
        # A part only goes once every part before it in the order is gone.
        assert gone == list(text.DROP_ORDER[:len(gone)])
        assert body.startswith("Cansee daily, X:") and body.endswith("Reply STOP to end")
    assert seen == list(text.DROP_ORDER)


def test_quote_keeps_27_characters_plus_the_ellipsis():
    assert text.quote("short prompt", 30) == "short prompt"
    assert text.quote("x" * 30, 30) == "x" * 30
    assert text.quote("y" * 31, 30) == "y" * 27 + "..."
    assert text.quote("z" * 31, 12) == "z" * 9 + "..."


# -- fields -------------------------------------------------------------------------------


def test_words_and_numbers():
    assert text.change_words(None) is None
    assert text.change_words(0.4) == text.change_words(-0.49) == "no change"
    assert text.change_words(0.5) == "up 1 pt"
    assert text.change_words(-1.2) == "down 1 pt"
    assert text.change_words(3.1) == "up 3 pts"
    assert text.change_words(-100.0) == "down 100 pts"
    assert text.usd(Decimal("1.2700")) == "$1.27"
    assert text.usd(Decimal("0.0040")) == "<$0.01"
    assert text.usd(Decimal("0.0050")) == "$0.01"
    assert text.usd(0) == "$0.00"
    assert text.whole_pct(15, 18) == 83 and text.whole_pct(1, 8) == 13
    assert text.whole_pct(0, 0) == 0
    assert text.count(1, "prompt") == "1 prompt" and text.count(2, "engine") == "2 engines"


def test_a_name_with_no_gsm7_letter_becomes_the_domain():
    assert text.project_name(site(name="日本語のノート")) == "notion.example"
    assert text.project_name(site(name="2026 🚀")) == "notion.example"
    assert text.project_name(site(name="Café “Notes”")) == 'Café "Notes"'
    assert text.project_name(site(name="A" * 30)) == "A" * 24
    assert text.project_name(site(name="x" * 23 + " tail")) == "x" * 23


def test_a_prompt_with_no_gsm7_letter_becomes_its_rank():
    ranking = {"min_answers": 4, "prompts": [
        {"ranked": True, "text": "最高のノートアプリ", "named": 5, "answers": 6,
         "share_pct": 83.3, "rank": 1},
        {"ranked": True, "text": "best notes app", "named": 1, "answers": 6,
         "share_pct": 16.7, "rank": 2},
    ]}
    parts = text.top_and_weakest_parts(ranking)
    assert [p.render(30, note=True) for p in parts] == [
        'Top: "prompt 1" 5/6.', 'Weakest: "best notes app" 1/6.',
    ]
    rows = [SimpleNamespace(answers_named=2, answers_answered=2, position=3,
                            brand_prompt=SimpleNamespace(created_at=datetime(2026, 1, 1),
                                                         prompt=SimpleNamespace(text="😀😀")))]
    assert text.first_run_parts(rows)[0].render(30, note=True) == 'Named most: "prompt 4" 2/2.'


def test_top_weakest_ties_and_the_zero_note():
    def row(rank, named, answers, share):
        return {"ranked": True, "text": f"prompt text {rank}", "named": named,
                "answers": answers, "share_pct": share, "rank": rank}

    ranking = {"min_answers": 4, "prompts": [
        row(1, 6, 6, 100.0), row(2, 0, 4, 0.0), row(3, 0, 9, 0.0), row(4, 0, 5, 0.0),
        {"ranked": False, "text": "new", "named": 0, "answers": 1, "share_pct": 0.0, "rank": None},
    ]}
    parts = text.top_and_weakest_parts(ranking)
    rendered = [p.render(30, note=True) for p in parts]
    # Ties on share: more answers is weaker; the other two at 0 are counted.
    assert rendered == ['Top: "prompt text 1" 6/6.', 'Weakest: "prompt text 3" 0/9 (+2 at 0).']
    one = text.top_and_weakest_parts({"min_answers": 4, "prompts": [row(1, 3, 4, 75.0)]})
    assert [p.key for p in one] == ["top"]
    none = text.top_and_weakest_parts({"min_answers": 4, "prompts": []})
    assert [p.render(30, note=True) for p in none] == ["Prompts rank after 4 answers."]


def test_first_run_named_most_ties_and_never_named():
    def row(named, answered, day, position, words):
        return SimpleNamespace(
            answers_named=named, answers_answered=answered, position=position,
            brand_prompt=SimpleNamespace(created_at=datetime(2026, 1, day),
                                         prompt=SimpleNamespace(text=words)),
        )

    rows = [row(2, 2, 3, 0, "newer"), row(2, 2, 1, 1, "older"), row(2, 1, 1, 2, "fewer"),
            row(0, 2, 1, 3, "zero"), row(0, 1, 1, 4, "zero too")]
    rendered = [p.render(30, note=True) for p in text.first_run_parts(rows)]
    assert rendered == ['Named most: "older" 2/2.', "Never named: 2 prompts."]
    nothing = [p.render(30, note=True) for p in text.first_run_parts([row(0, 2, 1, 0, "x")])]
    assert nothing == ["Never named: 1 prompt."]


# -- unmeasured parts ---------------------------------------------------------------------


def notion_run(**fields) -> AutopilotRun:
    values = {
        "website": site(name=BRAND), "local_date": date(2026, 11, 4), "link_code": "k3v9x2qa",
        "status": "done", "prompts_planned": 9, "prompts_done": 9, "answers_asked": 18,
        "answers_answered": 18, "answers_named": 15, "change_pts": 6.0,
        "google_status": "done", "google_measured": 9, "google_page_one": 0,
        "analysis_status": "done", "new_contradicted": 0, "ai_cost_usd": Decimal("0.36"),
        "plan": {"google": True, "cadence": "daily", "engines": FIVE[:2], "ask": True},
    }
    values.update(fields)
    return AutopilotRun(**values)


@pytest.fixture
def notion(monkeypatch, settings):
    settings.FRONTEND_URL = "https://cansee.ai"
    state = {"template": "A"}
    monkeypatch.setattr(text, "choose_template", lambda run: state["template"])
    monkeypatch.setattr(text, "_engines_asked", lambda run: 2)
    monkeypatch.setattr(ranking_service, "rank_prompts", lambda website, **kw: {
        "min_answers": 4, "prompts": [
            {"ranked": True, "text": "all in one workspace for notes and docs", "named": 13,
             "answers": 14, "share_pct": 92.9, "rank": 1},
            {"ranked": True, "text": "best wiki software for a fast growing team",
             "named": 6, "answers": 14, "share_pct": 42.9, "rank": 2},
        ]})
    return state


def test_the_notion_format_example(notion):
    body, template = text.build_text(notion_run())
    assert template == "A"
    assert body == (
        'Cansee daily, Notion: 9 prompts, 2 engines. Named in 15/18 answers (83%), up 6 pts. '
        'Top: "all in one workspace for no..." 13/14. Weakest: "best wiki software for a '
        'fa..." 6/14. Google page 1: 0/9. Claims: none new. AI $0.36. '
        'https://cansee.ai/r/k3v9x2qa Reply STOP to end'
    )
    assert len(body) == 271 and sms_service.segments(body) == 2


@pytest.mark.parametrize(("fields", "claims"), [
    ({"analysis_status": "done", "new_contradicted": 2}, "Claims: 2 new contradicted."),
    ({"analysis_status": "done", "new_contradicted": 0}, "Claims: none new."),
    ({"analysis_status": "pending"}, "Claims pending."),
    ({"analysis_status": "running"}, "Claims pending."),
    ({"analysis_status": "skipped"}, "Claims not checked."),
    ({"analysis_status": "failed"}, "Claims not checked."),
    ({"analysis_status": "off"}, None),
    ({"analysis_status": "done", "new_contradicted": 1, "answers_named": 0}, None),
])
def test_every_claims_state(notion, fields, claims):
    body, _ = text.build_text(notion_run(**fields))
    if claims is None:
        assert "Claims" not in body
    else:
        assert claims in body


def test_null_change_and_the_google_segment(notion):
    body, _ = text.build_text(notion_run(change_pts=None))
    assert "Named in 15/18 answers (83%). Top:" in body
    body, _ = text.build_text(notion_run(change_pts=0.2))
    assert "(83%), no change." in body
    weekly = notion_run(plan={**notion_run().plan, "cadence": "weekly"})
    assert "Google page 1 (this week): 0/9." in text.build_text(weekly)[0]
    unchecked = notion_run(google_measured=0, google_page_one=0, google_status="skipped")
    assert "Google not checked." in text.build_text(unchecked)[0]
    off = notion_run(google_status="off", plan={**notion_run().plan, "google": False})
    assert "Google" not in text.build_text(off)[0]


def test_unranked_and_single_ranked(notion, monkeypatch):
    monkeypatch.setattr(ranking_service, "rank_prompts", lambda website, **kw: {
        "min_answers": 4, "prompts": [{"ranked": False, "text": "x", "named": 1, "answers": 2,
                                       "share_pct": 50.0, "rank": None}]})
    body, _ = text.build_text(notion_run())
    assert "Prompts rank after 4 answers." in body and "Top:" not in body
    assert septets(body) <= 300
    monkeypatch.setattr(ranking_service, "rank_prompts", lambda website, **kw: {
        "min_answers": 4, "prompts": [{"ranked": True, "text": "only one", "named": 3,
                                       "answers": 4, "share_pct": 75.0, "rank": 1}]})
    body, _ = text.build_text(notion_run())
    assert 'Top: "only one" 3/4.' in body and "Weakest" not in body


@pytest.mark.parametrize(("fields", "why"), [
    ({"prompts_planned": 0, "plan": {"skip": "nothing_to_run"}}, "No tracked prompts yet"),
    ({"plan": {"run_engines": False, "engines": []}}, "AI engines are off in Autopilot"),
    ({"plan": {"run_engines": True, "engines": []}}, "No AI engine is configured"),
    ({"status": "interrupted", "answers_asked": 4}, "The run stopped early"),
    ({"answers_asked": 1}, "No engine answered (1 error)"),
    ({"answers_asked": 18}, "No engine answered (18 errors)"),
])
def test_why_nothing_was_measured(notion, fields, why):
    notion["template"] = "C"
    values = {"answers_answered": 0, "answers_named": 0, "status": "failed",
              "plan": {"engines": FIVE[:2], "google": False, "ask": True}}
    values.update(fields)
    body, _ = text.build_text(notion_run(**values))
    assert f": no AI answers today. {why}. AI $0.36." in body
