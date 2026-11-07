import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import ChartBlock from '@/components/agent/message/ChartBlock.vue'
import VizChart from '@/components/charts/VizChart.vue'

enableAutoUnmount(afterEach)

beforeEach(() => {
  localStorage.clear()
})

const spec = {
  type: 'bar',
  title: 'Visibility by engine',
  unit: '%',
  labels: ['ChatGPT', 'Claude', 'Gemini'],
  datasets: [{ label: 'Visibility', data: [42, 17.5, null] }],
}

describe('ChartBlock', () => {
  it('renders the shared VizChart with the converted spec', () => {
    const wrapper = mount(ChartBlock, { props: { spec } })
    expect(wrapper.classes()).toContain('ag-chart')
    const chart = wrapper.findComponent(VizChart)
    expect(chart.exists()).toBe(true)
    expect(chart.props()).toMatchObject({ compact: true, height: 220, surface: 'var(--ag-pane-bg)', headingLevel: 4 })
    expect(chart.props('spec')).toMatchObject({ value: 'percent', type: 'bar', labels: spec.labels })
    expect(wrapper.find('h4').text()).toBe('Visibility by engine')
    expect(wrapper.findAll('[role="radio"]').map((r) => r.text())).toEqual(['Bars', 'Table'])
  })

  it('renders nothing for a spec with nothing to plot', () => {
    expect(mount(ChartBlock, { props: { spec: { type: 'bar', labels: [], datasets: [] } } }).html()).toBe('<!--v-if-->')
    expect(mount(ChartBlock, { props: { spec: null } }).html()).toBe('<!--v-if-->')
  })

  it('shows the numbers when switched to the table, and persists nothing', async () => {
    const wrapper = mount(ChartBlock, { props: { spec } })
    await wrapper.findAll('[role="radio"]').find((r) => r.text() === 'Table').trigger('click')
    const rows = wrapper.findAll('table.viz-table tbody tr').map((tr) => tr.findAll('th, td').map((c) => c.text()))
    expect(rows).toEqual([
      ['ChatGPT', '42%'],
      ['Claude', '18%'],
      ['Gemini', 'No data'],
    ])
    expect(localStorage.getItem('cs-viz-v1')).toBe(null)
  })

  it('keeps a screen-reader table beside the bars', () => {
    const wrapper = mount(ChartBlock, { props: { spec } })
    expect(wrapper.find('.viz-sr-only table caption').text()).toBe('Visibility by engine')
  })
})
