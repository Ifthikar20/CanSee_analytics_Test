// What a context build costs, in the dialog and once it ran: dollars for
// paid accounts, never for the Free plan.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import ContextBuildDialog from '@/components/agent/context/ContextBuildDialog.vue'
import ContextBuildProgress from '@/components/agent/context/ContextBuildProgress.vue'
import { useAuthStore } from '@/stores/auth'

const FREE_RUNS = { unlimited: false, limit: 20, used: 2, reserved: 0, remaining: 18 }
const mounted = []

function builder(estimate) {
  return {
    isOpen: ref(false),
    options: ref({ choices: { domain: 'notion.so', documents: [], facts: { approved: 4 } } }),
    estimate: ref(estimate),
    estimating: ref(false),
    canStart: ref(true),
    changedNote: ref(''),
    error: ref(''),
    submitting: ref(false),
    setParams: vi.fn(),
    close: vi.fn(),
    start: vi.fn(),
  }
}

const ESTIMATE = {
  units: { pages: 12, rechecks: 0, documents: 0 },
  ai: { calls_max: 14, usd_max: '0.1200' },
  allowance: { unlimited: false, left_usd: '4.08' },
  warnings: [],
  blockers: [],
}

async function openDialog(estimate, { session = null } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (session) useAuthStore().session = session
  const b = builder(estimate)
  const wrapper = mount(ContextBuildDialog, { props: { builder: b, domain: 'notion.so' }, global: { plugins: [pinia] }, attachTo: document.body })
  mounted.push(wrapper)
  b.isOpen.value = true
  await flushPromises()
  return [...document.body.querySelectorAll('.ag-cbd-line')].map((p) => p.textContent.trim())
}

function progress(run, { session = null } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (session) useAuthStore().session = session
  const wrapper = mount(ContextBuildProgress, { props: { run }, global: { plugins: [pinia] } })
  mounted.push(wrapper)
  return wrapper.find('.ag-cbp-cost').text()
}

const doneRun = (ai) => ({
  status: 'done',
  progress: { total: 3, done: 3 },
  confirmed: { ai_calls: 3 },
  result: { suggested: { audience: 2 } },
  duration_ms: 4000,
  cost: { ai_usd: ai },
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('ContextBuildDialog cost', () => {
  it('states the AI cost in dollars for a paid account', async () => {
    const lines = await openDialog(ESTIMATE)
    expect(lines).toContain('AI: up to 14 requests, up to $0.12 of your AI allowance ($4.08 left this month).')
  })

  it('never shows the Free plan dollars', async () => {
    const lines = await openDialog(ESTIMATE, { session: { limits: { prompt_runs: FREE_RUNS } } })
    expect(lines).toContain("AI: up to 14 requests, from this month's free AI allowance.")
    expect(lines.join(' ')).not.toContain('$')
  })
})

describe('ContextBuildProgress cost', () => {
  it('says what a finished build used, in dollars for a paid account', () => {
    expect(progress(doneRun('0.0400'))).toBe('Used $0.04 of AI allowance.')
  })

  it('says it without dollars on the Free plan, and nothing billed for nothing', () => {
    const session = { limits: { prompt_runs: FREE_RUNS } }
    expect(progress(doneRun('0.0400'), { session })).toBe("Used some of this month's free AI allowance.")
    expect(progress(doneRun('0.0000'), { session })).toBe('Nothing was billed.')
  })
})
