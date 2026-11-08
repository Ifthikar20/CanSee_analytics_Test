import { describe, expect, it } from 'vitest'
import {
    BLOG_DESCRIPTION,
    BLOG_TITLE,
    blogIndexHead,
    blogLd,
    blogPostHead,
    blogPostingLd,
    breadcrumbLd,
    faqPageLd,
    missingPostHead,
    siteUrlFrom,
} from '../seo.js'

const SITE = 'https://cansee.ai'
const post = {
    slug: 'ai-search-visibility-explained',
    title: 'What AI search visibility is and why it matters for brands',
    description: 'A description.',
    date: '2026-11-08',
    updated: '2026-11-09',
    author: 'Cansee team',
    tags: ['AI search', 'Visibility', 'GEO'],
    keywords: ['ai search visibility', 'ai visibility', 'geo', 'brand mentions'],
    readingMinutes: 7,
    wordCount: 1400,
    faq: [
        { q: 'What is it?', a: 'An answer.' },
        { q: 'Why care?', a: 'Another answer.' },
    ],
}

describe('siteUrlFrom', () => {
    it.each([
        [undefined, 'https://cansee.ai'],
        ['', 'https://cansee.ai'],
        ['https://staging.cansee.ai/', 'https://staging.cansee.ai'],
        ['http://localhost:5173', 'http://localhost:5173'],
        ['https://example.com/sub/', 'https://example.com/sub'],
        ['javascript:alert(1)', 'https://cansee.ai'],
        ['not a url', 'https://cansee.ai'],
    ])('%j -> %j', (value, expected) => {
        expect(siteUrlFrom(value)).toBe(expected)
    })
})

describe('JSON-LD', () => {
    it('describes a post as a BlogPosting', () => {
        expect(blogPostingLd(post, SITE)).toEqual({
            '@context': 'https://schema.org',
            '@type': 'BlogPosting',
            headline: post.title,
            description: post.description,
            datePublished: '2026-11-08',
            dateModified: '2026-11-09',
            author: { '@type': 'Organization', name: 'Cansee team', url: 'https://cansee.ai/' },
            publisher: {
                '@type': 'Organization',
                name: 'Cansee',
                url: 'https://cansee.ai/',
                logo: { '@type': 'ImageObject', url: 'https://cansee.ai/images/cansee-mark.png' },
            },
            mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://cansee.ai/blog/ai-search-visibility-explained' },
            url: 'https://cansee.ai/blog/ai-search-visibility-explained',
            image: 'https://cansee.ai/images/cansee-mark.png',
            inLanguage: 'en',
            keywords: 'ai search visibility, ai visibility, geo, brand mentions',
            articleSection: 'AI search',
            wordCount: 1400,
        })
    })

    it('numbers breadcrumb items from 1', () => {
        expect(breadcrumbLd([{ name: 'Home', url: 'https://cansee.ai/' }, { name: 'Blog', url: 'https://cansee.ai/blog' }])).toEqual({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://cansee.ai/' },
                { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://cansee.ai/blog' },
            ],
        })
    })

    it('turns the faq field into an FAQPage', () => {
        expect(faqPageLd(post.faq)).toEqual({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: [
                { '@type': 'Question', name: 'What is it?', acceptedAnswer: { '@type': 'Answer', text: 'An answer.' } },
                { '@type': 'Question', name: 'Why care?', acceptedAnswer: { '@type': 'Answer', text: 'Another answer.' } },
            ],
        })
        expect(faqPageLd([])).toBeNull()
        expect(faqPageLd(undefined)).toBeNull()
    })

    it('lists every post on the Blog', () => {
        const ld = blogLd([post], SITE)
        expect(ld['@type']).toBe('Blog')
        expect(ld.url).toBe('https://cansee.ai/blog')
        expect(ld.blogPost).toEqual([
            {
                '@type': 'BlogPosting',
                headline: post.title,
                description: post.description,
                url: 'https://cansee.ai/blog/ai-search-visibility-explained',
                datePublished: '2026-11-08',
                dateModified: '2026-11-09',
            },
        ])
    })
})

describe('head specs', () => {
    const content = (spec, key) => spec.meta.filter((m) => (m.property || m.name) === key).map((m) => m.content)

    it('gives a post its canonical URL, Open Graph, Twitter and three JSON-LD blocks', () => {
        const head = blogPostHead(post, SITE)
        expect(head.title).toBe(post.title)
        expect(head.description).toBe(post.description)
        expect(head.canonical).toBe('https://cansee.ai/blog/ai-search-visibility-explained')
        expect(content(head, 'og:type')).toEqual(['article'])
        expect(content(head, 'og:url')).toEqual([head.canonical])
        expect(content(head, 'og:title')).toEqual([post.title])
        expect(content(head, 'og:description')).toEqual([post.description])
        expect(content(head, 'twitter:card')).toEqual(['summary'])
        expect(content(head, 'twitter:title')).toEqual([post.title])
        expect(content(head, 'article:published_time')).toEqual(['2026-11-08'])
        expect(content(head, 'article:modified_time')).toEqual(['2026-11-09'])
        expect(content(head, 'article:tag')).toEqual(post.tags)
        expect(head.jsonLd.map((x) => x['@type'])).toEqual(['BlogPosting', 'BreadcrumbList', 'FAQPage'])
        expect(head.jsonLd[1].itemListElement.map((i) => i.item)).toEqual([
            'https://cansee.ai/',
            'https://cansee.ai/blog',
            'https://cansee.ai/blog/ai-search-visibility-explained',
        ])
    })

    it('leaves out FAQPage for a post without questions', () => {
        expect(blogPostHead({ ...post, faq: [] }, SITE).jsonLd.map((x) => x['@type'])).toEqual(['BlogPosting', 'BreadcrumbList'])
    })

    it('follows the configured origin', () => {
        const head = blogPostHead(post, 'https://staging.example.com')
        expect(head.canonical).toBe('https://staging.example.com/blog/ai-search-visibility-explained')
    })

    it('describes the index as a website with Blog and BreadcrumbList', () => {
        const head = blogIndexHead([post], SITE)
        expect(head.title).toBe(BLOG_TITLE)
        expect(head.description).toBe(BLOG_DESCRIPTION)
        expect(head.canonical).toBe('https://cansee.ai/blog')
        expect(content(head, 'og:type')).toEqual(['website'])
        expect(head.jsonLd.map((x) => x['@type'])).toEqual(['Blog', 'BreadcrumbList'])
    })

    it('keeps the blog description within the length a search result shows', () => {
        expect(BLOG_DESCRIPTION.length).toBeGreaterThanOrEqual(140)
        expect(BLOG_DESCRIPTION.length).toBeLessThanOrEqual(160)
    })

    it('keeps a missing post out of the index', () => {
        const head = missingPostHead()
        expect(head.canonical).toBeUndefined()
        expect(head.meta).toEqual([{ name: 'robots', content: 'noindex' }])
    })
})
