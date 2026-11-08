import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FrontmatterError, parseFrontmatter, parseYamlSubset } from '../frontmatter.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(HERE, '__fixtures__', 'posts', name), 'utf8')

describe('parseYamlSubset', () => {
    it('reads quoted, plain and numeric scalars', () => {
        const data = parseYamlSubset(
            [
                'title: "A \\"quoted\\" title: with a colon"',
                "single: 'it''s fine'",
                'plain: just text # a comment',
                'readingMinutes: 7',
                'negative: -3',
                'flag: true',
            ].join('\n')
        )
        expect(data).toEqual({
            title: 'A "quoted" title: with a colon',
            single: "it's fine",
            plain: 'just text',
            readingMinutes: 7,
            negative: -3,
            flag: true,
        })
    })

    it('keeps a # inside a quoted string', () => {
        expect(parseYamlSubset('title: "Step #1 # not a comment"')).toEqual({ title: 'Step #1 # not a comment' })
    })

    it('reads flow lists, with quoted items that contain commas', () => {
        const data = parseYamlSubset('tags: [AI search, "GEO, explained", \'small business\', 3]')
        expect(data.tags).toEqual(['AI search', 'GEO, explained', 'small business', 3])
    })

    it('reads an empty flow list', () => {
        expect(parseYamlSubset('tags: []').tags).toEqual([])
    })

    it('reads a block list of mappings (the faq field)', () => {
        const data = parseYamlSubset(
            [
                'faq:',
                '  - q: "First?"',
                '    a: "One."',
                '',
                '  # a comment between items',
                '  - q: "Second?"',
                '    a: "Two, with: a colon."',
                'after: "x"',
            ].join('\n')
        )
        expect(data).toEqual({
            faq: [
                { q: 'First?', a: 'One.' },
                { q: 'Second?', a: 'Two, with: a colon.' },
            ],
            after: 'x',
        })
    })

    it('reads a block list of scalars', () => {
        expect(parseYamlSubset('tags:\n  - one\n  - "two"').tags).toEqual(['one', 'two'])
    })

    it('decodes the supported escapes', () => {
        expect(parseYamlSubset('a: "line\\nnext\\ttab \\\\ slash"').a).toBe('line\nnext\ttab \\ slash')
    })

    it.each([
        ['title "no colon"', /line 1: expected "key: value"/],
        ['title: "open', /line 1: unterminated double-quoted string/],
        ['title: "done" trailing', /line 1: unexpected text after the closing quote/],
        ['a: 1\na: 2', /line 2: duplicate key a/],
        ['  indented: 1', /line 1: unexpected indentation/],
        ['tags: [a, b', /line 1: a list must end with \]/],
        ['tags: [a, [b]]', /nested lists are not supported/],
        ['meta: {a: 1}', /inline mappings are not supported/],
        ['faq:', /line 1: no value for faq/],
        ['faq:\n  q: "not a list item"', /line 2: expected a list item/],
        ['faq:\n  - q: "x"\n     a: "misaligned"', /line 3: fields of a list item must line up/],
        ['faq:\n  - q: "x"\n    q: "again"', /line 3: duplicate key q/],
        ['a: "bad \\x escape"', /unsupported escape/],
    ])('rejects %j', (text, message) => {
        expect(() => parseYamlSubset(text)).toThrow(FrontmatterError)
        expect(() => parseYamlSubset(text)).toThrow(message)
    })

    it('numbers lines from the given start, so errors point into the file', () => {
        expect(() => parseYamlSubset('ok: 1\nbroken', 2)).toThrow(/line 3:/)
    })
})

describe('parseFrontmatter', () => {
    it('splits a fixture post into data and body', () => {
        const { data, body } = parseFrontmatter(fixture('alpha-fixture-post-one.md'))
        expect(data.slug).toBe('alpha-fixture-post-one')
        expect(data.readingMinutes).toBe(6)
        expect(data.tags).toEqual(['AI search', 'Visibility', 'Testing'])
        expect(data.faq).toHaveLength(3)
        expect(data.faq[2].q).toBe('Can a question carry "quotes" & <tags>?')
        expect(body.startsWith('AI answers mention some brands')).toBe(true)
        expect(body).toContain('## What the fixture covers')
    })

    it('handles Windows line endings and a byte order mark', () => {
        const raw = '﻿---\r\ntitle: "T"\r\n---\r\nBody\r\n'
        const { data, body } = parseFrontmatter(raw)
        expect(data).toEqual({ title: 'T' })
        expect(body.trim()).toBe('Body')
    })

    it('requires the opening and closing --- lines', () => {
        expect(() => parseFrontmatter('title: "x"\n---\nbody')).toThrow(/must start with a --- line/)
        expect(() => parseFrontmatter('---\ntitle: "x"\nbody')).toThrow(/no closing --- line/)
    })

    it('reports errors with the line number in the file', () => {
        expect(() => parseFrontmatter('---\ntitle: "x"\noops\n---\n')).toThrow(/line 3:/)
    })
})
