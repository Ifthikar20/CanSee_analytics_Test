// The prerender step: the pure page builders in lib/blog/prerender.js and
// scripts/prerender-blog.mjs run against the fixture posts and a fake dist.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { fillShell, robotsTxt, sitemapXml } from '../prerender.js'
import { blogStylesheets, prerender } from '../../../../scripts/prerender-blog.mjs'
import { blogContent } from '../../../../scripts/blog-content.mjs'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

// A trimmed copy of the built index.html: what the script reads as the shell.
const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="description" content="Cansee compares where your brand ranks &amp; more." />
  <title>Cansee — Brand Intelligence</title>
  <script>document.documentElement.setAttribute('data-theme', 'light')</script>
  <script type="module" crossorigin src="/assets/index-abc.js"></script>
  <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
</head>
<body>
  <div id="app"></div>
</body>
</html>
`

const MANIFEST = {
    'index.html': { file: 'assets/index-abc.js', isEntry: true, css: ['assets/index-abc.css'] },
    'src/pages/blog/BlogIndexPage.vue': { file: 'assets/BlogIndexPage-1.js', imports: ['index.html', '_posts-2.js'] },
    'src/pages/blog/BlogPostPage.vue': { file: 'assets/BlogPostPage-3.js', imports: ['index.html', '_posts-2.js'], css: ['assets/BlogPostPage-3.css'] },
    '_posts-2.js': { file: 'assets/posts-2.js', imports: ['index.html'], css: ['assets/posts-2.css'] },
}

let root
const log = { log: vi.fn(), warn: vi.fn() }

function makeProject({ posts = ['posts'], manifest = MANIFEST } = {}) {
    root = mkdtempSync(join(tmpdir(), 'blog-prerender-'))
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.html'), SHELL)
    if (manifest) {
        mkdirSync(join(root, 'dist', '.vite'))
        writeFileSync(join(root, 'dist', '.vite', 'manifest.json'), JSON.stringify(manifest))
    }
    const content = join(root, 'src', 'content', 'blog')
    mkdirSync(content, { recursive: true })
    for (const dir of posts) cpSync(join(FIXTURES, dir), content, { recursive: true })
    return root
}

const read = (path) => readFileSync(join(root, 'dist', path), 'utf8')
const parse = (html) => new JSDOM(html).window.document
const jsonLd = (doc) => [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent))

beforeEach(() => {
    log.log.mockClear()
    log.warn.mockClear()
})

afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
    vi.unstubAllEnvs()
})

describe('prerender script', () => {
    it('writes the index, one page per post, the sitemap and robots.txt', () => {
        makeProject()
        const written = prerender({ root, siteUrl: 'https://cansee.ai', log })
        expect(written).toEqual([
            'blog/index.html',
            'blog/gamma-fixture-post-three/index.html',
            'blog/beta-fixture-post-two/index.html',
            'blog/alpha-fixture-post-one/index.html',
            'sitemap.xml',
            'robots.txt',
        ])
        for (const path of written) expect(existsSync(join(root, 'dist', path))).toBe(true)
        expect(log.log).toHaveBeenCalledWith('Blog prerender: 3 posts, 6 files written for https://cansee.ai')
    })

    it('bakes the article, head tags and JSON-LD into the built shell', () => {
        makeProject()
        prerender({ root, siteUrl: 'https://cansee.ai', log })
        const html = read('blog/alpha-fixture-post-one/index.html')
        const doc = parse(html)

        // The shell is reused: the app bundle still loads and mounts on #app.
        expect(html).toContain('<script type="module" crossorigin src="/assets/index-abc.js"></script>')
        expect(html).toContain("<script>document.documentElement.setAttribute('data-theme', 'light')</script>")
        expect(doc.querySelectorAll('#app')).toHaveLength(1)

        expect(doc.title).toBe('Fixture post one: how AI answers mention a small brand')
        expect(doc.querySelector('title').getAttribute('data-default')).toBe('Cansee — Brand Intelligence')
        const desc = doc.querySelectorAll('meta[name="description"]')
        expect(desc).toHaveLength(1)
        expect(desc[0].getAttribute('content')).toMatch(/^A fixture description for the first test post\./)
        expect(desc[0].getAttribute('data-default')).toBe('Cansee compares where your brand ranks & more.')
        expect(doc.querySelector('link[rel="canonical"]').getAttribute('href')).toBe('https://cansee.ai/blog/alpha-fixture-post-one')
        expect(doc.querySelector('meta[property="og:type"]').getAttribute('content')).toBe('article')
        expect(doc.querySelector('meta[property="og:url"]').getAttribute('content')).toBe('https://cansee.ai/blog/alpha-fixture-post-one')
        expect(doc.querySelector('meta[name="twitter:card"]').getAttribute('content')).toBe('summary')
        expect([...doc.querySelectorAll('meta[property="article:tag"]')].map((m) => m.content)).toEqual(['AI search', 'Visibility', 'Testing'])

        const ld = jsonLd(doc)
        expect(ld.map((x) => x['@type'])).toEqual(['BlogPosting', 'BreadcrumbList', 'FAQPage'])
        expect(ld[0]).toMatchObject({ headline: doc.title, datePublished: '2026-11-01', dateModified: '2026-11-03' })
        expect(ld[2].mainEntity[2].name).toBe('Can a question carry "quotes" & <tags>?')

        // Only the page CSS, not the entry CSS the shell already links.
        expect([...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'))).toEqual([
            '/assets/index-abc.css',
            '/assets/posts-2.css',
            '/assets/BlogPostPage-3.css',
        ])
    })

    it('writes the full article for crawlers that run no JavaScript', () => {
        makeProject()
        prerender({ root, siteUrl: 'https://cansee.ai', log })
        const doc = parse(read('blog/alpha-fixture-post-one/index.html'))
        const app = doc.querySelector('#app')
        expect(app.querySelector('h1').textContent).toBe('Fixture post one: how AI answers mention a small brand')
        expect(app.querySelectorAll('h1')).toHaveLength(1)
        expect([...app.querySelectorAll('.blog-article-head .blog-meta time')].map((t) => [t.getAttribute('datetime'), t.textContent])).toEqual([
            ['2026-11-01', 'November 1, 2026'],
            ['2026-11-03', 'November 3, 2026'],
        ])
        expect(app.querySelector('.blog-article-head .blog-meta').textContent).toContain('By Cansee team')
        expect(app.querySelector('.blog-article-head .blog-meta').textContent).toContain('6 min read')
        expect([...app.querySelectorAll('.blog-article-head .blog-tag')].map((t) => t.textContent)).toEqual(['AI search', 'Visibility', 'Testing'])
        expect([...app.querySelectorAll('.blog-toc a')].map((a) => a.getAttribute('href'))).toEqual([
            '#what-the-fixture-covers',
            '#links',
            '#key-takeaways',
            '#blog-faq',
        ])
        expect(app.querySelector('.blog-body h2#links')).not.toBeNull()
        expect(app.querySelector('.blog-body table')).not.toBeNull()
        expect(app.querySelector('.blog-body script')).toBeNull()
        expect(app.querySelector('.blog-body a[href="https://example.com/guide"]').getAttribute('rel')).toBe('noopener noreferrer')
        expect([...app.querySelectorAll('a')].map((a) => a.getAttribute('href'))).not.toContainEqual(
            expect.stringMatching(/javascript:|evil\.example/)
        )
        expect([...app.querySelectorAll('.blog-faq h3')].map((h) => h.textContent)).toContain('Can a question carry "quotes" & <tags>?')

        // Related by shared tags; previous is older, next is newer.
        expect([...app.querySelectorAll('.blog-related .blog-card-title a')].map((a) => a.getAttribute('href'))).toEqual([
            '/blog/beta-fixture-post-two',
        ])
        expect(app.querySelector('.blog-pager-prev')).toBeNull()
        expect(app.querySelector('.blog-pager-next').getAttribute('href')).toBe('/blog/beta-fixture-post-two')
        expect(app.querySelector('.blog-crumbs [aria-current="page"]').textContent).toBe(
            'Fixture post one: how AI answers mention a small brand'
        )
    })

    it('lists the posts newest first on the index', () => {
        makeProject()
        prerender({ root, siteUrl: 'https://cansee.ai', log })
        const doc = parse(read('blog/index.html'))
        expect(doc.querySelector('link[rel="canonical"]').getAttribute('href')).toBe('https://cansee.ai/blog')
        expect([...doc.querySelectorAll('.blog-card-title a')].map((a) => a.getAttribute('href'))).toEqual([
            '/blog/gamma-fixture-post-three',
            '/blog/beta-fixture-post-two',
            '/blog/alpha-fixture-post-one',
        ])
        expect(doc.querySelector('.blog-card .blog-meta').textContent).toBe('November 8, 2026·5 min read')
        const ld = jsonLd(doc)
        expect(ld.map((x) => x['@type'])).toEqual(['Blog', 'BreadcrumbList'])
        expect(ld[0].blogPost).toHaveLength(3)
    })

    it('writes the sitemap with lastmod and robots.txt for the configured origin', () => {
        makeProject()
        prerender({ root, siteUrl: 'https://staging.example.com/', log })
        const sitemap = read('sitemap.xml')
        const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
        expect(locs).toEqual([
            'https://staging.example.com/',
            'https://staging.example.com/pricing',
            'https://staging.example.com/docs',
            'https://staging.example.com/blog',
            'https://staging.example.com/blog/gamma-fixture-post-three',
            'https://staging.example.com/blog/beta-fixture-post-two',
            'https://staging.example.com/blog/alpha-fixture-post-one',
        ])
        expect(sitemap).toContain('<url><loc>https://staging.example.com/blog</loc><lastmod>2026-11-08</lastmod></url>')
        expect(sitemap).toContain(
            '<url><loc>https://staging.example.com/blog/alpha-fixture-post-one</loc><lastmod>2026-11-03</lastmod></url>'
        )
        expect(read('robots.txt')).toBe('User-agent: *\nAllow: /\n\nSitemap: https://staging.example.com/sitemap.xml\n')
    })

    it('reads the origin from VITE_SITE_URL', () => {
        makeProject()
        vi.stubEnv('VITE_SITE_URL', 'https://preview.example.com')
        prerender({ root, log })
        expect(read('robots.txt')).toContain('Sitemap: https://preview.example.com/sitemap.xml')
    })

    it('works with no posts', () => {
        makeProject({ posts: [] })
        expect(prerender({ root, siteUrl: 'https://cansee.ai', log })).toEqual(['blog/index.html', 'sitemap.xml', 'robots.txt'])
        const doc = parse(read('blog/index.html'))
        expect(doc.querySelector('.blog-empty').textContent).toBe('No posts yet. Check back soon.')
        expect(read('sitemap.xml')).toContain('<url><loc>https://cansee.ai/blog</loc></url>')
    })

    it('works when the content folder does not exist', () => {
        makeProject({ posts: [] })
        rmSync(join(root, 'src', 'content'), { recursive: true })
        expect(prerender({ root, siteUrl: 'https://cansee.ai', log })).toHaveLength(3)
    })

    it('fails with a message naming the file and field, and writes nothing', () => {
        makeProject({ posts: ['posts', 'invalid'] })
        expect(() => prerender({ root, siteUrl: 'https://cansee.ai', log })).toThrow(
            /Blog: \d+ problems in src\/content\/blog:\n {2}- broken-fixture-post\.md: title must be 50-60 characters/
        )
        expect(existsSync(join(root, 'dist', 'blog'))).toBe(false)
        expect(existsSync(join(root, 'dist', 'sitemap.xml'))).toBe(false)
    })

    it('fails clearly before vite build has run', () => {
        makeProject()
        rmSync(join(root, 'dist', 'index.html'))
        expect(() => prerender({ root, siteUrl: 'https://cansee.ai', log })).toThrow(/index\.html not found; run vite build first/)
    })

    it('removes the build manifest from dist', () => {
        makeProject()
        prerender({ root, siteUrl: 'https://cansee.ai', log })
        expect(existsSync(join(root, 'dist', '.vite'))).toBe(false)
    })

    it('still writes the pages without a manifest, and says so', () => {
        makeProject({ manifest: null })
        prerender({ root, siteUrl: 'https://cansee.ai', log })
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/no \.vite\/manifest\.json/))
        expect(parse(read('blog/index.html')).querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1)
    })

    it('prints warnings without failing', () => {
        makeProject()
        rmSync(join(root, 'src', 'content', 'blog', 'beta-fixture-post-two.md'))
        prerender({ root, siteUrl: 'https://cansee.ai', log })
        expect(log.warn).toHaveBeenCalledWith(
            'Blog warning: alpha-fixture-post-one.md: link /blog/beta-fixture-post-two points to a post that does not exist'
        )
    })
})

describe('blogStylesheets', () => {
    it('follows imports, skips the entry and lists each file once', () => {
        expect(blogStylesheets(MANIFEST)).toEqual(['/assets/posts-2.css', '/assets/BlogPostPage-3.css'])
        expect(blogStylesheets({})).toEqual([])
    })
})

describe('fillShell', () => {
    const spec = { title: 'A <b>title</b>', description: 'D "quoted"', meta: [], jsonLd: [] }

    it('escapes the new title and description', () => {
        const html = fillShell(SHELL, { spec, content: '<p>x</p>' })
        expect(html).toContain('<title data-default="Cansee — Brand Intelligence">A &lt;b&gt;title&lt;/b&gt;</title>')
        expect(html).toContain('content="D &quot;quoted&quot;"')
        expect(html).toContain('<div id="app"><p>x</p></div>')
    })

    it('adds a title and description when the shell has none', () => {
        const bare = '<html><head></head><body><div id="app"></div></body></html>'
        const doc = parse(fillShell(bare, { spec, content: '' }))
        expect(doc.title).toBe('A <b>title</b>')
        expect(doc.querySelector('meta[name="description"]').getAttribute('content')).toBe('D "quoted"')
    })

    it('refuses a shell it cannot fill', () => {
        expect(() => fillShell('<html><head></head><body></body></html>', { spec, content: '' })).toThrow(/no empty <div id="app">/)
        expect(() => fillShell('<div id="app"></div>', { spec, content: '' })).toThrow(/no <\/head>/)
    })

    it('treats $ in content literally', () => {
        const html = fillShell(SHELL, { spec: { ...spec, title: "$& $' $1" }, content: '<p>$&</p>' })
        expect(html).toContain('<div id="app"><p>$&</p></div>')
        expect(html).toContain("$&amp; $&#39; $1</title>")
    })
})

describe('sitemapXml and robotsTxt', () => {
    it('escapes URLs and leaves lastmod off pages without a date', () => {
        expect(sitemapXml([], 'https://a.example')).toBe(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
                '  <url><loc>https://a.example/</loc></url>',
                '  <url><loc>https://a.example/pricing</loc></url>',
                '  <url><loc>https://a.example/docs</loc></url>',
                '  <url><loc>https://a.example/blog</loc></url>',
                '</urlset>',
                '',
            ].join('\n')
        )
        expect(robotsTxt('https://a.example')).toBe('User-agent: *\nAllow: /\n\nSitemap: https://a.example/sitemap.xml\n')
    })
})

describe('blogContent Vite plugin', () => {
    function run(dir) {
        const plugin = blogContent({ dir })
        const ctx = { warn: vi.fn(), addWatchFile: vi.fn(), error: vi.fn((m) => { throw new Error(m) }) }
        plugin.buildStart.call(ctx)
        return ctx
    }

    it('only runs for production builds', () => {
        expect(blogContent().apply).toBe('build')
    })

    it('passes valid posts and watches them', () => {
        const ctx = run(join(FIXTURES, 'posts'))
        expect(ctx.error).not.toHaveBeenCalled()
        expect(ctx.addWatchFile).toHaveBeenCalledTimes(3)
    })

    it('fails the build on an invalid post', () => {
        expect(() => run(join(FIXTURES, 'invalid'))).toThrow(/broken-fixture-post\.md: title must be 50-60 characters/)
    })

    it('passes with no posts', () => {
        expect(run(join(FIXTURES, 'does-not-exist')).error).not.toHaveBeenCalled()
    })
})
