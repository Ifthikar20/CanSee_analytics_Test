import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const { agentState, authState } = vi.hoisted(() => ({
  agentState: { websiteId: 'w1', messages: {}, chatState: {}, swarms: {}, artifacts: {}, visiblePath: () => [] },
  authState: { user: { id: 'u1' }, session: null, accessToken: null },
}))

vi.mock('../../../../stores/agent', () => ({ useAgentStore: () => agentState }))
vi.mock('../../../../stores/auth', () => ({ useAuthStore: () => authState }))

const { useAgentPaneStore } = await import('../../../../stores/agentPane')
const { default: SerpView } = await import('../views/SerpView.vue')

const tab = {
  id: 'serp:s1',
  kind: 'serp',
  status: 'ready',
  data: {
    query: 'best crm software',
    page: 1,
    brand: { name: 'Acme', domain: 'acme.example' },
    brand_positions: [1],
    results: [
      { position: 1, url: 'https://acme.example/', domain: 'acme.example', title: 'Acme CRM software', snippet: 'Acme is the CRM teams pick.', is_yours: true },
      { position: 2, url: 'https://globex.example/', domain: 'globex.example', title: 'Globex review', snippet: 'Globex versus Acme compared.', is_competitor: true, competitor_name: 'Globex' },
    ],
    people_also_ask: ['Is Acme better than Globex?'],
  },
}

let pane

beforeEach(() => {
  window.localStorage.clear()
  setActivePinia(createPinia())
  pane = useAgentPaneStore()
})

describe('SerpView highlighting', () => {
  it('renders no marks without a keyword highlight', () => {
    const wrapper = mount(SerpView, { props: { tab } })
    expect(wrapper.findAll('mark')).toHaveLength(0)
  })

  it('marks titles, snippets and People also ask with the pane keyword', async () => {
    pane.setKeywordHighlight({ keyword: 'best crm software', brand: ['Acme'], competitors: ['Globex'] })
    const wrapper = mount(SerpView, { props: { tab } })
    const titles = wrapper.findAll('.ag-serp-title mark')
    expect(titles.map((m) => m.classes().find((c) => c.startsWith('is-')))).toEqual([
      'is-brand',
      'is-keyword',
      'is-keyword',
      'is-competitor',
    ])
    expect(wrapper.findAll('.ag-serp-snippet mark.is-brand')).toHaveLength(2)
    expect(wrapper.findAll('.ag-serp-paa-list mark')).toHaveLength(2)
    // The query stays a plain read-only input.
    expect(wrapper.find('input.ag-serp-query').element.value).toBe('best crm software')
  })

  it('keeps the screen-reader position prefix on titles', () => {
    pane.setKeywordHighlight({ keyword: 'crm', brand: ['Acme'] })
    const wrapper = mount(SerpView, { props: { tab } })
    const title = wrapper.find('.ag-serp-title')
    expect(title.find('.ag-sr-only').text()).toBe('Position 1:')
    expect(title.text().replace('Brand: ', '')).toBe('Position 1: Acme CRM software')
  })
})
