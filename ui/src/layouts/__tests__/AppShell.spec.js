import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, onMounted, reactive, ref } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import shellSource from '../AppShell.vue?raw'

const fakeAgent = reactive({})
const fakePane = reactive({ toggleOpen: vi.fn() })
const bootstrap = vi.fn()

// The header logo is a public asset; outside a dev server the SFC compiler
// turns its absolute URL into an import, which the test resolver can't find.
vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => fakePane }))
vi.mock('@/composables/useShellBootstrap', () => ({ useShellBootstrap: () => bootstrap() }))

const { default: AppShell } = await import('../AppShell.vue')

const Page = defineComponent({ render: () => h('div', { class: 'test-page' }, 'page') })
// Pages that count their mounts; one has an anchor.
const mounts = { page: 0, board: 0, chat: 0 }
const CountedPage = defineComponent({
  setup() {
    mounts.page += 1
    return () => h('div', { class: 'test-page', id: 'anchor-target' }, 'counted')
  },
})
const Board = defineComponent({
  setup() {
    mounts.board += 1
    return () => h('div', { class: 'test-board' }, 'board')
  },
})
// The new-chat and chat routes share one component, as in agentRoutes.js.
const ChatPage = defineComponent({
  setup() {
    mounts.chat += 1
    return () => h('div', { class: 'test-page test-chat' }, 'chat')
  },
})
// A page that puts focus inside itself on mount.
const FocusingPage = defineComponent({
  setup() {
    const input = ref(null)
    onMounted(() => input.value?.focus())
    return () => h('div', { class: 'test-page' }, [h('input', { ref: input, class: 'test-focus', 'aria-label': 'Name' })])
  },
})

const mounted = []
let wide = true
const realMatchMedia = window.matchMedia

// The app's shape: AppShell parents carry meta.section, children a title.
function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/docs', name: 'docs', component: Page },
      { path: '/support', name: 'support', component: Page },
      { path: '/login', name: 'login', component: Page },
      { path: '/agent', name: 'agent', component: Page },
      {
        path: '/dashboard',
        component: AppShell,
        meta: { section: 'analytics' },
        children: [{ path: '', name: 'dashboard', component: Page, meta: { title: 'Analytics' } }],
      },
      {
        path: '/projects/:websiteId',
        component: AppShell,
        meta: { section: 'analytics' },
        children: [{ path: 'analytics', name: 'analytics', component: Board }],
      },
      {
        path: '/settings',
        component: AppShell,
        meta: { section: 'settings' },
        children: [
          { path: '', name: 'settings', component: CountedPage, meta: { title: 'Settings' } },
          { path: 'project', name: 'settings-project', component: FocusingPage, meta: { title: 'Project settings' } },
          {
            path: 'usage-dashboard',
            name: 'settings-command-center',
            component: CountedPage,
            meta: { title: 'Usage dashboard' },
          },
        ],
      },
      {
        path: '/billing',
        component: AppShell,
        meta: { section: 'settings' },
        children: [{ path: '', name: 'billing', component: Page, meta: { title: 'Billing' } }],
      },
      {
        path: '/agent/projects',
        component: AppShell,
        meta: { section: 'agent' },
        children: [{ path: '', name: 'agent-projects', component: Page, meta: { title: 'Projects' } }],
      },
      {
        path: '/projects/:websiteId/agent',
        component: AppShell,
        meta: { section: 'agent' },
        children: [
          { path: '', name: 'agent-home', component: ChatPage },
          { path: 'c/:chatId', name: 'agent-chat', component: ChatPage },
          { path: 'context', name: 'agent-context', component: Page, meta: { title: 'Context' } },
          { path: 'agents', name: 'agent-agents', component: Page, meta: { title: 'Agents' } },
          { path: 'findings', name: 'agent-findings', component: Page, meta: { title: 'Findings' } },
          { path: 'reviews', name: 'agent-reviews', component: Page, meta: { title: 'Reviews' } },
          { path: 'reports', name: 'agent-reports', component: Page, meta: { title: 'Reports' } },
          { path: 'documents', name: 'agent-documents', component: Page, meta: { title: 'Documents' } },
          { path: 'sheets', name: 'agent-sheets', component: Page, meta: { title: 'Sheets' } },
          { path: 'artifacts/:artifactId', name: 'agent-artifact', component: Page },
        ],
      },
    ],
  })
  // As the app's router does: the URL's project becomes active.
  router.afterEach((to, _from, failure) => {
    if (failure || !to.params.websiteId) return
    const app = useAppStore()
    const site = app.websites.find((w) => String(w.id) === String(to.params.websiteId))
    if (site) app.setActiveWebsite(site)
  })
  return router
}

async function setup(path = '/projects/w1/agent') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([
    { id: 'w1', name: 'Wrenfield' },
    { id: 'w2', name: 'Acme' },
  ])
  useAuthStore().user = { id: 7, full_name: 'Farah Chen', email: 'farah@wrenfield.test' }
  const router = makeRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router, ui: useAgentUiStore() }
}

async function go(router, to) {
  await router.push(to)
  await flushPromises()
}

const current = (wrapper) => wrapper.findAll('.shell-nav [aria-current="page"]').map((a) => a.text())

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  wide = true
  mounts.page = 0
  mounts.board = 0
  mounts.chat = 0
  bootstrap.mockClear()
  window.matchMedia = (query) => ({
    matches: query === '(min-width: 1024px)' || query === '(min-width: 901px)' ? wide : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })
  Object.assign(fakeAgent, {
    websiteId: null,
    chats: { loading: false, loaded: true, hasMore: false, search: '', error: null },
    recents: [],
    runs: {},
    messages: {},
    activity: [],
    catalog: [],
    init: vi.fn((wid) => {
      fakeAgent.websiteId = wid
      return Promise.resolve()
    }),
    loadChats: vi.fn(async () => {}),
    loadActivity: vi.fn(async () => []),
    isChatBusy: () => false,
  })
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  window.matchMedia = realMatchMedia
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
})

describe('AppShell header', () => {
  it('keeps the header over the board, an agent page and Settings, in one shell', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics')
    const frame = wrapper.find('.ag-root.app-frame')
    // The skip link, the header, then the body.
    expect([...frame.element.children].slice(0, 3).map((el) => el.tagName)).toEqual(['A', 'HEADER', 'MAIN'])
    expect(wrapper.findAll('.shell-nav a').map((a) => a.text())).toEqual(['Analytics', 'Agent', 'Settings'])
    expect(wrapper.find('button.shell-chip').attributes('aria-label')).toBe('Project: Wrenfield')
    expect(wrapper.find('.shell-rule').exists()).toBe(true)

    await go(router, '/projects/w2/agent/reports')
    expect(wrapper.find('header.shell-bar').exists()).toBe(true)
    expect(wrapper.find('button.shell-chip').attributes('aria-label')).toBe('Project: Acme')
    expect(wrapper.findAll('.shell-nav a').map((a) => a.attributes('href'))).toEqual([
      '/projects/w2/analytics',
      '/projects/w2/agent',
      '/settings',
    ])

    await go(router, '/settings')
    expect(wrapper.find('header.shell-bar').exists()).toBe(true)
    // One shell across all three.
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[aria-live="polite"]').exists()).toBe(true)
    expect(wrapper.find('[aria-live="assertive"]').exists()).toBe(true)
  })

  it('marks exactly one current section', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics')
    const cases = [
      ['/projects/w1/analytics', 'Analytics'],
      ['/projects/w1/analytics?widget=countries', 'Analytics'],
      ['/dashboard', 'Analytics'],
      ['/projects/w1/agent/reports', 'Agent'],
      ['/agent/projects', 'Agent'],
      ['/settings', 'Settings'],
      ['/settings/usage-dashboard', 'Settings'],
      ['/billing', 'Settings'],
    ]
    for (const [path, label] of cases) {
      await go(router, path)
      expect(current(wrapper), path).toEqual([label])
    }
  })
})

describe('AppShell body', () => {
  it('gives agent routes the workspace, and the board and Settings a full-width main', async () => {
    const { wrapper, router, ui } = await setup('/projects/w1/agent/reports')
    expect(wrapper.find('.ag-shell').classes()).toContain('is-docked')
    expect(wrapper.find('nav[aria-label="Workspace"]').exists()).toBe(true)
    expect(wrapper.find('main#ag-main .test-page').exists()).toBe(true)
    expect(wrapper.find('#app-main').exists()).toBe(false)
    expect(ui.sidebarAvailable).toBe(true)

    await go(router, '/projects/w1/analytics')
    expect(wrapper.find('main#app-main > .test-board').exists()).toBe(true)
    expect(wrapper.find('main#app-main').attributes('tabindex')).toBe('-1')
    expect(wrapper.find('nav[aria-label="Workspace"]').exists()).toBe(false)
    expect(wrapper.find('.ag-shell').exists()).toBe(false)
    expect(wrapper.findAll('main')).toHaveLength(1)
    expect(ui.sidebarAvailable).toBe(false)
    // No sidebar, so no page header offers one, collapsed or narrow.
    ui.setSidebarCollapsed(true)
    expect(ui.showSidebarToggle).toBe(false)
    ui.setDocked(false)
    expect(ui.showSidebarToggle).toBe(false)
    ui.setDocked(true)

    await go(router, '/settings')
    expect(wrapper.find('main#app-main > .test-page').exists()).toBe(true)
    expect(wrapper.find('nav[aria-label="Workspace"]').exists()).toBe(false)

    await go(router, '/projects/w1/agent')
    expect(ui.sidebarAvailable).toBe(true)
    expect(ui.showSidebarToggle).toBe(true)
    expect(wrapper.find('.ag-shell').classes()).toContain('is-collapsed')
  })

  it('keeps the chat page alive from the new-chat view to its chat', async () => {
    const { wrapper, router } = await setup('/projects/w1/agent')
    expect(mounts.chat).toBe(1)
    await go(router, '/projects/w1/agent/c/c1')
    expect(wrapper.find('main#ag-main > .test-chat').exists()).toBe(true)
    expect(mounts.chat).toBe(1)
  })

  it('mounts a page again at another address, and keeps it for a query change', async () => {
    const { router } = await setup('/settings')
    expect(mounts.page).toBe(1)
    await go(router, { path: '/settings', query: { section: 'usage' } })
    expect(mounts.page).toBe(1)
    await go(router, '/settings/usage-dashboard')
    expect(mounts.page).toBe(2)

    // The board too: a panel opens in the same board; another project's is new.
    await go(router, '/projects/w1/analytics')
    await go(router, '/projects/w1/analytics?widget=countries')
    expect(mounts.board).toBe(1)
    await go(router, '/projects/w2/analytics')
    expect(mounts.board).toBe(2)
  })

  it('starts a new page at the top of main and keeps the place for a query change', async () => {
    const { wrapper, router } = await setup('/settings')
    const main = wrapper.find('main#app-main').element
    main.scrollTop = 240
    await go(router, { path: '/settings', query: { tab: 'usage' } })
    expect(main.scrollTop).toBe(240)
    await go(router, '/settings/usage-dashboard')
    expect(main.scrollTop).toBe(0)

    await go(router, '/projects/w1/analytics')
    main.scrollTop = 300
    await go(router, '/projects/w1/analytics?widget=countries')
    expect(main.scrollTop).toBe(300)
  })

  it('scrolls a hash target into view inside main', async () => {
    const { router } = await setup('/settings')
    const original = HTMLElement.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    try {
      await go(router, '/settings/usage-dashboard#anchor-target')
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoView.mock.contexts[0].id).toBe('anchor-target')
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('moves focus into main on a new address only, and leaves a page that took focus alone', async () => {
    const { wrapper, router } = await setup('/settings')
    const main = () => wrapper.find('main#app-main').element
    // The first page load does not move focus.
    expect(document.activeElement).not.toBe(main())

    await go(router, '/settings/usage-dashboard')
    expect(document.activeElement).toBe(main())

    const link = wrapper.find('.shell-nav a').element
    link.focus()
    await go(router, { path: '/settings/usage-dashboard', query: { tab: 'x' } })
    expect(document.activeElement).toBe(link)

    await go(router, '/settings/project')
    expect(document.activeElement.classList.contains('test-focus')).toBe(true)

    // Agent routes never move focus (the chat handles its composer).
    link.focus()
    await go(router, '/projects/w1/agent/reports')
    expect(document.activeElement).toBe(link)
    await go(router, '/projects/w1/agent/context')
    expect(document.activeElement).toBe(link)
  })

  it('skips to the main region of the current layout', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics')
    const skip = wrapper.find('a.app-skip')
    expect(skip.text()).toBe('Skip to content')
    expect(wrapper.find('.app-frame').element.firstElementChild).toBe(skip.element)
    expect(skip.attributes('href')).toBe('#app-main')
    await skip.trigger('click')
    expect(document.activeElement).toBe(wrapper.find('#app-main').element)

    await go(router, '/projects/w1/agent/reports')
    expect(skip.attributes('href')).toBe('#ag-main')
    await skip.trigger('click')
    expect(document.activeElement).toBe(wrapper.find('#ag-main').element)
  })

  it('keeps the agent area under the header and its menu sheet', () => {
    // The browser pane's overlay is z 30, the bar's own level: in the agent
    // area's own stacking context it cannot paint over the sheet.
    expect(shellSource).toMatch(/\n\.ag-shell \{\n {2}isolation: isolate;\n/)
  })

  it("gives Settings and Billing the main app's look, but not the board", async () => {
    const { wrapper, router } = await setup('/settings')
    expect(wrapper.find('#app-main').classes()).toContain('is-settings')
    await go(router, '/billing')
    expect(wrapper.find('#app-main').classes()).toContain('is-settings')
    await go(router, '/projects/w1/analytics')
    expect(wrapper.find('#app-main').classes()).not.toContain('is-settings')
    await go(router, '/dashboard')
    expect(wrapper.find('#app-main').classes()).not.toContain('is-settings')
  })
})

describe('AppShell state', () => {
  it('locks the document scroll while mounted', async () => {
    const { wrapper } = await setup()
    expect(document.body.style.overflow).toBe('hidden')
    mounted.splice(mounted.indexOf(wrapper), 1)
    wrapper.unmount()
    expect(document.body.style.overflow).toBe('')
  })

  it('re-scopes the store to the project in view, from any section', async () => {
    const { router } = await setup()
    expect(fakeAgent.init).toHaveBeenCalledWith('w1')
    await go(router, '/projects/w2/agent/reports')
    expect(fakeAgent.init).toHaveBeenLastCalledWith('w2')
    await go(router, '/projects/w1/analytics')
    expect(fakeAgent.init).toHaveBeenLastCalledWith('w1')
  })

  it('uses the active project on the projects page', async () => {
    await setup('/agent/projects')
    expect(fakeAgent.init).toHaveBeenCalledWith('w1')
  })

  it('collapses the docked sidebar out of the tab order', async () => {
    const { wrapper, ui } = await setup()
    ui.toggleSidebar()
    await nextTick()
    const rail = wrapper.find('.ag-shell-rail')
    expect(wrapper.find('.ag-shell').classes()).toContain('is-collapsed')
    // Browsers take the inert property; jsdom has no such property, so Vue writes the attribute.
    expect(rail.element.inert === true || rail.element.hasAttribute('inert')).toBe(true)
    expect(rail.attributes('aria-hidden')).toBe('true')
    ui.toggleSidebar()
    await nextTick()
    expect(rail.element.inert === true || rail.element.hasAttribute('inert')).toBe(false)
  })

  it('puts the sidebar in a drawer below 1024px, on agent routes only, and closes it on navigation', async () => {
    wide = false
    const { wrapper, ui, router } = await setup()
    expect(wrapper.find('.ag-shell').classes()).not.toContain('is-docked')
    expect(wrapper.find('.ag-shell-rail').exists()).toBe(false)
    expect(ui.docked).toBe(false)
    ui.openDrawer()
    await flushPromises()
    const drawer = document.body.querySelector('.ag-portal.ag-drawer')
    expect(drawer).not.toBeNull()
    expect(drawer.querySelector('nav[aria-label="Workspace"]')).not.toBeNull()
    await go(router, '/projects/w1/agent/context')
    expect(ui.drawerOpen).toBe(false)

    await go(router, '/projects/w1/analytics')
    ui.toggleSidebar()
    await flushPromises()
    expect(ui.drawerOpen).toBe(false)
    expect(document.body.querySelector('.ag-portal.ag-drawer')).toBeNull()
  })

  it('opens the shortcuts dialog from the store', async () => {
    const { ui } = await setup()
    ui.openShortcuts()
    await flushPromises()
    const dialog = document.body.querySelector('.ag-portal.ag-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Keyboard shortcuts')
    expect(dialog.textContent).toContain('New chat')
  })

  it('gives focus back to the menu button when the shortcuts, opened from the sheet, close', async () => {
    const { wrapper, ui } = await setup('/projects/w1/agent')
    const burger = wrapper.find('button.shell-burger')
    await burger.trigger('click')
    const row = wrapper.findAll('#shell-sheet button').find((b) => b.text() === 'Keyboard shortcuts')
    row.element.focus()
    await row.trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('.ag-portal.ag-dialog')
    expect(dialog).not.toBeNull()

    dialog.querySelector('button[aria-label="Close"]').click()
    await flushPromises()
    expect(ui.shortcutsOpen).toBe(false)
    // Not the hidden row, which would leave focus on <body>.
    await vi.waitFor(() => expect(document.activeElement).toBe(burger.element))
  })

  it('opens the agent with chat search on Ctrl+K from the board', async () => {
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true })
    const { router, ui } = await setup('/projects/w1/analytics')
    expect(ui.sidebarAvailable).toBe(false)
    const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w1/agent')
    // After the frame offers the sidebar again; before that the search does nothing.
    expect(ui.sidebarAvailable).toBe(true)
    expect(ui.filterOpen).toBe(true)
    expect(ui.searchRequest).toBe(1)
  })

  it('titles the tab from route meta, and leaves the board to title itself', async () => {
    const { router } = await setup('/settings')
    expect(document.title).toBe('Settings — Cansee')
    await go(router, '/projects/w2/agent/context')
    expect(document.title).toBe('Context — Acme — Cansee')
    document.title = 'Analytics — Acme — Cansee'
    await go(router, '/projects/w2/analytics')
    expect(document.title).toBe('Analytics — Acme — Cansee')
    await go(router, '/dashboard')
    expect(document.title).toBe('Analytics — Cansee')
  })
})
