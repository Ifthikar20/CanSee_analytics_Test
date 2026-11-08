import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
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

describe('chatRanking', () => {
  const stamped = (id, prompt, query, positions) => ({
    capture_id: id,
    query,
    page: 1,
    captured_at: '2026-11-04T10:00:00Z',
    prompt_id: prompt,
    brand_prompt_id: `b-${prompt}`,
    results: [],
    brand_positions: positions,
  })

  it('ranks the tracked prompts of the visible branch only', () => {
    agentState.messages = {
      m1: { id: 'm1', role: 'assistant', research: { serp: { s1: stamped('s1', 'P1', 'best crm', [7]) } } },
      m2: { id: 'm2', role: 'assistant', research: { serp: { s2: stamped('s2', 'P2', 'other branch', [1]) } } },
      m3: { id: 'm3', role: 'assistant', research: { serp: { s3: { capture_id: 's3', query: 'ad hoc', results: [] } } } },
    }
    agentState.visiblePath = () => ['m1', 'm3']
    pane.bindChat('c1')
    expect(pane.chatRanking.rows.map((r) => [r.keyword, r.position])).toEqual([['best crm', 7]])
    expect(pane.chatRanking.byPromptId.P1.googleText).toBe('#7')
    // The ad-hoc search is still offered for highlighting.
    expect(pane.chatKeywords.map((k) => k.keyword)).toEqual(['best crm', 'ad hoc'])
  })

  it('never counts an open Google tab, which can hold another branch’s page', () => {
    agentState.messages = {
      m1: { id: 'm1', role: 'assistant', research: { serp: { s1: stamped('s1', 'P1', 'best crm', [3]) } } },
    }
    agentState.visiblePath = () => ['m1']
    pane.bindChat('c1')
    // A newer page of the same prompt from another branch, still open.
    pane.openSerp({ ...stamped('s9', 'P1', 'best crm', []), captured_at: '2026-11-05T10:00:00Z' })
    pane.openSerp(stamped('s8', 'P8', 'crm pricing', [1]))
    expect(pane.chatRanking.rows.map((r) => [r.promptId, r.position])).toEqual([['P1', 3]])
  })

  it('takes a streaming run’s captures from its message, and keeps the ranking while only text streams', () => {
    const research = { serp: { s1: stamped('s1', 'P1', 'best crm', [4]) } }
    agentState.messages = reactive({ m1: { id: 'm1', role: 'assistant', content: 'a', research } })
    agentState.visiblePath = () => ['m1']
    pane.bindChat('c1')
    const first = pane.chatRanking
    expect(first.rows.map((r) => r.promptId)).toEqual(['P1'])
    // A text delta replaces the message and keeps its research.
    agentState.messages.m1 = { ...agentState.messages.m1, content: 'ab' }
    expect(pane.chatRanking).toBe(first)
    // research.recorded replaces the research with a new capture in it.
    agentState.messages.m1 = {
      ...agentState.messages.m1,
      research: { serp: { ...agentState.messages.m1.research.serp, s2: stamped('s2', 'P2', 'crm pricing', [2]) } },
    }
    expect(pane.chatRanking).not.toBe(first)
    expect(pane.chatRanking.rows.map((r) => r.promptId)).toEqual(['P2', 'P1'])
  })

  it('is empty for a new chat', () => {
    pane.bindChat('new')
    expect(pane.chatRanking.rows).toEqual([])
  })
})
