// End-to-end wiring of the research agents (design/swarm_contract.md 4 to 6,
// swarm_frontend.md 5 to 10): the contract's event sequence goes through the
// real agent store (reducer, run state, research store), and the real chat
// thread, swarm block, results table, browser pane and findings store render
// it and act on it. Only the network (agentApi) and the run transport
// (runManager) are replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const rm = vi.hoisted(() => ({ attached: [] }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  authHeaders: () => ({}),
  refreshAccessToken: async () => '',
}))

vi.mock('@/api/agent', () => ({
  default: {
    status: vi.fn(),
    agents: vi.fn(),
    listChats: vi.fn(),
    createChat: vi.fn(),
    getChat: vi.fn(),
    updateChat: vi.fn(),
    deleteChat: vi.fn(),
    feedback: vi.fn(),
    listArtifacts: vi.fn(),
    getArtifact: vi.fn(),
    updateArtifact: vi.fn(),
    deleteArtifact: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    saveReport: vi.fn(),
    getContext: vi.fn(),
    putContext: vi.fn(),
    suggestions: vi.fn(),
    activity: vi.fn(),
    getSwarm: vi.fn(),
    getSwarmVersion: vi.fn(),
    listFindings: vi.fn(),
    createFindings: vi.fn(),
    updateFinding: vi.fn(),
    deleteFinding: vi.fn(),
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    editMessage: vi.fn(),
    continueMessage: vi.fn(),
    rerunSwarm: vi.fn(),
    cancelRun: vi.fn(),
    browse: vi.fn(),
  },
}))

// The transport is replaced: the specs hand the store its events directly.
vi.mock('@/lib/agent/runManager', () => ({
  createRunManager() {
    const sessions = new Set()
    return {
      attach(run) {
        rm.attached.push({ id: run.id, lastSeq: run.lastSeq })
        sessions.add(String(run.id))
        return run
      },
      detach: (id) => sessions.delete(String(id)),
      detachAll: () => sessions.clear(),
      isAttached: (id) => sessions.has(String(id)),
    }
  },
}))

vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('@/lib/agent/download', async (importOriginal) => ({ ...(await importOriginal()), downloadText: vi.fn() }))

import agentApi from '@/api/agent'
import BrowserPane from '@/components/agent/browser/BrowserPane.vue'
import ChatThread from '@/components/agent/chat/ChatThread.vue'
import { downloadText } from '@/lib/agent/download'
import { useAgentStore } from '@/stores/agent'
import { useAgentFindingsStore } from '@/stores/agentFindings'
import { useAgentPaneStore } from '@/stores/agentPane'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAuthStore } from '@/stores/auth'
import {
  CAPTURE_ID,
  PROMPT,
  SERP_CAPTURE,
  SWARM_ID,
  SWARM_MESSAGE_ID,
  SWARM_RUN_ID,
  TABLE_PART_ID,
  expectedSwarmPart,
  swarmAssistant,
  swarmRunEvents,
  swarmTable,
} from '@/lib/agent/__tests__/__fixtures__/swarmEvents'

enableAutoUnmount(afterEach)

const WID = '5'
const CHAT_ID = 'c1d2...'
const USER_ID = 'u1'
const SERP_TAB = `serp:${CAPTURE_ID}`
const TABLE_TAB = `table:${SWARM_ID}`
const RERUN_TEXT = 'Re-run the Google (SEO) agents'
const RERUN_RUN_ID = 'run-2'
const RERUN_USER_ID = 'u2'
const RERUN_MESSAGE_ID = 'a2'
const RERUN_CAPTURE_ID = '9e8d7c6b5a41'

const STATUS = {
  enabled: true,
  configured: true,
  live_available: true,
  model: 'claude-opus-5-5',
  engines: [],
  allowance: null,
  swarm: { enabled: true, max_agents: 30, worker_model: 'claude-haiku-5-5' },
}

const ok = (data) => ({ success: true, data })

const Blank = defineComponent({ render: () => h('div') })
// The report text is the model's Markdown; its renderer is not under test.
const MarkdownStub = defineComponent({
  props: { text: { type: String, default: '' }, streaming: { type: Boolean, default: false } },
  setup: (props) => () => h('div', { class: 'md-stub' }, props.text),
})

// The chat column and the pane as the workspace lays them out, both bound
// to the store: the thread shows the chat's visible path.
const Workspace = defineComponent({
  props: { chatId: { type: String, required: true } },
  setup(props) {
    const store = useAgentStore()
    return () =>
      h('div', { class: 'ws' }, [
        h(ChatThread, {
          chatKey: props.chatId,
          websiteId: WID,
          messages: store.visiblePath(props.chatId),
          busy: store.isChatBusy(props.chatId),
        }),
        h('aside', { class: 'ws-pane' }, [h(BrowserPane, { layout: 'split' })]),
      ])
  },
})

function userMessage(fields = {}) {
  return {
    id: USER_ID,
    chat_id: CHAT_ID,
    parent_id: null,
    role: 'user',
    status: 'complete',
    parts: [{ id: 'u1-text', type: 'text', text: 'Research Notion on Google and the AI engines' }],
    parts_seq: 0,
    sibling_ids: [USER_ID],
    ...fields,
  }
}

function tablePart(version = 1, table = swarmTable(version), fields = {}) {
  return {
    id: TABLE_PART_ID,
    type: 'swarm_table',
    request: 1,
    swarm_id: SWARM_ID,
    version,
    title: 'Research Notion',
    status: table.status,
    generated_at: table.generated_at,
    table,
    ...fields,
  }
}

// The re-run turn of version 2 as a reload finds it: its user message, and
// the reply with the swarm part, its table and the change summary.
function rerunTurn() {
  const [google] = expectedSwarmPart().tasks
  const [googleCategory] = expectedSwarmPart().categories
  return [
    userMessage({
      id: RERUN_USER_ID,
      parent_id: SWARM_MESSAGE_ID,
      sibling_ids: [RERUN_USER_ID],
      parts: [{ id: 'u2-text', type: 'text', text: RERUN_TEXT }],
    }),
    swarmAssistant({
      id: RERUN_MESSAGE_ID,
      parent_id: RERUN_USER_ID,
      sibling_ids: [RERUN_MESSAGE_ID],
      run_id: RERUN_RUN_ID,
      status: 'complete',
      parts_seq: 10,
      parts: [
        {
          ...expectedSwarmPart(),
          id: 'p1',
          request: 0,
          version: 2,
          scope: 'category',
          scope_label: 'Google (SEO)',
          status: 'done',
          started_at: '2026-11-04T11:02:00.190Z',
          ended_at: '2026-11-04T11:02:09.190Z',
          duration_ms: 9000,
          table_version: 2,
          categories: [googleCategory],
          tasks: [{ ...google, result: "You're #3 · AI Overview shown", rev: 3 }],
        },
        { ...tablePart(2, versionTwoTable()), id: 'p2', request: 0 },
        { id: 'p3', type: 'text', request: 0, text: 'Google now ranks you #3 for this prompt (was #4).' },
      ],
    }),
  ]
}

// The chat while the research runs (parts checkpointed at seq 40), or as a
// reload finds it once the turn has ended (and, with `rerun`, once version
// 2 has run too).
function chatDetail({ finished = false, rerun = false } = {}) {
  const assistant = finished
    ? swarmAssistant({
        status: 'complete',
        parts_seq: 145,
        parts: [expectedSwarmPart(), tablePart(1), { id: 'p6', type: 'text', request: 2, text: '# Notion on Google and AI', citations: [] }],
        research: { serp: { [CAPTURE_ID]: SERP_CAPTURE }, pages: {} },
      })
    : swarmAssistant()
  const messages = [userMessage(), assistant, ...(rerun ? rerunTurn() : [])]
  return {
    id: CHAT_ID,
    title: 'Research Notion',
    title_source: 'model',
    preview: '',
    created_at: '2026-11-04T10:15:00Z',
    last_message_at: '2026-11-04T10:15:00Z',
    current_leaf_id: messages[messages.length - 1].id,
    messages,
    active_run: finished ? null : { id: SWARM_RUN_ID, status: 'running', message_id: SWARM_MESSAGE_ID, last_seq: 40 },
  }
}

// The workspace on the chat: the store scoped to the project, the pane bound
// to the chat, and the chat loaded from `detail`.
async function openWorkspace({ finished = false, rerun = false, detail = null } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.accessToken = 'token'
  auth.user = { id: 7 }
  agentApi.status.mockResolvedValue(ok(STATUS))
  agentApi.listChats.mockResolvedValue(ok({ results: [], next_cursor: null }))
  agentApi.agents.mockResolvedValue(ok([{ key: 'gap_analyst', name: 'Gap Analyst', output_kind: 'report' }]))
  const store = useAgentStore()
  await store.init(WID)
  const pane = useAgentPaneStore()
  pane.bindChat(CHAT_ID)
  agentApi.getChat.mockResolvedValueOnce(ok(detail || chatDetail({ finished: finished || rerun, rerun })))
  await store.openChat(CHAT_ID)

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/billing', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: Blank },
      { path: '/projects/:websiteId/agent/findings', name: 'agent-findings', component: Blank },
      { path: '/projects/:websiteId/agent/artifacts/:artifactId', name: 'agent-artifact', component: Blank },
    ],
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(Workspace, {
    props: { chatId: CHAT_ID },
    global: { plugins: [pinia, router], stubs: { MarkdownBlock: MarkdownStub } },
    attachTo: document.body,
  })
  await flushPromises()
  return { wrapper, store, pane, router, ui: useAgentUiStore(), findings: useAgentFindingsStore() }
}

async function feed(store, runId, events) {
  store.applyEvents(runId, events)
  await flushPromises()
  await nextTick()
}

/* ── DOM helpers ── */

const thread = (w) => w.find('.ag-thread')
const blocks = (w) => thread(w).findAll('section.ag-swarm')
const inlineTables = (w) => thread(w).findAll('section.ag-st')
const paneTable = (w) => w.find('.ws-pane section.ag-st')
const headerOf = (block) => block.find('.ag-swarm-title').text()
const rowOf = (block, label) =>
  block.findAll('.ag-swarm-row').find((r) => r.find('.ag-swarm-row-label').text() === label) || null
const lineOf = (block, label) => rowOf(block, label).find('.ag-swarm-row-text')
const cellOf = (table, column) => table.find(`tbody .is-col-${column} .ag-st-cell`)
const buttonIn = (root, text) => root.findAll('button').find((b) => b.text().trim() === text) || null

function menuItem(text) {
  return [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes(text)) || null
}

/* ── Findings and the re-run turn ── */

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
    created_at: '2026-11-04T10:20:00Z',
    updated_at: '2026-11-04T10:20:00Z',
    created_by_name: 'Site Owner',
    status_changed_at: null,
    status_changed_by_name: null,
    ...fields,
  }
}

function rerunAccepted() {
  return ok({
    user_message: userMessage({
      id: RERUN_USER_ID,
      parent_id: SWARM_MESSAGE_ID,
      sibling_ids: [RERUN_USER_ID],
      parts: [{ id: 'u2-text', type: 'text', text: RERUN_TEXT }],
    }),
    assistant_message: swarmAssistant({
      id: RERUN_MESSAGE_ID,
      parent_id: RERUN_USER_ID,
      sibling_ids: [RERUN_MESSAGE_ID],
      parts_seq: 0,
      run_id: RERUN_RUN_ID,
    }),
    run: { id: RERUN_RUN_ID, chat_id: CHAT_ID, message_id: RERUN_MESSAGE_ID, status: 'queued', last_seq: 0 },
    swarm_version: { swarm_id: SWARM_ID, version: 2, scope: 'category', scope_key: 'google', task_ids: ['google.p1.page1'] },
  })
}

// SwarmDetail (contract 6d) after three versions, listed oldest first here
// (the client sorts them newest first).
function swarmDetail() {
  const summary = (version, fields) => ({
    version,
    scope: 'all',
    scope_label: 'All agents',
    status: 'done',
    counts: { total: 3, done: 3, failed: 0, skipped: 0, stopped: 0 },
    duration_ms: 120000,
    has_table: true,
    ...fields,
  })
  return {
    id: SWARM_ID,
    title: 'Research Notion',
    chat_id: CHAT_ID,
    message_id: SWARM_MESSAGE_ID,
    created_at: '2026-11-04T10:15:00Z',
    latest_version: 3,
    prompts: [{ key: 'p1', prompt_id: 'pr1', text: PROMPT, location: 'us' }],
    categories: [
      { key: 'google', label: 'Google (SEO)', task_ids: ['google.p1.page1'] },
      { key: 'engines', label: 'AI engines (GEO)', task_ids: ['engines.p1.chatgpt', 'engines.p1.claude'] },
    ],
    tasks: expectedSwarmPart().tasks.map(({ id, category, subcategory, worker, label }) => ({ id, category, subcategory, worker, label })),
    versions: [
      summary(1, {
        status: 'partial',
        counts: { total: 3, done: 2, failed: 1, skipped: 0, stopped: 0 },
        started_at: '2026-11-04T10:15:04.309Z',
        finished_at: '2026-11-04T10:17:18.510Z',
        message_id: SWARM_MESSAGE_ID,
        run_id: SWARM_RUN_ID,
      }),
      summary(2, {
        scope: 'category',
        scope_label: 'Google (SEO)',
        counts: { total: 1, done: 1, failed: 0, skipped: 0, stopped: 0 },
        started_at: '2026-11-04T11:02:00.190Z',
        finished_at: '2026-11-04T11:02:09.190Z',
        message_id: RERUN_MESSAGE_ID,
        run_id: RERUN_RUN_ID,
      }),
      summary(3, { started_at: '2026-11-04T12:00:00Z', finished_at: '2026-11-04T12:02:00Z', message_id: 'a-elsewhere', run_id: 'run-3' }),
    ],
  }
}

// Version 2's table: Google moved from #4 to #3; the engine cells are
// carried from version 1 (only the Google agents ran).
function versionTwoTable() {
  const base = swarmTable(2)
  const [row] = base.sheets[0].rows
  const carried = (cell) => ({ ...cell, version: 1 })
  const cells = {
    ...row.cells,
    google: { ...row.cells.google, text: '#3', v: 3, previous: { text: '#4', version: 1 } },
    chatgpt: carried(row.cells.chatgpt),
    claude: carried(row.cells.claude),
    ahead: carried(row.cells.ahead),
  }
  return {
    ...base,
    status: 'done',
    generated_at: '2026-11-04T11:02:10.880Z',
    counts: { total: 1, done: 1, failed: 0, skipped: 0, stopped: 0 },
    notes: ['Only the Google (SEO) agents ran in this version; other cells are from version 1.'],
    changes: [{ sheet: 'prompts', row: 'p1', column: 'google', label: `${PROMPT} · Google`, from: '#4', to: '#3' }],
    sheets: [{ ...base.sheets[0], rows: [{ ...row, cells }] }],
  }
}

// The re-run turn (contract 4d step 3 onwards): no model request, the part
// arrives whole, one agent runs, then the table and the change summary.
function versionTwoEvents() {
  let seq = 0
  const e = (type, ts, payload) => {
    seq += 1
    return { v: 1, seq, type, run_id: RERUN_RUN_ID, message_id: RERUN_MESSAGE_ID, ts, ...payload }
  }
  const [google] = expectedSwarmPart().tasks
  const [googleCategory] = expectedSwarmPart().categories
  const tabId = `serp:${RERUN_CAPTURE_ID}`
  return [
    e('run.started', '2026-11-04T11:02:00.100Z', { model: '' }),
    e('part.added', '2026-11-04T11:02:00.200Z', {
      part: {
        ...expectedSwarmPart(),
        id: 'p1',
        request: 0,
        version: 2,
        scope: 'category',
        scope_label: 'Google (SEO)',
        status: 'running',
        started_at: '2026-11-04T11:02:00.190Z',
        ended_at: null,
        duration_ms: null,
        table_version: null,
        categories: [googleCategory],
        tasks: [
          {
            ...google,
            status: 'queued',
            step: '',
            result: '',
            tone: null,
            started_at: null,
            ended_at: null,
            duration_ms: null,
            attempt: 0,
            pane: null,
            detail: null,
            rev: 1,
          },
        ],
      },
    }),
    e('task.started', '2026-11-04T11:02:00.300Z', {
      part_id: 'p1',
      task_id: 'google.p1.page1',
      rev: 2,
      patch: { status: 'running', started_at: '2026-11-04T11:02:00.290Z', step: 'Fetching Google page 1', attempt: 1 },
    }),
    e('research.recorded', '2026-11-04T11:02:08.000Z', {
      kind: 'serp',
      capture_id: RERUN_CAPTURE_ID,
      capture: { ...SERP_CAPTURE, capture_id: RERUN_CAPTURE_ID, brand_positions: [3], captured_at: '2026-11-04T11:02:07.900Z' },
    }),
    e('task.finished', '2026-11-04T11:02:08.100Z', {
      part_id: 'p1',
      task_id: 'google.p1.page1',
      rev: 3,
      patch: {
        status: 'done',
        step: '',
        ended_at: '2026-11-04T11:02:08.090Z',
        duration_ms: 7800,
        result: "You're #3 · AI Overview shown",
        tone: 'good',
        pane: { kind: 'serp', tab_id: tabId },
        error: null,
        detail: { ...google.detail, brand_positions: [3], captured_at: '2026-11-04T11:02:07.900Z' },
      },
    }),
    e('part.updated', '2026-11-04T11:02:09.000Z', {
      part_id: 'p1',
      patch: { status: 'done', ended_at: '2026-11-04T11:02:09.190Z', duration_ms: 9000 },
    }),
    e('part.added', '2026-11-04T11:02:10.900Z', {
      part: { ...tablePart(2, versionTwoTable()), id: 'p2', request: 0 },
    }),
    e('part.updated', '2026-11-04T11:02:10.910Z', { part_id: 'p1', patch: { table_version: 2 } }),
    e('part.added', '2026-11-04T11:02:10.920Z', {
      part: { id: 'p3', type: 'text', request: 0, text: 'Google now ranks you #3 for this prompt (was #4).' },
    }),
    e('run.completed', '2026-11-04T11:02:11.000Z', { status: 'complete', stop_reason: '', parts_seq: 9, duration_ms: 10900 }),
  ]
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  Object.values(agentApi).forEach((fn) => fn.mockReset())
  Object.values(toast).forEach((fn) => fn.mockReset())
  downloadText.mockReset()
  rm.attached = []
})

describe('research agents end to end: the live run', () => {
  it('folds the contract events into the live tree, then the results table and the report', async () => {
    const { wrapper, store, pane, ui } = await openWorkspace()
    const announce = vi.spyOn(ui, 'announce')
    expect(rm.attached).toEqual([{ id: SWARM_RUN_ID, lastSeq: 40 }])
    const events = swarmRunEvents()
    const at = (type, match = () => true) => events.findIndex((e) => e.type === type && match(e))
    const started = at('part.added', (e) => e.part.status === 'running')
    const googleDone = at('task.finished', (e) => e.task_id === 'google.p1.page1')
    const ended = at('part.updated', (e) => e.patch.status === 'partial')
    const table = at('part.added', (e) => e.part.type === 'swarm_table')
    const report = at('part.added', (e) => e.part.type === 'text')

    // Planning: the tool call is streaming; nothing ran, nothing to re-run.
    await feed(store, SWARM_RUN_ID, events.slice(0, 1))
    let [block] = blocks(wrapper)
    expect(headerOf(block)).toBe('Planning research agents')
    expect(block.find('.ag-swarm-head-rerun').exists()).toBe(false)
    expect(block.find('.ag-swarm-body').exists()).toBe(false)

    // Execution starts: every agent queued, grouped by category and prompt.
    await feed(store, SWARM_RUN_ID, events.slice(1, started + 1))
    ;[block] = blocks(wrapper)
    expect(headerOf(block)).toBe('Running 3 agents')
    expect(block.find('.ag-swarm-subtitle').text()).toBe('Research Notion')
    expect(block.find('.ag-swarm-count').text()).toBe('0/3')
    expect(block.findAll('.ag-swarm-cat-label').map((c) => c.text())).toEqual(['Google (SEO)', 'AI engines (GEO)'])
    expect(block.find('.ag-swarm-note').text()).toBe('Gemini, Grok and Perplexity are not configured, so they were not asked.')
    expect(block.findAll('.ag-swarm-sub-label').map((s) => s.text())).toEqual([`“${PROMPT}”`, `“${PROMPT}”`])
    expect(block.findAll('.ag-swarm-row-label').map((r) => r.text())).toEqual(['Google page 1', 'ChatGPT', 'Claude'])
    expect(block.findAll('.ag-swarm-row-text').map((r) => r.text())).toEqual(['Queued', 'Queued', 'Queued'])
    const bar = block.find('[role="progressbar"]')
    expect([bar.attributes('aria-valuenow'), bar.attributes('aria-valuemax')]).toEqual(['0', '3'])
    expect(announce).toHaveBeenCalledWith('Research started: 3 agents')
    // The chat is busy: re-run is offered but cannot start.
    expect(block.find('.ag-swarm-head-rerun button').attributes('aria-disabled')).toBe('true')

    // The agents start, report their steps and finish one by one.
    await feed(store, SWARM_RUN_ID, events.slice(started + 1, googleDone))
    ;[block] = blocks(wrapper)
    expect(lineOf(block, 'Google page 1').text()).toBe('Reading the results')
    expect(lineOf(block, 'Google page 1').classes()).toContain('is-shimmer')
    expect(lineOf(block, 'ChatGPT').text()).toBe('Asking ChatGPT')
    expect(lineOf(block, 'Claude').text()).toBe('Claude was busy; trying again')
    // The capture lands in the message research and opens as a background
    // tab; the run's first one shows the pane.
    expect(store.messages[SWARM_MESSAGE_ID].research.serp[CAPTURE_ID]).toEqual(SERP_CAPTURE)
    expect(pane.tabs.map((t) => [t.id, t.status])).toEqual([[SERP_TAB, 'ready']])
    expect(pane.activeId).toBe(SERP_TAB)
    expect(pane.open).toBe(true)

    await feed(store, SWARM_RUN_ID, events.slice(googleDone, ended))
    ;[block] = blocks(wrapper)
    expect(lineOf(block, 'Google page 1').text()).toBe("You're #4 · AI Overview shown")
    expect(lineOf(block, 'Google page 1').classes()).toContain('is-good')
    expect(lineOf(block, 'ChatGPT').text()).toBe('Not named · lists Evernote, OneNote')
    expect(lineOf(block, 'ChatGPT').classes()).toContain('is-warn')
    expect(lineOf(block, 'Claude').text()).toBe('Failed: The engine was busy or rate limited.')
    expect(lineOf(block, 'Claude').classes()).toContain('is-bad')
    expect(block.find('.ag-swarm-count').text()).toBe('3/3')
    expect(pane.tabs.map((t) => t.id)).toEqual([SERP_TAB])

    // Every agent settled: the swarm ends partial.
    await feed(store, SWARM_RUN_ID, events.slice(ended, table))
    ;[block] = blocks(wrapper)
    expect(headerOf(block)).toBe('Ran 3 agents in 2m 14s')
    expect(block.find('.ag-swarm-summary').text()).toBe('2 done · 1 failed')
    expect(block.classes()).toContain('is-partial')
    expect(announce).toHaveBeenCalledWith('Research finished: 2 done · 1 failed')
    expect(inlineTables(wrapper)).toHaveLength(0)

    // The consolidated table arrives in the reply body, before the report.
    await feed(store, SWARM_RUN_ID, events.slice(table, report))
    let [results] = inlineTables(wrapper)
    expect(results.find('.ag-st-title').text()).toBe('Results')
    expect(results.find('.ag-st-chip').text()).toBe('v1')
    expect(results.findAll('.ag-st-seg-item').map((s) => s.text())).toEqual(['Prompts 1'])
    expect(results.findAll('thead th').map((th) => th.text())).toContain('ChatGPT')
    expect(cellOf(results, 'prompt').text()).toBe(PROMPT)
    expect(cellOf(results, 'google').text()).toContain('#4')
    expect(cellOf(results, 'chatgpt').text()).toContain('Not named')
    expect(cellOf(results, 'chatgpt').classes()).toEqual(expect.arrayContaining(['is-not-found', 'is-tone-warn']))
    expect(cellOf(results, 'claude').classes()).toContain('is-failed')
    expect(cellOf(results, 'gemini').text()).toContain('Not configured')
    expect(cellOf(results, 'gemini').classes()).toContain('is-not-configured')
    expect(results.find('input.ag-st-check').attributes('aria-label')).toBe(`Add “${PROMPT}” to findings`)
    // The reply is still streaming: it cannot be saved yet.
    expect(buttonIn(results, 'Add to report').attributes('disabled')).toBeDefined()

    // The report streams after the table, and the run completes.
    await feed(store, SWARM_RUN_ID, events.slice(report))
    const message = store.messages[SWARM_MESSAGE_ID]
    expect(message.status).toBe('complete')
    expect(message.parts.find((p) => p.type === 'swarm')).toEqual(expectedSwarmPart())
    expect(message.parts.find((p) => p.type === 'swarm_table').table).toEqual(swarmTable(1))
    const body = thread(wrapper).find('.ag-assistant-body')
    expect(body.element.children[0].matches('section.ag-st')).toBe(true)
    expect(body.element.children[1].textContent).toBe('# Notion on Google and AI')
    ;[results] = inlineTables(wrapper)
    expect(buttonIn(results, 'Add to report').attributes('disabled')).toBeUndefined()
    ;[block] = blocks(wrapper)
    expect(block.find('.ag-swarm-head-rerun button').attributes('aria-disabled')).toBeUndefined()
    expect(store.isChatBusy(CHAT_ID)).toBe(false)
    expect(store.latestSwarmVersion(SWARM_ID)).toBe(1)
    expect(store.swarmTable(SWARM_ID)).toEqual(swarmTable(1))
    // A chat renders its research from its parts: no swarm endpoint was read.
    expect(agentApi.getSwarm).not.toHaveBeenCalled()
    expect(agentApi.getSwarmVersion).not.toHaveBeenCalled()
  })

  it('resumes a research reloaded mid-run from its checkpoint and ends as a live client does', async () => {
    // The checkpoint after the Google page finished (seq 54): ChatGPT and
    // Claude still run, the capture is in the research store.
    const [google, chatgpt, claude] = expectedSwarmPart().tasks
    const open = { result: '', tone: null, ended_at: null, duration_ms: null, pane: null, error: null, detail: null }
    const checkpoint = {
      ...expectedSwarmPart(),
      status: 'running',
      ended_at: null,
      duration_ms: null,
      table_version: null,
      tasks: [
        google,
        { ...chatgpt, ...open, status: 'running', step: 'Asking ChatGPT', rev: 2 },
        { ...claude, ...open, status: 'running', step: 'Claude was busy; trying again', rev: 3 },
      ],
    }
    const detail = chatDetail()
    detail.messages[1] = swarmAssistant({
      parts: [checkpoint],
      parts_seq: 54,
      research: { serp: { [CAPTURE_ID]: SERP_CAPTURE }, pages: {} },
    })
    const { wrapper, store } = await openWorkspace({ detail })
    expect(rm.attached).toEqual([{ id: SWARM_RUN_ID, lastSeq: 54 }])
    let [block] = blocks(wrapper)
    expect(headerOf(block)).toBe('Running 3 agents')
    expect(block.find('.ag-swarm-count').text()).toBe('1/3')
    expect(lineOf(block, 'Claude').text()).toBe('Claude was busy; trying again')

    // The resumed stream may repeat what the checkpoint holds: an event at
    // or below the checkpoint's seq, or a task event with a stale rev, is a
    // no-op; the rest folds in as it did live.
    const events = swarmRunEvents()
    const replayed = events.find((e) => e.type === 'task.started' && e.task_id === 'engines.p1.claude')
    const staleRev = { ...events.find((e) => e.type === 'task.progress' && e.task_id === 'engines.p1.claude'), seq: 55 }
    const rest = events.filter((e) => e.seq > 54)
    await feed(store, SWARM_RUN_ID, [replayed, staleRev, ...rest])
    const message = store.messages[SWARM_MESSAGE_ID]
    expect(message.parts.find((p) => p.type === 'swarm')).toEqual(expectedSwarmPart())
    ;[block] = blocks(wrapper)
    expect(headerOf(block)).toBe('Ran 3 agents in 2m 14s')
    expect(cellOf(inlineTables(wrapper)[0], 'google').text()).toContain('#4')
  })

  it('stops the agents that were still open when the run is cancelled', async () => {
    const { wrapper, store } = await openWorkspace()
    const events = swarmRunEvents()
    const firstFinish = events.findIndex((e) => e.type === 'task.finished')
    await feed(store, SWARM_RUN_ID, events.slice(0, firstFinish + 1))
    // Contract 4d step 8: the open agents stop, the swarm ends cancelled
    // with a table of what finished, then the run is cancelled.
    const stopped = (seq, taskId) => ({
      v: 1,
      seq,
      type: 'task.finished',
      run_id: SWARM_RUN_ID,
      message_id: SWARM_MESSAGE_ID,
      ts: '2026-11-04T10:15:41.000Z',
      part_id: 'p4',
      task_id: taskId,
      rev: 9,
      patch: { status: 'stopped', step: '', ended_at: '2026-11-04T10:15:41.000Z', error: { code: 'stopped', message: 'Stopped' } },
    })
    await feed(store, SWARM_RUN_ID, [
      stopped(100, 'engines.p1.chatgpt'),
      stopped(101, 'engines.p1.claude'),
      {
        v: 1,
        seq: 102,
        type: 'part.updated',
        run_id: SWARM_RUN_ID,
        message_id: SWARM_MESSAGE_ID,
        ts: '2026-11-04T10:15:41.100Z',
        part_id: 'p4',
        patch: { status: 'cancelled', ended_at: '2026-11-04T10:15:41.090Z', duration_ms: 36781 },
      },
      { v: 1, seq: 103, type: 'run.cancelled', run_id: SWARM_RUN_ID, message_id: SWARM_MESSAGE_ID, ts: '2026-11-04T10:15:41.200Z' },
    ])
    const [block] = blocks(wrapper)
    expect(headerOf(block)).toBe('Stopped after 1 of 3 agents')
    expect(block.find('.ag-swarm-summary').text()).toBe('1 done · 2 stopped')
    expect(lineOf(block, 'ChatGPT').text()).toBe('Stopped')
    expect(store.messages[SWARM_MESSAGE_ID].status).toBe('cancelled')
    expect(store.isChatBusy(CHAT_ID)).toBe(false)
  })
})

describe('research agents end to end: after the run', () => {
  it('rebuilds the tree and the table from a reloaded chat, and opens captures and the table in the pane', async () => {
    const { wrapper, store, pane } = await openWorkspace({ finished: true })
    const [block] = blocks(wrapper)
    expect(headerOf(block)).toBe('Ran 3 agents in 2m 14s')
    // A finished research reloads with one line per category.
    const cats = block.findAll('.ag-swarm-cat-row')
    expect(cats.map((c) => c.attributes('aria-expanded'))).toEqual(['false', 'false'])
    expect(block.findAll('.ag-swarm-cat-sum').map((s) => s.text())).toEqual(['best #4', 'named by 0 of 1 · 1 failed'])
    expect(cellOf(inlineTables(wrapper)[0], 'google').text()).toContain('#4')

    // The reload rebuilt the agent's Google page as a tab; its row shows it.
    expect(pane.tabs.map((t) => t.id)).toEqual([SERP_TAB])
    await cats[0].trigger('click')
    await rowOf(block, 'Google page 1').trigger('click')
    await flushPromises()
    expect(pane.open).toBe(true)
    expect(pane.activeId).toBe(SERP_TAB)
    expect(pane.activeTab).toMatchObject({ kind: 'serp', status: 'ready' })
    expect(wrapper.find('.ws-pane input[type="search"]').element.value).toBe(PROMPT)
    expect(block.find('.ag-swarm-detail').text()).toContain('Your position')

    // The table opens in the pane as one `table` tab, from the loaded parts.
    const [results] = inlineTables(wrapper)
    await results.find('button[aria-label="Open in browser pane"]').trigger('click')
    await flushPromises()
    expect(pane.activeId).toBe(TABLE_TAB)
    expect(pane.activeTab).toMatchObject({ kind: 'table', swarmId: SWARM_ID, version: null, title: 'Research Notion' })
    expect(wrapper.find('.ws-pane .ag-ph-title-text').text()).toBe('Research results')
    expect(wrapper.find('.ws-pane .ag-ph-sub').text()).toBe('Research Notion')
    expect(paneTable(wrapper).classes()).toContain('is-pane')
    expect(cellOf(paneTable(wrapper), 'google').text()).toContain('#4')
    expect(agentApi.getSwarmVersion).not.toHaveBeenCalled()

    // Its CSV is the sheet's cell texts.
    await results.find('button[aria-label="Download CSV"]').trigger('click')
    const [csv, filename, type] = downloadText.mock.calls[0]
    expect(filename).toBe('Research Notion v1 Prompts.csv')
    expect(type).toBe('text/csv;charset=utf-8')
    expect(csv).toContain('Prompt,Google,AI Overview,ChatGPT,Claude')
    expect(csv).toContain(`${PROMPT},#4,"Shown, not named",Not named,Failed,Not configured`)

    // The pane's tabs persist per chat: back on the chat, the capture tab is
    // rebuilt from the research store and the table tab still follows the
    // latest version.
    pane.bindChat('other-chat')
    expect(pane.tabs).toHaveLength(0)
    pane.bindChat(CHAT_ID)
    await flushPromises()
    expect(pane.tabs.map((t) => [t.id, t.kind, t.status])).toEqual([
      [SERP_TAB, 'serp', 'ready'],
      [TABLE_TAB, 'table', 'ready'],
    ])
    expect(pane.tabs[1]).toMatchObject({ swarmId: SWARM_ID, version: null })
    expect(pane.titleOf(pane.tabs[1])).toBe('Research results')
    expect(store.swarmTable(SWARM_ID)).toEqual(swarmTable(1))
  })

  it('adds a row to Findings and the reply to Reports from the table', async () => {
    const { wrapper, findings } = await openWorkspace({ finished: true })
    const [results] = inlineTables(wrapper)

    agentApi.createFindings.mockResolvedValueOnce(ok({ created: [finding()], duplicates: [] }))
    await buttonIn(results, 'Add all to findings (1)').trigger('click')
    await flushPromises()
    expect(agentApi.createFindings).toHaveBeenCalledWith(
      WID,
      { from_swarm: { swarm_id: SWARM_ID, version: 1, sheet: 'prompts', row_keys: ['p1'] } },
      { _silentError: true }
    )
    expect(findings.isAdded(SWARM_ID, 'prompts', 'p1')).toBe(true)
    expect(results.find('.ag-st-added').text()).toBe('In findings')
    expect(results.find('input.ag-st-check').exists()).toBe(false)
    expect(toast.success).toHaveBeenCalledWith('Added 1 finding.')
    expect(results.find('.ag-sta-view').attributes('href')).toBe(`/projects/${WID}/agent/findings`)
    expect(buttonIn(results, 'Add all to findings (0)').attributes('disabled')).toBeDefined()

    agentApi.saveReport.mockResolvedValueOnce(
      ok({ id: 'r1', kind: 'report', title: 'Research Notion', latest_version: 1, source_chat_id: CHAT_ID })
    )
    await buttonIn(results, 'Add to report').trigger('click')
    await flushPromises()
    expect(agentApi.saveReport).toHaveBeenCalledWith(WID, { message_id: SWARM_MESSAGE_ID }, { _silentError: true })
    expect(buttonIn(results, 'Saved to Reports')).not.toBeNull()
    expect(toast.success).toHaveBeenLastCalledWith('Saved to Reports.')
  })

  it('re-runs one category as a new turn, then shows the newer version everywhere', async () => {
    const { wrapper, store, pane } = await openWorkspace({ finished: true })
    let [first] = blocks(wrapper)

    agentApi.rerunSwarm.mockResolvedValueOnce(rerunAccepted())
    await first.find('.ag-swarm-head-rerun button').trigger('click')
    await flushPromises()
    expect(menuItem('Re-run all agents').textContent).toContain('3 agents')
    expect(menuItem('Google (SEO)').textContent).toContain('1 agent')
    expect(menuItem('AI engines (GEO)').textContent).toContain('2 agents')
    menuItem('Google (SEO)').click()
    await flushPromises()

    const [wid, sid, body, options] = agentApi.rerunSwarm.mock.calls[0]
    expect([wid, sid, body]).toEqual([WID, SWARM_ID, { scope: 'category', category: 'google' }])
    expect(options.idempotencyKey).toEqual(expect.any(String))
    expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_ID, SWARM_MESSAGE_ID, RERUN_USER_ID, RERUN_MESSAGE_ID])
    expect(thread(wrapper).text()).toContain(RERUN_TEXT)
    expect(rm.attached).toContainEqual({ id: RERUN_RUN_ID, lastSeq: 0 })
    // The new turn runs: the earlier block's re-run waits for it.
    ;[first] = blocks(wrapper)
    expect(first.find('.ag-swarm-head-rerun button').attributes('aria-disabled')).toBe('true')

    const events = versionTwoEvents()
    const finished = events.findIndex((e) => e.type === 'task.finished')
    await feed(store, RERUN_RUN_ID, events.slice(0, finished))
    let second = blocks(wrapper)[1]
    expect(headerOf(second)).toBe('Re-running 1 agent · Google (SEO)')
    expect(second.findAll('.ag-swarm-cat-label').map((c) => c.text())).toEqual(['Google (SEO)'])

    await feed(store, RERUN_RUN_ID, events.slice(finished))
    second = blocks(wrapper)[1]
    expect(headerOf(second)).toBe('Ran 1 agent in 9s')
    expect(store.latestSwarmVersion(SWARM_ID)).toBe(2)
    expect(store.isChatBusy(CHAT_ID)).toBe(false)

    // Version 2's table: the change and the carried cells are marked.
    const [older, newer] = inlineTables(wrapper)
    expect(newer.find('.ag-st-chip').text()).toBe('v2')
    expect(cellOf(newer, 'google').text()).toContain('#3')
    expect(newer.find('tbody .is-col-google .ag-st-prev').text()).toBe('was #4')
    expect(newer.find('tbody .is-col-chatgpt sup.ag-st-ver').attributes('aria-label')).toBe('measured in version 1')
    expect(thread(wrapper).text()).toContain('Google now ranks you #3 for this prompt (was #4).')

    // The first research points at the newer results.
    ;[first] = blocks(wrapper)
    expect(first.find('.ag-swarm-newer').text()).toBe('Newer results below')
    const chip = older.find('.ag-st-chip.is-newer')
    expect(chip.text()).toBe('Newer: v2')
    await chip.trigger('click')
    await flushPromises()
    expect(pane.activeTab).toMatchObject({ id: TABLE_TAB, kind: 'table', version: null })
    expect(paneTable(wrapper).find('.ag-st-chip').text()).toBe('v2')
    expect(cellOf(paneTable(wrapper), 'google').text()).toContain('#3')

    // Opened from version 1, the pane pins that version.
    await older.find('button[aria-label="Open in browser pane"]').trigger('click')
    await flushPromises()
    expect(pane.activeTab).toMatchObject({ id: TABLE_TAB, version: 1 })
    expect(paneTable(wrapper).find('.ag-st-chip').text()).toBe('v1')
    expect(agentApi.getSwarmVersion).not.toHaveBeenCalled()
  })

  it('switches the pane table between versions, reading one no loaded message holds from the API', async () => {
    const { wrapper, store, pane } = await openWorkspace({ rerun: true })
    const [older, newer] = inlineTables(wrapper)
    expect(older.find('.ag-st-chip.is-newer').text()).toBe('Newer: v2')
    expect(newer.find('.ag-st-chip.is-newer').exists()).toBe(false)
    await newer.find('button[aria-label="Open in browser pane"]').trigger('click')
    await flushPromises()
    expect(pane.activeTab).toMatchObject({ id: TABLE_TAB, version: null })
    expect(paneTable(wrapper).find('.ag-st-chip').text()).toBe('v2')

    // The version menu lists the versions with a table from the swarm's
    // detail, newest first; version 3 ran in a turn this thread does not show.
    agentApi.getSwarm.mockResolvedValueOnce(ok(swarmDetail()))
    agentApi.getSwarmVersion.mockResolvedValueOnce(
      ok({
        swarm_id: SWARM_ID,
        version: 3,
        scope: 'all',
        scope_label: 'All agents',
        status: 'done',
        counts: { total: 3, done: 3, failed: 0, skipped: 0, stopped: 0 },
        started_at: '2026-11-04T12:00:00Z',
        finished_at: '2026-11-04T12:02:00Z',
        duration_ms: 120000,
        message_id: 'a-elsewhere',
        table: swarmTable(3, { status: 'done' }),
      })
    )
    await wrapper.find('.ws-pane button.ag-ph-ver').trigger('click')
    await flushPromises()
    expect(agentApi.getSwarm).toHaveBeenCalledWith(WID, SWARM_ID, { _silentError: true })
    const labels = [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim())
    expect(labels).toHaveLength(3)
    expect(labels[0]).toMatch(/^Version 3 · All agents · Done · /)
    expect(labels[1]).toMatch(/^Version 2 · Google \(SEO\) · Done · /)
    expect(labels[2]).toMatch(/^Version 1 · All agents · Partial · /)

    // Following the latest, the pane now shows version 3, read from the API;
    // no loaded message holds it, so Add to report is not offered there.
    expect(store.latestSwarmVersion(SWARM_ID)).toBe(3)
    expect(agentApi.getSwarmVersion).toHaveBeenCalledWith(WID, SWARM_ID, 3, { _silentError: true })
    expect(paneTable(wrapper).find('.ag-st-chip').text()).toBe('v3')
    expect(buttonIn(paneTable(wrapper), 'Add to report')).toBeNull()
    expect(newer.find('.ag-st-chip.is-newer').text()).toBe('Newer: v3')

    menuItem('Version 1').click()
    await flushPromises()
    expect(pane.activeTab).toMatchObject({ id: TABLE_TAB, version: 1 })
    expect(paneTable(wrapper).find('.ag-st-chip').text()).toBe('v1')
    expect(buttonIn(paneTable(wrapper), 'Add to report')).not.toBeNull()
    expect(agentApi.getSwarmVersion).toHaveBeenCalledTimes(1)
  })
})
