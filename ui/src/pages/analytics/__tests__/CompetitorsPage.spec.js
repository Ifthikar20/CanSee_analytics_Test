import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { VizChartStub, chartsById } from '@/pages/__tests__/__fixtures__/vizStub'
import { apiError, competitorsPayload, ok } from './__fixtures__/measurementPayloads'

const insights = vi.hoisted(() => ({ competitors: vi.fn() }))
const ask = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))

vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/lib/agent/askAgent', () => ask)

const { default: CompetitorsPage } = await import('../CompetitorsPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function mountPage(path = '/projects/w1/competitors') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://notion.so' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
      {
        path: '/projects/:websiteId/competitors',
        name: 'competitors',
        component: CompetitorsPage,
        props: true,
        meta: { analytics: 'competitors' },
      },
      { path: '/projects/:websiteId/crawler-access', name: 'crawler-access', component: Blank },
      { path: '/projects/:websiteId/prompts/:promptId', name: 'prompt', component: Blank, props: true },
      { path: '/settings/project', name: 'settings-project', component: Blank },
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

beforeEach(() => {
  localStorage.clear()
  insights.competitors.mockReset()
  ask.askAgent.mockClear()
  insights.competitors.mockResolvedValue(ok(competitorsPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('CompetitorsPage', () => {
  it('renders a tile per brand, every chart and the tables', async () => {
    const { wrapper } = await mountPage()
    expect(insights.competitors).toHaveBeenCalledWith('w1', { period: '30d' })
    expect(wrapper.find('h1').text()).toBe('Competitors')
    expect(wrapper.text()).toContain('Benchmark')
    expect(wrapper.text()).toContain('How you compare with the competitors you track, on Google and in AI answers.')

    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles).toHaveLength(3)
    expect(tiles[0]).toContain('Notion')
    expect(tiles[0]).toContain('33%')
    expect(tiles[1]).toContain('Named in 50 of 120 answers')

    const charts = chartsById(wrapper)
    expect(Object.keys(charts)).toEqual([
      'competitors.visibility',
      'competitors.compare',
      'competitors.ai_by_prompt',
      'competitors.google_by_prompt',
    ])
    expect(charts['competitors.compare'].props('selected')).toBe('you')
    expect(Object.values(charts).every((c) => c.props('empty') === null)).toBe(true)

    expect(wrapper.findAll('.cmp-gap').map((g) => g.find('a').text())).toEqual([
      'note app with offline mode: Obsidian 67%, you 17%',
      'best note taking app for teams: Evernote 50%, you 25%',
    ])
    const h2h = wrapper.findAll('[aria-labelledby="cmp-h2h-title"] tbody tr').map((r) => r.text())
    expect(h2h[0]).toContain('Evernote')
    expect(h2h[0]).toContain('25')
    const site = wrapper.findAll('[aria-labelledby="cmp-site-title"] tbody tr').map((r) => r.text())
    expect(site).toEqual(['Notion7 of 9Yes', 'EvernoteNot auditedNot audited', 'Obsidian6 of 9No'])
    expect(wrapper.findAll('a').find((a) => a.text() === 'Open Crawler access').attributes('href')).toBe(
      '/projects/w1/crawler-access',
    )
  })

  it('keeps the filters in the query and sends them to the API', async () => {
    const { wrapper, router } = await mountPage()
    const [period, engine] = wrapper.findAll('.an-filters select')
    await period.setValue('90d')
    await flushPromises()
    await engine.setValue('claude')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ period: '90d', engine: 'claude' })
    expect(insights.competitors).toHaveBeenLastCalledWith('w1', { period: '90d', engine: 'claude' })
  })

  it('asks the agent about the biggest gap with the Google words', async () => {
    const { wrapper } = await mountPage()
    await wrapper.findAll('.cmp-gap')[1].find('.ask-btn').trigger('click')
    await flushPromises()
    const [, options] = ask.askAgent.mock.calls[0]
    expect(options).toMatchObject({ websiteId: 'w1', agent: 'gap_analyst', from: 'competitors' })
    expect(options.text).toBe(
      'For "best note taking app for teams", AI engines name Evernote in 50% of answers and us in 25%.\n' +
        'On Google we are #14 and they are not on page one.\n' +
        'Find why and draft a plan to close the gap.',
    )
  })

  it('drops the Google line for a prompt without a Google check', async () => {
    const { wrapper } = await mountPage()
    await wrapper.findAll('.cmp-gap')[0].find('.ask-btn').trigger('click')
    await flushPromises()
    expect(ask.askAgent.mock.calls[0][1].text).not.toContain('On Google')
  })

  it('shows the no-competitors state', async () => {
    insights.competitors.mockResolvedValue(ok(competitorsPayload({ empty_reason: 'no_competitors' })))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe("You aren't tracking any competitors yet.")
    expect(wrapper.find('.viz-state-body').text()).toBe('Add the competitors you want to compare with in Project settings.')
    expect(wrapper.find('.viz-state a').text()).toBe('Open project settings')
    expect(wrapper.findAll('.viz-stat')).toHaveLength(0)
  })

  it('shows the AI and Google states instead of zeros', async () => {
    insights.competitors.mockResolvedValue(
      ok(
        competitorsPayload({
          ai: { answers: 0, brands: {} },
          google: { configured: false, prompts_checked: 0, oldest_check_at: null, brands: null },
          citations: { has_data: false, brands: null },
        }),
      ),
    )
    const { wrapper } = await mountPage()
    const charts = chartsById(wrapper)
    const ai = {
      title: 'No AI answers in the last 30 days.',
      body: 'Answers appear after the engines are asked your prompts.',
      action: { label: 'Open prompts', to: { name: 'analytics', params: { websiteId: 'w1' }, query: { widget: 'prompts' } } },
    }
    expect(charts['competitors.visibility'].props('empty')).toEqual(ai)
    expect(charts['competitors.ai_by_prompt'].props('empty')).toEqual(ai)
    expect(charts['competitors.google_by_prompt'].props('empty')).toEqual({
      kind: 'not_connected',
      title: "Google results aren't configured on this server.",
    })
    expect(wrapper.findAll('.viz-stat').map((t) => t.text()).every((t) => t.includes('No answers'))).toBe(true)
    expect(wrapper.find('.cmp-gap').exists()).toBe(false)
  })

  it('says when no prompt was checked on Google', async () => {
    insights.competitors.mockResolvedValue(
      ok(competitorsPayload({ google: { configured: true, prompts_checked: 0, oldest_check_at: null, brands: null } })),
    )
    const { wrapper } = await mountPage()
    expect(chartsById(wrapper)['competitors.google_by_prompt'].props('empty')).toEqual({
      title: 'No Google checks yet.',
      body: 'Check Google for a prompt in Prompts to compare positions.',
      action: { label: 'Open prompts', to: { name: 'analytics', params: { websiteId: 'w1' }, query: { widget: 'prompts' } } },
    })
  })

  it('opens a prompt from a heatmap', async () => {
    const { wrapper, router } = await mountPage()
    chartsById(wrapper)['competitors.google_by_prompt'].vm.$emit('select', { label: 'p1' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w1/prompts/p1')
  })

  it('shows a load error with Try again', async () => {
    insights.competitors.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe("We couldn't load the comparison.")
    insights.competitors.mockResolvedValue(ok(competitorsPayload()))
    await wrapper.find('.viz-state button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.viz-stat')).toHaveLength(3)
  })
})
