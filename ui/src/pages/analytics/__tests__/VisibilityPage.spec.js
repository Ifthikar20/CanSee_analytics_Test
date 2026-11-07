import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { apiError, ok, visibilityPayload } from './__fixtures__/analyticsPayloads'

vi.mock('@/api/visibility', () => ({ default: { dashboard: vi.fn() } }))

const { default: visibilityApi } = await import('@/api/visibility')
const { default: VisibilityPage } = await import('../VisibilityPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function mountPage(path = '/projects/w1/visibility', { focus = '' } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank, props: true },
      {
        path: '/projects/:websiteId/visibility',
        name: 'visibility',
        component: VisibilityPage,
        props: (to) => ({ websiteId: to.params.websiteId, focus }),
      },
      { path: '/projects/:websiteId/prompts/:promptId', name: 'prompt', component: Blank, props: true },
      { path: '/projects/:websiteId/competitors', name: 'competitors', component: Blank, props: true },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router], stubs: { VizChart: true } } })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const charts = (wrapper) => wrapper.findAllComponents({ name: 'VizChart' })
const chart = (wrapper, id) => charts(wrapper).find((c) => c.props('spec').id === id)

beforeEach(() => {
  localStorage.clear()
  visibilityApi.dashboard.mockReset()
  visibilityApi.dashboard.mockResolvedValue(ok(visibilityPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
})

describe('VisibilityPage', () => {
  it('renders the header, the five tiles and every chart', async () => {
    const { wrapper } = await mountPage()
    expect(visibilityApi.dashboard).toHaveBeenCalledWith('w1', { period: '30d' })
    expect(wrapper.find('h1').text()).toBe('Notion')
    expect(wrapper.text()).toContain('AI visibility')
    expect(wrapper.text()).toContain(
      'How often the AI engines name you, next to whom, in what tone, and which sources they rely on.',
    )
    const tiles = wrapper.findAll('.viz-stat')
    expect(tiles).toHaveLength(5)
    expect(tiles[0].text()).toContain('34%')
    expect(tiles[0].text()).toContain('+4.1 pts vs previous 30 days')
    expect(tiles[4].text()).toContain('12 of 340')
    expect(charts(wrapper).map((c) => c.props('spec').id)).toEqual([
      'visibility.engines',
      'visibility.sov',
      'visibility.sov_total',
      'visibility.sentiment',
      'visibility.citations',
      'visibility.domains',
      'visibility.by_engine_bar',
      'visibility.by_prompt',
    ])
    expect(chart(wrapper, 'visibility.sov_total').props('selected')).toBe('you')
    expect(charts(wrapper).every((c) => c.props('empty') === null)).toBe(true)
  })

  it('keeps the filters in the query and sends them to the API', async () => {
    const { wrapper, router } = await mountPage()
    const [period, engine, prompt] = wrapper.findAll('select')
    expect(engine.findAll('option').map((o) => o.text())).toEqual(['All engines', 'ChatGPT', 'Claude'])
    expect(prompt.findAll('option').map((o) => o.text())).toEqual([
      'All prompts',
      'best note taking app for teams',
      'notion alternatives for small startups',
    ])

    await period.setValue('7d')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ period: '7d' })
    expect(visibilityApi.dashboard).toHaveBeenLastCalledWith('w1', { period: '7d' })

    await wrapper.findAll('select')[1].setValue('claude')
    await flushPromises()
    await wrapper.findAll('select')[2].setValue('p2')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ period: '7d', engine: 'claude', prompt: 'p2' })
    expect(visibilityApi.dashboard).toHaveBeenLastCalledWith('w1', { period: '7d', engine: 'claude', prompt_id: 'p2' })
  })

  it('reads filters from the URL and ignores unknown periods', async () => {
    await mountPage('/projects/w1/visibility?period=1y&engine=chatgpt')
    expect(visibilityApi.dashboard).toHaveBeenCalledWith('w1', { period: '30d', engine: 'chatgpt' })
  })

  it('shows state words for unmeasured tiles and 0 for a measured zero', async () => {
    visibilityApi.dashboard.mockResolvedValue(
      ok(
        visibilityPayload({
          headline: {
            answers: 0, answers_prev: null, visibility_pct: null, visibility_prev_pct: null, avg_rank: null,
            avg_rank_prev: null, share_of_voice_pct: null, share_of_voice_prev_pct: null, citations: null, your_citations: null,
          },
          citations: { has_data: false, totals: null, series: {}, top_domains: [] },
        }),
      ),
    )
    const { wrapper } = await mountPage()
    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles[0]).toContain('No answers')
    expect(tiles[1]).toContain('No brands named')
    expect(tiles[2]).toContain('Not named')
    expect(tiles[3]).toContain('0')
    expect(tiles[4]).toContain('Not recorded')
    expect(wrapper.find('.viz-stat-delta').exists()).toBe(false)
  })

  it.each([
    [
      'no_prompts',
      'No prompts tracked yet.',
      'Add the questions your buyers ask in Prompts. Cansee asks each AI engine and tracks the answers here.',
      'Add prompts',
      '/projects/w1/analytics?add=1&widget=prompts',
    ],
    [
      'no_engines',
      'No AI engine is connected yet.',
      'Visibility needs at least one AI engine. An administrator adds the engine keys on the server.',
      null,
      null,
    ],
    [
      'no_answers',
      'No AI answers in the last 30 days.',
      'Answers appear after the engines are asked your prompts. Use Check now on a prompt, or start research in the Agent.',
      'Open prompts',
      '/projects/w1/analytics?widget=prompts',
    ],
  ])('shows the %s empty state instead of the charts', async (reason, title, body, action, href) => {
    visibilityApi.dashboard.mockResolvedValue(ok(visibilityPayload({ has_data: false, empty_reason: reason })))
    const { wrapper } = await mountPage()
    const state = wrapper.find('.viz-state')
    expect(state.find('.viz-state-title').text()).toBe(title)
    expect(state.find('.viz-state-body').text()).toBe(body)
    if (action) {
      // The Overview's prompts live in the board's Prompts widget now.
      expect(state.find('a').text()).toBe(action)
      expect(state.find('a').attributes('href')).toBe(href)
    } else expect(state.find('a').exists()).toBe(false)
    expect(charts(wrapper)).toHaveLength(0)
    expect(wrapper.findAll('.viz-stat')).toHaveLength(0)
    // The filters stay, so another period can be tried.
    expect(wrapper.findAll('select')).toHaveLength(3)
  })

  it('passes the section empties to their charts', async () => {
    const payload = visibilityPayload({
      sentiment: { totals: { positive: 0, neutral: 0, negative: 0 }, series: {} },
      citations: { has_data: false, totals: null, series: {}, top_domains: [] },
    })
    payload.share_of_voice.brands = []
    visibilityApi.dashboard.mockResolvedValue(ok(payload))
    const { wrapper } = await mountPage()
    expect(chart(wrapper, 'visibility.sov').props('empty')).toEqual({ title: 'No brand was named in these answers.' })
    expect(chart(wrapper, 'visibility.sov_total').props('empty').title).toBe('No brand was named in these answers.')
    expect(chart(wrapper, 'visibility.sentiment').props('empty')).toEqual({
      title: "You weren't named in this period, so there is no tone to show.",
    })
    const citations = {
      title: 'No cited sources were recorded for these answers.',
      body: 'Sources are read from each answer after it arrives. Engines that answer without sources leave this empty.',
    }
    expect(chart(wrapper, 'visibility.citations').props('empty')).toEqual(citations)
    expect(chart(wrapper, 'visibility.domains').props('empty')).toEqual(citations)
  })

  it('shows a load error with Try again', async () => {
    visibilityApi.dashboard.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe("We couldn't load visibility.")
    visibilityApi.dashboard.mockResolvedValue(ok(visibilityPayload()))
    await wrapper.find('.viz-state button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.viz-stat')).toHaveLength(5)
  })

  it('keeps the last numbers when a refresh fails', async () => {
    const { wrapper } = await mountPage()
    visibilityApi.dashboard.mockRejectedValue(apiError(503))
    await wrapper.findAll('select')[0].setValue('90d')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain(
      "We couldn't refresh this page. Showing the last loaded numbers.",
    )
    expect(wrapper.findAll('.viz-stat')).toHaveLength(5)
    visibilityApi.dashboard.mockResolvedValue(ok(visibilityPayload()))
    await wrapper.find('.an-retry').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('drops a prompt filter the project no longer tracks', async () => {
    visibilityApi.dashboard.mockImplementation(async (_wid, params) => {
      if (params.prompt_id) throw apiError(404, 'not_found')
      return ok(visibilityPayload())
    })
    const { router, wrapper } = await mountPage('/projects/w1/visibility?prompt=gone')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(wrapper.findAll('.viz-stat')).toHaveLength(5)
  })

  it('links to the competitor comparison under the share of voice', async () => {
    const { wrapper, router } = await mountPage()
    const link = wrapper.find('a.an-compare')
    expect(link.text()).toBe('Compare with your competitors on Google and in AI answers')
    expect(link.attributes('href')).toBe('/projects/w1/competitors')
    await link.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('competitors')
  })

  it.each([
    ['', ['visibility.engines', 'visibility.sov', 'visibility.sov_total', 'visibility.sentiment', 'visibility.citations',
      'visibility.domains', 'visibility.by_engine_bar', 'visibility.by_prompt']],
    ['over-time', ['visibility.engines', 'visibility.sov', 'visibility.sov_total', 'visibility.sentiment',
      'visibility.citations', 'visibility.domains', 'visibility.by_engine_bar', 'visibility.by_prompt']],
    ['by-engine', ['visibility.by_engine_bar', 'visibility.engines', 'visibility.sov', 'visibility.sov_total',
      'visibility.sentiment', 'visibility.citations', 'visibility.domains', 'visibility.by_prompt']],
    ['share-of-voice', ['visibility.sov', 'visibility.sov_total', 'visibility.engines', 'visibility.sentiment',
      'visibility.citations', 'visibility.domains', 'visibility.by_engine_bar', 'visibility.by_prompt']],
    ['by-prompt', ['visibility.by_prompt', 'visibility.engines', 'visibility.sov', 'visibility.sov_total',
      'visibility.sentiment', 'visibility.citations', 'visibility.domains', 'visibility.by_engine_bar']],
    ['unknown', ['visibility.engines', 'visibility.sov', 'visibility.sov_total', 'visibility.sentiment',
      'visibility.citations', 'visibility.domains', 'visibility.by_engine_bar', 'visibility.by_prompt']],
  ])('puts the focused section first (focus %s), in the DOM as on screen', async (focus, order) => {
    const { wrapper } = await mountPage('/projects/w1/visibility', { focus })
    expect(charts(wrapper).map((c) => c.props('spec').id)).toEqual(order)
    // The tiles stay on top of every section.
    expect(wrapper.find('.an-kpis').exists()).toBe(true)
  })

  it('keeps the competitors link right under the share of voice when it is first', async () => {
    const { wrapper } = await mountPage('/projects/w1/visibility', { focus: 'share-of-voice' })
    const sections = wrapper.findAll('.an-page > *').map((el) => el.classes().join(' ') || el.element.tagName.toLowerCase())
    const sov = sections.indexOf('an-two')
    expect(sections[sov + 1]).toBe('an-compare')
  })

  it('opens a prompt from the heatmap', async () => {
    const { wrapper, router } = await mountPage()
    chart(wrapper, 'visibility.by_prompt').vm.$emit('select', { label: 'p2' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w1/prompts/p2')
  })
})
