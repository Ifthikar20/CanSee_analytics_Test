import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const visibility = vi.hoisted(() => ({ dashboard: vi.fn() }))
const countries = vi.hoisted(() => ({ matrix: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
const insights = vi.hoisted(() => ({
    fanOuts: vi.fn(),
    runOptions: vi.fn(),
    estimate: vi.fn(),
    startRun: vi.fn(),
    getRun: vi.fn(),
    cancelRun: vi.fn(),
}))
const ask = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))

vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))
vi.mock('@/api/visibility', () => ({ default: visibility }))
vi.mock('@/api/countries', () => ({ default: countries }))
vi.mock('@/api/searchGap', () => ({ default: { checkGoogle: vi.fn() } }))
vi.mock('@/api/promptLibrary', () => ({ default: { setArchived: vi.fn() } }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/lib/agent/askAgent', () => ask)

import PromptPage from '@/pages/PromptPage.vue'
import promptLibrary from '@/api/promptLibrary'
import { BOARD_CONTEXT } from '@/lib/board/context'
import { VizChartStub, chartsById } from './__fixtures__/vizStub'
import { PROMPT_ID, WEBSITE_ID, countryMatrix, dashboardPayload, promptDetail } from './__fixtures__/polish'
import { fanOutsPayload } from '@/pages/analytics/__tests__/__fixtures__/measurementPayloads'

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })
const board = {
    websiteId: computed(() => WEBSITE_ID),
    open: vi.fn(),
    close: vi.fn(),
    invalidate: vi.fn(),
    revalidate: vi.fn(),
}

const HISTORY = [
    { checked_at: '2026-10-08T09:00:00Z', position: 7, depth: 100, page: 1, location: 'gb', error: '' },
    { checked_at: '2026-10-09T09:00:00Z', position: 2, depth: 100, page: 1, location: 'us', error: '' },
    { checked_at: '2026-10-20T09:00:00Z', position: null, depth: 100, page: null, location: 'gb', error: '' },
]

function historyPayload(overrides = {}) {
    return dashboardPayload({ filters: { engine: null, prompt_id: PROMPT_ID }, google_history: HISTORY, ...overrides })
}

function promptFanouts(overrides = {}) {
    const payload = fanOutsPayload({ filters: { engine: null, prompt_id: PROMPT_ID }, ...overrides })
    payload.prompts = payload.prompts.slice(0, 1).map((p) => ({ ...p, prompt_id: PROMPT_ID }))
    return payload
}

async function mountPage({
    detail = promptDetail(),
    history = historyPayload(),
    matrix = countryMatrix(),
    fanouts = promptFanouts(),
} = {}) {
    setActivePinia(createPinia())
    if (fanouts instanceof Error) insights.fanOuts.mockRejectedValue(fanouts)
    else insights.fanOuts.mockResolvedValue({ data: fanouts })
    insights.runOptions.mockResolvedValue({
        data: { kind: 'fanout_google', enabled: true, configured: { google: true }, limits: { max_units: 10 }, choices: {} },
    })
    client.get.mockImplementation((url) => {
        if (url !== `/search-gap/websites/${WEBSITE_ID}/prompts/${PROMPT_ID}/`) return Promise.reject(new Error(`unexpected GET ${url}`))
        return detail instanceof Error ? Promise.reject(detail) : Promise.resolve({ data: detail })
    })
    if (history instanceof Error) visibility.dashboard.mockRejectedValue(history)
    else visibility.dashboard.mockResolvedValue({ data: history })
    if (matrix instanceof Error) countries.matrix.mockRejectedValue(matrix)
    else countries.matrix.mockResolvedValue({ data: matrix })
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/dashboard', name: 'dashboard', component: Blank },
            { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
            { path: '/settings/connections', name: 'settings-connections', component: Blank },
        ],
    })
    await router.push(`/projects/${WEBSITE_ID}/analytics?widget=prompts&prompt=${PROMPT_ID}`)
    await router.isReady()
    const wrapper = mount(PromptPage, {
        props: { websiteId: WEBSITE_ID, promptId: PROMPT_ID },
        global: {
            plugins: [router],
            provide: { [BOARD_CONTEXT]: board },
            stubs: {
                VizChart: VizChartStub,
                PromptSecurityFindings: true,
                PromptScheduleModal: true,
                ChatDetailModal: true,
            },
        },
        attachTo: document.body,
    })
    await flushPromises()
    return { wrapper, router }
}

const CHECK_LINK = `/projects/${WEBSITE_ID}/analytics?prompt=${PROMPT_ID}&check=1&widget=countries`
const ALL_PROMPTS = `/projects/${WEBSITE_ID}/analytics?widget=prompts`

beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset())
    visibility.dashboard.mockReset()
    countries.matrix.mockReset()
    Object.values(insights).forEach((fn) => fn.mockReset())
    ask.askAgent.mockClear()
    board.invalidate.mockClear()
    promptLibrary.setArchived.mockReset()
})

describe('PromptPage: in the Prompts panel', () => {
    it('goes back to All prompts and names the prompt in a plain block', async () => {
        const { wrapper } = await mountPage()
        const back = wrapper.find('.pp-back')
        expect(back.text()).toBe('All prompts')
        expect(back.attributes('href')).toBe(ALL_PROMPTS)
        // The panel's own title is the h2 above; the prompt is a section heading.
        expect(wrapper.find('h1').exists()).toBe(false)
        expect(wrapper.find('h2.pp-title').text()).toBe('best note taking app for teams')
        expect(wrapper.find('.pp-eyebrow').exists()).toBe(false)
        expect(wrapper.find('.gcard').exists()).toBe(false)
        expect(wrapper.find('.pp-verdict').text()).toContain('ChatGPT lists you #2. Google has you at #4 (page 1).')
        expect(wrapper.find('.pp-verdict .gap-badge').text()).toBe('Even -10')
    })

    it('links a prompt that is gone back to All prompts', async () => {
        const gone = new Error('gone')
        gone.response = { status: 404 }
        const { wrapper } = await mountPage({ detail: gone })
        const missing = wrapper.find('.pp-missing')
        expect(missing.text()).toContain("This prompt isn't tracked in this project any more.")
        expect(missing.find('a').text()).toBe('All prompts')
        expect(missing.find('a').attributes('href')).toBe(ALL_PROMPTS)
    })

    it('returns to the list after archiving and refetches the overview', async () => {
        const { wrapper, router } = await mountPage()
        promptLibrary.setArchived.mockResolvedValue({})
        await wrapper.findAll('button').find((b) => b.text() === 'Archive').trigger('click')
        await flushPromises()
        expect(promptLibrary.setArchived).toHaveBeenCalledWith('bp-1', true)
        expect(board.invalidate).toHaveBeenCalledWith('overview')
        expect(router.currentRoute.value.fullPath).toBe(ALL_PROMPTS)
    })
})

describe('PromptPage: how Google searches this prompt', () => {
    it('shows the method as a chip instead of the country', async () => {
        const { wrapper } = await mountPage()
        const meta = wrapper.find('.pp-meta')
        expect(meta.find('.mchip').text()).toBe('Google set to GB, US connection')
        expect(meta.text()).not.toContain('Searched from')
        expect(meta.text()).toContain('· Google checked')
    })

    it('keeps Global for a Global prompt on Google\'s default', async () => {
        const detail = promptDetail(
            { prompt: { ...promptDetail().prompt, location: '' } },
            { method: { method: 'default', label: 'Searched from US (default)' } }
        )
        const { wrapper } = await mountPage({ detail })
        const meta = wrapper.find('.pp-meta')
        expect(meta.find('.mchip').exists()).toBe(false)
        expect(meta.text()).toContain('Global')
    })

    it('falls back to the country when Google is not configured', async () => {
        const { wrapper } = await mountPage({ detail: promptDetail({ serp_configured: false }, { method: null }) })
        const meta = wrapper.find('.pp-meta')
        expect(meta.find('.mchip').exists()).toBe(false)
        expect(meta.text()).toContain('Searched from GB')
    })
})

describe('PromptPage: history', () => {
    it('draws the Google position from this prompt\'s location and the engines\' visibility', async () => {
        const { wrapper } = await mountPage()
        expect(visibility.dashboard).toHaveBeenCalledWith(WEBSITE_ID, { period: '30d', prompt_id: PROMPT_ID })
        expect(wrapper.find('#pp-history-title').text()).toBe('History')
        expect(wrapper.text()).toContain('How this prompt has moved.')

        const charts = chartsById(wrapper)
        const google = charts['prompt.google'].props('spec')
        expect(google).toMatchObject({ title: 'Google position', x: 'time', value: 'rank', representations: ['line', 'table'] })
        expect(google.labels).toEqual(['2026-10-08T09:00:00Z', '2026-10-20T09:00:00Z'])
        expect(google.datasets[0].data).toEqual([7, null])
        expect(google.datasets[0].states).toEqual([null, 'not_found'])
        expect(google.state_labels.not_found).toBe('Not in top 100')

        const engines = charts['prompt.engines'].props('spec')
        expect(engines).toMatchObject({ title: 'AI visibility', x: 'time', value: 'percent' })
        expect(charts['prompt.engines'].props('empty')).toBeNull()
    })

    it('offers 30 and 90 days and reloads for the period chosen', async () => {
        const { wrapper } = await mountPage()
        const select = wrapper.find('.pp-section-head.is-row select')
        expect(select.findAll('option').map((o) => o.text())).toEqual(['Last 30 days', 'Last 90 days'])
        await select.setValue('90d')
        await flushPromises()
        expect(visibility.dashboard).toHaveBeenLastCalledWith(WEBSITE_ID, { period: '90d', prompt_id: PROMPT_ID })
    })

    it('says when there are no Google checks or AI answers in the period', async () => {
        const { wrapper } = await mountPage({ history: historyPayload({ google_history: [], has_data: false, empty_reason: 'no_answers' }) })
        const charts = chartsById(wrapper)
        expect(charts['prompt.google'].props('empty')).toEqual({ title: 'No Google checks in this period.', body: 'Use Check now to record one.' })
        expect(charts['prompt.engines'].props('empty')).toEqual({ title: 'No AI answers for this prompt in this period.' })
    })

    it('shows a failed history inline with Try again', async () => {
        const { wrapper } = await mountPage({ history: new Error('boom') })
        const google = chartsById(wrapper)['prompt.google']
        expect(google.props('error')).toBe("We couldn't load the history.")
        visibility.dashboard.mockResolvedValueOnce({ data: historyPayload() })
        await google.find('.viz-stub-retry').trigger('click')
        await flushPromises()
        expect(chartsById(wrapper)['prompt.google'].props('error')).toBe('')
        expect(chartsById(wrapper)['prompt.google'].props('spec').labels).toHaveLength(2)
    })
})

describe('PromptPage: by country', () => {
    // Each cell's lines (the value, then the method under Google).
    const rows = (wrapper) =>
        wrapper.findAll('.pp-ct tbody tr').map((tr) =>
            tr.findAll('th, td').map((c) => {
                const lines = c.findAll('.pp-ct-value, .pp-ct-note, .gap-badge').map((l) => l.text().trim())
                return lines.length ? lines.join(' / ') : c.text().trim()
            })
        )

    it('lists the latest check in each country with the method and the gap', async () => {
        const { wrapper } = await mountPage()
        expect(countries.matrix).toHaveBeenCalledWith(WEBSITE_ID, { prompt_id: PROMPT_ID })
        expect(wrapper.text()).toContain('The latest check of this prompt in each country.')
        expect(wrapper.findAll('.pp-ct thead th').map((th) => th.text())).toEqual(['Country', 'Google', 'ChatGPT', 'Claude', 'Gap'])
        expect(rows(wrapper)).toEqual([
            ['Germany', 'Not in top 10 / Google set to DE, US connection', 'Not checked', 'Failed', 'Not definite'],
            ['United Kingdom', '#4 / Google set to GB, US connection', 'Named #2', 'Not checked', 'Google ahead'],
        ])
        const link = wrapper.findAll('a').find((a) => a.text() === 'Check countries')
        expect(link.attributes('href')).toBe(CHECK_LINK)
    })

    it('says when the prompt has not been checked in other countries', async () => {
        const { wrapper } = await mountPage({ matrix: countryMatrix({ cells: [], gaps: [] }) })
        expect(wrapper.find('.pp-ct').exists()).toBe(false)
        expect(wrapper.text()).toContain("This prompt hasn't been checked in other countries.")
        const links = wrapper.findAll('a').filter((a) => a.text() === 'Check countries')
        expect(links).toHaveLength(1)
        expect(links[0].attributes('href')).toBe(CHECK_LINK)
    })

    it('shows a failed load with Try again', async () => {
        const { wrapper } = await mountPage({ matrix: new Error('boom') })
        expect(wrapper.text()).toContain("We couldn't load country results.")
        countries.matrix.mockResolvedValueOnce({ data: countryMatrix() })
        await wrapper.findAll('button').find((b) => b.text() === 'Try again').trigger('click')
        await flushPromises()
        expect(rows(wrapper)).toHaveLength(2)
    })
})

describe('PromptPage: what the engines searched', () => {
    const section = (wrapper) => wrapper.find('[aria-labelledby="pp-fanouts-title"]')

    it('lists the searches the engines ran for this prompt, with Google next to each', async () => {
        const { wrapper } = await mountPage()
        expect(insights.fanOuts).toHaveBeenCalledWith(WEBSITE_ID, { period: '30d', prompt_id: PROMPT_ID })
        const fanouts = section(wrapper)
        expect(fanouts.find('h2').text()).toBe('What the engines searched')
        expect(fanouts.text()).toContain('The web searches the engines ran while answering this prompt.')
        expect(fanouts.text()).toContain('4 of 6 answers searched')
        // The card is on the prompt's own page, so its title is not a link.
        expect(fanouts.find('.fpc-title a').exists()).toBe(false)
        const rows = fanouts.findAll('.fpc-table tbody tr').map((r) => r.text())
        expect(rows).toHaveLength(3)
        expect(rows[0]).toContain('best note apps 2026')
        expect(rows[0]).toContain('#4')
        expect(rows[1]).toContain('Not on page one')
        expect(rows[2]).toContain('Not checked')
        // 61 searches, 58 texts: three searches sent no text.
        expect(fanouts.text()).toContain("3 searches didn't report their text.")
    })

    it('opens the Google check for the searches picked', async () => {
        const { wrapper } = await mountPage()
        const boxes = section(wrapper).findAll('.fpc-table input[type="checkbox"]')
        await boxes[0].setValue(true)
        await boxes[2].setValue(true)
        const button = section(wrapper).findAll('button').find((b) => b.text() === 'Check 2 on Google')
        insights.estimate.mockResolvedValue({ data: { kind: 'fanout_google', google: { pages_max: 2 }, can_run: true, confirm: {} } })
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            await button.trigger('click')
            await vi.advanceTimersByTimeAsync(300)
            expect(insights.estimate).toHaveBeenCalledWith(WEBSITE_ID, {
                kind: 'fanout_google',
                params: {
                    queries: [
                        { prompt_id: PROMPT_ID, text: 'best note apps 2026' },
                        { prompt_id: PROMPT_ID, text: 'notion pricing for teams' },
                    ],
                },
            })
        } finally {
            vi.useRealTimers()
        }
    })

    it('hands one search to the agent', async () => {
        const { wrapper } = await mountPage()
        await section(wrapper).find('.fpc-table tbody tr .ask-btn').trigger('click')
        await flushPromises()
        const [, options] = ask.askAgent.mock.calls[0]
        expect(options.agent).toBe('aeo_article')
        expect(options.text).toBe(
            'While answering "best note taking app for teams", ChatGPT searched the web for "best note apps 2026".\n' +
                'On Google we are #4 for that search.\n' +
                'Draft a page that answers that search.',
        )
    })

    it('says when the engines answered without searching', async () => {
        const payload = promptFanouts({ totals: { answers: 3, recorded: 3, searched: 0, searches: 0, queries: 0, unique_queries: 0 } })
        payload.prompts[0] = { ...payload.prompts[0], searched: 0, queries: [] }
        const { wrapper } = await mountPage({ fanouts: payload })
        expect(section(wrapper).text()).toContain('The engines answered this prompt without searching the web.')
    })

    it.each([
        ['web_search_off', "The engines aren't searching the web on this server."],
        ['none_recorded', 'No searches recorded yet.'],
        ['no_answers', 'No AI answers in the last 30 days.'],
    ])('shows the %s state', async (reason, title) => {
        const { wrapper } = await mountPage({ fanouts: promptFanouts({ empty_reason: reason }) })
        expect(section(wrapper).find('.viz-state-title').text()).toBe(title)
        expect(section(wrapper).find('.fpc').exists()).toBe(false)
    })

    it('shows a failed load with Try again', async () => {
        const { wrapper } = await mountPage({ fanouts: new Error('boom') })
        expect(section(wrapper).find('.viz-state-title').text()).toBe("We couldn't load query fan-outs.")
        insights.fanOuts.mockResolvedValue({ data: promptFanouts() })
        await section(wrapper).find('.viz-state button').trigger('click')
        await flushPromises()
        expect(section(wrapper).find('.fpc').exists()).toBe(true)
    })
})
