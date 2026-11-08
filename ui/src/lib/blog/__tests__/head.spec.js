import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyHead, escapeHtml, headTags, renderHeadTags, serializeJsonLd } from '../head.js'

const SHELL_TITLE = 'Cansee — Brand Intelligence'
const SHELL_DESC = 'Cansee compares where your brand ranks.'

const spec = {
    title: 'Post title',
    description: 'Post description',
    canonical: 'https://cansee.ai/blog/post',
    meta: [
        { property: 'og:title', content: 'Post title' },
        { name: 'twitter:card', content: 'summary' },
    ],
    jsonLd: [{ '@type': 'BlogPosting', headline: 'Post </script><b>' }],
}

function resetHead() {
    document.head.innerHTML = `<title>${SHELL_TITLE}</title><meta name="description" content="${SHELL_DESC}">`
}

const managed = () => [...document.head.querySelectorAll('[data-head]')]

describe('serializeJsonLd', () => {
    it('cannot close the script block it sits in', () => {
        const text = serializeJsonLd({ a: '</script><script>alert(1)</script>', b: 'x & y', c: 'line\u2028sep' })
        expect(text).not.toMatch(/[<>&\u2028]/)
        expect(JSON.parse(text)).toEqual({ a: '</script><script>alert(1)</script>', b: 'x & y', c: 'line\u2028sep' })
    })
})

describe('headTags and renderHeadTags', () => {
    it('lists canonical, meta and JSON-LD tags in order', () => {
        const tags = headTags(spec)
        expect(tags.map((t) => t.tag)).toEqual(['link', 'meta', 'meta', 'script'])
        expect(tags[0].attrs).toEqual({ rel: 'canonical', href: 'https://cansee.ai/blog/post' })
        expect(tags[1].attrs).toEqual({ property: 'og:title', content: 'Post title' })
        expect(tags[2].attrs).toEqual({ name: 'twitter:card', content: 'summary' })
    })

    it('renders escaped HTML, every tag marked data-head', () => {
        const html = renderHeadTags({ meta: [{ name: 'description', content: 'a "quoted" <b> & more' }], jsonLd: [] })
        expect(html).toBe('<meta name="description" content="a &quot;quoted&quot; &lt;b&gt; &amp; more" data-head>')
        const full = renderHeadTags(spec).split('\n')
        expect(full).toHaveLength(4)
        expect(full.every((line) => line.includes(' data-head>'))).toBe(true)
        expect(full[3]).toMatch(/^<script type="application\/ld\+json" data-head>\{.*\}<\/script>$/)
        expect(full[3]).not.toContain('</script><b>')
    })

    it('escapes all five HTML characters', () => {
        expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
        expect(escapeHtml(null)).toBe('')
    })
})

describe('applyHead', () => {
    beforeEach(resetHead)
    afterEach(resetHead)

    it('sets title, description and the managed tags', () => {
        applyHead(document, spec)
        expect(document.title).toBe('Post title')
        expect(document.head.querySelector('meta[name="description"]').getAttribute('content')).toBe('Post description')
        expect(document.head.querySelector('link[rel="canonical"]').getAttribute('href')).toBe('https://cansee.ai/blog/post')
        expect(document.head.querySelector('meta[property="og:title"]').getAttribute('content')).toBe('Post title')
        const ld = document.head.querySelector('script[type="application/ld+json"]')
        expect(JSON.parse(ld.textContent)).toEqual(spec.jsonLd[0])
        expect(managed()).toHaveLength(4)
    })

    it('restores the index.html title and description and removes its tags', () => {
        const restore = applyHead(document, spec)
        restore()
        expect(document.title).toBe(SHELL_TITLE)
        expect(document.head.querySelector('meta[name="description"]').getAttribute('content')).toBe(SHELL_DESC)
        expect(managed()).toEqual([])
    })

    it('replaces the tags of a prerendered page and restores the defaults it recorded', () => {
        // What the prerender script writes into dist/blog/<slug>/index.html.
        document.head.innerHTML =
            `<title data-default="${SHELL_TITLE}">Old post</title>` +
            `<meta name="description" content="Old description" data-default="${SHELL_DESC}">` +
            '<link rel="canonical" href="https://cansee.ai/blog/old" data-head>' +
            '<script type="application/ld+json" data-head>{}</script>'
        const restore = applyHead(document, spec)
        expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
        expect(document.head.querySelector('link[rel="canonical"]').getAttribute('href')).toBe('https://cansee.ai/blog/post')
        expect(document.head.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1)
        restore()
        expect(document.title).toBe(SHELL_TITLE)
        expect(document.head.querySelector('meta[name="description"]').getAttribute('content')).toBe(SHELL_DESC)
        expect(managed()).toEqual([])
    })

    it('applying twice through restore never duplicates tags', () => {
        let restore = applyHead(document, spec)
        restore()
        restore = applyHead(document, { ...spec, title: 'Second' })
        expect(document.title).toBe('Second')
        expect(managed()).toHaveLength(4)
        restore()
    })

    it('adds a description when the document has none, and removes it again', () => {
        document.head.innerHTML = '<title>T</title>'
        const restore = applyHead(document, { title: 'X', description: 'D', meta: [], jsonLd: [] })
        expect(document.head.querySelector('meta[name="description"]').getAttribute('content')).toBe('D')
        restore()
        expect(document.head.querySelector('meta[name="description"]')).toBeNull()
        expect(document.title).toBe('T')
    })
})
