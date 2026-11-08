import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// The keywords tab's header (sort, changed only, refresh, the count line) and
// the New tab entry that opens it, with the real pane store.
const { agentState, authState, appState, agentApi } = vi.hoisted(() => ({
  agentState: { websiteId: 'w1', messages: {}, chatState: {}, swarms: {}, artifacts: {}, visiblePath: () => [] },
  authState: { user: { id: 'u1' }, session: null, accessToken: null },
  appState: { websites: [], activeWebsite: null },
  agentApi: { trackedPrompts: vi.fn(), keywordChanges: vi.fn(), browse: vi.fn() },
}))

vi.mock('../../../../stores/agent', () => ({ useAgentStore: () => agentState }))
vi.mock('../../../../stores/auth', () => ({ useAuthStore: () => authState }))
vi.mock('../../../../stores/app', () => ({ useAppStore: () => appState }))
vi.mock('../../../../api/agent', () => ({ default: agentApi }))

const { useAgentPaneStore } = await import('../../../../stores/agentPane')
const { default: PaneHeader } = await import('../PaneHeader.vue')
const { default: NewTabView } = await import('../views/NewTabView.vue')

let pane
let wrapper

const keywordsTab = () => pane.tabs.find((t) => t.id === 'keywords')

function mountHeader() {
  wrapper = mount(PaneHeader, { props: { tab: keywordsTab() }, attachTo: document.body })
  return wrapper
}

beforeEach(() => {
  window.localStorage.clear()
  agentState.websiteId = 'w1'
  setActivePinia(createPinia())
  pane = useAgentPaneStore()
  pane.bindChat('c1')
  pane.openKeywords()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('keywords header', () => {
  it('names the tab and counts the tracked keywords once they load', async () => {
    mountHeader()
    expect(wrapper.find('.ag-ph-title-text').text()).toBe('Keywords')
    expect(wrapper.find('.ag-ph-sub').exists()).toBe(false)
    pane.updateTab('keywords', {
      status: 'ready',
      data: { overview: { kpis: { prompts: 12 } }, changes: { window_days: 90 } },
    })
    await flushPromises()
    expect(wrapper.find('.ag-ph-sub').text()).toBe('12 tracked · changes over 90 days')
  })

  it('toggles changed only on the tab', async () => {
    mountHeader()
    const toggle = wrapper.find('button.ag-ph-toggle')
    expect(toggle.attributes('aria-pressed')).toBe('false')
    await toggle.trigger('click')
    expect(keywordsTab().changedOnly).toBe(true)
    expect(toggle.attributes('aria-pressed')).toBe('true')
  })

  it('refreshes by bumping the nonce, and not while loading', async () => {
    mountHeader()
    const refresh = wrapper.findAll('button').find((b) => b.attributes('aria-label') === 'Refresh')
    await refresh.trigger('click')
    expect(keywordsTab().nonce).toBe(1)
    pane.updateTab('keywords', { status: 'loading' })
    await flushPromises()
    expect(refresh.attributes('disabled')).toBeDefined()
  })

  it('sets the sort from its menu', async () => {
    mountHeader()
    const trigger = wrapper.find('button.ag-ph-ver')
    expect(trigger.attributes('aria-label')).toBe('Sorted by Biggest gap. Change the sort')
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const items = [...document.body.querySelectorAll('.ag-portal.ag-menu [role="menuitem"]')]
    expect(items.map((el) => el.textContent.trim())).toEqual(['Biggest gap', 'Google rank', 'AI score', 'Recently changed'])
    items[1].click()
    await flushPromises()
    expect(keywordsTab().sort).toBe('google')
    expect(wrapper.find('button.ag-ph-ver').text()).toContain('Google rank')
  })
})

describe('New tab entry', () => {
  it('opens the keywords tab in place of the blank tab', async () => {
    pane.closeTab('keywords')
    pane.openNewTab()
    const blank = pane.activeTab
    wrapper = mount(NewTabView, { props: { tab: blank } })
    const entry = wrapper.findAll('button.ag-newtab-site').find((b) => b.text().includes('Tracked keywords'))
    await entry.trigger('click')
    expect(pane.activeTab.id).toBe('keywords')
    expect(pane.tabs.map((t) => t.id)).toEqual(['keywords'])
  })

  it('is not offered without a project', () => {
    agentState.websiteId = null
    pane.closeTab('keywords')
    pane.openNewTab()
    wrapper = mount(NewTabView, { props: { tab: pane.activeTab } })
    expect(wrapper.text()).not.toContain('Tracked keywords')
  })
})
