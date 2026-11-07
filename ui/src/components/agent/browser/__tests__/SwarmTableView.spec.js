import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, reactive } from 'vue'

vi.mock('@/stores/agent', async () => {
  const m = await import('./__fixtures__/stores.js')
  return { useAgentStore: m.useAgentStore }
})
vi.mock('@/stores/auth', async () => {
  const m = await import('./__fixtures__/stores.js')
  return { useAuthStore: m.useAuthStore }
})
vi.mock('@/stores/agentFindings', async () => {
  const m = await import('./__fixtures__/stores.js')
  return { useAgentFindingsStore: m.useAgentFindingsStore }
})
const fakePane = reactive({})
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => fakePane }))
vi.mock('@/composables/agent/useBrowse', () => ({ useBrowse: () => ({ load: () => {} }) }))
vi.mock('@/lib/agent/download', async (importOriginal) => ({ ...(await importOriginal()), downloadText: vi.fn() }))

const { default: SwarmTableView } = await import('../views/SwarmTableView.vue')
const { default: PaneHeader } = await import('../PaneHeader.vue')
const { useAgentStore } = await import('@/stores/agent')
const { downloadText } = await import('@/lib/agent/download')
const { SWARM_ID, swarmTable, tablePart } = await import('../../swarm/__tests__/__fixtures__/swarmParts.js')

enableAutoUnmount(afterEach)

const TAB_ID = `table:${SWARM_ID}`

const Harness = defineComponent({
  props: { tab: { type: Object, required: true } },
  setup(props) {
    return () => h('div', [h(PaneHeader, { tab: props.tab }), h('div', { style: 'position: relative' }, [h(SwarmTableView, { tab: props.tab })])])
  },
})

function versionSummary(version, fields = {}) {
  return {
    version,
    scope: 'all',
    scope_label: 'All agents',
    status: 'done',
    counts: { total: 7, done: 7, failed: 0, skipped: 0, stopped: 0 },
    started_at: '2026-11-04T10:15:04Z',
    finished_at: '2026-11-04T10:17:18Z',
    duration_ms: 134201,
    message_id: `m${version}`,
    run_id: `run-${version}`,
    has_table: true,
    ...fields,
  }
}

function detail(fields = {}) {
  return {
    id: SWARM_ID,
    title: 'Research Notion',
    chat_id: 'c1',
    message_id: 'm1',
    created_at: '2026-11-04T10:15:00Z',
    latest_version: 2,
    prompts: [{ key: 'p1', prompt_id: 'pr1', text: 'best note taking app for teams', location: 'us' }],
    categories: [{ key: 'google', label: 'Google (SEO)', task_ids: ['google.p1.page1'] }],
    tasks: [{ id: 'google.p1.page1', category: 'google', subcategory: 'p1', worker: 'serp_page', label: 'Google page 1' }],
    versions: [
      versionSummary(3, { status: 'interrupted', has_table: false }),
      versionSummary(2, { scope: 'category', scope_label: 'Google (SEO)', status: 'partial' }),
      versionSummary(1),
    ],
    ...fields,
  }
}

function tableVersion(version) {
  return {
    swarm_id: SWARM_ID,
    version,
    scope: 'all',
    scope_label: 'All agents',
    status: 'done',
    counts: {},
    started_at: null,
    finished_at: null,
    duration_ms: null,
    message_id: `m${version}`,
    table: swarmTable({ version }),
  }
}

let agent
let tab

beforeEach(() => {
  setActivePinia(createPinia())
  agent = useAgentStore()
  tab = reactive({ id: TAB_ID, kind: 'table', swarmId: SWARM_ID, version: null, title: 'Research Notion', status: 'ready' })
  for (const key of Object.keys(fakePane)) delete fakePane[key]
  Object.assign(fakePane, {
    updateTab: vi.fn((id, patch) => Object.assign(tab, patch)),
    openTable: vi.fn(),
    openCapture: vi.fn(),
    openUrl: vi.fn(),
    openArtifact: vi.fn(),
    setReturnFocus: vi.fn(),
    titleOf: () => 'Research Notion',
  })
  downloadText.mockClear()
})

function render() {
  return mount(Harness, { props: { tab }, attachTo: document.body })
}

const swarmCalls = () => agent.loadCalls.filter((c) => c[0] === 'swarm' || c[0] === 'version')
const menuItems = () => [...document.body.querySelectorAll('[role="menuitem"]')]

describe('SwarmTableView', () => {
  it('shows the table of a message the chat holds, without asking the API', async () => {
    agent.messages.m2 = { id: 'm2', chat_id: 'c1', role: 'assistant', status: 'complete', parts: [tablePart()] }
    const w = render()
    await flushPromises()
    expect(w.find('.ag-st.is-pane').exists()).toBe(true)
    expect(w.find('.ag-st-chip').text()).toBe('v2')
    expect(w.findAll('.ag-sta button').map((b) => b.text())).toContain('Add to report')
    expect(swarmCalls()).toEqual([])
    expect(w.find('.ag-ph-title-text').text()).toBe('Research results')
    expect(w.find('.ag-ph-sub').text()).toBe('Research Notion')
  })

  it('loads the latest table from the API when the chat does not hold it', async () => {
    agent.swarmApi.details[SWARM_ID] = detail({ latest_version: 3 })
    agent.swarmApi.versions[`${SWARM_ID}:3`] = tableVersion(3)
    const w = render()
    expect(w.find('.ag-stv-skeleton').exists()).toBe(true)
    expect(w.findAll('.ag-stv-bar')).toHaveLength(5)
    await flushPromises()
    expect(swarmCalls()).toEqual([
      ['swarm', SWARM_ID],
      ['version', SWARM_ID, 3],
    ])
    expect(w.find('.ag-st-chip').text()).toBe('v3')
    // The message that shows it is not loaded: no Add to report, but the
    // research can still be re-run in its chat.
    const labels = w.findAll('.ag-sta button').map((b) => b.text())
    expect(labels).not.toContain('Add to report')
    expect(labels).toContain('Re-run')
  })

  it('switches versions from the pane header', async () => {
    agent.messages.m2 = { id: 'm2', chat_id: 'c1', role: 'assistant', status: 'complete', parts: [tablePart()] }
    agent.swarmApi.details[SWARM_ID] = detail()
    agent.swarmApi.versions[`${SWARM_ID}:1`] = tableVersion(1)
    const w = render()
    await flushPromises()
    const trigger = w.find('.ag-ph-ver')
    expect(trigger.text()).toBe('v2')
    expect(trigger.attributes('aria-label')).toBe('Version 2, latest. Choose a version')

    await trigger.trigger('click')
    await flushPromises()
    await nextTick()
    // Versions without a table are left out.
    const labels = menuItems().map((el) => el.textContent.trim())
    expect(labels).toHaveLength(2)
    expect(labels[0]).toMatch(/^Version 2 · Google \(SEO\) · Partial · /)
    expect(labels[1]).toMatch(/^Version 1 · All agents · Done · /)
    menuItems()[1].click()
    await flushPromises()
    expect(fakePane.updateTab).toHaveBeenCalledWith(TAB_ID, { version: 1 })
    expect(swarmCalls()).toContainEqual(['version', SWARM_ID, 1])
    expect(w.find('.ag-st-chip').text()).toBe('v1')
    expect(w.find('.ag-st-chip.is-newer').text()).toBe('Newer: v2')

    await w.find('.ag-st-chip.is-newer').trigger('click')
    expect(fakePane.updateTab).toHaveBeenLastCalledWith(TAB_ID, { version: null })
    await flushPromises()
    expect(w.find('.ag-st-chip').text()).toBe('v2')
  })

  it('exports each sheet of the table as CSV from the header', async () => {
    agent.messages.m2 = { id: 'm2', chat_id: 'c1', role: 'assistant', status: 'complete', parts: [tablePart()] }
    const w = render()
    await flushPromises()
    await w.find('.ag-ph-export').trigger('click')
    await flushPromises()
    await nextTick()
    expect(menuItems().map((el) => el.textContent.trim())).toEqual(['CSV · Prompts', 'CSV · Content gaps'])
    menuItems()[1].click()
    await flushPromises()
    const [text, name] = downloadText.mock.calls[0]
    expect(name).toBe('Research Notion v2 Content gaps.csv')
    expect(text).toContain('No comparison with alternatives')
  })

  it('says when the table is gone', async () => {
    agent.swarmApi.details[SWARM_ID] = detail()
    agent.swarmApi.failures[`version:${SWARM_ID}:2`] = { status: 404, code: 'not_found', message: 'Not found.' }
    const w = render()
    await flushPromises()
    expect(w.find('.ag-stv-text').text()).toBe('This table is no longer available.')
    expect(w.find('.ag-stv-note button').exists()).toBe(false)
  })

  it('offers Retry when the table could not be loaded', async () => {
    agent.swarmApi.details[SWARM_ID] = detail()
    agent.swarmApi.failures[`version:${SWARM_ID}:2`] = { status: 500, code: 'server_error', message: 'Boom.' }
    const w = render()
    await flushPromises()
    expect(w.find('.ag-stv-text').text()).toBe('The table could not be loaded.')
    delete agent.swarmApi.failures[`version:${SWARM_ID}:2`]
    agent.swarmApi.versions[`${SWARM_ID}:2`] = tableVersion(2)
    await w.find('.ag-stv-note button').trigger('click')
    await flushPromises()
    expect(w.find('.ag-st-chip').text()).toBe('v2')
  })

  it('says the table is gone when the research no longer exists', async () => {
    agent.swarmApi.failures[`swarm:${SWARM_ID}`] = { status: 404, code: 'not_found', message: 'Not found.' }
    const w = render()
    await flushPromises()
    expect(w.find('.ag-stv-text').text()).toBe('This table is no longer available.')
    expect(w.find('.ag-ph-export').attributes('aria-disabled')).toBe('true')
  })
})
