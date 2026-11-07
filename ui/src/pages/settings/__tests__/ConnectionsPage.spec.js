import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const websites = vi.hoisted(() => ({ list: vi.fn() }))
const traffic = vi.hoisted(() => ({ sources: vi.fn() }))
const wa = vi.hoisted(() => ({
    pixel: vi.fn(),
    verifyPixel: vi.fn(),
    ga4Status: vi.fn(),
    ga4Connect: vi.fn(),
    ga4Properties: vi.fn(),
    ga4SelectProperty: vi.fn(),
    ga4Disconnect: vi.fn(),
    cfStatus: vi.fn(),
    cfConnect: vi.fn(),
    cfZones: vi.fn(),
    cfSelectZone: vi.fn(),
    cfDisconnect: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))
vi.mock('@/api/websites', () => ({ default: websites }))
vi.mock('@/api/traffic', () => ({ default: traffic }))
vi.mock('@/api/webAnalytics', () => ({ default: wa }))
vi.mock('@/api/searchConsole', () => ({
    default: { connectStart: vi.fn(), properties: vi.fn(), selectProperty: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

import ConnectionsPage from '@/pages/settings/ConnectionsPage.vue'
import { useAppStore } from '@/stores/app'
import { trafficSources } from '@/pages/__tests__/__fixtures__/polish'

enableAutoUnmount(afterEach)

const SITE_A = { id: 'site-a', name: 'Notion', url: 'https://notion.so' }
const SITE_B = { id: 'site-b', name: 'Turonote', url: 'https://turonote.test' }
const GSC_OFF = { configured: true, connected: false, site_url: null, last_synced_at: null, pending_property_selection: false }

const Blank = defineComponent({ render: () => h('div') })
// The settings frame (its nav has its own specs); the page's sections render inside.
const ShellStub = defineComponent({ name: 'SettingsShell', props: ['active'], setup: (_, { slots }) => () => h('div', slots.default?.()) })

async function mountPage(query = {}, { list = [SITE_A, SITE_B], active = SITE_A, websitesLoad = null } = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const app = useAppStore()
    if (list.length) app.setWebsites(list)
    if (active) app.setActiveWebsite(active)
    websites.list.mockImplementation(() => websitesLoad || Promise.resolve({ data: [SITE_A, SITE_B] }))
    client.get.mockImplementation((url) => {
        if (url.startsWith('/search-console/')) return Promise.resolve({ data: GSC_OFF })
        return Promise.reject(new Error(`unexpected GET ${url}`))
    })
    traffic.sources.mockResolvedValue({ data: trafficSources() })
    wa.pixel.mockResolvedValue({ data: { pixel_key: 'k', snippet: '<script></script>' } })
    wa.ga4Status.mockResolvedValue({ data: { connected: true, configured: true, property_id: '1', property_display_name: 'Web' } })
    wa.cfStatus.mockResolvedValue({ data: { connected: false } })
    wa.ga4Properties.mockResolvedValue({ data: { properties: [{ property_id: '1', display_name: 'Web', account_name: 'Acme' }] } })

    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/settings', name: 'settings', component: Blank },
            { path: '/settings/connections', name: 'settings-connections', component: Blank },
        ],
    })
    await router.push({ name: 'settings-connections', query })
    await router.isReady()
    const wrapper = mount(ConnectionsPage, {
        global: {
            plugins: [pinia, router],
            stubs: { SettingsShell: ShellStub, AlertChannels: true, PropertyPickerModal: true },
        },
        attachTo: document.body,
    })
    await flushPromises()
    return { wrapper, router, app }
}

const gscReads = () => client.get.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/search-console/'))

beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset())
    Object.values(wa).forEach((fn) => fn.mockReset())
    websites.list.mockReset()
    traffic.sources.mockReset()
    Object.values(toast).forEach((fn) => fn.mockReset())
})

describe('ConnectionsPage: Website traffic', () => {
    it('adds the traffic sources before where reports go', async () => {
        const { wrapper } = await mountPage()
        expect(wrapper.findAll('.sc-label').map((l) => l.text())).toEqual(['Google', 'Traffic', 'Reports'])
        const section = wrapper.findAll('.sc-wrap')[1]
        expect(section.find('.sc-title').text()).toBe('Website traffic')
        expect(section.find('.sc-desc').text()).toBe(
            'Where Cansee reads your visitors, their countries and visits from AI assistants. Each source measures something different.'
        )
        expect(section.findAll('.ts-card-title').map((t) => t.text())).toEqual(['Cansee pixel', 'Google Analytics 4', 'Cloudflare'])
        expect(wa.ga4Status).toHaveBeenCalledWith(SITE_A.id)
    })
})

describe('ConnectionsPage: back from Google Analytics', () => {
    it('makes the project Google connected active before reading any status, then clears the query', async () => {
        const { router, app } = await mountPage({ ga4: 'connected', website: SITE_B.id })
        expect(app.activeWebsite.id).toBe(SITE_B.id)
        expect(gscReads()).toEqual([`/search-console/${SITE_B.id}/status/`])
        expect(wa.ga4Status.mock.calls).toEqual([[SITE_B.id]])
        expect(traffic.sources.mock.calls).toEqual([[SITE_B.id]])
        expect(toast.success).toHaveBeenCalledWith('Google Analytics is connected.')
        expect(router.currentRoute.value.query).toEqual({})
    })

    it('waits for the project list on a fresh load before reading anything', async () => {
        let resolveList
        const websitesLoad = new Promise((resolve) => (resolveList = resolve))
        const { wrapper, app } = await mountPage(
            { ga4: 'error', reason: 'denied', website: SITE_B.id },
            { list: [], active: null, websitesLoad }
        )
        expect(gscReads()).toEqual([])
        expect(wa.ga4Status).not.toHaveBeenCalled()
        expect(wrapper.text()).toContain('Checking the connection...')

        resolveList({ data: [SITE_A, SITE_B] })
        await flushPromises()
        expect(app.activeWebsite.id).toBe(SITE_B.id)
        expect(gscReads()).toEqual([`/search-console/${SITE_B.id}/status/`])
        expect(wa.ga4Status.mock.calls).toEqual([[SITE_B.id]])
        expect(toast.error).toHaveBeenCalledWith('You declined access in Google.')
    })

    it('keeps the active project when the return names one the user does not have', async () => {
        const { app, router } = await mountPage({ ga4: 'error', reason: 'invalid_state', website: 'someone-else' })
        expect(app.activeWebsite.id).toBe(SITE_A.id)
        expect(wa.ga4Status.mock.calls).toEqual([[SITE_A.id]])
        expect(toast.error).toHaveBeenCalledWith('The connection link expired. Try again.')
        expect(router.currentRoute.value.query).toEqual({})
    })

    it('opens the property picker when Google asks to choose one', async () => {
        await mountPage({ ga4: 'select_property', website: SITE_B.id })
        expect(wa.ga4Properties).toHaveBeenCalledWith(SITE_B.id)
        expect(document.body.querySelectorAll('input[name="ga4-property"]')).toHaveLength(1)
    })
})
