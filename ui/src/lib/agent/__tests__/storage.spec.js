import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    PANE_STATE_CHAT_LIMIT,
    UI_PREFS_KEY,
    clearDraft,
    clearLastChat,
    clearUserData,
    getLastChat,
    getLastProject,
    loadActivitySeen,
    loadDraft,
    loadFindingsPrefs,
    loadPaneState,
    loadUiPrefs,
    moveDraft,
    movePaneState,
    paneStateChatIds,
    readJSON,
    removePaneState,
    saveActivitySeen,
    saveDraft,
    saveFindingsPrefs,
    savePaneState,
    saveUiPrefs,
    setLastChat,
    setLastProject,
    storageKeys,
} from '../storage'

beforeEach(() => {
    localStorage.clear()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('keys', () => {
    it('are versioned and scoped by user, project and chat', () => {
        expect(storageKeys.uiPrefs()).toBe('cs-agent-ui-v1')
        expect(storageKeys.lastProject(7)).toBe('cs-agent-last-project:7')
        expect(storageKeys.lastChat(7, 3)).toBe('cs-agent-last-chat:7:3')
        expect(storageKeys.tabs(7, 3)).toBe('cs-agent-tabs-v1:7:3')
        expect(storageKeys.draft(7, 3, 'c1')).toBe('cs-agent-draft-v1:7:3:c1')
        expect(storageKeys.draft(7, 3, null)).toBe('cs-agent-draft-v1:7:3:new')
        expect(storageKeys.findings(7, 3)).toBe('cs-agent-findings-v1:7:3')
    })
})

describe('findings filters', () => {
    it('round-trip per user and project, keeping only the three filter strings', () => {
        expect(loadFindingsPrefs(7, 3)).toEqual({})
        expect(saveFindingsPrefs(7, 3, { status: 'done', category: 'engines', severity: '', q: 'not stored', extra: 1 })).toBe(true)
        expect(loadFindingsPrefs(7, 3)).toEqual({ status: 'done', category: 'engines', severity: '' })
        expect(loadFindingsPrefs(7, 4)).toEqual({})
        expect(loadFindingsPrefs(8, 3)).toEqual({})
        expect(JSON.parse(localStorage.getItem(storageKeys.findings(7, 3)))).not.toHaveProperty('q')
    })

    it('need a user and a project, and survive corrupt values', () => {
        expect(saveFindingsPrefs(null, 3, { status: 'done' })).toBe(false)
        expect(saveFindingsPrefs(7, '', { status: 'done' })).toBe(false)
        expect(saveFindingsPrefs(7, 3, 'done')).toBe(false)
        expect(loadFindingsPrefs(null, 3)).toEqual({})
        localStorage.setItem(storageKeys.findings(7, 3), '{oops')
        expect(loadFindingsPrefs(7, 3)).toEqual({})
        localStorage.setItem(storageKeys.findings(7, 3), JSON.stringify({ status: 3, category: ['x'], severity: 'high' }))
        expect(loadFindingsPrefs(7, 3)).toEqual({ severity: 'high' })
        localStorage.setItem(storageKeys.findings(7, 3), JSON.stringify(['done']))
        expect(loadFindingsPrefs(7, 3)).toEqual({})
    })
})

describe('device prefs', () => {
    it('merges patches and survives corrupt JSON', () => {
        expect(loadUiPrefs()).toEqual({})
        saveUiPrefs({ sidebarCollapsed: true })
        saveUiPrefs({ paneRatio: 0.4 })
        expect(loadUiPrefs()).toEqual({ sidebarCollapsed: true, paneRatio: 0.4 })
        localStorage.setItem(UI_PREFS_KEY, '{oops')
        expect(loadUiPrefs()).toEqual({})
        localStorage.setItem(UI_PREFS_KEY, '[1,2]')
        expect(loadUiPrefs()).toEqual({})
    })
})

describe('last project and chat', () => {
    it('round-trips and needs a user and project', () => {
        setLastProject(7, 3)
        expect(getLastProject(7)).toBe('3')
        expect(getLastProject(8)).toBeNull()
        setLastProject(null, 3)
        setLastProject(7, '')
        expect(getLastProject(null)).toBeNull()

        setLastChat(7, 3, 'c1')
        expect(getLastChat(7, 3)).toBe('c1')
        setLastChat(7, 3, 'new')
        expect(getLastChat(7, 3)).toBe('c1')
    })

    it('clears the last chat only when it matches', () => {
        setLastChat(7, 3, 'c1')
        clearLastChat(7, 3, 'c2')
        expect(getLastChat(7, 3)).toBe('c1')
        clearLastChat(7, 3, 'c1')
        expect(getLastChat(7, 3)).toBeNull()
        setLastChat(7, 3, 'c3')
        clearLastChat(7, 3)
        expect(getLastChat(7, 3)).toBeNull()
    })
})

describe('pane state', () => {
    it('stores ids and urls, never capture payloads', () => {
        savePaneState(7, 3, 'c1', {
            open: true,
            active: 'serp:a',
            tabs: [
                { id: 'serp:a', kind: 'serp', data: { results: new Array(50).fill({ title: 'x' }) } },
                { id: 'url:b', kind: 'url', url: 'https://example.com/' },
                { kind: 'url' },
            ],
            closed: ['page:z'],
        })
        expect(loadPaneState(7, 3, 'c1')).toEqual({
            open: true,
            active: 'serp:a',
            tabs: [
                { id: 'serp:a', kind: 'serp' },
                { id: 'url:b', kind: 'url', url: 'https://example.com/' },
            ],
            closed: ['page:z'],
        })
        expect(loadPaneState(7, 3, 'c2')).toBeNull()
        expect(loadPaneState(8, 3, 'c1')).toBeNull()
    })

    it(`keeps the ${PANE_STATE_CHAT_LIMIT} most recently saved chats`, () => {
        let now = 1000
        vi.spyOn(Date, 'now').mockImplementation(() => now)
        for (let i = 0; i < PANE_STATE_CHAT_LIMIT + 5; i += 1) {
            now += 1
            savePaneState(7, 3, `c${i}`, { tabs: [] })
        }
        const ids = paneStateChatIds(7, 3)
        expect(ids).toHaveLength(PANE_STATE_CHAT_LIMIT)
        expect(ids[0]).toBe(`c${PANE_STATE_CHAT_LIMIT + 4}`)
        expect(ids).not.toContain('c0')
        expect(ids).not.toContain('c4')
        expect(ids).toContain('c5')
    })

    it('stores research table tabs by swarm id and version', () => {
        savePaneState(7, 3, 'c1', {
            open: true,
            active: 'table:5d0c',
            tabs: [
                { id: 'table:5d0c', kind: 'table', swarm_id: '5d0c', version: 2 },
                { id: 'table:77aa', kind: 'table', swarm_id: '77aa', version: null },
            ],
        })
        expect(loadPaneState(7, 3, 'c1').tabs).toEqual([
            { id: 'table:5d0c', kind: 'table', swarm_id: '5d0c', version: 2 },
            { id: 'table:77aa', kind: 'table', swarm_id: '77aa', version: null },
        ])
    })

    it('moves and removes a chat entry', () => {
        savePaneState(7, 3, 'new', { tabs: [{ id: 'serp:a', kind: 'serp' }] })
        movePaneState(7, 3, 'new', 'c9')
        expect(loadPaneState(7, 3, 'new')).toBeNull()
        expect(loadPaneState(7, 3, 'c9').tabs).toEqual([{ id: 'serp:a', kind: 'serp' }])
        removePaneState(7, 3, 'c9')
        expect(loadPaneState(7, 3, 'c9')).toBeNull()
    })

    it('starts over when the stored book is from another version or corrupt', () => {
        localStorage.setItem(storageKeys.tabs(7, 3), JSON.stringify({ v: 0, chats: { c1: { state: { tabs: [] } } } }))
        expect(loadPaneState(7, 3, 'c1')).toBeNull()
        localStorage.setItem(storageKeys.tabs(7, 3), 'not json')
        expect(loadPaneState(7, 3, 'c1')).toBeNull()
        expect(savePaneState(7, 3, 'c1', { tabs: [] })).toBe(true)
        expect(loadPaneState(7, 3, 'c1')).toEqual({ tabs: [] })
    })
})

describe('drafts', () => {
    it('saves, trims empties and moves from the new chat to its id', () => {
        saveDraft(7, 3, null, 'Research Turonote')
        expect(loadDraft(7, 3, 'new')).toBe('Research Turonote')
        moveDraft(7, 3, 'new', 'c1')
        expect(loadDraft(7, 3, null)).toBe('')
        expect(loadDraft(7, 3, 'c1')).toBe('Research Turonote')
        saveDraft(7, 3, 'c1', '   ')
        expect(localStorage.getItem(storageKeys.draft(7, 3, 'c1'))).toBeNull()
        saveDraft(7, 3, 'c1', 'again')
        clearDraft(7, 3, 'c1')
        expect(loadDraft(7, 3, 'c1')).toBe('')
    })
})

describe('clearUserData', () => {
    function seed() {
        saveUiPrefs({ sidebarCollapsed: true })
        setLastProject(7, 3)
        setLastChat(7, 3, 'c1')
        savePaneState(7, 3, 'c1', { tabs: [] })
        saveDraft(7, 3, 'c1', 'hello')
        setLastProject(8, 4)
        saveDraft(8, 4, null, 'other user')
        localStorage.setItem('cs-theme', 'dark')
        localStorage.setItem('cs-access', 'token')
    }

    it('removes the keys of one user and leaves everything else', () => {
        seed()
        expect(clearUserData(7)).toBe(4)
        expect(getLastProject(7)).toBeNull()
        expect(getLastChat(7, 3)).toBeNull()
        expect(loadPaneState(7, 3, 'c1')).toBeNull()
        expect(loadDraft(7, 3, 'c1')).toBe('')
        expect(getLastProject(8)).toBe('4')
        expect(loadDraft(8, 4, null)).toBe('other user')
        expect(loadUiPrefs()).toEqual({ sidebarCollapsed: true })
        expect(localStorage.getItem('cs-theme')).toBe('dark')
    })

    it('removes the keys of every user when none is given, keeping device prefs', () => {
        seed()
        expect(clearUserData()).toBe(6)
        expect(getLastProject(8)).toBeNull()
        expect(loadUiPrefs()).toEqual({ sidebarCollapsed: true })
        expect(localStorage.getItem('cs-access')).toBe('token')
    })

    it('removes the findings filters with the rest of a user\'s keys', () => {
        saveFindingsPrefs(7, 3, { status: 'done', category: '', severity: 'high' })
        saveFindingsPrefs(8, 3, { status: 'all', category: '', severity: '' })
        expect(clearUserData(7)).toBe(1)
        expect(loadFindingsPrefs(7, 3)).toEqual({})
        expect(loadFindingsPrefs(8, 3)).toEqual({ status: 'all', category: '', severity: '' })
        expect(clearUserData()).toBe(1)
        expect(loadFindingsPrefs(8, 3)).toEqual({})
    })

    it('treats activity read state as per user', () => {
        saveActivitySeen(7, { 12: '2026-11-02T15:00:00Z' })
        saveActivitySeen(8, { 12: '2026-11-01T09:00:00Z' })
        expect(localStorage.getItem(storageKeys.activitySeen(7))).not.toBeNull()
        expect(loadActivitySeen(8)).toEqual({ 12: '2026-11-01T09:00:00Z' })
        expect(clearUserData(7)).toBe(1)
        expect(loadActivitySeen(7)).toEqual({})
        expect(loadActivitySeen(8)).toEqual({ 12: '2026-11-01T09:00:00Z' })
        expect(loadActivitySeen(null)).toEqual({})
    })
})

describe('failure handling', () => {
    it('degrades to nothing stored when localStorage throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied')
        })
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota')
        })
        expect(() => setLastProject(7, 3)).not.toThrow()
        expect(getLastProject(7)).toBeNull()
        expect(savePaneState(7, 3, 'c1', { tabs: [] })).toBe(false)
        expect(loadPaneState(7, 3, 'c1')).toBeNull()
        expect(loadUiPrefs()).toEqual({})
        expect(readJSON('anything', 'fallback')).toBe('fallback')
        expect(() => saveDraft(7, 3, 'c1', 'x')).not.toThrow()
        expect(loadDraft(7, 3, 'c1')).toBe('')
        expect(saveFindingsPrefs(7, 3, { status: 'done' })).toBe(false)
        expect(loadFindingsPrefs(7, 3)).toEqual({})
    })
})
