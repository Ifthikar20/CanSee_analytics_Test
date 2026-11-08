// Settings, Usage: a free account sees its prompt runs and a chart of AI
// requests, never dollars; a paid account keeps its dollar allowance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))

const charts = vi.hoisted(() => [])
vi.mock('@/components/charts/VizChart.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'VizChart',
      props: ['spec', 'height', 'headingLevel', 'compact'],
      setup(props) {
        charts.push(props)
        return () => vue.h('div', { class: 'chart-stub' })
      },
    }),
  }
})

const { default: SettingsPage } = await import('../SettingsPage.vue')
const { useAuthStore } = await import('@/stores/auth')

const Blank = defineComponent({ render: () => h('div') })
const Shell = defineComponent({ name: 'SettingsShell', props: ['active'], setup: (_, { slots }) => () => h('div', slots.default?.()) })
const mounted = []

const DAILY = [
  { day: '2026-11-01', calls: 4, tokens: 1200, cost: 0.0123 },
  { day: '2026-11-02', calls: 9, tokens: 5100, cost: 0.42 },
]
const RUNS = {
  unlimited: false,
  limit: 20,
  used: 7,
  reserved: 0,
  remaining: 13,
  resets_at: '2026-11-30T23:59:59+00:00',
  by_engine: { chatgpt: 4, claude: 3 },
  by_feature: {},
}

function usage(extra = {}) {
  return {
    period: { start: '2026-11-01T00:00:00Z', end: '2026-11-30T23:59:59Z' },
    totals: { total_tokens: 6300, calls: 13 },
    daily: DAILY,
    allowance: {
      cap_usd: 3,
      spent_usd: 0.43,
      pct_used: 14,
      used_tokens: 6300,
      warning: false,
      exceeded: false,
      resets_at: '2026-11-30T23:59:59Z',
    },
    ...extra,
  }
}

async function render(payload) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().session = { subscription: { source: 'user' }, limits: { projects: 1 } }
  client.get.mockImplementation((url) =>
    url === '/auth/me/ai-usage/' ? Promise.resolve({ data: payload }) : Promise.reject(new Error(`unexpected GET ${url}`)),
  )
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/settings', name: 'settings', component: Blank }] })
  await router.push({ name: 'settings', query: { section: 'usage' } })
  await router.isReady()
  const wrapper = mount(SettingsPage, { global: { plugins: [pinia, router], stubs: { SettingsShell: Shell } }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  client.get.mockReset()
  charts.length = 0
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('Settings, Usage', () => {
  it('shows a free account its prompt runs and a chart of AI requests, never dollars', async () => {
    const w = await render(usage({ prompt_runs: RUNS }))
    expect(w.find('.prm-amt').text()).toBe('7 of 20 free prompt runs used')
    expect(w.find('.sp-allowance').exists()).toBe(false)
    expect(charts.at(-1).spec).toMatchObject({ value: 'count', datasets: [{ key: 'calls', label: 'AI requests' }] })
    expect(w.text()).toContain('A prompt run counts each prompt answered by one AI engine.')
    expect(w.text()).not.toContain('$')
    expect(w.text()).not.toContain('Costs are calculated')
  })

  it('keeps the dollar allowance and the cost chart for a paid account', async () => {
    const w = await render(usage({ prompt_runs: { ...RUNS, unlimited: true, limit: null, remaining: null } }))
    expect(w.find('.prm').exists()).toBe(false)
    expect(w.find('.sp-allowance-amt').text()).toContain('$0.43 of $3.00')
    expect(charts.at(-1).spec).toMatchObject({ value: 'usd', datasets: [{ key: 'cost' }] })
    expect(w.text()).toContain('Costs are calculated')
  })

  it('keeps the old view when the server sends no runs block', async () => {
    const w = await render(usage())
    expect(w.find('.prm').exists()).toBe(false)
    expect(w.find('.sp-allowance').exists()).toBe(true)
    expect(charts.at(-1).spec.value).toBe('usd')
  })
})
