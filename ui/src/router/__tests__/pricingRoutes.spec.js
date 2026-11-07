import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => ({
    default: { get: vi.fn(async () => ({ data: null })), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    authHeaders: () => ({}),
    refreshAccessToken: async () => '',
}))
vi.mock('@/api/websites', () => ({ default: { list: vi.fn(async () => ({ data: [] })) } }))

// Every page is a stand-in: these tests check where each address lands.
const stub = (name) => ({ default: { name, render: () => null } })
vi.mock('@/pages/PricingPage.vue', () => stub('PricingPage'))
vi.mock('@/pages/RunLinkPage.vue', () => stub('RunLinkPage'))
vi.mock('@/pages/auth/LoginPage.vue', () => stub('LoginPage'))
vi.mock('@/pages/PaywallPage.vue', () => stub('PaywallPage'))
vi.mock('@/pages/legal/TermsPage.vue', () => stub('TermsPage'))

const { default: router } = await import('@/router')
const { useAuthStore } = await import('@/stores/auth')

// The record holds the lazy import until a navigation resolved it.
async function loaded(record) {
    const component = record.components.default
    const mod = typeof component === 'function' ? await component() : component
    return (mod.default || mod).name
}

function signIn(session = { next_route: 'app', onboarding: { needs_onboarding: false } }) {
    const auth = useAuthStore()
    auth.accessToken = 'token'
    auth.user = { id: 7 }
    auth.session = session
}

beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    useAuthStore().accessToken = null
    // A neutral page to start every test from.
    await router.push('/terms')
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('/pricing', () => {
    it('is the public pricing window', async () => {
        const target = router.resolve('/pricing')
        expect(target.name).toBe('pricing')
        expect(target.meta).toMatchObject({ public: true })
        expect(await loaded(target.matched.at(-1))).toBe('PricingPage')
    })

    it('renders signed out', async () => {
        await router.push('/pricing')
        expect(router.currentRoute.value.name).toBe('pricing')
    })

    it('stays open to an account the paywall holds', async () => {
        signIn({ next_route: 'paywall' })
        await router.push({ name: 'pricing' })
        expect(router.currentRoute.value.name).toBe('pricing')
    })
})

describe('/r/:code', () => {
    it("is the text's link", async () => {
        const target = router.resolve({ name: 'run-link', params: { code: 'k3v9x2qa' } })
        expect(target.path).toBe('/r/k3v9x2qa')
        expect(target.meta).toMatchObject({ requiresAuth: true })
        expect(await loaded(target.matched.at(-1))).toBe('RunLinkPage')
    })

    it('goes through login and back when signed out', async () => {
        await router.push('/r/k3v9x2qa')
        expect(router.currentRoute.value.name).toBe('login')
        expect(router.currentRoute.value.query).toEqual({ redirect: '/r/k3v9x2qa' })
    })

    it('opens for a signed-in account', async () => {
        signIn()
        await router.push('/r/k3v9x2qa')
        expect(router.currentRoute.value.name).toBe('run-link')
        expect(router.currentRoute.value.params).toEqual({ code: 'k3v9x2qa' })
    })
})
