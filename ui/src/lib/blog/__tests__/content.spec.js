import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    adjacentPosts,
    compareNewestFirst,
    formatDate,
    formatProblems,
    loadPosts,
    relatedPosts,
    renderPostHtml,
    slugFromPath,
} from '../content.js'

const dir = (name) => join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', name)
const files = (name) =>
    readdirSync(dir(name)).map((f) => ({ path: join(dir(name), f), raw: readFileSync(join(dir(name), f), 'utf8') }))

describe('loadPosts', () => {
    it('loads the fixtures newest first', () => {
        const { posts, errors } = loadPosts(files('posts'))
        expect(errors).toEqual([])
        expect(posts.map((p) => p.slug)).toEqual([
            'gamma-fixture-post-three',
            'beta-fixture-post-two',
            'alpha-fixture-post-one',
        ])
        const alpha = posts[2]
        expect(alpha).toMatchObject({
            title: 'Fixture post one: how AI answers mention a small brand',
            date: '2026-11-01',
            updated: '2026-11-03',
            author: 'Cansee team',
            readingMinutes: 6,
            toc: [
                { id: 'what-the-fixture-covers', text: 'What the fixture covers' },
                { id: 'links', text: 'Links' },
                { id: 'key-takeaways', text: 'Key takeaways' },
            ],
        })
        expect(alpha.faq).toHaveLength(3)
        expect(alpha.wordCount).toBeGreaterThan(20)
    })

    it('loads nothing from no files', () => {
        expect(loadPosts([])).toEqual({ posts: [], errors: [], warnings: [] })
    })

    it('leaves out invalid posts and names the file in each problem', () => {
        const { posts, errors } = loadPosts([...files('posts'), ...files('invalid')])
        expect(posts).toHaveLength(3)
        expect(errors.length).toBeGreaterThan(3)
        expect(errors.every((e) => e.startsWith('broken-fixture-post.md: '))).toBe(true)
    })

    it('reports a file whose frontmatter does not parse', () => {
        const { posts, errors } = loadPosts([{ path: 'x/broken-yaml-post.md', raw: '---\ntitle "x"\n---\n' }])
        expect(posts).toEqual([])
        expect(errors).toEqual(['broken-yaml-post.md: line 2: expected "key: value", found: title "x"'])
    })

    it('warns about links to posts that do not exist, without dropping the post', () => {
        const only = files('posts').filter((f) => f.path.includes('alpha'))
        const { posts, warnings } = loadPosts(only)
        expect(posts).toHaveLength(1)
        expect(warnings).toContain(
            'alpha-fixture-post-one.md: link /blog/beta-fixture-post-two points to a post that does not exist'
        )
    })

    it('orders posts of the same date by slug, so builds are stable', () => {
        const list = [
            { slug: 'c-post', date: '2026-11-01' },
            { slug: 'a-post', date: '2026-11-01' },
            { slug: 'b-post', date: '2026-11-02' },
        ]
        expect(list.sort(compareNewestFirst).map((p) => p.slug)).toEqual(['b-post', 'a-post', 'c-post'])
    })
})

describe('renderPostHtml', () => {
    it('renders the sanitized article', () => {
        const alpha = loadPosts(files('posts')).posts.find((p) => p.slug === 'alpha-fixture-post-one')
        const html = renderPostHtml(alpha, window)
        expect(html).toContain('<h2 id="what-the-fixture-covers">')
        expect(html).toContain('<a href="/blog/beta-fixture-post-two">link to post two</a>')
        expect(html).toContain('<div class="blog-table"><table>')
        expect(html).toContain('&lt;script&gt;')
        expect(html).not.toMatch(/<script|href="javascript:|href="\/\/evil/)
    })
})

describe('relatedPosts and adjacentPosts', () => {
    const { posts } = loadPosts(files('posts'))
    const [gamma, beta, alpha] = posts

    it('relates posts by shared tags, ignoring case', () => {
        expect(relatedPosts(alpha, posts).map((p) => p.slug)).toEqual(['beta-fixture-post-two'])
        expect(relatedPosts(gamma, posts)).toEqual([])
    })

    it('ranks by shared tags, then newest, and caps the list', () => {
        const base = { tags: ['a', 'b'], date: '2026-01-01' }
        const list = [
            { ...base, slug: 'self' },
            { slug: 'one-tag-new', tags: ['a'], date: '2026-05-01' },
            { slug: 'two-tags', tags: ['A', 'b'], date: '2026-01-01' },
            { slug: 'one-tag-old', tags: ['b'], date: '2026-02-01' },
            { slug: 'none', tags: ['z'], date: '2026-06-01' },
        ]
        expect(relatedPosts(list[0], list, 2).map((p) => p.slug)).toEqual(['two-tags', 'one-tag-new'])
    })

    it('finds the older (previous) and newer (next) post', () => {
        expect(adjacentPosts(beta, posts)).toEqual({ previous: alpha, next: gamma })
        expect(adjacentPosts(gamma, posts)).toEqual({ previous: beta, next: null })
        expect(adjacentPosts(alpha, posts)).toEqual({ previous: null, next: beta })
        expect(adjacentPosts({ slug: 'missing' }, posts)).toEqual({ previous: null, next: null })
    })
})

describe('helpers', () => {
    it('formats dates the same in every time zone', () => {
        expect(formatDate('2026-11-08')).toBe('November 8, 2026')
        expect(formatDate('2026-01-01')).toBe('January 1, 2026')
        expect(formatDate('soon')).toBe('soon')
    })

    it('takes the slug from a path', () => {
        expect(slugFromPath('../../content/blog/my-post.md')).toBe('my-post')
        expect(slugFromPath('C:\\x\\other-post.MD')).toBe('other-post')
    })

    it('lists every problem in one message', () => {
        const text = formatProblems(['a.md: title is required', 'b.md: slug is required'])
        expect(text).toBe(
            [
                'Blog: 2 problems in src/content/blog:',
                '  - a.md: title is required',
                '  - b.md: slug is required',
                'Fix the post frontmatter (see src/lib/blog/validate.js for the rules) and build again.',
            ].join('\n')
        )
    })
})
