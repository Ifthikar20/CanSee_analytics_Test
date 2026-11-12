import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

// The keywords tab's view with the real pane store; the agent and auth stores
// are stand-ins and the API is mocked (responses keep the {success, data}
// envelope the client returns).
const { agentState, authState, agentApi } = vi.hoisted(() => ({
  agentState: { websiteId: 'w1', messages: {}, chatState: {}, swarms: {}, artifacts: {}, visiblePath: () => [] },
  authState: { user: { id: 'u1' }, session: null, accessToken: null },
  agentApi: { trackedPrompts: vi.fn(), keywordChanges: vi.fn() },
}))

vi.mock('../../../../stores/agent', () => ({ useAgentStore: () => agentState }))
vi.mock('../../../../stores/auth', () => ({ useAuthStore: () => authState }))
vi.mock('../../../../api/agent', () => ({ default: agentApi }))

const { useAgentPaneStore } = await import('../../../../stores/agentPane')
const { default: KeywordsView } = await import('../views/KeywordsView.vue')

const ok = (data) => Promise.resolve({ success: true, data })
const httpError = (status, code) =>
  Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    response: { status, data: { error: { code, message: 'Request failed' } } },
  })

function overviewPayload(overrides = {}) {
  return {
    website: { id: 'w1', name: 'Acme', url: 'https://www.acme.example' },
    serp_configured: true,
    engines: [
      { key: 'chatgpt', label: 'ChatGPT', configured: true },
      { key: 'claude', label: 'Claude', configured: true },
      { key: 'gemini', label: 'Gemini', configured: false },
    ],
    kpis: { prompts: 3 },
    prompts: [
      {
        prompt_id: 'P1',
        brand_prompt_id: 'B1',
        text: 'best crm',
        location: 'us',
        google: { status: 'ok', position: 12, depth: 100 },
        engines: {
          chatgpt: { configured: true, answers: 3, mentioned: true, rank: 2 },
          claude: { configured: true, answers: 0, mentioned: false, rank: null },
        },
        gap: { ai_score: 80, search_score: 55, value: 25, class: 'even', definite: true },
        top_action: { kind: 'get_cited', title: 'Get onto the pages AI cites' },
      },
      {
        prompt_id: 'P2',
        brand_prompt_id: 'B2',
        text: 'crm pricing',
        location: 'us',
        google: { status: 'not_checked', position: null, depth: 100 },
        engines: {
          chatgpt: { configured: true, answers: 2, mentioned: false, rank: null },
          claude: { configured: true, answers: 2, mentioned: false, rank: null },
        },
        gap: { ai_score: null, search_score: null, value: null, class: 'no_data', definite: true },
        top_action: null,
      },
      {
        prompt_id: 'P3',
        brand_prompt_id: 'B3',
        text: 'crm for startups',
        location: 'gb',
        google: { status: 'ok', position: 3, depth: 100 },
        engines: {
          chatgpt: { configured: true, answers: 1, mentioned: false, rank: null },
          claude: { configured: true, answers: 1, mentioned: true, rank: 5 },
        },
        gap: { ai_score: 20, search_score: 100, value: -80, class: 'google_ahead', definite: true },
        top_action: { kind: 'make_quotable', title: 'Make your page quotable' },
      },
    ],
    leaderboard: [
      { name: 'Globex', is_you: false, visibility_pct: 50 },
      { name: 'Acme', is_you: true, visibility_pct: 30 },
    ],
    ...overrides,
  }
}

function changesPayload(rows) {
  return {
    window_days: 90,
    counts: {},
    latest_check_at: null,
    previous_check_at: null,
    changes: rows,
    changes_total: rows.length,
  }
}

const CHANGES = [
  {
    prompt_id: 'P1',
    engine: 'chatgpt',
    label: 'ChatGPT',
    change: 'named_now',
    latest: { named: true, rank: 2 },
    previous: { named: false, rank: null },
  },
  {
    prompt_id: 'P3',
    engine: 'claude',
    label: 'Claude',
    change: 'first_check',
    latest: { named: true, rank: 5 },
    previous: null,
  },
]

let pane
let wrapper

const keywordsTab = () => pane.tabs.find((t) => t.id === 'keywords')
const rowIds = () => wrapper.findAll('tbody tr').map((tr) => tr.attributes('data-prompt-id'))
const row = (id) => wrapper.find(`tr[data-prompt-id="${id}"]`)

async function mountView() {
  wrapper = mount(KeywordsView, {
    props: { tab: keywordsTab() },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  window.localStorage.clear()
  agentState.websiteId = 'w1'
  agentState.messages = {}
  agentState.visiblePath = () => []
  setActivePinia(createPinia())
  pane = useAgentPaneStore()
  agentApi.trackedPrompts.mockReset().mockImplementation(() => ok(overviewPayload()))
  agentApi.keywordChanges.mockReset().mockImplementation(() => ok(changesPayload(CHANGES)))
  pane.bindChat('c1')
  pane.openKeywords()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('KeywordsView loading', () => {
  it('loads the overview and the changes once and keeps them on the tab', async () => {
    await mountView()
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(1)
    expect(agentApi.trackedPrompts).toHaveBeenCalledWith('w1')
    expect(agentApi.keywordChanges).toHaveBeenCalledWith('w1', { days: 90 })
    expect(rowIds()).toEqual(['P1', 'P2', 'P3'])
    expect(keywordsTab().status).toBe('ready')

    wrapper.unmount()
    await mountView()
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(1)
    expect(rowIds()).toEqual(['P1', 'P2', 'P3'])
  })

  it('fetches again when the header refreshes', async () => {
    await mountView()
    pane.updateTab('keywords', { nonce: 1 })
    await flushPromises()
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(2)
    expect(agentApi.keywordChanges).toHaveBeenCalledTimes(2)
  })

  it('drops a reply that arrives after the project changed', async () => {
    let resolve
    agentApi.trackedPrompts.mockImplementation(() => new Promise((r) => (resolve = r)))
    wrapper = mount(KeywordsView, { props: { tab: keywordsTab() }, global: { stubs: { RouterLink: RouterLinkStub } } })
    agentState.websiteId = 'w2'
    resolve({ success: true, data: overviewPayload() })
    await flushPromises()
    expect(keywordsTab().data).toBeNull()
  })

  it('keeps the rankings when the changes cannot be loaded', async () => {
    agentApi.keywordChanges.mockImplementation(() => Promise.reject(httpError(404, 'not_found')))
    await mountView()
    expect(rowIds()).toEqual(['P1', 'P2', 'P3'])
    expect(wrapper.text()).toContain('Changes are unavailable right now. Rankings are still current.')
    expect(row('P1').find('.ag-kw-dim').text()).toBe('Unavailable')
  })

  it('says a missing project is gone, without a retry', async () => {
    agentApi.trackedPrompts.mockImplementation(() => Promise.reject(httpError(404, 'not_found')))
    await mountView()
    expect(wrapper.text()).toContain('This project is no longer available.')
    expect(wrapper.find('button').exists()).toBe(false)
    expect(keywordsTab().status).toBe('error')
  })

  it('offers a retry on a failure and falls back to the keywords searched in this chat', async () => {
    agentState.messages = {
      m1: {
        id: 'm1',
        role: 'assistant',
        research: {
          serp: {
            cap1: { capture_id: 'cap1', query: 'best crm', page: 1, prompt_id: 'P1', results: [], brand_positions: [4] },
          },
        },
      },
    }
    agentState.visiblePath = () => ['m1']
    setActivePinia(createPinia())
    pane = useAgentPaneStore()
    pane.bindChat('c1')
    pane.openKeywords()
    agentApi.trackedPrompts.mockImplementation(() => Promise.reject(httpError(500, 'server_error')))
    await mountView()
    expect(wrapper.text()).toContain('Your tracked keywords could not be loaded.')
    expect(wrapper.find('#ag-kw-fallback-title').text()).toBe('Keywords searched in this chat')
    expect(wrapper.find('.ag-kw-fallback tbody tr').text()).toContain('#4')

    agentApi.trackedPrompts.mockImplementation(() => ok(overviewPayload()))
    await wrapper.findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    await flushPromises()
    expect(rowIds()).toEqual(['P1', 'P2', 'P3'])
  })

  it('invites adding keywords when none are tracked', async () => {
    agentApi.trackedPrompts.mockImplementation(() => ok(overviewPayload({ prompts: [], kpis: { prompts: 0 } })))
    await mountView()
    expect(wrapper.text()).toContain('No tracked keywords yet.')
    const link = wrapper.findComponent(RouterLinkStub)
    expect(link.props('to')).toEqual({ name: 'analytics', params: { websiteId: 'w1' }, query: { widget: 'prompts' } })
  })
})

describe('KeywordsView rows', () => {
  it('shows the configured engines and words unchecked values plainly', async () => {
    await mountView()
    expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual([
      'Keyword',
      'AI score',
      'Google',
      'ChatGPT',
      'Claude',
      'Gap',
      'Changed',
      'Top fix',
    ])
    const p1 = row('P1').findAll('td').map((td) => td.text())
    expect(p1.slice(0, 4)).toEqual(['80', '#12', 'Named #2', 'No answers'])
    expect(p1[4]).toBe('Even +25')
    expect(p1[6]).toBe('Get onto the pages AI cites')
    const p2 = row('P2').findAll('td').map((td) => td.text())
    expect(p2.slice(0, 2)).toEqual(['Not checked', 'Not checked'])
    expect(p2[4]).toBe('Not checked')
  })

  it('shows what changed, with First check for a first answer', async () => {
    await mountView()
    const named = row('P1').find('.ag-kw-change')
    expect(named.classes()).toContain('is-named-now')
    expect(named.text()).toBe('Named now: ChatGPT: not named to #2')
    expect(row('P3').find('.ag-kw-change').text()).toContain('First check')
    expect(row('P3').find('.ag-kw-change').text()).not.toContain('Dropped')
    expect(row('P2').find('.ag-kw-dim').text()).toBe('No answer in 90 days')
  })

  it('highlights a keyword with your brand and competitors, and a second click stops', async () => {
    await mountView()
    const key = row('P1').find('button.ag-kw-key')
    expect(key.attributes('aria-pressed')).toBe('false')
    await key.trigger('click')
    expect(pane.keywordHighlight).toEqual({
      keyword: 'best crm',
      brand: ['Acme', 'acme.example'],
      competitors: ['Globex'],
      sourceTabId: 'keywords',
    })
    expect(key.attributes('aria-pressed')).toBe('true')
    expect(row('P1').classes()).toContain('is-active')
    await key.trigger('click')
    expect(pane.keywordHighlight).toBeNull()
  })

  it('follows the sort and the changed-only filter from the header', async () => {
    await mountView()
    pane.updateTab('keywords', { sort: 'google' })
    await flushPromises()
    expect(rowIds()).toEqual(['P3', 'P1', 'P2'])
    expect(wrapper.find('caption').text()).toContain('sorted by Google rank')
    pane.updateTab('keywords', { changedOnly: true })
    await flushPromises()
    expect(rowIds()).toEqual(['P1'])
  })

  it('links a keyword searched in this chat to its Google results', async () => {
    agentState.messages = {
      m1: {
        id: 'm1',
        role: 'assistant',
        research: {
          serp: {
            cap1: { capture_id: 'cap1', query: 'best crm', page: 1, prompt_id: 'P1', results: [], brand_positions: [4] },
          },
        },
      },
    }
    agentState.visiblePath = () => ['m1']
    await mountView()
    const open = vi.spyOn(pane, 'openCapture').mockImplementation(() => 'serp:cap1')
    const chip = row('P1').find('button.ag-kw-chat')
    expect(chip.text()).toBe('Searched in this chat · #4')
    await chip.trigger('click')
    expect(open).toHaveBeenCalledWith('serp:cap1')
    expect(row('P2').find('button.ag-kw-chat').exists()).toBe(false)
  })
})

describe('KeywordsView review fixes', () => {
  const mountPending = () =>
    mount(KeywordsView, { props: { tab: keywordsTab() }, global: { stubs: { RouterLink: RouterLinkStub } } })

  it('under Changed only, says changes are unavailable when they failed to load', async () => {
    agentApi.keywordChanges.mockImplementation(() => Promise.reject(httpError(500, 'server_error')))
    await mountView()
    pane.updateTab('keywords', { changedOnly: true })
    await flushPromises()
    expect(rowIds()).toEqual([])
    expect(wrapper.find('.ag-kw-empty').text()).toBe(
      'What changed is unavailable right now, so no keyword can be shown as changed.'
    )
    expect(wrapper.text()).not.toContain('No keyword changed')
  })

  it('treats a reply without a change list as unavailable, not as no change', async () => {
    agentApi.keywordChanges.mockImplementation(() => ok(null))
    await mountView()
    expect(wrapper.text()).toContain('Changes are unavailable right now.')
    expect(row('P2').find('.ag-kw-dim').text()).toBe('Unavailable')
  })

  it('stops highlighting a keyword whose text has extra spaces', async () => {
    const payload = overviewPayload()
    payload.prompts[0].text = 'best  crm '
    agentApi.trackedPrompts.mockImplementation(() => ok(payload))
    await mountView()
    const key = row('P1').find('button.ag-kw-key')
    await key.trigger('click')
    expect(pane.keywordHighlight.keyword).toBe('best crm')
    expect(key.attributes('aria-pressed')).toBe('true')
    await key.trigger('click')
    expect(pane.keywordHighlight).toBeNull()
  })

  it('settles the tab when its view went to the background mid-load', async () => {
    let resolve
    agentApi.trackedPrompts.mockImplementation(() => new Promise((r) => (resolve = r)))
    wrapper = mountPending()
    wrapper.unmount()
    wrapper = null
    resolve({ success: true, data: overviewPayload() })
    await flushPromises()
    expect(keywordsTab().status).toBe('ready')
    expect(keywordsTab().data.overview.prompts).toHaveLength(3)
  })

  it('drops the reply of a tab closed and opened again; the new tab keeps its own', async () => {
    const pending = []
    agentApi.trackedPrompts.mockImplementation(() => new Promise((r) => pending.push(r)))
    wrapper = mountPending()
    wrapper.unmount()
    pane.closeTab('keywords')
    pane.openKeywords()
    wrapper = mountPending()
    expect(pending).toHaveLength(2)
    pending[0]({ success: true, data: overviewPayload({ kpis: { prompts: 99 } }) })
    await flushPromises()
    expect(keywordsTab().data).toBeNull()
    expect(keywordsTab().status).toBe('loading')
    pending[1]({ success: true, data: overviewPayload() })
    await flushPromises()
    expect(keywordsTab().data.overview.kpis.prompts).toBe(3)
    expect(rowIds()).toEqual(['P1', 'P2', 'P3'])
  })

  it('a view mounted while its tab loads waits for that load instead of fetching again', async () => {
    const pending = []
    agentApi.trackedPrompts.mockImplementation(() => new Promise((r) => pending.push(r)))
    wrapper = mountPending()
    wrapper.unmount()
    wrapper = mountPending()
    expect(pending).toHaveLength(1)
    expect(wrapper.find('.ag-kw-skeleton').exists()).toBe(true)
    pending[0]({ success: true, data: overviewPayload() })
    await flushPromises()
    expect(keywordsTab().status).toBe('ready')
    expect(rowIds()).toEqual(['P1', 'P2', 'P3'])
  })

  it('loads the new tab when a chat switch hands this view another keywords tab', async () => {
    await mountView()
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(1)
    // A chat switch: the pane drops its tabs and restores a new keywords tab.
    pane.closeTab('keywords')
    pane.openKeywords()
    await wrapper.setProps({ tab: keywordsTab() })
    await flushPromises()
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(2)
    expect(keywordsTab().status).toBe('ready')
    expect(rowIds()).toEqual(['P1', 'P2', 'P3'])
  })

  it('remembers a failed refresh on the tab, for the view that mounts next', async () => {
    await mountView()
    let reject
    agentApi.trackedPrompts.mockImplementation(() => new Promise((_, r) => (reject = r)))
    pane.updateTab('keywords', { nonce: 1 })
    await nextTick()
    expect(keywordsTab().status).toBe('loading')
    // The view goes to the background before the refresh fails.
    wrapper.unmount()
    reject(httpError(500, 'server_error'))
    await flushPromises()
    expect(keywordsTab().status).toBe('ready')
    await mountView()
    expect(wrapper.text()).toContain('The list could not be refreshed; it shows the last load.')
    expect(rowIds()).toEqual(['P1', 'P2', 'P3'])
    agentApi.trackedPrompts.mockImplementation(() => ok(overviewPayload()))
    pane.updateTab('keywords', { nonce: 2 })
    await flushPromises()
    expect(wrapper.text()).not.toContain('could not be refreshed')
  })

  it('remembers a failed first load on the tab, and Retry clears it', async () => {
    agentApi.trackedPrompts.mockImplementation(() => Promise.reject(httpError(500, 'server_error')))
    await mountView()
    expect(keywordsTab().data.loadError).toBe('error')
    // Back from another tab: the error shows again, with no new request.
    wrapper.unmount()
    await mountView()
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('Your tracked keywords could not be loaded.')
    agentApi.trackedPrompts.mockImplementation(() => new Promise(() => {}))
    await wrapper.findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    await flushPromises()
    // While the retry runs: the skeleton, not the old error.
    expect(wrapper.find('.ag-kw-skeleton').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('could not be loaded')
  })
})
