import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useHelpStore } from '@/stores/help'
import HelpMenu from '../HelpMenu.vue'

enableAutoUnmount(afterEach)

function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(HelpMenu, { global: { plugins: [pinia] }, attachTo: document.body })
  return { wrapper, help: useHelpStore() }
}

describe('HelpMenu', () => {
  it('is one labelled button that toggles the help drawer', async () => {
    const { wrapper, help } = setup()
    const button = wrapper.get('button')
    expect(button.attributes('aria-label')).toBe('Help')
    expect(button.attributes('aria-haspopup')).toBe('dialog')
    expect(button.attributes('aria-keyshortcuts')).toBe('Shift+?')
    expect(button.attributes('aria-expanded')).toBe('false')

    await button.trigger('click')
    expect(help.isOpen).toBe(true)
    expect(button.attributes('aria-expanded')).toBe('true')

    await button.trigger('click')
    expect(help.isOpen).toBe(false)
    expect(button.attributes('aria-expanded')).toBe('false')
  })

  it('shows the drawer state when the drawer opens another way', async () => {
    const { wrapper, help } = setup()
    help.open()
    await wrapper.vm.$nextTick()
    expect(wrapper.get('button').attributes('data-state')).toBe('open')
  })
})
