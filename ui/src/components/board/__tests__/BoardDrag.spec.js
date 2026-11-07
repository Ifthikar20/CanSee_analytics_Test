import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h, nextTick, provide } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT } from '@/lib/board/context'

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }))
vi.mock('@/api/board', () => ({ default: api }))

// The layout jsdom does not have: a 1200px board in the wide mode, 300px
// rows and 16px gaps, laid out by flowLayout from the cells' DOM order. The
// scroll container and the visible band are set per test.
const geo = vi.hoisted(() => ({ scroller: null, band: null, reveal: null }))
vi.mock('@/composables/board/boardGeometry', async () => {
  const { flowLayout } = await import('@/lib/board/flow')
  const COL = (1200 - 11 * 16) / 12
  const sizeOf = (li) => ['third', 'half', 'full'].find((s) => li.classList.contains(`is-${s}`))
  return {
    scrollParentOf: () => geo.scroller,
    gridBox: () => ({ left: 0, top: 0, right: 1200, bottom: 2000, width: 1200, height: 2000 }),
    readCells(grid) {
      const cells = [...grid.children].filter((el) => el.matches('li.bd-cell'))
      const items = cells.map((li) => ({ key: li.dataset.widget, size: sizeOf(li) }))
      return flowLayout(items, 'wide').map(({ key, row, col, span }) => ({
        key,
        x: col * (COL + 16),
        y: row * 316,
        w: span * COL + (span - 1) * 16,
        h: 300,
      }))
    },
    visibleBand: () => geo.band,
    revealCell: (...args) => geo.reveal(...args),
  }
})

// Stand-in cards that count their mounts and hold an input, so a move can
// be seen to keep them.
const mounts = vi.hoisted(() => ({}))
vi.mock('@/components/board/widgetComponents', async () => {
  const vue = await import('vue')
  const card = (key) => () =>
    Promise.resolve({
      __esModule: true,
      default: vue.defineComponent({
        props: { websiteId: String, size: String },
        setup() {
          vue.onMounted(() => {
            mounts[key] = (mounts[key] || 0) + 1
          })
          return () => vue.h('div', [vue.h('input', { class: 'stub-input', 'aria-label': `${key} notes` })])
        },
      }),
    })
  const keys = ['traffic', 'sentiment', 'citations', 'ai-traffic', 'ai-crawlers', 'crawler-access']
  return { WIDGET_COMPONENTS: Object.fromEntries(keys.map((k) => [k, { card: card(k), panel: card(k) }])) }
})

const { useBoardStore } = await import('@/stores/board')
const { useAgentUiStore } = await import('@/stores/agentUi')
const { useAuthStore } = await import('@/stores/auth')
const { default: BoardGrid } = await import('../BoardGrid.vue')

const third = (key) => ({ key, size: 'third' })
// Traffic, Sentiment and Citations on the top row, AI traffic under Traffic.
const FOUR = ['traffic', 'sentiment', 'citations', 'ai-traffic'].map(third)
const SIX = ['traffic', 'sentiment', 'citations', 'ai-traffic', 'ai-crawlers', 'crawler-access'].map(third)
const keysOf = (list) => list.map((w) => w.key)

const mounted = []
// Cleared after each test, so its debounced saves never land in the next one's mocks.
const stores = []
let ctx

// A frame queue standing in for requestAnimationFrame.
const frames = { next: 1, queue: new Map(), now: 0 }
async function runFrame() {
  const due = [...frames.queue.values()]
  frames.queue.clear()
  frames.now += 16
  due.forEach((cb) => cb(frames.now))
  await flushPromises()
  await nextTick()
}

// The phone query, which a test can flip.
const media = { phone: false, listeners: new Set() }
const PHONE = '(max-width: 767px)'
function setPhone(value) {
  media.phone = value
  media.listeners.forEach((fn) => fn({ matches: value, media: PHONE }))
}

async function setup(widgets = FOUR, { pending = false } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { id: 7 }
  api.get.mockResolvedValue({ data: { saved: true, version: 1, widgets } })
  api.save.mockImplementation((wid, body) => Promise.resolve({ data: { saved: true, version: body.version + 1, widgets: body.widgets } }))
  const store = useBoardStore()
  stores.push(store)
  await store.load('w1')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/projects/:websiteId/analytics', name: 'analytics', component: { render: () => null } }],
  })
  await router.push('/projects/w1/analytics')
  await router.isReady()
  ctx = { websiteId: computed(() => 'w1'), open: vi.fn(), close: vi.fn(), invalidate: vi.fn(), revalidate: vi.fn() }
  const Host = defineComponent({
    setup() {
      provide(BOARD_CONTEXT, ctx)
      return () =>
        h('div', { class: 'bd' }, [
          h('div', { class: 'bd-top', 'data-bd-sticky': '' }),
          h(BoardGrid, { widgets: store.layoutOf('w1').widgets, pending }),
        ])
    },
  })
  const wrapper = mount(Host, {
    global: { plugins: [pinia, router], stubs: { 'transition-group': false } },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, store, router, ui: useAgentUiStore() }
}

const cell = (wrapper, key) => wrapper.find(`.bd-cell[data-widget="${key}"]`)
const order = (wrapper) => wrapper.findAll('.bd-cell').map((c) => c.attributes('data-widget'))
const grip = (wrapper, key) => cell(wrapper, key).find('button.bd-card-grip').element
const title = (wrapper, key) => cell(wrapper, key).find('button.bd-card-open').element
const lifted = (wrapper) => wrapper.find('.bd-card.is-lifted').exists()
const dragging = () => document.documentElement.classList.contains('bd-dragging')
const said = (ui) => ui.politeAnnouncement.text

function pointer(type, target, { x = 0, y = 0, pointerType = 'mouse', buttons = type === 'pointerup' ? 0 : 1 } = {}) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    pointerType,
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
  })
  target.dispatchEvent(event)
  return event
}

function press(target, key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

// Lift Traffic by its grip and hold it over Sentiment's trailing half.
async function dragTrafficOverSentiment(wrapper) {
  pointer('pointerdown', grip(wrapper, 'traffic'), { x: 360, y: 20 })
  pointer('pointermove', window, { x: 367, y: 20 })
  await nextTick()
  pointer('pointermove', window, { x: 700, y: 150 })
  await runFrame()
}

beforeEach(() => {
  localStorage.clear()
  Object.values(api).forEach((fn) => fn.mockReset())
  for (const key of Object.keys(mounts)) delete mounts[key]
  geo.scroller = { scrollTop: 0 }
  geo.band = { top: -10000, bottom: 10000 }
  geo.reveal = vi.fn()
  frames.queue.clear()
  frames.now = 0
  vi.stubGlobal('requestAnimationFrame', (cb) => {
    const id = frames.next++
    frames.queue.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.queue.delete(id))
  media.phone = false
  media.listeners.clear()
  vi.stubGlobal('matchMedia', (query) => ({
    media: query,
    get matches() {
      return query === PHONE && media.phone
    },
    onchange: null,
    addEventListener: (type, fn) => {
      if (query === PHONE) media.listeners.add(fn)
    },
    removeEventListener: (type, fn) => media.listeners.delete(fn),
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  while (stores.length) stores.pop().clear()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('bd-dragging')
  document.body.innerHTML = ''
})

describe('dragging a card with a pointer', () => {
  it('keeps a press that moves under 6px a click: the title opens the panel and nothing lifts', async () => {
    const { wrapper } = await setup()
    pointer('pointerdown', title(wrapper, 'traffic'), { x: 50, y: 20 })
    pointer('pointermove', window, { x: 54, y: 23 })
    await runFrame()
    expect(lifted(wrapper)).toBe(false)
    expect(dragging()).toBe(false)
    pointer('pointerup', window, { x: 54, y: 23 })
    title(wrapper, 'traffic').click()
    expect(ctx.open).toHaveBeenCalledWith('traffic')
  })

  it('lifts past 6px, reorders under the pointer, and saves the drop once with its announcement', async () => {
    const { wrapper, store, ui } = await setup()
    const input = cell(wrapper, 'traffic').find('input.stub-input').element
    input.value = 'typed'
    expect(mounts.traffic).toBe(1)

    pointer('pointerdown', grip(wrapper, 'traffic'), { x: 360, y: 20 })
    pointer('pointermove', window, { x: 365, y: 20 })
    await nextTick()
    expect(lifted(wrapper)).toBe(false)
    pointer('pointermove', window, { x: 366, y: 20 })
    await nextTick()
    expect(cell(wrapper, 'traffic').classes()).toContain('is-slot')
    expect(cell(wrapper, 'traffic').find('.bd-card').classes()).toContain('is-lifted')
    expect(dragging()).toBe(true)
    // A pointer lift says nothing.
    expect(said(ui)).toBe('')

    // Over Sentiment's trailing half: Traffic's slot moves after it.
    pointer('pointermove', window, { x: 700, y: 150 })
    await runFrame()
    expect(order(wrapper)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])
    expect(keysOf(store.layoutOf('w1').widgets)).toEqual(keysOf(FOUR))

    pointer('pointerup', window, { x: 700, y: 150 })
    await nextTick()
    expect(dragging()).toBe(false)
    expect(wrapper.find('.is-slot').exists()).toBe(false)
    expect(lifted(wrapper)).toBe(false)
    expect(said(ui)).toBe('Moved Traffic. Now 2 of 4.')
    expect(keysOf(store.layoutOf('w1').widgets)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])

    // The click that follows the release never opens the panel; the next one does.
    title(wrapper, 'traffic').click()
    expect(ctx.open).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    title(wrapper, 'traffic').click()
    expect(ctx.open).toHaveBeenCalledWith('traffic')

    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1))
    expect(keysOf(api.save.mock.calls[0][1].widgets)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])
    // The card moved; it was never remounted.
    expect(mounts.traffic).toBe(1)
    expect(cell(wrapper, 'traffic').find('input.stub-input').element).toBe(input)
    expect(input.value).toBe('typed')
  })

  it('drags from the header with a mouse, and gives focus back to the title it came from', async () => {
    const { wrapper } = await setup()
    const open = title(wrapper, 'traffic')
    open.focus()
    pointer('pointerdown', open, { x: 40, y: 10 })
    pointer('pointermove', window, { x: 48, y: 10 })
    await nextTick()
    expect(lifted(wrapper)).toBe(true)
    pointer('pointermove', window, { x: 700, y: 150 })
    await runFrame()
    pointer('pointerup', window, { x: 700, y: 150 })
    await flushPromises()
    expect(order(wrapper)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])
    expect(document.activeElement).toBe(open)
  })

  it('keeps the slot at its height until the cards have re-rendered, so a drop or a cancel moves no other card', async () => {
    const { wrapper } = await setup()
    const slot = cell(wrapper, 'traffic').element
    const card = slot.querySelector('.bd-card')
    // The card's own height, which jsdom does not lay out.
    Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => 300 })
    // What each measure of the cells found while the card was still out of
    // its cell: the grid's TransitionGroup takes the cards' places then, and
    // a collapsed slot would have the cards after it glide in from above.
    const seen = []
    const rect = Element.prototype.getBoundingClientRect
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.matches('li.bd-cell') && card.classList.contains('is-lifted')) seen.push(slot.style.minHeight)
      return rect.call(this)
    })
    try {
      // A release in place, then a cancel.
      for (const end of ['pointerup', 'pointercancel']) {
        pointer('pointerdown', grip(wrapper, 'traffic'), { x: 360, y: 20 })
        pointer('pointermove', window, { x: 367, y: 20 })
        await nextTick()
        expect(lifted(wrapper)).toBe(true)
        expect(slot.style.minHeight).toBe('300px')
        seen.length = 0

        pointer(end, window, { x: 367, y: 20 })
        expect(slot.style.minHeight).toBe('300px')
        await nextTick()
        expect(lifted(wrapper)).toBe(false)
        expect(slot.style.minHeight).toBe('')
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every((height) => height === '300px')).toBe(true)
        // The release's click goes by.
        await new Promise((r) => setTimeout(r, 0))
      }
    } finally {
      spy.mockRestore()
    }
    expect(order(wrapper)).toEqual(keysOf(FOUR))
  })

  it('counts a move with no button down as a drop released outside the window', async () => {
    const { wrapper, store } = await setup()
    await dragTrafficOverSentiment(wrapper)
    pointer('pointermove', window, { x: 700, y: 150, buttons: 0 })
    await nextTick()
    expect(lifted(wrapper)).toBe(false)
    expect(keysOf(store.layoutOf('w1').widgets)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])
  })

  it('scrolls the container a little more each frame while the pointer is near its bottom edge', async () => {
    const { wrapper } = await setup()
    geo.band = { top: 0, bottom: 600 }
    pointer('pointerdown', grip(wrapper, 'traffic'), { x: 360, y: 20 })
    pointer('pointermove', window, { x: 360, y: 590 })
    await nextTick()
    const seen = []
    for (let i = 0; i < 3; i += 1) {
      await runFrame()
      seen.push(geo.scroller.scrollTop)
    }
    expect(seen[0]).toBeGreaterThan(0)
    expect(seen[1]).toBeGreaterThan(seen[0])
    expect(seen[2]).toBeGreaterThan(seen[1])

    // Away from the edges nothing scrolls.
    pointer('pointermove', window, { x: 360, y: 300 })
    await runFrame()
    const still = geo.scroller.scrollTop
    await runFrame()
    expect(geo.scroller.scrollTop).toBe(still)
  })
})

describe('cancelling a drag', () => {
  it('puts the order back on Escape, saves nothing and says so, and keeps Escape from the page', async () => {
    const { wrapper, store, ui } = await setup()
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    await dragTrafficOverSentiment(wrapper)
    expect(order(wrapper)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])

    const escape = press(document.body, 'Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(seen).not.toHaveBeenCalled()
    await nextTick()
    expect(order(wrapper)).toEqual(keysOf(FOUR))
    expect(lifted(wrapper)).toBe(false)
    expect(dragging()).toBe(false)
    expect(said(ui)).toBe('Move cancelled. Traffic is back at 1 of 4.')

    // The release that ends the cancelled drag clicks nothing either.
    pointer('pointerup', window, { x: 40, y: 10 })
    title(wrapper, 'traffic').click()
    expect(ctx.open).not.toHaveBeenCalled()

    await new Promise((r) => setTimeout(r, 450))
    expect(api.save).not.toHaveBeenCalled()
    expect(keysOf(store.layoutOf('w1').widgets)).toEqual(keysOf(FOUR))
    window.removeEventListener('keydown', seen)
  })

  it('cancels on pointercancel, on a route change and when the layout changes under the drag', async () => {
    const { wrapper, store, router } = await setup()

    await dragTrafficOverSentiment(wrapper)
    pointer('pointercancel', window, { x: 700, y: 150 })
    await nextTick()
    expect(lifted(wrapper)).toBe(false)
    expect(order(wrapper)).toEqual(keysOf(FOUR))

    await dragTrafficOverSentiment(wrapper)
    await router.push('/projects/w1/analytics?widget=traffic')
    await flushPromises()
    expect(lifted(wrapper)).toBe(false)
    expect(order(wrapper)).toEqual(keysOf(FOUR))

    // Another window's board arrives (a 409, or a late load answer).
    await dragTrafficOverSentiment(wrapper)
    store.layoutOf('w1').widgets = ['citations', 'traffic', 'sentiment', 'ai-traffic'].map(third)
    await flushPromises()
    expect(lifted(wrapper)).toBe(false)
    expect(dragging()).toBe(false)
    expect(order(wrapper)).toEqual(['citations', 'traffic', 'sentiment', 'ai-traffic'])

    await new Promise((r) => setTimeout(r, 450))
    expect(api.save).not.toHaveBeenCalled()
  })

  it('stops the frame loop and drops the page class when the board unmounts mid-drag', async () => {
    const { wrapper } = await setup()
    await dragTrafficOverSentiment(wrapper)
    expect(dragging()).toBe(true)
    expect(frames.queue.size).toBe(1)
    mounted.pop().unmount()
    expect(dragging()).toBe(false)
    expect(frames.queue.size).toBe(0)
    pointer('pointermove', window, { x: 100, y: 100 })
    expect(frames.queue.size).toBe(0)
  })
})

describe('where a drag starts', () => {
  it('never lifts from the card body or the options button, nor from a touch on the header; a touch on the grip lifts', async () => {
    const { wrapper } = await setup()
    const traffic = cell(wrapper, 'traffic')

    pointer('pointerdown', traffic.find('input.stub-input').element, { x: 50, y: 150 })
    pointer('pointermove', window, { x: 90, y: 150 })
    await nextTick()
    expect(lifted(wrapper)).toBe(false)
    pointer('pointerup', window, { x: 90, y: 150 })

    pointer('pointerdown', traffic.find('p.bd-card-desc').element, { x: 50, y: 30, pointerType: 'touch' })
    pointer('pointermove', window, { x: 90, y: 30, pointerType: 'touch' })
    await nextTick()
    expect(lifted(wrapper)).toBe(false)
    pointer('pointerup', window, { x: 90, y: 30, pointerType: 'touch' })

    pointer('pointerdown', grip(wrapper, 'traffic'), { x: 360, y: 20, pointerType: 'touch' })
    pointer('pointermove', window, { x: 360, y: 40, pointerType: 'touch' })
    await nextTick()
    expect(lifted(wrapper)).toBe(true)
    pointer('pointerup', window, { x: 360, y: 40, pointerType: 'touch' })
    await nextTick()
    expect(lifted(wrapper)).toBe(false)

    const options = traffic.find('button.bd-card-menu').element
    pointer('pointerdown', options, { x: 380, y: 10 })
    pointer('pointermove', window, { x: 420, y: 10 })
    await nextTick()
    expect(lifted(wrapper)).toBe(false)
    expect(dragging()).toBe(false)
  })
})

describe('moving a card with the keyboard', () => {
  it('picks up with Space, moves with the arrows, Home and End, and drops with Space as one save', async () => {
    const { wrapper, store, ui } = await setup()
    const g = grip(wrapper, 'traffic')
    g.focus()

    expect(press(g, ' ').defaultPrevented).toBe(true)
    await nextTick()
    expect(cell(wrapper, 'traffic').classes()).toContain('is-held')
    expect(said(ui)).toBe(
      'Traffic picked up. Position 1 of 4. Use the arrow keys to move it, then press Space to drop it or Escape to cancel.',
    )

    expect(press(g, 'ArrowRight').defaultPrevented).toBe(true)
    await flushPromises()
    expect(order(wrapper)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])
    expect(said(ui)).toBe('Traffic, position 2 of 4.')
    expect(document.activeElement).toBe(g)
    expect(cell(wrapper, 'traffic').classes()).toContain('is-held')
    // The grip is kept in view, below the toolbar.
    expect(geo.reveal).toHaveBeenCalledWith(geo.scroller, cell(wrapper, 'traffic').element, expect.objectContaining(geo.band))

    press(g, 'End')
    await flushPromises()
    expect(order(wrapper)).toEqual(['sentiment', 'citations', 'ai-traffic', 'traffic'])
    expect(said(ui)).toBe('Traffic, position 4 of 4.')

    press(g, 'Home')
    await flushPromises()
    expect(order(wrapper)).toEqual(keysOf(FOUR))
    expect(said(ui)).toBe('Traffic, position 1 of 4.')

    press(g, 'ArrowRight')
    await flushPromises()
    // Nothing is saved until the drop.
    expect(keysOf(store.layoutOf('w1').widgets)).toEqual(keysOf(FOUR))

    press(g, ' ')
    await flushPromises()
    expect(cell(wrapper, 'traffic').classes()).not.toContain('is-held')
    expect(said(ui)).toBe('Moved Traffic. Now 2 of 4.')
    expect(document.activeElement).toBe(g)
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1))
    expect(keysOf(api.save.mock.calls[0][1].widgets)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])
  })

  it('ignores a held Space key repeating, and says when a drop leaves the card where it was', async () => {
    const { wrapper, ui } = await setup()
    const g = grip(wrapper, 'traffic')
    g.focus()
    press(g, 'Enter')
    await nextTick()
    press(g, 'Enter', { repeat: true })
    await nextTick()
    expect(cell(wrapper, 'traffic').classes()).toContain('is-held')
    press(g, ' ')
    await nextTick()
    expect(cell(wrapper, 'traffic').classes()).not.toContain('is-held')
    expect(said(ui)).toBe('Traffic stays at 1 of 4.')
  })

  it('cancels on Escape, which never reaches a window listener, and when focus leaves the grip', async () => {
    const { wrapper, ui } = await setup()
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    const g = grip(wrapper, 'traffic')
    g.focus()
    press(g, ' ')
    press(g, 'ArrowRight')
    await flushPromises()

    const escape = press(g, 'Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(seen.mock.calls.map(([event]) => event.key)).not.toContain('Escape')
    await flushPromises()
    expect(order(wrapper)).toEqual(keysOf(FOUR))
    expect(cell(wrapper, 'traffic').classes()).not.toContain('is-held')
    expect(said(ui)).toBe('Move cancelled. Traffic is back at 1 of 4.')
    expect(document.activeElement).toBe(g)

    press(g, ' ')
    press(g, 'ArrowRight')
    await flushPromises()
    expect(order(wrapper)).toEqual(['sentiment', 'traffic', 'citations', 'ai-traffic'])
    const elsewhere = title(wrapper, 'citations')
    elsewhere.focus()
    await flushPromises()
    expect(order(wrapper)).toEqual(keysOf(FOUR))
    expect(cell(wrapper, 'traffic').classes()).not.toContain('is-held')
    expect(document.activeElement).toBe(elsewhere)
    window.removeEventListener('keydown', seen)
  })

  it('moves a row up or down at the same column in a grid of thirds', async () => {
    const { wrapper, ui } = await setup(SIX)
    const g = grip(wrapper, 'sentiment')
    g.focus()
    press(g, ' ')
    press(g, 'ArrowDown')
    await flushPromises()
    // The middle of the top row to the middle of the second.
    expect(order(wrapper)).toEqual(['traffic', 'citations', 'ai-traffic', 'ai-crawlers', 'sentiment', 'crawler-access'])
    expect(said(ui)).toBe('Sentiment, position 5 of 6.')
    press(g, 'ArrowUp')
    await flushPromises()
    expect(order(wrapper)).toEqual(keysOf(SIX))
    expect(said(ui)).toBe('Sentiment, position 2 of 6.')
  })

  it('says when the card cannot go further', async () => {
    const { wrapper, ui } = await setup()
    const g = grip(wrapper, 'traffic')
    g.focus()
    press(g, ' ')
    press(g, 'ArrowLeft')
    expect(said(ui)).toBe('Traffic is already first.')
    press(g, 'ArrowUp')
    expect(said(ui)).toBe('Traffic is already in the top row.')
    press(g, 'End')
    await flushPromises()
    press(g, 'ArrowRight')
    expect(said(ui)).toBe('Traffic is already last.')
    // Alone on the last row.
    press(g, 'ArrowDown')
    expect(said(ui)).toBe('Traffic is already in the bottom row.')
    expect(order(wrapper)).toEqual(['sentiment', 'citations', 'ai-traffic', 'traffic'])
  })

  it('picks up and drops on a screen reader click (detail 0); a mouse click on the grip does nothing', async () => {
    const { wrapper, ui } = await setup()
    const g = grip(wrapper, 'traffic')
    const click = (detail) => g.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }))

    click(1)
    await nextTick()
    expect(cell(wrapper, 'traffic').classes()).not.toContain('is-held')

    click(0)
    await nextTick()
    expect(cell(wrapper, 'traffic').classes()).toContain('is-held')
    expect(said(ui)).toContain('Traffic picked up.')
    click(0)
    await nextTick()
    expect(cell(wrapper, 'traffic').classes()).not.toContain('is-held')
    expect(said(ui)).toBe('Traffic stays at 1 of 4.')

    // The click a handled Space or Enter brings is not a second toggle.
    g.focus()
    press(g, 'Enter')
    click(0)
    await nextTick()
    expect(cell(wrapper, 'traffic').classes()).toContain('is-held')
  })
})

describe('when cards cannot move', () => {
  it('shows no grip while the layout loads, on a phone, or with one widget', async () => {
    const loading = await setup(FOUR, { pending: true })
    expect(loading.wrapper.find('button.bd-card-grip').exists()).toBe(false)
    mounted.pop().unmount()

    media.phone = true
    const phone = await setup()
    expect(phone.wrapper.find('button.bd-card-grip').exists()).toBe(false)
    expect(phone.wrapper.find('.bd-card-head.is-movable').exists()).toBe(false)
    pointer('pointerdown', title(phone.wrapper, 'traffic'), { x: 40, y: 10 })
    pointer('pointermove', window, { x: 80, y: 10 })
    await nextTick()
    expect(lifted(phone.wrapper)).toBe(false)
    pointer('pointerup', window, { x: 80, y: 10 })
    mounted.pop().unmount()

    media.phone = false
    const one = await setup([third('traffic')])
    expect(one.wrapper.find('button.bd-card-grip').exists()).toBe(false)
  })

  it('cancels a hold when the window narrows to a phone', async () => {
    const { wrapper, ui } = await setup()
    const g = grip(wrapper, 'traffic')
    g.focus()
    press(g, ' ')
    press(g, 'ArrowRight')
    await flushPromises()
    setPhone(true)
    await flushPromises()
    expect(order(wrapper)).toEqual(keysOf(FOUR))
    expect(wrapper.find('.is-held').exists()).toBe(false)
    expect(wrapper.find('button.bd-card-grip').exists()).toBe(false)
    expect(said(ui)).toBe('Move cancelled. Traffic is back at 1 of 4.')
  })
})
