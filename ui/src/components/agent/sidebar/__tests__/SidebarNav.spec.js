import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const fakeAgent = reactive({ artifacts: {}, reviewsWaiting: null, artifact: (id) => fakeAgent.artifacts[id] || null })
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

// The Analytics / Agent / Settings links are the header's (components/shell).
const { default: SidebarNav } = await import('../SidebarNav.vue')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

async function setup(component, path, props) {
  setActivePinia(createPinia())
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      { path: '/agent', name: 'agent', component: Blank },
      { path: '/agent/projects', name: 'agent-projects', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: Blank },
      { path: '/projects/:websiteId/agent/context', name: 'agent-context', component: Blank },
      { path: '/projects/:websiteId/agent/agents', name: 'agent-agents', component: Blank },
      { path: '/projects/:websiteId/agent/findings', name: 'agent-findings', component: Blank },
      { path: '/projects/:websiteId/agent/reviews', name: 'agent-reviews', component: Blank },
      { path: '/projects/:websiteId/agent/reports', name: 'agent-reports', component: Blank },
      { path: '/projects/:websiteId/agent/sheets', name: 'agent-sheets', component: Blank },
      { path: '/projects/:websiteId/agent/documents', name: 'agent-documents', component: Blank },
      { path: '/projects/:websiteId/agent/artifacts/:artifactId', name: 'agent-artifact', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  return mount(component, { props, global: { plugins: [router] } })
}

beforeEach(() => {
  fakeAgent.artifacts = {}
  fakeAgent.reviewsWaiting = null
})

describe('SidebarNav', () => {
  it('lists the nine sections in order with project links', async () => {
    const w = await setup(SidebarNav, '/projects/w1/agent', { websiteId: 'w1' })
    const links = w.findAll('a.ag-nav-row')
    expect(links.map((a) => a.text())).toEqual([
      'Agent',
      'Projects',
      'Context',
      'Agents',
      'Findings',
      'Reviews',
      'Reports',
      'Sheets',
      'Documents',
    ])
    expect(links.map((a) => a.attributes('href'))).toEqual([
      '/projects/w1/agent',
      '/agent/projects',
      '/projects/w1/agent/context',
      '/projects/w1/agent/agents',
      '/projects/w1/agent/findings',
      '/projects/w1/agent/reviews',
      '/projects/w1/agent/reports',
      '/projects/w1/agent/sheets',
      '/projects/w1/agent/documents',
    ])
    expect(w.findAll('svg.ag-nav-icon')).toHaveLength(9)
  })

  it('counts the drafts waiting for your review, and hides a zero or unknown count', async () => {
    fakeAgent.reviewsWaiting = 3
    let w = await setup(SidebarNav, '/projects/w1/agent/reviews', { websiteId: 'w1' })
    const reviews = w.find('[aria-current="page"]')
    expect(reviews.find('.ag-nav-label').text()).toBe('Reviews')
    expect(reviews.find('.ag-nav-count').text()).toBe('3')
    expect(reviews.find('.ag-nav-count').attributes('aria-label')).toBe('3 waiting for your review')

    fakeAgent.reviewsWaiting = 0
    w = await setup(SidebarNav, '/projects/w1/agent', { websiteId: 'w1' })
    expect(w.find('.ag-nav-count').exists()).toBe(false)
    fakeAgent.reviewsWaiting = null
    w = await setup(SidebarNav, '/projects/w1/agent', { websiteId: 'w1' })
    expect(w.find('.ag-nav-count').exists()).toBe(false)
  })

  it('shows Findings with the flag glyph and marks it current on its page', async () => {
    const w = await setup(SidebarNav, '/projects/w1/agent/findings', { websiteId: 'w1' })
    const current = w.find('[aria-current="page"]')
    expect(current.text()).toBe('Findings')
    expect(current.classes()).toContain('is-active')
    expect(current.find('svg.ag-icon-findings').exists()).toBe(true)
    expect(w.findAll('.is-active')).toHaveLength(1)
  })

  it('marks the current section and not Agent while a chat is open', async () => {
    let w = await setup(SidebarNav, '/projects/w1/agent/reports', { websiteId: 'w1' })
    expect(w.find('[aria-current="page"]').text()).toBe('Reports')
    w = await setup(SidebarNav, '/projects/w1/agent/c/c1', { websiteId: 'w1' })
    expect(w.find('[aria-current="page"]').exists()).toBe(false)
  })

  it('highlights the list an open artifact belongs to', async () => {
    fakeAgent.artifacts = { a1: { id: 'a1', kind: 'page' } }
    const w = await setup(SidebarNav, '/projects/w1/agent/artifacts/a1', { websiteId: 'w1' })
    expect(w.find('[aria-current="page"]').text()).toBe('Documents')
  })

  it('disables project sections when there is no project', async () => {
    const w = await setup(SidebarNav, '/agent/projects', { websiteId: null })
    expect(w.findAll('a.ag-nav-row').map((a) => a.text())).toEqual(['Projects'])
    expect(w.findAll('[aria-disabled="true"]')).toHaveLength(8)
  })
})
