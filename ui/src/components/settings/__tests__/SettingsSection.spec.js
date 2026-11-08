import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import SettingsSection from '../SettingsSection.vue'

enableAutoUnmount(afterEach)

describe('SettingsSection', () => {
  it('adds a help icon beside the title only when given help', () => {
    const plain = mount(SettingsSection, { props: { title: 'Website traffic', description: 'Where Cansee reads your visitors.' } })
    expect(plain.find('h3.sc-title').text()).toBe('Website traffic')
    expect(plain.find('.cs-helptip').exists()).toBe(false)

    const helped = mount(SettingsSection, {
      props: { title: 'Website traffic', help: 'Each source counts something different.' },
      attachTo: document.body,
    })
    expect(helped.find('h3.sc-title').text()).toBe('Website traffic')
    const tip = helped.find('.sc-title-row button.cs-helptip')
    expect(tip.attributes('aria-label')).toBe('About Website traffic')
    expect(document.getElementById(tip.attributes('aria-describedby')).textContent).toBe(
      'Each source counts something different.',
    )
  })
})
