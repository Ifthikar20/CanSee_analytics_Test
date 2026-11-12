import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// The keywords tab of the pane store: one per pane, its sort stored with the
// chat's tabs, its data never stored, and the keyword it highlighted cleared
// when it leaves the strip.
const { agentState, authState } = vi.hoisted(() => ({
  agentState: {
    websiteId: 'w1',
    messages: {},
    chatState: {},
    swarms: {},
    artifacts: {},
    visiblePath: () => [],
  },
  authState: { user: { id: 'u1' }, session: null, accessToken: null },
}))

vi.mock('../../stores/agent', () => ({ useAgentStore: () => agentState }))
vi.mock('../../stores/auth', () => ({ useAuthStore: () => authState }))

const { useAgentPaneStore, KEYWORDS_TAB_ID, MAX_TABS } = await import('../agentPane')

let pane

beforeEach(() => {
  window.localStorage.clear()
  agentState.websiteId = 'w1'
  agentState.messages = {}
  agentState.chatState = {}
  agentState.visiblePath = () => []
  setActivePinia(createPinia())
  pane = useAgentPaneStore()
})

afterEach(() => {
  vi.useRealTimers()
})

const storedTabs = () => {
  const text = JSON.stringify({ ...window.localStorage })
  return text
}

describe('keywords tab', () => {
  it('opens one keywords tab and reuses it', () => {
    pane.bindChat('c1')
    expect(pane.openKeywords()).toBe(KEYWORDS_TAB_ID)
    expect(pane.openKeywords({ sort: 'google' })).toBe(KEYWORDS_TAB_ID)
    expect(pane.tabs).toHaveLength(1)
    expect(pane.activeTab).toMatchObject({ id: 'keywords', kind: 'keywords', sort: 'google', status: 'ready' })
    expect(pane.titleOf(pane.activeTab)).toBe('Keywords')
    expect(pane.open).toBe(true)
  })

  it('ignores an unknown sort and treats the gap sort as the default', () => {
    pane.bindChat('c1')
    pane.openKeywords({ sort: 'nonsense' })
    expect(pane.activeTab.sort).toBeNull()
    pane.openKeywords({ sort: 'gap' })
    expect(pane.activeTab.sort).toBeNull()
  })

  it('needs a project', () => {
    agentState.websiteId = null
    pane.bindChat('c1')
    expect(pane.openKeywords()).toBeNull()
    expect(pane.tabs).toHaveLength(0)
  })

  it('stores the sort but never the loaded data, and restores the tab ready', async () => {
    vi.useFakeTimers()
    pane.bindChat('c1')
    pane.openKeywords({ sort: 'ai' })
    pane.updateTab(KEYWORDS_TAB_ID, {
      status: 'ready',
      data: { overview: { prompts: [{ text: 'secret-keyword-text' }] } },
    })
    pane.updateTab(KEYWORDS_TAB_ID, { changedOnly: true })
    await nextTick()
    vi.advanceTimersByTime(1000)
    const stored = storedTabs()
    const saved = JSON.parse(window.localStorage.getItem('cs-agent-tabs-v1:u1:w1'))
    expect(saved.chats.c1.state.tabs).toEqual([{ id: 'keywords', kind: 'keywords', sort: 'ai' }])
    expect(stored).not.toContain('secret-keyword-text')
    expect(stored).not.toContain('changedOnly')

    setActivePinia(createPinia())
    pane = useAgentPaneStore()
    pane.bindChat('c1')
    await nextTick()
    const restored = pane.tabs.find((t) => t.id === KEYWORDS_TAB_ID)
    expect(restored).toMatchObject({ kind: 'keywords', sort: 'ai', status: 'ready', data: null, changedOnly: false })
  })

  it('keeps sort and changedOnly out of the tab data', () => {
    pane.bindChat('c1')
    pane.openKeywords()
    pane.updateTab(KEYWORDS_TAB_ID, { sort: 'google', changedOnly: true })
    expect(pane.activeTab).toMatchObject({ sort: 'google', changedOnly: true })
    expect(pane.activeTab.data).toBeNull()
  })
})

describe('keyword highlight from the keywords tab', () => {
  it('clears when the keywords tab closes', () => {
    pane.bindChat('c1')
    pane.openKeywords()
    pane.setKeywordHighlight({ keyword: 'best crm', sourceTabId: KEYWORDS_TAB_ID })
    pane.closeTab(KEYWORDS_TAB_ID)
    expect(pane.keywordHighlight).toBeNull()
  })

  it('clears when the keywords tab is evicted for a newer tab', () => {
    pane.bindChat('c1')
    pane.openKeywords()
    pane.setKeywordHighlight({ keyword: 'best crm', sourceTabId: KEYWORDS_TAB_ID })
    for (let i = 0; i <= MAX_TABS; i += 1) pane.openUrl(`https://example.com/${i}`)
    expect(pane.tabs.some((t) => t.id === KEYWORDS_TAB_ID)).toBe(false)
    expect(pane.keywordHighlight).toBeNull()
  })

  it('stays when a Google results tab that set it closes', () => {
    pane.bindChat('c1')
    pane.openKeywords({ activate: false })
    const serp = pane.openSerp({ capture_id: 'g1', query: 'best crm', results: [] })
    const serpId = typeof serp === 'string' ? serp : 'serp:g1'
    pane.setKeywordHighlight({ keyword: 'best crm', sourceTabId: serpId })
    pane.closeTab(serpId)
    expect(pane.keywordHighlight).toMatchObject({ keyword: 'best crm' })
  })
})
