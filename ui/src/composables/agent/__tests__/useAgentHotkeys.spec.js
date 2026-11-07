import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAppStore } from '@/stores/app'

const fakeAgent = reactive({ busy: {}, stop: vi.fn(), isChatBusy: (id) => Boolean(fakeAgent.busy[id]) })
const fakePane = reactive({ open: false, toggleOpen: vi.fn(() => (fakePane.open = !fakePane.open)) })

vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => fakePane }))

const { matchShortcut, useAgentHotkeys } = await import('../useAgentHotkeys')

const Blank = defineComponent({ render: () => h('div') })

// As in the app: AppShell's parents carry the section, children their title.
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'root', component: Blank },
      { path: '/agent', name: 'agent', component: Blank, meta: { section: 'agent' } },
      {
        path: '/projects/:websiteId/agent',
        meta: { section: 'agent' },
        children: [
          { path: '', name: 'agent-home', component: Blank },
          { path: 'c/:chatId', name: 'agent-chat', component: Blank },
          { path: 'context', name: 'agent-context', component: Blank, meta: { title: 'Context' } },
        ],
      },
      {
        path: '/projects/:websiteId',
        meta: { section: 'analytics' },
        children: [{ path: 'analytics', name: 'analytics', component: Blank }],
      },
      {
        path: '/settings',
        meta: { section: 'settings' },
        children: [{ path: '', name: 'settings', component: Blank, meta: { title: 'Settings' } }],
      },
    ],
  })
}

async function setup(path, { sites = [] } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites(sites)
  const router = makeRouter()
  await router.push(path)
  await router.isReady()
  const Host = defineComponent({
    setup() {
      useAgentHotkeys()
      return () => h('div')
    },
  })
  const wrapper = mount(Host, { global: { plugins: [pinia, router] }, attachTo: document.body })
  const ui = useAgentUiStore()
  ui.setDocked(true)
  return { wrapper, router, ui, app: useAppStore() }
}

function press(init, target = window) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

const ctrl = (key, extra = {}) => ({ key, ctrlKey: true, ...extra })

let wrapper

beforeEach(() => {
  localStorage.clear()
  fakeAgent.busy = {}
  fakeAgent.stop.mockClear()
  fakePane.open = false
  fakePane.toggleOpen.mockClear()
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('matchShortcut', () => {
  it('maps the documented keys', () => {
    expect(matchShortcut({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true }, false)).toBe('new-chat')
    expect(matchShortcut({ key: 'k', code: 'KeyK', ctrlKey: true }, false)).toBe('search')
    expect(matchShortcut({ key: 'b', code: 'KeyB', ctrlKey: true }, false)).toBe('sidebar')
    expect(matchShortcut({ key: '\\', code: 'Backslash', ctrlKey: true }, false)).toBe('pane')
    expect(matchShortcut({ key: '/', code: 'Slash', ctrlKey: true }, false)).toBe('shortcuts')
    expect(matchShortcut({ key: 'Escape' }, false)).toBe('escape')
  })

  it('uses Cmd on a Mac and ignores IME composition', () => {
    expect(matchShortcut({ key: 'k', metaKey: true }, true)).toBe('search')
    expect(matchShortcut({ key: 'k', ctrlKey: true }, true)).toBeNull()
    expect(matchShortcut({ key: 'k', ctrlKey: true, isComposing: true }, false)).toBeNull()
    expect(matchShortcut({ key: 'k', ctrlKey: true, keyCode: 229 }, false)).toBeNull()
    expect(matchShortcut({ key: 'k' }, false)).toBeNull()
    expect(matchShortcut({ key: 'b', ctrlKey: true, shiftKey: true }, false)).toBeNull()
  })
})

describe('useAgentHotkeys', () => {
  it('toggles the sidebar, the shortcuts dialog and opens chat search', async () => {
    const ctx = await setup('/projects/w1/agent')
    wrapper = ctx.wrapper
    expect(press(ctrl('b', { code: 'KeyB' })).defaultPrevented).toBe(true)
    expect(ctx.ui.sidebarCollapsed).toBe(true)
    press(ctrl('/', { code: 'Slash' }))
    expect(ctx.ui.shortcutsOpen).toBe(true)
    press(ctrl('k', { code: 'KeyK' }))
    expect(ctx.ui.filterOpen).toBe(true)
    expect(ctx.ui.sidebarCollapsed).toBe(false)
  })

  it('opens the agent with chat search from the board and Settings', async () => {
    const ctx = await setup('/projects/w1/analytics?widget=countries')
    wrapper = ctx.wrapper
    expect(press(ctrl('k', { code: 'KeyK' })).defaultPrevented).toBe(true)
    // Not before the agent is open: the board has no sidebar to search in.
    expect(ctx.ui.filterOpen).toBe(false)
    await flushPromises()
    // Where the header's Agent link goes: no last chat yet, so a new chat.
    expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w1/agent')
    expect(ctx.ui.filterOpen).toBe(true)

    wrapper.unmount()
    const settings = await setup('/settings', { sites: [{ id: 'w2', name: 'Acme' }] })
    wrapper = settings.wrapper
    expect(press(ctrl('k', { code: 'KeyK' })).defaultPrevented).toBe(true)
    await flushPromises()
    expect(settings.router.currentRoute.value.fullPath).toBe('/projects/w2/agent')
    expect(settings.ui.filterOpen).toBe(true)
  })

  it('leaves Ctrl+K alone without a project', async () => {
    const ctx = await setup('/settings')
    wrapper = ctx.wrapper
    expect(press(ctrl('k', { code: 'KeyK' })).defaultPrevented).toBe(false)
    await flushPromises()
    expect(ctx.router.currentRoute.value.name).toBe('settings')
    expect(ctx.ui.filterOpen).toBe(false)
  })

  it('leaves Ctrl+K to a field outside the agent, so typed text is not lost', async () => {
    const ctx = await setup('/settings', { sites: [{ id: 'w2', name: 'Acme' }] })
    wrapper = ctx.wrapper
    const input = document.createElement('input')
    const box = document.createElement('textarea')
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.append(document.createElement('span'))
    document.body.append(input, box, editor)
    for (const field of [input, editor.firstChild]) {
      expect(press(ctrl('k', { code: 'KeyK' }), field).defaultPrevented).toBe(false)
    }
    await flushPromises()
    expect(ctx.router.currentRoute.value.name).toBe('settings')

    // The board's Ask AI box keeps its question too.
    await ctx.router.push('/projects/w2/analytics')
    expect(press(ctrl('k', { code: 'KeyK' }), box).defaultPrevented).toBe(false)
    await flushPromises()
    expect(ctx.router.currentRoute.value.name).toBe('analytics')
    expect(ctx.ui.filterOpen).toBe(false)

    // On the agent the search opens from any field, the composer included.
    await ctx.router.push('/projects/w2/agent')
    expect(press(ctrl('k', { code: 'KeyK' }), box).defaultPrevented).toBe(true)
    expect(ctx.ui.filterOpen).toBe(true)
  })

  it('leaves Ctrl+B to the browser on the board, and still opens the shortcuts', async () => {
    const ctx = await setup('/projects/w1/analytics')
    wrapper = ctx.wrapper
    expect(press(ctrl('b', { code: 'KeyB' })).defaultPrevented).toBe(false)
    expect(ctx.ui.sidebarCollapsed).toBe(false)
    expect(press(ctrl('/', { code: 'Slash' })).defaultPrevented).toBe(true)
    expect(ctx.ui.shortcutsOpen).toBe(true)
    // The browser pane exists only beside a chat.
    expect(press(ctrl('\\', { code: 'Backslash' })).defaultPrevented).toBe(false)
  })

  it('toggles the pane only on chat routes', async () => {
    const ctx = await setup('/projects/w1/agent/context')
    wrapper = ctx.wrapper
    const ignored = press(ctrl('\\', { code: 'Backslash' }))
    expect(ignored.defaultPrevented).toBe(false)
    expect(fakePane.toggleOpen).not.toHaveBeenCalled()
    await ctx.router.push('/projects/w1/agent/c/c9')
    expect(press(ctrl('\\', { code: 'Backslash' })).defaultPrevented).toBe(true)
    expect(fakePane.toggleOpen).toHaveBeenCalledTimes(1)
  })

  it('starts a new chat in the current project', async () => {
    const ctx = await setup('/projects/w1/agent/c/c9')
    wrapper = ctx.wrapper
    press(ctrl('O', { code: 'KeyO', shiftKey: true }))
    await vi.waitFor(() => expect(ctx.router.currentRoute.value.name).toBe('agent-home'))
    expect(ctx.router.currentRoute.value.params.websiteId).toBe('w1')
  })

  it('stops the busy chat on Escape and leaves idle chats alone', async () => {
    const ctx = await setup('/projects/w1/agent/c/c9')
    wrapper = ctx.wrapper
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(false)
    expect(fakeAgent.stop).not.toHaveBeenCalled()
    fakeAgent.busy = { c9: true }
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(true)
    expect(fakeAgent.stop).toHaveBeenCalledWith('c9')
    expect(ctx.ui.politeAnnouncement.text).toBe('Stopping the agent')
  })

  it('stops a first message still being sent from the new-chat view', async () => {
    const ctx = await setup('/projects/w1/agent')
    wrapper = ctx.wrapper
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(false)
    fakeAgent.busy = { new: true }
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(true)
    expect(fakeAgent.stop).toHaveBeenCalledWith('new')
  })

  it('leaves Escape to an open menu or dialog, and to handlers that took it', async () => {
    const ctx = await setup('/projects/w1/agent/c/c9')
    wrapper = ctx.wrapper
    fakeAgent.busy = { c9: true }
    const layer = document.createElement('div')
    layer.setAttribute('data-dismissable-layer', '')
    document.body.appendChild(layer)
    press({ key: 'Escape' })
    expect(fakeAgent.stop).not.toHaveBeenCalled()
    layer.remove()

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.addEventListener('keydown', (e) => e.preventDefault())
    press({ key: 'Escape' }, input)
    expect(fakeAgent.stop).not.toHaveBeenCalled()
  })

  it('closes the drawer on Escape when narrow', async () => {
    const ctx = await setup('/projects/w1/agent')
    wrapper = ctx.wrapper
    ctx.ui.setDocked(false)
    ctx.ui.openDrawer()
    press({ key: 'Escape' })
    expect(ctx.ui.drawerOpen).toBe(false)
  })

  it('stops listening on unmount', async () => {
    const ctx = await setup('/projects/w1/agent')
    ctx.wrapper.unmount()
    press(ctrl('b', { code: 'KeyB' }))
    expect(ctx.ui.sidebarCollapsed).toBe(false)
  })
})
