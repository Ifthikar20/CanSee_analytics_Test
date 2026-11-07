import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

const { default: AgentArtifactsPage } = await import('../AgentArtifactsPage.vue')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

async function setup(name, kinds, extraRoutes = []) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: Blank },
      { path: '/projects/:websiteId/agent/reports', name: 'agent-reports', component: Blank },
      { path: '/projects/:websiteId/agent/documents', name: 'agent-documents', component: Blank },
      { path: '/projects/:websiteId/agent/sheets', name: 'agent-sheets', component: Blank },
      { path: '/projects/:websiteId/agent/artifacts/:artifactId', name: 'agent-artifact', component: Blank },
      ...extraRoutes,
    ],
  })
  await router.push({ name, params: { websiteId: 'w1' } })
  await router.isReady()
  const wrapper = mount(AgentArtifactsPage, {
    props: { websiteId: 'w1', kinds },
    global: { plugins: [pinia, router] },
  })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  Object.assign(fakeAgent, {
    websiteId: 'w1',
    loadArtifacts: vi.fn(async () => []),
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentArtifactsPage', () => {
  it.each([
    ['agent-reports', ['report'], 'Reports', 'No reports yet.', 'Ask the agent to research a brand, then save the report.'],
    ['agent-documents', ['document', 'page'], 'Documents', 'No documents yet.', ''],
    ['agent-sheets', ['sheet'], 'Sheets', 'No sheets yet.', ''],
  ])('%s shows an honest empty state', async (name, kinds, title, empty, body) => {
    const { wrapper } = await setup(name, kinds)
    expect(fakeAgent.loadArtifacts).toHaveBeenCalledWith(kinds, '')
    expect(wrapper.find('h1').text()).toBe(title)
    expect(wrapper.text()).toContain(empty)
    if (body) expect(wrapper.text()).toContain(body)
    expect(wrapper.find('ul.ag-arts').exists()).toBe(false)
  })

  it('describes what a saved report keeps: engine checks, not answer text', async () => {
    const { wrapper } = await setup('agent-reports', ['report'])
    const intro = wrapper.find('.ag-page-intro').text()
    // The research snapshot stores each engine's named / rank / sentiment only.
    expect(intro).toContain('AI engine checks (named or not, rank, sentiment)')
    expect(intro).not.toMatch(/engine answers/i)
  })

  it('derives kinds from the route when the prop is missing', async () => {
    await setup('agent-sheets', null)
    expect(fakeAgent.loadArtifacts).toHaveBeenCalledWith(['sheet'], '')
  })

  it('lists artifacts with version, update time, author and links', async () => {
    fakeAgent.loadArtifacts = vi.fn(async () => [
      {
        id: 'a1',
        kind: 'page',
        title: 'Battery landing page',
        latest_version: 3,
        updated_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        created_by_name: 'Sam',
        source_chat_id: 'c7',
      },
      { id: 'a2', kind: 'document', title: 'Battery guide', latest_version: 1, updated_at: null, source_chat_id: null },
    ])
    const { wrapper } = await setup('agent-documents', ['document', 'page'])
    const rows = wrapper.findAll('li.ag-art')
    expect(rows).toHaveLength(2)
    const main = rows[0].find('a.ag-art-main')
    expect(main.attributes('href')).toBe('/projects/w1/agent/artifacts/a1')
    expect(main.text()).toContain('Battery landing page')
    expect(main.find('.ag-art-meta').text()).toBe('Landing page · v3 · Updated 2 hours ago · Sam')
    const chat = rows[0].find('a.ag-art-chat')
    expect(chat.attributes('href')).toBe('/projects/w1/agent/c/c7?artifact=a1')
    expect(rows[1].find('a.ag-art-chat').exists()).toBe(false)
  })

  it("shows each draft's review state and filters by it", async () => {
    const review = (state, effective = state, version = 2) => ({ state, effective_state: effective, version, reviewer_name: '', updated_at: null })
    fakeAgent.loadArtifacts = vi.fn(async () => [
      { id: 'a1', kind: 'document', title: 'Approved guide', latest_version: 2, review: review('approved') },
      { id: 'a2', kind: 'document', title: 'Guide in review', latest_version: 1, review: review('in_review') },
      // Approved at version 2, edited since: a draft again.
      { id: 'a3', kind: 'document', title: 'Edited guide', latest_version: 3, review: review('approved', 'draft') },
      { id: 'a4', kind: 'page', title: 'Never reviewed', latest_version: 1 },
    ])
    const { wrapper } = await setup('agent-documents', ['document', 'page'])
    const states = () => wrapper.findAll('li.ag-art').map((li) => [li.find('.ag-art-title').text(), li.find('.ag-rchip').text()])
    expect(states()).toEqual([
      ['Approved guide', 'Approved v2'],
      ['Guide in review', 'In review'],
      ['Edited guide', 'Draft'],
      ['Never reviewed', 'Draft'],
    ])
    const select = wrapper.find('.ag-arts-filter select')
    expect(select.findAll('option').map((o) => o.text())).toEqual(['All', 'Draft', 'In review', 'Changes requested', 'Approved'])
    await select.setValue('draft')
    expect(states().map(([title]) => title)).toEqual(['Edited guide', 'Never reviewed'])
    await select.setValue('approved')
    expect(states().map(([title]) => title)).toEqual(['Approved guide'])
    await select.setValue('changes_requested')
    expect(wrapper.findAll('li.ag-art')).toHaveLength(0)
    expect(wrapper.text()).toContain('No documents match "Changes requested".')
    // Filtering is local: the list was read once.
    expect(fakeAgent.loadArtifacts).toHaveBeenCalledTimes(1)
  })

  it('searches after a pause and says when nothing matches', async () => {
    const { wrapper } = await setup('agent-reports', ['report'])
    vi.useFakeTimers()
    await wrapper.find('input[type="search"]').setValue('turonote')
    vi.advanceTimersByTime(300)
    vi.useRealTimers()
    await flushPromises()
    expect(fakeAgent.loadArtifacts).toHaveBeenLastCalledWith(['report'], 'turonote')
    expect(wrapper.text()).toContain('No reports match "turonote".')
  })

  it('shows the error with a retry', async () => {
    fakeAgent.loadArtifacts = vi.fn(async () => {
      throw Object.assign(new Error('x'), { name: 'AgentError', message: 'The agent is temporarily unavailable.' })
    })
    const { wrapper } = await setup('agent-reports', ['report'])
    expect(wrapper.text()).toContain("Couldn't load reports.")
    expect(wrapper.text()).toContain('The agent is temporarily unavailable.')
    fakeAgent.loadArtifacts = vi.fn(async () => [])
    await wrapper.find('.ag-empty button').trigger('click')
    await flushPromises()
    expect(fakeAgent.loadArtifacts).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('No reports yet.')
  })
})
