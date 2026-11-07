import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { plansPayload } from '@/components/billing/__tests__/__fixtures__/plans'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const billing = vi.hoisted(() => ({ getCurrent: vi.fn(), getPlans: vi.fn(), checkout: vi.fn(), dismissPaywall: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))
vi.mock('@/api/billing', () => ({ default: billing }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
// The template's public image compiles to an import; node has no /images.
vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))

const { default: PaywallPage } = await import('../PaywallPage.vue')
const { useAuthStore } = await import('@/stores/auth')

const Blank = defineComponent({ render: () => h('div') })

async function render({ billingReady = true } = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore()
    auth.accessToken = 'token'
    auth.user = { email: 'fresh-check@cansee.test' }
    auth.session = { subscription: { is_paying: false } }
    vi.spyOn(auth, 'fetchSession').mockResolvedValue(null)
    billing.getPlans.mockResolvedValue({ data: plansPayload() })
    billing.getCurrent.mockResolvedValue({ data: { billing_ready: billingReady } })
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/paywall', name: 'paywall', component: Blank },
            { path: '/dashboard', name: 'dashboard', component: Blank },
        ],
    })
    await router.push('/paywall')
    await router.isReady()
    const wrapper = mount(PaywallPage, {
        global: { plugins: [pinia, router], stubs: { WatercolorBackdrop: true } },
    })
    await flushPromises()
    return { wrapper, router }
}

const cardButtons = (wrapper) => wrapper.findAll('button.pc-btn')

beforeEach(() => {
    Object.values(billing).forEach((fn) => fn.mockReset())
    Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('PaywallPage', () => {
    it('offers the two plans in place of the cycle rows and the trial', async () => {
        const { wrapper } = await render()
        expect(wrapper.findAll('article.pc-card').map((c) => c.find('h3').text())).toEqual(['100 prompts', '200 prompts'])
        expect(cardButtons(wrapper).map((b) => b.text())).toEqual(['Choose 100 prompts', 'Choose 200 prompts'])
        expect(wrapper.find('.pw-eyebrow').text()).toBe('Upgrade')
        expect(wrapper.text()).not.toMatch(/Annual|free trial|\$0 due today|billed annually/)
        expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
        // The contact line is the cards' footnote now.
        expect(wrapper.text()).toContain('Need more? Email sales@cansee.ai.')
        expect(wrapper.text()).not.toContain('Talk to us about')
        expect(wrapper.find('.pw-free-link').text()).toBe('Continue with the free plan for now')
    })

    it('starts the checkout of the plan chosen and says so inline when it fails', async () => {
        const { wrapper } = await render()
        billing.checkout.mockRejectedValue({
            response: { status: 503, data: { error: { code: 'billing_not_configured', message: "Checkout isn't set up yet." } } },
            displayMessage: "Checkout isn't set up yet.",
        })
        await cardButtons(wrapper)[1].trigger('click')
        await flushPromises()
        expect(billing.checkout).toHaveBeenCalledWith({ plan: 'prompts_200' })
        expect(wrapper.find('.pw-error').text()).toBe("Checkout isn't set up yet.")
    })

    it('takes an account that already pays to its dashboard', async () => {
        const { wrapper, router } = await render()
        billing.checkout.mockRejectedValue({ response: { status: 400, data: { error: { code: 'already_subscribed' } } } })
        await cardButtons(wrapper)[0].trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.name).toBe('dashboard')
    })

    it('holds the cards until checkout is set up', async () => {
        const { wrapper } = await render({ billingReady: false })
        expect(cardButtons(wrapper).every((b) => b.attributes('disabled') !== undefined)).toBe(true)
        expect(wrapper.find('.pc-note').text()).toBe("Checkout isn't set up yet.")
    })
})
