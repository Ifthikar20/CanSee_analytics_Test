import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { MINE, runSummary, settingsPayload } from '@/components/settings/autopilot/__tests__/__fixtures__/autopilot'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const autopilot = vi.hoisted(() => ({
    get: vi.fn(),
    save: vi.fn(),
    estimate: vi.fn(),
    runNow: vi.fn(),
    runs: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    testText: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))
vi.mock('@/api/autopilot', () => ({ default: autopilot }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: AutopilotSettings } = await import('../AutopilotSettings.vue')
const { useAppStore } = await import('@/stores/app')

const NOTION = { id: 'w1', name: 'Notion', url: 'https://notion.so' }
const ACME = { id: 'w2', name: 'Acme', url: 'https://acme.test' }
const DESCRIPTION =
    "Cansee checks every tracked prompt of this project once a day, on its own, and can text you the results, so you don't need to log in."

const Blank = defineComponent({ render: () => h('div') })
const ShellStub = defineComponent({ name: 'SettingsShell', props: ['active'], setup: (_, { slots }) => () => h('div', slots.default?.()) })
// The dialog has its own spec; here it only has to open.
const RunNowStub = defineComponent({
    name: 'RunNowDialog',
    props: ['open', 'websiteId', 'analysis'],
    emits: ['update:open', 'started'],
    render: () => h('div', { class: 'run-now-stub' }),
})
const mounted = []

async function render({ payload = settingsPayload(), active = NOTION, get = null } = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const app = useAppStore()
    app.setWebsites([NOTION, ACME])
    app.setActiveWebsite(active)
    autopilot.get.mockImplementation(get || (() => Promise.resolve({ data: payload })))
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/settings/autopilot', name: 'settings-autopilot', component: Blank },
            { path: '/settings/connections', name: 'settings-connections', component: Blank },
            { path: '/billing', name: 'billing', component: Blank },
        ],
    })
    await router.push('/settings/autopilot')
    await router.isReady()
    const wrapper = mount(AutopilotSettings, {
        global: { plugins: [pinia, router], stubs: { SettingsShell: ShellStub, RunNowDialog: RunNowStub } },
        attachTo: document.body,
    })
    mounted.push(wrapper)
    await flushPromises()
    return { wrapper, app, router }
}

const section = (wrapper, title) => wrapper.findAll('.sc-wrap').find((s) => s.find('.sc-title').text() === title)
const saveButton = (wrapper) => section(wrapper, 'Autopilot').find('.sc-foot button')
const lines = (wrapper) => wrapper.findAll('.ap-line').map((p) => p.text())

beforeEach(() => {
    Object.values(autopilot).forEach((fn) => fn.mockReset())
    Object.values(toast).forEach((fn) => fn.mockReset())
    autopilot.run.mockResolvedValue({ data: {} })
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('AutopilotSettings: page states', () => {
    it('asks for a project first', async () => {
        const { wrapper } = await render({ active: null })
        expect(wrapper.find('.ap-muted').text()).toBe('Pick a project in the header first.')
        expect(autopilot.get).not.toHaveBeenCalled()
    })

    it('says it is loading, then offers a retry when it fails', async () => {
        const pending = await render({ get: () => new Promise(() => {}) })
        expect(pending.wrapper.find('.ap-muted').text()).toBe('Loading Autopilot...')
        pending.wrapper.unmount()
        mounted.pop()

        const { wrapper } = await render({ get: () => Promise.reject(new Error('500')) })
        expect(wrapper.find('.ap-muted').text()).toBe("We couldn't load Autopilot.")
        autopilot.get.mockResolvedValue({ data: settingsPayload() })
        await wrapper.find('.ap-failed button').trigger('click')
        await flushPromises()
        expect(section(wrapper, 'Autopilot').find('.sc-desc').text()).toBe(DESCRIPTION)
    })

    it('shows the plan copy to a plan without Autopilot', async () => {
        const { wrapper, router } = await render({
            payload: settingsPayload({ plan: { id: 'free', name: 'Free', autopilot: false, sms_digest: false } }),
        })
        expect(wrapper.find('.ap-muted').text()).toBe('Autopilot is part of the 100 and 200 prompt plans.')
        const link = wrapper.find('.ap-failed a')
        expect(link.text()).toBe('See plans')
        await link.trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.name).toBe('billing')
        expect(section(wrapper, 'Daily text')).toBeUndefined()
        expect(section(wrapper, 'Runs')).toBeUndefined()
    })

    it('says when Autopilot is off on the server', async () => {
        const { wrapper } = await render({ payload: settingsPayload({ available: false }) })
        expect(wrapper.find('.ap-muted').text()).toBe('Autopilot is turned off on this server.')
        expect(wrapper.find('form').exists()).toBe(false)
    })

    it('says Autopilot paused after failed runs', async () => {
        const { wrapper } = await render({ payload: settingsPayload({ settings: { paused_reason: 'failures' } }) })
        expect(wrapper.find('.ap-notice').text()).toBe(
            'Autopilot paused after 3 failed runs. Check the last run below, then turn it back on.',
        )
        expect((await render()).wrapper.find('.ap-notice').exists()).toBe(false)
    })
})

describe('AutopilotSettings: the Autopilot section', () => {
    it('lays out the controls with their words', async () => {
        const { wrapper } = await render()
        const s = section(wrapper, 'Autopilot')
        expect(s.find('.sc-label').text()).toBe('Project')
        expect(s.find('.sc-desc').text()).toBe(DESCRIPTION)
        expect(s.find('label[for="ap-enabled"]').text()).toBe('Run Autopilot every day')
        expect(s.find('#ap-enabled').attributes('role')).toBe('switch')
        expect(s.find('label[for="ap-run-time"]').text()).toBe('Start at')
        expect(s.find('#ap-run-time').element.value).toBe('07:00')
        expect(s.findAll('#ap-run-time option')).toHaveLength(96)
        expect(s.find('label[for="ap-timezone"]').text()).toBe('in')
        expect(s.find('#ap-timezone').element.value).toBe('UTC')
        expect(s.find('#ap-time-help').text()).toBe('Runs once a day at about this time. A run takes a few minutes.')
        expect(s.find('legend').text()).toBe('What runs')
        expect(s.find('label[for="ap-engines"]').text()).toBe('Ask the AI engines (ChatGPT and Claude)')
        expect(s.find('#ap-engines-help').text()).toBe('Asks each tracked prompt once per engine, the way a buyer would.')
        expect(s.find('label[for="ap-google"]').text()).toBe('Check Google page one')
        expect(s.findAll('.ap-cadence option').map((o) => o.text())).toEqual(['Every day', 'Once a week'])
        expect(s.find('#ap-google-help').text()).toBe('Uses 1 Google results page per prompt (25 ScraperAPI credits).')
        expect(s.find('label[for="ap-analysis"]').text()).toBe('Analyze new answers that name you')
        expect(s.find('#ap-analysis-help').text()).toBe('Reads the claims and tone of new answers (Fact check and Sentiment).')
        expect(saveButton(wrapper).text()).toBe('Save changes')
        expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
    })

    it('reads the plan and the cost of the last run', async () => {
        const { wrapper } = await render()
        expect(lines(wrapper)).toEqual([
            'Your plan covers 100 tracked prompts; this account tracks 9.',
            'Last run: 200 answers, $1.27 of AI, 100 Google pages (2,500 ScraperAPI credits).',
            'At this rate a month of daily runs costs about $38.10 of AI. Your plan includes $52.00.',
            'Autopilot stops for the month when 90% of your AI allowance is used, so the rest stays free for your own questions.',
        ])
    })

    it('gives the bound before the first run, and the over-the-plan line', async () => {
        const { wrapper } = await render({
            payload: settingsPayload({
                tracked: { limit: 100, used: 140, over_limit: 40 },
                cost: { last_run: null, month_projection_usd: null },
            }),
        })
        expect(lines(wrapper)).toEqual([
            'This account tracks 140 prompts and your plan covers 100. Autopilot checks the 100 oldest.',
            'The first run measures the real cost. Each run costs at most $6.00 of AI and 100 Google pages.',
            'Autopilot stops for the month when 90% of your AI allowance is used, so the rest stays free for your own questions.',
        ])
    })

    it('leaves credits out of the Google line when the server has none', async () => {
        const { wrapper } = await render({ payload: settingsPayload({ google: { credits_per_page: null } }) })
        expect(wrapper.find('#ap-google-help').text()).toBe('Uses 1 Google results page per prompt.')
    })

    it("starts a project without saved settings on the browser's zone", async () => {
        vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Asia/Kolkata' })
        const { wrapper } = await render({ payload: settingsPayload({ saved: false }) })
        expect(wrapper.find('#ap-timezone').element.value).toBe('Asia/Kolkata')
        // Offered, not changed: nothing to save yet.
        expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
        await wrapper.find('#ap-enabled').setValue(true)
        autopilot.save.mockResolvedValue({ data: settingsPayload({ settings: { enabled: true, timezone: 'Asia/Kolkata' } }) })
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(autopilot.save.mock.calls[0][1].timezone).toBe('Asia/Kolkata')
    })

    it('saves the settings and says so', async () => {
        const { wrapper } = await render()
        await wrapper.find('#ap-enabled').setValue(true)
        await wrapper.find('#ap-run-time').setValue('06:45')
        await wrapper.find('.ap-cadence').setValue('weekly')
        expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
        const saved = settingsPayload({ settings: { enabled: true, run_time: '06:45', google_cadence: 'weekly' } })
        autopilot.save.mockResolvedValue({ data: saved })
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(autopilot.save).toHaveBeenCalledWith('w1', {
            enabled: true,
            run_time: '06:45',
            timezone: 'UTC',
            run_engines: true,
            run_google: true,
            google_cadence: 'weekly',
            run_analysis: true,
            sms_digest: false,
            sms_subscription_id: null,
            quiet_start: '21:00',
            quiet_end: '08:00',
            sms_consent: false,
        })
        expect(toast.success).toHaveBeenCalledWith('Autopilot settings saved.')
        expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
    })

    it("puts the server's words under the field it names", async () => {
        const { wrapper } = await render()
        await wrapper.find('#ap-run-time').setValue('06:45')
        autopilot.save.mockRejectedValue({
            response: {
                status: 400,
                data: { error: { code: 'invalid', message: 'x', details: { field: 'run_time', message: 'Choose a time on the quarter hour, like 07:00.' } } },
            },
        })
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(wrapper.find('.ap-error').text()).toBe('Choose a time on the quarter hour, like 07:00.')
        // The next change takes the words away.
        await wrapper.find('#ap-run-time').setValue('07:15')
        await nextTick()
        expect(wrapper.find('.ap-error').exists()).toBe(false)
    })

    it('asks for something to run before turning on', async () => {
        const { wrapper } = await render()
        await wrapper.find('#ap-enabled').setValue(true)
        await wrapper.find('#ap-engines').setValue(false)
        await wrapper.find('#ap-google').setValue(false)
        await wrapper.find('#ap-analysis').setValue(false)
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(autopilot.save).not.toHaveBeenCalled()
        expect(wrapper.find('#ap-enabled-error').text()).toBe('Choose at least one thing for Autopilot to run.')
    })

    it('shows the plan copy when the server says the plan has no Autopilot', async () => {
        const { wrapper } = await render()
        await wrapper.find('#ap-enabled').setValue(true)
        autopilot.save.mockRejectedValue({
            response: { status: 403, data: { error: { code: 'plan_required', message: 'Autopilot is part of the 100 and 200 prompt plans.' } } },
        })
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(wrapper.find('.ap-muted').text()).toBe('Autopilot is part of the 100 and 200 prompt plans.')
        expect(wrapper.find('form').exists()).toBe(false)
    })
})

describe('AutopilotSettings: the daily text', () => {
    it('needs the agreement before it saves the text, then sends it', async () => {
        const { wrapper } = await render()
        const text = section(wrapper, 'Daily text')
        await text.find('#dt-digest').setValue(true)
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(autopilot.save).not.toHaveBeenCalled()
        expect(text.find('#dt-consent-error').text()).toBe('Agree to the text message terms to turn on the daily text.')

        await text.find('.dt-agree input').setValue(true)
        autopilot.save.mockResolvedValue({
            data: settingsPayload({
                settings: { sms_digest: true, sms_subscription_id: MINE.id },
                sms: { recipient: { ...MINE, status: 'verified', set_by_name: 'You' } },
            }),
        })
        await text.find('.sc-foot button').trigger('click')
        await flushPromises()
        expect(autopilot.save.mock.calls[0][1]).toMatchObject({ sms_digest: true, sms_subscription_id: MINE.id, sms_consent: true })
        expect(toast.success).toHaveBeenCalledWith('Autopilot settings saved.')
        expect(section(wrapper, 'Daily text').find('.dt-consent').exists()).toBe(false)
    })

    it('says when texts are not set up on the server', async () => {
        const { wrapper } = await render()
        await section(wrapper, 'Daily text').find('#dt-digest').setValue(true)
        await section(wrapper, 'Daily text').find('.dt-agree input').setValue(true)
        autopilot.save.mockRejectedValue({
            response: { status: 503, data: { error: { code: 'sms_unavailable', message: "Text messaging isn't configured on this deployment." } } },
        })
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(wrapper.find('#dt-digest-error').text()).toBe("Text messaging isn't configured on this deployment.")
    })

    it('lets the owner agree again when the last text waited for it', async () => {
        const held = runSummary({ text: { status: 'skipped', reason: 'consent_needed', due_at: null, sent_at: null } })
        const payload = settingsPayload({
            settings: { sms_digest: true, sms_subscription_id: MINE.id },
            sms: { recipient: { ...MINE, status: 'verified', set_by_name: 'You' } },
            runs: [held],
        })
        const { wrapper } = await render({ payload })
        const text = () => section(wrapper, 'Daily text')
        expect(text().find('.dt-consent').exists()).toBe(true)
        expect(saveButton(wrapper).attributes('disabled')).toBeDefined()

        await text().find('.dt-agree input').setValue(true)
        expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
        autopilot.save.mockResolvedValue({ data: payload })
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(autopilot.save.mock.calls[0][1]).toMatchObject({ sms_digest: true, sms_subscription_id: MINE.id, sms_consent: true })
        // Agreed: the box goes, though the held text stays the latest until the next run.
        expect(text().find('.dt-consent').exists()).toBe(false)
    })

    it('saves other changes without the agreement asked again', async () => {
        const held = runSummary({ text: { status: 'skipped', reason: 'consent_needed', due_at: null, sent_at: null } })
        const { wrapper } = await render({
            payload: settingsPayload({
                settings: { sms_digest: true, sms_subscription_id: MINE.id },
                sms: { recipient: { ...MINE, status: 'verified', set_by_name: 'You' } },
                runs: [held],
            }),
        })
        await wrapper.find('#ap-run-time').setValue('06:00')
        autopilot.save.mockResolvedValue({ data: settingsPayload() })
        await saveButton(wrapper).trigger('click')
        await flushPromises()
        expect(autopilot.save.mock.calls[0][1]).toMatchObject({ run_time: '06:00', sms_consent: false })
    })

    it("quotes the latest run's text", async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-11-05T15:00:00Z'))
        const older = runSummary({ id: 'run-0', local_date: '2026-11-03' })
        const latest = runSummary({ id: 'run-1', local_date: '2026-11-05', text: { status: 'sent', sent_at: '2026-11-05T08:00:05Z' } })
        const body = 'Cansee daily, Notion: 9 prompts, 2 engines. Named in 15/18 answers (83%), up 6 pts.'
        autopilot.run.mockResolvedValue({ data: { ...latest, text_body: body, prompts: [] } })
        const { wrapper } = await render({
            payload: settingsPayload({
                settings: { sms_digest: true, sms_subscription_id: MINE.id },
                sms: { recipient: { ...MINE, status: 'verified', set_by_name: 'You' } },
                runs: [older, latest],
            }),
        })
        expect(autopilot.run).toHaveBeenCalledWith('w1', 'run-1')
        expect(wrapper.find('.dt-quote').text()).toBe(body)
        expect(wrapper.find('.dt-last .dt-help').text()).toBe('Sent at 08:00')
    })

    it("previews the latest run's text when texts are off on the server", async () => {
        const latest = runSummary({ id: 'run-2', text: { status: 'not_requested', due_at: null, sent_at: null } })
        const body = 'Cansee daily, Notion, first run: 9 prompts, 2 engines. Named in 13/18 answers (72%). Reply STOP to end'
        autopilot.run.mockResolvedValue({ data: { ...latest, text_body: body, prompts: [] } })
        const { wrapper } = await render({ payload: settingsPayload({ sms: { available: false }, runs: [latest] }) })
        expect(autopilot.run).toHaveBeenCalledWith('w1', 'run-2')
        expect(wrapper.find('.dt-last .dt-label').text()).toBe("The last run's text (not sent)")
        expect(wrapper.find('.dt-quote').text()).toBe(body)
    })

    it('reads no text for a run that did not ask for one while texts are set up', async () => {
        const latest = runSummary({ text: { status: 'not_requested', due_at: null, sent_at: null } })
        const { wrapper } = await render({ payload: settingsPayload({ runs: [latest] }) })
        expect(autopilot.run).not.toHaveBeenCalled()
        expect(wrapper.find('.dt-quote').exists()).toBe(false)
    })
})

describe('AutopilotSettings: runs', () => {
    it('lists the runs, newest first', async () => {
        const { wrapper } = await render({
            payload: settingsPayload({
                runs: [runSummary({ id: 'a', local_date: '2026-11-03' }), runSummary({ id: 'b', local_date: '2026-11-04' })],
            }),
        })
        expect(wrapper.findAll('tbody tr').map((r) => r.find('td').text())).toEqual(['Nov 4', 'Nov 3'])
    })

    it('opens Run now and reads the payload again once a run starts', async () => {
        const { wrapper } = await render()
        await section(wrapper, 'Runs').find('.art-head button').trigger('click')
        const dialog = wrapper.findComponent(RunNowStub)
        expect(dialog.props('open')).toBe(true)
        expect(dialog.props('websiteId')).toBe('w1')
        expect(dialog.props('analysis')).toBe(true)
        dialog.vm.$emit('started', runSummary({ status: 'queued' }))
        await flushPromises()
        expect(autopilot.get).toHaveBeenCalledTimes(2)
    })

    it('follows an active run until it finishes, then stops reading', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const running = settingsPayload({ runs: [runSummary({ status: 'running', text: { status: 'not_requested' } })] })
        const done = settingsPayload({ runs: [runSummary({ status: 'done' })] })
        const { wrapper } = await render({ payload: running })
        expect(wrapper.find('.art-status span').text()).toBe('Running')

        autopilot.get.mockResolvedValue({ data: done })
        await vi.advanceTimersByTimeAsync(5000)
        await flushPromises()
        expect(autopilot.get).toHaveBeenCalledTimes(2)
        expect(wrapper.find('.art-status span').text()).toBe('Done')

        await vi.advanceTimersByTimeAsync(20000)
        await flushPromises()
        expect(autopilot.get).toHaveBeenCalledTimes(2)
    })

    it('keeps unsaved changes while it follows a run', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const running = settingsPayload({ runs: [runSummary({ status: 'running', text: { status: 'not_requested' } })] })
        const { wrapper } = await render({ payload: running })
        await wrapper.find('#ap-run-time').setValue('09:30')
        await vi.advanceTimersByTimeAsync(5000)
        await flushPromises()
        expect(wrapper.find('#ap-run-time').element.value).toBe('09:30')
    })

    it('stops a running run', async () => {
        const run = runSummary({ id: 'run-9', status: 'running', text: { status: 'not_requested' } })
        const { wrapper } = await render({ payload: settingsPayload({ runs: [run] }) })
        autopilot.cancel.mockResolvedValue({ data: {} })
        await wrapper.find('.art-stop').trigger('click')
        await flushPromises()
        expect(autopilot.cancel).toHaveBeenCalledWith('w1', 'run-9')
        expect(autopilot.get).toHaveBeenCalledTimes(2)
    })

    it('reads the other project when the header switches', async () => {
        const { app } = await render()
        autopilot.get.mockResolvedValue({ data: settingsPayload() })
        app.setActiveWebsite(ACME)
        await flushPromises()
        expect(autopilot.get).toHaveBeenLastCalledWith('w2')
    })
})
