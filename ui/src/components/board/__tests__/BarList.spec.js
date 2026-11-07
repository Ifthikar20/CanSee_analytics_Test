import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import BarList from '../BarList.vue'

enableAutoUnmount(afterEach)

const ITEMS = [
  { key: 'you', label: 'Wrenfield', value: 40, text: '40%', emphasis: true },
  { key: 'b1', label: 'Acme', value: 20, text: '20%', hint: 'acme.test' },
  { key: 'b2', label: 'Zero Co', value: 0, text: '0%' },
  { key: 'b3', label: 'Unchecked', value: null, text: 'Not checked' },
]

const fills = (wrapper) => wrapper.findAll('.bd-bars-fill')

describe('BarList', () => {
  it('draws a bar per measured row against the largest value, with you in the accent', () => {
    const wrapper = mount(BarList, { props: { items: ITEMS, label: 'Share of voice' } })
    const list = wrapper.find('ul')
    expect(list.attributes('role')).toBe('list')
    expect(list.attributes('aria-label')).toBe('Share of voice')
    const rows = wrapper.findAll('li')
    expect(rows).toHaveLength(4)
    expect(rows[0].text()).toContain('Wrenfield')
    expect(rows[0].text()).toContain('40%')
    expect(rows[1].find('.bd-bars-hint').text()).toBe('acme.test')

    // A measured zero has its track and an empty bar; an unmeasured row has neither.
    expect(fills(wrapper).map((f) => f.attributes('style'))).toEqual(['width: 100%;', 'width: 50%;', 'width: 0%;'])
    expect(fills(wrapper)[0].classes()).toContain('is-you')
    expect(fills(wrapper)[1].classes()).not.toContain('is-you')
    expect(rows[3].find('.bd-bars-track').exists()).toBe(false)
    expect(rows[3].find('.bd-bars-value').classes()).toContain('is-none')
    expect(rows[3].text()).toContain('Not checked')
    expect(rows[2].find('.bd-bars-value').classes()).not.toContain('is-none')
    // Bars are decoration; the words carry the values.
    expect(rows[0].find('.bd-bars-track').attributes('aria-hidden')).toBe('true')
  })

  it('takes a fixed maximum (percentages out of 100)', () => {
    const wrapper = mount(BarList, { props: { items: ITEMS, max: 100 } })
    expect(fills(wrapper).map((f) => f.attributes('style'))).toEqual(['width: 40%;', 'width: 20%;', 'width: 0%;'])
  })

  it('has no buttons unless someone listens, and then emits the row key', async () => {
    const still = mount(BarList, { props: { items: ITEMS } })
    expect(still.findAll('button')).toHaveLength(0)

    const keys = []
    const live = mount(BarList, { props: { items: ITEMS, onSelect: (key) => keys.push(key) } })
    const buttons = live.findAll('button')
    expect(buttons).toHaveLength(4)
    expect(buttons[0].attributes('type')).toBe('button')
    await buttons[1].trigger('click')
    expect(keys).toEqual(['b1'])
    expect(live.emitted('select')).toEqual([['b1']])
  })

  it('draws no bars when nothing was measured', () => {
    const wrapper = mount(BarList, { props: { items: [{ key: 'a', label: 'A', value: null, text: 'No answers' }] } })
    expect(fills(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('No answers')
  })
})
