import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { WIDGETS, blockCode } from '@/lib/board/widgets'
import { previewShapes } from '@/lib/board/previews'

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }))
vi.mock('@/api/board', () => ({ default: api }))

// One block draws its own tile; every other tile draws the catalog's kind.
const own = vi.hoisted(() => ({ loads: 0 }))
vi.mock('../widgetComponents', async () => {
  const vue = await import('vue')
  const OwnPreview = vue.defineComponent({ render: () => vue.h('svg', { class: 'own-preview' }) })
  const none = () => Promise.resolve({ __esModule: true, default: { render: () => null } })
  return {
    WIDGET_COMPONENTS: {
      'next-steps': {
        card: none,
        panel: none,
        preview: () => {
          own.loads += 1
          return Promise.resolve({ __esModule: true, default: OwnPreview })
        },
      },
      // A group that gives no drawing, and one that gives something that is not a loader.
      summary: { card: none, panel: none },
      pages: { card: none, panel: none, preview: 'nope' },
    },
  }
})

const { useBoardStore } = await import('@/stores/board')
const { useAgentUiStore } = await import('@/stores/agentUi')
const { default: WidgetCatalog } = await import('../WidgetCatalog.vue')

const mounted = []
// Cleared after each test, so its debounced saves never land in the next one's mocks.
const stores = []

async function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  api.get.mockResolvedValue({
    data: {
      saved: false,
      version: 0,
      widgets: [
        { key: 'summary', size: 'full' },
        { key: 'prompts', size: 'full' },
        { key: 'countries', size: 'half' },
        { key: 'traffic', size: 'half' },
      ],
    },
  })
  api.save.mockImplementation((wid, body) => Promise.resolve({ data: { saved: true, version: body.version + 1, widgets: body.widgets } }))
  const store = useBoardStore()
  stores.push(store)
  await store.load('w1')
  const wrapper = mount(WidgetCatalog, {
    props: { websiteId: 'w1', open: true, 'onUpdate:open': (v) => wrapper.setProps({ open: v }) },
    global: { plugins: [pinia] },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, store, ui: useAgentUiStore() }
}

const dialog = () => document.body.querySelector('.ag-portal.ag-dialog')
const rows = () => [...dialog().querySelectorAll('li.bd-cat-tile')]
const rowOf = (title) => rows().find((r) => r.querySelector('.bd-cat-title').textContent === title)

async function search(text) {
  const input = dialog().querySelector('input[type="search"]')
  input.value = text
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}

beforeEach(() => {
  localStorage.clear()
  Object.values(api).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  while (stores.length) stores.pop().clear()
  document.body.innerHTML = ''
})

describe('WidgetCatalog', () => {
  it('lists every widget in catalog order with its one-liner and whether it is on the board', async () => {
    await setup()
    expect(dialog().querySelector('.ag-dialog-title').textContent).toBe('Add a widget')
    expect(dialog().textContent).toContain('Pick what this board shows. Each widget opens a detailed view.')
    expect(dialog().classList.contains('is-gallery')).toBe(true)
    const input = dialog().querySelector('input[type="search"]')
    expect(input.getAttribute('aria-label')).toBe('Search widgets')
    expect(input.getAttribute('placeholder')).toBe('Search widgets')
    expect(rows().map((r) => r.querySelector('.bd-cat-title').textContent)).toEqual(WIDGETS.map((w) => w.title))
    expect(rowOf('Summary').textContent).toContain('On your board')
    expect(rowOf('Summary').querySelector('button')).toBeNull()
    const add = rowOf('AI crawlers').querySelector('button')
    expect(add.textContent.trim()).toBe('Add')
    expect(add.getAttribute('aria-label')).toBe('Add AI crawlers')
    expect(rowOf('AI crawlers').textContent).toContain('AI bots reading your site, counted by Cloudflare.')
    // All 28 blocks, each named by a heading, with how many are on the board.
    expect(rows()).toHaveLength(28)
    expect(rows().every((r) => r.querySelector('h3.bd-cat-title'))).toBe(true)
    expect(dialog().querySelector('.bd-cat-count').textContent).toBe('4 of 28 on your board')
  })

  it("shows each block's code and default size, and a drawing on the block's own surface", async () => {
    await setup()
    expect(rows().map((r) => r.querySelector('.cs-caption__code').textContent)).toEqual(WIDGETS.map((w) => blockCode(w.key)))
    expect(rowOf('Watch').querySelector('.bd-cat-code').textContent).toBe('CNS_01One third')
    expect(rowOf('Latest report').querySelector('.bd-cat-code').textContent).toBe('CNS_28Half')
    expect(rowOf('Ask AI').querySelector('.bd-cat-code').textContent).toBe('CNS_05Full width')
    for (const w of WIDGETS) {
      const tile = dialog().querySelector(`[data-catalog="${w.key}"]`)
      const preview = tile.querySelector('.bd-cat-preview')
      expect(preview.classList.contains('cs-contrast'), w.key).toBe(w.tone === 'ink')
      if (w.key === 'next-steps') continue
      const svg = preview.querySelector('svg.bd-preview')
      expect(svg.getAttribute('data-preview'), w.key).toBe(w.preview)
      // Decoration: the tile names the block in words.
      expect(svg.getAttribute('aria-hidden'), w.key).toBe('true')
      expect(svg.children.length, w.key).toBe(previewShapes(w.preview).length)
    }
    // The reference row: the eye and the numeral in ink, the question and the rank in light.
    expect(WIDGETS.slice(0, 4).map((w) => w.tone)).toEqual(['ink', 'light', 'light', 'ink'])
  })

  it('marks every drawing as sample data, in the tile and in the description', async () => {
    await setup()
    for (const tile of rows()) {
      const chip = tile.querySelector('.bd-cat-preview .bd-cat-sample')
      expect(chip.textContent, tile.dataset.catalog).toBe('Sample data')
      // Never the chip a live card wears.
      expect(chip.classList.contains('cs-chip--live'), tile.dataset.catalog).toBe(false)
      expect(tile.textContent, tile.dataset.catalog).not.toMatch(/\bLive\b/)
    }
    expect(dialog().textContent).toContain('The drawings are sketches with sample data, not your numbers.')
  })

  it("draws a block's own tile when its group gives one, else the catalog's kind", async () => {
    await setup()
    const tile = dialog().querySelector('[data-catalog="next-steps"]')
    expect(tile.querySelector('svg.own-preview')).not.toBeNull()
    expect(tile.querySelector('svg.bd-preview')).toBeNull()
    expect(tile.querySelector('.bd-cat-sample').textContent).toBe('Sample data')
    expect(own.loads).toBeGreaterThanOrEqual(1)
    // No drawing given, or not a loader: the catalog's kind.
    expect(dialog().querySelector('[data-catalog="summary"] svg.bd-preview').getAttribute('data-preview')).toBe('tiles')
    expect(dialog().querySelector('[data-catalog="pages"] svg.bd-preview').getAttribute('data-preview')).toBe('table')
  })

  it('searches titles, one-liners and codes, ignoring case, and says when nothing matches', async () => {
    await setup()
    await search('CLOUDFLARE')
    expect(rows().map((r) => r.querySelector('.bd-cat-title').textContent)).toEqual(['AI crawlers'])
    await search('share')
    expect(rows().map((r) => r.querySelector('.bd-cat-title').textContent)).toEqual(['AI visibility by engine', 'Share of voice'])
    await search('cns_28')
    expect(rows().map((r) => r.querySelector('.bd-cat-title').textContent)).toEqual(['Latest report'])
    // The count is of the whole catalog, not of the matches.
    expect(dialog().querySelector('.bd-cat-count').textContent).toBe('4 of 28 on your board')
    await search('  zebra ')
    expect(rows()).toHaveLength(0)
    expect(dialog().textContent).toContain('No widget matches "zebra".')
  })

  it('adds a widget, keeps the dialog open and turns its row into On your board', async () => {
    const { wrapper, store, ui } = await setup()
    rowOf('Share of voice').querySelector('button').click()
    await flushPromises()
    expect(store.layoutOf('w1').widgets.at(-1)).toEqual({ key: 'share-of-voice', size: 'third' })
    expect(ui.politeAnnouncement.text).toBe('Added Share of voice to your board.')
    expect(dialog()).not.toBeNull()
    const row = rowOf('Share of voice')
    expect(row.querySelector('button')).toBeNull()
    expect(row.querySelector('.bd-cat-on').textContent).toBe('On your board')
    expect(document.activeElement).toBe(row.querySelector('.bd-cat-on'))
    expect(dialog().querySelector('.bd-cat-count').textContent).toBe('5 of 28 on your board')

    rowOf('AI crawlers').querySelector('button').click()
    await flushPromises()
    await wrapper.setProps({ open: false })
    await flushPromises()
    // The board scrolls to and focuses the card added last.
    expect(wrapper.emitted('done')).toEqual([['ai-crawlers']])
  })

  it('says nothing back when nothing was added', async () => {
    const { wrapper } = await setup()
    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(wrapper.emitted('done')).toBeUndefined()
  })
})
