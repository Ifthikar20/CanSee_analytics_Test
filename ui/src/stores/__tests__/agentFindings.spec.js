import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const agentStub = vi.hoisted(() => ({ websiteId: '5' }))

vi.mock('@/api/client', () => ({
    default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    authHeaders: () => ({}),
    refreshAccessToken: async () => '',
}))

vi.mock('@/api/agent', () => ({
    default: {
        listFindings: vi.fn(),
        createFindings: vi.fn(),
        updateFinding: vi.fn(),
        deleteFinding: vi.fn(),
    },
}))

// Only the project the agent workspace is on is read from the agent store.
vi.mock('@/stores/agent', () => ({ useAgentStore: () => agentStub }))

import agentApi from '@/api/agent'
import { useAgentFindingsStore } from '@/stores/agentFindings'
import { useAuthStore } from '@/stores/auth'
import { loadFindingsPrefs, saveFindingsPrefs } from '@/lib/agent/storage'

const ok = (data) => ({ success: true, data })
const SWARM_ID = '5d0c'

function axiosError(status, error) {
    return Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        config: {},
        response: { status, data: { success: false, error } },
    })
}

let seq = 0

// A Finding as the API returns it (swarm_contract.md 6d).
function finding(overrides = {}) {
    seq += 1
    return {
        id: `f${seq}`,
        title: `Finding ${seq}`,
        detail: '',
        category: 'engines',
        category_label: 'AI engines (GEO)',
        severity: 'high',
        status: 'open',
        prompt_text: 'best note taking app for teams',
        evidence: [],
        source: null,
        created_at: '2026-11-04T11:00:00Z',
        updated_at: '2026-11-04T11:00:00Z',
        created_by_name: 'Site Owner',
        status_changed_at: null,
        status_changed_by_name: null,
        ...overrides,
    }
}

function fromRow(rowKey, overrides = {}) {
    return finding({
        source: {
            swarm_id: SWARM_ID,
            swarm_title: 'Research Notion',
            version: 1,
            sheet: 'prompts',
            row_key: rowKey,
            task_ids: [],
            chat_id: 'c1',
            message_id: 'm1',
        },
        ...overrides,
    })
}

function page(results, { next = null, counts = { open: results.length, done: 0, dismissed: 0 }, canEdit = true } = {}) {
    return ok({ results, next_cursor: next, counts, can_edit: canEdit })
}

let store
let auth

beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    Object.values(agentApi).forEach((fn) => fn.mockReset())
    agentStub.websiteId = '5'
    seq = 0
    auth = useAuthStore()
    auth.accessToken = 'token'
    auth.user = { id: 7 }
    store = useAgentFindingsStore()
})

async function loaded(results, options) {
    store.init(5)
    agentApi.listFindings.mockResolvedValueOnce(page(results, options))
    await store.load()
}

describe('agentFindings: loading', () => {
    it('loads the open findings with the counts and the edit right', async () => {
        const rows = [finding(), finding({ id: 99, source: { swarm_id: 5, version: '1', sheet: 'gaps', row_key: 'p1.g1' } })]
        await loaded(rows, { next: 'cur-2', counts: { open: 12, done: 3, dismissed: 1 }, canEdit: false })

        expect(agentApi.listFindings).toHaveBeenCalledWith(
            '5',
            { status: 'open', category: '', severity: '', q: '', cursor: undefined },
            { _silentError: true }
        )
        expect(store.items.map((f) => f.id)).toEqual(['f1', '99'])
        expect(store.items[1].source).toMatchObject({ swarm_id: '5', version: 1, row_key: 'p1.g1' })
        expect(store.counts).toEqual({ open: 12, done: 3, dismissed: 1 })
        expect(store).toMatchObject({ canEdit: false, hasMore: true, cursor: 'cur-2', loaded: true, loading: false, error: null })
    })

    it('loads more with the cursor, without repeating a row', async () => {
        const first = [finding(), finding()]
        await loaded(first, { next: 'cur-2' })
        agentApi.listFindings.mockResolvedValueOnce(page([first[1], finding()], { next: null }))
        await store.load({ more: true })
        expect(agentApi.listFindings.mock.calls[1][1].cursor).toBe('cur-2')
        expect(store.items.map((f) => f.id)).toEqual(['f1', 'f2', 'f3'])
        expect(store.hasMore).toBe(false)

        await store.load({ more: true })
        expect(agentApi.listFindings).toHaveBeenCalledTimes(2)
    })

    it('records a failed load instead of throwing', async () => {
        store.init(5)
        agentApi.listFindings.mockRejectedValueOnce(axiosError(500, { code: 'server_error', message: 'Boom.' }))
        await expect(store.load()).resolves.toBeUndefined()
        expect(store.error).toMatchObject({ status: 500 })
        expect(store).toMatchObject({ loading: false, loaded: false })
    })

    it('sends the filters, trims the search and keeps the last answer', async () => {
        await loaded([finding()])
        let resolveSlow
        agentApi.listFindings.mockImplementationOnce(() => new Promise((resolve) => (resolveSlow = resolve)))
        const slow = store.setFilters({ category: 'google' })
        agentApi.listFindings.mockResolvedValueOnce(page([finding({ category: 'google', severity: 'low' })]))
        await store.setFilters({ severity: 'low', q: '  pricing ' })
        expect(agentApi.listFindings.mock.calls[2][1]).toEqual({
            status: 'open',
            category: 'google',
            severity: 'low',
            q: 'pricing',
            cursor: undefined,
        })
        resolveSlow(page([finding(), finding()]))
        await slow
        expect(store.items).toHaveLength(1)
        expect(store.filters).toEqual({ status: 'open', category: 'google', severity: 'low', q: '  pricing ' })
    })

    it('ignores filter values outside the vocabulary', async () => {
        await loaded([])
        agentApi.listFindings.mockResolvedValue(page([]))
        await store.setFilters({ status: 'archived', category: 'social', severity: 'urgent' })
        expect(store.filters).toEqual({ status: 'open', category: '', severity: '', q: '' })
        expect(agentApi.listFindings).toHaveBeenCalledTimes(1)
        await store.setFilters({ status: 'all', category: 'other' })
        expect(store.filters).toMatchObject({ status: 'all', category: 'other' })
        await store.setFilters({ category: null })
        expect(store.filters.category).toBe('')
    })
})

describe('agentFindings: filters per project', () => {
    it('saves the status, category and severity per user and project, not the search', async () => {
        await loaded([])
        agentApi.listFindings.mockResolvedValue(page([]))
        await store.setFilters({ status: 'done', severity: 'high', q: 'g2' })
        expect(loadFindingsPrefs('7', '5')).toEqual({ status: 'done', category: '', severity: 'high' })
        expect(loadFindingsPrefs('7', '6')).toEqual({})
    })

    it('restores them when the project changes, and starts the list over', async () => {
        saveFindingsPrefs('7', '6', { status: 'dismissed', category: 'sources', severity: 'bogus' })
        await loaded([finding()], { counts: { open: 4, done: 1, dismissed: 0 } })
        store.init(6)
        expect(store.filters).toEqual({ status: 'dismissed', category: 'sources', severity: '', q: '' })
        expect(store).toMatchObject({ websiteId: '6', items: [], loaded: false, hasMore: false, cursor: null })
        expect(store.counts).toEqual({ open: 0, done: 0, dismissed: 0 })

        // The same project again changes nothing.
        store.init('6')
        expect(store.filters.status).toBe('dismissed')
    })

    it('drops an answer for the project it left', async () => {
        store.init(5)
        let resolveOld
        agentApi.listFindings.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
        const old = store.load()
        store.init(6)
        resolveOld(page([finding()]))
        await old
        expect(store.items).toEqual([])
        expect(store.loaded).toBe(false)
    })
})

describe('agentFindings: adding table rows', () => {
    it('posts the rows of a sheet and marks created and duplicate rows as added', async () => {
        await loaded([finding()], { counts: { open: 1, done: 2, dismissed: 0 } })
        agentApi.createFindings.mockResolvedValueOnce(
            ok({ created: [fromRow('p1'), fromRow('p2')], duplicates: [fromRow('p3', { status: 'done' })] })
        )
        const result = await store.addFromTable({ swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: ['p1', 'p2', 'p3', 'p1'] })

        expect(agentApi.createFindings).toHaveBeenCalledWith(
            '5',
            { from_swarm: { swarm_id: SWARM_ID, version: 1, sheet: 'prompts', row_keys: ['p1', 'p2', 'p3'] } },
            { _silentError: true }
        )
        expect(result.created.map((f) => f.source.row_key)).toEqual(['p1', 'p2'])
        expect(result.duplicates.map((f) => f.source.row_key)).toEqual(['p3'])
        expect(store.isAdded(SWARM_ID, 'prompts', 'p1')).toBe(true)
        expect(store.isAdded(SWARM_ID, 'prompts', 'p3')).toBe(true)
        expect(store.isAdded(SWARM_ID, 'gaps', 'p1')).toBe(false)
        expect(store.isAdded('other', 'prompts', 'p1')).toBe(false)
        expect(store.added[`${SWARM_ID}:prompts:p2`]).toBe(result.created[1].id)
        // New open findings join the open list and its count.
        expect(store.counts).toEqual({ open: 3, done: 2, dismissed: 0 })
        expect(store.items.map((f) => f.source?.row_key ?? null)).toEqual(['p1', 'p2', null])
    })

    it('counts but does not show created findings that the list filters out', async () => {
        await loaded([], { counts: { open: 0, done: 5, dismissed: 0 } })
        agentApi.listFindings.mockResolvedValueOnce(page([], { counts: { open: 0, done: 5, dismissed: 0 } }))
        await store.setFilters({ status: 'done' })
        agentApi.createFindings.mockResolvedValueOnce(ok({ created: [fromRow('p1')], duplicates: [] }))
        await store.addFromTable({ swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: ['p1'] })
        expect(store.items).toEqual([])
        expect(store.counts.open).toBe(1)

        agentApi.listFindings.mockResolvedValueOnce(page([]))
        await store.setFilters({ status: 'all', category: 'google' })
        agentApi.createFindings.mockResolvedValueOnce(
            ok({ created: [fromRow('p2', { category: 'google' }), fromRow('p3', { category: 'engines' })], duplicates: [] })
        )
        await store.addFromTable({ swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: ['p2', 'p3'] })
        expect(store.items.map((f) => f.source.row_key)).toEqual(['p2'])
    })

    it('posts to the project the chat is in, even when Findings lists another', async () => {
        await loaded([], { counts: { open: 7, done: 0, dismissed: 0 } })
        agentStub.websiteId = '9'
        agentApi.createFindings.mockResolvedValueOnce(ok({ created: [fromRow('p1')], duplicates: [] }))
        await store.addFromTable({ swarmId: SWARM_ID, version: 2, sheet: 'prompts', rowKeys: ['p1'] })
        expect(agentApi.createFindings.mock.calls[0][0]).toBe('9')
        expect(store.isAdded(SWARM_ID, 'prompts', 'p1')).toBe(true)
        // The listed project's rows and counts are not another project's.
        expect(store.items).toEqual([])
        expect(store.counts.open).toBe(7)
    })

    it('checks its arguments and passes server refusals on', async () => {
        await loaded([])
        for (const args of [
            { swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: [] },
            { swarmId: SWARM_ID, version: 0, sheet: 'prompts', rowKeys: ['p1'] },
            { swarmId: SWARM_ID, version: 1, sheet: 'other', rowKeys: ['p1'] },
            { swarmId: '', version: 1, sheet: 'prompts', rowKeys: ['p1'] },
            { swarmId: SWARM_ID, version: 1, sheet: 'sources', rowKeys: Array.from({ length: 51 }, (_, i) => `d${i}.com`) },
        ]) {
            await expect(store.addFromTable(args)).rejects.toMatchObject({ code: 'invalid' })
        }
        expect(agentApi.createFindings).not.toHaveBeenCalled()

        agentApi.createFindings.mockRejectedValueOnce(
            axiosError(400, { code: 'no_finding', message: 'These rows have no finding: p2.', details: { row_keys: ['p2'] } })
        )
        await expect(
            store.addFromTable({ swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: ['p1', 'p2'] })
        ).rejects.toMatchObject({ code: 'no_finding', details: { row_keys: ['p2'] } })
        expect(store.isAdded(SWARM_ID, 'prompts', 'p1')).toBe(false)
        expect(store.canEdit).toBe(true)
    })

    it('turns read-only when a write is refused for a viewer', async () => {
        await loaded([])
        agentApi.createFindings.mockRejectedValueOnce(
            axiosError(403, { code: 'permission_denied', message: "Viewers can see this project's agent work but not change it." })
        )
        await expect(store.addFromTable({ swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: ['p1'] })).rejects.toMatchObject({
            status: 403,
        })
        expect(store.canEdit).toBe(false)

        // An allowance 403 is not about rights.
        store.canEdit = true
        agentApi.updateFinding.mockRejectedValueOnce(axiosError(403, { code: 'allowance_exceeded', message: 'Used up.' }))
        await expect(store.setStatus('f1', 'done')).rejects.toMatchObject({ code: 'allowance_exceeded' })
        expect(store.canEdit).toBe(true)
    })
})

describe('agentFindings: changing findings', () => {
    it('setStatus moves a row out of its tab and moves the count with it', async () => {
        const rows = [finding(), finding(), finding()]
        await loaded(rows, { counts: { open: 3, done: 4, dismissed: 0 } })
        agentApi.updateFinding.mockResolvedValueOnce(ok({ ...rows[1], status: 'done', status_changed_by_name: 'Site Owner' }))
        const updated = await store.setStatus('f2', 'done')

        expect(agentApi.updateFinding).toHaveBeenCalledWith('5', 'f2', { status: 'done' }, { _silentError: true })
        expect(updated).toMatchObject({ id: 'f2', status: 'done', status_changed_by_name: 'Site Owner' })
        expect(store.items.map((f) => f.id)).toEqual(['f1', 'f3'])
        expect(store.counts).toEqual({ open: 2, done: 5, dismissed: 0 })
        await expect(store.setStatus('f1', 'archived')).rejects.toMatchObject({ code: 'invalid' })
    })

    it('setStatus keeps the row in place under All', async () => {
        const rows = [finding(), finding({ status: 'done' })]
        await loaded(rows, { counts: { open: 1, done: 1, dismissed: 0 } })
        agentApi.listFindings.mockResolvedValueOnce(page(rows, { counts: { open: 1, done: 1, dismissed: 0 } }))
        await store.setFilters({ status: 'all' })
        agentApi.updateFinding.mockResolvedValueOnce(ok({ ...rows[0], status: 'dismissed' }))
        await store.setStatus('f1', 'dismissed')
        expect(store.items.map((f) => [f.id, f.status])).toEqual([
            ['f1', 'dismissed'],
            ['f2', 'done'],
        ])
        expect(store.counts).toEqual({ open: 0, done: 1, dismissed: 1 })
    })

    it('update sends only the fields a finding can change', async () => {
        const rows = [finding()]
        await loaded(rows)
        agentApi.updateFinding.mockResolvedValueOnce(ok({ ...rows[0], title: 'Renamed', severity: 'low' }))
        await store.update('f1', { title: '  Renamed ', severity: 'low', category: 'google', prompt_text: 'x' })
        expect(agentApi.updateFinding).toHaveBeenCalledWith('5', 'f1', { title: 'Renamed', severity: 'low' }, { _silentError: true })
        expect(store.items[0]).toMatchObject({ title: 'Renamed', severity: 'low' })

        await expect(store.update('f1', { title: '   ' })).rejects.toMatchObject({ code: 'invalid' })
        await expect(store.update('f1', { severity: 'urgent' })).rejects.toMatchObject({ code: 'invalid' })
        await expect(store.update('f1', {})).resolves.toMatchObject({ id: 'f1' })
        expect(agentApi.updateFinding).toHaveBeenCalledTimes(1)
    })

    it('update drops a row the severity filter no longer shows', async () => {
        const rows = [finding({ severity: 'high' })]
        await loaded(rows)
        agentApi.listFindings.mockResolvedValueOnce(page(rows))
        await store.setFilters({ severity: 'high' })
        agentApi.updateFinding.mockResolvedValueOnce(ok({ ...rows[0], severity: 'medium' }))
        await store.update('f1', { severity: 'medium' })
        expect(store.items).toEqual([])
    })

    it('create posts a manual finding and shows it at the top', async () => {
        await loaded([finding()], { counts: { open: 1, done: 0, dismissed: 0 } })
        const created = finding({ title: 'Claim the G2 listing', category: 'sources', severity: 'medium', source: null })
        agentApi.createFindings.mockResolvedValueOnce(ok({ created: [created], duplicates: [] }))
        const result = await store.create({
            title: ' Claim the G2 listing ',
            detail: 'Cited by two engines.',
            category: 'sources',
            severity: 'medium',
        })
        expect(agentApi.createFindings).toHaveBeenCalledWith(
            '5',
            { title: 'Claim the G2 listing', detail: 'Cited by two engines.', category: 'sources', severity: 'medium', prompt_text: '' },
            { _silentError: true }
        )
        expect(result).toMatchObject({ id: created.id, source: null })
        expect(store.items[0].id).toBe(created.id)
        expect(store.counts.open).toBe(2)
    })

    it('create checks the fields before posting', async () => {
        await loaded([])
        for (const fields of [
            { title: '', category: 'other', severity: 'low' },
            { title: 'x'.repeat(201), category: 'other', severity: 'low' },
            { title: 'Fine', detail: 'x'.repeat(2001), category: 'other', severity: 'low' },
            { title: 'Fine', category: 'social', severity: 'low' },
            { title: 'Fine', category: 'other', severity: 'urgent' },
            { title: 'Fine', category: 'other', severity: 'low', prompt_text: 'x'.repeat(301) },
        ]) {
            await expect(store.create(fields)).rejects.toMatchObject({ code: 'invalid' })
        }
        expect(agentApi.createFindings).not.toHaveBeenCalled()
    })

    it('remove deletes a finding, its count and its added mark', async () => {
        await loaded([fromRow('p1'), finding()], { counts: { open: 2, done: 0, dismissed: 0 } })
        agentApi.createFindings.mockResolvedValueOnce(ok({ created: [], duplicates: [store.items[0]] }))
        await store.addFromTable({ swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: ['p1'] })
        expect(store.isAdded(SWARM_ID, 'prompts', 'p1')).toBe(true)

        agentApi.deleteFinding.mockResolvedValueOnce({ status: 204 })
        await store.remove('f1')
        expect(agentApi.deleteFinding).toHaveBeenCalledWith('5', 'f1', { _silentError: true })
        expect(store.items.map((f) => f.id)).toEqual(['f2'])
        expect(store.counts.open).toBe(1)
        expect(store.isAdded(SWARM_ID, 'prompts', 'p1')).toBe(false)
    })

    it('remove treats a finding already deleted as removed, and throws other failures', async () => {
        await loaded([finding(), finding()], { counts: { open: 2, done: 0, dismissed: 0 } })
        agentApi.deleteFinding.mockRejectedValueOnce(axiosError(404, { code: 'not_found', message: 'Not found.' }))
        await store.remove('f1')
        expect(store.items.map((f) => f.id)).toEqual(['f2'])

        agentApi.deleteFinding.mockRejectedValueOnce(axiosError(500, { code: 'server_error' }))
        await expect(store.remove('f2')).rejects.toMatchObject({ status: 500 })
        expect(store.items.map((f) => f.id)).toEqual(['f2'])
        expect(store.counts.open).toBe(1)
    })
})

describe('agentFindings: sign-out', () => {
    it('resets everything, including the added rows, when auth is cleared', async () => {
        await loaded([finding()], { counts: { open: 1, done: 0, dismissed: 0 }, canEdit: false })
        agentApi.createFindings.mockResolvedValueOnce(ok({ created: [fromRow('p1')], duplicates: [] }))
        await store.addFromTable({ swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: ['p1'] })
        auth.clearAuth()
        expect(store).toMatchObject({
            websiteId: null,
            items: [],
            loaded: false,
            canEdit: true,
            added: {},
            filters: { status: 'open', category: '', severity: '', q: '' },
            counts: { open: 0, done: 0, dismissed: 0 },
        })
        expect(store.isAdded(SWARM_ID, 'prompts', 'p1')).toBe(false)
    })

    it('resets when another user signs in or the session ends without a sign-out', async () => {
        await loaded([finding()])
        auth.user = { id: 8 }
        await nextTick()
        expect(store).toMatchObject({ websiteId: null, items: [], loaded: false })

        await loaded([finding()])
        auth.accessToken = null
        await nextTick()
        expect(store.items).toEqual([])
    })

    it('keeps the added rows across a project change', async () => {
        await loaded([])
        agentApi.createFindings.mockResolvedValueOnce(ok({ created: [fromRow('p1')], duplicates: [] }))
        await store.addFromTable({ swarmId: SWARM_ID, version: 1, sheet: 'prompts', rowKeys: ['p1'] })
        store.init(6)
        expect(store.isAdded(SWARM_ID, 'prompts', 'p1')).toBe(true)
    })
})
