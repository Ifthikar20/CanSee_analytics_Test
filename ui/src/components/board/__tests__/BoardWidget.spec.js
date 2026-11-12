import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h, nextTick, provide } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT } from '@/lib/board/context'

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }))
vi.mock('@/api/board', () => ({ default: api }))

// Stand-in cards: one that shows its props, one that throws while
// rendering, and one whose code fails to load the first time.
const cards = vi.hoisted(() => {
  const loaders = {}
  return { loaders }
})
vi.mock('@/components/board/widgetComponents', async () => {
  const vue = await import('vue')
  const Card = vue.defineComponent({
    props: { websiteId: { type: String, required: true }, size: { type: String, default: 'half' } },
    setup: (props) => () => vue.h('p', { class: 'stub-card' }, `${props.websiteId} ${props.size}`),
  })
  const Broken = vue.defineComponent({
    setup() {
      return () => {
        if (cards.loaders.broken()) throw new Error('render failed')
        return vue.h('p', { class: 'stub-card' }, 'recovered')
      }
    },
  })
  // A card that tells its frame what its body shows (useCardStatus).
  const { useCardStatus } = await import('@/lib/board/context')
  cards.status = vue.ref('live')
  const Reporter = vue.defineComponent({
    setup() {
      useCardStatus(() => cards.status.value)
      return () => vue.h('p', { class: 'stub-card' }, 'reporting')
    },
  })
  cards.loaders.card = vi.fn(() => Promise.resolve({ __esModule: true, default: Card }))
  cards.loaders.flaky = vi.fn()
  cards.loaders.broken = vi.fn(() => true)
  const panel = () => Promise.resolve({ __esModule: true, default: Card })
  return {
    WIDGET_COMPONENTS: {
      summary: { card: () => cards.loaders.card(), panel },
      countries: { card: () => cards.loaders.card(), panel },
      traffic: { card: () => cards.loaders.card(), panel },
      sentiment: { card: () => cards.loaders.flaky(), panel },
      pages: { card: () => Promise.resolve({ __esModule: true, default: Broken }), panel },
      'by-engine': { card: () => Promise.resolve({ __esModule: true, default: Reporter }), panel },
      'visibility-score': { card: () => Promise.resolve({ __esModule: true, default: Reporter }), panel },
    },
  }
})

const { useBoardStore } = await import('@/stores/board')
const { useAgentUiStore } = await import('@/stores/agentUi')
const { useAuthStore } = await import('@/stores/auth')
const { default: BoardGrid } = await import('../BoardGrid.vue')

const LAYOUT = [
  { key: 'summary', size: 'full' },
  { key: 'countries', size: 'half' },
  { key: 'traffic', size: 'half' },
]

const mounted = []
// Cleared after each test, so its debounced saves never land in the next one's mocks.
const stores = []
let ctx

async function setup(widgets = LAYOUT, { path = '/projects/w1/analytics', pending = false, columns = undefined } = {}) {
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
  await router.push(path)
  await router.isReady()
  ctx = { websiteId: computed(() => 'w1'), open: vi.fn(), close: vi.fn(), invalidate: vi.fn(), revalidate: vi.fn() }
  const Host = defineComponent({
    setup() {
      provide(BOARD_CONTEXT, ctx)
      return () =>
        h('div', { class: 'bd' }, [
          h('button', { type: 'button', 'data-bd-add': '' }, 'Add widget'),
          h(BoardGrid, { widgets: store.layoutOf('w1').widgets, pending, ...(columns === undefined ? {} : { columns }) }),
        ])
    },
  })
  // The grid's TransitionGroup renders for real (test-utils stubs it by default).
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

async function openMenu(wrapper, key) {
  await cell(wrapper, key).find('button.bd-card-menu').trigger('click')
  await flushPromises()
  return document.body.querySelector('.ag-portal.ag-menu')
}

function menuItem(text) {
  return [...document.body.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((el) =>
    el.textContent.trim().startsWith(text),
  )
}

async function settle() {
  await flushPromises()
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await flushPromises()
}

beforeEach(() => {
  localStorage.clear()
  Object.values(api).forEach((fn) => fn.mockReset())
  cards.loaders.card.mockClear()
  cards.loaders.flaky.mockReset()
  cards.loaders.broken.mockReset()
  cards.loaders.broken.mockReturnValue(true)
  cards.status.value = 'live'
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  while (stores.length) stores.pop().clear()
  document.body.innerHTML = ''
})

describe('BoardWidget', () => {
  it('renders the card chrome and the compact card with the project and size', async () => {
    const { wrapper } = await setup()
    expect(order(wrapper)).toEqual(['summary', 'countries', 'traffic'])
    const grid = wrapper.find('ul.bd-grid')
    expect(grid.attributes('role')).toBe('list')
    expect(grid.attributes('aria-label')).toBe('Widgets')

    const countries = cell(wrapper, 'countries')
    expect(countries.element.tagName).toBe('LI')
    expect(countries.classes()).toContain('is-half')
    const section = countries.find('section.bd-card')
    const title = countries.find('h2.bd-card-title')
    expect(section.attributes('aria-labelledby')).toBe(title.attributes('id'))
    expect(title.find('button.bd-card-open').text()).toBe('Countries')
    // The one-liner is the title's tooltip; the card itself stays quiet.
    expect(title.find('button.bd-card-open').attributes('title')).toBe(
      'Where you rank and where your traffic comes from, country by country.',
    )
    expect(countries.find('.bd-card-desc').exists()).toBe(false)
    // The card's face is the chip and the title; the stub card reports nothing, so no chip.
    expect([...countries.find('.bd-card-head').element.children].map((el) => el.tagName)).toEqual(['H2'])

    // Under the card, outside it: the code and caption, then the grip and the options.
    const foot = countries.find('footer.bd-card-foot')
    expect(section.element.contains(foot.element)).toBe(false)
    expect(foot.find('.cs-caption__code').text()).toBe('CNS_09')
    expect(foot.find('.bd-card-caption-text').text()).toBe('Rank, country by country')
    expect(foot.find('button.bd-card-menu').attributes('aria-label')).toBe('Options for Countries')
    const grip = foot.find('button.bd-card-grip')
    expect(grip.attributes('aria-label')).toBe('Move Countries')
    expect(grip.attributes('aria-describedby')).toBe('bd-move-help')
    const tools = [...foot.find('.bd-card-tools').element.children]
    expect(tools.map((el) => ['bd-card-grip', 'bd-card-menu'].find((c) => el.classList.contains(c)))).toEqual([
      'bd-card-grip',
      'bd-card-menu',
    ])
    // Tab order: the title, the card, then its controls.
    const focusable = [...countries.element.querySelectorAll('button')].map((b) => b.className.split(' ')[0])
    expect(focusable).toEqual(['bd-card-open', 'bd-card-grip', 'bd-card-menu'])
    expect(wrapper.find('p#bd-move-help').attributes('hidden')).toBeDefined()
    expect(countries.find('.stub-card').text()).toBe('w1 half')
    expect(cell(wrapper, 'summary').find('.stub-card').text()).toBe('w1 full')
  })

  it('wears the surface of its block: ink for some, light for the rest, wherever it sits', async () => {
    const { wrapper, store } = await setup([
      { key: 'visibility-score', size: 'third' },
      { key: 'by-engine', size: 'third' },
      { key: 'traffic', size: 'half' },
    ])
    const tones = () => order(wrapper).map((key) => `${key}:${cell(wrapper, key).attributes('data-tone')}`)
    expect(tones()).toEqual(['visibility-score:ink', 'by-engine:light', 'traffic:ink'])
    expect(cell(wrapper, 'visibility-score').find('section.bd-card').classes()).toEqual(
      expect.arrayContaining(['cs-card', 'cs-contrast']),
    )
    expect(cell(wrapper, 'by-engine').find('section.bd-card').classes()).toContain('cs-card')
    expect(cell(wrapper, 'by-engine').find('section.bd-card').classes()).not.toContain('cs-contrast')
    // The line under an ink card stays on the page's own surface.
    expect(cell(wrapper, 'visibility-score').find('.bd-card-foot').element.closest('.cs-contrast')).toBeNull()
    // A move changes the place, never the surface.
    store.move('w1', 'by-engine', -1)
    await settle()
    expect(tones()).toEqual(['by-engine:light', 'visibility-score:ink', 'traffic:ink'])
  })

  it('shows Live only while the card reports fresh numbers, and says what it shows otherwise', async () => {
    const { wrapper } = await setup([{ key: 'by-engine', size: 'third' }])
    const chip = () => cell(wrapper, 'by-engine').find('.bd-card-chip')
    expect(chip().text()).toBe('Live')
    expect(chip().attributes('data-status')).toBe('live')
    expect(chip().classes()).toContain('cs-chip--live')
    expect(chip().classes()).not.toContain('cs-chip--quiet')
    // The chip leads the card's header, before the title.
    expect([...cell(wrapper, 'by-engine').find('.bd-card-head').element.children].map((el) => el.tagName)).toEqual(['SPAN', 'H2'])

    for (const [status, label] of [
      ['empty', 'No data'],
      ['setup', 'Setup'],
      ['error', 'Error'],
      ['stale', 'Stale'],
      ['loading', 'Loading'],
    ]) {
      cards.status.value = status
      await nextTick()
      expect(chip().text(), status).toBe(label)
      expect(chip().attributes('data-status'), status).toBe(status)
      expect(chip().classes(), status).not.toContain('cs-chip--live')
      expect(chip().classes(), status).toContain('cs-chip--quiet')
    }

    cards.status.value = 'ready'
    await nextTick()
    expect(chip().text()).toBe('Ready')
    expect(chip().classes()).not.toContain('cs-chip--live')

    // A status the frame does not know, or none, draws no chip rather than a guess.
    for (const unknown of ['LIVE', 'fresh', '', null]) {
      cards.status.value = unknown
      await nextTick()
      expect(chip().exists(), String(unknown)).toBe(false)
    }
    cards.status.value = 'live'
    await nextTick()
    expect(chip().text()).toBe('Live')
  })

  it('keeps each card to its own chip', async () => {
    cards.status.value = 'empty'
    const { wrapper } = await setup([
      { key: 'by-engine', size: 'third' },
      { key: 'traffic', size: 'half' },
    ])
    expect(cell(wrapper, 'by-engine').find('.bd-card-chip').text()).toBe('No data')
    // The stub card says nothing: no chip, and never its neighbour's.
    expect(cell(wrapper, 'traffic').find('.bd-card-chip').exists()).toBe(false)
  })

  it('sets the density on the grid: 2, 3 or 4 columns, four by default', async () => {
    const { wrapper } = await setup()
    const grid = () => wrapper.find('ul.bd-grid')
    expect(grid().classes()).toContain('is-cols-4')
    expect(grid().attributes('data-columns')).toBe('4')
    for (const n of [2, 3, 4]) {
      while (mounted.length) mounted.pop().unmount()
      const next = await setup(LAYOUT, { columns: n })
      expect(next.wrapper.find('ul.bd-grid').classes(), n).toContain(`is-cols-${n}`)
      expect(next.wrapper.find('ul.bd-grid').attributes('data-columns'), n).toBe(String(n))
    }
    while (mounted.length) mounted.pop().unmount()
    const odd = await setup(LAYOUT, { columns: 7 })
    expect(odd.wrapper.find('ul.bd-grid').attributes('data-columns')).toBe('4')
    // The size word stays on the cell; the grid decides what a third spans.
    expect(cell(odd.wrapper, 'countries').classes()).toContain('is-half')
  })

  it('opens the panel from the title and from Expand', async () => {
    const { wrapper } = await setup()
    await cell(wrapper, 'traffic').find('button.bd-card-open').trigger('click')
    expect(ctx.open).toHaveBeenCalledWith('traffic')

    await openMenu(wrapper, 'countries')
    menuItem('Expand').click()
    await settle()
    expect(ctx.open).toHaveBeenLastCalledWith('countries')
    // Close returns to the menu button it came from.
    expect(document.activeElement).toBe(cell(wrapper, 'countries').find('button.bd-card-menu').element)
  })

  it('offers the menu items, with Move up and Move down disabled at the ends', async () => {
    const { wrapper } = await setup()
    const menu = await openMenu(wrapper, 'summary')
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim())
    expect(items).toEqual(['Expand', 'Move up', 'Move down', 'Size', 'Remove from board'])
    expect(menuItem('Move up').hasAttribute('data-disabled')).toBe(true)
    expect(menuItem('Move down').hasAttribute('data-disabled')).toBe(false)
    expect(menuItem('Remove from board').classList.contains('is-danger')).toBe(true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()

    await openMenu(wrapper, 'traffic')
    expect(menuItem('Move up').hasAttribute('data-disabled')).toBe(false)
    expect(menuItem('Move down').hasAttribute('data-disabled')).toBe(true)
  })

  it('moves a card, says where it went and keeps focus on its menu button', async () => {
    const { wrapper, store, ui } = await setup()
    await openMenu(wrapper, 'summary')
    menuItem('Move down').click()
    await settle()
    expect(order(wrapper)).toEqual(['countries', 'summary', 'traffic'])
    expect(store.layoutOf('w1').widgets.map((w) => w.key)).toEqual(['countries', 'summary', 'traffic'])
    expect(ui.politeAnnouncement.text).toBe('Moved Summary down. Now 2 of 3.')
    expect(document.activeElement).toBe(cell(wrapper, 'summary').find('button.bd-card-menu').element)

    await openMenu(wrapper, 'traffic')
    menuItem('Move up').click()
    await settle()
    expect(order(wrapper)).toEqual(['countries', 'traffic', 'summary'])
    expect(ui.politeAnnouncement.text).toBe('Moved Traffic up. Now 2 of 3.')
  })

  it("keeps every card mounted when a save's answer replaces the layout", async () => {
    const { wrapper } = await setup()
    const loads = cards.loaders.card.mock.calls.length
    const traffic = cell(wrapper, 'traffic').find('.stub-card').element
    await openMenu(wrapper, 'summary')
    menuItem('Move down').click()
    await settle()
    // The answer comes back as new {key, size} objects in the same order.
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1))
    await settle()
    expect(cards.loaders.card.mock.calls.length).toBe(loads)
    expect(cell(wrapper, 'traffic').find('.stub-card').element).toBe(traffic)
  })

  it('offers only the sizes a widget allows, checks the current one and resizes', async () => {
    const { wrapper, store, ui } = await setup()
    await openMenu(wrapper, 'countries')
    menuItem('Size').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    const radios = [...document.body.querySelectorAll('[role="menuitemradio"]')]
    expect(radios.map((el) => el.textContent.trim())).toEqual(['Half', 'Full width'])
    expect(radios.map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    radios[1].click()
    await settle()
    expect(store.layoutOf('w1').widgets[1]).toEqual({ key: 'countries', size: 'full' })
    expect(cell(wrapper, 'countries').classes()).toContain('is-full')
    expect(ui.politeAnnouncement.text).toBe('Countries is now full width.')
    expect(document.activeElement).toBe(cell(wrapper, 'countries').find('button.bd-card-menu').element)
  })

  it('removes a card and moves focus to the next card, else the previous, else Add widget', async () => {
    const { wrapper, store, ui } = await setup()
    await openMenu(wrapper, 'countries')
    menuItem('Remove from board').click()
    await settle()
    expect(order(wrapper)).toEqual(['summary', 'traffic'])
    expect(ui.politeAnnouncement.text).toBe('Removed Countries from your board.')
    expect(document.activeElement).toBe(cell(wrapper, 'traffic').find('button.bd-card-open').element)
    expect(ctx.close).not.toHaveBeenCalled()

    await openMenu(wrapper, 'traffic')
    menuItem('Remove from board').click()
    await settle()
    expect(document.activeElement).toBe(cell(wrapper, 'summary').find('button.bd-card-open').element)

    await openMenu(wrapper, 'summary')
    menuItem('Remove from board').click()
    await settle()
    expect(store.layoutOf('w1').widgets).toEqual([])
    expect(document.activeElement).toBe(wrapper.find('[data-bd-add]').element)
  })

  it("closes the widget's panel when it is removed", async () => {
    const { wrapper } = await setup(LAYOUT, { path: '/projects/w1/analytics?widget=traffic' })
    await openMenu(wrapper, 'traffic')
    menuItem('Remove from board').click()
    await settle()
    expect(ctx.close).toHaveBeenCalledWith({ restoreFocus: false })
    expect(document.activeElement).toBe(cell(wrapper, 'countries').find('button.bd-card-open').element)
  })

  it('says when a card cannot load, and Try again loads it afresh', async () => {
    cards.loaders.flaky.mockRejectedValueOnce(new Error('chunk failed'))
    const { wrapper } = await setup([{ key: 'sentiment', size: 'third' }])
    const sentiment = cell(wrapper, 'sentiment')
    expect(sentiment.text()).toContain("This widget couldn't load.")
    expect(sentiment.find('.stub-card').exists()).toBe(false)
    // The chip says so too, and never Live.
    expect(sentiment.find('.bd-card-chip').text()).toBe('Error')
    // The chrome stays usable.
    expect(sentiment.find('button.bd-card-menu').exists()).toBe(true)

    const { default: Card } = await cards.loaders.card()
    cards.loaders.flaky.mockResolvedValueOnce({ __esModule: true, default: Card })
    await sentiment.findAll('button').find((b) => b.text() === 'Try again').trigger('click')
    await flushPromises()
    expect(cards.loaders.flaky).toHaveBeenCalledTimes(2)
    expect(cell(wrapper, 'sentiment').find('.stub-card').text()).toBe('w1 third')
  })

  it('keeps a card that throws to itself, and Try again remounts it', async () => {
    const { wrapper } = await setup([
      { key: 'pages', size: 'half' },
      { key: 'traffic', size: 'half' },
    ])
    expect(cell(wrapper, 'pages').text()).toContain("This widget couldn't load.")
    expect(cell(wrapper, 'pages').find('.bd-card-chip').text()).toBe('Error')
    expect(cell(wrapper, 'traffic').find('.stub-card').exists()).toBe(true)
    cards.loaders.broken.mockReturnValue(false)
    await cell(wrapper, 'pages').findAll('button').find((b) => b.text() === 'Try again').trigger('click')
    await flushPromises()
    expect(cell(wrapper, 'pages').find('.stub-card').text()).toBe('recovered')
    expect(cell(wrapper, 'pages').find('.bd-card-chip').exists()).toBe(false)
  })

  it('forgets what a card reported once it is loaded afresh', async () => {
    const { wrapper } = await setup([{ key: 'by-engine', size: 'third' }])
    expect(cell(wrapper, 'by-engine').find('.bd-card-chip').text()).toBe('Live')
    // The card goes away with its report: no chip is left behind claiming Live.
    while (mounted.length) mounted.pop().unmount()
    cards.status.value = null
    const next = await setup([{ key: 'by-engine', size: 'third' }])
    expect(cell(next.wrapper, 'by-engine').find('.bd-card-chip').exists()).toBe(false)
  })

  it('shows skeletons and loads no card while the layout is unknown', async () => {
    const { wrapper } = await setup(LAYOUT, { pending: true })
    expect(wrapper.findAll('.bd-skel')).toHaveLength(3)
    expect(wrapper.findAll('.bd-card-chip').map((c) => c.text())).toEqual(['Loading', 'Loading', 'Loading'])
    expect(wrapper.find('.stub-card').exists()).toBe(false)
    expect(wrapper.find('button.bd-card-menu').exists()).toBe(false)
    // Nothing moves while the layout is unknown.
    expect(wrapper.find('button.bd-card-grip').exists()).toBe(false)
    expect(wrapper.find('.bd-card-head.is-movable').exists()).toBe(false)
    expect(cards.loaders.card).not.toHaveBeenCalled()
    expect(cell(wrapper, 'summary').find('section').attributes('aria-busy')).toBe('true')
  })
})
