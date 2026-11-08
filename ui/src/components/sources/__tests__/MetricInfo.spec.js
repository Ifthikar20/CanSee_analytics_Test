import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import MetricInfo from '../MetricInfo.vue'

enableAutoUnmount(afterEach)

describe('MetricInfo', () => {
  it('is a HelpTip: named, described, and opened by a tap without a provider', async () => {
    const w = mount(MetricInfo, { props: { text: 'Share of answers that cite this URL.' }, attachTo: document.body })
    const button = w.find('button')
    expect(button.attributes('aria-label')).toBe('What does this metric mean?')
    expect(document.getElementById(button.attributes('aria-describedby')).textContent).toBe('Share of answers that cite this URL.')
    await button.trigger('pointerdown', { pointerType: 'touch' })
    await button.trigger('click')
    await flushPromises()
    const tip = document.body.querySelector('.cs-tooltip')
    expect(tip.textContent).toContain('Share of answers that cite this URL.')
    expect(tip.getAttribute('data-side')).toBe('top')
  })
})
