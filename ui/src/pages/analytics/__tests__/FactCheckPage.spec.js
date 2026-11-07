import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/stores/app'
import { VizChartStub, chartsById } from '@/pages/__tests__/__fixtures__/vizStub'
import { apiError, factCheckPayload, ok } from './__fixtures__/measurementPayloads'

const insights = vi.hoisted(() => ({
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  factCheck: vi.fn(),
}))
const ask = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))

vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/lib/agent/askAgent', () => ask)

const { default: FactCheckPage } = await import('../FactCheckPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const Shell = defineComponent({ render: () => h(TooltipProvider, null, () => h(RouterView)) })
const mounted = []

const NOT_ANALYZED = {
  coverage: { named_answers: 52, analyzed: 0, not_analyzed: 52, failed: 0 },
  totals: null,
  series: null,
  by_topic: null,
  by_engine: null,
  claims: [],
}

async function mountPage(path = '/projects/w1/fact-check') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://www.notion.so' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      {
        path: '/projects/:websiteId/fact-check',
        name: 'fact-check',
        component: FactCheckPage,
        props: true,
        meta: { analytics: 'fact-check' },
      },
      { path: '/projects/:websiteId/visibility', name: 'visibility', component: Blank },
      { path: '/settings/brand-facts', name: 'settings-brand-facts', component: Blank },
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
const claimRows = (wrapper) => wrapper.findAll('.cl-row')

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(insights)) fn.mockReset()
  ask.askAgent.mockClear()
  insights.runOptions.mockResolvedValue(ok({ kind: 'answer_analysis', enabled: true, choices: {}, active_run: null }))
  insights.factCheck.mockResolvedValue(ok(factCheckPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('FactCheckPage', () => {
  it('renders the coverage and evidence lines, the tiles, the charts and the claims', async () => {
    const { wrapper } = await mountPage()
    expect(insights.factCheck).toHaveBeenCalledWith('w1', { period: '30d' })
    expect(wrapper.find('h1').text()).toBe('Fact check')
    expect(wrapper.text()).toContain('What the AI engines state about you, checked against your brand facts and your own pages.')
    expect(wrapper.find('.cov').text()).toContain('Claims come from 40 of 52 answers that name you.')
    expect(wrapper.find('.an-evidence').text()).toContain(
      'Checked against 14 approved brand facts and 2 pages of notion.so. 3 facts waiting for review are not used.',
    )
    expect(wrapper.find('.an-evidence a').attributes('href')).toBe('/settings/brand-facts')

    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles[0]).toContain('Claims checked')
    expect(tiles[0]).toContain('55')
    expect(tiles[2]).toContain('Contradicted')
    expect(tiles[2]).toContain('of 55 claims checked')
    expect(Object.keys(chartsById(wrapper))).toEqual(['factcheck.verdicts', 'factcheck.topics', 'factcheck.engines'])

    const rows = claimRows(wrapper)
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain("Notion's Plus plan costs $8 per user per month")
    expect(rows[0].text()).toContain('Contradicted')
    expect(rows[0].text()).toContain('"Plus $10 per seat/month"')
    expect(rows[0].text()).toContain('/pricing')
    expect(rows[0].text()).toContain("Checker's note: The pricing page lists $10 per seat, not $8.")
    expect(rows[0].text()).toContain('of 40 analyzed')
    expect(rows[1].text()).toContain('No evidence covers this')
    expect(rows[2].text()).toContain('Brand fact')
    expect(wrapper.text()).toContain(
      "Claims and verdicts are read by Claude Haiku 5.5. Each claim quotes the answer word for word and each verdict quotes your evidence word for word; the verdict is the model's reading of the two.",
    )
  })

  it('keeps the claim filters in the query and sends them to the API', async () => {
    const { wrapper, router } = await mountPage()
    const [verdictSelect, topicSelect] = wrapper.findAll('.cl-filters select')
    expect(verdictSelect.findAll('option').map((o) => o.text())).toEqual([
      'All verdicts',
      'Contradicted',
      'Not verifiable',
      'Not checked',
      'Supported',
    ])
    await verdictSelect.setValue('contradicted')
    await flushPromises()
    await topicSelect.setValue('pricing')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ verdict: 'contradicted', topic: 'pricing' })
    expect(insights.factCheck).toHaveBeenLastCalledWith('w1', { period: '30d', verdict: 'contradicted', topic: 'pricing' })
  })

  it('clears both claim filters at once when none match', async () => {
    insights.factCheck.mockResolvedValue(ok(factCheckPayload({ claims: [] })))
    const { wrapper, router } = await mountPage('/projects/w1/fact-check?verdict=supported&topic=security')
    expect(stateTitles(wrapper)).toContain('No claims match these filters.')
    await wrapper.findAll('.cl button').find((b) => b.text() === 'Clear filters').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('opens where a claim was said', async () => {
    const { wrapper } = await mountPage()
    const toggle = claimRows(wrapper)[0].find('.cl-toggle')
    expect(toggle.text()).toContain('Show where it was said')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.cl-where').text()).toContain('"Plus at $8 per user"')
    expect(wrapper.find('.cl-where').text()).toContain('ChatGPT')
  })

  it('asks the agent to correct a contradicted claim on the evidence page', async () => {
    const { wrapper } = await mountPage()
    const buttons = claimRows(wrapper)[0].findAll('.ask-btn')
    expect(buttons.map((b) => b.text())).toEqual(['Ask the agent', 'Ask publishers to correct it'])
    await buttons[0].trigger('click')
    await flushPromises()
    const [, fix] = ask.askAgent.mock.calls[0]
    expect(fix).toMatchObject({ websiteId: 'w1', agent: 'page_optimizer', from: 'fact-check' })
    expect(fix.text).toBe(
      'AI engines state something about us that our own evidence contradicts.\n' +
        'Claim (ChatGPT, 3 answers): "Notion\'s Plus plan costs $8 per user per month"\n' +
        'Our evidence (https://notion.so/pricing): "Plus $10 per seat/month"\n' +
        'Draft the correction for https://notion.so/pricing, so the engines can find the right fact, and tell me where to publish it.',
    )

    await buttons[1].trigger('click')
    await flushPromises()
    const [, publishers] = ask.askAgent.mock.calls[1]
    expect(publishers.agent).toBe('pr_writer')
    expect(publishers.text).toContain('(Fact check claim 9f2c41aa0b1d77e3|contradicted)')
  })

  it('offers the agent and a brand fact for a claim no evidence covers', async () => {
    const { wrapper } = await mountPage()
    const row = claimRows(wrapper)[1]
    expect(row.find('a').text()).toBe('Add a brand fact')
    await row.find('.ask-btn').trigger('click')
    await flushPromises()
    const [, options] = ask.askAgent.mock.calls[0]
    expect(options.agent).toBe('aeo_article')
    expect(options.text).toContain('AI engines state "Notion was founded in 2016" about us (2 answers)')
  })

  it('reads Not analyzed instead of zeros and offers the analysis', async () => {
    insights.factCheck.mockResolvedValue(ok(factCheckPayload({ ...NOT_ANALYZED, empty_reason: 'not_analyzed' })))
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toEqual(['No answers analyzed yet.'])
    expect(wrapper.text()).toContain(
      'Cansee lists the factual claims each answer makes about you and checks them against your brand facts and your own pages. You see the cost before anything runs.',
    )
    expect(wrapper.find('.viz-state button').text()).toBe('Analyze 52 answers')
    expect(wrapper.findAll('.viz-stat')).toHaveLength(0)
    expect(wrapper.find('.cov').exists()).toBe(false)
    // Nothing was checked yet, so there is no evidence line.
    expect(wrapper.find('.an-evidence').exists()).toBe(false)
  })

  it.each([
    ['no_answers', "The engines didn't name you in the last 30 days.", 'Fact check needs answers that name you.'],
    ['no_claims', 'The analyzed answers make no checkable claims about you.', ''],
  ])('shows the %s state', async (reason, title, body) => {
    insights.factCheck.mockResolvedValue(ok(factCheckPayload({ empty_reason: reason, claims: [] })))
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toEqual([title])
    if (body) expect(wrapper.find('.viz-state-body').text()).toBe(body)
    else expect(wrapper.find('.viz-state-body').exists()).toBe(false)
  })

  it('warns when nothing could serve as evidence', async () => {
    insights.factCheck.mockResolvedValue(
      ok(
        factCheckPayload({
          evidence: { facts: 0, facts_pending: 0, pages: [{ url: 'https://notion.so/', state: 'failed', read_at: null }] },
        }),
      ),
    )
    const { wrapper } = await mountPage()
    const alert = wrapper.findAll('[role="alert"]').find((a) => a.text().includes('every claim is Not verifiable'))
    expect(alert.text()).toContain(
      'You have no approved brand facts and none of your pages could be read, so every claim is Not verifiable.',
    )
    expect(alert.find('a').text()).toBe('Add brand facts')
  })

  it('shows a load error with Try again', async () => {
    insights.factCheck.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(stateTitles(wrapper)).toEqual(["We couldn't load the fact check."])
  })
})
