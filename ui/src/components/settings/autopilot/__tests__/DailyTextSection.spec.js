import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { MINE, MINE_TOO, THEIRS, settingsPayload } from './__fixtures__/autopilot'

const autopilot = vi.hoisted(() => ({ testText: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/autopilot', () => ({ default: autopilot }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: DailyTextSection } = await import('../DailyTextSection.vue')

const Blank = defineComponent({ render: () => h('div') })
const CONSENT =
    'I agree to receive one automated text a day from Cansee about Notion at this number. Msg & data rates may apply. Reply STOP to cancel or HELP for help. Consent is not a condition of purchase.'

// Mounts the section with every v-model wired back into its props.
async function render({ sms = {}, saved = {}, models = {}, ...props } = {}) {
    const payload = settingsPayload({ sms, settings: saved })
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/', component: Blank },
            { path: '/settings/connections', name: 'settings-connections', component: Blank },
        ],
    })
    await router.push('/')
    const state = {
        digest: payload.settings.sms_digest,
        recipient: payload.settings.sms_subscription_id,
        quietStart: payload.settings.quiet_start,
        quietEnd: payload.settings.quiet_end,
        consent: false,
        ...models,
    }
    const wrapper = mount(DailyTextSection, {
        props: {
            websiteId: 'w1',
            sms: payload.sms,
            saved: payload.settings,
            timezone: 'America/New_York',
            ...state,
            'onUpdate:digest': (v) => wrapper.setProps({ digest: v }),
            'onUpdate:recipient': (v) => wrapper.setProps({ recipient: v }),
            'onUpdate:quietStart': (v) => wrapper.setProps({ quietStart: v }),
            'onUpdate:quietEnd': (v) => wrapper.setProps({ quietEnd: v }),
            'onUpdate:consent': (v) => wrapper.setProps({ consent: v }),
            ...props,
        },
        global: { plugins: [router] },
    })
    await flushPromises()
    return { wrapper, router }
}

const theSwitch = (wrapper) => wrapper.find('input[role="switch"]')
const consentBox = (wrapper) => wrapper.find('.dt-consent')

beforeEach(() => {
    autopilot.testText.mockReset()
    Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
    vi.useRealTimers()
})

describe('DailyTextSection: states', () => {
    it('explains the section', async () => {
        const { wrapper } = await render()
        expect(wrapper.find('.sc-title').text()).toBe('Daily text')
        expect(wrapper.find('.sc-desc').text()).toBe('One text after each run with what ran and which prompts keep you visible.')
    })

    it('says so when texts are off on the server', async () => {
        const { wrapper } = await render({ sms: { available: false } })
        expect(wrapper.find('.dt-muted').text()).toBe("Text messages aren't set up on this server yet.")
        expect(theSwitch(wrapper).exists()).toBe(false)
        expect(wrapper.find('.sc-foot').exists()).toBe(false)
    })

    it("shows the last run's text as a preview when texts are off on the server", async () => {
        const body = 'Cansee daily, Notion: named in 13/18 answers (72%). Reply STOP to end'
        const { wrapper } = await render({ sms: { available: false }, lastText: { text: { status: 'not_requested' }, body } })
        expect(wrapper.find('.dt-quote').text()).toBe(body)
        expect(wrapper.find('.dt-last .dt-label').text()).toBe("The last run's text (not sent)")
    })

    it('sends a caller without a verified number to Connections', async () => {
        const { wrapper } = await render({ sms: { numbers: [] } })
        expect(wrapper.find('.dt-muted').text()).toBe('Add and verify your mobile number in Connections to get the daily text.')
        const link = wrapper.find('a')
        expect(link.text()).toBe('Open Connections')
        expect(link.attributes('href')).toBe('/settings/connections')
        expect(theSwitch(wrapper).exists()).toBe(false)
    })
})

describe('DailyTextSection: turning the text on', () => {
    it('picks your number and asks for your agreement', async () => {
        const { wrapper } = await render({ sms: { numbers: [MINE, MINE_TOO] } })
        expect(wrapper.find('label[for="dt-digest"]').text()).toBe('Text me after each run')
        expect(consentBox(wrapper).exists()).toBe(false)

        await theSwitch(wrapper).setValue(true)
        expect(wrapper.props('digest')).toBe(true)
        expect(wrapper.props('recipient')).toBe(MINE.id)
        expect(wrapper.find('label[for="dt-number"]').text()).toBe('Send to')
        expect(wrapper.findAll('#dt-number option').map((o) => o.text())).toEqual(['•••-•••-1234', '•••-•••-5678'])

        const box = consentBox(wrapper)
        expect(box.find('.dt-consent-text').text()).toBe(CONSENT)
        const links = box.findAll('.dt-consent-links a')
        expect(links.map((a) => [a.text(), a.attributes('href'), a.attributes('target')])).toEqual([
            ['Text message terms', '/terms#sms', '_blank'],
            ['Privacy', '/privacy', '_blank'],
        ])
        const agree = box.find('input[type="checkbox"]')
        expect(agree.attributes('required')).toBeDefined()
        expect(box.find('.dt-agree').text()).toBe('I agree')
        await agree.setValue(true)
        expect(wrapper.props('consent')).toBe(true)
    })

    it('asks the owner to agree again when the last text waited for it', async () => {
        const { wrapper } = await render({
            sms: { recipient: { ...MINE, status: 'verified', set_by_name: 'You' } },
            saved: { sms_digest: true, sms_subscription_id: MINE.id },
            agreeAgain: true,
        })
        const box = consentBox(wrapper)
        expect(box.find('.dt-consent-text').text()).toBe(CONSENT)
        // Optional here: the text and its number stay as they are.
        expect(box.find('input[type="checkbox"]').attributes('required')).toBeUndefined()
    })

    it('keeps the saved number when it turns off again', async () => {
        const { wrapper } = await render()
        await theSwitch(wrapper).setValue(true)
        expect(wrapper.props('recipient')).toBe(MINE.id)
        await theSwitch(wrapper).setValue(false)
        expect(wrapper.props('digest')).toBe(false)
        expect(wrapper.props('recipient')).toBeNull()
        expect(consentBox(wrapper).exists()).toBe(false)
    })

    it('sets quiet hours in the project zone', async () => {
        const { wrapper } = await render({ models: { digest: true, recipient: MINE.id } })
        expect(wrapper.find('.dt-quiet').text()).toContain("Don't text between")
        const [start, end] = wrapper.findAll('.dt-quiet select')
        expect(start.element.value).toBe('21:00')
        expect(end.element.value).toBe('08:00')
        expect(start.findAll('option')).toHaveLength(96)
        expect(wrapper.find('#dt-quiet-help').text()).toBe(
            'A text that is ready during quiet hours waits until they end. Times are in America/New_York.',
        )
        await end.setValue('07:30')
        expect(wrapper.props('quietEnd')).toBe('07:30')
    })

    it('asks again when the number changes while the text is on, not otherwise', async () => {
        const { wrapper } = await render({
            sms: { numbers: [MINE, MINE_TOO], recipient: { ...MINE, status: 'verified', set_by_name: 'You' } },
            saved: { sms_digest: true, sms_subscription_id: MINE.id },
        })
        expect(consentBox(wrapper).exists()).toBe(false)
        await wrapper.find('#dt-number').setValue(MINE_TOO.id)
        expect(consentBox(wrapper).exists()).toBe(true)
        await wrapper.find('#dt-number').setValue(MINE.id)
        expect(consentBox(wrapper).exists()).toBe(false)
    })

    it('shows each field error under its field', async () => {
        const errors = {
            sms_digest: "Text messaging isn't configured on this deployment.",
            sms_subscription_id: 'Choose a mobile number you verified.',
            sms_consent: 'Agree to the text message terms to turn on the daily text.',
            quiet_end: 'Quiet hours need a start and an end that differ.',
        }
        const { wrapper } = await render({ models: { digest: true, recipient: MINE.id }, errors })
        expect(wrapper.findAll('.dt-error').map((p) => p.text())).toEqual([
            errors.sms_digest,
            errors.sms_subscription_id,
            errors.sms_consent,
            errors.quiet_end,
        ])
    })

    it('saves the page from its own footer', async () => {
        const { wrapper } = await render({ dirty: false })
        const save = wrapper.find('.sc-foot button')
        expect(save.text()).toBe('Save changes')
        expect(save.attributes('disabled')).toBeDefined()
        await wrapper.setProps({ dirty: true })
        await save.trigger('click')
        expect(wrapper.emitted('save')).toHaveLength(1)
        await wrapper.setProps({ saving: true })
        expect(save.text()).toBe('Saving...')
    })
})

describe("DailyTextSection: someone else's number", () => {
    const saved = { sms_digest: true, sms_subscription_id: THEIRS.id }

    it('names it, and can turn it off', async () => {
        const { wrapper } = await render({ sms: { numbers: [], recipient: THEIRS }, saved })
        expect(wrapper.find('.dt-line').text()).toBe('Texts go to •••-•••-9876, set by Ifthikar.')
        expect(theSwitch(wrapper).attributes('disabled')).toBeUndefined()
        await theSwitch(wrapper).setValue(false)
        expect(wrapper.props('digest')).toBe(false)
        expect(wrapper.find('.dt-line').exists()).toBe(false)
        // Back on before saving restores what was saved; no new consent.
        await theSwitch(wrapper).setValue(true)
        expect(wrapper.props('recipient')).toBe(THEIRS.id)
        expect(consentBox(wrapper).exists()).toBe(false)
    })

    it('cannot be turned on for it once it is off', async () => {
        const { wrapper } = await render({
            sms: { numbers: [], recipient: THEIRS },
            saved: { sms_digest: false, sms_subscription_id: THEIRS.id },
        })
        expect(wrapper.find('.dt-muted').text()).toBe('Add and verify your mobile number in Connections to get the daily text.')
        expect(theSwitch(wrapper).exists()).toBe(false)
    })

    it('turns on only with your own number and your own consent', async () => {
        const { wrapper } = await render({
            sms: { numbers: [MINE], recipient: THEIRS },
            saved: { sms_digest: false, sms_subscription_id: THEIRS.id },
        })
        await theSwitch(wrapper).setValue(true)
        expect(wrapper.props('recipient')).toBe(MINE.id)
        expect(wrapper.findAll('#dt-number option').map((o) => o.text())).toEqual(['•••-•••-1234'])
        expect(consentBox(wrapper).exists()).toBe(true)
    })

    it('moves to your own number with your consent, and back without it', async () => {
        const { wrapper } = await render({ sms: { numbers: [MINE], recipient: THEIRS }, saved })
        expect(wrapper.findAll('#dt-number option').map((o) => o.attributes('value'))).toEqual([THEIRS.id, MINE.id])
        await wrapper.find('#dt-number').setValue(MINE.id)
        expect(consentBox(wrapper).exists()).toBe(true)
        // Their number stays on the list: choosing it again changes nothing.
        expect(wrapper.findAll('#dt-number option').map((o) => o.attributes('value'))).toEqual([THEIRS.id, MINE.id])
        await wrapper.find('#dt-number').setValue(THEIRS.id)
        expect(consentBox(wrapper).exists()).toBe(false)
    })
})

describe('DailyTextSection: the last text', () => {
    const lastText = (text) => ({ text, body: 'Cansee daily, Notion: 9 prompts, 2 engines. https://cansee.ai/r/k3v9x2qa Reply STOP to end' })
    const saved = { timezone: 'UTC', sms_digest: true, sms_subscription_id: MINE.id }
    const sms = { recipient: { ...MINE, status: 'verified', set_by_name: 'You' } }

    it.each([
        [{ status: 'sent', sent_at: '2026-11-05T08:00:05Z' }, 'Sent at 08:00'],
        [{ status: 'waiting', due_at: '2026-11-05T21:00:00Z' }, 'Waiting for quiet hours to end (21:00)'],
        [{ status: 'skipped', reason: 'opted_out' }, 'Not sent: this number texted STOP.'],
        [{ status: 'skipped', reason: 'consent_needed' }, 'Not sent: agree to the daily text again for this number.'],
        [{ status: 'skipped', reason: 'superseded' }, "Not sent: a newer run's text replaced it."],
        [{ status: 'skipped', reason: 'unavailable' }, "Not sent: text messages aren't set up on this server."],
        [{ status: 'skipped', reason: 'no_access' }, "Not sent: the number's owner can no longer open this project."],
        [{ status: 'failed' }, "Couldn't send the text."],
    ])('quotes it with %o', async (text, line) => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-11-05T15:00:00Z'))
        const { wrapper } = await render({ sms, saved, lastText: lastText(text) })
        const block = wrapper.find('.dt-last')
        expect(block.find('figcaption').text()).toBe('Last text')
        expect(block.find('blockquote').text()).toBe(lastText(text).body)
        expect(block.find('.dt-help').text()).toBe(line)
    })

    it('shows nothing without a body', async () => {
        const { wrapper } = await render({ sms, saved, lastText: null })
        expect(wrapper.find('.dt-last').exists()).toBe(false)
    })
})

describe('DailyTextSection: Send a test text', () => {
    const saved = { sms_digest: true, sms_subscription_id: MINE.id }
    const sms = { recipient: { ...MINE, status: 'verified', set_by_name: 'You' } }

    it('texts the saved number and says so', async () => {
        autopilot.testText.mockResolvedValue({ data: {} })
        const { wrapper } = await render({ sms, saved })
        const button = wrapper.find('.dt-test button')
        expect(button.text()).toBe('Send a test text')
        await button.trigger('click')
        await flushPromises()
        expect(autopilot.testText).toHaveBeenCalledWith('w1')
        expect(toast.success).toHaveBeenCalledWith('Test text sent to •••-•••-1234.')
    })

    it("shows the server's words when it cannot", async () => {
        autopilot.testText.mockRejectedValue({
            response: { status: 429, data: { error: { code: 'too_many_tests', message: 'You can send another test text in a few minutes.' } } },
        })
        const { wrapper } = await render({ sms, saved })
        await wrapper.find('.dt-test button').trigger('click')
        await flushPromises()
        expect(wrapper.find('.dt-test .dt-error').text()).toBe('You can send another test text in a few minutes.')
        expect(toast.success).not.toHaveBeenCalled()
    })

    it('is not offered before a number is saved', async () => {
        const { wrapper } = await render()
        expect(wrapper.find('.dt-test').exists()).toBe(false)
    })
})
