import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'

// The template's public image compiles to an import; node has no /images.
vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))

// The pages read the posts bundled from src/content/blog; use the fixtures.
vi.mock('@/lib/blog/posts', async () => {
    const { fixturePosts } = await import('@/lib/blog/__tests__/__fixtures__/fixturePosts.js')
    const { renderPostHtml } = await import('@/lib/blog/content')
    const posts = fixturePosts()
    return {
        posts,
        siteUrl: 'https://cansee.ai',
        findPost: (slug) => posts.find((p) => p.slug === slug) || null,
        postHtml: (post) => renderPostHtml(post, window),
    }
})

const { default: BlogPostPage } = await import('../BlogPostPage.vue')

const Blank = defineComponent({ render: () => h('div') })

async function renderPost(slug) {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/blog/:slug', component: BlogPostPage, props: true },
            { path: '/:any(.*)*', component: Blank },
        ],
    })
    await router.push(`/blog/${slug}`)
    const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } })
    await flushPromises()
    return { wrapper, router }
}

beforeEach(() => {
    document.head.innerHTML = '<title>Cansee — Brand Intelligence</title><meta name="description" content="Default.">'
})

afterEach(() => {
    document.body.innerHTML = ''
})

describe('BlogPostPage', () => {
    it('renders the article with its meta, tags and table of contents', async () => {
        const { wrapper } = await renderPost('alpha-fixture-post-one')
        expect(wrapper.find('h1').text()).toBe('Fixture post one: how AI answers mention a small brand')
        const meta = wrapper.find('.blog-article-head .blog-meta').text()
        expect(meta).toContain('By Cansee team')
        expect(meta).toContain('Published November 1, 2026')
        expect(meta).toContain('Updated November 3, 2026')
        expect(meta).toContain('6 min read')
        expect(wrapper.findAll('.blog-article-head .blog-tag').map((t) => t.text())).toEqual(['AI search', 'Visibility', 'Testing'])
        expect(wrapper.findAll('.blog-toc a').map((a) => [a.text(), a.attributes('href')])).toEqual([
            ['What the fixture covers', '/blog/alpha-fixture-post-one#what-the-fixture-covers'],
            ['Links', '/blog/alpha-fixture-post-one#links'],
            ['Key takeaways', '/blog/alpha-fixture-post-one#key-takeaways'],
            ['Frequently asked questions', '/blog/alpha-fixture-post-one#blog-faq'],
        ])
        wrapper.unmount()
    })

    it('renders the sanitized body and the FAQ', async () => {
        const { wrapper } = await renderPost('alpha-fixture-post-one')
        const body = wrapper.find('.blog-body')
        expect(body.find('h2#links').exists()).toBe(true)
        expect(body.find('table').exists()).toBe(true)
        expect(body.find('script').exists()).toBe(false)
        expect(wrapper.findAll('.blog-faq h3').map((q) => q.text())).toEqual([
            'What is this fixture for?',
            'Does it contain real data?',
            'Can a question carry "quotes" & <tags>?',
        ])
        wrapper.unmount()
    })

    it('links related posts and the previous and next posts', async () => {
        const { wrapper } = await renderPost('beta-fixture-post-two')
        expect(wrapper.find('.blog-pager-prev').attributes('href')).toBe('/blog/alpha-fixture-post-one')
        expect(wrapper.find('.blog-pager-next').attributes('href')).toBe('/blog/gamma-fixture-post-three')
        expect(wrapper.findAll('.blog-related .blog-card-title a').map((a) => a.attributes('href'))).toEqual([
            '/blog/alpha-fixture-post-one',
        ])
        wrapper.unmount()
    })

    it('sends site links in the article through the router', async () => {
        const { wrapper, router } = await renderPost('alpha-fixture-post-one')
        const push = vi.spyOn(router, 'push')
        await wrapper.find('.blog-body a[href="/pricing"]').trigger('click', { button: 0 })
        expect(push).toHaveBeenCalledWith('/pricing')
        push.mockClear()
        await wrapper.find('.blog-body a[href="https://example.com/guide"]').trigger('click', { button: 0 })
        expect(push).not.toHaveBeenCalled()
        wrapper.unmount()
    })

    it('sets the head for the post and restores it on leaving', async () => {
        const { wrapper } = await renderPost('alpha-fixture-post-one')
        expect(document.title).toBe('Fixture post one: how AI answers mention a small brand')
        expect(document.head.querySelector('link[rel="canonical"]').getAttribute('href')).toBe(
            'https://cansee.ai/blog/alpha-fixture-post-one'
        )
        const types = [...document.head.querySelectorAll('script[type="application/ld+json"]')].map(
            (s) => JSON.parse(s.textContent)['@type']
        )
        expect(types).toEqual(['BlogPosting', 'BreadcrumbList', 'FAQPage'])
        wrapper.unmount()
        expect(document.title).toBe('Cansee — Brand Intelligence')
        expect(document.head.querySelector('link[rel="canonical"]')).toBeNull()
    })

    it('says so for an unknown post and keeps it out of the index', async () => {
        const { wrapper } = await renderPost('no-such-post-here')
        expect(wrapper.find('h1').text()).toBe('Post not found')
        expect(wrapper.find('a.blog-back').attributes('href')).toBe('/blog')
        expect(document.head.querySelector('meta[name="robots"]').getAttribute('content')).toBe('noindex')
        expect(document.head.querySelector('link[rel="canonical"]')).toBeNull()
        wrapper.unmount()
    })
})
