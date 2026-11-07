import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import VizSwitcher from '@/components/charts/VizSwitcher.vue'

enableAutoUnmount(afterEach)

const OPTIONS = [
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bars' },
  { value: 'table', label: 'Table' },
]

const settle = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('VizSwitcher', () => {
  it('is a labelled radio group of words', () => {
    const wrapper = mount(VizSwitcher, { props: { modelValue: 'bar', options: OPTIONS } })
    const group = wrapper.find('[role="radiogroup"]')
    expect(group.attributes('aria-label')).toBe('Chart type')
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map((r) => r.text())).toEqual(['Line', 'Bars', 'Table'])
    expect(radios.map((r) => r.attributes('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('is one tab stop that lands on the checked item', async () => {
    const wrapper = mount(VizSwitcher, { props: { modelValue: 'bar', options: OPTIONS }, attachTo: document.body })
    await nextTick()
    const group = wrapper.find('[role="radiogroup"]')
    expect(group.attributes('tabindex')).toBe('0')
    expect(wrapper.findAll('[role="radio"]').every((r) => r.attributes('tabindex') === '-1')).toBe(true)
    group.element.focus()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.findAll('[role="radio"]')[1].element)
  })

  it('emits the clicked representation', async () => {
    const wrapper = mount(VizSwitcher, { props: { modelValue: 'line', options: OPTIONS } })
    await wrapper.findAll('[role="radio"]')[2].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['table']])
  })

  it('moves and selects with the arrow keys', async () => {
    const wrapper = mount(VizSwitcher, { props: { modelValue: 'line', options: OPTIONS }, attachTo: document.body })
    await nextTick()
    const radios = wrapper.findAll('[role="radio"]')
    radios[0].element.focus()
    await settle()

    await radios[0].trigger('keydown', { key: 'ArrowRight' })
    await settle()
    await radios[1].trigger('keyup', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radios[1].element)
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['bar'])

    await radios[1].trigger('keydown', { key: 'ArrowLeft' })
    await settle()
    expect(document.activeElement).toBe(radios[0].element)
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['line'])
  })
})
