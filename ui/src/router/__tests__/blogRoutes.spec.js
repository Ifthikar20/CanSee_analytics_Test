import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => ({
    default: { get: vi.fn(async () => ({ data: null })), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    authHeaders: () => ({}),
    refreshAccessToken: async () => '',
}))
vi.mock('@/api/websites', () => ({ default: { list: vi.fn(async () => ({ data: [] })) } }))

// Every page is a stand-in: these tests check where each address lands.
const stub = (name) => ({ default: { name, props: ['slug'], render: () => null } })
vi.mock('@/pages/blog/BlogIndexPage.vue', () => stub('BlogIndexPage'))
vi.mock('@/pages/blog/BlogPostPage.vue', () => stub('BlogPostPage'))
vi.mock('@/pages/legal/TermsPage.vue', () => stub('TermsPage'))

const { default: router } = await import('@/router')
const { useAuthStore } = await import('@/stores/auth')

async function loaded(record) {
    const component = record.components.default
    const mod = typeof component === 'function' ? await component() : component
    return (mod.default || mod).name
}

beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    useAuthStore().accessToken = null
    await router.push('/terms')
})

describe('/blog', () => {
    it('is the public blog index', async () => {
        const target = router.resolve('/blog')
        expect(target.name).toBe('blog')
        expect(target.meta).toMatchObject({ public: true })
        expect(await loaded(target.matched.at(-1))).toBe('BlogIndexPage')
        await router.push('/blog')
        expect(router.currentRoute.value.name).toBe('blog')
    })

    it('matches with a trailing slash, as the prerendered folder is served', () => {
        expect(router.resolve('/blog/').name).toBe('blog')
    })
})

describe('/blog/:slug', () => {
    it('is a public post page that gets the slug as a prop', async () => {
        const target = router.resolve('/blog/ai-search-visibility-explained')
        expect(target.name).toBe('blog-post')
        expect(target.params).toEqual({ slug: 'ai-search-visibility-explained' })
        expect(target.meta).toMatchObject({ public: true })
        expect(target.matched.at(-1).props.default).toBe(true)
        expect(await loaded(target.matched.at(-1))).toBe('BlogPostPage')
    })

    it('renders signed out, without the login bounce', async () => {
        await router.push('/blog/ai-search-visibility-explained')
        expect(router.currentRoute.value.name).toBe('blog-post')
    })

    it('stays on the post for a signed-in user still in onboarding', async () => {
        const auth = useAuthStore()
        auth.accessToken = 'token'
        auth.user = { id: 7 }
        auth.session = { next_route: 'onboarding' }
        await router.push('/blog/ai-search-visibility-explained')
        expect(router.currentRoute.value.name).toBe('blog-post')
    })
})
