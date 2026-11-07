import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { WIDGETS } from '@/lib/board/widgets'

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }))
vi.mock('@/api/board', () => ({ default: api }))

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
const rows = () => [...dialog().querySelectorAll('li.bd-cat-row')]
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
  })

  it('searches titles and one-liners, ignoring case, and says when nothing matches', async () => {
    await setup()
    await search('CLOUDFLARE')
    expect(rows().map((r) => r.querySelector('.bd-cat-title').textContent)).toEqual(['AI crawlers'])
    await search('share')
    expect(rows().map((r) => r.querySelector('.bd-cat-title').textContent)).toEqual(['AI visibility by engine', 'Share of voice'])
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
