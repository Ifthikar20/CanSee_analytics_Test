import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import GapBadge from '../GapBadge.vue'

enableAutoUnmount(afterEach)

describe('GapBadge', () => {
  it('puts the class meaning in a HelpTip on its words, not in title=', () => {
    const w = mount(GapBadge, { props: { cls: 'ai_ahead', value: 30, showValue: true }, attachTo: document.body })
    expect(w.text()).toBe('AI ahead +30')
    expect(w.find('[title]').exists()).toBe(false)
    const trigger = w.find('button.cs-helptip')
    expect(trigger.text()).toBe('AI ahead')
    expect(document.getElementById(trigger.attributes('aria-describedby')).textContent).toBe(
      'AI engines rank you higher than Google does.',
    )
  })

  it('explains a gap that is not definite', () => {
    const gap = { class: 'no_data', value: null, value_min: null, definite: false, ai_score: 62, search_score: null, search_score_max: 55 }
    const w = mount(GapBadge, { props: { gap, showValue: true }, attachTo: document.body })
    expect(w.text()).toBe('Not definite')
    const trigger = w.find('button.cs-helptip')
    expect(document.getElementById(trigger.attributes('aria-describedby')).textContent).toContain(
      'the gap could fall in either of two classes',
    )
  })
})
