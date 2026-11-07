import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { VizChartStub, chartsById } from '@/pages/__tests__/__fixtures__/vizStub'
import { apiError, ok, promptIdeasPayload } from './__fixtures__/measurementPayloads'

const insights = vi.hoisted(() => ({
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  promptIdeas: vi.fn(),
  updateIdea: vi.fn(),
  trackIdea: vi.fn(),
}))
const ask = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/lib/agent/askAgent', () => ask)
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: PromptResearchPage } = await import('../PromptResearchPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function mountPage(path = '/projects/w1/prompt-research') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://notion.so' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      {
        path: '/projects/:websiteId/prompt-research',
        name: 'prompt-research',
        component: PromptResearchPage,
        props: true,
        meta: { analytics: 'prompt-research' },
      },
      { path: '/projects/:websiteId/prompts/:promptId', name: 'prompt', component: Blank, props: true },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, {
    global: { plugins: [pinia, router], stubs: { VizChart: VizChartStub, ChatDetailModal: true } },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const body = () => new DOMWrapper(document.body)
const stateTitles = (wrapper) => wrapper.findAll('.viz-state-title').map((t) => t.text())
const ideaRows = (wrapper) => wrapper.findAll('.it-row')

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(insights)) fn.mockReset()
  for (const fn of Object.values(toast)) fn.mockReset()
  ask.askAgent.mockClear()
  insights.runOptions.mockResolvedValue(ok({ kind: 'prompt_research', enabled: true, choices: { prompts: [] }, active_run: null }))
  insights.promptIdeas.mockResolvedValue(ok(promptIdeasPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('PromptResearchPage', () => {
  it('renders the sources, the tiles, the chart and the ideas, with no volume', async () => {
    const { wrapper } = await mountPage()
    expect(insights.promptIdeas).toHaveBeenCalledWith('w1', { status: 'new' })
    expect(wrapper.find('h1').text()).toBe('Prompt research')
    expect(wrapper.text()).toContain('Questions people and engines ask around your prompts, with where each one came from.')
    expect(wrapper.findAll('.ss-chip').map((c) => c.text())).toEqual([
      'People also ask: On',
      'Related search: None seen',
      'Engine search: No web search',
      'AI suggestion: Not run',
      'Predicted sub-query: On',
    ])
    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles).toEqual([
      'New ideas20',
      'From People also ask9',
      'From related searches0',
      'From engine searchesNo web search',
      'AI suggestionsNot run',
      'Tracked3',
    ])
    expect(chartsById(wrapper)['prompts.sources'].props('spec').title).toBe('Ideas by source')
    const rows = ideaRows(wrapper)
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('is notion free for teams')
    expect(rows[0].text()).toContain('People also ask')
    expect(rows[0].text()).toContain('2 prompts')
    expect(wrapper.find('.it-table thead').text()).not.toMatch(/volume/i)
    expect(wrapper.text()).toContain(
      'Cansee has no data on how often people ask these questions, so each idea shows where it came from instead of a volume.',
    )
  })

  it('opens an idea to show where it came from', async () => {
    const { wrapper } = await mountPage()
    await ideaRows(wrapper)[0].find('.it-toggle').trigger('click')
    const evidence = wrapper.find('.it-evidence').text()
    expect(evidence).toContain('People also ask on "best note taking app for teams"')
    expect(evidence).toContain('Predicted sub-query of "notion alternatives for small startups"')
  })

  it('keeps the filters in the query and sends them to the API', async () => {
    const { wrapper, router } = await mountPage()
    const [sourceSelect, statusSelect] = wrapper.findAll('.it-filters select')
    expect(sourceSelect.findAll('option').map((o) => o.text())).toEqual([
      'All sources',
      'People also ask',
      'Related search',
      'Engine search',
      'AI suggestion',
      'Predicted sub-query',
    ])
    await sourceSelect.setValue('paa')
    await flushPromises()
    await statusSelect.setValue('dismissed')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ source: 'paa', status: 'dismissed' })
    expect(insights.promptIdeas).toHaveBeenLastCalledWith('w1', { status: 'dismissed', source: 'paa' })
  })

  it('says when no idea matches, and clears both filters at once', async () => {
    insights.promptIdeas.mockResolvedValue(ok(promptIdeasPayload({ ideas: [] })))
    const { wrapper, router } = await mountPage('/projects/w1/prompt-research?source=fanout&status=tracked')
    expect(stateTitles(wrapper)).toContain('No ideas match these filters.')
    await wrapper.findAll('.it button').find((b) => b.text() === 'Clear filters').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('shows the no-ideas state with Find prompt ideas', async () => {
    insights.promptIdeas.mockResolvedValue(
      ok(
        promptIdeasPayload({
          counts: { new: 0, tracked: 0, dismissed: 0, by_source: { paa: 0, related_search: 0, fanout: 0, ai_suggestion: 0, sub_query: 0 } },
          ideas: [],
        }),
      ),
    )
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toEqual(['No ideas yet.'])
    expect(wrapper.find('.viz-state-body').text()).toBe(
      "Ideas come from Google's People also ask and related searches on your Google checks, from the searches engines run while answering, and from AI suggestions based on your brand context.",
    )
    expect(wrapper.find('.viz-state button').text()).toBe('Find prompt ideas')
    expect(wrapper.findAll('.viz-stat')).toHaveLength(0)
  })

  it('opens the research dialog with suggestions on', async () => {
    const { wrapper } = await mountPage()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    insights.estimate.mockResolvedValue(ok({ kind: 'prompt_research', ai: { calls_max: 1, usd_max: '0.0100' }, confirm: {}, can_run: true }))
    await wrapper.findAll('button').find((b) => b.text() === 'Find prompt ideas').trigger('click')
    await vi.advanceTimersByTimeAsync(300)
    expect(insights.estimate).toHaveBeenCalledWith('w1', {
      kind: 'prompt_research',
      params: { suggest: true, google_prompt_ids: [] },
    })
    expect(body().text()).toContain('Suggest prompts from my brand context')
  })

  it('dismisses and restores ideas', async () => {
    insights.updateIdea.mockResolvedValue(ok({}))
    const { wrapper } = await mountPage()
    await ideaRows(wrapper)[0].findAll('button').find((b) => b.text() === 'Dismiss').trigger('click')
    await flushPromises()
    expect(insights.updateIdea).toHaveBeenCalledWith('w1', 'e5', { status: 'dismissed' })
    expect(insights.promptIdeas).toHaveBeenCalledTimes(2)

    const dismissed = promptIdeasPayload()
    dismissed.ideas = dismissed.ideas.map((i) => ({ ...i, status: 'dismissed' }))
    insights.promptIdeas.mockResolvedValue(ok(dismissed))
    const second = await mountPage('/projects/w1/prompt-research?status=dismissed')
    await ideaRows(second.wrapper)[0].findAll('button').find((b) => b.text() === 'Restore').trigger('click')
    await flushPromises()
    expect(insights.updateIdea).toHaveBeenLastCalledWith('w1', 'e5', { status: 'new' })
  })

  it('links a tracked idea to its prompt', async () => {
    const tracked = promptIdeasPayload()
    tracked.ideas = [{ ...tracked.ideas[0], status: 'tracked', tracked_prompt_id: 'p9' }]
    insights.promptIdeas.mockResolvedValue(ok(tracked))
    const { wrapper } = await mountPage('/projects/w1/prompt-research?status=tracked')
    const row = ideaRows(wrapper)[0]
    expect(row.find('a.it-state').text()).toBe('Tracked')
    expect(row.find('a.it-state').attributes('href')).toBe('/projects/w1/prompts/p9')
    expect(row.findAll('button').map((b) => b.text())).not.toContain('Track')
  })

  it('asks the agent for an answer page', async () => {
    const { wrapper } = await mountPage()
    await ideaRows(wrapper)[0].find('.ask-btn').trigger('click')
    await flushPromises()
    const [, options] = ask.askAgent.mock.calls[0]
    expect(options).toMatchObject({ websiteId: 'w1', agent: 'aeo_article', from: 'prompt-research' })
    expect(options.text).toBe(
      'Draft an answer page for this question: "is notion free for teams".\n' +
        'Where it came from: People also ask and Predicted sub-query.\n' +
        'Related tracked prompts: "best note taking app for teams" and "notion alternatives for small startups".',
    )
  })

  it('tracks an idea after the cost is confirmed', async () => {
    insights.trackIdea.mockResolvedValue(ok({ idea: { id: 'e5', status: 'tracked' }, prompt_id: 'p9', scan_audit_id: 'a9' }))
    const { wrapper } = await mountPage()
    await ideaRows(wrapper)[0].findAll('button').find((b) => b.text() === 'Track').trigger('click')
    await flushPromises()
    expect(body().text()).toContain('Track this prompt?')
    expect(body().text()).toContain(
      'Cansee adds "is notion free for teams" to your tracked prompts and asks ChatGPT and Claude now: up to $0.04 of your AI allowance ($4.08 left this month).',
    )
    await body().findAll('button').find((b) => b.text() === 'Track and check').trigger('click')
    await flushPromises()
    expect(insights.trackIdea).toHaveBeenCalledWith('w1', 'e5', { confirm: { ai_usd_max: '0.0400' } })
    expect(toast.success).toHaveBeenCalledWith('Tracking "is notion free for teams". The AI engines are being asked now.')
    expect(insights.promptIdeas).toHaveBeenCalledTimes(2)
  })

  it('shows a load error with Try again', async () => {
    insights.promptIdeas.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toEqual(["We couldn't load prompt ideas."])
  })
})
