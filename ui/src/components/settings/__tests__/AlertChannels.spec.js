import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const integrations = vi.hoisted(() => ({
    disconnect: vi.fn(),
    smsList: vi.fn(),
    smsSubscribe: vi.fn(),
    smsVerify: vi.fn(),
    smsResend: vi.fn(),
    smsUpdate: vi.fn(),
    smsRemove: vi.fn(),
}))

vi.mock('@/api/client', () => ({ default: client }))
vi.mock('@/api/integrations', () => ({ default: integrations }))

const { default: AlertChannels } = await import('../AlertChannels.vue')

const Blank = defineComponent({ render: () => h('div') })
const CONSENT_NOTE =
    'By sending the code you agree to receive texts from Cansee at this number: verification codes and the daily Autopilot texts you turn on. Msg & data rates may apply. Reply STOP to cancel, HELP for help.'

async function render(subscriptions = []) {
    client.get.mockResolvedValue({ data: { data: [] } })
    integrations.smsList.mockResolvedValue({ data: { available: true, subscriptions } })
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/', component: Blank },
            { path: '/settings/autopilot', name: 'settings-autopilot', component: Blank },
        ],
    })
    await router.push('/')
    const wrapper = mount(AlertChannels, { global: { plugins: [router] } })
    await flushPromises()
    return { wrapper, router }
}

const smsTile = (wrapper) => wrapper.findAll('.intg-tile').find((t) => t.find('.intg-tile-name').text() === 'Text messages')

beforeEach(() => {
    client.get.mockReset()
    Object.values(integrations).forEach((fn) => fn.mockReset())
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('AlertChannels: text messages', () => {
    it("says the number gets Autopilot's daily text", async () => {
        const { wrapper } = await render()
        expect(smsTile(wrapper).find('.intg-tile-desc').text()).toBe(
            "Get Autopilot's daily text, and text Cansee a question from your phone.",
        )
    })

    it('says what sending the code agrees to, with the terms', async () => {
        const { wrapper } = await render()
        await smsTile(wrapper).find('button').trigger('click')
        const note = smsTile(wrapper).find('.sms-consent-note')
        expect(note.text()).toBe(`${CONSENT_NOTE} Text message terms`)
        const link = note.find('a')
        expect(link.text()).toBe('Text message terms')
        expect(link.attributes('href')).toBe('/terms#sms')
        expect(link.attributes('target')).toBe('_blank')
    })

    it('points a verified number to Autopilot for the daily texts', async () => {
        const { wrapper, router } = await render([
            { id: 's1', phone_masked: '•••-•••-1234', status: 'verified', allow_replies: true },
        ])
        const hints = smsTile(wrapper).findAll('.sms-form-hint').map((p) => p.text())
        expect(hints).toContain('Daily texts are set per project in Autopilot.')
        const link = smsTile(wrapper).find('.sms-link')
        expect(link.attributes('href')).toBe('/settings/autopilot')
        await link.trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.name).toBe('settings-autopilot')
    })

    it('lists the daily text among what gets sent', async () => {
        const { wrapper } = await render()
        expect(wrapper.findAll('.sent-row').map((r) => [r.find('.sent-row-title').text(), r.find('.sent-row-desc').text()])).toEqual([
            ['Daily report', 'Every morning: AI visibility for your projects and any open brand-security findings.'],
            ['Autopilot daily text', 'One text a day per project with what ran and which prompts keep you visible.'],
        ])
    })
})
