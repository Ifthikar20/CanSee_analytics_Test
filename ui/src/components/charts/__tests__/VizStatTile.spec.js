import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { ArrowDown, ArrowUp, Minus } from '@lucide/vue'
import VizStatTile from '@/components/charts/VizStatTile.vue'

enableAutoUnmount(afterEach)

const render = (props) => mount(VizStatTile, { props: { label: 'AI visibility', ...props } })

describe('VizStatTile', () => {
  it('formats the value by its kind', () => {
    expect(render({ value: 34.2, kind: 'percent' }).find('.viz-stat-value').text()).toBe('34%')
    expect(render({ value: 3.2, kind: 'rank' }).find('.viz-stat-value').text()).toBe('#3.2')
    expect(render({ value: 1204, kind: 'count' }).find('.viz-stat-value').text()).toBe('1,204')
    expect(render({ value: 12900, kind: 'count' }).find('.viz-stat-value').text()).toBe('12.9K')
    expect(render({ value: '12 of 340' }).find('.viz-stat-value').text()).toBe('12 of 340')
  })

  it('shows a measured zero as 0', () => {
    expect(render({ value: 0, kind: 'count' }).find('.viz-stat-value').text()).toBe('0')
  })

  it('shows the state word, not a number, when nothing was measured', () => {
    const wrapper = render({ value: null, kind: 'percent', stateText: 'No answers' })
    expect(wrapper.find('.viz-stat-value').exists()).toBe(false)
    expect(wrapper.find('.viz-stat-state').text()).toBe('No answers')
    expect(render({ value: null }).find('.viz-stat-state').text()).toBe('Not measured')
  })

  it('draws a rise that is good with an up arrow, its text and the good colour', () => {
    const wrapper = render({
      value: 34.2,
      kind: 'percent',
      delta: { value: 4.1, unit: 'pts', label: 'vs previous 30 days', goodWhen: 'up' },
    })
    const delta = wrapper.find('.viz-stat-delta')
    expect(delta.text()).toBe('+4.1 pts vs previous 30 days')
    expect(delta.classes()).toContain('is-good')
    expect(wrapper.findComponent(ArrowUp).exists()).toBe(true)
  })

  it('draws a rank that went down as good when lower is better', () => {
    const wrapper = render({
      label: 'Avg. rank when named',
      value: 3.2,
      kind: 'rank',
      delta: { value: -0.6, unit: 'rank', label: 'vs previous 30 days', goodWhen: 'down' },
    })
    const delta = wrapper.find('.viz-stat-delta')
    expect(delta.text()).toBe('−0.6 vs previous 30 days')
    expect(delta.classes()).toContain('is-good')
    expect(wrapper.findComponent(ArrowDown).exists()).toBe(true)
  })

  it('draws a fall that is bad with a down arrow and the critical colour', () => {
    const wrapper = render({
      value: 120,
      kind: 'count',
      delta: { value: -12.7, unit: 'pct', label: 'vs previous 30 days', goodWhen: 'up' },
    })
    expect(wrapper.find('.viz-stat-delta').text()).toBe('−12.7% vs previous 30 days')
    expect(wrapper.find('.viz-stat-delta').classes()).toContain('is-bad')
    expect(wrapper.findComponent(ArrowDown).exists()).toBe(true)
  })

  it('draws no change flat', () => {
    const wrapper = render({ value: 5, kind: 'count', delta: { value: 0, unit: 'pct', label: 'vs previous 7 days' } })
    expect(wrapper.find('.viz-stat-delta').classes()).toContain('is-flat')
    expect(wrapper.findComponent(Minus).exists()).toBe(true)
  })

  it('has no delta line without a value or a known change', () => {
    expect(render({ value: null, delta: { value: 4, unit: 'pts' } }).find('.viz-stat-delta').exists()).toBe(false)
    expect(render({ value: 4, delta: { value: null, unit: 'pts' } }).find('.viz-stat-delta').exists()).toBe(false)
  })

  it('shows the hint, the identity dot and a sparkline', () => {
    const wrapper = render({ value: 3, hint: 'AI ranks you higher', tone: 'var(--gap-ai)', spark: [1, null, 3, 4] })
    expect(wrapper.find('.viz-stat-hint').text()).toBe('AI ranks you higher')
    expect(wrapper.find('.viz-stat-dot').attributes('style')).toContain('var(--gap-ai)')
    expect(wrapper.find('.viz-stat-spark').exists()).toBe(true)
    expect(wrapper.findAll('.viz-stat-spark path')).toHaveLength(1)
    expect(wrapper.find('.viz-stat-spark circle').exists()).toBe(true)
    expect(render({ value: 3, spark: [null, null] }).find('.viz-stat-spark').exists()).toBe(false)
  })
})
