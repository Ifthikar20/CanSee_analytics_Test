import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

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

vi.mock('@/api/traffic', () => ({ default: traffic }))
vi.mock('@/api/webAnalytics', () => ({ default: wa }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

import TrafficSources from '../TrafficSources.vue'
import { WEBSITE_ID, trafficSources } from '@/pages/__tests__/__fixtures__/polish'

enableAutoUnmount(afterEach)

const SNIPPET = '<script async src="https://cansee.test/p.js" data-key="k-1"></script>'
const ok = (data) => Promise.resolve({ data })

function httpError(status, body) {
    return Object.assign(new Error('Request failed'), { response: { status, data: body } })
}

const GA4_OFF = { connected: false, property_id: null, property_display_name: null, pending_property_selection: false, configured: true }
const GA4_ON = { ...GA4_OFF, connected: true, property_id: '123', property_display_name: 'Notion web' }
const CF_OFF = { connected: false, zone_id: null, zone_name: null, pending_zone_selection: false, zones_found: 0 }
const CF_ON = { ...CF_OFF, connected: true, zone_id: 'z1', zone_name: 'notion.so' }

async function mountCard({ props = {}, sources = trafficSources(), ga4 = GA4_OFF, cf = CF_OFF } = {}) {
    traffic.sources.mockImplementation(() => ok(sources))
    wa.pixel.mockImplementation(() => ok({ pixel_key: 'k-1', snippet: SNIPPET }))
    wa.ga4Status.mockImplementation(() => (ga4 instanceof Error ? Promise.reject(ga4) : ok(ga4)))
    wa.cfStatus.mockImplementation(() => (cf instanceof Error ? Promise.reject(cf) : ok(cf)))
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/settings/connections', name: 'settings-connections', component: defineComponent({ render: () => h('div') }) }],
    })
    await router.push('/settings/connections')
    await router.isReady()
    const wrapper = mount(TrafficSources, {
        props: { websiteId: WEBSITE_ID, websiteUrl: 'https://notion.so', ...props },
        global: { plugins: [router] },
        attachTo: document.body,
    })
    await flushPromises()
    return wrapper
}

const card = (wrapper, title) => wrapper.findAll('.ts-card').find((c) => c.find('.ts-card-title').text() === title)
const statusOf = (wrapper, title) => card(wrapper, title).find('.ts-status').text().replace(/\s+/g, ' ').trim()
const button = (root, text) => root.findAll('button').find((b) => b.text().trim() === text)
const modalButton = (text) => [...document.body.querySelectorAll('.modal-card button')].find((b) => b.textContent.trim() === text)

beforeEach(() => {
    Object.values(wa).forEach((fn) => fn.mockReset())
    traffic.sources.mockReset()
    Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('TrafficSources: statuses', () => {
    it('shows each source with its status and what each can measure', async () => {
        const wrapper = await mountCard({ cf: CF_ON })
        expect(statusOf(wrapper, 'Cansee pixel')).toBe('Installed and recording')
        expect(statusOf(wrapper, 'Google Analytics 4')).toBe('Not connected')
        expect(statusOf(wrapper, 'Cloudflare')).toBe('Connected: notion.so')
        expect(card(wrapper, 'Cansee pixel').text()).toContain(
            'Counts unique visitors and visits from AI assistants. Visitors who decline analytics consent are not counted.'
        )
        expect(card(wrapper, 'Cloudflare').text()).toContain(
            'Cloudflare counts every request, including bots, so its numbers are requests, not visitors. It is the only source that can see AI crawlers.'
        )
        // The capability table, without a link back to this page.
        expect(wrapper.findAll('.scap-table tbody tr')).toHaveLength(4)
        expect(wrapper.text()).not.toContain('Manage connections')
    })

    it('tells an installed pixel without visits from one that is not installed', async () => {
        const quiet = trafficSources()
        quiet.sources[0] = { ...quiet.sources[0], status: 'not_installed', connected: true, has_data: false }
        let wrapper = await mountCard({ sources: quiet })
        expect(statusOf(wrapper, 'Cansee pixel')).toBe('Installed, no visits yet')
        wrapper.unmount()

        quiet.sources[0] = { ...quiet.sources[0], connected: false }
        wrapper = await mountCard({ sources: quiet })
        expect(statusOf(wrapper, 'Cansee pixel')).toBe('Not installed')
    })

    it('says when web analytics is turned off on the server', async () => {
        const off = httpError(404, { success: false, error: { code: 'not_found', message: 'Not found.' } })
        const wrapper = await mountCard({ ga4: off, cf: off })
        expect(statusOf(wrapper, 'Google Analytics 4')).toBe('Not available on this server')
        expect(statusOf(wrapper, 'Cloudflare')).toBe('Not available on this server')
        expect(button(wrapper, 'Connect Google Analytics')).toBeUndefined()
        expect(wrapper.find('#ts-cf-token').exists()).toBe(false)
    })

    it('says when Google Analytics is not configured on the server', async () => {
        const wrapper = await mountCard({ ga4: { ...GA4_OFF, configured: false } })
        expect(statusOf(wrapper, 'Google Analytics 4')).toBe('Not available on this server')
        expect(button(wrapper, 'Connect Google Analytics')).toBeUndefined()
    })
})

describe('TrafficSources: the Cansee pixel', () => {
    it('shows the snippet and copies it', async () => {
        const writeText = vi.fn().mockResolvedValue()
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
        const wrapper = await mountCard()
        expect(wa.pixel).toHaveBeenCalledWith(WEBSITE_ID)
        expect(wrapper.find('.px-code').text()).toBe(SNIPPET)
        await button(wrapper, 'Copy snippet').trigger('click')
        await flushPromises()
        expect(writeText).toHaveBeenCalledWith(SNIPPET)
        expect(toast.success).toHaveBeenCalledWith('Snippet copied.')
    })

    it('checks the installation and refreshes the status', async () => {
        const wrapper = await mountCard()
        wa.verifyPixel.mockResolvedValueOnce({ data: { verified: true, pixel_key: 'k-1' } })
        await button(wrapper, 'Check installation').trigger('click')
        await flushPromises()
        expect(wa.verifyPixel).toHaveBeenCalledWith(WEBSITE_ID)
        expect(toast.success).toHaveBeenCalledWith('The pixel is on notion.so.')
        expect(traffic.sources).toHaveBeenCalledTimes(2)
    })

    it('says where it looked when the pixel is not found', async () => {
        const wrapper = await mountCard()
        wa.verifyPixel.mockResolvedValueOnce({ data: { verified: false, pixel_key: 'k-1' } })
        await button(wrapper, 'Check installation').trigger('click')
        await flushPromises()
        expect(wrapper.find('.px-error').text().replace(/\s+/g, ' ')).toBe(
            "We couldn't find the pixel on https://notion.so. Put the snippet in the page's head, publish, then check again."
        )
        expect(toast.success).not.toHaveBeenCalled()
    })
})

describe('TrafficSources: Google Analytics 4', () => {
    it('sends the user to Google to connect', async () => {
        const assign = vi.fn()
        vi.stubGlobal('location', { ...window.location, assign })
        const wrapper = await mountCard()
        wa.ga4Connect.mockResolvedValueOnce({ data: { authorize_url: 'https://accounts.google.test/o/oauth2/auth?x=1' } })
        await button(card(wrapper, 'Google Analytics 4'), 'Connect Google Analytics').trigger('click')
        await flushPromises()
        expect(wa.ga4Connect).toHaveBeenCalledWith(WEBSITE_ID)
        expect(assign).toHaveBeenCalledWith('https://accounts.google.test/o/oauth2/auth?x=1')
    })

    it('chooses a property from the connected account', async () => {
        const wrapper = await mountCard({ ga4: { ...GA4_ON, property_id: null, property_display_name: null, pending_property_selection: true } })
        expect(statusOf(wrapper, 'Google Analytics 4')).toBe('Choose a property')
        wa.ga4Properties.mockResolvedValueOnce({
            data: {
                properties: [
                    { property_id: '123', display_name: 'Notion web', account_name: 'Notion' },
                    { property_id: '456', display_name: 'Notion docs', account_name: 'Notion' },
                ],
            },
        })
        await button(card(wrapper, 'Google Analytics 4'), 'Choose property').trigger('click')
        await flushPromises()
        const options = [...document.body.querySelectorAll('input[name="ga4-property"]')]
        expect(options).toHaveLength(2)
        options[1].click()
        await flushPromises()

        wa.ga4SelectProperty.mockResolvedValueOnce({ data: { ...GA4_ON, property_id: '456', property_display_name: 'Notion docs' } })
        modalButton('Use this property').click()
        await flushPromises()
        expect(wa.ga4SelectProperty).toHaveBeenCalledWith(WEBSITE_ID, { property_id: '456' })
        expect(toast.success).toHaveBeenCalledWith('Google Analytics is connected.')
        expect(statusOf(wrapper, 'Google Analytics 4')).toBe('Connected: Notion docs')
        expect(document.body.querySelector('input[name="ga4-property"]')).toBeNull()
    })

    it('disconnects only after the user confirms', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
        const wrapper = await mountCard({ ga4: GA4_ON })
        expect(statusOf(wrapper, 'Google Analytics 4')).toBe('Connected: Notion web')
        await button(card(wrapper, 'Google Analytics 4'), 'Disconnect').trigger('click')
        expect(confirm).toHaveBeenCalledWith('Disconnect Google Analytics? Cansee stops reading it; your Google data is not touched.')
        expect(wa.ga4Disconnect).not.toHaveBeenCalled()

        wa.ga4Disconnect.mockResolvedValueOnce({ data: '' })
        wa.ga4Status.mockImplementation(() => ok(GA4_OFF))
        await button(card(wrapper, 'Google Analytics 4'), 'Disconnect').trigger('click')
        await flushPromises()
        expect(wa.ga4Disconnect).toHaveBeenCalledWith(WEBSITE_ID)
        expect(toast.success).toHaveBeenCalledWith('Google Analytics disconnected.')
        expect(statusOf(wrapper, 'Google Analytics 4')).toBe('Not connected')
    })

    it.each([
        [{ outcome: 'connected', reason: '' }, 'success', 'Google Analytics is connected.'],
        [{ outcome: 'error', reason: 'denied' }, 'error', 'You declined access in Google.'],
        [{ outcome: 'error', reason: 'exchange_failed' }, 'error', "Google didn't confirm the connection. Try again."],
        [{ outcome: 'error', reason: 'invalid_state' }, 'error', 'The connection link expired. Try again.'],
    ])('reports the return from Google: %o', async (ga4Return, kind, text) => {
        await mountCard({ props: { ga4Return } })
        expect(toast[kind]).toHaveBeenCalledWith(text)
    })

    it('opens the property picker when Google asks to choose one', async () => {
        wa.ga4Properties.mockResolvedValue({ data: { properties: [{ property_id: '123', display_name: 'Notion web', account_name: 'Notion' }] } })
        await mountCard({ ga4: GA4_ON, props: { ga4Return: { outcome: 'select_property', reason: '' } } })
        expect(wa.ga4Properties).toHaveBeenCalledWith(WEBSITE_ID)
        expect(document.body.querySelectorAll('input[name="ga4-property"]')).toHaveLength(1)
        // The property in use is preselected.
        expect(document.body.querySelector('input[name="ga4-property"]').checked).toBe(true)
    })
})

describe('TrafficSources: Cloudflare', () => {
    async function submitToken(wrapper, value) {
        await wrapper.find('#ts-cf-token').setValue(value)
        await wrapper.find('form.ts-form').trigger('submit')
        await flushPromises()
    }

    it('takes a token in a password field and clears it after every submit', async () => {
        const wrapper = await mountCard()
        const input = wrapper.find('#ts-cf-token')
        expect(input.attributes('type')).toBe('password')
        expect(input.attributes('autocomplete')).toBe('off')
        expect(wrapper.find('label[for="ts-cf-token"]').text()).toBe('Cloudflare API token (Zone, Analytics, Read)')

        wa.cfConnect.mockRejectedValueOnce(httpError(400, { error: 'invalid_token' }))
        await submitToken(wrapper, 'secret-token-1')
        expect(wa.cfConnect).toHaveBeenCalledWith(WEBSITE_ID, { api_token: 'secret-token-1' })
        expect(wrapper.find('.ts-error').text()).toBe("Cloudflare didn't accept this token.")
        expect(wrapper.find('#ts-cf-token').element.value).toBe('')
        expect(wrapper.html()).not.toContain('secret-token-1')

        wa.cfConnect.mockResolvedValueOnce({ data: CF_ON })
        await submitToken(wrapper, 'secret-token-2')
        expect(toast.success).toHaveBeenCalledWith('Cloudflare is connected.')
        expect(statusOf(wrapper, 'Cloudflare')).toBe('Connected: notion.so')
        expect(wrapper.find('#ts-cf-token').exists()).toBe(false)
        expect(wrapper.html()).not.toContain('secret-token-2')
    })

    it('asks for a zone when the token reads several and none matches the site', async () => {
        const wrapper = await mountCard()
        wa.cfConnect.mockResolvedValueOnce({ data: { ...CF_ON, zone_id: null, zone_name: null, pending_zone_selection: true, zones_found: 2 } })
        wa.cfZones.mockResolvedValueOnce({
            data: {
                zones: [
                    { id: 'z1', name: 'notion.so', status: 'active', paused: false },
                    { id: 'z2', name: 'notion.site', status: 'active', paused: true },
                ],
            },
        })
        await submitToken(wrapper, 'secret-token')
        expect(statusOf(wrapper, 'Cloudflare')).toBe('Choose a zone')
        const zones = [...document.body.querySelectorAll('input[name="cf-zone"]')]
        expect(zones).toHaveLength(2)
        zones[0].click()
        await flushPromises()

        wa.cfSelectZone.mockResolvedValueOnce({ data: CF_ON })
        modalButton('Use this zone').click()
        await flushPromises()
        expect(wa.cfSelectZone).toHaveBeenCalledWith(WEBSITE_ID, { zone_id: 'z1' })
        expect(statusOf(wrapper, 'Cloudflare')).toBe('Connected: notion.so')
    })

    it('offers the zone picker again for a connection still waiting for its zone, and disconnects', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
        const wrapper = await mountCard({ cf: { ...CF_ON, zone_id: null, zone_name: null, pending_zone_selection: true } })
        expect(button(card(wrapper, 'Cloudflare'), 'Choose zone')).toBeDefined()

        wa.cfDisconnect.mockResolvedValueOnce({ data: '' })
        wa.cfStatus.mockImplementation(() => ok(CF_OFF))
        await button(card(wrapper, 'Cloudflare'), 'Disconnect').trigger('click')
        await flushPromises()
        expect(confirm).toHaveBeenCalledWith('Disconnect Cloudflare? Cansee stops reading it; your Cloudflare data is not touched.')
        expect(wa.cfDisconnect).toHaveBeenCalledWith(WEBSITE_ID)
        expect(statusOf(wrapper, 'Cloudflare')).toBe('Not connected')
        expect(wrapper.find('#ts-cf-token').exists()).toBe(true)
    })
})
