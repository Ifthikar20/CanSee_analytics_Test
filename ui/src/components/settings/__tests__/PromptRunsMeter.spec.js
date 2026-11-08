import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import PromptRunsMeter from '@/components/settings/PromptRunsMeter.vue'

enableAutoUnmount(afterEach)

// GET auth/me/ai-usage/ prompt_runs for a free account.
const RUNS = {
  unlimited: false,
  limit: 20,
  used: 7,
  reserved: 0,
  remaining: 13,
  plan: 'free',
  scope: 'account',
  period_start: '2026-11-01T00:00:00+00:00',
  resets_at: '2026-11-30T23:59:59+00:00',
  by_engine: { chatgpt: 4, claude: 3, gemini: 0 },
  by_feature: { audit: 7 },
}

const meter = (runs, planLabel = 'Free') => mount(PromptRunsMeter, { props: { runs, planLabel } })

describe('PromptRunsMeter', () => {
  it('shows runs used, left and when they renew, never dollars', () => {
    const w = meter(RUNS)
    expect(w.find('.prm-title').text()).toBe('Free prompt runs · Free')
    expect(w.find('.prm-amt').text()).toBe('7 of 20 free prompt runs used')
    expect(w.text()).toContain('13 free prompt runs left. They renew on November 30.')
    expect(w.text()).toContain('One prompt run is one prompt answered by one AI engine, shared by all your projects.')
    expect(w.text()).toContain('Used by engine: ChatGPT 4, Claude 3.')
    expect(w.text()).not.toContain('$')
    expect(w.find('.prm-flag').exists()).toBe(false)
  })

  it('draws an accessible bar of what is used, reserved runs included', () => {
    const w = meter({ ...RUNS, used: 5, reserved: 2, remaining: 13 })
    const bar = w.find('[role="progressbar"]')
    expect(bar.attributes('aria-valuenow')).toBe('5')
    expect(bar.attributes('aria-valuemax')).toBe('20')
    expect(bar.attributes('aria-valuetext')).toBe('5 of 20 free prompt runs used')
    expect(bar.attributes('aria-labelledby')).toBe('prm-title')
    expect(w.find('.prm-bar-fill').attributes('style')).toContain('width: 35%')
  })

  it('warns when a quarter or less is left', () => {
    const w = meter({ ...RUNS, used: 15, remaining: 5 })
    expect(w.classes()).toContain('is-warn')
    expect(w.find('.prm-flag').text()).toBe('Few free prompt runs are left this month.')
    // One more than a quarter left: no warning.
    expect(meter({ ...RUNS, used: 14, remaining: 6 }).find('.prm-flag').exists()).toBe(false)
  })

  it('says when they are all used', () => {
    const w = meter({ ...RUNS, used: 20, remaining: 0, by_engine: {} })
    expect(w.classes()).toContain('is-exceeded')
    expect(w.text()).toContain('No free prompt runs left. They renew on November 30.')
    expect(w.find('.prm-flag').text()).toBe(
      'All free prompt runs are used. The AI engines are asked again once they renew; Google results still work.',
    )
    expect(w.find('.prm-bar-fill').attributes('style')).toContain('width: 100%')
    expect(w.text()).not.toContain('Used by engine')
  })

  it.each([
    ['a paid account', { ...RUNS, unlimited: true, limit: null, remaining: null }],
    ['no block', null],
    ['a malformed block', { unlimited: 'no' }],
  ])('shows nothing for %s', (_, runs) => {
    expect(meter(runs).find('.prm').exists()).toBe(false)
  })

  it('leaves out the plan label and the renewal day when it does not know them', () => {
    const w = meter({ ...RUNS, resets_at: '' }, '')
    expect(w.find('.prm-title').text()).toBe('Free prompt runs')
    expect(w.text()).toContain('13 free prompt runs left. One prompt run')
  })
})
