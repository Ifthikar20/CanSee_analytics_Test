import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import replySource from '../AssistantMessage.vue?raw'

const fakeAgent = reactive({})
const fakePane = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => fakePane }))

const { default: AssistantMessage } = await import('@/components/agent/message/AssistantMessage.vue')
const { default: SwarmBlock } = await import('@/components/agent/swarm/SwarmBlock.vue')
const { default: SwarmTable } = await import('@/components/agent/swarm/SwarmTable.vue')
const { finishedPart, tablePart } = await import('@/components/agent/swarm/__tests__/__fixtures__/swarmParts.js')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

function mountReply(props, extraStubs = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/billing', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
    ],
  })
  return mount(AssistantMessage, {
    props: { websiteId: 'w1', ...props },
    global: {
      plugins: [pinia, router],
      stubs: { WorkedLabel: true, MessageActions: true, MarkdownBlock: true, ChartBlock: true, ...extraStubs },
    },
  })
}

// The agent_call part as translate.py adds it when run_agent starts
// streaming: the agent, title and kind are only known once its input ends.
function callPart(fields = {}) {
  return {
    id: 'p1',
    type: 'agent_call',
    agent: null,
    agent_name: null,
    status: 'preparing',
    artifact_id: null,
    version: null,
    title: null,
    kind: null,
    summary: '',
    error: null,
    ...fields,
  }
}

function reply(fields = {}) {
  return { id: 'm1', chat_id: 'c1', role: 'assistant', status: 'complete', parts: [], ...fields }
}

beforeEach(() => {
  Object.assign(fakeAgent, { artifact: () => null, regenerate: vi.fn(async () => null) })
  Object.assign(fakePane, { open: false, activeId: null, setReturnFocus: vi.fn(), openArtifact: vi.fn() })
})

describe('AssistantMessage sub-agent card', () => {
  it('does not name a kind while the call has no agent yet', async () => {
    const w = mountReply({ message: reply({ status: 'streaming', parts: [callPart()] }), run: { phase: 'running' } })
    const card = w.find('.ag-card')
    expect(card.text()).toContain('Preparing an agent')
    expect(card.text()).toContain('Writing the brief…')
    expect(card.text()).not.toContain('Landing page')

    const named = callPart({ agent: 'ad_campaign', agent_name: 'Ad Campaign Agent' })
    await w.setProps({ message: reply({ status: 'streaming', parts: [named] }) })
    expect(w.find('.ag-card-title').text()).toBe('Sheet')
  })

  it('takes the kind from the catalog for an agent the UI does not list', () => {
    const part = callPart({ agent: 'faq_writer', agent_name: 'FAQ Writer', status: 'drafting' })
    const w = mountReply({
      message: reply({ status: 'streaming', parts: [part] }),
      run: { phase: 'running' },
      catalog: [{ key: 'faq_writer', name: 'FAQ Writer', output_kind: 'document' }],
    })
    expect(w.find('.ag-card-title').text()).toBe('Document')
  })
})

describe('AssistantMessage Retry', () => {
  it('offers no Retry when run.failed said trying again cannot help', () => {
    const w = mountReply({
      message: reply({ status: 'failed', error_code: 'new_backend_code', error_message: 'Not this time.' }),
      run: { phase: 'failed', error: { code: 'new_backend_code', message: 'Not this time.', retryable: false } },
    })
    expect(w.find('.ag-msg-error').text()).toContain('Not this time.')
    expect(w.find('.ag-msg-error-btn').exists()).toBe(false)
  })

  it('offers no Retry for a reloaded reply that hit its cost limit', () => {
    const w = mountReply({
      message: reply({ status: 'failed', error_code: 'run_cost_limit', error_message: 'This reply reached the $3.00 cost limit for one reply.' }),
    })
    expect(w.find('.ag-msg-error').exists()).toBe(true)
    expect(w.find('.ag-msg-error-btn').exists()).toBe(false)
  })

  it('keeps Retry for a reply whose stream was lost', async () => {
    const w = mountReply({
      message: reply({ status: 'interrupted', error_code: 'not_found', error_message: "We couldn't find that." }),
      run: { phase: 'failed', error: { code: 'not_found', message: "We couldn't find that.", retryable: false } },
    })
    await w.find('.ag-msg-error-btn').trigger('click')
    expect(fakeAgent.regenerate).toHaveBeenCalledWith('m1')
  })
})

describe('AssistantMessage research agents', () => {
  const stubs = { SwarmBlock: true, SwarmTable: true }
  const toolPart = { id: 'p1', type: 'tool', name: 'list_tracked_prompts', label: 'Listed tracked prompts', status: 'done', summary: '' }

  it('shows the research agents between the steps and the reply, and the table in body order', () => {
    const swarm = finishedPart()
    const table = tablePart()
    const text = { id: 'p6', type: 'text', text: '# Research Notion' }
    const message = reply({ parts: [toolPart, swarm, table, text] })
    const w = mountReply({ message, busy: true }, stubs)

    const children = [...w.find('article').element.children].map((el) => el.className)
    const steps = children.findIndex((c) => c.includes('ag-steps'))
    const swarms = children.findIndex((c) => c.includes('ag-assistant-swarms'))
    const body = children.findIndex((c) => c.includes('ag-assistant-body'))
    expect(steps).toBeGreaterThanOrEqual(0)
    expect(swarms).toBeGreaterThan(steps)
    expect(body).toBeGreaterThan(swarms)

    const block = w.findComponent(SwarmBlock)
    expect(block.props()).toMatchObject({ part: swarm, message, live: false, websiteId: 'w1', busy: true })

    const bodyKids = [...w.find('.ag-assistant-body').element.children].map((el) => el.tagName.toLowerCase())
    expect(bodyKids).toEqual(['swarm-table-stub', 'markdown-block-stub'])
    expect(w.findComponent(SwarmTable).props()).toMatchObject({ part: table, message, mode: 'inline', busy: true })
  })

  it('renders one block per swarm part and none without one', () => {
    const rerun = finishedPart({ id: 'p7', version: 2, scope: 'category', scope_label: 'Google (SEO)' })
    const w = mountReply({ message: reply({ parts: [finishedPart(), rerun] }) }, stubs)
    expect(w.findAllComponents(SwarmBlock)).toHaveLength(2)

    const plain = mountReply({ message: reply({ parts: [{ id: 'p1', type: 'text', text: 'Hi' }] }) }, stubs)
    expect(plain.find('.ag-assistant-swarms').exists()).toBe(false)
  })
})

describe('AssistantMessage layout', () => {
  // jsdom lays nothing out, so the rule is read from the source. Without it
  // the body's implicit grid column took a wide table's width, and on a
  // phone every paragraph of the reply ran past the screen's edge.
  it('keeps the reply body to one column no wider than the reply', () => {
    const rule = replySource.match(/\.ag-assistant-body \{[^}]*\}/)?.[0] || ''
    expect(rule).toContain('display: grid;')
    expect(rule).toContain('grid-template-columns: minmax(0, 1fr);')
  })
})
