import { describe, expect, it } from 'vitest'
import {
    AgentError,
    errorCopy,
    normalizeError,
    normalizeFinding,
    normalizeSwarmDetail,
    normalizeSwarmVersion,
    taskError,
} from '../normalize'
import { swarmTable } from './__fixtures__/swarmEvents'

function axiosError(status, error) {
    return Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        config: {},
        response: { status, data: { success: false, error } },
    })
}

// A Finding as the API returns it (swarm_contract.md 6d).
function rawFinding(overrides = {}) {
    return {
        id: 'f9e8',
        title: 'Not named by ChatGPT for “best note taking app for teams”',
        detail: 'Google ranks you #4.',
        category: 'engines',
        category_label: 'AI engines (GEO)',
        severity: 'high',
        status: 'open',
        prompt_text: 'best note taking app for teams',
        evidence: [{ kind: 'serp', label: "Google page 1 · you're #4", tab_id: 'serp:3f2a9c1d0e7b', url: null }],
        source: {
            swarm_id: '5d0c',
            swarm_title: 'Research Notion',
            version: 1,
            sheet: 'prompts',
            row_key: 'p1',
            task_ids: ['engines.p1.chatgpt'],
            chat_id: 'c1d2',
            message_id: 'b77a',
        },
        created_at: '2026-11-04T11:00:00Z',
        updated_at: '2026-11-04T11:00:00Z',
        created_by_name: 'Site Owner',
        status_changed_at: null,
        status_changed_by_name: null,
        ...overrides,
    }
}

describe('taskError', () => {
    it('reads the {code, message} the swarm code writes', () => {
        expect(taskError({ code: 'rate_limited', message: 'The engine was busy or rate limited.' })).toEqual({
            code: 'rate_limited',
            message: 'The engine was busy or rate limited.',
        })
        expect(taskError({ code: 'stopped' })).toEqual({ code: 'stopped', message: '' })
        expect(taskError({ message: 'Interrupted', extra: 1 })).toEqual({ code: '', message: 'Interrupted' })
    })

    it('reads the plain string a part closed by the runner carries', () => {
        expect(taskError('Not finished')).toEqual({ code: '', message: 'Not finished' })
    })

    it('is null when there is no error', () => {
        expect(taskError(null)).toBeNull()
        expect(taskError(undefined)).toBeNull()
        expect(taskError('')).toBeNull()
        expect(taskError({})).toBeNull()
        expect(taskError({ code: 7, message: null })).toBeNull()
        expect(taskError(['x'])).toBeNull()
    })
})

describe('normalizeFinding', () => {
    it('keeps a finding from a research table with string ids', () => {
        const finding = normalizeFinding(rawFinding({ id: 42, source: { ...rawFinding().source, swarm_id: 5, version: '2' } }))
        expect(finding).toMatchObject({
            id: '42',
            title: 'Not named by ChatGPT for “best note taking app for teams”',
            category: 'engines',
            category_label: 'AI engines (GEO)',
            severity: 'high',
            status: 'open',
            created_by_name: 'Site Owner',
            status_changed_by_name: '',
        })
        expect(finding.source).toEqual({
            swarm_id: '5',
            swarm_title: 'Research Notion',
            version: 2,
            sheet: 'prompts',
            row_key: 'p1',
            task_ids: ['engines.p1.chatgpt'],
            chat_id: 'c1d2',
            message_id: 'b77a',
        })
        expect(finding.evidence).toHaveLength(1)
    })

    it('keeps the chat ids null when the caller does not own the chat', () => {
        const finding = normalizeFinding(rawFinding({ source: { ...rawFinding().source, chat_id: null, message_id: undefined } }))
        expect(finding.source.chat_id).toBeNull()
        expect(finding.source.message_id).toBeNull()
        expect(finding.source.swarm_id).toBe('5d0c')
    })

    it('gives a manual finding a null source and fills the category label', () => {
        const finding = normalizeFinding(
            rawFinding({ source: null, category: 'other', category_label: undefined, evidence: undefined, prompt_text: null })
        )
        expect(finding.source).toBeNull()
        expect(finding.category_label).toBe('Other')
        expect(finding.evidence).toEqual([])
        expect(finding.prompt_text).toBe('')
    })

    it('drops malformed evidence and invents nothing', () => {
        const finding = normalizeFinding({ id: 'f1', evidence: [null, 'x', { kind: 'link', label: 'G2', tab_id: null, url: 'https://g2.com/' }] })
        expect(finding.evidence).toEqual([{ kind: 'link', label: 'G2', tab_id: null, url: 'https://g2.com/' }])
        expect(finding).toMatchObject({ title: '', detail: '', category: '', category_label: '', severity: '', status: 'open' })
    })

    it('rejects anything without an id', () => {
        expect(normalizeFinding(null)).toBeNull()
        expect(normalizeFinding({ title: 'x' })).toBeNull()
        expect(normalizeFinding({ id: '' })).toBeNull()
        expect(normalizeFinding([{ id: 'x' }])).toBeNull()
    })
})

describe('normalizeSwarmDetail', () => {
    it('orders versions newest first and stringifies ids', () => {
        const detail = normalizeSwarmDetail({
            id: 7,
            title: 'Research Notion',
            chat_id: 3,
            message_id: 'b77a',
            created_at: '2026-11-04T10:15:00Z',
            latest_version: 2,
            prompts: [{ key: 'p1', prompt_id: '6f1c', text: 'best note taking app for teams', location: 'us' }],
            categories: [{ key: 'google', label: 'Google (SEO)', task_ids: ['google.p1.page1'] }],
            tasks: [{ id: 'google.p1.page1', category: 'google', subcategory: 'p1', worker: 'serp_page', label: 'Google page 1' }],
            versions: [
                { version: 1, scope: 'all', status: 'partial', has_table: true, message_id: 'b77a', run_id: 9, duration_ms: 134201 },
                { version: 3, scope: 'task', status: 'running', has_table: false, message_id: 'm3', run_id: 'r3', duration_ms: null },
                { version: 2, scope: 'category', status: 'done', has_table: 1, message_id: 'm2', run_id: 'r2' },
                { version: 'x' },
            ],
        })
        expect(detail).toMatchObject({ id: '7', chat_id: '3', message_id: 'b77a', latest_version: 2 })
        expect(detail.versions.map((v) => v.version)).toEqual([3, 2, 1])
        expect(detail.versions[2]).toMatchObject({ run_id: '9', has_table: true, duration_ms: 134201 })
        expect(detail.versions[1]).toMatchObject({ has_table: true, duration_ms: null, counts: {} })
        expect(detail.categories[0].task_ids).toEqual(['google.p1.page1'])
    })

    it('defaults the lists and rejects a payload without an id', () => {
        expect(normalizeSwarmDetail({ id: 's1' })).toMatchObject({
            id: 's1',
            latest_version: 0,
            prompts: [],
            categories: [],
            tasks: [],
            versions: [],
        })
        expect(normalizeSwarmDetail(null)).toBeNull()
        expect(normalizeSwarmDetail({ title: 'x' })).toBeNull()
    })
})

describe('normalizeSwarmVersion', () => {
    it('keeps the table and the version number', () => {
        const table = swarmTable(2)
        const version = normalizeSwarmVersion({
            swarm_id: 5,
            version: '2',
            scope: 'category',
            scope_label: 'Google (SEO)',
            status: 'done',
            counts: { total: 1, done: 1, failed: 0, skipped: 0, stopped: 0 },
            started_at: '2026-11-04T11:00:00Z',
            finished_at: '2026-11-04T11:02:10Z',
            duration_ms: '130000',
            message_id: 81,
            table,
        })
        expect(version).toMatchObject({ swarm_id: '5', version: 2, message_id: '81', duration_ms: 130000, scope_label: 'Google (SEO)' })
        expect(version.table).toBe(table)
    })

    it('has a null table until the version has one, and rejects a bad number', () => {
        expect(normalizeSwarmVersion({ swarm_id: 's', version: 4, status: 'running', table: null })).toMatchObject({
            version: 4,
            table: null,
            counts: {},
            duration_ms: null,
            message_id: null,
        })
        expect(normalizeSwarmVersion({ swarm_id: 's', version: 0 })).toBeNull()
        expect(normalizeSwarmVersion({ swarm_id: 's' })).toBeNull()
        expect(normalizeSwarmVersion('x')).toBeNull()
    })
})

describe('research agent error copy', () => {
    it.each([
        ['swarm_disabled', 'The research agents are turned off on this server.'],
        ['insufficient_allowance', 'Not enough AI allowance is left for this re-run.'],
        ['version_limit', 'This research has reached its version limit. Start a new research.'],
        ['no_finding', 'Some of these rows have no finding to add.'],
    ])('%s has its own copy', (code, copy) => {
        expect(errorCopy(code)).toBe(copy)
        expect(new AgentError({ status: 400, code }).message).toBe(copy)
    })

    it("prefers the server's message and keeps its details", () => {
        const error = normalizeError(
            axiosError(400, { code: 'no_finding', message: 'Rows p2 have no finding.', details: { row_keys: ['p2'] } })
        )
        expect(error).toMatchObject({ status: 400, code: 'no_finding', message: 'Rows p2 have no finding.', details: { row_keys: ['p2'] } })
        const bare = normalizeError(axiosError(503, { code: 'swarm_disabled' }))
        expect(bare.message).toBe('The research agents are turned off on this server.')
        expect(bare.retryable).toBe(true)
    })
})
