import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAgentUiStore } from '@/stores/agentUi'
import ActivityPopover from '../ActivityPopover.vue'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

const { default: ActivityButton } = await import('../ActivityButton.vue')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: Blank },
      { path: '/projects/:websiteId/agent/artifacts/:artifactId', name: 'agent-artifact', component: Blank },
    ],
  })
}

async function mountWith(component, props) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = makeRouter()
  await router.push('/projects/w1/agent')
  await router.isReady()
  const wrapper = mount(component, { props, global: { plugins: [pinia, router] }, attachTo: document.body })
  return { wrapper, ui: useAgentUiStore() }
}

const ACTIVITY = [
  { type: 'run_completed', at: '2026-11-02T10:00:00Z', chat_id: 'c1', title: 'Pricing research' },
  { type: 'artifact_version', at: '2026-11-02T11:00:00Z', chat_id: 'c1', title: 'Battery page', artifact_id: 'a1', kind: 'page', version: 2 },
]

beforeEach(() => {
  localStorage.clear()
  Object.assign(fakeAgent, {
    websiteId: 'w1',
    activity: [],
    loadActivity: vi.fn(async () => {
      fakeAgent.activity = []
      return []
    }),
  })
})

describe('ActivityPopover', () => {
  it('has a real empty state', async () => {
    const { wrapper } = await mountWith(ActivityPopover, { items: [], websiteId: 'w1' })
    expect(wrapper.text()).toContain('Nothing new yet.')
    expect(wrapper.text()).toContain('Finished agent runs, new drafts and review requests in this project show up here.')
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it.each([
    ['review_requested', { version: 3 }, 'Sam asked you to review · v3'],
    ['review_approved', { version: 3, excerpt: 'Ship it' }, 'Sam approved it · v3'],
    ['review_changes_requested', { version: 2, excerpt: 'Fix the price' }, 'Sam asked for changes · v2'],
    ['review_comment', { version: 2, excerpt: 'One typo in the FAQ' }, 'Sam commented: One typo in the FAQ'],
  ])('shows a %s item with its icon and a link to the draft', async (type, extra, meta) => {
    const item = { type, at: '2026-11-02T12:00:00Z', artifact_id: 'a7', title: 'Pricing page', kind: 'document', actor_name: 'Sam', ...extra }
    const { wrapper } = await mountWith(ActivityPopover, { items: [item], websiteId: 'w1' })
    const link = wrapper.find('a.ag-act-item')
    expect(link.find('.ag-act-item-title').text()).toBe('Pricing page')
    expect(link.find('.ag-act-meta').text()).toContain(meta)
    expect(link.attributes('href')).toBe('/projects/w1/agent/artifacts/a7')
    expect(link.find('.ag-act-icon svg').exists()).toBe(true)
  })

  it('lists runs and artifact versions with links into the project', async () => {
    const { wrapper } = await mountWith(ActivityPopover, { items: ACTIVITY, websiteId: 'w1' })
    const links = wrapper.findAll('a.ag-act-item')
    expect(links).toHaveLength(2)
    expect(links[0].text()).toContain('Pricing research')
    expect(links[0].text()).toContain('Agent finished')
    expect(links[0].attributes('href')).toBe('/projects/w1/agent/c/c1')
    expect(links[1].text()).toContain('Landing page v2')
    expect(links[1].attributes('href')).toBe('/projects/w1/agent/artifacts/a1')
    await links[0].trigger('click')
    expect(wrapper.emitted('navigate')).toHaveLength(1)
  })

  it('shows loading and errors with a retry', async () => {
    const { wrapper } = await mountWith(ActivityPopover, { items: [], websiteId: 'w1', loading: true })
    expect(wrapper.text()).toContain('Loading activity')
    await wrapper.setProps({ loading: false, error: "Couldn't load activity." })
    expect(wrapper.text()).toContain("Couldn't load activity.")
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})

describe('ActivityButton', () => {
  it('loads activity when opened and shows the empty state', async () => {
    const { wrapper } = await mountWith(ActivityButton, { websiteId: 'w1' })
    const button = wrapper.find('button')
    expect(button.attributes('aria-label')).toBe('Activity')
    await button.trigger('click')
    await flushPromises()
    expect(fakeAgent.loadActivity).toHaveBeenCalled()
    expect(document.body.querySelector('.ag-portal.ag-popover').textContent).toContain('Nothing new yet.')
  })

  it('refreshes the review count with the quiet prefetch', async () => {
    vi.useFakeTimers()
    fakeAgent.loadActivity = vi.fn(async () => [])
    await mountWith(ActivityButton, { websiteId: 'w1' })
    expect(fakeAgent.loadActivity).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    vi.useRealTimers()
    await flushPromises()
    // The store's loadActivity also reads GET reviews/?box=waiting (agent store spec).
    expect(fakeAgent.loadActivity).toHaveBeenCalledTimes(1)
  })

  it('marks new items until the inbox is opened', async () => {
    vi.useFakeTimers()
    fakeAgent.activity = ACTIVITY
    fakeAgent.loadActivity = vi.fn(async () => ACTIVITY)
    const { wrapper, ui } = await mountWith(ActivityButton, { websiteId: 'w1' })
    expect(wrapper.find('.ag-act-dot').exists()).toBe(true)
    expect(wrapper.find('button').attributes('aria-label')).toBe('Activity, new items')
    vi.useRealTimers()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(ui.activitySeenAtFor('w1')).toBe('2026-11-02T11:00:00Z')
    expect(wrapper.find('.ag-act-dot').exists()).toBe(false)
  })
})
