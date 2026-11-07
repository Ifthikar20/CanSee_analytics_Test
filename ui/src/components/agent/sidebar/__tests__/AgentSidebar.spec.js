import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAppStore } from '@/stores/app'

// The inbox, agent sections and recents belong to other files; these
// stand-ins say where each one renders.
const { stub } = vi.hoisted(() => ({
  stub: (cls) => async () => {
    const vue = await import('vue')
    return {
      default: vue.defineComponent({
        props: ['websiteId'],
        setup: (props) => () => vue.h('div', { class: cls, 'data-website-id': props.websiteId ?? '' }),
      }),
    }
  },
}))
vi.mock('../ActivityButton.vue', stub('stub-activity'))
vi.mock('../SidebarNav.vue', stub('stub-agent-nav'))
vi.mock('../SidebarRecents.vue', stub('stub-recents'))

const { default: AgentSidebar } = await import('../AgentSidebar.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function setup(path = '/projects/w1/agent/context', props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([
    { id: 'w1', name: 'Wrenfield' },
    { id: 'w2', name: 'Acme' },
  ])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/agent/projects',
        meta: { section: 'agent' },
        children: [{ path: '', name: 'agent-projects', component: Blank, meta: { title: 'Projects' } }],
      },
      {
        path: '/projects/:websiteId/agent',
        meta: { section: 'agent' },
        children: [
          { path: '', name: 'agent-home', component: Blank },
          { path: 'context', name: 'agent-context', component: Blank, meta: { title: 'Context' } },
        ],
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AgentSidebar, { props, global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router, ui: useAgentUiStore() }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AgentSidebar', () => {
  it('holds the sections, recent chats and a footer with the inbox and the collapse button', async () => {
    const { wrapper } = await setup()
    const nav = wrapper.find('nav.ag-sb[aria-label="Workspace"]')
    expect(nav.classes()).toContain('is-docked')
    const parts = nav.element.children
    expect([...parts].map((el) => el.className)).toEqual(['stub-agent-nav', 'stub-recents', 'ag-sb-footer'])

    const footer = wrapper.find('.ag-sb-footer')
    expect(footer.find('.stub-activity').exists()).toBe(true)
    const collapse = footer.find('button[aria-label="Collapse sidebar"]')
    expect(collapse.exists()).toBe(true)
    expect(collapse.attributes('aria-keyshortcuts')).toBe('Control+B')
    // Inbox bottom left, collapse bottom right.
    const [first, last] = footer.element.children
    expect(first.classList.contains('stub-activity')).toBe(true)
    expect(last).toBe(collapse.element)

    // What moved to the header is gone.
    expect(wrapper.find('.ag-ps-item').exists()).toBe(false)
    expect(wrapper.find('.ag-ws').exists()).toBe(false)
    expect(wrapper.find('a[aria-label="Settings"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Help"]').exists()).toBe(false)
  })

  it('scopes its parts to the project in view', async () => {
    let ctx = await setup('/projects/w2/agent')
    expect(ctx.wrapper.find('.stub-agent-nav').attributes('data-website-id')).toBe('w2')
    expect(ctx.wrapper.find('.stub-activity').attributes('data-website-id')).toBe('w2')

    ctx = await setup('/agent/projects')
    expect(ctx.wrapper.find('.stub-recents').attributes('data-website-id')).toBe('w1')
  })

  it('collapses when docked, and closes the drawer as a drawer', async () => {
    let ctx = await setup()
    ctx.ui.setDocked(true)
    await ctx.wrapper.find('button[aria-label="Collapse sidebar"]').trigger('click')
    expect(ctx.ui.sidebarCollapsed).toBe(true)

    localStorage.clear()
    ctx = await setup('/projects/w1/agent', { variant: 'drawer' })
    ctx.ui.setDocked(false)
    ctx.ui.openDrawer()
    expect(ctx.wrapper.find('nav.ag-sb').classes()).toContain('is-drawer')
    const close = ctx.wrapper.find('button[aria-label="Close sidebar"]')
    expect(close.exists()).toBe(true)
    await close.trigger('click')
    expect(ctx.ui.drawerOpen).toBe(false)
    // The docked preference is not the drawer's.
    expect(ctx.ui.sidebarCollapsed).toBe(false)
  })
})
