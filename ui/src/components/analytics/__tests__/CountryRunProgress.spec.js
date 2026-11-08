import { afterEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { useAuthStore } from '@/stores/auth'
import CountryRunProgress from '../CountryRunProgress.vue'
import { countryRun, finishedRun } from '@/pages/analytics/__tests__/__fixtures__/analyticsPayloads'

const mounted = []

function setup(props) {
  const wrapper = mount(CountryRunProgress, { props, attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

function session(promptRuns) {
  setActivePinia(createPinia())
  useAuthStore().session = { limits: { prompt_runs: promptRuns } }
}

const FREE = { unlimited: false, limit: 20, used: 3, reserved: 0, remaining: 17 }
const PAID = { unlimited: true, limit: null, used: 0, reserved: 0, remaining: null }

// A SerpAPI run that asked engines: both a Google and an AI dollar amount.
const serpRun = (overrides = {}) =>
  finishedRun({
    provider: 'serpapi',
    cost: { google_pages_fetched: 2, scraperapi_credits: null, google_usd: '0.0300', ai_usd: '0.0712' },
    ...overrides,
  })

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('CountryRunProgress cost line', () => {
  it('shows no dollars to a free account, only the Google pages used', () => {
    session(FREE)
    const wrapper = setup({ run: serpRun() })
    expect(wrapper.find('.crp-cost').text()).toBe('Used 2 Google pages.')
    expect(wrapper.text()).not.toContain('$')
    expect(wrapper.text()).not.toContain('AI allowance')
  })

  it('shows no cost line to a free account when only engines were asked', () => {
    session(FREE)
    const wrapper = setup({ run: serpRun({ include_google: false }) })
    expect(wrapper.find('.crp-cost').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('$')
  })

  it('shows no dollars to a free account with no runs left', () => {
    session({ ...FREE, used: 20, remaining: 0 })
    const wrapper = setup({ run: serpRun() })
    expect(wrapper.text()).not.toContain('$')
  })

  it('keeps the Google and AI dollar line for a paid account', () => {
    session(PAID)
    const wrapper = setup({ run: serpRun() })
    expect(wrapper.find('.crp-cost').text()).toBe('Used 2 Google pages ($0.03) and $0.07 of AI allowance.')
  })

  it('keeps the dollar line when the session does not say (no runs block)', () => {
    session(undefined)
    const wrapper = setup({ run: serpRun() })
    expect(wrapper.find('.crp-cost').text()).toContain('$0.07 of AI allowance')
  })

  it('shows no cost line while the run is still going', () => {
    session(PAID)
    const wrapper = setup({ run: countryRun() })
    expect(wrapper.find('.crp-cost').exists()).toBe(false)
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true)
  })
})
