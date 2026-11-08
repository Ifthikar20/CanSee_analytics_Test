import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import AgentSetupStrip from '../AgentSetupStrip.vue'

enableAutoUnmount(afterEach)

// A production build: setting names only when the server sends them.
beforeEach(() => vi.stubEnv('DEV', false))
afterEach(() => vi.unstubAllEnvs())

const ENGINES = [
  { key: 'chatgpt', label: 'ChatGPT', configured: true, key_setting: '' },
  { key: 'claude', label: 'Claude', configured: true, key_setting: '' },
  { key: 'gemini', label: 'Gemini', configured: false, key_setting: '' },
  { key: 'grok', label: 'Grok', configured: false, key_setting: '' },
  { key: 'perplexity', label: 'Perplexity', configured: false, key_setting: '' },
]
const FREE = {
  enabled: true,
  configured: true,
  live_available: true,
  engines: ENGINES,
  google: { configured: false, key_settings: [], reliable_pages: 0 },
  serp_configured: false,
  allowance: { cap_usd: '3.00', spent_usd: '0.40', exceeded: false, show_usd: false },
  prompt_runs: { unlimited: false, limit: 20, used: 7, reserved: 0, remaining: 13 },
}
const PAID = {
  ...FREE,
  google: { configured: true, key_settings: [], reliable_pages: 10 },
  serp_configured: true,
  allowance: { cap_usd: '29.25', spent_usd: '3.00', exceeded: false, show_usd: true },
  prompt_runs: { unlimited: true, limit: null, remaining: null },
}

async function mountStrip(props) {
  const w = mount(AgentSetupStrip, { props, attachTo: document.body })
  await flushPromises()
  return w
}

const row = (w, label) => w.findAll('.ag-setup-row').find((r) => r.find('dt').text() === label)

describe('AgentSetupStrip', () => {
  it('shows nothing without a status', async () => {
    const w = await mountStrip({ status: null })
    expect(w.find('.ag-setup').exists()).toBe(false)
  })

  it('tells a free customer what is set up in plain words, with prompt runs and no dollars', async () => {
    const w = await mountStrip({ status: FREE })
    expect(w.find('h2').text()).toBe('Set up on this workspace')
    expect(row(w, 'Google results').find('dd').text()).toBe('Not set up')
    const engines = row(w, 'AI engines').find('dd').text()
    expect(engines).toContain('ChatGPT and Claude')
    expect(engines).toContain('Not set up: Gemini, Grok and Perplexity')
    expect(row(w, 'Free prompt runs').find('dd').text()).toBe('13 free prompt runs left this month')
    expect(w.text()).not.toMatch(/\$/)
    expect(w.text()).not.toMatch(/_KEY|Setting/)
    expect(row(w, 'AI allowance')).toBeUndefined()
  })

  it('shows a paid account its allowance in dollars', async () => {
    const w = await mountStrip({ status: PAID })
    expect(row(w, 'Google results').find('dd').text()).toBe('Set up')
    expect(row(w, 'AI allowance').find('dd').text()).toBe('$26.25 of AI allowance left this month')
    expect(row(w, 'Free prompt runs')).toBeUndefined()
  })

  it('names the settings for staff (the server sends them)', async () => {
    const staff = {
      ...FREE,
      engines: ENGINES.map((e) => ({ ...e, key_setting: e.configured ? '' : `${e.key.toUpperCase()}_API_KEY` })),
      google: { configured: false, key_settings: ['SERPAPI_KEY', 'SCRAPERAPI_KEY'] },
    }
    const w = await mountStrip({ status: staff })
    expect(row(w, 'Google results').text()).toContain('Setting: SERPAPI_KEY or SCRAPERAPI_KEY.')
    expect(row(w, 'AI engines').text()).toContain('Settings: GEMINI_API_KEY, GROK_API_KEY, PERPLEXITY_API_KEY.')
  })

  it('shows every setting on a local dev build', async () => {
    vi.stubEnv('DEV', true)
    const w = await mountStrip({ status: FREE })
    expect(row(w, 'Google results').text()).toContain('Setting: SERPAPI_KEY or SCRAPERAPI_KEY.')
  })

  it('says when no engine is set up, and when Google covers page one only', async () => {
    const w = await mountStrip({
      status: { ...PAID, engines: ENGINES.map((e) => ({ ...e, configured: false })), google: { configured: true, reliable_pages: 1, key_settings: [] } },
    })
    expect(row(w, 'AI engines').find('dd').text()).toBe('None set up')
    expect(row(w, 'Google results').find('dd').text()).toBe('Set up, page one only')
  })

  it('leaves out rows the server does not send', async () => {
    const w = await mountStrip({ status: { enabled: true, allowance: { cap_usd: '5', spent_usd: '1' } } })
    expect(w.find('.ag-setup').exists()).toBe(false)
  })

  it('says what stops every agent, what to do, and checks again', async () => {
    const block = {
      code: 'agent_unavailable',
      title: "The AI agent isn't running right now.",
      action: 'Try again in a minute. If it stays down, contact support.',
      setting: '',
    }
    const w = await mountStrip({ status: { ...FREE, live_available: false }, block })
    const notice = w.find('.ag-setup-block')
    expect(notice.attributes('role')).toBe('status')
    expect(notice.text()).toContain("The AI agent isn't running right now.")
    expect(notice.text()).toContain('Try again in a minute. If it stays down, contact support.')
    await notice.find('button').trigger('click')
    expect(w.emitted('refresh')).toHaveLength(1)
    await w.setProps({ checking: true })
    expect(notice.find('button').attributes('aria-busy')).toBe('true')
  })

  it('explains itself in a HelpTip', async () => {
    const w = await mountStrip({ status: FREE })
    const tip = w.find('.ag-setup-head button.cs-helptip')
    expect(tip.attributes('aria-label')).toBe('About what is set up')
    expect(document.getElementById(tip.attributes('aria-describedby')).textContent).toMatch(/never as not mentioning you/)
  })
})
