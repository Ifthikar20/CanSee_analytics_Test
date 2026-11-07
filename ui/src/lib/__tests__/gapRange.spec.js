import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import GapBadge from '@/components/gap/GapBadge.vue'
import { gapDisplay, gapKey, gapValueText } from '@/lib/gap'

// The API's gap when Google was read to the top 10 without finding you:
// your search score is 0 to 55, so the gap is a range.
const sure = { class: 'ai_ahead', value: null, value_min: 45, definite: true, ai_score: 100, search_score: null, search_score_max: 55 }
const unsure = { class: 'no_data', value: null, value_min: null, definite: false, ai_score: 62, search_score: null, search_score_max: 55 }
const exact = { class: 'google_ahead', value: -40, value_min: null, definite: true, ai_score: 40, search_score: 80, search_score_max: null }
const unchecked = { class: 'no_data', value: null, value_min: null, definite: false, ai_score: 70, search_score: null, search_score_max: null }

describe('gap ranges', () => {
  it('keys a range that spans two classes as not definite, and nothing else', () => {
    expect([sure, unsure, exact, unchecked].map(gapKey)).toEqual(['ai_ahead', 'not_definite', 'google_ahead', 'no_data'])
    expect(gapDisplay(unsure).label).toBe('Not definite')
    expect(gapDisplay(unchecked).label).toBe('Not checked')
  })

  it('shows a lower bound for a definite range and never invents an exact value', () => {
    expect(gapValueText(sure)).toBe('≥ +45')
    expect(gapValueText(exact)).toBe('-40')
    expect(gapValueText(unsure)).toBe('')
  })

  it('renders the badge from the whole gap', () => {
    expect(mount(GapBadge, { props: { gap: sure, showValue: true } }).text()).toBe('AI ahead ≥ +45')
    expect(mount(GapBadge, { props: { gap: unsure, showValue: true } }).text()).toBe('Not definite')
    // The older props still work for callers that pass a class and a value.
    expect(mount(GapBadge, { props: { cls: 'ai_ahead', value: 30, showValue: true } }).text()).toBe('AI ahead +30')
  })
})
