import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// The pane store reads the agent store (project, messages) and the auth
// store (user); plain stand-ins are enough for the highlight state.
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

vi.mock('../agent', () => ({ useAgentStore: () => agentState }))
vi.mock('../auth', () => ({ useAuthStore: () => authState }))

const { useAgentPaneStore } = await import('../agentPane')

let pane

beforeEach(() => {
  window.localStorage.clear()
  agentState.messages = {}
  agentState.visiblePath = () => []
  setActivePinia(createPinia())
  pane = useAgentPaneStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('find bar state', () => {
  it('only opens for a tab in the strip', () => {
    pane.openFind('url:nope')
    expect(pane.findOf('url:nope')).toBeNull()
    const id = pane.openUrl('https://example.com/')
    pane.openFind(id)
    expect(pane.findOf(id)).toMatchObject({ open: true, text: '', index: 0, count: 0 })
  })

  it('resets the position and bumps nav when the text changes', () => {
    const id = pane.openUrl('https://example.com/')
    pane.openFind(id)
    pane.setFindCount(id, 5)
    pane.stepFind(id, 1)
    const before = pane.findOf(id).nav
    pane.setFindText(id, 'pricing')
    expect(pane.findOf(id)).toMatchObject({ text: 'pricing', index: 0 })
    expect(pane.findOf(id).nav).toBe(before + 1)
    pane.setFindText(id, 'pricing')
    expect(pane.findOf(id).nav).toBe(before + 1)
  })

  it('ignores text for a tab whose bar is closed', () => {
    const id = pane.openUrl('https://example.com/')
    pane.setFindText(id, 'pricing')
    expect(pane.findOf(id)).toBeNull()
  })

  it('wraps next and previous and does nothing without matches', () => {
    const id = pane.openUrl('https://example.com/')
    pane.openFind(id)
    pane.stepFind(id, 1)
    expect(pane.findOf(id).index).toBe(0)
    pane.setFindCount(id, 3)
    pane.stepFind(id, -1)
    expect(pane.findOf(id).index).toBe(2)
    pane.stepFind(id, 1)
    expect(pane.findOf(id).index).toBe(0)
  })

  it('pulls the position back when the match count shrinks', () => {
    const id = pane.openUrl('https://example.com/')
    pane.openFind(id)
    pane.setFindCount(id, 4)
    pane.stepFind(id, -1)
    expect(pane.findOf(id).index).toBe(3)
    pane.setFindCount(id, 2)
    expect(pane.findOf(id).index).toBe(0)
  })

  it('drops the find text on close but keeps the keyword', () => {
    const id = pane.openUrl('https://example.com/')
    pane.openFind(id)
    pane.setFindText(id, 'pricing')
    pane.setKeywordHighlight({ keyword: 'crm' })
    pane.closeFind(id)
    expect(pane.findOf(id)).toBeNull()
    expect(pane.keywordHighlight).toMatchObject({ keyword: 'crm' })
    pane.toggleFind(id)
    expect(pane.findOf(id).text).toBe('')
  })

  it('forgets a tab’s find bar when the tab closes', async () => {
    const id = pane.openUrl('https://example.com/')
    pane.openFind(id)
    pane.closeTab(id)
    await nextTick()
    expect(pane.finds[id]).toBeUndefined()
  })
})

describe('keyword highlight', () => {
  it('normalises the keyword and dedupes names', () => {
    pane.setKeywordHighlight({
      keyword: '  best   crm ',
      brand: ['Acme', 'ACME', ''],
      competitors: ['Globex', 'globex', 'Initech'],
      sourceTabId: 'serp:1',
    })
    expect(pane.keywordHighlight).toEqual({
      keyword: 'best crm',
      brand: ['Acme'],
      competitors: ['Globex', 'Initech'],
      sourceTabId: 'serp:1',
    })
  })

  it('clears on a blank keyword', () => {
    pane.setKeywordHighlight({ keyword: 'crm' })
    pane.setKeywordHighlight({ keyword: '   ' })
    expect(pane.keywordHighlight).toBeNull()
  })
})

describe('highlightGroups', () => {
  it('combines the tab’s find text with the pane keyword', () => {
    const id = pane.openUrl('https://example.com/')
    pane.setKeywordHighlight({ keyword: 'best crm tools', brand: ['Acme'], competitors: ['Globex'] })
    expect(pane.highlightGroups(id)).toEqual({
      find: [],
      keyword: ['best crm tools', 'crm', 'tools'],
      brand: ['Acme'],
      competitor: ['Globex'],
    })
    pane.openFind(id)
    pane.setFindText(id, '   ')
    expect(pane.highlightGroups(id).find).toEqual([])
    pane.setFindText(id, 'pricing')
    expect(pane.highlightGroups(id).find).toEqual(['pricing'])
  })

  it('keeps one tab’s find text out of another tab', () => {
    const a = pane.openUrl('https://example.com/a')
    const b = pane.openUrl('https://example.com/b')
    pane.openFind(a)
    pane.setFindText(a, 'pricing')
    expect(pane.highlightGroups(b).find).toEqual([])
  })
})

describe('chat lifecycle', () => {
  it('clears find bars and the keyword when the chat changes', () => {
    pane.bindChat('c1')
    const id = pane.openUrl('https://example.com/')
    pane.openFind(id)
    pane.setKeywordHighlight({ keyword: 'crm' })
    pane.bindChat('c2')
    expect(pane.finds).toEqual({})
    expect(pane.keywordHighlight).toBeNull()
  })

  it('never writes highlight state to storage', async () => {
    vi.useFakeTimers()
    pane.bindChat('c1')
    const id = pane.openUrl('https://example.com/stored-page')
    pane.openFind(id)
    pane.setFindText(id, 'secret-find-text')
    pane.setKeywordHighlight({ keyword: 'secret-keyword', brand: ['SecretBrand'] })
    await nextTick()
    vi.advanceTimersByTime(1000)
    const stored = JSON.stringify({ ...window.localStorage })
    // The tab itself was saved, so the absence below is meaningful.
    expect(stored).toContain('stored-page')
    expect(stored).not.toContain('secret-find-text')
    expect(stored).not.toContain('secret-keyword')
    expect(stored).not.toContain('SecretBrand')
  })
})

describe('chatKeywords', () => {
  it('collects keywords from the chat’s research and open Google tabs', () => {
    agentState.messages = {
      m1: {
        id: 'm1',
        role: 'assistant',
        research: {
          serp: {
            s1: {
              query: 'best crm',
              brand: { name: 'Acme' },
              results: [{ is_competitor: true, competitor_name: 'Globex' }],
            },
            s2: {
              query: 'Best CRM',
              results: [{ is_competitor: true, competitor_name: 'Initech' }],
            },
            s3: { query: '   ' },
          },
        },
      },
    }
    agentState.visiblePath = () => ['m1']
    pane.bindChat('c1')
    pane.openSerp({ capture_id: 'live1', query: 'crm pricing', results: [] })
    expect(pane.chatKeywords).toEqual([
      { keyword: 'best crm', brand: ['Acme'], competitors: ['Globex', 'Initech'] },
      { keyword: 'crm pricing', brand: [], competitors: [] },
    ])
  })
})
