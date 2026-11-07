import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref, watch } from 'vue'
import { RouterView, createMemoryHistory, createRouter, useRoute } from 'vue-router'

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }))
vi.mock('@/api/board', () => ({ default: api }))
const sources = vi.hoisted(() => ({ invalidate: vi.fn(), revalidate: vi.fn() }))
vi.mock('@/composables/board/useBoardSource', () => sources)
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const loaded = vi.hoisted(() => [])
vi.mock('@/components/board/widgetComponents', async () => {
  const vue = await import('vue')
  const Card = vue.defineComponent({
    props: { websiteId: String, size: String },
    setup: (props) => () => vue.h('p', { class: 'stub-card' }, props.websiteId),
  })
  const View = vue.defineComponent({
    props: { websiteId: String },
    setup: (props) => () => vue.h('div', { class: 'stub-view' }, props.websiteId),
  })
  const entry = (key) => ({
    card: () => {
      loaded.push(key)
      return Promise.resolve({ __esModule: true, default: Card })
    },
    panel: () => Promise.resolve({ __esModule: true, default: View }),
  })
  const { WIDGETS } = await import('@/lib/board/widgets')
  return { WIDGET_COMPONENTS: Object.fromEntries(WIDGETS.map((w) => [w.key, entry(w.key)])) }
})

const { useAppStore } = await import('@/stores/app')
const { useAuthStore } = await import('@/stores/auth')
const { useBoardStore } = await import('@/stores/board')
const { default: AnalyticsBoardPage } = await import('../AnalyticsBoardPage.vue')

// The default board (autopilot_contract.md 6): Ask AI, then Prompt ranking.
const DEFAULT = [
  { key: 'prompt-box', size: 'full' },
  { key: 'ranking', size: 'full' },
]
const DEFAULT_KEYS = DEFAULT.map((w) => w.key)
const payload = (widgets = DEFAULT, version = 0) => ({ data: { saved: version > 0, version, updated_at: null, widgets } })

const mounted = []
// Cleared after each test, so its debounced saves never land in the next one's mocks.
const stores = []

// The frame's <main id="app-main">: the board's scroll container. jsdom has
// no layout, so its height is set here and its observer called by hand. As
// the frame does, a new path starts main at the top just after it mounts.
const Frame = defineComponent({
  setup() {
    const route = useRoute()
    const mainEl = ref(null)
    watch(
      () => route.path,
      () => {
        nextTick(() => {
          if (mainEl.value) mainEl.value.scrollTop = 0
        })
      },
    )
    return () => h('main', { id: 'app-main', ref: mainEl, style: 'overflow-y: auto' }, [h(RouterView)])
  },
})
let mainHeight = 0
let observers = []
const RealResizeObserver = window.ResizeObserver

async function setup(path = '/projects/w1/analytics') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { id: 7 }
  useAppStore().setWebsites([
    { id: 'w1', name: 'Wrenfield' },
    { id: 'w2', name: 'Acme' },
  ])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: AnalyticsBoardPage, props: true, meta: { section: 'analytics' } },
      // Another page in main.
      { path: '/elsewhere', component: { render: () => h('p', 'Elsewhere') } },
    ],
  })
  await router.push(path)
  await router.isReady()
  // The grid's TransitionGroup renders for real (test-utils stubs it by default).
  const wrapper = mount(Frame, {
    global: { plugins: [pinia, router], stubs: { 'transition-group': false } },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  stores.push(useBoardStore())
  await flushPromises()
  return { wrapper, router, store: useBoardStore(), main: wrapper.find('main').element }
}

async function settle() {
  await flushPromises()
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await flushPromises()
}

const cells = (wrapper) => wrapper.findAll('.bd-cell').map((c) => c.attributes('data-widget'))
const addButton = (wrapper) => wrapper.find('button[data-bd-add]')
const saveStates = (wrapper) => wrapper.findAll('.bd-save').map((s) => s.text())

beforeEach(() => {
  localStorage.clear()
  loaded.length = 0
  Object.values(api).forEach((fn) => fn.mockReset())
  Object.values(sources).forEach((fn) => fn.mockReset())
  Object.values(toast).forEach((fn) => fn.mockReset())
  api.save.mockImplementation((wid, body) => Promise.resolve(payload(body.widgets, body.version + 1)))
  mainHeight = 640
  observers = []
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.tagName === 'MAIN' ? mainHeight : 0
    },
  })
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  while (stores.length) stores.pop().clear()
  vi.useRealTimers()
  delete HTMLElement.prototype.clientHeight
  window.ResizeObserver = RealResizeObserver
  document.body.innerHTML = ''
})

describe('AnalyticsBoardPage', () => {
  it('shows skeleton cards of the default board, and asks for no data, until the layout is known', async () => {
    let answer
    api.get.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { wrapper } = await setup()
    // The board's own toolbar, sticky in main; Analytics has no sidebar to open.
    const header = wrapper.find('.bd-top[data-bd-sticky] > header.bd-bar')
    expect(header.find('h1#bd-title').text()).toBe('Analytics')
    expect(wrapper.find('header.ag-page-header').exists()).toBe(false)
    expect(wrapper.findAll('button').some((b) => /sidebar/i.test(b.attributes('aria-label') || ''))).toBe(false)
    expect(wrapper.find('section.bd-main').attributes('aria-labelledby')).toBe('bd-title')
    expect(cells(wrapper)).toEqual(['prompt-box', 'ranking'])
    expect(wrapper.findAll('.bd-skel')).toHaveLength(2)
    expect(loaded).toEqual([])
    expect(addButton(wrapper).attributes('disabled')).toBeDefined()

    answer(payload([{ key: 'traffic', size: 'third' }, { key: 'sentiment', size: 'third' }], 2))
    await flushPromises()
    expect(cells(wrapper)).toEqual(['traffic', 'sentiment'])
    // Each card's code loads once the layout is known (in whatever order Vue mounts them).
    expect([...loaded].sort()).toEqual(['sentiment', 'traffic'])
    expect(addButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(addButton(wrapper).attributes('aria-label')).toBe('Add widget')
    expect(addButton(wrapper).text()).toBe('Add widget')
  })

  it('opens a panel from ?widget and saves nothing, even for a widget off the board', async () => {
    api.get.mockResolvedValue(payload())
    const { wrapper, store } = await setup('/projects/w1/analytics?widget=products')
    await settle()
    expect(wrapper.find('aside.bd-panel h2').text()).toBe('Products')
    expect(store.has('w1', 'products')).toBe(false)
    expect(cells(wrapper)).toEqual(DEFAULT_KEYS)
    await new Promise((r) => setTimeout(r, 500))
    expect(api.save).not.toHaveBeenCalled()
  })

  it('says when the board is empty and offers Add widget', async () => {
    api.get.mockResolvedValue(payload([], 4))
    const { wrapper } = await setup()
    const empty = wrapper.find('.ag-empty')
    expect(empty.text()).toContain('Your board is empty.')
    expect(empty.text()).toContain('Add a widget to start.')
    await empty.find('button').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('.ag-portal.ag-dialog')
    expect(dialog.querySelector('.ag-dialog-title').textContent).toBe('Add a widget')
  })

  it('adds from the catalog, then scrolls to and focuses the card added last', async () => {
    api.get.mockResolvedValue(payload())
    const { wrapper } = await setup()
    await addButton(wrapper).trigger('click')
    await flushPromises()
    const row = [...document.body.querySelectorAll('li.bd-cat-row')].find((r) => r.textContent.includes('AI crawlers'))
    row.querySelector('button').click()
    await flushPromises()
    document.body.querySelector('.ag-dialog .ag-dlg-close').click()
    await settle()
    expect(cells(wrapper).at(-1)).toBe('ai-crawlers')
    expect(document.activeElement).toBe(wrapper.find('.bd-cell[data-widget="ai-crawlers"] button.bd-card-open').element)
  })

  it('asks before resetting, then shows the default with the answered version', async () => {
    api.get.mockResolvedValue(payload([{ key: 'pages', size: 'full' }], 3))
    api.reset.mockResolvedValue({ data: { saved: true, version: 4, updated_at: '2026-11-04T10:12:00Z', widgets: DEFAULT } })
    const { wrapper, store, main } = await setup()
    main.scrollTop = 400
    await wrapper.find('button[aria-label="Board options"]').trigger('click')
    await flushPromises()
    const reset = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Reset board'))
    reset.click()
    await settle()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog.textContent).toContain('Reset this board?')
    expect(dialog.textContent).toContain(
      'Your board goes back to Ask AI and Prompt ranking. Widgets you added are removed; their data is not touched.',
    )
    expect(api.reset).not.toHaveBeenCalled()
    ;[...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reset board').click()
    await settle()
    expect(api.reset).toHaveBeenCalledWith('w1')
    expect(cells(wrapper)).toEqual(DEFAULT_KEYS)
    expect(store.layoutOf('w1').version).toBe(4)
    // The board starts again at the top of main.
    expect(main.scrollTop).toBe(0)
    // The dialog gives focus back to the menu button it came from.
    expect(document.activeElement).toBe(wrapper.find('button[aria-label="Board options"]').element)
  })

  it('titles the browser tab with the project, and the open panel first', async () => {
    api.get.mockResolvedValue(payload())
    const { router } = await setup()
    expect(document.title).toBe('Analytics — Wrenfield — Cansee')
    await router.push('/projects/w1/analytics?widget=countries')
    await settle()
    expect(document.title).toBe('Countries — Analytics — Wrenfield — Cansee')
    await router.replace('/projects/w1/analytics?widget=prompts&prompt=p9')
    await settle()
    expect(document.title).toBe('Prompt — Analytics — Wrenfield — Cansee')
  })

  it("loads the other project's board on a project change", async () => {
    api.get.mockImplementation((wid) =>
      Promise.resolve(wid === 'w2' ? payload([{ key: 'products', size: 'half' }], 1) : payload()),
    )
    const { wrapper, router } = await setup()
    await router.push('/projects/w2/analytics')
    await settle()
    expect(api.get).toHaveBeenLastCalledWith('w2')
    expect(cells(wrapper)).toEqual(['products'])
    expect(document.title).toBe('Analytics — Acme — Cansee')
  })

  it("covers main's visible height with the panel, and locks main while a panel is open", async () => {
    api.get.mockResolvedValue(payload())
    const { wrapper, router, main } = await setup('/projects/w1/analytics?widget=countries')
    const root = wrapper.find('.bd').element
    expect(root.style.getPropertyValue('--bd-view-h')).toBe('640px')
    mainHeight = 720
    observers.forEach((o) => o.callback([]))
    await nextTick()
    expect(root.style.getPropertyValue('--bd-view-h')).toBe('720px')

    // A deep link locks main right after mount; closing puts back what was there.
    expect(wrapper.find('aside.bd-panel').exists()).toBe(true)
    expect(main.style.overflowY).toBe('hidden')
    // No scrollbar gutter here (as on phones), so no padding stands in for one.
    expect(main.style.paddingRight).toBe('')
    expect(root.style.getPropertyValue('--bd-lock-gutter')).toBe('')
    await wrapper.find('aside.bd-panel button[aria-label="Close Countries"]').trigger('click')
    await settle()
    expect(wrapper.find('aside.bd-panel').exists()).toBe(false)
    expect(main.style.overflowY).toBe('auto')

    await router.push('/projects/w1/analytics?widget=traffic')
    await settle()
    expect(main.style.overflowY).toBe('hidden')
    // Unmounting with the panel open puts it back too, and leaves main's
    // place to the frame.
    main.scrollTop = 300
    mounted.pop().unmount()
    expect(main.style.overflowY).toBe('auto')
    expect(main.scrollTop).toBe(300)
  })

  it("trades main's scrollbar gutter for padding the panel reaches over, and gives it back", async () => {
    api.get.mockResolvedValue(payload())
    // Main is 1440px wide with a 10.5px gutter (a zoomed page), so the board
    // root in it is 1429.5px.
    const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const width = this.tagName === 'MAIN' ? 1440 : this.classList.contains('bd') ? 1429.5 : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) }
    })
    try {
      const { wrapper, router, main } = await setup()
      const root = wrapper.find('.bd').element
      await router.push('/projects/w1/analytics?widget=countries')
      await settle()
      expect(main.style.overflowY).toBe('hidden')
      expect(main.style.scrollbarGutter).toBe('auto')
      expect(main.style.paddingRight).toBe('10.5px')
      expect(root.style.getPropertyValue('--bd-lock-gutter')).toBe('10.5px')

      await wrapper.find('aside.bd-panel button[aria-label="Close Countries"]').trigger('click')
      await settle()
      expect(main.style.overflowY).toBe('auto')
      expect(main.style.scrollbarGutter).toBe('')
      expect(main.style.paddingRight).toBe('')
      expect(root.style.getPropertyValue('--bd-lock-gutter')).toBe('')

      // Unmounting with the panel open gives it back too.
      await router.push('/projects/w1/analytics?widget=traffic')
      await settle()
      expect(main.style.paddingRight).toBe('10.5px')
      mounted.pop().unmount()
      expect(main.style.scrollbarGutter).toBe('')
      expect(main.style.paddingRight).toBe('')
    } finally {
      rects.mockRestore()
    }
  })

  it("keeps main's place while a panel is open, even when a view in the panel scrolls it, and on close", async () => {
    api.get.mockResolvedValue(payload())
    const { wrapper, router, main } = await setup()
    main.scrollTop = 400
    await router.push('/projects/w1/analytics?widget=countries')
    await settle()
    expect(main.style.overflowY).toBe('hidden')

    // A row the panel brings into view scrolls main too, hidden or not.
    main.scrollTop = 100
    main.dispatchEvent(new Event('scroll'))
    expect(main.scrollTop).toBe(400)
    // A scroll whose event the close comes before.
    main.scrollTop = 250
    await wrapper.find('aside.bd-panel button[aria-label="Close Countries"]').trigger('click')
    await settle()
    expect(wrapper.find('aside.bd-panel').exists()).toBe(false)
    expect(main.scrollTop).toBe(400)
    expect(main.style.overflowY).toBe('auto')

    // Unlocked, main scrolls as it likes.
    main.scrollTop = 120
    main.dispatchEvent(new Event('scroll'))
    expect(main.scrollTop).toBe(120)
  })

  it('keeps a page that opens with a panel at the top, where the frame starts it, not at the last page’s place', async () => {
    api.get.mockResolvedValue(payload())
    const { wrapper, router, main } = await setup('/elsewhere')
    main.scrollTop = 500
    await router.push('/projects/w1/analytics?widget=countries')
    await settle()
    expect(wrapper.find('aside.bd-panel').exists()).toBe(true)
    expect(main.scrollTop).toBe(0)

    main.scrollTop = 120
    main.dispatchEvent(new Event('scroll'))
    expect(main.scrollTop).toBe(0)
    await wrapper.find('aside.bd-panel button[aria-label="Close Countries"]').trigger('click')
    await settle()
    expect(main.scrollTop).toBe(0)
    expect(main.style.overflowY).toBe('auto')
  })

  it('says Saving... only after 600ms, and offers Try again when a save fails', async () => {
    api.get.mockResolvedValue(payload())
    const { wrapper, store } = await setup()
    vi.useFakeTimers()
    let answer
    api.save.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    store.add('w1', 'pages')
    await vi.advanceTimersByTimeAsync(400)
    expect(store.layoutOf('w1').save).toBe('saving')
    await vi.advanceTimersByTimeAsync(599)
    expect(saveStates(wrapper).join('')).toBe('')
    await vi.advanceTimersByTimeAsync(1)
    expect(saveStates(wrapper)[0]).toBe('Saving...')
    answer(payload([...DEFAULT, { key: 'pages', size: 'half' }], 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(saveStates(wrapper).join('')).toBe('')

    api.save.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('500'), { response: { status: 500, data: { error: { code: 'error' } } } })),
    )
    store.remove('w1', 'pages')
    await vi.advanceTimersByTimeAsync(400)
    expect(saveStates(wrapper)[0]).toContain("Couldn't save your board.")
    // Still on fake time: Vue drops a click stamped before its handler was attached.
    const retry = wrapper.find('.bd-save-head').findAll('button').find((b) => b.text() === 'Try again')
    await retry.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(api.save).toHaveBeenCalledTimes(3)
    expect(saveStates(wrapper).join('')).toBe('')
  })

  it('says when the saved board could not be loaded, and Try again asks again', async () => {
    api.get.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('500'), { response: { status: 500 } })))
    const { wrapper } = await setup()
    expect(cells(wrapper)).toEqual(DEFAULT_KEYS)
    expect(wrapper.findAll('.bd-skel')).toHaveLength(0)
    const state = wrapper.find('.bd-save-head')
    expect(state.text()).toContain("We couldn't load your saved board. Showing the default.")
    expect(state.attributes('role')).toBe('status')
    api.get.mockResolvedValueOnce(payload([{ key: 'pages', size: 'half' }], 2))
    await state.findAll('button').find((b) => b.text() === 'Try again').trigger('click')
    await flushPromises()
    expect(cells(wrapper)).toEqual(['pages'])
    expect(wrapper.find('.bd-save-head').text()).toBe('')
  })
})
