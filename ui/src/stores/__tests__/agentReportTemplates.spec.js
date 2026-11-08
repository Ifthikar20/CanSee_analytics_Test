import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  authHeaders: () => ({}),
  refreshAccessToken: async () => '',
}))

vi.mock('@/api/agent', () => ({
  default: {
    status: vi.fn(),
    agents: vi.fn(),
    reportTemplates: vi.fn(),
    listChats: vi.fn(),
    createChat: vi.fn(),
    getChat: vi.fn(),
    sendMessage: vi.fn(),
    suggestions: vi.fn(),
    activity: vi.fn(),
    listReviews: vi.fn(),
    cancelRun: vi.fn(),
  },
}))

vi.mock('@/lib/agent/runManager', () => ({
  createRunManager() {
    const sessions = new Map()
    return {
      attach: (run) => (sessions.set(String(run.id), run), run),
      detach: (id) => sessions.delete(String(id)),
      detachAll: () => sessions.clear(),
      isAttached: (id) => sessions.has(String(id)),
      nudge() {},
    }
  },
}))

import agentApi from '@/api/agent'
import { useAgentStore } from '@/stores/agent'
import { useAuthStore } from '@/stores/auth'
import { CHAT_ID, RUN_ID, USER_MESSAGE_ID, ASSISTANT_ID, emptyAssistant } from '@/lib/agent/__tests__/__fixtures__/runEvents'

const ok = (data) => ({ success: true, data })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function axiosError(status, error) {
  return Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    config: {},
    response: { status, data: { success: false, error } },
  })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function catalogItem(id, overrides = {}) {
  return {
    id,
    name: `Server ${id}`,
    purpose: 'From the server.',
    header_fields: ['template', 'project', 'captured_at', 'data', 'engines', 'locations'],
    sections: [{ title: 'Method', shows: 'When.', source: 'Tools', repeat: null }],
    requirements: { google: 'saved', engines: 'saved', research_agents: false, runs_checks: false, note: 'Note.' },
    available: true,
    unavailable: null,
    limitations: [],
    ...overrides,
  }
}

function chatDetail() {
  return {
    id: CHAT_ID,
    title: '',
    title_source: 'auto',
    preview: '',
    created_at: '2026-11-02T10:00:00Z',
    last_message_at: '2026-11-02T10:00:00Z',
    current_leaf_id: null,
    messages: [],
    active_run: null,
  }
}

function accepted() {
  return ok({
    user_message: {
      id: USER_MESSAGE_ID,
      chat_id: CHAT_ID,
      parent_id: null,
      role: 'user',
      status: 'complete',
      parts: [{ id: 'u-text', type: 'text', text: 'Write it' }],
      parts_seq: 0,
      sibling_ids: [USER_MESSAGE_ID],
    },
    assistant_message: emptyAssistant({ research: { serp: {}, pages: {}, template: 'executive_summary' } }),
    run: { id: RUN_ID, chat_id: CHAT_ID, message_id: ASSISTANT_ID, status: 'queued', last_seq: 0 },
  })
}

let store

async function initProject() {
  agentApi.status.mockResolvedValue(ok({ enabled: true, live_available: true }))
  agentApi.listChats.mockResolvedValue(ok({ results: [], next_cursor: null }))
  agentApi.agents.mockResolvedValue(ok([]))
  agentApi.suggestions.mockResolvedValue(ok([]))
  agentApi.activity.mockResolvedValue(ok([]))
  agentApi.listReviews.mockResolvedValue(ok([]))
  await store.init(5)
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  Object.values(agentApi).forEach((fn) => fn.mockReset())
  const auth = useAuthStore()
  auth.accessToken = 'token'
  auth.user = { id: 7 }
  store = useAgentStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('agent store: report templates', () => {
  it('starts empty, then loads the catalog once and keeps it', async () => {
    expect(store.reportTemplates).toEqual({ items: [], source: '', loading: false, error: null })
    agentApi.reportTemplates.mockResolvedValue(ok([catalogItem('change_log'), catalogItem('executive_summary'), catalogItem('nope')]))
    const items = await store.loadReportTemplates()
    expect(agentApi.reportTemplates).toHaveBeenCalledWith({ _silentError: true })
    expect(items.map((t) => [t.id, t.name])).toEqual([
      ['change_log', 'Server change_log'],
      ['executive_summary', 'Server executive_summary'],
    ])
    expect(store.reportTemplates).toMatchObject({ source: 'catalog', loading: false, error: null })
    await store.loadReportTemplates()
    expect(agentApi.reportTemplates).toHaveBeenCalledTimes(1)
    await store.loadReportTemplates({ force: true })
    expect(agentApi.reportTemplates).toHaveBeenCalledTimes(2)
  })

  it('marks itself loading while the request runs', async () => {
    const pending = deferred()
    agentApi.reportTemplates.mockReturnValue(pending.promise)
    const call = store.loadReportTemplates()
    expect(store.reportTemplates.loading).toBe(true)
    pending.resolve(ok([catalogItem('change_log')]))
    await call
    expect(store.reportTemplates.loading).toBe(false)
  })

  it('shares one request between callers', async () => {
    const pending = deferred()
    agentApi.reportTemplates.mockReturnValue(pending.promise)
    const a = store.loadReportTemplates()
    const b = store.loadReportTemplates()
    pending.resolve(ok([catalogItem('brand_accuracy')]))
    const [first, second] = await Promise.all([a, b])
    expect(agentApi.reportTemplates).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })

  it('falls back to the local copy when the call fails, then tries again on the next call', async () => {
    agentApi.reportTemplates.mockRejectedValueOnce(axiosError(503, { code: 'agent_disabled', message: 'The agent is switched off.' }))
    const items = await store.loadReportTemplates()
    expect(items).toHaveLength(7)
    expect(store.reportTemplates.source).toBe('fallback')
    expect(store.reportTemplates.error).toMatchObject({ status: 503, code: 'agent_disabled' })
    expect(items.every((t) => t.available && !t.checked)).toBe(true)

    agentApi.reportTemplates.mockResolvedValueOnce(ok([catalogItem('google_ai_gap')]))
    await store.loadReportTemplates()
    expect(store.reportTemplates.source).toBe('catalog')
    expect(store.reportTemplates.error).toBeNull()
    expect(store.reportTemplates.items.map((t) => t.id)).toEqual(['google_ai_gap'])
  })

  it('treats a catalog with nothing usable as a failure', async () => {
    agentApi.reportTemplates.mockResolvedValueOnce(ok([{ id: 'unknown' }]))
    await store.loadReportTemplates()
    expect(store.reportTemplates.source).toBe('fallback')
    expect(store.reportTemplates.items).toHaveLength(7)
    expect(store.reportTemplates.error.message).toBe('The report templates could not be loaded.')
  })

  it('keeps the server availability and reasons', async () => {
    agentApi.reportTemplates.mockResolvedValueOnce(
      ok([catalogItem('brand_accuracy', { available: false, unavailable: { code: 'insights_off', message: 'Off here.' } })]),
    )
    const [t] = await store.loadReportTemplates()
    expect(t).toMatchObject({ available: false, unavailable: { code: 'insights_off', message: 'Off here.' } })
  })

  it('forgets the templates on sign-out and drops a reply that arrives after it', async () => {
    agentApi.reportTemplates.mockResolvedValueOnce(ok([catalogItem('change_log')]))
    await store.loadReportTemplates()
    const pending = deferred()
    agentApi.reportTemplates.mockReturnValueOnce(pending.promise)
    const call = store.loadReportTemplates({ force: true })
    store.resetAll()
    expect(store.reportTemplates).toEqual({ items: [], source: '', loading: false, error: null })
    pending.resolve(ok([catalogItem('executive_summary')]))
    await call
    expect(store.reportTemplates.items).toEqual([])
    // The next user loads afresh.
    agentApi.reportTemplates.mockResolvedValueOnce(ok([catalogItem('brand_accuracy')]))
    await store.loadReportTemplates()
    expect(store.reportTemplates.items.map((t) => t.id)).toEqual(['brand_accuracy'])
  })

  it('drops a failure that arrives after sign-out too', async () => {
    const pending = deferred()
    agentApi.reportTemplates.mockReturnValueOnce(pending.promise)
    const call = store.loadReportTemplates()
    store.resetAll()
    pending.reject(axiosError(500, {}))
    await call
    expect(store.reportTemplates).toEqual({ items: [], source: '', loading: false, error: null })
  })
})

describe('agent store: sending with a report template', () => {
  it('posts the template with a new chat message', async () => {
    await initProject()
    agentApi.createChat.mockResolvedValueOnce(ok(chatDetail()))
    agentApi.sendMessage.mockResolvedValueOnce(accepted())
    await store.send({ chatId: null, text: 'Write it', agent: 'gap_analyst', template: 'executive_summary' })
    await flush()
    const [, , body] = agentApi.sendMessage.mock.calls[0]
    expect(body).toEqual({ text: 'Write it', parent_id: undefined, agent: 'gap_analyst', template: 'executive_summary' })
    expect(body.template).toBe('executive_summary')
  })

  it('posts it with a follow-up in an existing chat', async () => {
    await initProject()
    agentApi.getChat.mockResolvedValueOnce(ok(chatDetail()))
    agentApi.sendMessage.mockResolvedValueOnce(accepted())
    await store.send({ chatId: CHAT_ID, text: 'Next', template: 'change_log' })
    await flush()
    expect(agentApi.sendMessage.mock.calls[0][2]).toMatchObject({ text: 'Next', template: 'change_log' })
  })

  it('leaves the template out without one, and drops an unknown key', async () => {
    await initProject()
    agentApi.getChat.mockResolvedValueOnce(ok(chatDetail()))
    agentApi.sendMessage.mockResolvedValue(accepted())
    await store.send({ chatId: CHAT_ID, text: 'Plain' })
    await flush()
    expect(agentApi.sendMessage.mock.calls[0][2].template).toBeUndefined()
    agentApi.getChat.mockResolvedValueOnce(ok(chatDetail()))
    await store.send({ chatId: 'c-two', text: 'Odd', template: 'weekly_digest' })
    await flush()
    expect(agentApi.sendMessage.mock.calls.at(-1)[2].template).toBeUndefined()
  })

  it('keeps the template when a refused send is retried', async () => {
    await initProject()
    agentApi.getChat.mockResolvedValueOnce(ok(chatDetail()))
    agentApi.sendMessage.mockRejectedValueOnce(
      axiosError(400, {
        code: 'template_unavailable',
        message: 'The Change log since the last run template needs a newer chat. Start a new chat to use it.',
      }),
    )
    await store.send({ chatId: CHAT_ID, text: 'Log', template: 'change_log' })
    await flush()
    const [failed] = store.visiblePath(CHAT_ID)
    expect(failed.status).toBe('send_failed')
    expect(failed.error_code).toBe('template_unavailable')
    expect(failed.error_message).toBe('The Change log since the last run template needs a newer chat. Start a new chat to use it.')
    expect(failed.send.template).toBe('change_log')
    agentApi.sendMessage.mockResolvedValueOnce(accepted())
    await store.retrySend(failed.id)
    expect(agentApi.sendMessage.mock.calls[1][2].template).toBe('change_log')
  })
})
