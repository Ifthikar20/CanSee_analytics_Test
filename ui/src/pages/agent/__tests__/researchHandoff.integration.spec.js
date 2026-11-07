// End-to-end wiring around the research agents' pages (swarm_frontend.md 11
// and 12): onboarding hands its first research to the agent chat, which
// sends it with the research agent; the Findings page lists, changes and
// links findings through the real findings store; "Open in chat" reopens a
// finding's capture in the chat's pane. The stores, the composables and the
// pages are real. Only the network (api client, agentApi), the run transport
// and the chat column's own components are replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))

vi.mock('@/api/agent', () => ({
  default: {
    status: vi.fn(),
    agents: vi.fn(),
    listChats: vi.fn(),
    createChat: vi.fn(),
    getChat: vi.fn(),
    updateChat: vi.fn(),
    deleteChat: vi.fn(),
    saveReport: vi.fn(),
    getContext: vi.fn(),
    createContextEntry: vi.fn(),
    suggestions: vi.fn(),
    activity: vi.fn(),
    getSwarm: vi.fn(),
    getSwarmVersion: vi.fn(),
    listFindings: vi.fn(),
    createFindings: vi.fn(),
    updateFinding: vi.fn(),
    deleteFinding: vi.fn(),
    sendMessage: vi.fn(),
    rerunSwarm: vi.fn(),
    cancelRun: vi.fn(),
  },
}))

vi.mock('@/lib/agent/runManager', () => ({
  createRunManager() {
    const sessions = new Set()
    return {
      attach: (run) => sessions.add(String(run.id)) && run,
      detach: (id) => sessions.delete(String(id)),
      detachAll: () => sessions.clear(),
      isAttached: (id) => sessions.has(String(id)),
    }
  },
}))

vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

// The chat column and the pane have their own specs; the page only wires
// them, so they render as markers here.
vi.mock('@/components/agent/chat/ChatPane.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'ChatPane',
      props: ['websiteId', 'chatId', 'projectName', 'initialAgent', 'paneDomId'],
      emits: ['created'],
      setup: (props) => () => vue.h('div', { class: 'chat-stub', 'data-chat': props.chatId || 'new' }),
    }),
  }
})
vi.mock('@/components/agent/browser/BrowserPane.vue', async () => {
  const vue = await import('vue')
  return { default: vue.defineComponent({ name: 'BrowserPane', props: ['layout'], setup: () => () => vue.h('aside') }) }
})
vi.mock('@/components/agent/workspace/AgentWorkspaceSplit.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'AgentWorkspaceSplit',
      setup: (_, { slots }) => () => vue.h('div', [slots.chat?.({ layout: 'split' }), slots.pane?.({ layout: 'split' })]),
    }),
  }
})

import agentApi from '@/api/agent'
import { provideOnboardingFlow } from '@/components/onboarding/useOnboardingFlow'
import { useFirstResearch } from '@/composables/agent/useFirstResearch'
import AgentChatPage from '@/pages/agent/AgentChatPage.vue'
import AgentFindingsPage from '@/pages/agent/AgentFindingsPage.vue'
import { useAgentStore } from '@/stores/agent'
import { useAgentFindingsStore } from '@/stores/agentFindings'
import { useAgentPaneStore } from '@/stores/agentPane'
import { useAuthStore } from '@/stores/auth'
import {
  CAPTURE_ID,
  PROMPT,
  SERP_CAPTURE,
  SWARM_ID,
  SWARM_MESSAGE_ID,
  expectedSwarmPart,
  swarmAssistant,
  swarmTable,
} from '@/lib/agent/__tests__/__fixtures__/swarmEvents'

enableAutoUnmount(afterEach)

const WID = '5'
const CHAT_ID = 'c1d2...'
const NEW_CHAT_ID = 'c-first'
const SERP_TAB = `serp:${CAPTURE_ID}`

const STATUS = {
  enabled: true,
  configured: true,
  live_available: true,
  serp_configured: true,
  model: 'claude-opus-5-5',
  engines: [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
  ],
  allowance: { cap_usd: 10, spent_usd: 2.5, exceeded: false, warning: false },
  swarm: { enabled: true, max_agents: 30, worker_model: 'claude-haiku-5-5' },
}

const SCAN = {
  url: 'https://notion.so',
  success: true,
  error: null,
  business_name: 'Notion',
  domain: 'notion.so',
  industry: 'Software',
  description_short: 'Notion is one workspace for docs, wikis and projects.',
  description_raw: '',
  products: ['Docs', 'Wikis'],
  topics: [PROMPT, 'notion alternatives for startups', 'how to organize team documentation', 'team wiki software'],
  topics_source: 'ai',
  missing_keys: [],
  competitors: [{ name: 'Evernote', domain: 'evernote.com' }],
}

const ok = (data) => ({ success: true, data })
const Blank = defineComponent({ render: () => h('div') })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/paywall', component: Blank },
      { path: '/billing', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: AgentChatPage, props: true },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: AgentChatPage, props: true },
      { path: '/projects/:websiteId/agent/findings', name: 'agent-findings', component: AgentFindingsPage, props: true },
    ],
  })
}

// The signed-in user, the agent's status and an empty chat list.
function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.accessToken = 'token'
  auth.user = { id: 7 }
  agentApi.status.mockResolvedValue(ok(STATUS))
  agentApi.listChats.mockResolvedValue(ok({ results: [], next_cursor: null }))
  agentApi.agents.mockResolvedValue(ok([{ key: 'gap_analyst', name: 'Gap Analyst', output_kind: 'report' }]))
  agentApi.suggestions.mockResolvedValue(ok([]))
  return { pinia, router: makeRouter() }
}

async function mountApp({ pinia, router }, path) {
  await router.push(path)
  await router.isReady()
  const App = defineComponent({ render: () => h(RouterView) })
  const wrapper = mount(App, { global: { plugins: [pinia, router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

function finding(fields = {}) {
  const draft = swarmTable(1).sheets[0].rows[0].finding
  return {
    id: 'f1',
    title: draft.title,
    detail: draft.detail,
    category: 'engines',
    category_label: 'AI engines (GEO)',
    severity: 'high',
    status: 'open',
    prompt_text: PROMPT,
    evidence: draft.evidence,
    source: {
      swarm_id: SWARM_ID,
      swarm_title: 'Research Notion',
      version: 1,
      sheet: 'prompts',
      row_key: 'p1',
      task_ids: ['engines.p1.chatgpt'],
      chat_id: CHAT_ID,
      message_id: SWARM_MESSAGE_ID,
    },
    created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    updated_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    created_by_name: 'Site Owner',
    status_changed_at: null,
    status_changed_by_name: null,
    ...fields,
  }
}

function researchChat() {
  return {
    id: CHAT_ID,
    title: 'Research Notion',
    title_source: 'model',
    preview: '',
    created_at: '2026-11-04T10:15:00Z',
    last_message_at: '2026-11-04T10:17:40Z',
    current_leaf_id: SWARM_MESSAGE_ID,
    messages: [
      {
        id: 'u1',
        chat_id: CHAT_ID,
        parent_id: null,
        role: 'user',
        status: 'complete',
        parts: [{ id: 'u1-text', type: 'text', text: 'Research Notion' }],
        parts_seq: 0,
        sibling_ids: ['u1'],
      },
      swarmAssistant({
        status: 'complete',
        parts_seq: 145,
        parts: [expectedSwarmPart()],
        research: { serp: { [CAPTURE_ID]: SERP_CAPTURE }, pages: {} },
      }),
    ],
    active_run: null,
  }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  Object.values(client).forEach((fn) => fn.mockReset())
  Object.values(agentApi).forEach((fn) => fn.mockReset())
  Object.values(toast).forEach((fn) => fn.mockReset())
})

describe('first research: onboarding to the agent chat', () => {
  it('saves the project, stashes the first message and the chat sends it with the research agent', async () => {
    const ctx = setup()
    client.post.mockImplementation((url) => {
      if (url === '/onboarding/scan/') return Promise.resolve({ data: { ...SCAN } })
      if (url === '/onboarding/save/') return Promise.resolve({ data: { website_id: WID, name: 'Notion' } })
      return Promise.reject(new Error(`unexpected POST ${url}`))
    })
    client.get.mockImplementation((url) => {
      if (url === '/auth/session/') return Promise.resolve({ data: { next_route: 'dashboard', user: { id: 7 } } })
      if (url === '/websites/') return Promise.resolve({ data: [{ id: WID, name: 'Notion' }] })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })
    agentApi.getContext.mockResolvedValue(ok({ entries: [], totals: { entries: 0, suggested: 0, references: 0 } }))
    agentApi.createContextEntry.mockImplementation(async (wid, body) => ok({ id: 'e1', ...body }))
    agentApi.createChat.mockResolvedValueOnce(
      ok({ id: NEW_CHAT_ID, title: '', title_source: 'auto', messages: [], current_leaf_id: null, active_run: null })
    )
    agentApi.sendMessage.mockResolvedValueOnce(
      ok({
        user_message: { id: 'u-first', chat_id: NEW_CHAT_ID, parent_id: null, role: 'user', status: 'complete', parts: [] },
        assistant_message: { id: 'a-first', chat_id: NEW_CHAT_ID, parent_id: 'u-first', role: 'assistant', status: 'streaming', parts: [] },
        run: { id: 'run-first', chat_id: NEW_CHAT_ID, message_id: 'a-first', status: 'queued', last_seq: 0 },
      })
    )

    const wrapper = await mountApp(ctx, '/')
    // The onboarding flow, as its shell provides it, in the same app.
    const onComplete = vi.fn()
    let flow
    const Onboarding = defineComponent({
      setup() {
        flow = provideOnboardingFlow({ onComplete })
        return () => h('div')
      },
    })
    mount(Onboarding, { global: { plugins: [ctx.pinia, ctx.router] } })

    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    flow.form.value.prompts = flow.form.value.prompts.map((p, i) => ({ ...p, selected: i < 2 }))
    flow.form.value.audience = 'Operations leads at growing companies'
    await flow.loadAgentStatus()
    expect(flow.availability.value).toBe('available')

    await flow.startResearch()
    await flushPromises()

    const text = [
      'Research Notion (notion.so) on Google and the AI engines for these prompts:',
      `1. ${PROMPT}`,
      '2. notion alternatives for startups',
      'Search from United States (us).',
      'Competitors to compare: Evernote (evernote.com).',
    ].join('\n')
    const save = client.post.mock.calls.find(([url]) => url === '/onboarding/save/')
    expect(save[1]).toMatchObject({
      business_name: 'Notion',
      keywords: [PROMPT, 'notion alternatives for startups'],
      competitors: [{ name: 'Evernote', domain: 'evernote.com' }],
    })
    expect(agentApi.createContextEntry).toHaveBeenCalledWith(WID, {
      section: 'audience',
      title: 'Audience',
      body: 'Operations leads at growing companies',
      references: [],
    })
    expect(onComplete).toHaveBeenCalled()

    // The chat page took the stash once and sent it as a new chat.
    expect(agentApi.createChat).toHaveBeenCalledWith(WID, { entry_agent: 'gap_analyst' }, { _silentError: true })
    const [wid, cid, body, options] = agentApi.sendMessage.mock.calls[0]
    expect([wid, cid]).toEqual([WID, NEW_CHAT_ID])
    expect(body).toMatchObject({ text, agent: 'gap_analyst' })
    expect(options.idempotencyKey).toEqual(expect.any(String))
    expect(ctx.router.currentRoute.value).toMatchObject({ name: 'agent-chat', params: { websiteId: WID, chatId: NEW_CHAT_ID } })
    expect(ctx.router.currentRoute.value.query).toEqual({})
    expect(useFirstResearch().peek(WID)).toBeNull()
    expect(useAgentStore().isChatBusy(NEW_CHAT_ID)).toBe(true)
    expect(wrapper.find('.chat-stub').attributes('data-chat')).toBe(NEW_CHAT_ID)
  })
})

describe('findings: the page and the way back to the chat', () => {
  it('lists the project findings, marks one done and opens its evidence in the chat', async () => {
    const ctx = setup()
    agentApi.listFindings.mockResolvedValueOnce(
      ok({ results: [finding()], next_cursor: null, counts: { open: 1, done: 0, dismissed: 0 }, can_edit: true })
    )
    const wrapper = await mountApp(ctx, `/projects/${WID}/agent/findings`)
    const store = useAgentFindingsStore()
    expect(agentApi.listFindings).toHaveBeenCalledWith(
      WID,
      { status: 'open', category: '', severity: '', q: '', cursor: undefined },
      { _silentError: true }
    )
    const row = wrapper.find('li.ag-fr')
    expect(row.find('.ag-fr-title').text()).toContain(finding().title)
    expect(row.find('.ag-fr-meta').text()).toContain(`AI engines (GEO) · “${PROMPT}” · From Research Notion v1`)
    const seg = wrapper.findAll('.ag-fp-seg-item').map((b) => b.text().replace(/\s+/g, ' '))
    expect(seg).toEqual(['Open 1', 'Done 0', 'Dismissed 0', 'All'])

    // Mark done: the row leaves the Open tab and the counts follow.
    agentApi.updateFinding.mockResolvedValueOnce(
      ok(finding({ status: 'done', status_changed_at: new Date().toISOString(), status_changed_by_name: 'Site Owner' }))
    )
    await row.find(`button[aria-label="Mark done: ${finding().title}"]`).trigger('click')
    await flushPromises()
    expect(agentApi.updateFinding).toHaveBeenCalledWith(WID, 'f1', { status: 'done' }, { _silentError: true })
    expect(store.counts).toEqual({ open: 0, done: 1, dismissed: 0 })
    expect(wrapper.find('li.ag-fr').exists()).toBe(false)
    expect(wrapper.text()).toContain('No open findings.')

    // The Done tab lists it with its evidence and the way back to the chat.
    agentApi.listFindings.mockResolvedValueOnce(
      ok({ results: [finding({ status: 'done' })], next_cursor: null, counts: { open: 0, done: 1, dismissed: 0 }, can_edit: true })
    )
    await wrapper.findAll('.ag-fp-seg-item').find((b) => b.text().startsWith('Done')).trigger('click')
    await flushPromises()
    expect(agentApi.listFindings).toHaveBeenLastCalledWith(
      WID,
      { status: 'done', category: '', severity: '', q: '', cursor: undefined },
      { _silentError: true }
    )
    await wrapper.find('li.ag-fr .ag-fr-title').trigger('click')
    const open = wrapper.find(`a[aria-label="Open Google page 1 · you're #4 in chat"]`)
    expect(open.attributes('href')).toBe(`/projects/${WID}/agent/c/${CHAT_ID}?tab=${SERP_TAB}`)

    // Following it loads the chat, opens the capture in its pane and drops the query.
    agentApi.getChat.mockResolvedValueOnce(ok(researchChat()))
    await open.trigger('click')
    await flushPromises()
    await flushPromises()
    const pane = useAgentPaneStore()
    expect(ctx.router.currentRoute.value).toMatchObject({ name: 'agent-chat', params: { chatId: CHAT_ID } })
    expect(ctx.router.currentRoute.value.query).toEqual({})
    expect(pane.chatKey).toBe(CHAT_ID)
    expect(pane.activeId).toBe(SERP_TAB)
    expect(pane.activeTab).toMatchObject({ kind: 'serp', status: 'ready' })
    expect(pane.open).toBe(true)
  })

  it('turns read-only for a viewer, whatever the table offered', async () => {
    const ctx = setup()
    agentApi.listFindings.mockResolvedValueOnce(
      ok({ results: [finding()], next_cursor: null, counts: { open: 1, done: 0, dismissed: 0 }, can_edit: false })
    )
    const wrapper = await mountApp(ctx, `/projects/${WID}/agent/findings`)
    expect(wrapper.text()).toContain('You can view findings but not change them.')
    expect(wrapper.find('li.ag-fr input[type="checkbox"]').exists()).toBe(false)
    expect(wrapper.find('li.ag-fr .ag-fr-actions').exists()).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'New finding')).toBe(false)
    expect(useAgentFindingsStore().canEdit).toBe(false)
  })
})
