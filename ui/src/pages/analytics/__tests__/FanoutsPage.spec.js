import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { VizChartStub, chartsById } from '@/pages/__tests__/__fixtures__/vizStub'
import { apiError, fanOutsPayload, insightRun, ok } from './__fixtures__/measurementPayloads'

const insights = vi.hoisted(() => ({
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  fanOuts: vi.fn(),
}))
const ask = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))

vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/lib/agent/askAgent', () => ask)

const { default: FanoutsPage } = await import('../FanoutsPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

const OPTIONS = {
  kind: 'fanout_google',
  enabled: true,
  configured: { ai: true, google: true, google_provider: 'scraperapi', google_provider_label: 'ScraperAPI', shopping: true },
  limits: { max_units: 10 },
  choices: {},
  active_run: null,
  last_run: null,
}

async function mountPage(path = '/projects/w1/fan-outs') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://notion.so' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
      {
        path: '/projects/:websiteId/fan-outs',
        name: 'fan-outs',
        component: FanoutsPage,
        props: true,
        meta: { analytics: 'fan-outs' },
      },
      { path: '/projects/:websiteId/prompts/:promptId', name: 'prompt', component: Blank, props: true },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, {
    global: { plugins: [pinia, router], stubs: { VizChart: VizChartStub } },
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
  insights.fanOuts.mockResolvedValue(ok(fanOutsPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('FanoutsPage', () => {
  it('renders the tiles, the engines chart and a card per prompt', async () => {
    const { wrapper } = await mountPage()
    expect(insights.fanOuts).toHaveBeenCalledWith('w1', { period: '30d' })
    expect(insights.runOptions).toHaveBeenCalledWith('w1', 'fanout_google')
    expect(wrapper.find('h1').text()).toBe('Query fan-outs')
    expect(wrapper.text()).toContain(
      'The web searches the engines ran while answering your prompts, and where you rank on Google for them.',
    )
    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles).toEqual(['Answers that searched22 of 30', 'Searches run61', 'Search texts reported58', 'Unique searches45'])
    expect(chartsById(wrapper)['fanouts.engines'].props('spec').labels).toEqual(['chatgpt', 'claude'])

    const cards = wrapper.findAll('.fpc')
    expect(cards).toHaveLength(2)
    expect(cards[0].find('.fpc-title a').text()).toBe('best note taking app for teams')
    expect(cards[0].find('.fpc-title a').attributes('href')).toBe('/projects/w1/prompts/p1')
    expect(cards[0].text()).toContain('4 of 6 answers searched')
    expect(cards[1].text()).toContain('The engines answered this prompt without searching the web.')
    // Across several prompts the unreported searches are counted once, for the page.
    expect(wrapper.find('.an-note').text()).toBe("3 searches didn't report their text.")
  })

  it('offers only the engines that report searches and keeps filters in the query', async () => {
    const { wrapper, router } = await mountPage()
    const [period, engine, prompt] = wrapper.findAll('.an-filters select')
    expect(engine.findAll('option').map((o) => o.text())).toEqual(['All engines', 'ChatGPT', 'Claude'])
    expect(prompt.findAll('option').map((o) => o.text())).toEqual([
      'All prompts',
      'best note taking app for teams',
      'notion alternatives for small startups',
    ])
    await period.setValue('7d')
    await flushPromises()
    insights.fanOuts.mockResolvedValue(
      ok(fanOutsPayload({ filters: { engine: null, prompt_id: 'p1' }, prompts: fanOutsPayload().prompts.slice(0, 1) })),
    )
    await wrapper.findAll('.an-filters select')[2].setValue('p1')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ period: '7d', prompt: 'p1' })
    expect(insights.fanOuts).toHaveBeenLastCalledWith('w1', { period: '7d', prompt_id: 'p1' })
    // The other prompts stay offered while one is chosen.
    expect(wrapper.findAll('.an-filters select')[2].findAll('option')).toHaveLength(3)
    // With one prompt the unreported line moves onto its card.
    expect(wrapper.find('.an-note').exists()).toBe(false)
    expect(wrapper.find('.fpc-note').text()).toBe("3 searches didn't report their text.")
  })

  it('opens the Google check with the searches picked on a card', async () => {
    const { wrapper } = await mountPage()
    const card = wrapper.findAll('.fpc')[0]
    expect(card.find('.fpc-foot').exists()).toBe(false)
    await card.findAll('input[type="checkbox"]')[1].setValue(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    insights.estimate.mockResolvedValue(
      ok({ kind: 'fanout_google', google: { pages_max: 1, credits_max: 25, daily_left: 60, daily_limit: 60 }, confirm: {}, can_run: true }),
    )
    await card.findAll('button').find((b) => b.text() === 'Check 1 on Google').trigger('click')
    await vi.advanceTimersByTimeAsync(300)
    expect(insights.estimate).toHaveBeenCalledWith('w1', {
      kind: 'fanout_google',
      params: { queries: [{ prompt_id: 'p1', text: 'evernote vs notion' }] },
    })
    expect(document.body.textContent).toContain('Check searches on Google')
  })

  it('takes at most ten searches in one check', async () => {
    const payload = fanOutsPayload()
    payload.prompts[0].queries = Array.from({ length: 12 }, (_, i) => ({
      key: `q${i}`,
      text: `search ${i}`,
      engines: ['chatgpt'],
      answers: 1,
      google: { state: 'not_checked' },
    }))
    insights.fanOuts.mockResolvedValue(ok(payload))
    const { wrapper } = await mountPage()
    const boxes = wrapper.findAll('.fpc')[0].findAll('input[type="checkbox"]')
    for (const box of boxes.slice(0, 10)) await box.setValue(true)
    expect(boxes[10].attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('.fpc')[0].find('.fpc-foot button').text()).toBe('Check 10 on Google')
  })

  it('follows a running check and reloads when it ends', async () => {
    insights.runOptions.mockResolvedValue(ok({ ...OPTIONS, active_run: insightRun({ kind: 'fanout_google', kind_label: 'Fan-out Google check' }) }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { wrapper } = await mountPage()
    expect(wrapper.find('.irp').text()).toContain('Fan-out Google check running')
    insights.getRun.mockResolvedValue(
      ok(insightRun({ kind: 'fanout_google', kind_label: 'Fan-out Google check', status: 'done', duration_ms: 4000 })),
    )
    const calls = insights.fanOuts.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(insights.fanOuts.mock.calls.length).toBe(calls + 1)
  })

  it('warns when web search is off but searches were recorded', async () => {
    insights.fanOuts.mockResolvedValue(ok(fanOutsPayload({ web_search: { ...fanOutsPayload().web_search, enabled: false } })))
    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain('Web search is off on this server now; these searches were recorded while it was on.')
  })

  it.each([
    [
      'web_search_off',
      "The engines aren't searching the web on this server.",
      'Query fan-outs are the web searches an engine runs while it answers. Cansee records them for ChatGPT and Claude when web search is on (LLM_WEBSEARCH_ENABLED). Answers with web search cost more.',
      null,
    ],
    [
      'none_recorded',
      'No searches recorded yet.',
      'Searches are recorded from answers collected after web search was turned on. Check a prompt now to record some.',
      'Open prompts',
    ],
    ['no_answers', 'No AI answers in the last 30 days.', '', 'Open prompts'],
  ])('shows the %s state', async (reason, title, body, action) => {
    insights.fanOuts.mockResolvedValue(ok(fanOutsPayload({ empty_reason: reason })))
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toEqual([title])
    if (body) expect(wrapper.find('.viz-state-body').text()).toBe(body)
    if (action) {
      // Prompts are the board's Prompts widget now, for this project.
      expect(wrapper.find('.viz-state a').text()).toBe(action)
      expect(wrapper.find('.viz-state a').attributes('href')).toBe('/projects/w1/analytics?widget=prompts')
    } else expect(wrapper.find('.viz-state a').exists()).toBe(false)
    expect(wrapper.findAll('.fpc')).toHaveLength(0)
  })

  it('shows a load error with Try again', async () => {
    insights.fanOuts.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toEqual(["We couldn't load query fan-outs."])
  })
})
