import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { RouterView, createRouter, createWebHistory } from 'vue-router'

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }))
vi.mock('@/api/board', () => ({ default: api }))
const sources = vi.hoisted(() => ({ invalidate: vi.fn(), revalidate: vi.fn() }))
vi.mock('@/composables/board/useBoardSource', () => sources)

// Cards and expanded views are stand-ins; a view says what it was given and
// whether it knows it renders in the panel. Products has no view.
vi.mock('@/components/board/widgetComponents', async () => {
  const vue = await import('vue')
  const { IN_PANEL, useBoard } = await import('@/lib/board/context')
  const module = (component) => () => Promise.resolve({ __esModule: true, default: component })
  const Card = vue.defineComponent({
    props: { websiteId: String, size: String },
    setup: (props) => () => vue.h('p', { class: 'stub-card' }, props.websiteId),
  })
  const View = vue.defineComponent({
    props: { websiteId: String, focus: { type: String, default: '' } },
    setup(props) {
      const inPanel = vue.inject(IN_PANEL, false)
      const board = useBoard()
      return () =>
        vue.h('div', { class: 'stub-view', style: 'height: 2000px' }, [
          vue.h('span', { class: 'stub-view-props' }, `${props.websiteId}|${props.focus}|${inPanel}`),
          vue.h('button', { type: 'button', class: 'stub-view-button' }, 'Inside'),
          // A view opening a record of its own (a prompt's detail, say).
          vue.h('button', { type: 'button', class: 'stub-view-open', onClick: () => board.open('traffic', { period: '7d' }) }, 'Record'),
          // A view opening another widget (Who AI recommends -> Competitors, say).
          vue.h('button', { type: 'button', class: 'stub-view-switch', onClick: () => board.open('countries') }, 'Other'),
        ])
    },
  })
  const entry = (extra = {}) => ({ card: module(Card), panel: module(View), ...extra })
  return {
    WIDGET_COMPONENTS: {
      summary: entry(),
      prompts: entry(),
      countries: entry(),
      traffic: entry(),
      'ai-crawlers': entry({ panelProps: { focus: 'crawlers' } }),
      'ai-traffic': entry({ panelProps: { focus: 'visits' } }),
    },
  }
})

const { useAppStore } = await import('@/stores/app')
const { useAgentUiStore } = await import('@/stores/agentUi')
const { useBoardStore } = await import('@/stores/board')
const { default: AnalyticsBoardPage } = await import('@/pages/board/AnalyticsBoardPage.vue')

const DEFAULT = [
  { key: 'summary', size: 'full' },
  { key: 'prompts', size: 'full' },
  { key: 'countries', size: 'half' },
  { key: 'traffic', size: 'half' },
]

const mounted = []
// Cleared after each test, so its debounced saves never land in the next one's mocks.
const stores = []
const realMatchMedia = window.matchMedia
let phone = false

async function setup(path) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Wrenfield' }])
  api.get.mockResolvedValue({ data: { saved: false, version: 0, updated_at: null, widgets: DEFAULT } })
  api.save.mockImplementation((wid, body) => Promise.resolve({ data: { saved: true, version: body.version + 1, widgets: body.widgets } }))
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: AnalyticsBoardPage, props: true, meta: { section: 'analytics' } },
      { path: '/elsewhere', name: 'elsewhere', component: { render: () => null } },
    ],
  })
  await router.push(path)
  await router.isReady()
  // The grid's TransitionGroup renders for real (test-utils stubs it by default).
  const wrapper = mount(RouterView, {
    global: { plugins: [pinia, router], stubs: { 'transition-group': false } },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  stores.push(useBoardStore())
  return { wrapper, router, store: useBoardStore(), ui: useAgentUiStore() }
}

async function settle() {
  await flushPromises()
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await flushPromises()
}

const panel = (wrapper) => wrapper.find('aside.bd-panel')
const query = (router) => router.currentRoute.value.query
const escape = (target) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
const main = (wrapper) => wrapper.find('section.bd-main').element
const inert = (el) => el.inert === true || el.hasAttribute('inert')

beforeEach(() => {
  localStorage.clear()
  phone = false
  Object.values(api).forEach((fn) => fn.mockReset())
  Object.values(sources).forEach((fn) => fn.mockReset())
  window.matchMedia = (q) => ({
    matches: q === '(max-width: 767px)' ? phone : false,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  while (stores.length) stores.pop().clear()
  window.matchMedia = realMatchMedia
  document.body.innerHTML = ''
})

describe('BoardPanel', () => {
  it('opens the panel of ?widget with its view, its props and the panel flag', async () => {
    const { wrapper, ui } = await setup('/projects/w1/analytics?widget=ai-crawlers&period=7d')
    const aside = panel(wrapper)
    expect(aside.exists()).toBe(true)
    const title = aside.find('h2#bd-panel-title')
    expect(aside.attributes('aria-labelledby')).toBe('bd-panel-title')
    expect(title.text()).toBe('AI crawlers')
    expect(title.attributes('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(title.element)
    expect(aside.find('.stub-view-props').text()).toBe('w1|crawlers|true')
    expect(aside.find('button[aria-label="Close AI crawlers"]').exists()).toBe(true)
    expect(ui.politeAnnouncement.text).toBe('Opened AI crawlers.')
    // Inside the board, never teleported, and never a modal dialog.
    expect(wrapper.find('.bd').element.contains(aside.element)).toBe(true)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('Widen makes the sheet cover the board, is remembered, and shows at every width but phones', async () => {
    const { wrapper } = await setup('/projects/w1/analytics?widget=countries')
    expect(panel(wrapper).classes()).not.toContain('is-wide')
    const widen = panel(wrapper).find('button[aria-label="Widen"]')
    expect(widen.attributes('aria-pressed')).toBe('false')
    await widen.trigger('click')
    await flushPromises()
    const narrow = panel(wrapper).find('button[aria-label="Narrow"]')
    expect(narrow.attributes('aria-pressed')).toBe('true')
    expect(panel(wrapper).classes()).toContain('is-wide')
    expect(localStorage.getItem('cs-board-panel-wide')).toBe('1')

    // The next panel opens wide.
    mounted.pop().unmount()
    const again = await setup('/projects/w1/analytics?widget=traffic')
    expect(panel(again.wrapper).classes()).toContain('is-wide')
    await panel(again.wrapper).find('button[aria-label="Narrow"]').trigger('click')
    await flushPromises()
    expect(panel(again.wrapper).classes()).not.toContain('is-wide')
    expect(localStorage.getItem('cs-board-panel-wide')).toBe('0')
  })

  it('lies over the board at every width on a scrim, with the board inert, and fills a phone without Widen', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics?widget=countries')
    // The layer comes first in the board root and holds the scrim and the sheet.
    const layer = wrapper.find('.bd > .bd-layer')
    expect(wrapper.find('.bd').element.firstElementChild).toBe(layer.element)
    expect(layer.find('.bd-scrim').exists()).toBe(true)
    expect(layer.find('aside.bd-panel').exists()).toBe(true)
    expect(panel(wrapper).classes()).not.toContain('is-full')
    expect(inert(main(wrapper))).toBe(true)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    await wrapper.find('.bd-scrim').trigger('click')
    await settle()
    expect(query(router).widget).toBeUndefined()
    expect(wrapper.find('.bd-layer').exists()).toBe(false)
    expect(inert(main(wrapper))).toBe(false)

    mounted.pop().unmount()
    phone = true
    const small = await setup('/projects/w1/analytics?widget=countries')
    expect(panel(small.wrapper).classes()).toContain('is-full')
    expect(panel(small.wrapper).find('button[aria-label="Widen"]').exists()).toBe(false)
    expect(inert(main(small.wrapper))).toBe(true)
  })

  it('closes on Escape and gives focus back to the card that opened it', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics')
    const before = window.history.length
    const open = wrapper.find('.bd-cell[data-widget="traffic"] button.bd-card-open')
    open.element.focus()
    await open.trigger('click')
    await settle()
    expect(query(router).widget).toBe('traffic')
    expect(window.history.length).toBe(before + 1)
    expect(window.history.state.bdPanel).toBe(true)

    panel(wrapper).find('.stub-view-button').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(query(router).widget).toBeUndefined())
    await settle()
    expect(panel(wrapper).exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('.bd-cell[data-widget="traffic"] button.bd-card-open').element)
    // Closing refetches the stale card data in use.
    expect(sources.revalidate).toHaveBeenCalledWith('w1')
  })

  it('closes on Escape from the header above it, and from nowhere', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics?widget=countries')
    // The header's Help button, in the app's root beside the board, once its
    // menu has closed and given it focus back, which shows its tooltip: a
    // reka layer, but only a hint.
    const help = document.createElement('button')
    wrapper.element.parentElement.prepend(help)
    const tooltip = document.createElement('div')
    tooltip.setAttribute('data-dismissable-layer', '')
    tooltip.innerHTML = 'Help<span role="tooltip">Help</span>'
    document.body.append(tooltip)
    escape(help)
    await vi.waitFor(() => expect(query(router).widget).toBeUndefined())
    await settle()
    expect(panel(wrapper).exists()).toBe(false)

    await router.push('/projects/w1/analytics?widget=traffic')
    await settle()
    escape(document.body)
    await vi.waitFor(() => expect(query(router).widget).toBeUndefined())
  })

  it('leaves Escape to whoever took it, and to a menu, a dialog or a layer over the page', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics?widget=countries')
    const button = panel(wrapper).find('.stub-view-button').element
    button.addEventListener('keydown', (e) => e.preventDefault())
    escape(button)
    await settle()
    expect(query(router).widget).toBe('countries')

    // A reka menu that is still open closes itself; so does a page's modal.
    const help = document.createElement('button')
    wrapper.element.parentElement.prepend(help)
    for (const attrs of [{ 'data-dismissable-layer': '' }, { role: 'dialog', 'aria-modal': 'true' }]) {
      const layer = document.createElement('div')
      Object.entries(attrs).forEach(([name, value]) => layer.setAttribute(name, value))
      document.body.append(layer)
      escape(help)
      await settle()
      expect(query(router).widget).toBe('countries')
      layer.remove()
    }

    // A card teleported over the page keeps the key, even one that ignores it.
    const card = document.createElement('div')
    card.append(document.createElement('button'))
    document.body.append(card)
    escape(card.firstElementChild)
    await settle()
    expect(query(router).widget).toBe('countries')
  })

  it('closes a panel opened by a link in place, focusing its card or Add widget', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics?widget=countries&engine=claude')
    await panel(wrapper).find('button[aria-label="Close Countries"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w1/analytics')
    expect(document.activeElement).toBe(wrapper.find('.bd-cell[data-widget="countries"] button.bd-card-open').element)

    await router.push('/projects/w1/analytics?widget=ai-traffic')
    await settle()
    await panel(wrapper).find('button[aria-label="Close AI traffic"]').trigger('click')
    await settle()
    expect(document.activeElement).toBe(wrapper.find('[data-bd-add]').element)
  })

  it('switches panels in place from an open panel, keeping its history entry', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics')
    await wrapper.find('.bd-cell[data-widget="summary"] button.bd-card-open').trigger('click')
    await settle()
    const length = window.history.length
    await panel(wrapper).find('.stub-view-switch').trigger('click')
    await settle()
    expect(query(router).widget).toBe('countries')
    expect(window.history.length).toBe(length)
    expect(window.history.state.bdPanel).toBe(true)
    expect(panel(wrapper).find('h2').text()).toBe('Countries')
    expect(document.activeElement).toBe(panel(wrapper).find('h2').element)
  })

  it('a record opened from inside the panel keeps the card that opened it', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics')
    const title = (key) => wrapper.find(`.bd-cell[data-widget="${key}"] button.bd-card-open`)
    title('traffic').element.focus()
    await title('traffic').trigger('click')
    await settle()
    expect(query(router).widget).toBe('traffic')
    const record = panel(wrapper).find('.stub-view-open')
    record.element.focus()
    await record.trigger('click')
    await settle()
    expect(query(router)).toEqual({ widget: 'traffic', period: '7d' })

    await panel(wrapper).find('button[aria-label="Close Traffic"]').trigger('click')
    await vi.waitFor(() => expect(query(router).widget).toBeUndefined())
    await settle()
    expect(document.activeElement).toBe(title('traffic').element)
  })

  it('offers Add to board only while the widget is off the board', async () => {
    const { wrapper, store, ui } = await setup('/projects/w1/analytics?widget=ai-crawlers')
    const add = panel(wrapper).findAll('button').find((b) => b.text() === 'Add to board')
    expect(add).toBeTruthy()
    await add.trigger('click')
    await flushPromises()
    expect(store.has('w1', 'ai-crawlers')).toBe(true)
    expect(ui.politeAnnouncement.text).toBe('Added AI crawlers to your board.')
    expect(panel(wrapper).findAll('button').some((b) => b.text() === 'Add to board')).toBe(false)
    expect(wrapper.find('.bd-cell[data-widget="ai-crawlers"]').exists()).toBe(true)

    await settle()
    const onBoard = await setup('/projects/w1/analytics?widget=countries')
    expect(panel(onBoard.wrapper).findAll('button').some((b) => b.text() === 'Add to board')).toBe(false)
  })

  it('drops an unknown widget from the address and closes a widget with no view', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics?widget=nope&period=90d')
    expect(router.currentRoute.value.fullPath).toBe('/projects/w1/analytics?period=90d')
    expect(panel(wrapper).exists()).toBe(false)

    await router.push('/projects/w1/analytics?widget=products')
    await settle()
    expect(query(router).widget).toBeUndefined()
    expect(panel(wrapper).exists()).toBe(false)
  })

  it("titles a prompt's detail Prompt and starts a new record at the top", async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics?widget=prompts')
    const body = panel(wrapper).find('.bd-panel-body').element
    body.scrollTop = 300
    await router.replace('/projects/w1/analytics?widget=prompts&prompt=p1')
    await settle()
    expect(panel(wrapper).find('h2').text()).toBe('Prompt')
    expect(panel(wrapper).find('button[aria-label="Close Prompt"]').exists()).toBe(true)
    expect(body.scrollTop).toBe(0)
  })
})
