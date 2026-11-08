import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter } from '../frontmatter.js'
import { renderMarkdown } from '../markdown.js'
import { RULES, isIsoDate, validatePost } from '../validate.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (dir, name) => readFileSync(join(HERE, '__fixtures__', dir, name), 'utf8')

function check(dir, name, options = {}) {
    const { data, body } = parseFrontmatter(read(dir, name))
    return validatePost(data, renderMarkdown(body), { fileSlug: name.replace(/\.md$/, ''), ...options })
}

const valid = () => parseFrontmatter(read('posts', 'beta-fixture-post-two.md')).data

describe('validatePost', () => {
    it('accepts the fixture posts', () => {
        for (const name of ['alpha-fixture-post-one.md', 'beta-fixture-post-two.md', 'gamma-fixture-post-three.md']) {
            expect(check('posts', name).errors).toEqual([])
        }
    })

    it('names every problem in the broken fixture', () => {
        const { errors } = check('invalid', 'broken-fixture-post.md')
        expect(errors).toEqual(
            expect.arrayContaining([
                'title must be 50-60 characters (it is 9)',
                'description must be 140-155 characters (it is 15)',
                'slug "not-the-file-name" must match the file name "broken-fixture-post.md"',
                'date must be a date written "YYYY-MM-DD"',
                'tags must have 3-5 items (it has 1)',
                'readingMinutes must be a whole number above 0',
                'faq must have 3-5 items (it has 1)',
                'the body must not contain an H1 (# heading); the title is the H1',
            ])
        )
    })

    it('requires every field', () => {
        const { errors } = validatePost({}, null)
        for (const field of ['title', 'description', 'slug', 'date', 'updated', 'author', 'tags', 'keywords', 'readingMinutes', 'faq']) {
            expect(errors).toContain(`${field} is required`)
        }
    })

    it('enforces the title and description length bounds exactly', () => {
        const at = (n) => 'x'.repeat(n)
        const base = valid()
        expect(validatePost({ ...base, title: at(RULES.title.min) }, null).errors).toEqual([])
        expect(validatePost({ ...base, title: at(RULES.title.max) }, null).errors).toEqual([])
        expect(validatePost({ ...base, title: at(RULES.title.max + 1) }, null).errors).toEqual([
            'title must be 50-60 characters (it is 61)',
        ])
        expect(validatePost({ ...base, description: at(RULES.description.min - 1) }, null).errors).toEqual([
            'description must be 140-155 characters (it is 139)',
        ])
    })

    it('checks the slug shape and word count', () => {
        const base = valid()
        expect(validatePost({ ...base, slug: 'Bad_Slug' }, null).errors).toContain(
            'slug must be lowercase words joined by hyphens'
        )
        expect(validatePost({ ...base, slug: 'two-words' }, null).errors).toContain('slug must have 3-7 words (it has 2)')
        expect(validatePost({ ...base, slug: 'a-b-c-d-e-f-g-h' }, null).errors).toContain('slug must have 3-7 words (it has 8)')
    })

    it('rejects an update dated before publication', () => {
        expect(validatePost({ ...valid(), updated: '2026-11-01' }, null).errors).toContain(
            'updated must not be earlier than date'
        )
    })

    it('checks list sizes, items and duplicates', () => {
        const base = valid()
        expect(validatePost({ ...base, keywords: 'one, two' }, null).errors).toContain('keywords must be a list like [a, b, c]')
        expect(validatePost({ ...base, tags: ['a', 'b', 'A'] }, null).errors).toContain('tags has duplicate items')
        expect(validatePost({ ...base, tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, null).errors).toContain(
            'tags must have 3-5 items (it has 6)'
        )
    })

    it('checks faq items', () => {
        const base = valid()
        const faq = [{ q: 'One?', a: 'Yes.' }, { q: 'Two?' }, { q: 'Three?', a: 'Yes.', extra: 'x' }]
        const { errors } = validatePost({ ...base, faq }, null)
        expect(errors).toContain('faq item 2 needs a question (q) and an answer (a)')
        expect(errors).toContain('faq item 3 may only have q and a')
    })

    it('warns, without failing, about body length, H2 count, unknown fields and broken post links', () => {
        const { errors, warnings } = check('posts', 'alpha-fixture-post-one.md', { knownSlugs: new Set(['alpha-fixture-post-one']) })
        expect(errors).toEqual([])
        expect(warnings).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^the body has 3 H2 sections; aim for 6-10$/),
                expect.stringMatching(/^the body has about \d+ words; aim for 1200-1800$/),
                'link /blog/beta-fixture-post-two points to a post that does not exist',
            ])
        )
        const extra = validatePost({ ...valid(), draft: true }, null)
        expect(extra.warnings).toEqual(['unknown frontmatter field "draft" is ignored'])
    })
})

describe('isIsoDate', () => {
    it.each([
        ['2026-11-08', true],
        ['2024-02-29', true],
        ['2026-02-29', false],
        ['2026-13-01', false],
        ['2026-1-8', false],
        ['November 8, 2026', false],
        [20261108, false],
    ])('%j -> %s', (value, expected) => {
        expect(isIsoDate(value)).toBe(expected)
    })
})
