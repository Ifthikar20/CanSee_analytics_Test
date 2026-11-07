import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import VizHeatmap from '@/components/charts/VizHeatmap.vue'
import { binsFor } from '@/lib/charts/scales'
import { normalizeVizSpec } from '@/lib/charts/spec'

enableAutoUnmount(afterEach)

const byPrompt = normalizeVizSpec({
  title: 'By prompt',
  value: 'percent',
  labels: ['p1', 'p2'],
  label_names: { p1: 'best crm', p2: 'crm for startups' },
  state_labels: { not_found: 'Not named' },
  datasets: [
    { key: 'chatgpt', label: 'ChatGPT', data: [85, 10] },
    { key: 'claude', label: 'Claude', data: [null, null], states: ['not_checked', 'not_found'] },
    { key: 'gemini', label: 'Gemini', data: [null, 50], states: ['named', null] },
  ],
})

const overTime = normalizeVizSpec({
  title: 'Visibility over time',
  x: 'time',
  value: 'percent',
  labels: ['2026-10-01', '2026-10-02', '2026-10-03'],
  datasets: [
    { key: 'chatgpt', label: 'ChatGPT', data: [40, null, 35] },
    { key: 'claude', label: 'Claude', data: [20, 25, 61] },
  ],
})

function render(spec, props = {}) {
  return mount(VizHeatmap, {
    props: { spec, bins: binsFor(spec), title: spec.title, ...props },
    attachTo: document.body,
  })
}

const rowHeaders = (wrapper) => wrapper.findAll('tbody th').map((th) => th.text())
const columnHeaders = (wrapper) => wrapper.findAll('thead th.viz-heat-col').map((th) => th.text())

describe('VizHeatmap', () => {
  it('puts labels in rows and datasets in columns', () => {
    const wrapper = render(byPrompt)
    expect(rowHeaders(wrapper)).toEqual(['best crm', 'crm for startups'])
    expect(columnHeaders(wrapper)).toEqual(['ChatGPT', 'Claude', 'Gemini'])
  })

  it('puts datasets in rows and dates in columns over time', () => {
    const wrapper = render(overTime)
    expect(rowHeaders(wrapper)).toEqual(['ChatGPT', 'Claude'])
    expect(columnHeaders(wrapper)).toEqual(['1 Oct', '2 Oct', '3 Oct'])
  })

  it('shades values by bin with the bin ink', () => {
    const cells = render(byPrompt).findAll('td')
    expect(cells[0].text()).toBe('85%')
    expect(cells[0].attributes('style')).toContain('background: var(--viz-seq-5)')
    expect(cells[0].attributes('style')).toContain('color: var(--viz-seq-ink-5)')
    expect(cells[3].attributes('style')).toContain('var(--viz-seq-1)')
  })

  it('prints states as words on their own fills', () => {
    const cells = render(byPrompt).findAll('td')
    expect(cells[1].text()).toBe('Not checked')
    expect(cells[1].classes()).toContain('is-nodata')
    expect(cells[4].text()).toBe('Not named')
    expect(cells[4].classes()).toContain('is-absent')
    expect(cells[2].text()).toBe('Named')
    expect(cells[2].classes()).toContain('is-named')
    expect(render(overTime).findAll('td')[1].text()).toBe('No data')
  })

  it('labels every cell with its row, column and text', () => {
    const cells = render(byPrompt).findAll('td')
    expect(cells[0].attributes('aria-label')).toBe('best crm, ChatGPT: 85%')
    expect(cells[4].attributes('aria-label')).toBe('crm for startups, Claude: Not named')
  })

  it('moves a single tab stop with the arrow keys', async () => {
    const wrapper = render(byPrompt)
    const cells = () => wrapper.findAll('td')
    expect(cells().filter((c) => c.attributes('tabindex') === '0')).toHaveLength(1)
    cells()[0].element.focus()
    await cells()[0].trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cells()[1].element)
    await cells()[1].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cells()[4].element)
    await cells()[4].trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(cells()[5].element)
    await cells()[5].trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(cells()[3].element)
    expect(cells()[3].attributes('tabindex')).toBe('0')
  })

  it('selects a row from its header by click or keyboard, when someone listens', async () => {
    const wrapper = render(byPrompt, { selectable: true, selected: 'p2' })
    const buttons = wrapper.findAll('.viz-heat-row-btn')
    expect(buttons.map((b) => b.text())).toEqual(['best crm', 'crm for startups'])
    expect(wrapper.findAll('tbody tr')[1].classes()).toContain('is-selected')
    await buttons[0].trigger('click')
    expect(wrapper.emitted('select')[0]).toEqual([{ label: 'p1', labelIndex: 0, datasetKey: null, value: null, state: null }])

    const cell = wrapper.findAll('td')[0]
    cell.element.focus()
    await cell.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select')).toHaveLength(2)
    expect(wrapper.emitted('select')[1][0]).toMatchObject({ label: 'p1', datasetKey: 'chatgpt', value: 85 })
    await cell.trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons[0].element)
  })

  it('has no row buttons when no one listens', () => {
    expect(render(byPrompt).find('.viz-heat-row-btn').exists()).toBe(false)
  })
})
