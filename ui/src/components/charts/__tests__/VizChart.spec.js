import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import VizChart from '@/components/charts/VizChart.vue'

enableAutoUnmount(afterEach)

beforeEach(() => {
  localStorage.clear()
})

const engines = (extra = {}) => ({
  id: 'test.engines',
  title: 'Visibility over time',
  subtitle: 'Share of answers that name you, by engine.',
  x: 'time',
  value: 'percent',
  labels: ['2026-10-01', '2026-10-02', '2026-10-03'],
  datasets: [
    { key: 'chatgpt', label: 'ChatGPT', data: [40, null, 35], entity: 'engine:chatgpt' },
    { key: 'claude', label: 'Claude', data: [20, 25, null], entity: 'engine:claude', states: [null, null, 'not_measured'] },
  ],
  ...extra,
})

function render(props = {}, options = {}) {
  return mount(VizChart, {
    props: { spec: engines(), ...props },
    global: { stubs: { RouterLink: true } },
    ...options,
  })
}

const switchLabels = (wrapper) => wrapper.findAll('[role="radio"]').map((r) => r.text())
const visibleTable = (wrapper) => wrapper.find('table.viz-table')

describe('VizChart', () => {
  it('measures its outer width, so its own narrow padding never flips it back', async () => {
    const original = globalThis.ResizeObserver
    let report = null
    let options = null
    globalThis.ResizeObserver = class {
      constructor(callback) {
        report = callback
      }
      observe(_el, opts) {
        options = opts
      }
      disconnect() {}
    }
    try {
      const wrapper = render()
      expect(options).toEqual({ box: 'border-box' })
      // 590px wide frame: its content box (548px) is under the 560px threshold.
      report([{ contentRect: { width: 548 }, borderBoxSize: [{ inlineSize: 590 }] }])
      await nextTick()
      expect(wrapper.find('figure').classes()).not.toContain('is-narrow')
      report([{ contentRect: { width: 520 }, borderBoxSize: [{ inlineSize: 552 }] }])
      await nextTick()
      expect(wrapper.find('figure').classes()).toContain('is-narrow')
      // Its narrower padding widens the content box; the frame stays narrow.
      report([{ contentRect: { width: 528 }, borderBoxSize: [{ inlineSize: 552 }] }])
      await nextTick()
      expect(wrapper.find('figure').classes()).toContain('is-narrow')
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  it('renders the title at the requested level and the subtitle', () => {
    const wrapper = render({ headingLevel: 2 })
    expect(wrapper.find('h2').text()).toBe('Visibility over time')
    expect(wrapper.text()).toContain('Share of answers that name you, by engine.')
    expect(wrapper.find('figure').attributes('aria-labelledby')).toBe(wrapper.find('h2').attributes('id'))
  })

  it('offers exactly the representations that suit the spec', () => {
    expect(switchLabels(render())).toEqual(['Line', 'Area', 'Bars', 'Heatmap', 'Table'])
    const custom = render({ spec: { ...engines(), representations: ['custom', 'table'], custom_label: 'Map' } })
    expect(switchLabels(custom)).toEqual(['Map', 'Table'])
  })

  it('hides the switcher when the table is the only view', () => {
    const wrapper = render({
      spec: { title: 'Rank', value: 'rank', labels: ['a'], datasets: [{ key: 'r', label: 'Rank', data: [3] }] },
    })
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
    expect(visibleTable(wrapper).text()).toContain('#3')
  })

  it('remembers the choice by key across a remount', async () => {
    const first = render()
    await first.findAll('[role="radio"]').find((r) => r.text() === 'Table').trigger('click')
    expect(first.emitted('update:representation')).toEqual([['table']])
    expect(JSON.parse(localStorage.getItem('cs-viz-v1'))).toEqual({ 'test.engines': 'table' })
    expect(visibleTable(first).exists()).toBe(true)
    first.unmount()

    const second = render()
    expect(visibleTable(second).exists()).toBe(true)
    expect(second.find('[role="radio"][aria-checked="true"]').text()).toBe('Table')

    const other = render({ persistKey: 'somewhere.else' })
    expect(visibleTable(other).exists()).toBe(false)
  })

  it('survives broken storage', () => {
    localStorage.setItem('cs-viz-v1', '{not json')
    const wrapper = render()
    expect(wrapper.find('[role="radio"][aria-checked="true"]').text()).toBe('Line')
  })

  it('follows v-model:representation', async () => {
    const wrapper = render({ representation: 'heatmap' })
    expect(wrapper.find('table.viz-heat').exists()).toBe(true)
    await wrapper.setProps({ representation: 'table' })
    expect(visibleTable(wrapper).exists()).toBe(true)
  })

  it('reads values and state words in the table view', () => {
    const wrapper = render({ representation: 'table' })
    const rows = visibleTable(wrapper).findAll('tbody tr').map((tr) => tr.findAll('th, td').map((c) => c.text()))
    expect(rows).toEqual([
      ['1 Oct', '40%', '20%'],
      ['2 Oct', 'No data', '25%'],
      ['3 Oct', '35%', 'Not measured'],
    ])
  })

  it('keeps a screen-reader table beside every other view', () => {
    const wrapper = render()
    const hidden = wrapper.find('.viz-sr-only table')
    expect(hidden.exists()).toBe(true)
    expect(hidden.find('caption').text()).toBe('Visibility over time')
    expect(hidden.text()).toContain('Not measured')
    expect(render({ representation: 'table' }).find('.viz-sr-only table').exists()).toBe(false)
  })

  it('shows a legend for two or more series only', () => {
    const two = render()
    expect(two.findAll('.viz-legend-item').map((i) => i.text())).toEqual(['ChatGPT', 'Claude'])
    const one = render({
      spec: engines({ datasets: [{ key: 'chatgpt', label: 'ChatGPT', data: [40, 30, 20] }] }),
    })
    expect(one.find('.viz-legend').exists()).toBe(false)
  })

  it('toggles a series from the legend but never hides the last one', async () => {
    const wrapper = render()
    const buttons = () => wrapper.findAll('.viz-legend-btn')
    await buttons()[1].trigger('click')
    expect(buttons()[1].attributes('aria-pressed')).toBe('false')
    await buttons()[0].trigger('click')
    expect(buttons()[0].attributes('aria-pressed')).toBe('true')
    await buttons()[1].trigger('click')
    expect(buttons()[1].attributes('aria-pressed')).toBe('true')
  })

  it('shows a skeleton on the first load, then keeps the frame dimmed while refetching', async () => {
    const wrapper = render({ loading: true })
    expect(wrapper.find('.viz-skeleton').exists()).toBe(true)
    expect(wrapper.find('.viz-body').exists()).toBe(false)

    await wrapper.setProps({ loading: false })
    expect(wrapper.find('.viz-skeleton').exists()).toBe(false)
    expect(wrapper.find('.viz-body').classes()).not.toContain('is-busy')

    await wrapper.setProps({ loading: true })
    expect(wrapper.find('.viz-skeleton').exists()).toBe(false)
    expect(wrapper.find('.viz-body').classes()).toContain('is-busy')
    expect(wrapper.find('.viz-body').attributes('aria-busy')).toBe('true')
  })

  it('replaces the body with the error and emits retry', async () => {
    const wrapper = render({ error: "We couldn't load visibility." })
    expect(wrapper.find('.viz-body').exists()).toBe(false)
    expect(wrapper.find('.viz-state').text()).toContain("We couldn't load visibility.")
    await wrapper.find('.viz-state button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('shows the empty state with its copy and action', () => {
    const wrapper = render({
      empty: { title: 'No AI answers in the last 30 days.', body: 'Answers appear after the engines are asked.', action: { label: 'Go to Overview', to: '/' } },
    })
    expect(wrapper.find('.viz-body').exists()).toBe(false)
    expect(wrapper.find('.viz-state').text()).toContain('No AI answers in the last 30 days.')
    expect(wrapper.find('.viz-state').text()).toContain('Answers appear after the engines are asked.')
    expect(wrapper.findComponent({ name: 'RouterLink' }).exists()).toBe(true)
  })

  it('uses the empty kind, and retries from an empty action without a destination', async () => {
    const wrapper = render({
      empty: { kind: 'error', title: "We couldn't reach Cloudflare just now.", body: 'Try again in a minute.', action: { label: 'Try again' } },
    })
    expect(wrapper.find('.viz-state').classes()).toContain('is-error')
    await wrapper.find('.viz-state button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('renders the empty slot instead when given', () => {
    const wrapper = render({ empty: { title: 'x' } }, { slots: { empty: '<p class="own-empty">Nothing yet</p>' } })
    expect(wrapper.find('.own-empty').text()).toBe('Nothing yet')
  })

  it('says there is no data when the spec has nothing to draw', () => {
    const wrapper = render({ spec: { title: 'Empty', labels: ['a'], datasets: [{ key: 'a', data: [null] }] } })
    expect(wrapper.find('h3').text()).toBe('Empty')
    expect(wrapper.find('.viz-state').text()).toContain('No data')
  })

  it('draws one dataset at a time with a Show picker', async () => {
    const wrapper = render({
      spec: {
        id: 'test.by_engine',
        title: 'By engine',
        pick_one: true,
        labels: ['ChatGPT', 'Claude'],
        datasets: [
          { key: 'vis', label: 'AI visibility', data: [40, 20], value: 'percent' },
          { key: 'rank', label: 'Avg. rank when named', data: [2, 3.5], value: 'rank' },
        ],
      },
    })
    const select = wrapper.find('select')
    expect(select.findAll('option').map((o) => o.text())).toEqual(['AI visibility', 'Avg. rank when named'])
    expect(switchLabels(wrapper)).toEqual(['Bars', 'Table'])
    expect(wrapper.find('.viz-legend').exists()).toBe(false)

    await select.setValue('rank')
    // Ranks offer only the table, so the chart falls back to it.
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
    expect(visibleTable(wrapper).text()).toContain('#3.5')
    // The table view shows every dataset in its own kind.
    expect(visibleTable(wrapper).text()).toContain('40%')
  })

  it('shows the world map with a scale legend and a picker for several datasets', async () => {
    const wrapper = render({
      spec: {
        title: 'Rankings by country',
        x: 'country',
        pick_one: true,
        labels: ['gb', 'de'],
        label_names: { gb: 'United Kingdom', de: 'Germany' },
        datasets: [
          { key: 'ai', label: 'AI visibility', data: [40, null], value: 'percent', states: [null, 'not_checked'] },
          { key: 'google', label: 'Google position', data: [4, null], value: 'rank', states: [null, 'not_found'] },
        ],
        state_labels: { not_found: 'Not in top 10' },
      },
    })
    // The map and its geometry load lazily.
    await vi.waitFor(() => expect(wrapper.find('svg.viz-geo-svg').exists()).toBe(true))
    expect(wrapper.findAll('path.viz-geo-country')).toHaveLength(176)
    expect(wrapper.find('[data-code="GB"]').attributes('aria-label')).toBe('United Kingdom: 40%')
    expect(wrapper.find('svg').attributes('aria-label')).toBe('Rankings by country')
    const scale = wrapper.find('.viz-scale').text()
    expect(scale).toContain('0-19%')
    expect(scale).toContain('Not checked')
    expect(scale).toContain('No data')
    expect(wrapper.find('select').exists()).toBe(true)
    expect(wrapper.find('.viz-sr-only table').exists()).toBe(true)
    expect(switchLabels(wrapper)).toEqual(['Map', 'Bars', 'Table'])
  })

  it('keeps a narrow map a map', async () => {
    const original = globalThis.ResizeObserver
    let report = null
    globalThis.ResizeObserver = class {
      constructor(callback) {
        report = callback
      }
      observe() {}
      disconnect() {}
    }
    try {
      const wrapper = render({
        spec: { title: 'Visitors by country', x: 'country', value: 'count', labels: ['us'], datasets: [{ key: 'v', data: [30] }] },
      })
      report([{ borderBoxSize: [{ inlineSize: 340 }] }])
      await nextTick()
      expect(wrapper.find('figure').classes()).toContain('is-narrow')
      expect(wrapper.find('[role="radio"][aria-checked="true"]').text()).toBe('Map')
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  it('hides the representation switcher on request and keeps the screen-reader table', () => {
    const wrapper = render({ hideSwitcher: true })
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
    expect(wrapper.find('h3').text()).toBe('Visibility over time')
    expect(wrapper.find('.viz-sr-only table').exists()).toBe(true)
    const bare = render({ hideSwitcher: true, spec: { ...engines(), title: '', subtitle: '' } })
    expect(bare.find('.viz-head').exists()).toBe(false)
  })

  it('emits select from a heatmap row when someone listens', async () => {
    const onSelect = []
    const wrapper = render({
      spec: {
        title: 'By prompt',
        type: 'heatmap',
        value: 'percent',
        labels: ['p1', 'p2'],
        label_names: { p1: 'best crm', p2: 'crm for startups' },
        datasets: [
          { key: 'chatgpt', label: 'ChatGPT', data: [40, 10] },
          { key: 'claude', label: 'Claude', data: [null, 30], states: ['not_checked', null] },
        ],
      },
      onSelect: (payload) => onSelect.push(payload),
    })
    expect(wrapper.find('table.viz-heat').exists()).toBe(true)
    await wrapper.findAll('.viz-heat-row-btn')[1].trigger('click')
    expect(onSelect).toEqual([{ label: 'p2', labelIndex: 1, datasetKey: null, value: null, state: null }])
  })

  it('shows the footnote and how many series were kept', () => {
    const datasets = Array.from({ length: 10 }, (_, i) => ({ key: `d${i}`, label: `D${i}`, data: [i + 1, i + 2, i + 3] }))
    const wrapper = render({ spec: engines({ datasets, footnote: 'Days without answers are gaps.' }) })
    const foot = wrapper.find('.viz-foot').text()
    expect(foot).toContain('Days without answers are gaps.')
    expect(foot).toContain('Showing 8 of 10 series.')
  })

  it('switches with the arrow keys', async () => {
    const wrapper = render({}, { attachTo: document.body })
    await nextTick()
    const settle = async () => {
      await nextTick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
    const checked = wrapper.find('[role="radio"][aria-checked="true"]')
    checked.element.focus()
    await settle()
    await checked.trigger('keydown', { key: 'ArrowRight' })
    await settle()
    await checked.trigger('keyup', { key: 'ArrowRight' })
    expect(wrapper.find('[role="radio"][aria-checked="true"]').text()).toBe('Area')
  })
})
