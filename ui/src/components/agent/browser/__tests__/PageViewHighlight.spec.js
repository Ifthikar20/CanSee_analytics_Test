import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const { agentState, authState } = vi.hoisted(() => ({
  agentState: { websiteId: 'w1', messages: {}, chatState: {}, swarms: {}, artifacts: {}, visiblePath: () => [] },
  authState: { user: { id: 'u1' }, session: null, accessToken: null },
}))

vi.mock('../../../../stores/agent', () => ({ useAgentStore: () => agentState }))
vi.mock('../../../../stores/auth', () => ({ useAuthStore: () => authState }))
// The page below already carries its reader text; nothing is fetched.
vi.mock('../../../../api/agent', () => ({ default: { browse: vi.fn(() => new Promise(() => {})) } }))

const { useAgentPaneStore } = await import('../../../../stores/agentPane')
const { default: PageView } = await import('../views/PageView.vue')

const URL = 'https://acme.example/guide'
const reader = {
  title: 'Acme guide',
  blocks: [{ type: 'paragraph', text: 'Acme and Acme again. Then Acme.' }],
  links: [],
}

let pane

function readerTab() {
  const id = pane.openUrl(URL)
  pane.updateTab(id, { status: 'ready', mode: 'reader', data: { url: URL, final_url: URL, reader } })
  return pane.tabs.find((t) => t.id === id)
}

beforeEach(() => {
  window.localStorage.clear()
  setActivePinia(createPinia())
  pane = useAgentPaneStore()
})

describe('PageView highlighting', () => {
  it('steps through keyword marks when the find bar opens after they render', async () => {
    pane.setKeywordHighlight({ keyword: 'guide', brand: ['Acme'], competitors: [] })
    const tab = readerTab()
    const wrapper = mount(PageView, { props: { tab } })
    await nextTick()
    const shown = wrapper.findAll('.ag-reader mark.ag-hl').length
    expect(shown).toBe(5)

    pane.openFind(tab.id)
    await nextTick()
    expect(pane.findOf(tab.id).count).toBe(shown)
    expect(wrapper.find('.ag-find-status').text()).toBe('1 of 5 highlights')

    pane.stepFind(tab.id, 1)
    await nextTick()
    expect(wrapper.find('mark.is-current').attributes('data-hl-index')).toBe('1')
    expect(wrapper.find('.ag-find-status').text()).toBe('2 of 5 highlights')
    wrapper.unmount()
  })

  it('counts find matches once text is typed into a newly opened bar', async () => {
    const tab = readerTab()
    pane.openFind(tab.id)
    const wrapper = mount(PageView, { props: { tab } })
    pane.setFindText(tab.id, 'acme')
    await nextTick()
    await nextTick()
    expect(pane.findOf(tab.id).count).toBe(4)
    wrapper.unmount()
  })
})
