import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed } from 'vue'

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
        createChat: vi.fn(),
        getChat: vi.fn(),
        updateChat: vi.fn(),
        deleteChat: vi.fn(),
        feedback: vi.fn(),
        listArtifacts: vi.fn(),
        getArtifact: vi.fn(),
        listVersions: vi.fn(),
        getVersion: vi.fn(),
        saveReport: vi.fn(),
        suggestions: vi.fn(),
        activity: vi.fn(),
        listReviews: vi.fn(),
        getSwarm: vi.fn(),
        getSwarmVersion: vi.fn(),
        sendMessage: vi.fn(),
        regenerate: vi.fn(),
        editMessage: vi.fn(),
        continueMessage: vi.fn(),
        rerunSwarm: vi.fn(),
        cancelRun: vi.fn(),
        browse: vi.fn(),
    },
}))

vi.mock('@/lib/agent/runManager', () => ({
    createRunManager(hooks) {
        rm.hooks = hooks
        const sessions = new Map()
        return {
            attach(run) {
                rm.attached.push({ id: run.id, lastSeq: run.lastSeq })
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
            sessions,
        }
    },
}))

import agentApi from '@/api/agent'
import { useAgentStore } from '@/stores/agent'
import { useAgentPaneStore } from '@/stores/agentPane'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { getLastChat, getLastProject, loadDraft, loadPaneState, saveDraft, savePaneState, setLastChat } from '@/lib/agent/storage'
import {
    ASSISTANT_ID,
    CHAT_ID,
    RUN_ID,
    USER_MESSAGE_ID,
    emptyAssistant,
    eventFactory,
    researchRunEvents,
} from '@/lib/agent/__tests__/__fixtures__/runEvents'
import {
    CAPTURE_ID,
    SERP_CAPTURE as SWARM_SERP_CAPTURE,
    SWARM_ID,
    expectedSwarmPart,
    swarmTable,
} from '@/lib/agent/__tests__/__fixtures__/swarmEvents'

const ok = (data) => ({ success: true, data })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function axiosError(status, error) {
    return Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        config: {},
        response: { status, data: { success: false, error } },
    })
}

function userMessage(overrides = {}) {
    return {
        id: USER_MESSAGE_ID,
        chat_id: CHAT_ID,
        parent_id: null,
        role: 'user',
        status: 'complete',
        parts: [{ id: 'u-text', type: 'text', text: 'Research Turonote' }],
        parts_seq: 0,
        sibling_ids: [USER_MESSAGE_ID],
        ...overrides,
    }
}

function chatDetail(overrides = {}) {
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
        ...overrides,
    }
}

function accepted(overrides = {}) {
    return ok({
        user_message: userMessage(),
        assistant_message: emptyAssistant(),
        run: { id: RUN_ID, chat_id: CHAT_ID, message_id: ASSISTANT_ID, status: 'queued', last_seq: 0 },
        ...overrides,
    })
}

let store
let auth

async function initProject() {
    agentApi.status.mockResolvedValue(ok({ enabled: true, live_available: true, model: 'claude-opus-5-5', engines: [], allowance: null }))
    agentApi.listChats.mockResolvedValue(ok({ results: [], next_cursor: null }))
    agentApi.agents.mockResolvedValue(ok([{ key: 'gap_analyst', name: 'Gap Analyst', output_kind: 'report' }]))
    await store.init(5)
}

/** A chat opened with a running run whose parts are checkpointed at seq 10. */
async function openRunningChat() {
    agentApi.getChat.mockResolvedValueOnce(
        ok(
            chatDetail({
                title: 'Turonote visibility',
                current_leaf_id: ASSISTANT_ID,
                messages: [
                    userMessage(),
                    emptyAssistant({ parts: [{ id: 'p-text', type: 'text', request: 1, text: 'Partial' }], parts_seq: 10 }),
                ],
                active_run: { id: RUN_ID, status: 'running', message_id: ASSISTANT_ID, last_seq: 14 },
            })
        )
    )
    await store.openChat(CHAT_ID)
}

beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    Object.values(agentApi).forEach((fn) => fn.mockReset())
    rm.hooks = null
    rm.attached = []
    rm.detached = []
    auth = useAuthStore()
    auth.accessToken = 'token'
    auth.user = { id: 7 }
    store = useAgentStore()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('agent store: loading', () => {
    it('init scopes the store and loads status, chats and the catalog', async () => {
        agentApi.status.mockResolvedValue(ok({ enabled: true, live_available: true }))
        agentApi.agents.mockResolvedValue(ok([{ key: 'gap_analyst', name: 'Gap Analyst' }]))
        agentApi.listChats.mockResolvedValue(
            ok({
                results: [
                    { id: 'c2', title: 'Running', preview: '', created_at: null, last_message_at: null, active_run_id: 'run-9' },
                    { id: 'c1', title: 'Older', preview: '', created_at: null, last_message_at: null, active_run_id: null },
                ],
                next_cursor: 'cursor-2',
            })
        )
        agentApi.getChat.mockResolvedValue(
            ok(
                chatDetail({
                    id: 'c2',
                    current_leaf_id: 'a9',
                    messages: [
                        userMessage({ id: 'u9', chat_id: 'c2', sibling_ids: ['u9'] }),
                        emptyAssistant({ id: 'a9', chat_id: 'c2', parent_id: 'u9', sibling_ids: ['a9'], parts_seq: 3 }),
                    ],
                    active_run: { id: 'run-9', status: 'running', message_id: 'a9', last_seq: 5 },
                })
            )
        )
        await store.init(5)
        await flush()

        expect(store.websiteId).toBe('5')
        expect(getLastProject('7')).toBe('5')
        expect(store.status).toEqual({ enabled: true, live_available: true })
        expect(store.catalog).toHaveLength(1)
        expect(store.recents.map((c) => c.id)).toEqual(['c2', 'c1'])
        expect(store.chats.hasMore).toBe(true)
        // A run another tab started is followed so the list can show it finish.
        expect(agentApi.getChat).toHaveBeenCalledWith('5', 'c2', { _silentError: true })
        expect(rm.attached).toEqual([{ id: 'run-9', lastSeq: 3 }])
        expect(store.recents[0].running).toBe(true)
        expect(store.recents[1].running).toBe(false)
    })

    it('loads more chats with the cursor and keeps the order', async () => {
        await initProject()
        agentApi.listChats.mockResolvedValueOnce(ok({ results: [{ id: 'a' }, { id: 'b' }], next_cursor: 'n1' }))
        await store.loadChats({ q: '' })
        agentApi.listChats.mockResolvedValueOnce(ok({ results: [{ id: 'b' }, { id: 'c' }], next_cursor: null }))
        await store.loadChats({ more: true })
        expect(agentApi.listChats).toHaveBeenLastCalledWith('5', { q: undefined, cursor: 'n1' }, { _silentError: true })
        expect(store.chats.order).toEqual(['a', 'b', 'c'])
        expect(store.chats.hasMore).toBe(false)
    })

    it('records a failed chat list instead of throwing', async () => {
        await initProject()
        agentApi.listChats.mockRejectedValueOnce(axiosError(503, { code: 'agent_disabled', message: 'Off.' }))
        await expect(store.loadChats()).resolves.toBeUndefined()
        expect(store.chats.error).toMatchObject({ status: 503, code: 'agent_disabled', message: 'Off.' })
    })

    it('openChat resumes an active run from the parts checkpoint and remembers the chat', async () => {
        await initProject()
        await openRunningChat()
        expect(store.chatState[CHAT_ID]).toMatchObject({ loaded: true, leafId: ASSISTANT_ID, activeRunId: RUN_ID })
        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_MESSAGE_ID, ASSISTANT_ID])
        expect(rm.attached).toEqual([{ id: RUN_ID, lastSeq: 10 }])
        expect(store.runs[RUN_ID]).toMatchObject({ phase: 'running', chatId: CHAT_ID, messageId: ASSISTANT_ID })
        expect(store.isChatBusy(CHAT_ID)).toBe(true)
        expect(getLastChat('7', '5')).toBe(CHAT_ID)
        // Cached for the session: a second open does not refetch.
        await store.openChat(CHAT_ID)
        expect(agentApi.getChat).toHaveBeenCalledTimes(1)
    })

    it('keeps its project when the active website changes without the workspace URL', async () => {
        await initProject()
        // A page that blocked a project switch still shows project 5.
        useAppStore().setActiveWebsite({ id: 6, name: 'Other' })
        await flush()
        expect(store.websiteId).toBe('5')
        expect(agentApi.listChats).toHaveBeenCalledTimes(1)
    })

    it('keeps no brand context of its own: the Context page reads and writes it', () => {
        expect(store.context).toBeUndefined()
        expect(store.loadContext).toBeUndefined()
        expect(store.saveContext).toBeUndefined()
    })

    it('loads the review count with the activity and drops it on a project switch', async () => {
        await initProject()
        agentApi.activity.mockResolvedValue(ok([{ type: 'run_completed', at: '2026-11-02T10:00:00Z', chat_id: CHAT_ID }]))
        agentApi.listReviews.mockResolvedValue(ok([{ id: 'a1' }, { id: 'a2' }]))
        await store.loadActivity()
        await flush()
        expect(agentApi.listReviews).toHaveBeenCalledWith('5', 'waiting')
        expect(store.reviewsWaiting).toBe(2)

        // A failed count is unknown, never zero.
        agentApi.listReviews.mockRejectedValueOnce(axiosError(500, { code: 'server_error', message: 'Down.' }))
        await store.loadActivity()
        await flush()
        expect(store.reviewsWaiting).toBeNull()

        agentApi.listReviews.mockResolvedValue(ok([]))
        await store.loadReviewsWaiting()
        expect(store.reviewsWaiting).toBe(0)
        store.resetProjectScope()
        expect(store.reviewsWaiting).toBeNull()
    })

    it('follows a review action on the artifact it knows', async () => {
        await initProject()
        agentApi.getArtifact.mockResolvedValue(
            ok({ id: 'a1', kind: 'document', title: 'Draft', latest_version: 2, version: 2, content: '# Draft', review: { state: 'draft', effective_state: 'draft', version: 0, reviewer_name: '', updated_at: null } })
        )
        await store.loadArtifact('a1')
        store.setArtifactReview('a1', { state: 'approved', effective_state: 'approved', version: 2, reviewer_name: 'Ana' })
        expect(store.artifact('a1').review).toMatchObject({ state: 'approved', effective_state: 'approved', version: 2 })
        // An artifact the store has not loaded is left alone.
        store.setArtifactReview('zz', { state: 'approved' })
        expect(store.artifacts.zz).toBeUndefined()
    })

    it('openChat keeps a 404 out of the last-chat memory', async () => {
        await initProject()
        agentApi.getChat.mockRejectedValueOnce(axiosError(404, { code: 'not_found', message: 'Not found.' }))
        const state = await store.openChat('gone')
        expect(state.error).toMatchObject({ status: 404 })
        expect(getLastChat('7', '5')).toBeNull()
    })
})

describe('agent store: a research turn end to end', () => {
    it('creates the chat, streams the run into parts and pane tabs, and finishes it', async () => {
        await initProject()
        const pane = useAgentPaneStore()
        pane.bindChat('new')
        agentApi.createChat.mockResolvedValueOnce(ok(chatDetail()))
        let resolvePost
        agentApi.sendMessage.mockImplementationOnce(() => new Promise((resolve) => (resolvePost = resolve)))

        const chatId = await store.send({ chatId: null, text: '  Research Turonote ', agent: 'gap_analyst' })

        expect(chatId).toBe(CHAT_ID)
        expect(agentApi.createChat).toHaveBeenCalledWith('5', { entry_agent: 'gap_analyst' }, { _silentError: true })
        expect(pane.chatKey).toBe(CHAT_ID)
        expect(store.recents.map((c) => c.id)).toEqual([CHAT_ID])
        const [optimistic] = store.visiblePath(CHAT_ID)
        expect(optimistic).toMatchObject({ role: 'user', status: 'sending', local: true, parent_id: null })
        expect(optimistic.parts[0].text).toBe('Research Turonote')
        expect(store.isChatBusy(CHAT_ID)).toBe(true)
        const [wid, cid, body, options] = agentApi.sendMessage.mock.calls[0]
        expect([wid, cid]).toEqual(['5', CHAT_ID])
        expect(body).toEqual({ text: 'Research Turonote', parent_id: undefined, agent: 'gap_analyst' })
        expect(options.idempotencyKey).toEqual(expect.any(String))

        resolvePost(accepted())
        await flush()

        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_MESSAGE_ID, ASSISTANT_ID])
        expect(store.messages[USER_MESSAGE_ID].client_id).toBe(optimistic.id)
        expect(store.messages[optimistic.id]).toBeUndefined()
        expect(rm.attached).toEqual([{ id: RUN_ID, lastSeq: 0 }])
        expect(store.activeRun(CHAT_ID).id).toBe(RUN_ID)

        const events = researchRunEvents()
        rm.hooks.applyEvents(RUN_ID, events.slice(0, -1))
        const message = store.messages[ASSISTANT_ID]
        expect(message.status).toBe('streaming')
        expect(message.parts.map((p) => p.type)).toEqual(['thinking', 'serp', 'engine_check', 'engine_check', 'text'])
        expect(message.research.serp['cap-1'].results).toHaveLength(3)
        expect(store.runs[RUN_ID]).toMatchObject({ phase: 'running', lastSeq: 17 })
        expect(store.runs[RUN_ID].usage.cost_usd).toBe(0.0125)
        expect(store.chats.byId[CHAT_ID].title).toBe('Turonote visibility')

        const tab = pane.tabs.find((t) => t.id === 'serp:cap-1')
        expect(tab).toMatchObject({ kind: 'serp', status: 'ready' })
        expect(tab.data.results).toHaveLength(3)
        expect(pane.activeId).toBe('serp:cap-1')

        // Replayed events (a reconnect) change nothing.
        const before = store.messages[ASSISTANT_ID]
        rm.hooks.applyEvents(RUN_ID, events.slice(10, 15))
        expect(store.messages[ASSISTANT_ID]).toBe(before)

        store.setViewingChat(null)
        rm.hooks.applyEvents(RUN_ID, events.slice(-1))
        expect(store.messages[ASSISTANT_ID].status).toBe('complete')
        expect(store.runs[RUN_ID]).toMatchObject({ phase: 'done', durationMs: 9000 })
        expect(store.activeRun(CHAT_ID)).toBeNull()
        expect(store.isChatBusy(CHAT_ID)).toBe(false)
        expect(useAgentUiStore().isUnseen(CHAT_ID)).toBe(true)
        expect(store.recents[0].unseen).toBe(true)
        // The allowance is refreshed after spend.
        expect(agentApi.status).toHaveBeenCalledTimes(2)
    })

    it('keeps a failed send on screen and retries it with the same Idempotency-Key', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(ok(chatDetail()))
        agentApi.sendMessage.mockRejectedValueOnce(axiosError(429, { code: 'agent_busy', message: 'You already have a run in progress.' }))
        await store.send({ chatId: CHAT_ID, text: 'Hello' })
        await flush()

        const [failed] = store.visiblePath(CHAT_ID)
        expect(failed.status).toBe('send_failed')
        expect(failed.send.error).toMatchObject({ status: 429, code: 'agent_busy', retryable: true })
        expect(store.isChatBusy(CHAT_ID)).toBe(false)

        agentApi.sendMessage.mockResolvedValueOnce(accepted())
        await store.retrySend(failed.id)
        const keys = agentApi.sendMessage.mock.calls.map((c) => c[3].idempotencyKey)
        expect(keys[1]).toBe(keys[0])
        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_MESSAGE_ID, ASSISTANT_ID])
    })

    it('editing a failed send posts the new text with a new Idempotency-Key', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(ok(chatDetail()))
        // The response was lost: the server may have started a turn with this key.
        agentApi.sendMessage.mockRejectedValueOnce(axiosError(502, {}))
        await store.send({ chatId: CHAT_ID, text: 'Old question' })
        await flush()
        const [failed] = store.visiblePath(CHAT_ID)
        expect(failed.status).toBe('send_failed')

        agentApi.sendMessage.mockResolvedValueOnce(accepted())
        await store.editMessage(failed.id, 'New question')
        const [first, second] = agentApi.sendMessage.mock.calls
        expect(second[2].text).toBe('New question')
        expect(second[3].idempotencyKey).toEqual(expect.any(String))
        expect(second[3].idempotencyKey).not.toBe(first[3].idempotencyKey)
    })

    it('sends a follow-up under the current leaf', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(
            ok(chatDetail({ current_leaf_id: ASSISTANT_ID, messages: [userMessage(), emptyAssistant({ status: 'complete' })] }))
        )
        await store.openChat(CHAT_ID)
        agentApi.sendMessage.mockImplementationOnce(() => new Promise(() => {}))
        await store.send({ chatId: CHAT_ID, text: 'And on Perplexity?' })
        expect(agentApi.sendMessage.mock.calls[0][2].parent_id).toBe(ASSISTANT_ID)
        expect(store.visiblePath(CHAT_ID).map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
        await expect(store.send({ chatId: CHAT_ID, text: 'Again' })).rejects.toMatchObject({ code: 'run_in_progress' })
    })

    it('loads a chat it has not opened before replying under its leaf', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(
            ok(chatDetail({ current_leaf_id: ASSISTANT_ID, messages: [userMessage(), emptyAssistant({ status: 'complete' })] }))
        )
        agentApi.sendMessage.mockImplementationOnce(() => new Promise(() => {}))
        await store.send({ chatId: CHAT_ID, text: 'Next question' })
        expect(agentApi.getChat).toHaveBeenCalledTimes(1)
        expect(agentApi.sendMessage.mock.calls[0][2].parent_id).toBe(ASSISTANT_ID)
    })

    it('does not send when the chat cannot be loaded', async () => {
        await initProject()
        agentApi.getChat.mockRejectedValueOnce(axiosError(404, { code: 'not_found', message: 'Not found.' }))
        await expect(store.send({ chatId: 'gone', text: 'Hello' })).rejects.toMatchObject({ status: 404 })
        expect(agentApi.sendMessage).not.toHaveBeenCalled()
    })

    it('rejects an empty message without calling the API', async () => {
        await initProject()
        await expect(store.send({ chatId: null, text: '   ' })).rejects.toMatchObject({ code: 'invalid' })
        expect(agentApi.createChat).not.toHaveBeenCalled()
    })

    it('shows a new chat message while the chat is created, then moves it to the chat', async () => {
        await initProject()
        await store.openChat(null)
        let resolveCreate
        agentApi.createChat.mockImplementationOnce(() => new Promise((resolve) => (resolveCreate = resolve)))
        agentApi.sendMessage.mockImplementationOnce(() => new Promise(() => {}))

        const sending = store.send({ chatId: null, text: 'Research Turonote' })
        const [early] = store.visiblePath('new')
        expect(early).toMatchObject({ role: 'user', status: 'sending', local: true })
        expect(early.parts[0].text).toBe('Research Turonote')
        expect(store.isChatBusy('new')).toBe(true)

        resolveCreate(ok(chatDetail()))
        await expect(sending).resolves.toBe(CHAT_ID)
        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([early.id])
        expect(store.messages[early.id].chat_id).toBe(CHAT_ID)
        expect(store.childrenOf['root:new']).toBeUndefined()
        expect(store.isChatBusy(CHAT_ID)).toBe(true)

        // Back on the new-chat view, the moved message is not shown there.
        await store.openChat(null)
        expect(store.visiblePath('new')).toEqual([])
    })

    it('drops the new chat message when the chat cannot be created', async () => {
        await initProject()
        await store.openChat(null)
        agentApi.createChat.mockRejectedValueOnce(axiosError(503, { code: 'agent_disabled', message: 'The agent is switched off.' }))
        await expect(store.send({ chatId: null, text: 'Hello' })).rejects.toMatchObject({ status: 503, code: 'agent_disabled' })
        expect(store.visiblePath('new')).toEqual([])
        expect(Object.values(store.messages).filter((m) => m.local)).toEqual([])
        expect(store.isChatBusy('new')).toBe(false)
        expect(agentApi.sendMessage).not.toHaveBeenCalled()
    })
})

describe('agent store: resync, stop and transport loss', () => {
    it('resync reloads the snapshot and resumes from its parts_seq', async () => {
        await initProject()
        await openRunningChat()
        const e = eventFactory({ start: 10 })
        rm.hooks.applyEvents(RUN_ID, [e('part.delta', { part_id: 'p-text', field: 'text', append: ' more' })])
        expect(store.messages[ASSISTANT_ID].parts[0].text).toBe('Partial more')

        agentApi.getChat.mockResolvedValueOnce(
            ok(
                chatDetail({
                    current_leaf_id: ASSISTANT_ID,
                    messages: [
                        userMessage(),
                        emptyAssistant({ parts: [{ id: 'p-text', type: 'text', request: 1, text: 'Checkpointed text' }], parts_seq: 20 }),
                    ],
                    active_run: { id: RUN_ID, status: 'running', message_id: ASSISTANT_ID, last_seq: 22 },
                })
            )
        )
        const result = await rm.hooks.onResync(RUN_ID, 'buffer_expired')
        expect(result).toEqual({ active: true, lastSeq: 20 })
        expect(store.messages[ASSISTANT_ID].parts[0].text).toBe('Checkpointed text')
        expect(store.runs[RUN_ID].lastSeq).toBe(20)
    })

    it('resync that finds the run over settles it from the message status', async () => {
        await initProject()
        await openRunningChat()
        agentApi.getChat.mockResolvedValueOnce(
            ok(chatDetail({ current_leaf_id: ASSISTANT_ID, messages: [userMessage(), emptyAssistant({ status: 'complete', parts_seq: 30 })] }))
        )
        const result = await rm.hooks.onResync(RUN_ID, 'restart')
        expect(result.active).toBe(false)
        expect(store.runs[RUN_ID].phase).toBe('done')
        expect(store.isChatBusy(CHAT_ID)).toBe(false)
    })

    /** The chat detail the server returns while a stopped run winds down, then after it ended. */
    function stoppingDetail({ runStatus = 'running', messageStatus = 'streaming', partsSeq = 12 } = {}) {
        return ok(
            chatDetail({
                current_leaf_id: ASSISTANT_ID,
                messages: [
                    userMessage(),
                    emptyAssistant({
                        status: messageStatus,
                        parts: [{ id: 'p-text', type: 'text', request: 1, text: 'Partial and saved' }],
                        parts_seq: partsSeq,
                    }),
                ],
                active_run: runStatus ? { id: RUN_ID, status: runStatus, message_id: ASSISTANT_ID, last_seq: partsSeq } : null,
            })
        )
    }

    it('stop asks the server after 8 seconds and stays busy while the run still runs there', async () => {
        vi.useFakeTimers()
        await initProject()
        await openRunningChat()
        agentApi.cancelRun.mockResolvedValueOnce(ok({ status: 'running' }))
        await store.stop(CHAT_ID)
        expect(agentApi.cancelRun).toHaveBeenCalledWith(RUN_ID)
        expect(store.runs[RUN_ID]).toMatchObject({ phase: 'cancelling', cancelRequested: true })
        expect(store.isChatBusy(CHAT_ID)).toBe(true)

        // A tool in flight (the engine checks) keeps the run going past 8 s.
        agentApi.getChat.mockResolvedValueOnce(stoppingDetail())
        await vi.advanceTimersByTimeAsync(7999)
        expect(agentApi.getChat).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(agentApi.getChat).toHaveBeenCalledTimes(2)
        expect(store.runs[RUN_ID].phase).toBe('cancelling')
        expect(store.isChatBusy(CHAT_ID)).toBe(true)
        expect(rm.detached).not.toContain(RUN_ID)

        // The next check finds it over without its terminal event reaching
        // this tab: the saved message is what the server ended with.
        agentApi.getChat.mockResolvedValueOnce(stoppingDetail({ runStatus: null, messageStatus: 'cancelled', partsSeq: 30 }))
        await vi.advanceTimersByTimeAsync(8000)
        expect(rm.detached).toContain(RUN_ID)
        expect(store.runs[RUN_ID].phase).toBe('cancelled')
        expect(store.runs[RUN_ID].settledLocally).toBe(false)
        expect(store.messages[ASSISTANT_ID]).toMatchObject({ status: 'cancelled', parts_seq: 30 })
        expect(store.messages[ASSISTANT_ID].parts[0].text).toBe('Partial and saved')
        expect(store.isChatBusy(CHAT_ID)).toBe(false)
    })

    it('stop confirms at once when the server says the run already ended', async () => {
        vi.useFakeTimers()
        await initProject()
        await openRunningChat()
        agentApi.cancelRun.mockResolvedValueOnce(ok({ status: 'completed' }))
        agentApi.getChat.mockResolvedValueOnce(stoppingDetail({ runStatus: null, messageStatus: 'complete', partsSeq: 40 }))
        await store.stop(CHAT_ID)
        await vi.advanceTimersByTimeAsync(0)
        // It finished before the stop took effect: done, not cancelled.
        expect(store.runs[RUN_ID].phase).toBe('done')
        expect(store.messages[ASSISTANT_ID].status).toBe('complete')
        expect(store.isChatBusy(CHAT_ID)).toBe(false)
        await vi.advanceTimersByTimeAsync(20000)
        expect(agentApi.getChat).toHaveBeenCalledTimes(2)
    })

    it('stop settles locally when the server does not know the run', async () => {
        await initProject()
        await openRunningChat()
        agentApi.cancelRun.mockRejectedValueOnce(axiosError(404, { code: 'not_found', message: 'Not found.' }))
        await store.stop(CHAT_ID)
        expect(store.runs[RUN_ID]).toMatchObject({ phase: 'cancelled', settledLocally: true })
        expect(store.messages[ASSISTANT_ID].status).toBe('cancelled')
        expect(rm.detached).toContain(RUN_ID)
        expect(store.isChatBusy(CHAT_ID)).toBe(false)
    })

    it('follows a run again when the server still runs it after this tab gave up on its stream', async () => {
        await initProject()
        await openRunningChat()
        rm.hooks.onClose(RUN_ID, { terminal: false, error: { isTransportError: true, status: 401, code: 'unauthorized', retryable: false } })
        expect(store.runs[RUN_ID]).toMatchObject({ phase: 'failed', settledLocally: true })
        expect(store.isChatBusy(CHAT_ID)).toBe(false)

        agentApi.getChat.mockResolvedValueOnce(stoppingDetail({ partsSeq: 18 }))
        await store.openChat(CHAT_ID, { force: true })
        expect(store.runs[RUN_ID]).toMatchObject({ phase: 'running', settledLocally: false, error: null, lastSeq: 18 })
        expect(rm.attached.at(-1)).toEqual({ id: RUN_ID, lastSeq: 18 })
        expect(store.messages[ASSISTANT_ID].status).toBe('streaming')
        expect(store.isChatBusy(CHAT_ID)).toBe(true)
    })

    it('the chat list follows a run this tab gave up on while the server still runs it', async () => {
        await initProject()
        await openRunningChat()
        rm.hooks.onClose(RUN_ID, { terminal: false, error: { isTransportError: true, code: 'resync_failed', retryable: false } })
        agentApi.listChats.mockResolvedValueOnce(ok({ results: [{ id: CHAT_ID, active_run_id: RUN_ID }], next_cursor: null }))
        agentApi.getChat.mockResolvedValueOnce(stoppingDetail({ partsSeq: 20 }))
        await store.loadChats()
        await flush()
        expect(agentApi.getChat).toHaveBeenCalledTimes(2)
        expect(rm.attached.at(-1)).toEqual({ id: RUN_ID, lastSeq: 20 })
        expect(store.recents[0].running).toBe(true)
    })

    it('a send refused with run_in_progress loads the chat so its active run shows', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(
            ok(chatDetail({ current_leaf_id: ASSISTANT_ID, messages: [userMessage(), emptyAssistant({ status: 'complete' })] }))
        )
        await store.openChat(CHAT_ID)
        agentApi.sendMessage.mockRejectedValueOnce(
            axiosError(409, { code: 'run_in_progress', message: 'This chat is already working on a reply.', details: { run_id: 'run-9' } })
        )
        agentApi.getChat.mockResolvedValueOnce(
            ok(
                chatDetail({
                    current_leaf_id: 'a9',
                    messages: [
                        userMessage(),
                        emptyAssistant({ status: 'complete' }),
                        userMessage({ id: 'u9', parent_id: ASSISTANT_ID, sibling_ids: ['u9'] }),
                        emptyAssistant({ id: 'a9', parent_id: 'u9', sibling_ids: ['a9'], parts_seq: 4 }),
                    ],
                    active_run: { id: 'run-9', status: 'running', message_id: 'a9', last_seq: 6 },
                })
            )
        )
        await store.send({ chatId: CHAT_ID, text: 'Hello again' })
        await flush()
        expect(agentApi.getChat).toHaveBeenCalledTimes(2)
        expect(rm.attached.at(-1)).toEqual({ id: 'run-9', lastSeq: 4 })
        expect(store.isChatBusy(CHAT_ID)).toBe(true)
    })

    it('a Stop pressed while a regenerate is posting cancels that run and leaves nothing behind', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(
            ok(chatDetail({ current_leaf_id: ASSISTANT_ID, messages: [userMessage(), emptyAssistant({ status: 'complete' })] }))
        )
        await store.openChat(CHAT_ID)
        let resolveRegenerate
        agentApi.regenerate.mockImplementationOnce(() => new Promise((resolve) => (resolveRegenerate = resolve)))
        agentApi.cancelRun.mockResolvedValue(ok({ status: 'running' }))
        const pending = store.regenerate(ASSISTANT_ID)
        await store.stop(CHAT_ID)
        expect(agentApi.cancelRun).not.toHaveBeenCalled()
        resolveRegenerate(
            ok({
                assistant_message: emptyAssistant({ id: 'a2', sibling_ids: [ASSISTANT_ID, 'a2'] }),
                run: { id: 'run-2', chat_id: CHAT_ID, message_id: 'a2', status: 'queued', last_seq: 0 },
            })
        )
        await pending
        expect(agentApi.cancelRun).toHaveBeenCalledWith('run-2')
        expect(store.chatState[CHAT_ID].cancelOnStart).toBe(false)

        // The next message's run is not cancelled by a leftover flag.
        rm.hooks.applyEvents('run-2', [eventFactory({ runId: 'run-2', messageId: 'a2' })('run.cancelled')])
        agentApi.sendMessage.mockResolvedValueOnce(
            accepted({
                user_message: userMessage({ id: 'u3', parent_id: 'a2', sibling_ids: ['u3'] }),
                assistant_message: emptyAssistant({ id: 'a3', parent_id: 'u3', sibling_ids: ['a3'] }),
                run: { id: 'run-3', chat_id: CHAT_ID, message_id: 'a3', status: 'queued', last_seq: 0 },
            })
        )
        await store.send({ chatId: CHAT_ID, text: 'Next question' })
        await flush()
        expect(agentApi.cancelRun).toHaveBeenCalledTimes(1)
        expect(store.runs['run-3'].phase).toBe('queued')
    })

    it('a Stop pressed while a regenerate fails does not cancel the next message', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(
            ok(chatDetail({ current_leaf_id: ASSISTANT_ID, messages: [userMessage(), emptyAssistant({ status: 'complete' })] }))
        )
        await store.openChat(CHAT_ID)
        let rejectRegenerate
        agentApi.regenerate.mockImplementationOnce(() => new Promise((_, reject) => (rejectRegenerate = reject)))
        const pending = store.regenerate(ASSISTANT_ID)
        await store.stop(CHAT_ID)
        rejectRegenerate(axiosError(500, { code: 'server_error' }))
        await expect(pending).rejects.toMatchObject({ status: 500 })
        expect(store.chatState[CHAT_ID].cancelOnStart).toBe(false)
        agentApi.sendMessage.mockResolvedValueOnce(accepted())
        await store.send({ chatId: CHAT_ID, text: 'Hello' })
        await flush()
        expect(agentApi.cancelRun).not.toHaveBeenCalled()
    })

    it('stop ends with the server event when it arrives in time', async () => {
        vi.useFakeTimers()
        await initProject()
        await openRunningChat()
        agentApi.cancelRun.mockResolvedValueOnce(ok({ status: 'cancelling' }))
        await store.stop(CHAT_ID)
        const e = eventFactory({ start: 10 })
        rm.hooks.applyEvents(RUN_ID, [e('run.cancelled')])
        expect(store.runs[RUN_ID].phase).toBe('cancelled')
        vi.advanceTimersByTime(10000)
        expect(rm.detached).not.toContain(RUN_ID)
    })

    it('a send stopped before its 202 cancels the run as soon as it exists', async () => {
        await initProject()
        let resolvePost
        agentApi.sendMessage.mockImplementationOnce(() => new Promise((resolve) => (resolvePost = resolve)))
        agentApi.cancelRun.mockResolvedValue(ok({ status: 'cancelling' }))
        agentApi.getChat.mockResolvedValueOnce(ok(chatDetail()))
        await store.send({ chatId: CHAT_ID, text: 'Hello' })
        await store.stop(CHAT_ID)
        expect(agentApi.cancelRun).not.toHaveBeenCalled()
        resolvePost(accepted())
        await flush()
        expect(agentApi.cancelRun).toHaveBeenCalledWith(RUN_ID)
    })

    it('a transport that dies with an error settles the run as failed', async () => {
        await initProject()
        await openRunningChat()
        rm.hooks.onClose(RUN_ID, { terminal: false, error: { isTransportError: true, status: 404, code: 'not_found', retryable: false } })
        expect(store.runs[RUN_ID].phase).toBe('failed')
        expect(store.messages[ASSISTANT_ID].status).toBe('interrupted')
        expect(store.isChatBusy(CHAT_ID)).toBe(false)
    })
})

describe('agent store: branches, reports and artifacts', () => {
    async function openAnswered() {
        agentApi.getChat.mockResolvedValueOnce(
            ok(chatDetail({ current_leaf_id: ASSISTANT_ID, messages: [userMessage(), emptyAssistant({ status: 'complete' })] }))
        )
        await store.openChat(CHAT_ID)
    }

    it('regenerate adds a sibling, and switchBranch moves between them', async () => {
        await initProject()
        await openAnswered()
        agentApi.regenerate.mockResolvedValueOnce(
            ok({
                assistant_message: emptyAssistant({ id: 'a2', sibling_ids: [ASSISTANT_ID, 'a2'] }),
                run: { id: 'run-2', chat_id: CHAT_ID, message_id: 'a2', status: 'queued', last_seq: 0 },
            })
        )
        await store.regenerate(ASSISTANT_ID)
        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_MESSAGE_ID, 'a2'])
        expect(store.siblingInfo('a2')).toMatchObject({ position: 2, count: 2, prevId: ASSISTANT_ID })
        expect(rm.attached.at(-1)).toEqual({ id: 'run-2', lastSeq: 0 })

        rm.hooks.applyEvents('run-2', [eventFactory({ runId: 'run-2', messageId: 'a2' })('run.completed', { status: 'complete' })])
        agentApi.updateChat.mockResolvedValueOnce(
            ok(chatDetail({ current_leaf_id: ASSISTANT_ID, messages: [userMessage(), emptyAssistant({ status: 'complete', sibling_ids: [ASSISTANT_ID, 'a2'] })] }))
        )
        const pending = store.switchBranch('a2', -1)
        // The known sibling shows before the server answers.
        expect(store.chatState[CHAT_ID].leafId).toBe(ASSISTANT_ID)
        await pending
        expect(agentApi.updateChat).toHaveBeenCalledWith('5', CHAT_ID, { current_leaf_id: ASSISTANT_ID }, { _silentError: true })
        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_MESSAGE_ID, ASSISTANT_ID])
        expect(store.siblingInfo(ASSISTANT_ID)).toMatchObject({ position: 1, count: 2, nextId: 'a2' })
    })

    it('switchBranch restores the leaf when the server refuses', async () => {
        await initProject()
        await openAnswered()
        store.childrenOf[USER_MESSAGE_ID] = [ASSISTANT_ID, 'a2']
        agentApi.updateChat.mockRejectedValueOnce(axiosError(500, { code: 'server_error' }))
        await expect(store.switchBranch(ASSISTANT_ID, 1)).rejects.toMatchObject({ status: 500 })
        expect(store.chatState[CHAT_ID].leafId).toBe(ASSISTANT_ID)
    })

    it('saveReport returns the existing report on 409 already_saved', async () => {
        await initProject()
        await openAnswered()
        agentApi.saveReport.mockRejectedValueOnce(
            axiosError(409, { code: 'already_saved', message: 'Already saved.', details: { artifact_id: 'art-9' } })
        )
        await expect(store.saveReport(ASSISTANT_ID)).resolves.toEqual({ id: 'art-9', already_saved: true })
        expect(store.messages[ASSISTANT_ID].saved_report_id).toBe('art-9')
    })

    it('feedback is optimistic and reverts on failure', async () => {
        await initProject()
        await openAnswered()
        agentApi.feedback.mockRejectedValueOnce(axiosError(500, {}))
        const pending = store.sendFeedback(ASSISTANT_ID, -1, { reason: 'inaccurate' })
        expect(store.messages[ASSISTANT_ID].feedback).toBe(-1)
        await expect(pending).rejects.toBeTruthy()
        expect(store.messages[ASSISTANT_ID].feedback).toBeNull()
    })

    it('a chat opened mid-draft knows what the draft is, and that it only has its tail', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(
            ok(
                chatDetail({
                    current_leaf_id: ASSISTANT_ID,
                    messages: [
                        userMessage(),
                        emptyAssistant({
                            parts: [
                                {
                                    id: 'call',
                                    type: 'agent_call',
                                    request: 2,
                                    agent: 'landing_page',
                                    status: 'drafting',
                                    artifact_id: 'art-5',
                                    title: 'Battery page',
                                    kind: 'page',
                                },
                            ],
                            parts_seq: 40,
                        }),
                    ],
                    active_run: { id: RUN_ID, status: 'running', message_id: ASSISTANT_ID, last_seq: 44 },
                })
            )
        )
        await store.openChat(CHAT_ID)
        const e = eventFactory({ start: 40 })
        rm.hooks.applyEvents(RUN_ID, [e('artifact.delta', { artifact_id: 'art-5', append: '<section>tail</section>' })])
        expect(store.artifact('art-5')).toMatchObject({ kind: 'page', title: 'Battery page', agent_key: 'landing_page' })
        expect(store.artifact('art-5').draft).toMatchObject({ status: 'drafting', partial: true })
    })

    it('a drafted artifact is replaced by its saved version once it completes', async () => {
        await initProject()
        await openRunningChat()
        agentApi.getArtifact.mockResolvedValueOnce(
            ok({
                id: 'art-1',
                kind: 'page',
                title: 'Battery landing page',
                agent_key: 'landing_page',
                latest_version: 1,
                version: 1,
                content: '<!DOCTYPE html><html></html>',
                content_type: 'text/html',
                warnings: [],
                summary: '5 sections',
            })
        )
        const e = eventFactory({ start: 10 })
        rm.hooks.applyEvents(RUN_ID, [
            e('part.added', { part: { id: 'call', type: 'agent_call', request: 2, agent: 'landing_page', status: 'drafting', artifact_id: 'art-1' } }),
            e('artifact.started', { artifact_id: 'art-1', kind: 'page', title: 'Battery page', agent_key: 'landing_page', base_version: null }),
            e('artifact.delta', { artifact_id: 'art-1', append: '<!DOCTYPE html>' }),
        ])
        expect(store.artifact('art-1').draft).toMatchObject({ status: 'drafting', content: '<!DOCTYPE html>', runId: RUN_ID })

        rm.hooks.applyEvents(RUN_ID, [
            e('artifact.completed', { artifact_id: 'art-1', version: 1, title: 'Battery landing page', summary: '5 sections', warnings: [] }),
        ])
        expect(store.artifact('art-1').draft.status).toBe('done')
        await flush()
        expect(agentApi.getArtifact).toHaveBeenCalledWith('5', 'art-1', { _silentError: true })
        expect(store.artifact('art-1')).toMatchObject({ content: '<!DOCTYPE html><html></html>', version: 1, draft: null })
    })
})

describe('agent store: what a run leaves when it ends', () => {
    function startDraft(start = 10) {
        const e = eventFactory({ start })
        rm.hooks.applyEvents(RUN_ID, [
            e('part.added', { part: { id: 'call', type: 'agent_call', request: 2, agent: 'landing_page', status: 'drafting', artifact_id: 'art-1' } }),
            e('artifact.started', { artifact_id: 'art-1', kind: 'page', title: 'Battery page', agent_key: 'landing_page', base_version: 0 }),
            e('artifact.delta', { artifact_id: 'art-1', append: '<h1>Half a page' }),
        ])
        expect(store.artifact('art-1').draft).toMatchObject({ status: 'drafting', runId: RUN_ID })
        return e
    }

    it('fails a draft the run was still writing when it was stopped', async () => {
        await initProject()
        await openRunningChat()
        const e = startDraft()
        rm.hooks.applyEvents(RUN_ID, [e('run.cancelled')])
        expect(store.artifact('art-1').draft).toMatchObject({
            status: 'failed',
            error: { code: 'stopped', message: 'Stopped' },
            content: '<h1>Half a page',
        })
    })

    it('fails a draft as not finished when the run ended any other way', async () => {
        await initProject()
        await openRunningChat()
        startDraft()
        rm.hooks.onClose(RUN_ID, { terminal: false, error: { isTransportError: true, status: 404, code: 'not_found', retryable: false } })
        expect(store.runs[RUN_ID].phase).toBe('failed')
        expect(store.artifact('art-1').draft).toMatchObject({ status: 'failed', error: { code: 'not_finished', message: 'Not finished' } })
    })

    it('loads the saved copy of a draft whose end event never arrived but whose call saved it', async () => {
        await initProject()
        await openRunningChat()
        startDraft()
        agentApi.getChat.mockResolvedValueOnce(
            ok(
                chatDetail({
                    current_leaf_id: ASSISTANT_ID,
                    messages: [
                        userMessage(),
                        emptyAssistant({
                            status: 'complete',
                            parts_seq: 30,
                            parts: [{ id: 'call', type: 'agent_call', request: 2, agent: 'landing_page', status: 'done', artifact_id: 'art-1', version: 1 }],
                        }),
                    ],
                })
            )
        )
        agentApi.getArtifact.mockResolvedValueOnce(
            ok({ id: 'art-1', kind: 'page', title: 'Battery page', latest_version: 1, version: 1, content: '<h1>Saved</h1>' })
        )
        const result = await rm.hooks.onResync(RUN_ID, 'buffer_expired')
        await flush()
        expect(result.active).toBe(false)
        expect(agentApi.getArtifact).toHaveBeenCalledWith('5', 'art-1', { _silentError: true })
        expect(store.artifact('art-1')).toMatchObject({ content: '<h1>Saved</h1>', version: 1, draft: null })
    })

    it('marks a generated title as generated and keeps a name the user gave the chat', async () => {
        await initProject()
        await openRunningChat()
        const e = eventFactory({ start: 10 })
        rm.hooks.applyEvents(RUN_ID, [e('chat.updated', { chat_id: CHAT_ID, title: 'Battery research' })])
        expect(store.chats.byId[CHAT_ID]).toMatchObject({ title: 'Battery research', title_source: 'model' })

        agentApi.updateChat.mockResolvedValueOnce(ok(chatDetail({ title: 'My name', title_source: 'user' })))
        await store.renameChat(CHAT_ID, 'My name')
        rm.hooks.applyEvents(RUN_ID, [e('chat.updated', { chat_id: CHAT_ID, title: 'Another title' })])
        expect(store.chats.byId[CHAT_ID]).toMatchObject({ title: 'My name', title_source: 'user' })
    })

    it("asks for a new chat's generated title when it was saved after the first reply ended", async () => {
        vi.useFakeTimers()
        await initProject()
        agentApi.createChat.mockResolvedValueOnce(ok(chatDetail()))
        agentApi.sendMessage.mockResolvedValueOnce(accepted())
        await store.send({ chatId: null, text: 'Research Turonote' })
        await vi.advanceTimersByTimeAsync(0)
        const e = eventFactory()
        rm.hooks.applyEvents(RUN_ID, [e('run.started'), e('run.completed', { status: 'complete' })])
        expect(agentApi.getChat).not.toHaveBeenCalled()

        // Not there at the first check: the first-message title shows meanwhile.
        agentApi.getChat.mockResolvedValueOnce(ok(chatDetail({ title: 'Research Turonote', title_source: 'auto' })))
        await vi.advanceTimersByTimeAsync(2000)
        expect(agentApi.getChat).toHaveBeenCalledTimes(1)
        expect(store.chats.byId[CHAT_ID]).toMatchObject({ title: 'Research Turonote', title_source: 'auto' })

        agentApi.getChat.mockResolvedValueOnce(ok(chatDetail({ title: 'Turonote visibility', title_source: 'model' })))
        await vi.advanceTimersByTimeAsync(6000)
        expect(agentApi.getChat).toHaveBeenCalledTimes(2)
        expect(store.chats.byId[CHAT_ID]).toMatchObject({ title: 'Turonote visibility', title_source: 'model' })

        // Nothing more to ask once it is there.
        await vi.advanceTimersByTimeAsync(60000)
        expect(agentApi.getChat).toHaveBeenCalledTimes(2)
    })

    it('does not ask for a title that arrived with the reply, nor for chats it did not start', async () => {
        vi.useFakeTimers()
        await initProject()
        await openRunningChat()
        rm.hooks.applyEvents(RUN_ID, [eventFactory({ start: 10 })('run.completed', { status: 'complete' })])
        await vi.advanceTimersByTimeAsync(60000)
        // The one call is openRunningChat's own load.
        expect(agentApi.getChat).toHaveBeenCalledTimes(1)
    })
})

describe('agent store: research agents', () => {
    const RERUN_TEXT = 'Re-run the Google (SEO) agents'

    // The finished research of version 1: the swarm part and its table.
    function finishedSwarmParts() {
        return [
            expectedSwarmPart(),
            {
                id: 'p5',
                type: 'swarm_table',
                request: 1,
                swarm_id: SWARM_ID,
                version: 1,
                title: 'Research Notion',
                status: 'partial',
                generated_at: '2026-11-04T10:17:18.880Z',
                table: swarmTable(1),
            },
        ]
    }

    function swarmChatDetail() {
        return ok(
            chatDetail({
                title: 'Research Notion',
                current_leaf_id: ASSISTANT_ID,
                messages: [
                    userMessage(),
                    emptyAssistant({
                        status: 'complete',
                        parts: finishedSwarmParts(),
                        parts_seq: 145,
                        research: { serp: { [CAPTURE_ID]: SWARM_SERP_CAPTURE }, pages: {} },
                    }),
                ],
            })
        )
    }

    async function openSwarmChat() {
        agentApi.getChat.mockResolvedValueOnce(swarmChatDetail())
        await store.openChat(CHAT_ID)
    }

    function rerunAccepted(overrides = {}) {
        return ok({
            user_message: userMessage({
                id: 'u2',
                parent_id: ASSISTANT_ID,
                sibling_ids: ['u2'],
                parts: [{ id: 'u2-text', type: 'text', text: RERUN_TEXT }],
            }),
            assistant_message: emptyAssistant({ id: 'a2', parent_id: 'u2', sibling_ids: ['a2'], run_id: 'run-2' }),
            run: { id: 'run-2', chat_id: CHAT_ID, message_id: 'a2', status: 'queued', last_seq: 0 },
            swarm_version: { swarm_id: SWARM_ID, version: 2, scope: 'category', scope_key: 'google', task_ids: ['google.p1.page1'] },
            ...overrides,
        })
    }

    // The re-run turn streams version 2: its swarm part, then its table.
    function streamVersion2() {
        const e = eventFactory({ runId: 'run-2', messageId: 'a2' })
        const [google] = expectedSwarmPart().tasks
        rm.hooks.applyEvents('run-2', [
            e('run.started'),
            e('part.added', {
                part: {
                    ...expectedSwarmPart(),
                    id: 'p1',
                    version: 2,
                    scope: 'category',
                    scope_label: 'Google (SEO)',
                    status: 'running',
                    ended_at: null,
                    duration_ms: null,
                    table_version: null,
                    categories: [expectedSwarmPart().categories[0]],
                    tasks: [{ ...google, status: 'queued', result: '', tone: null, pane: null, detail: null, rev: 1 }],
                },
            }),
            e('task.finished', { part_id: 'p1', task_id: 'google.p1.page1', rev: 2, patch: { status: 'done', result: "You're #3" } }),
            e('part.updated', { part_id: 'p1', patch: { status: 'done', ended_at: '2026-11-04T11:02:10Z', duration_ms: 9000 } }),
            e('part.added', {
                part: {
                    id: 'p2',
                    type: 'swarm_table',
                    request: 1,
                    swarm_id: SWARM_ID,
                    version: 2,
                    title: 'Research Notion',
                    status: 'done',
                    generated_at: '2026-11-04T11:02:10Z',
                    table: swarmTable(2),
                },
            }),
        ])
    }

    it('rerunSwarm posts the scope with a fresh Idempotency-Key and appends the turn', async () => {
        await initProject()
        await openSwarmChat()
        agentApi.rerunSwarm.mockResolvedValueOnce(rerunAccepted())
        const run = await store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'category', category: 'google' })

        const [wid, sid, body, options] = agentApi.rerunSwarm.mock.calls[0]
        expect([wid, sid]).toEqual(['5', SWARM_ID])
        expect(body).toEqual({ scope: 'category', category: 'google' })
        expect(options.idempotencyKey).toEqual(expect.any(String))

        expect(run).toMatchObject({ id: 'run-2', chatId: CHAT_ID, messageId: 'a2' })
        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_MESSAGE_ID, ASSISTANT_ID, 'u2', 'a2'])
        expect(store.childrenOf[ASSISTANT_ID]).toEqual(['u2'])
        expect(store.childrenOf.u2).toEqual(['a2'])
        expect(rm.attached).toEqual([{ id: 'run-2', lastSeq: 0 }])
        expect(store.activeRun(CHAT_ID).id).toBe('run-2')
        expect(store.isChatBusy(CHAT_ID)).toBe(true)
        expect(store.recents[0]).toMatchObject({ id: CHAT_ID, preview: RERUN_TEXT, running: true })
    })

    it('rerunSwarm refuses while the chat is busy, and each re-run takes its own key', async () => {
        await initProject()
        await openSwarmChat()
        agentApi.rerunSwarm.mockResolvedValueOnce(rerunAccepted())
        await store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'all' })
        await expect(store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'all' })).rejects.toMatchObject({
            code: 'run_in_progress',
        })
        expect(agentApi.rerunSwarm).toHaveBeenCalledTimes(1)

        rm.hooks.applyEvents('run-2', [eventFactory({ runId: 'run-2', messageId: 'a2' })('run.completed', { status: 'complete' })])
        agentApi.rerunSwarm.mockResolvedValueOnce(
            rerunAccepted({
                user_message: userMessage({ id: 'u3', parent_id: 'a2', sibling_ids: ['u3'] }),
                assistant_message: emptyAssistant({ id: 'a3', parent_id: 'u3', sibling_ids: ['a3'] }),
                run: { id: 'run-3', chat_id: CHAT_ID, message_id: 'a3', status: 'queued', last_seq: 0 },
            })
        )
        await store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'task', taskId: 'engines.p1.claude' })
        const [first, second] = agentApi.rerunSwarm.mock.calls
        expect(first[2]).toEqual({ scope: 'all' })
        expect(second[2]).toEqual({ scope: 'task', task_id: 'engines.p1.claude' })
        expect(second[3].idempotencyKey).not.toBe(first[3].idempotencyKey)
    })

    it('rerunSwarm loads a chat it has not opened, so the turn goes under its leaf', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(swarmChatDetail())
        agentApi.rerunSwarm.mockResolvedValueOnce(rerunAccepted())
        await store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'all' })
        expect(agentApi.getChat).toHaveBeenCalledTimes(1)
        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_MESSAGE_ID, ASSISTANT_ID, 'u2', 'a2'])
    })

    it('rerunSwarm checks its arguments before calling the API', async () => {
        await initProject()
        await openSwarmChat()
        for (const args of [
            { chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'everything' },
            { chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'category' },
            { chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'task' },
            { chatId: null, swarmId: SWARM_ID, scope: 'all' },
            { chatId: CHAT_ID, swarmId: '', scope: 'all' },
        ]) {
            await expect(store.rerunSwarm(args)).rejects.toMatchObject({ code: 'invalid' })
        }
        expect(agentApi.rerunSwarm).not.toHaveBeenCalled()
    })

    it('rerunSwarm throws the server refusal, frees the chat and refreshes the status when the agents are off', async () => {
        await initProject()
        await openSwarmChat()
        agentApi.rerunSwarm.mockRejectedValueOnce(
            axiosError(400, { code: 'version_limit', message: 'This research already has 50 versions; start a new research.' })
        )
        await expect(store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'all' })).rejects.toMatchObject({
            status: 400,
            code: 'version_limit',
            message: 'This research already has 50 versions; start a new research.',
        })
        expect(store.isChatBusy(CHAT_ID)).toBe(false)
        expect(agentApi.status).toHaveBeenCalledTimes(1)

        agentApi.rerunSwarm.mockRejectedValueOnce(axiosError(503, { code: 'swarm_disabled' }))
        await expect(store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'all' })).rejects.toMatchObject({
            code: 'swarm_disabled',
            message: 'The research agents are turned off on this server.',
        })
        expect(agentApi.status).toHaveBeenCalledTimes(2)
        expect(store.visiblePath(CHAT_ID).map((m) => m.id)).toEqual([USER_MESSAGE_ID, ASSISTANT_ID])
    })

    it('opens an agent\'s Google page in the background, placed by its task, with the run as the reveal key', async () => {
        await initProject()
        const live = { status: 'running', result: '', tone: null, ended_at: null, duration_ms: null, pane: null, error: null, detail: null }
        const running = {
            ...expectedSwarmPart(),
            status: 'running',
            ended_at: null,
            duration_ms: null,
            table_version: null,
            tasks: expectedSwarmPart().tasks.map((t) => ({ ...t, ...live })),
        }
        agentApi.getChat.mockResolvedValueOnce(
            ok(
                chatDetail({
                    current_leaf_id: ASSISTANT_ID,
                    messages: [userMessage(), emptyAssistant({ parts: [running], parts_seq: 10 })],
                    active_run: { id: RUN_ID, status: 'running', message_id: ASSISTANT_ID, last_seq: 10 },
                })
            )
        )
        const pane = useAgentPaneStore()
        pane.bindChat(CHAT_ID)
        await store.openChat(CHAT_ID)
        expect(pane.tabs).toHaveLength(0)
        const openSerp = vi.spyOn(pane, 'openSerp')

        const e = eventFactory({ start: 10 })
        rm.hooks.applyEvents(RUN_ID, [
            e('research.recorded', { kind: 'serp', capture_id: CAPTURE_ID, capture: SWARM_SERP_CAPTURE, task_id: 'google.p1.page1' }),
            e('research.recorded', { kind: 'page', capture_id: 'pg-1', capture: { url: 'https://evernote.com/' }, task_id: 'engines.p1.claude' }),
        ])
        expect(openSerp).toHaveBeenCalledTimes(1)
        const [tab, options] = openSerp.mock.calls[0]
        expect(tab).toMatchObject({ id: `serp:${CAPTURE_ID}`, kind: 'serp', status: 'ready' })
        expect(options).toEqual({ activate: false, background: true, order: { group: `${SWARM_ID}:1`, index: 0 }, revealKey: RUN_ID })
        // The page capture waits for its row; the Google page is the pane's tab.
        expect(pane.tabs.map((t) => t.id)).toEqual([`serp:${CAPTURE_ID}`])
        expect(pane.activeId).toBe(`serp:${CAPTURE_ID}`)
        expect(store.messages[ASSISTANT_ID].research.pages['pg-1'].url).toBe('https://evernote.com/')
    })

    it('swarmTable reads the tables in loaded messages before API data', async () => {
        await initProject()
        await openSwarmChat()
        expect(store.swarmTable(SWARM_ID, 1)).toEqual(swarmTable(1))

        // A version the chat's messages do not hold comes from the API.
        expect(store.swarmTable(SWARM_ID, 2)).toBeNull()
        agentApi.getSwarmVersion.mockResolvedValueOnce(
            ok({ swarm_id: SWARM_ID, version: 2, scope: 'all', status: 'done', message_id: 'elsewhere', table: swarmTable(2, { title: 'From the API' }) })
        )
        await store.loadSwarmVersion(SWARM_ID, 2)
        expect(agentApi.getSwarmVersion).toHaveBeenCalledWith('5', SWARM_ID, 2, { _silentError: true })
        expect(store.swarmTable(SWARM_ID, 2).title).toBe('From the API')
        expect(store.swarmTable(SWARM_ID).version).toBe(2)
        expect(store.swarmTableMessage(SWARM_ID, 2)).toBeNull()
        expect(store.swarmTableMessage(SWARM_ID, 1).id).toBe(ASSISTANT_ID)

        // The message's own table wins over an API copy of the same version.
        agentApi.getSwarmVersion.mockResolvedValueOnce(
            ok({ swarm_id: SWARM_ID, version: 1, status: 'partial', table: swarmTable(1, { title: 'Stale copy' }) })
        )
        await store.loadSwarmVersion(SWARM_ID, 1)
        expect(store.swarmTable(SWARM_ID, 1).title).toBe('Research Notion')
        expect(store.swarmTable('unknown', 1)).toBeNull()
    })

    it('latestSwarmVersion follows the detail and every table that arrives', async () => {
        await initProject()
        await openSwarmChat()
        expect(store.latestSwarmVersion(SWARM_ID)).toBe(1)
        expect(store.latestSwarmVersion('unknown')).toBeNull()

        agentApi.rerunSwarm.mockResolvedValueOnce(rerunAccepted())
        await store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'category', category: 'google' })
        streamVersion2()
        expect(store.latestSwarmVersion(SWARM_ID)).toBe(2)
        expect(store.swarmTable(SWARM_ID, 2)).toEqual(swarmTable(2))
        expect(store.swarmTableMessage(SWARM_ID).id).toBe('a2')

        agentApi.getSwarm.mockResolvedValueOnce(ok({ id: SWARM_ID, chat_id: CHAT_ID, latest_version: 3, versions: [] }))
        await store.loadSwarm(SWARM_ID)
        expect(store.latestSwarmVersion(SWARM_ID)).toBe(3)
    })

    it('swarmCategories come from the newest run of every agent until the detail is loaded', async () => {
        await initProject()
        await openSwarmChat()
        expect(store.swarmCategories(SWARM_ID)).toEqual([
            { key: 'google', label: 'Google (SEO)', task_ids: ['google.p1.page1'], count: 1 },
            { key: 'engines', label: 'AI engines (GEO)', task_ids: ['engines.p1.chatgpt', 'engines.p1.claude'], count: 2 },
        ])
        // A re-run of one category does not narrow the menu.
        agentApi.rerunSwarm.mockResolvedValueOnce(rerunAccepted())
        await store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'category', category: 'google' })
        streamVersion2()
        expect(store.swarmCategories(SWARM_ID).map((c) => c.key)).toEqual(['google', 'engines'])

        agentApi.getSwarm.mockResolvedValueOnce(
            ok({
                id: SWARM_ID,
                chat_id: CHAT_ID,
                latest_version: 2,
                categories: [
                    { key: 'google', label: 'Google (SEO)', task_ids: ['google.p1.page1'] },
                    { key: 'sources', label: 'Sources and citations', task_ids: [] },
                ],
                versions: [],
            })
        )
        await store.loadSwarm(SWARM_ID)
        expect(store.swarmCategories(SWARM_ID)).toEqual([
            { key: 'google', label: 'Google (SEO)', task_ids: ['google.p1.page1'], count: 1 },
        ])
        expect(store.swarmCategories('unknown')).toEqual([])
    })

    it('loadSwarm caches the detail and reloads it after a re-run or on force', async () => {
        await initProject()
        await openSwarmChat()
        const detail = {
            id: SWARM_ID,
            title: 'Research Notion',
            chat_id: CHAT_ID,
            latest_version: 1,
            versions: [{ version: 1, scope: 'all', status: 'partial', has_table: true }],
        }
        agentApi.getSwarm.mockResolvedValue(ok(detail))
        const [a, b] = await Promise.all([store.loadSwarm(SWARM_ID), store.loadSwarm(SWARM_ID)])
        expect(a).toBe(b)
        expect(a.versions.map((v) => v.version)).toEqual([1])
        expect(agentApi.getSwarm).toHaveBeenCalledTimes(1)
        expect(agentApi.getSwarm).toHaveBeenCalledWith('5', SWARM_ID, { _silentError: true })
        expect(store.swarms[SWARM_ID]).toMatchObject({ loading: false, error: null })

        await store.loadSwarm(SWARM_ID)
        expect(agentApi.getSwarm).toHaveBeenCalledTimes(1)
        await store.loadSwarm(SWARM_ID, { force: true })
        expect(agentApi.getSwarm).toHaveBeenCalledTimes(2)

        agentApi.rerunSwarm.mockResolvedValueOnce(rerunAccepted())
        await store.rerunSwarm({ chatId: CHAT_ID, swarmId: SWARM_ID, scope: 'all' })
        await store.loadSwarm(SWARM_ID)
        expect(agentApi.getSwarm).toHaveBeenCalledTimes(3)
    })

    it('loadSwarm resolves null for a 404 and records the error; other failures throw', async () => {
        await initProject()
        agentApi.getSwarm.mockRejectedValueOnce(axiosError(404, { code: 'not_found', message: 'Not found.' }))
        await expect(store.loadSwarm('gone')).resolves.toBeNull()
        expect(store.swarms.gone).toMatchObject({ detail: null, loading: false, error: { status: 404, code: 'not_found' } })

        agentApi.getSwarm.mockRejectedValueOnce(axiosError(500, { code: 'server_error' }))
        await expect(store.loadSwarm('broken')).rejects.toMatchObject({ status: 500 })
        expect(store.swarms.broken.error).toMatchObject({ status: 500 })

        agentApi.getSwarmVersion.mockRejectedValueOnce(axiosError(404, { code: 'not_found', message: 'Not found.' }))
        await expect(store.loadSwarmVersion('gone', 3)).resolves.toBeNull()
        await expect(store.loadSwarmVersion('gone', 0)).resolves.toBeNull()
        expect(agentApi.getSwarmVersion).toHaveBeenCalledTimes(1)
    })

    it('loadSwarmVersion caches a settled version and asks again for one still running', async () => {
        await initProject()
        agentApi.getSwarmVersion
            .mockResolvedValueOnce(ok({ swarm_id: SWARM_ID, version: 2, status: 'running', table: null }))
            .mockResolvedValueOnce(ok({ swarm_id: SWARM_ID, version: 2, status: 'done', table: swarmTable(2) }))
        expect(await store.loadSwarmVersion(SWARM_ID, 2)).toMatchObject({ status: 'running', table: null })
        expect(await store.loadSwarmVersion(SWARM_ID, 2)).toMatchObject({ status: 'done' })
        await store.loadSwarmVersion(SWARM_ID, 2)
        expect(agentApi.getSwarmVersion).toHaveBeenCalledTimes(2)
        expect(store.swarmTable(SWARM_ID, 2)).toEqual(swarmTable(2))
    })

    it('the swarm getters do not re-run while the report text streams, only when a swarm part changes', async () => {
        await initProject()
        agentApi.getChat.mockResolvedValueOnce(
            ok(
                chatDetail({
                    current_leaf_id: ASSISTANT_ID,
                    messages: [
                        userMessage(),
                        emptyAssistant({ parts: [...finishedSwarmParts(), { id: 'p6', type: 'text', request: 2, text: '' }], parts_seq: 143 }),
                    ],
                    active_run: { id: RUN_ID, status: 'running', message_id: ASSISTANT_ID, last_seq: 143 },
                })
            )
        )
        await store.openChat(CHAT_ID)
        let evaluations = 0
        const probe = computed(() => {
            evaluations += 1
            return [store.swarmTable(SWARM_ID, 1), store.latestSwarmVersion(SWARM_ID), store.swarmCategories(SWARM_ID).length]
        })
        expect(probe.value.slice(1)).toEqual([1, 2])

        const e = eventFactory({ start: 143 })
        rm.hooks.applyEvents(RUN_ID, [e('part.delta', { part_id: 'p6', field: 'text', append: '# Notion' })])
        rm.hooks.applyEvents(RUN_ID, [e('part.delta', { part_id: 'p6', field: 'text', append: ' on Google' })])
        expect(store.messages[ASSISTANT_ID].parts[2].text).toBe('# Notion on Google')
        expect(probe.value[1]).toBe(1)
        expect(evaluations).toBe(1)

        rm.hooks.applyEvents(RUN_ID, [e('part.updated', { part_id: 'p4', patch: { table_version: 1, title: 'Renamed' } })])
        expect(probe.value[1]).toBe(1)
        expect(evaluations).toBe(2)
    })

    it('a project switch drops the swarms and ignores late answers', async () => {
        await initProject()
        let resolveLate
        agentApi.getSwarm.mockImplementationOnce(() => new Promise((resolve) => (resolveLate = resolve)))
        const late = store.loadSwarm(SWARM_ID)
        expect(store.swarms[SWARM_ID].loading).toBe(true)
        await store.init(6)
        expect(store.swarms).toEqual({})
        resolveLate(ok({ id: SWARM_ID, latest_version: 1, versions: [] }))
        await expect(late).resolves.toBeNull()
        expect(store.swarms).toEqual({})
    })
})

describe('agent store: deletes and resets', () => {
    it('deleteChat drops the chat, its messages and its stored keys', async () => {
        await initProject()
        await openRunningChat()
        setLastChat('7', '5', CHAT_ID)
        saveDraft('7', '5', CHAT_ID, 'unsent')
        savePaneState('7', '5', CHAT_ID, { tabs: [] })
        agentApi.deleteChat.mockResolvedValueOnce({})
        await store.deleteChat(CHAT_ID)
        expect(store.chats.byId[CHAT_ID]).toBeUndefined()
        expect(store.messages[ASSISTANT_ID]).toBeUndefined()
        expect(store.chatState[CHAT_ID]).toBeUndefined()
        expect(rm.detached).toContain(RUN_ID)
        expect(getLastChat('7', '5')).toBeNull()
        expect(loadDraft('7', '5', CHAT_ID)).toBe('')
        expect(loadPaneState('7', '5', CHAT_ID)).toBeNull()
    })

    it('a project switch detaches transports and ignores late responses', async () => {
        await initProject()
        await openRunningChat()
        let resolveLate
        agentApi.getChat.mockImplementationOnce(() => new Promise((resolve) => (resolveLate = resolve)))
        const late = store.openChat('other-chat')
        await store.init(6)
        expect(rm.detached).toContain(RUN_ID)
        expect(store.websiteId).toBe('6')
        expect(store.messages).toEqual({})
        resolveLate(ok(chatDetail({ id: 'other-chat', current_leaf_id: 'x', messages: [userMessage({ id: 'x', chat_id: 'other-chat' })] })))
        await late
        expect(store.messages.x).toBeUndefined()
        expect(store.chatState['other-chat']).toBeUndefined()
    })

    it('a sign-out anywhere resets the store before clearAuth returns', async () => {
        await initProject()
        await openRunningChat()
        auth.clearAuth()
        expect(store.websiteId).toBeNull()
        expect(store.messages).toEqual({})
        expect(rm.detached).toContain(RUN_ID)
    })

    it('signing out resets everything and clears per-user keys', async () => {
        await initProject()
        await openRunningChat()
        expect(getLastChat('7', '5')).toBe(CHAT_ID)
        auth.clearAuth()
        await flush()
        expect(store.websiteId).toBeNull()
        expect(store.status).toBeNull()
        expect(store.catalog).toEqual([])
        expect(rm.detached).toContain(RUN_ID)
        expect(getLastChat('7', '5')).toBeNull()
        expect(getLastProject('7')).toBeNull()
    })
})
