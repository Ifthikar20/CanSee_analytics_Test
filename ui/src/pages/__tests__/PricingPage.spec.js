import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { plansPayload } from '@/components/billing/__tests__/__fixtures__/plans'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const billing = vi.hoisted(() => ({ getPlans: vi.fn() }))

vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))
vi.mock('@/api/billing', () => ({ default: billing }))
// The template's public image compiles to an import; node has no /images.
vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))

const { default: PricingPage } = await import('../PricingPage.vue')
const { useAuthStore } = await import('@/stores/auth')

const Blank = defineComponent({ render: () => h('div') })

async function render({ signedIn = false, subscription = null, plans = 'ok' } = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore()
    auth.accessToken = signedIn ? 'token' : null
    auth.session = signedIn ? { subscription } : null
    if (plans === 'fail') billing.getPlans.mockRejectedValue(new Error('network'))
    else if (plans === 'pending') billing.getPlans.mockReturnValue(new Promise(() => {}))
    else billing.getPlans.mockResolvedValue({ data: plansPayload() })
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/', name: 'landing', component: Blank },
            { path: '/pricing', name: 'pricing', component: Blank },
            { path: '/login', name: 'login', component: Blank },
            { path: '/billing', name: 'billing', component: Blank },
            { path: '/terms', component: Blank },
            { path: '/privacy', component: Blank },
            { path: '/support', component: Blank },
        ],
    })
    await router.push('/pricing')
    await router.isReady()
    const wrapper = mount(PricingPage, { global: { plugins: [pinia, router] } })
    await flushPromises()
    return { wrapper, router }
}

const cardButtons = (wrapper) => wrapper.findAll('button.pc-btn')

beforeEach(() => {
    billing.getPlans.mockReset()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('PricingPage', () => {
    it('shows the two plans signed out', async () => {
        const { wrapper } = await render()
        expect(wrapper.find('h1').text()).toBe('Pricing')
        expect(wrapper.find('.pp-sub').text()).toBe(
            'Track the questions your buyers ask AI. Cansee checks them every day and texts you what changed.',
        )
        expect(wrapper.findAll('article.pc-card').map((c) => c.find('h3').text())).toEqual(['100 prompts', '200 prompts'])
        expect(cardButtons(wrapper).map((b) => b.text())).toEqual(['Get started', 'Get started'])
        expect(wrapper.find('.pp-signin').text()).toBe('Sign in')
        expect(document.title).toBe('Pricing — Cansee')
    })

    it('sends a signed-out choice through login to Billing', async () => {
        const { wrapper, router } = await render()
        await cardButtons(wrapper)[1].trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.name).toBe('login')
        expect(router.currentRoute.value.query).toEqual({ redirect: '/billing?plan=prompts_200' })
    })

    it('sends a signed-in choice straight to Billing', async () => {
        const { wrapper, router } = await render({ signedIn: true, subscription: { status: 'none', plan: 'free' } })
        expect(cardButtons(wrapper).map((b) => b.text())).toEqual(['Choose 100 prompts', 'Choose 200 prompts'])
        expect(wrapper.find('.pp-signin').exists()).toBe(false)
        await cardButtons(wrapper)[0].trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.fullPath).toBe('/billing?plan=prompts_100')
    })

    it('marks the plan a signed-in account is on', async () => {
        const { wrapper } = await render({ signedIn: true, subscription: { status: 'active', plan: 'prompts_100', tier: 'prompts_100' } })
        expect(cardButtons(wrapper).map((b) => b.text())).toEqual(['Current plan', 'Move to 200 prompts'])
    })

    it('says while the plans load, and offers a retry when they fail', async () => {
        const loading = await render({ plans: 'pending' })
        expect(loading.wrapper.find('.pp-note').text()).toBe('Loading plans...')

        const { wrapper } = await render({ plans: 'fail' })
        expect(wrapper.find('.pp-note').text()).toBe("We couldn't load the plans.")
        billing.getPlans.mockResolvedValue({ data: plansPayload() })
        await wrapper.find('.pp-retry').trigger('click')
        await flushPromises()
        expect(wrapper.findAll('article.pc-card')).toHaveLength(2)
    })
})
