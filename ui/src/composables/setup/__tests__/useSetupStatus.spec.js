import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

// The run manager is the agent store's one way to follow a run (stream,
// else long-poll). Faked here: the test feeds its events by hand, and can
// see what the store attached and detached.
const rm = vi.hoisted(() => ({ hooks: null, attached: [], detached: [] }))

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
    getChat: vi.fn(),
    createChat: vi.fn(),
    sendMessage: vi.fn(),
  },
}))

vi.mock('@/lib/agent/runManager', () => ({
  createRunManager(hooks) {
    rm.hooks = hooks
    const sessions = new Map()
    return {
      attach(run) {
        rm.attached.push(String(run.id))
        sessions.set(String(run.id), run)
        return run
      },
      detach(id) {
        if (sessions.delete(String(id))) rm.detached.push(String(id))
      },
      detachAll() {
        for (const id of [...sessions.keys()]) this.detach(id)
      },
      isAttached: (id) => sessions.has(String(id)),
      nudge() {},
    }
  },
}))

import agentApi from '@/api/agent'
import { useAgentStore } from '@/stores/agent'
import { useAuthStore } from '@/stores/auth'
import { noteFirstResearchChat, noteSetupFinished, readSetup } from '@/lib/setup/storage'
import { useSetupStatus } from '../useSetupStatus'

const ok = (data) => ({ data })
const notFound = () =>
  Object.assign(new Error('Not found'), { isAxiosError: true, config: {}, response: { status: 404, data: { error: { code: 'not_found', message: 'Not found' } } } })

const STATUS = {
  enabled: true,
  configured: true,
  live_available: true,
  engines: [{ key: 'chatgpt', label: 'ChatGPT', configured: true, key_setting: '' }],
  google: { configured: true, key_settings: [] },
  research: { available: true, reason: null, message: '' },
  prompt_runs: { unlimited: false, limit: 20, used: 7, remaining: 13, resets_at: '2026-12-01T00:00:00Z' },
  setup: { ready: true, issues: [] },
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

const swarmPart = (status, tasks) => ({ id: 'p-swarm', type: 'swarm', status, swarm_id: 's1', version: 1, title: '', tasks })
const engineTask = (status = 'queued', rev = 1) => ({
  id: 'engines.p1.chatgpt',
  category: 'engines',
  subcategory: 'p1',
  worker: 'engine_answer',
  label: 'ChatGPT',
  target: 'best crm for agencies',
  status,
  rev,
})

function chatDetail({ id = 'c1', run = null, reply = {} } = {}) {
  return {
    id,
    title: 'First research',
    title_source: 'model',
    created_at: '2026-11-08T10:00:00Z',
    current_leaf_id: 'a1',
    messages: [
      { id: 'u1', chat_id: id, parent_id: null, role: 'user', status: 'complete', parts: [], sibling_ids: ['u1'] },
      { id: 'a1', chat_id: id, parent_id: 'u1', role: 'assistant', status: 'streaming', parts: [], parts_seq: 0, sibling_ids: ['a1'], ...reply },
    ],
    active_run: run,
  }
}

let seq = 0
const event = (type, payload = {}) => ({ v: 1, seq: ++seq, type, run_id: 'r1', message_id: 'a1', ts: '2026-11-08T10:00:00Z', ...payload })

const mounted = []

function host(wid, options) {
  let model
  const Host = defineComponent({
    setup() {
      model = useSetupStatus(wid, options)
      return () => h('div')
    },
  })
  const wrapper = mount(Host)
  mounted.push(wrapper)
  return { wrapper, model: () => model }
}

async function scopeStore(wid) {
  const agent = useAgentStore()
  await agent.init(wid)
  await flushPromises()
  return agent
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  setActivePinia(createPinia())
  useAuthStore().user = { id: 7 }
  rm.attached = []
  rm.detached = []
  seq = 0
  vi.clearAllMocks()
  agentApi.status.mockResolvedValue(ok(STATUS))
  agentApi.agents.mockResolvedValue(ok([]))
  agentApi.listChats.mockResolvedValue(ok({ results: [], next_cursor: null }))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
})

describe('useSetupStatus', () => {
  it('shows nothing about research and no panel for a project without a record and nothing missing', async () => {
    await scopeStore('w1')
    const { model } = host('w1')
    await flushPromises()
    expect(model().research.value.state).toBe('none')
    expect(model().panel.value).toMatchObject({ visible: false, complete: true })
    expect(agentApi.getChat).not.toHaveBeenCalled()
  })

  it("loads the first research chat once and follows its run through the store's run manager", async () => {
    noteSetupFinished(7, 'w1', 'research', Date.now())
    noteFirstResearchChat(7, 'w1', 'c1')
    // The chat list names the active run too, so the store follows it on its own.
    agentApi.listChats.mockResolvedValue(ok({ results: [{ id: 'c1', title: 'First research', active_run_id: 'r1' }], next_cursor: null }))
    agentApi.getChat.mockResolvedValue(ok(chatDetail({ run: { id: 'r1', chat_id: 'c1', message_id: 'a1', status: 'queued', last_seq: 0, queue: { position: 2, ahead: 1, slots: 6 } } })))
    const agent = await scopeStore('w1')
    const { model } = host('w1')
    await flushPromises()

    // One request for the chat, whoever asked first; the run is followed once.
    expect(agentApi.getChat).toHaveBeenCalledTimes(1)
    expect(agentApi.getChat).toHaveBeenCalledWith('w1', 'c1', expect.anything())
    expect(rm.attached).toEqual(['r1'])
    expect(model().research.value).toMatchObject({ state: 'queued', title: 'Waiting for a free slot (1 ahead)' })
    expect(model().panel.value).toMatchObject({ visible: true, dismissible: false })

    rm.hooks.applyEvents('r1', [event('run.queued', { position: 1, ahead: 0, slots: 6 })])
    await nextTick()
    expect(model().research.value.title).toBe('Waiting for a free slot')

    rm.hooks.applyEvents('r1', [event('run.started', { model: 'claude-opus-5-5' })])
    await nextTick()
    expect(model().research.value).toMatchObject({ state: 'running', stage: 'plan' })

    rm.hooks.applyEvents('r1', [event('part.added', { part: swarmPart('running', [engineTask()]) })])
    rm.hooks.applyEvents('r1', [event('task.started', { part_id: 'p-swarm', task_id: 'engines.p1.chatgpt', rev: 2, patch: { status: 'running' } })])
    await nextTick()
    expect(model().research.value).toMatchObject({ state: 'running', stage: 'research', line: '0 of 1 agent finished' })
    expect(model().research.value.asking).toEqual([{ id: 'engines.p1.chatgpt', who: 'ChatGPT', prompt: 'best crm for agencies' }])

    rm.hooks.applyEvents('r1', [event('task.finished', { part_id: 'p-swarm', task_id: 'engines.p1.chatgpt', rev: 3, patch: { status: 'done' } })])
    rm.hooks.applyEvents('r1', [event('part.added', { part: swarmPart('done', [engineTask('done', 3)]) })])
    await nextTick()
    expect(model().research.value.stage).toBe('write')

    expect(agentApi.status).toHaveBeenCalledTimes(1)
    rm.hooks.applyEvents('r1', [event('run.completed', { status: 'complete' })])
    await flushPromises()
    expect(model().research.value).toMatchObject({ state: 'done', title: 'Your first research is ready.', line: '1 of 1 agent finished' })
    // The research used prompt runs: the store reads the status once more
    // when the run ends, and the panel adds no request of its own.
    expect(agentApi.status).toHaveBeenCalledTimes(2)
    expect(model().runsLine.value.text).toBe('13 free prompt runs left')
    expect(model().panel.value).toMatchObject({ visible: true, dismissible: true })
    expect(model().steps.value.map((s) => s.key)).toEqual(['results', 'autopilot', 'prompts'])
    // Still the one chat request: the panel polls nothing of its own.
    expect(agentApi.getChat).toHaveBeenCalledTimes(1)
    expect(agent.runs.r1.phase).toBe('done')
  })

  it('reads a research that ended before this visit from its saved reply', async () => {
    noteFirstResearchChat(7, 'w1', 'c1')
    agentApi.getChat.mockResolvedValue(
      ok(chatDetail({ reply: { status: 'complete', parts: [swarmPart('done', [engineTask('done', 3)])] } })),
    )
    await scopeStore('w1')
    const { model } = host('w1')
    await flushPromises()
    expect(rm.attached).toEqual([])
    expect(model().research.value).toMatchObject({ state: 'done', line: '1 of 1 agent finished' })
  })

  it('says the chat was deleted when it is gone', async () => {
    noteFirstResearchChat(7, 'w1', 'c1')
    agentApi.getChat.mockRejectedValue(notFound())
    await scopeStore('w1')
    const { model } = host('w1')
    await flushPromises()
    expect(model().research.value.state).toBe('missing')
    expect(model().steps.value[0].key).toBe('research')
  })

  it("waits for the store to serve this project before it asks for the chat", async () => {
    noteFirstResearchChat(7, 'w1', 'c1')
    agentApi.getChat.mockResolvedValue(ok(chatDetail()))
    await scopeStore('w2')
    const wid = ref('w1')
    const { model } = host(wid)
    await flushPromises()
    expect(agentApi.getChat).not.toHaveBeenCalled()
    expect(model().chatId.value).toBeNull()

    await scopeStore('w1')
    await flushPromises()
    expect(agentApi.getChat).toHaveBeenCalledTimes(1)
    expect(model().chatId.value).toBe('c1')
  })

  it("drops a chat answer that lands after a project switch and shows the new project's record", async () => {
    noteFirstResearchChat(7, 'w1', 'c1')
    noteSetupFinished(7, 'w2', 'skip', Date.now())
    const late = deferred()
    agentApi.getChat.mockReturnValueOnce(late.promise)
    const agent = await scopeStore('w1')
    const wid = ref('w1')
    const { model } = host(wid)
    await flushPromises()
    expect(agentApi.getChat).toHaveBeenCalledTimes(1)

    // The project changes while the chat request is out.
    wid.value = 'w2'
    await agent.init('w2')
    await flushPromises()
    late.resolve(ok(chatDetail({ run: { id: 'r1', chat_id: 'c1', message_id: 'a1', status: 'running', last_seq: 0 } })))
    await flushPromises()

    expect(model().record.value.mode).toBe('skip')
    expect(model().chatId.value).toBeNull()
    expect(model().research.value.state).toBe('none')
    // The old project's run was never attached for the new one.
    expect(rm.attached).toEqual([])
    expect(agent.chatState.c1).toBeUndefined()
    expect(agentApi.getChat).toHaveBeenCalledTimes(1)
  })

  it("stops following when the project changes: the store detaches the old project's run", async () => {
    noteFirstResearchChat(7, 'w1', 'c1')
    agentApi.getChat.mockResolvedValue(ok(chatDetail({ run: { id: 'r1', chat_id: 'c1', message_id: 'a1', status: 'running', last_seq: 0 } })))
    const agent = await scopeStore('w1')
    const wid = ref('w1')
    const { model } = host(wid)
    await flushPromises()
    expect(rm.attached).toEqual(['r1'])

    wid.value = 'w2'
    await agent.init('w2')
    await flushPromises()
    expect(rm.detached).toEqual(['r1'])
    expect(model().research.value.state).toBe('none')
    // One status read per project, none for the switch itself.
    expect(agentApi.status).toHaveBeenCalledTimes(2)
  })

  it('asks for nothing after it unmounts', async () => {
    noteFirstResearchChat(7, 'w1', 'c1')
    agentApi.getChat.mockResolvedValue(ok(chatDetail()))
    await scopeStore('w2')
    const { wrapper } = host('w1')
    await flushPromises()
    wrapper.unmount()
    mounted.length = 0
    await scopeStore('w1')
    await flushPromises()
    expect(agentApi.getChat).not.toHaveBeenCalled()
  })

  it("lists what is not set up from the store's status, and Check again reloads it once at a time", async () => {
    const agent = await scopeStore('w1')
    const { model } = host('w1')
    await flushPromises()
    expect(model().issues.value).toEqual([])
    expect(model().runsLine.value.text).toBe('13 free prompt runs left')
    expect(agentApi.status).toHaveBeenCalledTimes(1)

    const pending = deferred()
    agentApi.status.mockReturnValueOnce(pending.promise)
    model().checkAgain()
    model().checkAgain()
    expect(agentApi.status).toHaveBeenCalledTimes(2)
    expect(model().checking.value).toBe(true)
    pending.resolve(
      ok({
        ...STATUS,
        setup: {
          ready: true,
          issues: [{ code: 'engine_not_configured', severity: 'limited', subject: 'engine', engine: 'grok', setting: null, title: "Grok isn't set up on this workspace.", action: 'Grok is skipped.' }],
        },
      }),
    )
    await flushPromises()
    expect(model().checking.value).toBe(false)
    expect(model().issues.value.map((i) => i.title)).toEqual(["Grok isn't set up on this workspace."])
    expect(model().panel.value).toMatchObject({ visible: true, incomplete: true, dismissible: false })
    expect(agent.status.setup.issues).toHaveLength(1)
  })

  it('says the status could not be read', async () => {
    agentApi.status.mockRejectedValue(new Error('down'))
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    await scopeStore('w1')
    const { model } = host('w1')
    await flushPromises()
    expect(model().statusFailed.value).toBe(true)
    expect(model().panel.value).toMatchObject({ visible: true, dismissible: false })
  })

  it('dismisses only once it may, and remembers the dismissal and the fold per project', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    await scopeStore('w1')
    const wid = ref('w1')
    const { model } = host(wid)
    await flushPromises()
    model().setCollapsed(true)
    expect(model().collapsed.value).toBe(true)
    expect(readSetup(7, 'w1').collapsed).toBe(true)
    expect(model().dismiss()).toBe(true)
    expect(model().panel.value.visible).toBe(false)
    expect(readSetup(7, 'w1').dismissed).toBe(true)

    // Another project keeps its own record.
    noteFirstResearchChat(7, 'w2', 'c2')
    agentApi.getChat.mockReturnValue(new Promise(() => {}))
    wid.value = 'w2'
    await scopeStore('w2')
    expect(model().collapsed.value).toBe(false)
    expect(model().panel.value.visible).toBe(true)
    // The research is in flight (loading): not dismissible yet.
    expect(model().dismiss()).toBe(false)
    expect(readSetup(7, 'w2').dismissed).toBe(false)
  })

  it('still hides for this visit when storage refuses the dismissal', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    await scopeStore('w1')
    const { model } = host('w1')
    await flushPromises()
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(model().dismiss()).toBe(true)
    expect(model().panel.value.visible).toBe(false)
    model().setCollapsed(true)
    expect(model().collapsed.value).toBe(true)
    spy.mockRestore()
  })

  it('leaves Autopilot out of the next steps when it runs', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    await scopeStore('w1')
    const autopilotOn = ref(null)
    const { model } = host('w1', { autopilotOn })
    await flushPromises()
    expect(model().steps.value.map((s) => s.key)).toEqual(['research', 'autopilot', 'prompts'])
    autopilotOn.value = true
    await nextTick()
    expect(model().steps.value.map((s) => s.key)).toEqual(['research', 'prompts'])
  })
})
