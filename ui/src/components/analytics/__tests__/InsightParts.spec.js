import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { insightRunKey } from '@/composables/analytics/useInsightRun'

const askAgent = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/agent/askAgent', async (importOriginal) => ({ ...(await importOriginal()), askAgent }))

const { default: AskAgentButton } = await import('../AskAgentButton.vue')
const { default: CoverageLine } = await import('../CoverageLine.vue')
const { default: SourceStates } = await import('../SourceStates.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function withRouter(path = '/projects/w1/analytics?widget=sentiment') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank, meta: { section: 'analytics' } },
      { path: '/elsewhere', name: 'elsewhere', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  return router
}

beforeEach(() => askAgent.mockClear())
afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
})

describe('AskAgentButton', () => {
  it('drafts the template for the open panel and its agent', async () => {
    const router = await withRouter()
    const wrapper = mount(AskAgentButton, {
      props: {
        websiteId: 'w1',
        template: 'theme',
        values: { theme: 'easy to set up', tone: 'positive', answers: 9, engines: ['chatgpt'], quote: 'takes minutes' },
      },
      global: { plugins: [router] },
    })
    mounted.push(wrapper)
    expect(wrapper.text()).toBe('Ask the agent')
    expect(wrapper.find('svg').exists()).toBe(true)
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(askAgent).toHaveBeenCalledWith(router, {
      websiteId: 'w1',
      agent: 'gap_analyst',
      from: 'sentiment',
      text:
        'AI engines describe us as "easy to set up" (positive) in 9 answers (ChatGPT). Example: "takes minutes"\n' +
        'Find what drives this description and draft content that reinforces or corrects it honestly.',
    })
  })

  it('names the widget whose panel is open, over the template', async () => {
    const router = await withRouter('/projects/w1/analytics?widget=citations')
    const wrapper = mount(AskAgentButton, {
      props: { websiteId: 'w1', template: 'page_optimize', values: { url: 'https://a.test/x', facts: ['- Google: #4 for "crm"'] } },
      global: { plugins: [router] },
    })
    mounted.push(wrapper)
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(askAgent.mock.calls[0][1]).toMatchObject({ agent: 'page_optimizer', from: 'citations' })
  })

  it("takes a label, and the template's own key without a panel", async () => {
    const router = await withRouter('/elsewhere')
    const wrapper = mount(AskAgentButton, {
      props: { websiteId: 'w1', template: 'fact_publishers', values: { claim: 'x', key: 'k' }, label: 'Ask publishers to correct it' },
      global: { plugins: [router] },
    })
    mounted.push(wrapper)
    expect(wrapper.text()).toBe('Ask publishers to correct it')
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(askAgent.mock.calls[0][1]).toMatchObject({ agent: 'pr_writer', from: 'fact-check' })
  })
})

describe('CoverageLine', () => {
  it('says how many answers the analysis covers and opens the analysis dialog', async () => {
    const runner = { open: vi.fn() }
    const wrapper = mount(CoverageLine, {
      props: { coverage: { named_answers: 52, analyzed: 40, not_analyzed: 12, failed: 0 }, params: { period: '30d' } },
      global: { provide: { [insightRunKey('answer_analysis')]: runner } },
    })
    mounted.push(wrapper)
    expect(wrapper.text()).toContain('Themes come from 40 of 52 answers that name you.')
    const button = wrapper.find('button')
    expect(button.text()).toBe('Analyze 12 answers')
    await button.trigger('click')
    expect(runner.open).toHaveBeenCalledWith({ period: '30d' })
    expect(wrapper.emitted('analyze')).toHaveLength(1)
  })

  it('names claims, a single answer, and hides with nothing left to analyze', async () => {
    let wrapper = mount(CoverageLine, { props: { coverage: { named_answers: 3, analyzed: 2, not_analyzed: 1 }, label: 'Claims' } })
    mounted.push(wrapper)
    expect(wrapper.text()).toContain('Claims come from 2 of 3 answers that name you.')
    expect(wrapper.find('button').text()).toBe('Analyze 1 answer')
    wrapper = mount(CoverageLine, { props: { coverage: { named_answers: 3, analyzed: 3, not_analyzed: 0 } } })
    mounted.push(wrapper)
    expect(wrapper.find('p').exists()).toBe(false)
  })
})

describe('SourceStates', () => {
  it('lists each source with its state, the note on focus', async () => {
    const wrapper = mount(SourceStates, {
      props: {
        items: [
          { key: 'google', label: 'Google rankings', word: 'On', ok: true },
          { key: 'paa', label: 'People also ask', word: 'No checks yet', note: 'Google questions are read from Google checks made after this release.' },
        ],
      },
      attachTo: document.body,
    })
    mounted.push(wrapper)
    const chips = wrapper.findAll('.ss-chip')
    expect(chips.map((c) => c.text())).toEqual(['Google rankings: On', 'People also ask: No checks yet'])
    expect(chips[0].classes()).toContain('is-on')
    expect(chips[1].element.tagName).toBe('BUTTON')
    await chips[1].trigger('focus')
    await flushPromises()
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('Google questions are read')
  })
})
