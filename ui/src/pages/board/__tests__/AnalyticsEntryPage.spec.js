import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'

const list = vi.hoisted(() => vi.fn())
vi.mock('@/api/websites', () => ({ default: { list } }))
vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  authHeaders: () => ({}),
  refreshAccessToken: async () => '',
}))
vi.mock('@/components/onboarding/OnboardingFlow.vue', async () => {
  const vue = await import('vue')
  return { default: vue.defineComponent({ setup: () => () => vue.h('div', { class: 'stub-onboarding' }) }) }
})
vi.mock('@/components/projects/AddProjectDialog.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      props: { open: Boolean },
      setup: (props) => () => vue.h('div', { class: 'stub-add-project', 'data-open': String(props.open) }),
    }),
  }
})

const { useAppStore } = await import('@/stores/app')
const { useAuthStore } = await import('@/stores/auth')
const { setLastProject } = await import('@/lib/agent/storage')
const { default: AnalyticsEntryPage } = await import('../AnalyticsEntryPage.vue')

const Blank = defineComponent({ render: () => h('div', { class: 'stub-elsewhere' }) })
const SITES = [
  { id: 'w1', name: 'Wrenfield' },
  { id: 'w2', name: 'Acme' },
]
const mounted = []

async function setup(path = '/dashboard', { onboarding = false } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.user = { id: 7 }
  auth.session = { onboarding: { needs_onboarding: onboarding } }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: AnalyticsEntryPage, meta: { section: 'analytics', title: 'Analytics' } },
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router, auth, app: useAppStore() }
}

beforeEach(() => {
  localStorage.clear()
  list.mockReset()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AnalyticsEntryPage', () => {
  it('shows onboarding to a first-run user and asks for nothing', async () => {
    const { wrapper } = await setup('/dashboard', { onboarding: true })
    expect(wrapper.find('.stub-onboarding').exists()).toBe(true)
    expect(list).not.toHaveBeenCalled()
  })

  it('says there is no project yet and offers Add project', async () => {
    list.mockResolvedValue({ data: [] })
    const { wrapper } = await setup()
    expect(wrapper.text()).toContain('No project selected.')
    expect(wrapper.text()).toContain('Add a project to start tracking prompts.')
    const add = wrapper.findAll('button').find((b) => b.text().includes('Add project'))
    await add.trigger('click')
    expect(wrapper.find('.stub-add-project').attributes('data-open')).toBe('true')
  })

  it('opens the board of a project added here', async () => {
    list.mockResolvedValue({ data: [] })
    const { router, app } = await setup('/dashboard?widget=prompts')
    app.websites.push(SITES[1])
    app.setActiveWebsite(SITES[1])
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?widget=prompts')
  })

  it('says the projects could not load, and Try again opens the board once they do', async () => {
    list.mockRejectedValue(Object.assign(new Error('500'), { response: { status: 500 } }))
    const { wrapper, router } = await setup('/dashboard?widget=countries#map')
    expect(wrapper.text()).toContain("We couldn't load your projects.")
    expect(wrapper.text()).not.toContain('No project selected.')
    list.mockResolvedValue({ data: SITES })
    await wrapper.findAll('button').find((b) => b.text() === 'Try again').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w1/analytics?widget=countries#map')
  })

  it("opens the user's last project once the list is in", async () => {
    list.mockResolvedValue({ data: SITES })
    setLastProject(7, 'w2')
    const { router } = await setup('/dashboard?period=90d')
    expect(router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?period=90d')
  })

  it('opens the new project after onboarding, unless onboarding went somewhere else', async () => {
    const first = await setup('/dashboard', { onboarding: true })
    list.mockResolvedValue({ data: SITES })
    first.auth.session = { onboarding: { needs_onboarding: false } }
    await flushPromises()
    expect(first.router.currentRoute.value.fullPath).toBe('/projects/w1/analytics')

    mounted.pop().unmount()
    list.mockReset()
    let answer
    list.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const second = await setup('/dashboard', { onboarding: true })
    second.auth.session = { onboarding: { needs_onboarding: false } }
    // The flow opens the first research chat itself.
    await second.router.push({ name: 'agent-home', params: { websiteId: 'w2' }, query: { start: 'first-research' } })
    answer({ data: SITES })
    await flushPromises()
    expect(second.router.currentRoute.value.name).toBe('agent-home')
  })
})
