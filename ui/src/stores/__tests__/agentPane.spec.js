import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('@/stores/agent', async () => {
  const m = await import('@/components/agent/browser/__tests__/__fixtures__/stores.js')
  return { useAgentStore: m.useAgentStore }
})
vi.mock('@/stores/auth', async () => {
  const m = await import('@/components/agent/browser/__tests__/__fixtures__/stores.js')
  return { useAuthStore: m.useAuthStore }
})

import { MAX_TABS, researchTabs, serpPageKey, useAgentPaneStore } from '../agentPane'
import { useAgentStore } from '@/stores/agent'
import { serpCapture } from '@/components/agent/browser/__tests__/__fixtures__/stores.js'

const TABS_KEY = 'cs-agent-tabs-v1:7:w1'

function serpSpec(id, status = 'loading', data = {}) {
  return { id: `serp:${id}`, kind: 'serp', title: `Google · q${id}`, status, data: { capture_id: id, query: `q${id}`, page: 1, ...data } }
}

function assistant(id, parts, research = { serp: {}, pages: {} }) {
  return { id, role: 'assistant', parts, research }
}

describe('agentPane store', () => {
  let pane
  let agent

  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    agent = useAgentStore()
    pane = useAgentPaneStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('tabs', () => {
    it('opens a Google results tab and activates it only when asked', () => {
      pane.openSerp(serpSpec('a'), { activate: false })
      expect(pane.tabs).toHaveLength(1)
      expect(pane.activeId).toBe(null)
      expect(pane.open).toBe(false)

      pane.openSerp(serpSpec('b'), { activate: true })
      expect(pane.activeId).toBe('serp:b')
      expect(pane.open).toBe(true)
      expect(pane.activeTab.kind).toBe('serp')
    })

    it('accepts a bare SerpCapture', () => {
      const id = pane.openSerp(serpCapture(), { activate: true })
      expect(id).toBe('serp:c1')
      expect(pane.activeTab.status).toBe('ready')
      expect(pane.titleOf(pane.activeTab)).toBe('Google · best note app · p2')
    })

    it('titles every results page with its number, as the server does', () => {
      pane.openSerp(serpCapture({ capture_id: 'p1', page: 1 }))
      expect(pane.titleOf(pane.tabs[0])).toBe('Google · best note app · p1')
    })

    it('merges browser.update patches into data (reducer and contract shapes)', () => {
      pane.openSerp(serpSpec('a'), { activate: true })
      pane.updateTab('serp:a', { data: { results: [], brand_positions: [] }, status: 'ready' })
      expect(pane.activeTab.status).toBe('ready')
      expect(pane.activeTab.data.query).toBe('qa')

      pane.openSerp(serpSpec('b'))
      pane.updateTab('serp:b', { results: [{ position: 1 }] })
      const tab = pane.tabs.find((t) => t.id === 'serp:b')
      expect(tab.data.results).toHaveLength(1)
      expect(tab.status).toBe('ready')

      pane.updateTab('serp:b', { error: { code: 'serp_not_configured', message: 'x' } })
      expect(tab.status).toBe('error')
    })

    it('closes to the right neighbour, then the left, and hides the pane when empty', () => {
      for (const id of ['a', 'b', 'c']) pane.openSerp(serpSpec(id))
      pane.activateTab('serp:b')
      expect(pane.closeTab('serp:b')).toBe('serp:c')
      expect(pane.closeTab('serp:c')).toBe('serp:a')
      pane.closeTab('serp:a')
      expect(pane.tabs).toHaveLength(0)
      expect(pane.open).toBe(false)
    })

    it(`keeps at most ${MAX_TABS} tabs and evicts the least recently used inactive one`, () => {
      pane.openSerp(serpSpec('first'), { activate: true })
      for (let i = 0; i < MAX_TABS; i++) pane.openSerp(serpSpec(`n${i}`))
      expect(pane.tabs).toHaveLength(MAX_TABS)
      expect(pane.tabs.some((t) => t.id === 'serp:first')).toBe(true)
      expect(pane.tabs.some((t) => t.id === 'serp:n0')).toBe(false)
    })

    it('normalizes, reuses and refuses URLs', () => {
      const id = pane.openUrl('example.com/pricing')
      expect(pane.activeTab.url).toBe('https://example.com/pricing')
      expect(pane.activeTab.status).toBe('idle')
      expect(pane.openUrl('https://example.com/pricing')).toBe(id)
      expect(pane.tabs).toHaveLength(1)
      expect(pane.openUrl('javascript:alert(1)')).toBe(null)
      expect(pane.tabs).toHaveLength(1)
    })

    it('reuses one new tab and turns it into a page on navigation', () => {
      const id = pane.openNewTab()
      expect(pane.openNewTab()).toBe(id)
      pane.navigateTab(id, 'example.com')
      expect(pane.activeTab.kind).toBe('url')
      expect(pane.activeTab.url).toBe('https://example.com/')
    })

    it('keeps per-tab history for back and forward', () => {
      const id = pane.openUrl('https://a.test/')
      pane.updateTab(id, { status: 'ready', data: { title: 'A' } })
      pane.navigateTab(id, 'https://a.test/b')
      pane.navigateTab(id, 'https://a.test/c')
      pane.goBack(id)
      expect(pane.activeTab.url).toBe('https://a.test/b')
      expect(pane.activeTab.status).toBe('idle')
      pane.goForward(id)
      expect(pane.activeTab.url).toBe('https://a.test/c')
      pane.goBack(id)
      pane.navigateTab(id, 'https://a.test/d')
      expect(pane.activeTab.history.entries).toEqual(['https://a.test/', 'https://a.test/b', 'https://a.test/d'])
      expect(pane.goForward(id)).toBe(null)
    })

    it('opens artifacts once and keeps the chosen version unless told otherwise', () => {
      pane.openArtifact('42', { activate: true, version: 2 })
      pane.openArtifact('42')
      expect(pane.tabs).toHaveLength(1)
      expect(pane.activeTab.version).toBe(2)
      pane.openArtifact('42', { version: null })
      expect(pane.activeTab.version).toBe(null)
    })

    it('clamps and stores the split ratio as a device preference', () => {
      pane.setRatio(0.99)
      expect(pane.ratio).toBe(0.85)
      expect(JSON.parse(localStorage.getItem('cs-agent-ui-v1')).paneRatio).toBe(0.85)
    })
  })

  describe('chat binding and rebuild', () => {
    function seedChat(chatId) {
      agent.messages.m1 = { id: 'm1', role: 'user', parts: [{ id: 'p0', type: 'text', text: 'Research' }] }
      agent.messages.m2 = assistant(
        'm2',
        [
          { id: 'p1', type: 'serp', status: 'done', tab_id: 'serp:c1', query: 'best note app', page: 2 },
          { id: 'p2', type: 'page_inspect', status: 'done', tab_id: 'page:p9', url: 'https://turonote.test/' },
          { id: 'p3', type: 'agent_call', status: 'done', artifact_id: 'a5', title: 'Battery page' },
        ],
        {
          serp: { c1: serpCapture() },
          pages: { p9: { capture_id: 'p9', url: 'https://turonote.test/', final_url: 'https://turonote.test/', frameable: true, seo: { title: 'Turonote' } } },
        }
      )
      agent.paths[chatId] = ['m1', 'm2']
      agent.chatState[chatId] = { loaded: true }
    }

    it('derives research and artifact tabs from messages', () => {
      seedChat('c')
      const specs = researchTabs(agent.visiblePath('c'))
      expect(specs.map((s) => s.id)).toEqual(['serp:c1', 'page:p9', 'artifact:a5'])
      expect(specs[0].status).toBe('ready')
      expect(specs[1].complete).toBe(true)
    })

    it('rebuilds tabs for a chat with no stored state and activates the newest', () => {
      seedChat('c')
      pane.bindChat('c')
      expect(pane.tabs.map((t) => t.id)).toEqual(['serp:c1', 'page:p9', 'artifact:a5'])
      expect(pane.activeId).toBe('artifact:a5')
      expect(pane.tabs[1].url).toBe('https://turonote.test/')
    })

    it('persists ids and urls only, and restores them with research data', async () => {
      vi.useFakeTimers()
      seedChat('c')
      pane.bindChat('c')
      pane.openUrl('https://example.com/a')
      pane.closeTab('page:p9')
      await nextTick()
      vi.advanceTimersByTime(200)

      const stored = JSON.parse(localStorage.getItem(TABS_KEY))
      const state = stored.chats.c.state
      expect(state.tabs.map((t) => t.id)).toEqual(['serp:c1', 'artifact:a5', expect.stringMatching(/^url:/)])
      expect(JSON.stringify(state)).not.toContain('best note app')
      expect(state.closed).toContain('page:p9')

      pane.bindChat('other')
      expect(pane.tabs).toHaveLength(0)
      pane.bindChat('c')
      expect(pane.tabs.map((t) => t.kind)).toEqual(['serp', 'artifact', 'url'])
      expect(pane.tabs[0].data.query).toBe('best note app')
      expect(pane.tabs[0].status).toBe('ready')
      expect(pane.tabs.some((t) => t.id === 'page:p9')).toBe(false)
    })

    it('reopens a closed research tab when its step is clicked', () => {
      seedChat('c')
      pane.bindChat('c')
      pane.closeTab('serp:c1')
      expect(pane.activateTab('serp:c1')).toBe('serp:c1')
      expect(pane.activeTab.data.results).toHaveLength(3)
    })

    it('marks restored captures that the chat no longer has', async () => {
      vi.useFakeTimers()
      localStorage.setItem(
        TABS_KEY,
        JSON.stringify({ v: 1, chats: { c: { at: 1, state: { open: true, active: 'serp:gone', tabs: [{ id: 'serp:gone', kind: 'serp' }] } } } })
      )
      agent.paths.c = []
      agent.chatState.c = { loaded: false }
      pane.bindChat('c')
      expect(pane.tabs[0].status).toBe('missing')
      agent.messages.m2 = assistant('m2', [])
      agent.paths.c = ['m2']
      agent.chatState.c = { loaded: true }
      await nextTick()
      expect(pane.tabs[0].status).toBe('gone')
    })

    it('opens an artifact tab while a sub-agent drafts it', async () => {
      agent.messages.m2 = assistant('m2', [{ id: 'p3', type: 'agent_call', status: 'preparing' }])
      agent.paths.c = ['m2']
      pane.bindChat('c')
      expect(pane.tabs).toHaveLength(0)
      agent.messages.m2.parts[0] = { id: 'p3', type: 'agent_call', status: 'drafting', artifact_id: 'a7' }
      await nextTick()
      expect(pane.activeId).toBe('artifact:a7')
      expect(pane.open).toBe(true)
    })

    it('settles a loading results tab when its step ends without a capture', async () => {
      agent.messages.m2 = {
        ...assistant('m2', [{ id: 'p1', type: 'serp', status: 'running', tab_id: 'serp:c1', query: 'q', page: 1 }]),
        status: 'streaming',
      }
      agent.paths.c = ['m2']
      agent.chatState.c = { loaded: true }
      pane.bindChat('c')
      pane.openSerp(serpSpec('c1'), { activate: true })
      expect(pane.activeTab.status).toBe('loading')

      // The resync brings the reply the sweeper closed.
      agent.messages.m2.status = 'interrupted'
      agent.messages.m2.parts[0] = {
        ...agent.messages.m2.parts[0],
        status: 'error',
        error: { code: 'interrupted', message: 'Interrupted' },
      }
      await nextTick()
      expect(pane.activeTab.status).toBe('error')
      expect(pane.activeTab.data.error).toEqual({ code: 'interrupted', message: 'Interrupted' })
    })

    it('settles loading research tabs when the reply ended here with steps still running', async () => {
      agent.messages.m2 = {
        ...assistant('m2', [
          { id: 'p1', type: 'serp', status: 'running', tab_id: 'serp:c1', query: 'q', page: 1 },
          { id: 'p2', type: 'page_inspect', status: 'running', tab_id: 'page:p9', url: 'https://turonote.test/' },
        ]),
        status: 'streaming',
      }
      agent.paths.c = ['m2']
      agent.chatState.c = { loaded: true }
      pane.bindChat('c')
      pane.openSerp(serpSpec('c1'))
      pane.openPage({ id: 'page:p9', kind: 'page', status: 'loading', data: { capture_id: 'p9', url: 'https://turonote.test/' } })

      // The stream gave up: the run was settled locally, no part was closed.
      agent.messages.m2.status = 'cancelled'
      await nextTick()
      const serp = pane.tabs.find((t) => t.id === 'serp:c1')
      const page = pane.tabs.find((t) => t.id === 'page:p9')
      expect(serp.status).toBe('error')
      expect(serp.data.error).toEqual({ code: 'stopped', message: 'Stopped' })
      expect(page.status).toBe('error')
      expect(page.data.error.code).toBe('stopped')
    })

    it('never opens a tab for an artifact the agent did not save', () => {
      agent.messages.m2 = assistant('m2', [
        { id: 'p1', type: 'agent_call', status: 'cancelled', artifact_id: 'a8', title: 'Acme page', kind: 'page', error: 'Stopped' },
        { id: 'p2', type: 'agent_call', status: 'error', artifact_id: 'a9', title: 'Guide', kind: 'document', error: 'The page is incomplete.' },
        { id: 'p3', type: 'agent_call', status: 'done', artifact_id: 'a10', version: 1, title: 'Ads', kind: 'sheet' },
        // A failed revision of an artifact saved in another chat.
        { id: 'p4', type: 'agent_call', status: 'error', artifact_id: 'a11', base_version: 2, kind: 'page', error: 'Upstream' },
      ])
      agent.paths.c = ['m2']
      agent.chatState.c = { loaded: true }

      const specs = researchTabs(agent.visiblePath('c'))
      expect(specs.map((s) => [s.id, s.unsaved])).toEqual([
        ['artifact:a8', true],
        ['artifact:a9', true],
        ['artifact:a10', false],
        ['artifact:a11', false],
      ])
      pane.bindChat('c')
      expect(pane.tabs.map((t) => t.id)).toEqual(['artifact:a10', 'artifact:a11'])
      expect(pane.activateTab('artifact:a9')).toBe(null)
      expect(pane.artifactCall('a9')).toEqual({
        status: 'error',
        active: false,
        saved: false,
        error: 'The page is incomplete.',
        kind: 'document',
        title: 'Guide',
      })
      expect(pane.artifactCall('a10').saved).toBe(true)
    })

    it('treats a call still drafting in a reply that ended as not finished', () => {
      agent.messages.m2 = {
        ...assistant('m2', [{ id: 'p1', type: 'agent_call', status: 'drafting', artifact_id: 'a8', kind: 'page' }]),
        status: 'interrupted',
      }
      agent.paths.c = ['m2']
      pane.bindChat('c')
      expect(pane.tabs).toHaveLength(0)
      expect(pane.open).toBe(false)
      expect(pane.artifactCall('a8')).toMatchObject({ status: 'error', active: false, saved: false, error: 'Interrupted' })
    })

    it('opens the artifact again for each new draft of it', async () => {
      agent.messages.m2 = assistant('m2', [{ id: 'p1', type: 'agent_call', status: 'drafting', artifact_id: 'a7', kind: 'page' }])
      agent.paths.c = ['m2']
      pane.bindChat('c')
      expect(pane.activeId).toBe('artifact:a7')
      agent.messages.m2.parts[0] = { id: 'p1', type: 'agent_call', status: 'done', artifact_id: 'a7', version: 1, kind: 'page' }
      await nextTick()
      pane.closeTab('artifact:a7')
      expect(pane.open).toBe(false)

      // A later turn revises it.
      agent.messages.m4 = assistant('m4', [{ id: 'p9', type: 'agent_call', status: 'planning', artifact_id: 'a7', kind: 'page' }])
      agent.paths.c = ['m2', 'm4']
      await nextTick()
      expect(pane.activeId).toBe('artifact:a7')
      expect(pane.open).toBe(true)
      expect(pane.artifactCall('a7')).toMatchObject({ status: 'planning', active: true, saved: true })
    })

    it('moves the new chat state to its id', () => {
      vi.useFakeTimers()
      pane.bindChat('new')
      pane.openUrl('https://example.com/')
      pane.rekeyChat('new', 'c42')
      expect(pane.chatKey).toBe('c42')
      expect(pane.tabs).toHaveLength(1)
      const stored = JSON.parse(localStorage.getItem(TABS_KEY))
      expect(stored.chats.c42.state.tabs[0].url).toBe('https://example.com/')
    })

    it('does not open the pane for the agent where it would cover the chat', () => {
      pane.setLayout('overlay')
      pane.openSerp(serpSpec('a'), { activate: true })
      expect(pane.activeId).toBe('serp:a')
      expect(pane.open).toBe(false)
      expect(pane.attention).toBe(true)

      pane.setOpen(true)
      expect(pane.open).toBe(true)
      expect(pane.attention).toBe(false)
      // Opened by the user, it stays open as an overlay.
      pane.setLayout('overlay')
      expect(pane.open).toBe(true)
    })

    it('closes a pane the agent opened once the layout turns out to be an overlay', () => {
      pane.openSerp(serpSpec('a'), { activate: true })
      expect(pane.open).toBe(true)
      pane.setLayout('overlay')
      expect(pane.open).toBe(false)
      expect(pane.attention).toBe(true)

      pane.setLayout('split')
      pane.openSerp(serpSpec('b'), { activate: true })
      expect(pane.open).toBe(true)
      expect(pane.attention).toBe(false)
    })

    it('resets when the project changes', () => {
      pane.bindChat('c')
      pane.openUrl('https://example.com/')
      agent.websiteId = 'w2'
      expect(pane.tabs).toHaveLength(0)
      expect(pane.chatKey).toBe(null)
    })
  })

  describe('research agents', () => {
    const PAGE_CAPTURE = {
      capture_id: 'pg1',
      url: 'https://notely.test/',
      final_url: 'https://notely.test/',
      frameable: true,
      status_code: 200,
      seo: { title: 'Notely: notes for teams' },
      error: null,
    }

    // A finished swarm whose agents took one Google page and one page (read
    // twice); the Claude agent failed without a capture.
    function swarmPart(overrides = {}) {
      return {
        id: 'p4',
        type: 'swarm',
        swarm_id: 's1',
        version: 1,
        status: 'done',
        tasks: [
          {
            id: 'google.p1.page1',
            status: 'done',
            pane: { kind: 'serp', tab_id: 'serp:c1' },
            detail: { query: 'best note app', page: 2, location: 'us' },
          },
          {
            id: 'competitors.p1.c1',
            status: 'done',
            pane: { kind: 'page', tab_id: 'page:pg1' },
            detail: { url: 'https://notely.test/', title: 'Notely' },
          },
          { id: 'engines.p1.claude', status: 'failed', pane: null, error: { code: 'rate_limited', message: 'Busy' } },
          { id: 'site.p1.page', status: 'done', pane: { kind: 'page', tab_id: 'page:pg1' }, detail: { url: 'https://notely.test/' } },
        ],
        ...overrides,
      }
    }

    function seedSwarmChat(chatId, part = swarmPart(), research = { serp: { c1: serpCapture() }, pages: { pg1: PAGE_CAPTURE } }) {
      agent.messages.m1 = { id: 'm1', role: 'user', parts: [{ id: 'p0', type: 'text', text: 'Research' }] }
      agent.messages.m2 = { ...assistant('m2', [part], research), status: 'complete' }
      agent.paths[chatId] = ['m1', 'm2']
      agent.chatState[chatId] = { loaded: true }
    }

    it('opens one results table tab per swarm and switches its version', () => {
      expect(pane.openTable('s1', { version: 2, title: 'Research Notion' })).toBe('table:s1')
      expect(pane.activeTab).toMatchObject({ id: 'table:s1', kind: 'table', swarmId: 's1', version: 2, status: 'ready' })
      expect(pane.open).toBe(true)
      expect(pane.titleOf(pane.activeTab)).toBe('Research Notion')

      // Again: the same tab, now on the latest version, keeping its title.
      expect(pane.openTable('s1')).toBe('table:s1')
      expect(pane.tabs).toHaveLength(1)
      expect(pane.activeTab).toMatchObject({ version: null, title: 'Research Notion' })

      pane.openTable('s2', { activate: false })
      expect(pane.tabs.map((t) => t.id)).toEqual(['table:s1', 'table:s2'])
      expect(pane.activeId).toBe('table:s1')
      expect(pane.titleOf(pane.tabs[1])).toBe('Research results')
      pane.updateTab('table:s2', { version: 3 })
      expect(pane.tabs[1].version).toBe(3)
      expect(pane.openTable('')).toBe(null)
      expect(pane.openTable(null)).toBe(null)
    })

    it('persists results table tabs by swarm and version, and restores them ready', async () => {
      vi.useFakeTimers()
      agent.paths.c = []
      agent.chatState.c = { loaded: true }
      pane.bindChat('c')
      pane.openTable('s1', { version: 2, title: 'Research Notion' })
      pane.openTable('s2')
      await nextTick()
      vi.advanceTimersByTime(200)

      const state = JSON.parse(localStorage.getItem(TABS_KEY)).chats.c.state
      expect(state.tabs).toEqual([
        { id: 'table:s1', kind: 'table', swarm_id: 's1', version: 2 },
        { id: 'table:s2', kind: 'table', swarm_id: 's2', version: null },
      ])
      expect(state.active).toBe('table:s2')

      pane.bindChat('other')
      expect(pane.tabs).toHaveLength(0)
      pane.bindChat('c')
      expect(pane.tabs.map((t) => [t.id, t.kind, t.swarmId, t.version, t.status])).toEqual([
        ['table:s1', 'table', 's1', 2, 'ready'],
        ['table:s2', 'table', 's2', null, 'ready'],
      ])
      expect(pane.activeId).toBe('table:s2')
      expect(pane.titleOf(pane.tabs[0])).toBe('Research results')
    })

    it('derives the agents\' captures only when asked: first occurrence, Google pages open by themselves', () => {
      seedSwarmChat('c')
      expect(researchTabs(agent.visiblePath('c'))).toEqual([])
      const specs = researchTabs(agent.visiblePath('c'), { includeSwarm: true })
      expect(specs.map((s) => [s.id, s.kind, s.status, s.auto])).toEqual([
        ['serp:c1', 'serp', 'ready', true],
        ['page:pg1', 'page', 'ready', false],
      ])
      expect(specs[0].title).toBe('Google · best note app · p2')
      expect(specs[0].order).toEqual({ group: 's1:1', index: 0 })
      expect(specs[1].title).toBe('Notely: notes for teams')
    })

    it('never adds a page capture to the pane on its own, on load or while the swarm runs', async () => {
      const running = swarmPart({ status: 'running' })
      running.tasks = running.tasks.map((t) => ({ ...t, status: 'running', pane: null }))
      seedSwarmChat('c', running, { serp: {}, pages: {} })
      agent.messages.m2.status = 'streaming'
      pane.bindChat('c')
      expect(pane.tabs).toHaveLength(0)

      // The agents finish and name their captures: the Google page joins
      // the tabs quietly, the page capture waits for a click.
      agent.messages.m2.research = { serp: { c1: serpCapture() }, pages: { pg1: PAGE_CAPTURE } }
      agent.messages.m2.parts = [swarmPart()]
      agent.messages.m2.status = 'complete'
      await nextTick()
      expect(pane.tabs.map((t) => t.id)).toEqual(['serp:c1'])
      expect(pane.open).toBe(false)

      // A chat loaded with a finished swarm rebuilds its Google page only.
      pane.bindChat('other')
      seedSwarmChat('d')
      pane.bindChat('d')
      expect(pane.tabs.map((t) => t.id)).toEqual(['serp:c1'])
    })

    it('openCapture opens a capture that only a research agent names', () => {
      seedSwarmChat('c')
      pane.bindChat('c')
      expect(pane.openCapture('serp:c1')).toBe('serp:c1')
      expect(pane.activeTab).toMatchObject({ id: 'serp:c1', kind: 'serp', status: 'ready' })
      expect(pane.activeTab.data.results).toHaveLength(3)
      expect(pane.titleOf(pane.activeTab)).toBe('Google · best note app · p2')
      expect(pane.open).toBe(true)

      expect(pane.openCapture('page:pg1', { activate: false })).toBe('page:pg1')
      const page = pane.tabs.find((t) => t.id === 'page:pg1')
      expect(page).toMatchObject({ kind: 'page', status: 'ready', url: 'https://notely.test/', finalUrl: 'https://notely.test/' })
      expect(pane.activeId).toBe('serp:c1')

      // Again: the open tab is activated, not duplicated.
      expect(pane.openCapture('page:pg1')).toBe('page:pg1')
      expect(pane.tabs).toHaveLength(2)
      expect(pane.activeId).toBe('page:pg1')

      // Closed, it reopens from the research store.
      pane.closeTab('serp:c1')
      expect(pane.activateTab('serp:c1')).toBe('serp:c1')
      expect(pane.activeTab.data.query).toBe('best note app')
    })

    it('openCapture opens any capture in the chat research, and refuses the rest', () => {
      seedSwarmChat('c', swarmPart({ tasks: [] }), {
        serp: { c9: serpCapture({ capture_id: 'c9', query: 'notion alternatives', page: 1 }) },
        pages: {},
      })
      pane.bindChat('c')
      expect(pane.openCapture('serp:c9')).toBe('serp:c9')
      expect(pane.activeTab).toMatchObject({ kind: 'serp', status: 'ready' })
      expect(pane.titleOf(pane.activeTab)).toBe('Google · notion alternatives · p1')

      for (const id of ['serp:missing', 'page:', 'table:s1', 'artifact:a1', 'c9', '', null]) {
        expect(pane.openCapture(id)).toBe(null)
      }
      expect(pane.tabs).toHaveLength(1)
    })

    it('openCapture needs a bound chat', () => {
      seedSwarmChat('c')
      expect(pane.openCapture('serp:c1')).toBe(null)
      expect(pane.tabs).toHaveLength(0)
    })

    it('keeps restored tabs of agent captures instead of marking them gone', () => {
      localStorage.setItem(
        TABS_KEY,
        JSON.stringify({
          v: 1,
          chats: {
            c: {
              at: 1,
              state: {
                open: true,
                active: 'serp:c1',
                tabs: [
                  { id: 'serp:c1', kind: 'serp' },
                  { id: 'page:pg1', kind: 'page' },
                  { id: 'page:old', kind: 'page' },
                ],
              },
            },
          },
        })
      )
      seedSwarmChat('c')
      pane.bindChat('c')
      expect(pane.tabs.map((t) => [t.id, t.status])).toEqual([
        ['serp:c1', 'ready'],
        ['page:pg1', 'ready'],
        ['page:old', 'gone'],
      ])
      expect(pane.tabs[0].data.results).toHaveLength(3)
      expect(pane.tabs[1].url).toBe('https://notely.test/')
      expect(pane.activeId).toBe('serp:c1')
    })

    it('fills a restored agent capture tab once the task names its capture', async () => {
      localStorage.setItem(
        TABS_KEY,
        JSON.stringify({ v: 1, chats: { c: { at: 1, state: { open: false, active: 'serp:c1', tabs: [{ id: 'serp:c1', kind: 'serp' }] } } } })
      )
      const running = swarmPart({ status: 'running' })
      running.tasks = running.tasks.map((t) => ({ ...t, pane: null }))
      seedSwarmChat('c', running, { serp: { c1: serpCapture() }, pages: {} })
      agent.chatState.c = { loaded: false }
      pane.bindChat('c')
      expect(pane.tabs[0].status).toBe('missing')

      agent.messages.m2.parts = [swarmPart()]
      agent.chatState.c = { loaded: true }
      await nextTick()
      expect(pane.tabs[0]).toMatchObject({ id: 'serp:c1', status: 'ready' })
      expect(pane.tabs[0].data.query).toBe('best note app')
    })
  })

  describe('background Google pages of research agents', () => {
    // A Google page as the agent store opens it from research.recorded.
    function bg(id, index, { group = 's1:1', run = 'r1', ...data } = {}) {
      return pane.openSerp(serpSpec(id, 'ready', { results: [], ...data }), {
        activate: false,
        background: true,
        order: index === null ? null : { group, index },
        revealKey: run,
      })
    }

    const ids = () => pane.tabs.map((t) => t.id)

    // Two prompts with two Google pages each, an engine and a competitor
    // page, in task order; `named` lists the tasks that named their capture.
    function googleSwarm({ status = 'done', named = ['a1', 'a2', 'b1', 'b2', 'pg1'] } = {}) {
      const task = (id, tabId, detail) => ({
        id,
        status: named.includes(tabId.split(':')[1]) ? 'done' : 'running',
        pane: named.includes(tabId.split(':')[1]) ? { kind: tabId.split(':')[0], tab_id: tabId } : null,
        detail,
      })
      return {
        id: 'p4',
        type: 'swarm',
        swarm_id: 's1',
        version: 1,
        status,
        tasks: [
          task('google.p1.page1', 'serp:a1', { query: 'best note app', page: 1 }),
          task('google.p1.page2', 'serp:a2', { query: 'best note app', page: 2 }),
          { id: 'engines.p1.chatgpt', status: 'done', pane: null },
          task('google.p2.page1', 'serp:b1', { query: 'notion alternatives', page: 1 }),
          task('google.p2.page2', 'serp:b2', { query: 'notion alternatives', page: 2 }),
          task('competitors.p1.c1', 'page:pg1', { url: 'https://notely.test/' }),
        ],
      }
    }

    function googleResearch() {
      const capture = (id, query, page) => serpCapture({ capture_id: id, query, page })
      return {
        serp: {
          a1: capture('a1', 'best note app', 1),
          a2: capture('a2', 'best note app', 2),
          b1: capture('b1', 'notion alternatives', 1),
          b2: capture('b2', 'notion alternatives', 2),
        },
        pages: { pg1: { capture_id: 'pg1', url: 'https://notely.test/', final_url: 'https://notely.test/', seo: { title: 'Notely' } } },
      }
    }

    function seedGoogleChat(chatId, part, messageStatus = 'complete') {
      agent.messages.m1 = { id: 'm1', role: 'user', parts: [{ id: 'p0', type: 'text', text: 'Research' }] }
      agent.messages.m2 = { ...assistant('m2', [part], googleResearch()), status: messageStatus }
      agent.paths[chatId] = ['m1', 'm2']
      agent.chatState[chatId] = { loaded: true }
    }

    it('selects the run\'s first page and reveals the pane beside the chat, once', () => {
      pane.setLayout('split')
      const button = document.createElement('button')
      document.body.appendChild(button)
      button.focus()

      expect(bg('a1', 0)).toBe('serp:a1')
      expect(pane.activeId).toBe('serp:a1')
      expect(pane.open).toBe(true)
      expect(pane.attention).toBe(false)

      // Later pages join without taking the view.
      expect(bg('a2', 1)).toBe('serp:a2')
      expect(ids()).toEqual(['serp:a1', 'serp:a2'])
      expect(pane.activeId).toBe('serp:a1')
      expect(pane.activeTab.status).toBe('ready')
      expect(pane.titleOf(pane.tabs[1])).toBe('Google · qa2')
      // Focus never moves.
      expect(document.activeElement).toBe(button)
      button.remove()
    })

    it('never switches away from the active tab while the pane is open', () => {
      pane.setLayout('split')
      pane.openArtifact('42', { activate: true })
      bg('a1', 0)
      bg('a2', 1)
      expect(pane.activeId).toBe('artifact:42')
      expect(pane.open).toBe(true)
      expect(ids()).toEqual(['artifact:42', 'serp:a1', 'serp:a2'])
    })

    it('reveals a closed pane on the run\'s first page; a later page never reopens it', () => {
      pane.setLayout('split')
      pane.openArtifact('42', { activate: true })
      pane.setOpen(false)

      bg('a1', 0)
      expect(pane.open).toBe(true)
      expect(pane.activeId).toBe('serp:a1')

      // The user goes back to the artifact and closes the pane.
      pane.activateTab('artifact:42')
      pane.setOpen(false)
      bg('a2', 1)
      expect(pane.open).toBe(false)
      expect(pane.attention).toBe(false)
      expect(pane.activeId).toBe('artifact:42')

      // The next run reveals once more.
      bg('c1', 0, { run: 'r2', group: 's1:2' })
      expect(pane.open).toBe(true)
      expect(pane.activeId).toBe('serp:c1')
    })

    it('only marks the pane button where the pane would cover the chat', () => {
      pane.setLayout('overlay')
      bg('a1', 0)
      expect(pane.open).toBe(false)
      expect(pane.attention).toBe(true)
      // Nothing was active, so the page is the one the pane shows when opened.
      expect(pane.activeId).toBe('serp:a1')

      pane.setOpen(true)
      expect(pane.attention).toBe(false)
      pane.setOpen(false)
      bg('a2', 1)
      expect(pane.attention).toBe(false)
      expect(pane.activeId).toBe('serp:a1')
    })

    it('only marks the pane button on a phone before the layout is known', () => {
      const original = window.matchMedia
      window.matchMedia = (query) => ({ ...original(query), matches: true })
      try {
        bg('a1', 0)
        expect(pane.open).toBe(false)
        expect(pane.attention).toBe(true)
        expect(ids()).toEqual(['serp:a1'])
      } finally {
        window.matchMedia = original
      }
    })

    it('merges a replayed page and never reopens one the user closed', () => {
      bg('a1', 0)
      bg('a1', 0, { brand_positions: [4] })
      expect(ids()).toEqual(['serp:a1'])
      expect(pane.tabs[0].data.brand_positions).toEqual([4])

      pane.closeTab('serp:a1')
      expect(bg('a1', 0)).toBe(null)
      expect(pane.tabs).toHaveLength(0)
      // Asked for directly (a row or a link), it opens again.
      expect(pane.openSerp(serpSpec('a1', 'ready'), { activate: true })).toBe('serp:a1')
      expect(pane.activeId).toBe('serp:a1')
    })

    it('orders a swarm\'s pages by prompt, then page, whatever order they arrive in', () => {
      pane.openUrl('https://example.com/')
      bg('b1', 3)
      pane.openArtifact('42', { activate: false })
      bg('a2', 1)
      bg('b2', 4)
      bg('a1', 0)
      // A page recorded before task ids existed goes last.
      bg('x1', null)
      expect(ids()).toEqual([
        expect.stringMatching(/^url:/),
        'serp:a1',
        'serp:a2',
        'serp:b1',
        'serp:b2',
        'artifact:42',
        'serp:x1',
      ])
      expect(pane.activeTab.kind).toBe('url')
    })

    it('lines up a re-run\'s pages after the earlier run\'s', () => {
      bg('a1', 0)
      bg('a2', 1)
      bg('r2', 1, { group: 's1:2', run: 'r2' })
      bg('r1', 0, { group: 's1:2', run: 'r2' })
      expect(ids()).toEqual(['serp:a1', 'serp:a2', 'serp:r1', 'serp:r2'])
    })

    it('rebuilds the Google pages of a finished swarm on reload and opens the pane beside the chat', () => {
      pane.setLayout('split')
      seedGoogleChat('c', googleSwarm())
      pane.bindChat('c')
      expect(ids()).toEqual(['serp:a1', 'serp:a2', 'serp:b1', 'serp:b2'])
      expect(pane.tabs.every((t) => t.status === 'ready')).toBe(true)
      expect(pane.titleOf(pane.tabs[3])).toBe('Google · notion alternatives · p2')
      expect(pane.open).toBe(true)
      expect(pane.activeId).toBe('serp:b2')

      // As an overlay the pane stays closed and its button is marked.
      pane.bindChat('other')
      pane.setLayout('overlay')
      pane.bindChat('c')
      expect(ids()).toEqual(['serp:a1', 'serp:a2', 'serp:b1', 'serp:b2'])
      expect(pane.open).toBe(false)
      expect(pane.attention).toBe(true)
    })

    it('places a page recorded after a reload among the rebuilt ones', () => {
      seedGoogleChat('c', googleSwarm({ status: 'running', named: ['a1', 'b1'] }), 'streaming')
      pane.bindChat('c')
      expect(ids()).toEqual(['serp:a1', 'serp:b1'])
      bg('a2', 1)
      expect(ids()).toEqual(['serp:a1', 'serp:a2', 'serp:b1'])
    })

    it('places a page recorded after a reload among tabs restored from storage', () => {
      localStorage.setItem(
        TABS_KEY,
        JSON.stringify({
          v: 1,
          chats: { c: { at: 1, state: { open: false, active: 'serp:b1', tabs: [{ id: 'serp:a1', kind: 'serp' }, { id: 'serp:b1', kind: 'serp' }] } } },
        })
      )
      seedGoogleChat('c', googleSwarm({ status: 'running', named: ['a1', 'b1'] }), 'streaming')
      pane.bindChat('c')
      expect(ids()).toEqual(['serp:a1', 'serp:b1'])
      expect(pane.tabs[0].status).toBe('ready')
      expect(pane.open).toBe(false)
      bg('a2', 1)
      expect(ids()).toEqual(['serp:a1', 'serp:a2', 'serp:b1'])
      // The run's first page since the reload reveals the closed pane.
      expect(pane.open).toBe(true)
      expect(pane.activeId).toBe('serp:a2')
    })

    describe('re-runs', () => {
      const page = (query, n = 1, location = 'us') => ({ query, page: n, location })

      // A swarm that captured two Google pages (version 1), then a re-run
      // (version 2, a later message) that captured the same two pages again.
      function seedRerunChat(chatId) {
        const task = (id, tabId, detail) => ({ id, status: 'done', pane: { kind: 'serp', tab_id: tabId }, detail })
        const part = (version, a, b) => ({
          id: `p${version}`,
          type: 'swarm',
          swarm_id: 's1',
          version,
          status: 'done',
          tasks: [
            task('google.p1.page1', `serp:${a}`, page('best note app')),
            task('google.p2.page1', `serp:${b}`, page('notion alternatives')),
          ],
        })
        const research = (a, b) => ({
          serp: {
            [a]: serpCapture({ capture_id: a, ...page('best note app') }),
            [b]: serpCapture({ capture_id: b, ...page('notion alternatives') }),
          },
          pages: {},
        })
        agent.messages.m1 = { id: 'm1', role: 'user', parts: [{ id: 'u1', type: 'text', text: 'Research' }] }
        agent.messages.m2 = { ...assistant('m2', [part(1, 'a1', 'b1')], research('a1', 'b1')), status: 'complete' }
        agent.messages.m3 = { id: 'm3', role: 'user', parts: [{ id: 'u2', type: 'text', text: 'Re-run all 2 research agents' }] }
        agent.messages.m4 = { ...assistant('m4', [part(2, 'a2', 'b2')], research('a2', 'b2')), status: 'complete' }
        agent.paths[chatId] = ['m1', 'm2', 'm3', 'm4']
        agent.chatState[chatId] = { loaded: true }
      }

      function saveTabs(state) {
        localStorage.setItem(TABS_KEY, JSON.stringify({ v: 1, chats: { c: { at: 1, state } } }))
      }

      const serpTab = (id) => ({ id: `serp:${id}`, kind: 'serp' })

      it('names a Google page by its query, results page and location', () => {
        expect(serpPageKey(page('Best note app'))).toBe(serpPageKey({ query: ' best  note app ', page: '1', location: 'US' }))
        expect(serpPageKey(page('best note app'))).not.toBe(serpPageKey(page('best note app', 2)))
        expect(serpPageKey(page('best note app'))).not.toBe(serpPageKey(page('best note app', 1, '')))
        expect(serpPageKey({ query: 'best note app' })).toBe(serpPageKey({ query: 'best note app', page: 1, location: null }))
        expect(serpPageKey({ page: 1 })).toBe('')
        expect(serpPageKey(null)).toBe('')
      })

      it('puts a re-run\'s capture of a Google page in the earlier capture\'s tab, live', () => {
        pane.setLayout('split')
        bg('a1', 0, page('best note app'))
        bg('b1', 1, page('notion alternatives'))
        expect(pane.activeId).toBe('serp:a1')

        // The re-run's pages arrive in any order; the query is matched loosely.
        bg('b2', 1, { group: 's1:2', run: 'r2', ...page('notion alternatives') })
        bg('a2', 0, { group: 's1:2', run: 'r2', ...page(' Best  note app', 1, 'US') })
        expect(ids()).toEqual(['serp:a2', 'serp:b2'])
        expect(pane.tabs.map((t) => t.data.query)).toEqual([' Best  note app', 'notion alternatives'])
        // The active tab still shows the same page, now the newer capture.
        expect(pane.activeId).toBe('serp:a2')
        // A replayed event of an earlier capture does not bring it back.
        expect(bg('a1', 0, page('best note app'))).toBe(null)
        expect(ids()).toEqual(['serp:a2', 'serp:b2'])

        // Another results page or another country is another Google page.
        bg('c2', 2, { group: 's1:2', run: 'r2', ...page('best note app', 2) })
        bg('d2', 3, { group: 's1:2', run: 'r2', ...page('best note app', 1, 'gb') })
        expect(ids()).toEqual(['serp:a2', 'serp:b2', 'serp:c2', 'serp:d2'])
      })

      it('keeps step tabs of the same query apart from the agents\' pages', () => {
        pane.openSerp(serpSpec('s1', 'ready', page('best note app')), { activate: true })
        bg('a1', 0, page('best note app'))
        expect(ids()).toEqual(['serp:s1', 'serp:a1'])
      })

      it('marks the earlier captures of a page as superseded in the rebuilt tab specs', () => {
        seedRerunChat('c')
        const specs = researchTabs(['m1', 'm2', 'm3', 'm4'].map((id) => agent.messages[id]), { includeSwarm: true })
        const byId = Object.fromEntries(specs.map((s) => [s.id, s]))
        expect(byId['serp:a1']).toMatchObject({ auto: false, supersededBy: 'serp:a2' })
        expect(byId['serp:b1']).toMatchObject({ auto: false, supersededBy: 'serp:b2' })
        expect(byId['serp:a2']).toMatchObject({ auto: true })
        expect(byId['serp:a2'].supersededBy).toBeUndefined()
        // Without the agents' captures nothing changes.
        expect(researchTabs(['m2', 'm4'].map((id) => agent.messages[id]))).toEqual([])
      })

      it('rebuilds one tab per Google page after a re-run, the newest capture', () => {
        pane.setLayout('split')
        seedRerunChat('c')
        pane.bindChat('c')
        expect(ids()).toEqual(['serp:a2', 'serp:b2'])
        expect(pane.tabs.every((t) => t.status === 'ready')).toBe(true)

        // A click on the earlier run's task row shows that capture in the page's tab.
        expect(pane.openCapture('serp:a1')).toBe('serp:a1')
        expect(ids()).toEqual(['serp:a1', 'serp:b2'])
        expect(pane.activeId).toBe('serp:a1')
      })

      it('drops the earlier capture from a tab list saved before or during the re-run', () => {
        saveTabs({ open: true, active: 'serp:a1', tabs: ['a1', 'b1', 'a2', 'b2'].map(serpTab) })
        pane.setLayout('split')
        seedRerunChat('c')
        pane.bindChat('c')
        expect(ids()).toEqual(['serp:a2', 'serp:b2'])
        expect(pane.activeId).toBe('serp:a2')
      })

      it('replaces the earlier captures of a tab list saved before the re-run ran elsewhere', () => {
        saveTabs({ open: true, active: 'serp:b1', tabs: ['a1', 'b1'].map(serpTab) })
        pane.setLayout('split')
        seedRerunChat('c')
        pane.bindChat('c')
        expect(ids()).toEqual(['serp:a2', 'serp:b2'])
        expect(pane.activeId).toBe('serp:b2')
      })
    })
  })
})
