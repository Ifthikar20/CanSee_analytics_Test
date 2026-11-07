import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { plansPayload } from '@/components/billing/__tests__/__fixtures__/plans'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const billing = vi.hoisted(() => ({
    getCurrent: vi.fn(),
    getPlans: vi.fn(),
    checkout: vi.fn(),
    confirm: vi.fn(),
    dismissPaywall: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    upgradeNow: vi.fn(),
    changePlan: vi.fn(),
    portal: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))
vi.mock('@/api/billing', () => ({ default: billing }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: BillingPage } = await import('../BillingPage.vue')
const { useAuthStore } = await import('@/stores/auth')

const Blank = defineComponent({ render: () => h('div') })
const ShellStub = defineComponent({ name: 'SettingsShell', props: ['active'], setup: (_, { slots }) => () => h('div', slots.default?.()) })
const body = () => new DOMWrapper(document.body)
const mounted = []

// GET /billing/ for an account on `plan` (null: Free).
function overview(plan, extra = {}) {
    const paid = Boolean(plan)
    return {
        plan: paid ? plan : 'free',
        source: 'user',
        plan_details: null,
        limits: { projects: paid ? 5 : 1, tracked_prompts: { limit: paid ? 100 : 5, used: 9 }, autopilot: paid, sms_digest: paid },
        billing_ready: true,
        subscription_status: paid ? 'active' : 'none',
        tier: plan,
        is_trialing: false,
        trial_end: null,
        interval: paid ? 'month' : null,
        subscription_plan: plan,
        current_period_end: paid ? '2026-12-01T12:00:00Z' : null,
        cancel_at_period_end: false,
        managed: paid,
        provider: paid ? 'polar' : null,
        ...extra,
    }
}

async function render({ query = {}, current = overview(null), plansFail = false } = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore()
    auth.accessToken = 'token'
    auth.session = { subscription: { source: 'user' }, limits: { projects: 1 } }
    vi.spyOn(auth, 'fetchSession').mockResolvedValue(null)
    billing.getCurrent.mockResolvedValue({ data: current })
    if (plansFail) billing.getPlans.mockRejectedValue(new Error('500'))
    else billing.getPlans.mockResolvedValue({ data: plansPayload() })

    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/billing', name: 'billing', component: Blank },
            { path: '/dashboard', name: 'dashboard', component: Blank },
        ],
    })
    await router.push({ name: 'billing', query })
    await router.isReady()
    const wrapper = mount(BillingPage, {
        global: { plugins: [pinia, router], stubs: { SettingsShell: ShellStub } },
        attachTo: document.body,
    })
    mounted.push(wrapper)
    await flushPromises()
    return { wrapper, router, auth }
}

const cardButtons = (wrapper) => wrapper.findAll('button.pc-btn')
const cardWords = (wrapper) => cardButtons(wrapper).map((b) => b.text())
const dialogButton = (label) => body().findAll('.modal-card button').find((b) => b.text() === label)

beforeEach(() => {
    Object.values(billing).forEach((fn) => fn.mockReset())
    Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

describe('BillingPage: the pricing window', () => {
    it('shows the same two cards, the current plan marked', async () => {
        const { wrapper } = await render({ current: overview('prompts_100') })
        expect(wrapper.find('.bp-current-name').text()).toContain('100 prompts')
        expect(wrapper.find('.bp-current-name').text()).toContain('$80')
        expect(cardWords(wrapper)).toEqual(['Current plan', 'Move to 200 prompts'])
        // The monthly and annual toggle is gone.
        expect(wrapper.text()).not.toContain('Annual')
        expect(wrapper.text()).not.toContain('Switch to annual billing')
    })

    it('offers both plans to a Free account and starts the checkout of the one chosen', async () => {
        const { wrapper } = await render()
        expect(cardWords(wrapper)).toEqual(['Choose 100 prompts', 'Choose 200 prompts'])
        billing.checkout.mockResolvedValue({ data: { success: true, data: { checkout_url: 'https://evil.example/pay' } } })
        await cardButtons(wrapper)[0].trigger('click')
        await flushPromises()
        expect(billing.checkout).toHaveBeenCalledWith({ plan: 'prompts_100' })
        // Never hands the browser to anything but Polar.
        expect(toast.error).toHaveBeenCalledWith("We couldn't start checkout. Please try again.")
    })

    it('recovers from already_subscribed by reading the subscription again', async () => {
        const { wrapper } = await render()
        billing.checkout.mockRejectedValue({ response: { status: 400, data: { error: { code: 'already_subscribed', message: 'x' } } } })
        await cardButtons(wrapper)[1].trigger('click')
        await flushPromises()
        expect(toast.success).toHaveBeenCalledWith('Your subscription is already active.')
        expect(billing.getCurrent).toHaveBeenCalledTimes(2)
    })

    it('says checkout is not set up and holds the cards', async () => {
        const { wrapper } = await render({ current: overview(null, { billing_ready: false }) })
        expect(cardButtons(wrapper).every((b) => b.attributes('disabled') !== undefined)).toBe(true)
        expect(wrapper.find('.pc-note').text()).toBe("Checkout isn't set up yet.")
    })

    it('shows a failed plan list inline with a retry', async () => {
        const { wrapper } = await render({ plansFail: true })
        const note = wrapper.find('.bp-current-note.is-warn')
        expect(note.text()).toContain("We couldn't load the plans.")
        billing.getPlans.mockResolvedValue({ data: plansPayload() })
        await note.find('button').trigger('click')
        await flushPromises()
        expect(cardWords(wrapper)).toEqual(['Choose 100 prompts', 'Choose 200 prompts'])
    })
})

describe('BillingPage: ?plan=', () => {
    it('starts the checkout once for an account without a paid plan, then drops the query', async () => {
        billing.checkout.mockResolvedValue({ data: { success: true, data: { checkout_url: 'https://evil.example/pay' } } })
        const { router } = await render({ query: { plan: 'prompts_200' } })
        expect(billing.checkout).toHaveBeenCalledTimes(1)
        expect(billing.checkout).toHaveBeenCalledWith({ plan: 'prompts_200' })
        expect(router.currentRoute.value.query).toEqual({})
    })

    it('ignores a plan that is not offered', async () => {
        const { router } = await render({ query: { plan: 'business' } })
        expect(billing.checkout).not.toHaveBeenCalled()
        expect(router.currentRoute.value.query).toEqual({})
    })

    it('asks before moving a paid account to the plan it chose', async () => {
        await render({ query: { plan: 'prompts_200' }, current: overview('prompts_100') })
        expect(billing.checkout).not.toHaveBeenCalled()
        expect(body().find('.bm-title').text()).toBe('Move to 200 prompts?')
    })
})

describe('ChangePlanDialog from Billing', () => {
    it('moves up: Polar charges the difference', async () => {
        const { wrapper, auth } = await render({ current: overview('prompts_100') })
        await cardButtons(wrapper)[1].trigger('click')
        await flushPromises()
        expect(body().find('.bm-title').text()).toBe('Move to 200 prompts?')
        expect(body().findAll('.cpd-text').map((p) => p.text())).toEqual([
            'Your plan changes now. Polar charges the difference for the rest of this billing month.',
        ])

        billing.changePlan.mockResolvedValue({ data: { success: true, data: {} } })
        billing.getCurrent.mockResolvedValue({ data: overview('prompts_200') })
        await dialogButton('Move to 200 prompts').trigger('click')
        await flushPromises()
        expect(billing.changePlan).toHaveBeenCalledWith({ plan: 'prompts_200' }, { _silentError: true, _noRetry429: true })
        expect(auth.fetchSession).toHaveBeenCalled()
        expect(toast.success).toHaveBeenCalledWith("You're on 200 prompts.")
        expect(body().find('.bm-title').exists()).toBe(false)
        expect(cardWords(wrapper)).toEqual(['Move to 100 prompts', 'Current plan'])
    })

    it('moves down: Polar credits the rest, and the oldest prompts stay checked', async () => {
        const current = overview('prompts_200', {
            limits: { projects: 5, tracked_prompts: { limit: 200, used: 140 }, autopilot: true, sms_digest: true },
        })
        const { wrapper } = await render({ current })
        await cardButtons(wrapper)[0].trigger('click')
        await flushPromises()
        expect(body().find('.bm-title').text()).toBe('Move to 100 prompts?')
        expect(body().findAll('.cpd-text').map((p) => p.text())).toEqual([
            'Your plan changes now. Polar credits the unused part to your next invoice.',
            'You track 140 prompts. Autopilot will check the 100 oldest until you archive 40.',
        ])
    })

    it('leaves the tracked line out when the smaller plan covers them', async () => {
        const { wrapper } = await render({ current: overview('prompts_200') })
        await cardButtons(wrapper)[0].trigger('click')
        await flushPromises()
        expect(body().findAll('.cpd-text')).toHaveLength(1)
    })

    it('shows the server message inline when the change fails', async () => {
        const { wrapper } = await render({ current: overview('prompts_100') })
        await cardButtons(wrapper)[1].trigger('click')
        await flushPromises()
        billing.changePlan.mockRejectedValue({
            response: { status: 400, data: { error: { code: 'not_active', message: 'Your subscription is not active.' } } },
        })
        await dialogButton('Move to 200 prompts').trigger('click')
        await flushPromises()
        expect(body().find('.cpd-error').text()).toBe('Your subscription is not active.')
        expect(toast.success).not.toHaveBeenCalled()
    })

    it('moves a legacy Pro account up to either plan', async () => {
        const current = overview('pro', {
            plan_details: { id: 'pro', name: 'Pro', price_monthly: 45, price_yearly: 450, self_serve: false },
        })
        const { wrapper } = await render({ current })
        expect(wrapper.find('.bp-current-name').text()).toContain('Pro')
        expect(wrapper.find('.bp-current-name').text()).toContain('$45')
        expect(cardWords(wrapper)).toEqual(['Move to 100 prompts', 'Move to 200 prompts'])
        await cardButtons(wrapper)[0].trigger('click')
        await flushPromises()
        expect(body().find('.cpd-text').text()).toBe(
            'Your plan changes now. Polar charges the difference for the rest of this billing month.',
        )
    })
})

describe('BillingPage: the cycle switch', () => {
    it('stays for legacy Pro only', async () => {
        const pro = await render({ current: overview('pro') })
        expect(pro.wrapper.findAll('button').some((b) => b.text() === 'Switch to annual billing')).toBe(true)
        pro.wrapper.unmount()
        mounted.pop()

        const hundred = await render({ current: overview('prompts_100') })
        expect(hundred.wrapper.findAll('button').some((b) => /Switch to (annual|monthly) billing/.test(b.text()))).toBe(false)
    })
})
