import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import VizTable from '@/components/charts/VizTable.vue'

enableAutoUnmount(afterEach)

const spec = {
  title: 'By engine',
  labels: ['chatgpt', 'claude', 'gemini'],
  label_names: { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' },
  label_header: 'Engine',
  datasets: [
    { key: 'vis', label: 'AI visibility', data: [40, 62.5, null], value: 'percent', states: [null, null, 'not_configured'] },
    { key: 'rank', label: 'Avg. rank', data: [2.6, 1.4, null], value: 'rank' },
  ],
}

const render = (props = {}) => mount(VizTable, { props: { spec, ...props } })
const rows = (wrapper) => wrapper.findAll('tbody tr').map((tr) => tr.findAll('th, td').map((c) => c.text()))
const header = (wrapper, i) => wrapper.findAll('thead th')[i]

describe('VizTable', () => {
  it('reads as a semantic table with row headers and its caption', () => {
    const wrapper = render()
    expect(wrapper.find('caption').text()).toBe('By engine')
    expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual(['Engine', 'AI visibility', 'Avg. rank'])
    expect(wrapper.findAll('tbody th[scope="row"]')).toHaveLength(3)
    expect(rows(wrapper)).toEqual([
      ['ChatGPT', '40%', '#2.6'],
      ['Claude', '63%', '#1.4'],
      ['Gemini', 'Not configured', 'No data'],
    ])
  })

  it('right-aligns numbers and marks words', () => {
    const cells = render().findAll('tbody td')
    expect(cells[0].classes()).toContain('is-num')
    expect(cells[4].classes()).toContain('is-word')
    expect(cells[0].classes()).not.toContain('is-word')
  })

  it('sorts by a value column, largest first, missing values last', async () => {
    const wrapper = render()
    expect(header(wrapper, 1).attributes('aria-sort')).toBe(undefined)
    await header(wrapper, 1).find('button').trigger('click')
    expect(header(wrapper, 1).attributes('aria-sort')).toBe('descending')
    expect(rows(wrapper).map((r) => r[0])).toEqual(['Claude', 'ChatGPT', 'Gemini'])
    await header(wrapper, 1).find('button').trigger('click')
    expect(header(wrapper, 1).attributes('aria-sort')).toBe('ascending')
    expect(rows(wrapper).map((r) => r[0])).toEqual(['ChatGPT', 'Claude', 'Gemini'])
  })

  it('sorts ranks best first on the first click', async () => {
    const wrapper = render()
    await header(wrapper, 2).find('button').trigger('click')
    expect(header(wrapper, 2).attributes('aria-sort')).toBe('ascending')
    expect(rows(wrapper).map((r) => r[0])).toEqual(['Claude', 'ChatGPT', 'Gemini'])
    expect(header(wrapper, 1).attributes('aria-sort')).toBe(undefined)
  })

  it('sorts names A to Z first', async () => {
    const wrapper = render()
    await header(wrapper, 0).find('button').trigger('click')
    expect(header(wrapper, 0).attributes('aria-sort')).toBe('ascending')
    await header(wrapper, 0).find('button').trigger('click')
    expect(rows(wrapper).map((r) => r[0])).toEqual(['Gemini', 'Claude', 'ChatGPT'])
  })

  it('reads text columns as written and sorts them A to Z', async () => {
    const wrapper = render({
      spec: {
        ...spec,
        datasets: [
          ...spec.datasets,
          { key: 'operator', label: 'Operator', texts: ['OpenAI', 'Anthropic', 'Google'] },
        ],
      },
    })
    expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual(['Engine', 'AI visibility', 'Avg. rank', 'Operator'])
    const cells = wrapper.findAll('tbody tr')[0].findAll('td')
    expect(cells[2].text()).toBe('OpenAI')
    expect(cells[2].classes()).toContain('is-text')
    expect(cells[2].classes()).not.toContain('is-word')
    await header(wrapper, 3).find('button').trigger('click')
    expect(header(wrapper, 3).attributes('aria-sort')).toBe('ascending')
    expect(rows(wrapper).map((r) => r[3])).toEqual(['Anthropic', 'Google', 'OpenAI'])
  })

  it('highlights the selected row', () => {
    const wrapper = render({ selected: 'claude' })
    expect(wrapper.findAll('tbody tr')[1].classes()).toContain('is-selected')
  })

  it('renders a screen-reader copy with no controls', () => {
    const wrapper = render({ srOnly: true })
    expect(wrapper.classes()).toContain('viz-sr-only')
    expect(wrapper.find('table caption').text()).toBe('By engine')
    expect(wrapper.find('button').exists()).toBe(false)
    expect(rows(wrapper)[2]).toEqual(['Gemini', 'Not configured', 'No data'])
  })
})
