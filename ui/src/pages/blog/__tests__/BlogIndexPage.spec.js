import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))

const state = vi.hoisted(() => ({ posts: [] }))
vi.mock('@/lib/blog/posts', () => ({
    get posts() {
        return state.posts
    },
    siteUrl: 'https://cansee.ai',
}))

const { fixturePosts } = await import('@/lib/blog/__tests__/__fixtures__/fixturePosts.js')
const { default: BlogIndexPage } = await import('../BlogIndexPage.vue')

const Blank = defineComponent({ render: () => h('div') })

async function render() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: Blank }] })
    await router.push('/blog')
    return mount(BlogIndexPage, { global: { plugins: [router] } })
}

afterEach(() => {
    state.posts = []
})

describe('BlogIndexPage', () => {
    it('lists the posts newest first with date, reading time and tags', async () => {
        state.posts = fixturePosts()
        const wrapper = await render()
        expect(wrapper.find('h1').text()).toBe('AI search visibility, explained')
        const cards = wrapper.findAll('.blog-card')
        expect(cards.map((c) => c.find('.blog-card-title a').attributes('href'))).toEqual([
            '/blog/gamma-fixture-post-three',
            '/blog/beta-fixture-post-two',
            '/blog/alpha-fixture-post-one',
        ])
        expect(cards[0].find('.blog-card-title').element.tagName).toBe('H2')
        expect(cards[0].find('.blog-card-desc').text()).toMatch(/^A fixture description for the third test post\./)
        expect(cards[0].find('time').attributes('datetime')).toBe('2026-11-08')
        expect(cards[0].find('.blog-meta').text()).toBe('November 8, 2026·5 min read')
        expect(cards[0].findAll('.blog-tag').map((t) => t.text())).toEqual(['Competitors', 'Research', 'Analytics'])
        expect(wrapper.find('.blog-empty').exists()).toBe(false)
        wrapper.unmount()
    })

    it('says there are no posts yet when there are none', async () => {
        const wrapper = await render()
        expect(wrapper.find('.blog-cards').exists()).toBe(false)
        expect(wrapper.find('.blog-empty').text()).toBe('No posts yet. Check back soon.')
        wrapper.unmount()
    })

    it('has the shared header and footer with Blog, Docs and Pricing', async () => {
        const wrapper = await render()
        expect(wrapper.findAll('.blog-nav a').map((a) => [a.text(), a.attributes('href')])).toEqual([
            ['Blog', '/blog'],
            ['Docs', '/docs'],
            ['Pricing', '/pricing'],
            ['Sign in', '/login'],
        ])
        expect(wrapper.findAll('.blog-foot-links a').map((a) => a.attributes('href'))).toEqual([
            '/blog',
            '/pricing',
            '/docs',
            '/privacy',
            '/terms',
            '/support',
        ])
        expect(wrapper.find('a.blog-skip').attributes('href')).toBe('#main')
        expect(wrapper.find('main#main').exists()).toBe(true)
        wrapper.unmount()
    })

    it('sets the index head tags', async () => {
        state.posts = fixturePosts()
        const wrapper = await render()
        expect(document.title).toBe('Blog: AI search visibility guides from Cansee')
        expect(document.head.querySelector('link[rel="canonical"]').getAttribute('href')).toBe('https://cansee.ai/blog')
        const ld = [...document.head.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent))
        expect(ld.map((x) => x['@type'])).toEqual(['Blog', 'BreadcrumbList'])
        expect(ld[0].blogPost).toHaveLength(3)
        wrapper.unmount()
        expect(document.head.querySelector('link[rel="canonical"]')).toBeNull()
    })
})
