import { afterEach, describe, expect, it, vi } from 'vitest'
import { PREVIEW_CSP, UNSETTLED_HTML, buildSrcdoc, cleanCss, sanitizePageHtml } from '../srcdoc'

const parse = (html) => new DOMParser().parseFromString(html, 'text/html')

// Elements that would run script once a browser parses the HTML.
function handlers(html) {
  return Array.from(parse(html).querySelectorAll('*')).filter((el) =>
    Array.from(el.attributes).some((attr) => attr.name.toLowerCase().startsWith('on'))
  )
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=https://evil.test">
<meta http-equiv="Content-Security-Policy" content="default-src *">
<meta name="referrer" content="unsafe-url">
<base href="https://evil.test/">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<link rel="stylesheet" href="https://evil.test/x.css">
<link rel="icon" href="https://evil.test/favicon.ico">
<style>body{color:#192118}</style>
<script>alert(1)</script>
<script type="application/ld+json">{"@type":"FAQPage"}</script>
</head>
<body onload="alert(1)">
<h1 onclick="alert(1)" class="hero">More rides.</h1>
<a href="javascript:alert(1)" id="js">bad</a>
<a href=" jav&#x09;ascript:alert(1)" id="js2">bad2</a>
<a href="data:text/html,<script>alert(1)</script>" id="data">data</a>
<a href="https://shop.test/guide" id="ok">ok</a>
<img src="data:image/png;base64,AAAA" id="img" onerror="alert(1)">
<iframe src="https://evil.test"></iframe>
<object data="x.swf"></object>
<embed src="x.swf">
<form action="https://evil.test"><button formaction="javascript:alert(1)">Go</button></form>
<svg><script>alert(1)</script><a href="javascript:alert(1)" id="svga"><text>t</text></a>
<animate attributeName="href" to="javascript:alert(1)"/><use href="https://evil.test/s.svg#x"/></svg>
<div style="background:url(javascript:alert(1))" id="styled">s</div>
</body>
</html>`

describe('buildSrcdoc', () => {
  const out = buildSrcdoc(PAGE)
  const doc = parse(out)

  it('starts with a doctype and puts the CSP first in head', () => {
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    const first = doc.head.firstElementChild
    expect(first.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first.getAttribute('content')).toBe(PREVIEW_CSP)
    expect(doc.head.children[1].getAttribute('name')).toBe('referrer')
    expect(doc.head.children[1].getAttribute('content')).toBe('no-referrer')
    expect(doc.head.children[2].tagName).toBe('BASE')
    expect(doc.head.children[2].getAttribute('target')).toBe('_blank')
    expect(doc.head.children[2].hasAttribute('href')).toBe(false)
  })

  it('pins the expected policy', () => {
    expect(PREVIEW_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data:; form-action 'none'; base-uri 'none'"
    )
  })

  it('removes scripts, frames, plugins, the original base and http-equiv metas', () => {
    expect(doc.querySelectorAll('script')).toHaveLength(0)
    expect(doc.querySelectorAll('iframe, object, embed')).toHaveLength(0)
    expect(doc.querySelectorAll('base')).toHaveLength(1)
    expect(doc.querySelectorAll('meta[http-equiv]')).toHaveLength(1)
    expect(doc.querySelectorAll('meta[name="referrer"]')).toHaveLength(1)
    expect(out).not.toContain('evil.test/x.css')
    expect(out).not.toContain('refresh')
  })

  it('keeps only Google Fonts stylesheets among links', () => {
    const links = doc.querySelectorAll('link')
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toContain('fonts.googleapis.com/css2')
  })

  it('strips event handlers and script URLs', () => {
    expect(out).not.toMatch(/\son[a-z]+=/i)
    expect(doc.getElementById('js').hasAttribute('href')).toBe(false)
    expect(doc.getElementById('js2').hasAttribute('href')).toBe(false)
    expect(doc.getElementById('data').hasAttribute('href')).toBe(false)
    expect(doc.getElementById('ok').getAttribute('href')).toBe('https://shop.test/guide')
    expect(doc.getElementById('svga').hasAttribute('href')).toBe(false)
    expect(doc.getElementById('styled').hasAttribute('style')).toBe(false)
    expect(doc.querySelector('button').hasAttribute('formaction')).toBe(false)
  })

  it('keeps inline images, styles and content', () => {
    expect(doc.getElementById('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(doc.querySelector('style').textContent).toContain('#192118')
    expect(doc.querySelector('h1.hero').textContent).toBe('More rides.')
  })

  it('drops SVG animations that rewrite links and external use references', () => {
    expect(doc.querySelectorAll('animate')).toHaveLength(0)
    expect(doc.querySelectorAll('use')).toHaveLength(0)
  })

  it('handles empty and partial input from a streaming draft', () => {
    const empty = parse(buildSrcdoc(''))
    expect(empty.head.firstElementChild.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    const partial = parse(buildSrcdoc('<!DOCTYPE html><html><head><style>h1{color:red}</sty'))
    expect(partial.head.firstElementChild.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(buildSrcdoc(null)).toContain('Content-Security-Policy')
  })
})

describe('sanitizePageHtml', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cleans without injecting the preview policy', () => {
    const out = sanitizePageHtml(PAGE)
    const doc = parse(out)
    expect(doc.querySelectorAll('script:not([type="application/ld+json"]), iframe, base, meta[http-equiv]')).toHaveLength(0)
    expect(out).not.toContain(PREVIEW_CSP)
    expect(doc.querySelector('h1').hasAttribute('onclick')).toBe(false)
  })

  it('keeps the FAQPage JSON-LD the landing page carries, and only that script', () => {
    const doc = parse(sanitizePageHtml(PAGE))
    const scripts = doc.querySelectorAll('script')
    expect(scripts).toHaveLength(1)
    expect(scripts[0].getAttribute('type')).toBe('application/ld+json')
    expect(JSON.parse(scripts[0].textContent)).toEqual({ '@type': 'FAQPage' })
  })

  it('reduces JSON-LD to its type and text, escapes "<" and drops invalid JSON', () => {
    const out = sanitizePageHtml(`<!DOCTYPE html><html><head>
<script type=" Application/LD+JSON " id="x" onload="alert(1)">{"@type":"FAQPage","a":"1 < 2 <\\/script> <!--"}</script>
<script type="application/ld+json">{"@type": broken</script>
</head><body><svg><script type="application/ld+json">{"a":1}</script></svg></body></html>`)
    const scripts = parse(out).querySelectorAll('script')
    expect(scripts).toHaveLength(1)
    expect(Array.from(scripts[0].attributes).map((a) => `${a.name}=${a.value}`)).toEqual(['type=application/ld+json'])
    expect(scripts[0].textContent).not.toContain('<')
    expect(JSON.parse(scripts[0].textContent).a).toBe('1 < 2 </script> <!--')
  })

  it('never hands out HTML that turns into live markup when parsed again (mutation XSS)', () => {
    const payloads = [
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(document.domain)></style></mglyph></table></mtext></math>',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
      '<math><mi><table><mglyph><style><svg><img src=x onerror=alert(2)></style></mglyph></table></mi></math>',
    ]
    for (const payload of payloads) {
      const out = sanitizePageHtml(payload)
      expect(handlers(out)).toEqual([])
      // Parsing the download again finds nothing new to clean.
      expect(handlers(sanitizePageHtml(out))).toEqual([])
      expect(handlers(buildSrcdoc(payload))).toEqual([])
    }
  })

  it('removes elements in a namespace the parser would not give them, and keeps inline SVG', () => {
    const out = sanitizePageHtml(`<!DOCTYPE html><html><body>
<svg viewBox="0 0 10 10" id="icon"><title>Icon</title><path d="M0 0h10v10z" fill="#192118"/>
<foreignObject width="10" height="10"><p id="fo">Wrapped text</p></foreignObject></svg>
<math><mi>x</mi></math>
</body></html>`)
    const doc = parse(out)
    expect(doc.querySelector('#icon path').getAttribute('d')).toBe('M0 0h10v10z')
    expect(doc.querySelector('#fo').textContent).toBe('Wrapped text')
    expect(doc.querySelector('math mi').textContent).toBe('x')
  })

  it('gives the download the preview policy for resources', () => {
    const out = sanitizePageHtml(`<!DOCTYPE html><html><head>
<style>
@import "https://evil.test/x.css";
@import url("https://fonts.googleapis.com/css2?family=Inter");
.hero{background-image:image-set("https://collector.test/p.png" 1x)}
.alt{background-image:-webkit-image-set("https://collector.test/q.png" 1x)}
.bg{background:url(https://collector.test/r.png)}
.esc{background:u\\72l(https://collector.test/s.png)}
.own{background:url(/img/hero.png)}
.font{font-family:Inter}
</style></head><body background="https://collector.test/b.png">
<img id="ext" src="https://collector.test/t.gif" srcset="https://collector.test/t2.gif 2x">
<img id="rel" src="/img/a.png" alt="A">
<img id="noslash" src="https:collector.test/n.gif">
<img id="unc" src="\\\\collector.test\\share\\p.gif">
<img id="inline" src="data:image/png;base64,AAAA">
<video id="vid" poster="//collector.test/v.png"></video>
<svg><image id="svgimg" href="https://collector.test/i.png"/><rect id="rect" fill="url(https://collector.test/f.svg#g)"/></svg>
<div id="styled" style="background:image-set('https://collector.test/u.png' 1x);color:red">x</div>
<form id="lead" action="https://collector.test/lead" method="post"><input name="email"></form>
<a id="link" href="https://shop.test/guide">Guide</a>
</body></html>`)
    expect(out).not.toContain('collector.test')
    expect(out).not.toContain('evil.test')
    const doc = parse(out)
    const css = doc.querySelector('style').textContent
    expect(css).toContain('fonts.googleapis.com/css2?family=Inter')
    expect(css).toContain('url(/img/hero.png)')
    expect(css).toContain('.font{font-family:Inter}')
    expect(doc.getElementById('ext').hasAttribute('src')).toBe(false)
    expect(doc.getElementById('ext').hasAttribute('srcset')).toBe(false)
    expect(doc.getElementById('rel').getAttribute('src')).toBe('/img/a.png')
    expect(doc.getElementById('noslash').hasAttribute('src')).toBe(false)
    expect(doc.getElementById('unc').hasAttribute('src')).toBe(false)
    expect(doc.getElementById('inline').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(doc.getElementById('styled').getAttribute('style')).toBe('background:none;color:red')
    expect(doc.getElementById('lead').hasAttribute('action')).toBe(false)
    expect(doc.getElementById('lead').getAttribute('method')).toBe('post')
    expect(doc.getElementById('link').getAttribute('href')).toBe('https://shop.test/guide')
  })

  it('refuses HTML whose cleaning never settles', () => {
    // A parser that brings back new markup on every parse.
    const Real = window.DOMParser
    class Revealing {
      parseFromString(html, type) {
        const doc = new Real().parseFromString(html, type)
        doc.body.append(doc.createElement('script'))
        return doc
      }
    }
    vi.stubGlobal('DOMParser', Revealing)
    expect(() => sanitizePageHtml('<p>Hi</p>')).toThrow(UNSETTLED_HTML)
    expect(buildSrcdoc('<p>Hi</p>')).toContain('Hi')
  })
})

describe('cleanCss', () => {
  it('turns every way CSS can fetch from another host into none', () => {
    expect(cleanCss('a{background:url(https://x.test/p.png) no-repeat}')).toBe('a{background:none no-repeat}')
    expect(cleanCss('a{background:url( "//x.test/p.png" )}')).toBe('a{background:none}')
    expect(cleanCss('a{b:image-set("https://x.test/p.png" 1x, "a.png" 2x)}')).toBe('a{b:none}')
    expect(cleanCss('a{b:-webkit-image-set("https://x.test/p.png" 1x)}')).toBe('a{b:none}')
    expect(cleanCss('a{b:image-set(var(--u) 1x)}')).toBe('a{b:none}')
    expect(cleanCss('a{b:image-set("a.png" 1x, url(https://x.test/b.png) 2x)}')).toBe('a{b:none}')
    expect(cleanCss('a{b:src("https://x.test/p.png")}')).toBe('a{b:none}')
    expect(cleanCss('a{b:url(data:text/html,x)}')).toBe('a{b:none}')
    expect(cleanCss('@import "https://x.test/a.css";p{color:red}')).toBe('p{color:red}')
  })

  it('reads escapes, strings and comments as a browser does', () => {
    expect(cleanCss(String.raw`a{b:\75 rl(https://x.test/p.png)}`)).toBe('a{b:none}')
    expect(cleanCss(String.raw`a{b:url(\68ttps://x.test/p.png)}`)).toBe('a{b:none}')
    expect(cleanCss(String.raw`@\69mport "https://x.test/a.css";p{}`)).toBe('p{}')
    expect(cleanCss('a{b:url(x"y) url(https://x.test/p.png)}')).toBe('a{b:url(x"y) none}')
    const untouched = String.raw`.sm\:flex{content:"url(https://x.test/)"} /* url(https://x.test/) */`
    expect(cleanCss(untouched)).toBe(untouched)
  })

  it('keeps inline images, the page own paths, gradients and Google Fonts', () => {
    const css = [
      "@import url('https://fonts.googleapis.com/css2?family=Inter');",
      '@font-face{src:url(https://fonts.gstatic.com/s/x.woff2) format("woff2")}',
      'a{background:url(/img/a.png), linear-gradient(red, blue)}',
      'b{background:image-set("b.avif" type("image/avif") 1x, url(data:image/png;base64,AA) 2x)}',
    ].join('')
    expect(cleanCss(css)).toBe(css)
  })
})
