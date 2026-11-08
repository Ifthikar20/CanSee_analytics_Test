import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { isSafeHref, renderMarkdown, slugify } from '../markdown.js'
import { sanitizeBlogHtml } from '../sanitize.js'

const render = (md) => sanitizeBlogHtml(renderMarkdown(md).html, window)

describe('renderMarkdown', () => {
    it('gives H2 and H3 headings unique ids and builds the table of contents from H2s', () => {
        const { html, toc, headings } = renderMarkdown('## Why it matters\n\ntext\n\n### Detail\n\n## Why it matters\n\n## 2026 plans')
        expect(toc).toEqual([
            { id: 'why-it-matters', text: 'Why it matters' },
            { id: 'why-it-matters-2', text: 'Why it matters' },
            { id: 's-2026-plans', text: '2026 plans' },
        ])
        expect(headings).toEqual(['h2', 'h3', 'h2', 'h2'])
        expect(html).toContain('<h2 id="why-it-matters">Why it matters</h2>')
        expect(html).toContain('<h3 id="detail">Detail</h3>')
    })

    it('never gives a heading an id the page uses itself', () => {
        expect(renderMarkdown('## Blog FAQ').toc[0].id).toBe('blog-faq-2')
    })

    it('uses the text of formatted headings', () => {
        expect(renderMarkdown('## What **GEO** means for `llms.txt`').toc[0]).toEqual({
            id: 'what-geo-means-for-llms-txt',
            text: 'What GEO means for llms.txt',
        })
    })

    it('escapes raw HTML instead of rendering it', () => {
        const { html } = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
        expect(html).not.toContain('<script>')
        expect(html).not.toContain('<img')
        expect(html).toContain('&lt;script&gt;')
    })

    it('does not render images', () => {
        expect(renderMarkdown('![alt](https://example.com/x.png)').html).not.toContain('<img')
    })

    it('wraps tables in a scrolling box', () => {
        const { html } = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
        expect(html).toMatch(/^<div class="blog-table"><table>/)
    })

    it('lists links and counts words', () => {
        const out = renderMarkdown('One two [three](/blog/x) four.\n\n- five `six`')
        expect(out.links).toEqual(['/blog/x'])
        expect(out.wordCount).toBe(6)
    })
})

describe('isSafeHref and slugify', () => {
    it.each([
        ['/blog/post', true],
        ['#section', true],
        ['https://example.com', true],
        ['mailto:hello@example.com', true],
        ['//evil.example', false],
        ['javascript:alert(1)', false],
        ['java\nscript:alert(1)', false],
        ['data:text/html,x', false],
        [null, false],
    ])('isSafeHref(%j) is %s', (href, expected) => {
        expect(isSafeHref(href)).toBe(expected)
    })

    it.each([
        ['Generative engine optimization (GEO)', 'generative-engine-optimization-geo'],
        ['Café & résumé', 'cafe-resume'],
        ['   ', 'section'],
        ['10 steps', 's-10-steps'],
    ])('slugify(%j) is %j', (text, expected) => {
        expect(slugify(text)).toBe(expected)
    })
})

describe('sanitizeBlogHtml', () => {
    it('keeps headings with ids, including ids that name document properties', () => {
        const html = render('## Links\n\n## Images\n\n## Cookie')
        expect(html).toContain('<h2 id="links">Links</h2>')
        expect(html).toContain('<h2 id="images">Images</h2>')
        expect(html).toContain('<h2 id="cookie">Cookie</h2>')
    })

    it('opens other sites in a new tab and keeps site links in place', () => {
        const html = render('[out](https://example.com/a) [in](/pricing) [anchor](#x)')
        expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">out</a>')
        expect(html).toContain('<a href="/pricing">in</a>')
        expect(html).toContain('<a href="#x">anchor</a>')
    })

    it('never turns an unsafe Markdown link into a link', () => {
        const html = render('[bad](javascript:alert(1)) [proto](//evil.example/x)')
        expect(html).not.toContain('<a')
        expect(html).toContain('[bad]')
    })

    it('drops unsafe hrefs that reach the sanitizer, keeping the text', () => {
        const html = sanitizeBlogHtml('<a href="javascript:alert(1)">bad</a><a href="//evil.example/x">proto</a>', window)
        expect(html).toBe('<a>bad</a><a>proto</a>')
    })

    it('removes markup outside the allowlist, even if it reaches the sanitizer', () => {
        const dirty =
            '<h2 id="ok" onclick="x()">T</h2><p id="nope" class="evil" style="color:red">p</p>' +
            '<img src=x onerror="alert(1)"><iframe src="https://x"></iframe><form name="cookie"></form>' +
            '<td style="text-align:center">c</td>'
        const html = sanitizeBlogHtml(dirty, window)
        expect(html).toContain('<h2 id="ok">T</h2>')
        expect(html).toContain('<p>p</p>')
        expect(html).not.toMatch(/onclick|onerror|<img|<iframe|<form|evil|color:red/)
    })

    it('keeps table alignment styles only', () => {
        const html = render('| a | b |\n| :-: | --- |\n| 1 | 2 |')
        expect(html).toContain('style="text-align:center"')
    })

    it('works with a jsdom window, as the prerender script uses it', () => {
        const { window: other } = new JSDOM('')
        expect(sanitizeBlogHtml('<h2 id="hi">Hi</h2><a href="javascript:y">x</a><a href="https://e.example">e</a>', other)).toBe(
            '<h2 id="hi">Hi</h2><a>x</a><a href="https://e.example" target="_blank" rel="noopener noreferrer">e</a>'
        )
        other.close()
    })

    it('needs a window', () => {
        expect(sanitizeBlogHtml('', null)).toBe('')
        expect(() => sanitizeBlogHtml('<p>x</p>', {})).toThrow(/needs a window/)
    })
})
