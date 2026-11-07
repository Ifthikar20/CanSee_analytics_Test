import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAuthStore } from '@/stores/auth'

const PREFS_KEY = 'cs-agent-ui-v1'
const SEEN_KEY = (uid) => `cs-agent-activity-seen-v1:${uid}`

function freshStore() {
  setActivePinia(createPinia())
  return useAgentUiStore()
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('agentUi preferences', () => {
  it('persists sidebar and recents collapse in cs-agent-ui-v1 and reads them back', () => {
    const ui = freshStore()
    ui.setSidebarCollapsed(true)
    ui.toggleRecents()
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY))
    expect(saved).toMatchObject({ sidebarCollapsed: true, recentsCollapsed: true })

    const again = freshStore()
    expect(again.sidebarCollapsed).toBe(true)
    expect(again.recentsCollapsed).toBe(true)
  })

  it('keeps other fields of the shared prefs object', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ paneRatio: 0.6 }))
    const ui = freshStore()
    ui.setSidebarCollapsed(true)
    expect(JSON.parse(localStorage.getItem(PREFS_KEY))).toEqual({ paneRatio: 0.6, sidebarCollapsed: true })
  })

  it('starts from defaults when the stored value is corrupt', () => {
    localStorage.setItem(PREFS_KEY, '{not json')
    const ui = freshStore()
    expect(ui.sidebarCollapsed).toBe(false)
    expect(ui.recentsCollapsed).toBe(false)
  })

  it('survives a storage that throws', () => {
    setActivePinia(createPinia())
    // The app creates the auth store at start, before the workspace opens.
    useAuthStore().user = { id: 7 }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const ui = useAgentUiStore()
    expect(() => ui.setSidebarCollapsed(true)).not.toThrow()
    expect(ui.sidebarCollapsed).toBe(true)
    expect(() => ui.markActivitySeen('w1', '2026-11-02T10:00:00Z')).not.toThrow()
    expect(ui.activitySeenAtFor('w1')).toBe('2026-11-02T10:00:00Z')
  })
})

describe('agentUi sidebar', () => {
  it('collapses the docked sidebar and toggles the drawer when narrow', () => {
    const ui = freshStore()
    ui.setDocked(true)
    expect(ui.sidebarVisible).toBe(true)
    expect(ui.showSidebarToggle).toBe(false)
    ui.toggleSidebar()
    expect(ui.sidebarCollapsed).toBe(true)
    expect(ui.sidebarVisible).toBe(false)
    expect(ui.showSidebarToggle).toBe(true)

    ui.setDocked(false)
    expect(ui.showSidebarToggle).toBe(true)
    expect(ui.drawerOpen).toBe(false)
    ui.toggleSidebar()
    expect(ui.drawerOpen).toBe(true)
    expect(ui.sidebarVisible).toBe(true)
    // The docked preference is untouched by the drawer.
    expect(ui.sidebarCollapsed).toBe(true)
  })

  it('closes the drawer when the layout becomes wide', () => {
    const ui = freshStore()
    ui.setDocked(false)
    ui.openDrawer()
    ui.setDocked(true)
    expect(ui.drawerOpen).toBe(false)
  })

  it('openSearch reveals the sidebar, expands recents and opens the filter', () => {
    const ui = freshStore()
    ui.setDocked(true)
    ui.setSidebarCollapsed(true)
    ui.setRecentsCollapsed(true)
    const before = ui.searchRequest
    ui.openSearch()
    expect(ui.sidebarCollapsed).toBe(false)
    expect(ui.recentsCollapsed).toBe(false)
    expect(ui.filterOpen).toBe(true)
    expect(ui.searchRequest).toBe(before + 1)
  })

  it('has no sidebar where the page has none', () => {
    const ui = freshStore()
    expect(ui.sidebarAvailable).toBe(true)
    ui.setDocked(false)
    ui.openDrawer()
    ui.setSidebarAvailable(false)
    // An open drawer closes with it.
    expect(ui.drawerOpen).toBe(false)
    expect(ui.showSidebarToggle).toBe(false)
    expect(ui.sidebarVisible).toBe(false)

    ui.setDocked(true)
    ui.setSidebarCollapsed(true)
    expect(ui.showSidebarToggle).toBe(false)
    expect(ui.sidebarVisible).toBe(false)

    // The toggles change nothing, the saved preference included.
    const request = ui.searchRequest
    ui.toggleSidebar()
    ui.openSidebar()
    ui.openSearch()
    expect(ui.sidebarCollapsed).toBe(true)
    expect(JSON.parse(localStorage.getItem(PREFS_KEY))).toMatchObject({ sidebarCollapsed: true })
    expect(ui.filterOpen).toBe(false)
    expect(ui.searchRequest).toBe(request)
    ui.setDocked(false)
    ui.toggleSidebar()
    ui.openSidebar()
    expect(ui.drawerOpen).toBe(false)

    // Back on a page with the sidebar, everything works as before.
    ui.setSidebarAvailable(true)
    expect(ui.showSidebarToggle).toBe(true)
    ui.toggleSidebar()
    expect(ui.drawerOpen).toBe(true)
    expect(ui.sidebarVisible).toBe(true)
    ui.setDocked(true)
    expect(ui.showSidebarToggle).toBe(true)
    ui.openSearch()
    expect(ui.sidebarCollapsed).toBe(false)
    expect(ui.filterOpen).toBe(true)
  })
})

describe('agentUi unseen chats and activity', () => {
  it('marks and clears unseen chats by id', () => {
    const ui = freshStore()
    ui.markUnseen(42)
    expect(ui.isUnseen('42')).toBe(true)
    ui.markSeen('42')
    expect(ui.isUnseen(42)).toBe(false)
  })

  it('only moves the activity watermark forward, stored for the signed-in user', () => {
    const ui = freshStore()
    useAuthStore().user = { id: 7 }
    ui.markActivitySeen('w1', '2026-11-02T10:00:00Z')
    ui.markActivitySeen('w1', '2026-11-01T10:00:00Z')
    expect(ui.activitySeenAtFor('w1')).toBe('2026-11-02T10:00:00Z')
    expect(JSON.parse(localStorage.getItem(SEEN_KEY(7)))).toEqual({ w1: '2026-11-02T10:00:00Z' })
    // Not in the device prefs every user of this browser shares.
    expect(localStorage.getItem(PREFS_KEY)).toBeNull()
  })

  it("keeps each user's activity read state apart and drops it on sign-out", () => {
    const ui = freshStore()
    const auth = useAuthStore()
    auth.accessToken = 'token-a'
    auth.user = { id: 7 }
    ui.markActivitySeen('12', '2026-11-02T15:00:00Z')

    auth.clearAuth()
    expect(ui.activitySeenAtFor('12')).toBeNull()
    expect(localStorage.getItem(SEEN_KEY(7))).toBeNull()

    // Another member of project 12 signs in on the same browser.
    auth.accessToken = 'token-b'
    auth.user = { id: 8 }
    expect(ui.activitySeenAtFor('12')).toBeNull()

    // Each user's own stored watermark comes back with them.
    localStorage.setItem(SEEN_KEY(9), JSON.stringify({ 12: '2026-11-01T09:00:00Z' }))
    auth.user = { id: 9 }
    expect(ui.activitySeenAtFor('12')).toBe('2026-11-01T09:00:00Z')
  })

  it('forgets unseen chats when another user signs in', () => {
    const ui = freshStore()
    const auth = useAuthStore()
    auth.user = { id: 7 }
    ui.markUnseen('c1')
    auth.user = { id: 8 }
    expect(ui.isUnseen('c1')).toBe(false)
  })
})

describe('agentUi.announce', () => {
  it('routes by politeness and normalises whitespace', () => {
    const ui = freshStore()
    ui.announce('  Agent   is working ')
    expect(ui.politeAnnouncement.text).toBe('Agent is working')
    ui.announce('The agent stopped with an error.', 'assertive')
    expect(ui.assertiveAnnouncement.text).toBe('The agent stopped with an error.')
  })

  it('drops an identical message inside 1.5 s and clears text later', () => {
    vi.useFakeTimers()
    const ui = freshStore()
    expect(ui.announce('Chat deleted')).toBe(true)
    const id = ui.politeAnnouncement.id
    expect(ui.announce('Chat deleted')).toBe(false)
    expect(ui.politeAnnouncement.id).toBe(id)
    vi.advanceTimersByTime(1600)
    expect(ui.announce('Chat deleted')).toBe(true)
    expect(ui.politeAnnouncement.id).toBe(id + 1)
    vi.advanceTimersByTime(8000)
    expect(ui.politeAnnouncement.text).toBe('')
  })

  it('ignores empty text', () => {
    const ui = freshStore()
    expect(ui.announce('   ')).toBe(false)
    expect(ui.announce(null)).toBe(false)
  })
})

describe('agentUi.focusComposer', () => {
  it('prefers the latest registered handler', async () => {
    const ui = freshStore()
    const first = vi.fn(() => true)
    const second = vi.fn(() => true)
    ui.registerComposer(first)
    const off = ui.registerComposer(second)
    await expect(ui.focusComposer()).resolves.toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    off()
    await ui.focusComposer()
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('falls back to the composer textarea in the DOM', async () => {
    const ui = freshStore()
    document.body.innerHTML = '<form class="ag-composer"><textarea></textarea></form>'
    await expect(ui.focusComposer()).resolves.toBe(true)
    expect(document.activeElement).toBe(document.querySelector('.ag-composer textarea'))
  })

  it('retries until the composer mounts', async () => {
    vi.useFakeTimers()
    const ui = freshStore()
    const done = ui.focusComposer()
    vi.advanceTimersByTime(120)
    document.body.innerHTML = '<form class="ag-composer"><textarea></textarea></form>'
    vi.advanceTimersByTime(60)
    await expect(done).resolves.toBe(true)
    expect(ui.composerFocusRequest).toBe(1)
  })

  it('gives up after about 1.5 s', async () => {
    vi.useFakeTimers()
    const ui = freshStore()
    const done = ui.focusComposer()
    vi.advanceTimersByTime(2000)
    await expect(done).resolves.toBe(false)
  })
})

describe('agentUi.reset', () => {
  it('runs on a sign-out from anywhere in the app, not only the workspace menu', () => {
    const ui = freshStore()
    const auth = useAuthStore()
    auth.accessToken = 'token'
    auth.user = { id: 7 }
    ui.setSidebarCollapsed(true)
    ui.openShortcuts()
    ui.markUnseen('c1')
    ui.announce('Reply finished')
    // An expired session or the main app's sign-out, not the header's account menu.
    auth.clearAuth()
    expect(ui.isUnseen('c1')).toBe(false)
    expect(ui.shortcutsOpen).toBe(false)
    expect(ui.politeAnnouncement.text).toBe('')
    expect(ui.sidebarCollapsed).toBe(true)
  })

  it('closes dialogs and forgets unseen chats but keeps device prefs', () => {
    const ui = freshStore()
    ui.setSidebarCollapsed(true)
    ui.openShortcuts()
    ui.openAddProject()
    ui.markUnseen('c1')
    ui.reset()
    expect(ui.shortcutsOpen).toBe(false)
    expect(ui.addProjectOpen).toBe(false)
    expect(ui.isUnseen('c1')).toBe(false)
    expect(ui.sidebarCollapsed).toBe(true)
  })
})
