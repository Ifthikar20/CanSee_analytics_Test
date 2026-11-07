import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/stores/app'
import { VizChartStub, chartsById } from '@/pages/__tests__/__fixtures__/vizStub'
import { apiError, ok, sentimentPayload } from './__fixtures__/measurementPayloads'

const insights = vi.hoisted(() => ({
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  sentiment: vi.fn(),
}))
const ask = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))

vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/lib/agent/askAgent', () => ask)

const { default: SentimentPage } = await import('../SentimentPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const Shell = defineComponent({ render: () => h(TooltipProvider, null, () => h(RouterView)) })
const mounted = []

const OPTIONS = {
  kind: 'answer_analysis',
  enabled: true,
  configured: { ai: true, google: true, google_provider: 'scraperapi', google_provider_label: 'ScraperAPI', shopping: true },
  limits: { max_units: 60 },
  allowance: { unlimited: false, cap_usd: '5.00', spent_usd: '0.92', left_usd: '4.08' },
  choices: { named_answers: 52, unanalyzed: 12, engines: [], prompts: [], evidence: { facts: 14, facts_pending: 3, pages_planned: [] } },
  active_run: null,
  last_run: null,
}

async function mountPage(path = '/projects/w1/sentiment') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://notion.so' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      {
        path: '/projects/:websiteId/sentiment',
        name: 'sentiment',
        component: SentimentPage,
        props: true,
        meta: { analytics: 'sentiment' },
      },
      { path: '/projects/:websiteId/visibility', name: 'visibility', component: Blank },
      { path: '/projects/:websiteId/prompts/:promptId', name: 'prompt', component: Blank, props: true },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(Shell, {
    global: { plugins: [pinia, router], stubs: { VizChart: VizChartStub, ChatDetailModal: true } },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const stateTitles = (wrapper) => wrapper.findAll('.viz-state-title').map((t) => t.text())

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(insights)) fn.mockReset()
  ask.askAgent.mockClear()
  insights.runOptions.mockResolvedValue(ok(OPTIONS))
  insights.sentiment.mockResolvedValue(ok(sentimentPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('SentimentPage', () => {
  it('renders the header, the coverage line, the tiles, the charts and the themes', async () => {
    const { wrapper } = await mountPage()
    expect(insights.sentiment).toHaveBeenCalledWith('w1', { period: '30d' })
    expect(insights.runOptions).toHaveBeenCalledWith('w1', 'answer_analysis')
    expect(wrapper.find('h1').text()).toBe('Sentiment')
    expect(wrapper.text()).toContain('Answer engines')
    expect(wrapper.text()).toContain('How the AI engines describe you when they name you, and the themes they repeat.')
    expect(wrapper.find('.cov').text()).toContain('Themes come from 40 of 52 answers that name you.')
    expect(wrapper.find('.cov-btn').text()).toBe('Analyze 12 answers')

    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles).toHaveLength(5)
    expect(tiles[0]).toContain('Answers that name you')
    expect(tiles[0]).toContain('52')
    expect(tiles[1]).toContain('of 52 answers that name you')
    expect(tiles[4]).toContain('40 of 52')

    expect(Object.keys(chartsById(wrapper))).toEqual([
      'sentiment.tone',
      'sentiment.themes_positive',
      'sentiment.themes_negative',
      'sentiment.by_engine',
      'sentiment.by_prompt',
    ])
    const rows = wrapper.findAll('.tt-table tbody tr')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('easy to set up')
    expect(rows[0].text()).toContain('"takes minutes to set up"')
    // No earlier analysis to compare with: the state word, never 0.
    expect(rows[1].text()).toContain('Not analyzed')
    expect(wrapper.text()).toContain(
      'Tone is the label recorded with each answer that names you when it was collected. Themes are read from each answer by Claude Haiku 5.5; every quote appears word for word in the answer.',
    )
  })

  it('keeps the filters in the query and sends them to the API', async () => {
    const { wrapper, router } = await mountPage()
    const [period, engine, prompt] = wrapper.findAll('.an-filters select')
    expect(engine.findAll('option').map((o) => o.text())).toEqual(['All engines', 'ChatGPT', 'Claude'])
    await period.setValue('7d')
    await flushPromises()
    await wrapper.findAll('.an-filters select')[1].setValue('claude')
    await flushPromises()
    await prompt.setValue('p2')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ period: '7d', engine: 'claude', prompt: 'p2' })
    expect(insights.sentiment).toHaveBeenLastCalledWith('w1', { period: '7d', engine: 'claude', prompt_id: 'p2' })
  })

  it('opens the analysis dialog with the page filters', async () => {
    const { wrapper } = await mountPage('/projects/w1/sentiment?period=7d&engine=chatgpt')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    insights.estimate.mockResolvedValue(
      ok({ kind: 'answer_analysis', units: { answers: 12 }, ai: { calls_max: 24, usd_max: '0.0720' }, confirm: {}, can_run: true }),
    )
    await wrapper.findAll('button').find((b) => b.text() === 'Analyze answers').trigger('click')
    await vi.advanceTimersByTimeAsync(300)
    expect(insights.estimate).toHaveBeenCalledWith('w1', {
      kind: 'answer_analysis',
      params: { period: '7d', engines: ['chatgpt'], prompt_ids: null, reanalyze: false },
    })
    expect(document.body.textContent).toContain('Analyze AI answers')
  })

  it('says why there are no themes before any analysis, with the analyze action', async () => {
    insights.sentiment.mockResolvedValue(
      ok(sentimentPayload({ coverage: { named_answers: 52, analyzed: 0, not_analyzed: 52, failed: 0 }, themes: [] })),
    )
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toContain('No answers analyzed yet.')
    expect(wrapper.text()).toContain(
      'Cansee reads each answer that names you and lists how it describes you. You see the cost before anything runs.',
    )
    expect(wrapper.find('.viz-state button').text()).toBe('Analyze 52 answers')
    expect(wrapper.findAll('.viz-stat')[3].text()).toContain('Not analyzed')
    // Tone needs no analysis, so its chart stays.
    expect(chartsById(wrapper)['sentiment.tone']).toBeTruthy()
    expect(chartsById(wrapper)['sentiment.themes_positive']).toBeUndefined()
  })

  it('says when the analyzed answers repeat no theme', async () => {
    insights.sentiment.mockResolvedValue(ok(sentimentPayload({ themes: [] })))
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toContain("The analyzed answers don't describe you in a way that repeats.")
    expect(wrapper.find('.tt-table').exists()).toBe(false)
  })

  it('says when one tone has no theme', async () => {
    const positive = sentimentPayload().themes.filter((t) => t.tone === 'positive')
    insights.sentiment.mockResolvedValue(ok(sentimentPayload({ themes: positive })))
    const { wrapper } = await mountPage()
    const charts = chartsById(wrapper)
    expect(charts['sentiment.themes_positive'].props('empty')).toBeNull()
    expect(charts['sentiment.themes_negative'].props('empty')).toEqual({
      title: 'None of the analyzed answers describe you this way.',
    })
  })

  it('shows the no-answers state with a link to Visibility', async () => {
    insights.sentiment.mockResolvedValue(ok(sentimentPayload({ empty_reason: 'no_answers' })))
    const { wrapper } = await mountPage('/projects/w1/sentiment?period=90d')
    expect(stateTitles(wrapper)).toEqual(["The engines didn't name you in the last 30 days."])
    expect(wrapper.text()).toContain('Sentiment needs answers that name you. Visibility shows how often each engine names you.')
    expect(wrapper.find('.viz-state a').text()).toBe('Open Visibility')
    expect(wrapper.find('.viz-state a').attributes('href')).toBe('/projects/w1/visibility')
    expect(wrapper.findAll('.viz-stat')).toHaveLength(0)
  })

  it('hands a theme to the agent as a drafted message', async () => {
    const { wrapper } = await mountPage()
    await wrapper.findAll('.tt-table tbody tr')[0].find('.ask-btn').trigger('click')
    await flushPromises()
    expect(ask.askAgent).toHaveBeenCalledTimes(1)
    const [, options] = ask.askAgent.mock.calls[0]
    expect(options).toMatchObject({ websiteId: 'w1', agent: 'gap_analyst', from: 'sentiment' })
    expect(options.text).toBe(
      'AI engines describe us as "easy to set up" (positive) in 9 answers (ChatGPT and Claude). Example: "takes minutes to set up"\n' +
        'Find what drives this description and draft content that reinforces or corrects it honestly.',
    )
  })

  it('filters themes by tone', async () => {
    const { wrapper } = await mountPage()
    await wrapper.find('.tt-head select').setValue('negative')
    const rows = wrapper.findAll('.tt-table tbody tr')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('expensive for large teams')
  })

  it('opens a prompt from the heatmap', async () => {
    const { wrapper, router } = await mountPage()
    chartsById(wrapper)['sentiment.by_prompt'].vm.$emit('select', { label: 'p2' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w1/prompts/p2')
  })

  it('shows a load error with Try again, and the turned-off state', async () => {
    insights.sentiment.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toEqual(["We couldn't load sentiment."])
    insights.sentiment.mockResolvedValue(ok(sentimentPayload()))
    await wrapper.find('.viz-state button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.viz-stat')).toHaveLength(5)

    insights.sentiment.mockRejectedValue(apiError(503, 'insights_disabled', 'Insights are turned off on this server.'))
    const second = await mountPage()
    expect(stateTitles(second.wrapper)).toEqual(['Insights are turned off on this server.'])
  })
})
