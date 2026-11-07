import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { useAppStore } from '@/stores/app'
import { apiError, run, runEstimate, runOptions } from '@/composables/analytics/__tests__/__fixtures__/insightRuns'

const api = vi.hoisted(() => ({
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}))
vi.mock('@/api/insights', () => ({ default: api }))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { useInsightRun } = await import('@/composables/analytics/useInsightRun')
const { default: InsightRunDialog } = await import('../InsightRunDialog.vue')

const mounted = []

async function setup(kind, { params = {}, extra = null, options = null, estimate = null, vModel = false } = {}) {
  setActivePinia(createPinia())
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://www.notion.so/' }])
  useAppStore().setActiveWebsite({ id: 'w1', name: 'Notion', url: 'https://www.notion.so/' })
  api.runOptions.mockResolvedValue({ data: options || runOptions(kind) })
  api.estimate.mockResolvedValue({ data: estimate || runEstimate(kind) })
  let runner
  const open = ref(false)
  const started = vi.fn()
  const Host = defineComponent({
    setup() {
      runner = useInsightRun(kind, { websiteId: () => 'w1' })
      return () =>
        h(InsightRunDialog, {
          kind,
          extra,
          ...(vModel ? { open: open.value, params, 'onUpdate:open': (v) => (open.value = v) } : {}),
          onStarted: started,
        })
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { runner, wrapper, open, started }
}

async function openWith(ctx, params) {
  ctx.runner.open(params)
  await flushPromises()
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const lines = () => [...document.body.querySelectorAll('.ird-line')].map((p) => p.textContent.trim())
const runButton = () => [...dialog().querySelectorAll('button')].find((b) => /^(Run|Starting)/.test(b.textContent.trim()))

beforeEach(() => {
  vi.useFakeTimers()
  Object.values(api).forEach((fn) => fn.mockReset())
  Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('InsightRunDialog', () => {
  it('answer analysis: title, description, lines, warnings and the run label', async () => {
    const options = runOptions('answer_analysis', {
      choices: {
        named_answers: 52,
        unanalyzed: 40,
        engines: [
          { key: 'chatgpt', label: 'ChatGPT', unanalyzed: 22 },
          { key: 'claude', label: 'Claude', unanalyzed: 18 },
        ],
        prompts: [],
        evidence: { facts: 14, facts_pending: 3, pages_planned: ['https://notion.so/', 'https://notion.so/pricing'] },
      },
    })
    const ctx = await setup('answer_analysis', { options })
    await openWith(ctx, { period: '30d', engines: null, prompt_ids: null, reanalyze: false })
    expect(dialog().textContent).toContain('Analyze AI answers')
    expect(dialog().textContent).toContain(
      'Cansee reads each answer that names you, lists the claims it makes and how it describes you, then checks the claims against your brand facts and your own pages. Nothing runs until you confirm the cost.',
    )
    expect(lines()).toEqual([
      '40 answers that name you, last 30 days.',
      'AI: up to 80 requests, up to $0.24 of your AI allowance ($4.08 left this month).',
      'Evidence: 14 brand facts and up to 5 pages of notion.so. Reading pages is free.',
    ])
    expect(dialog().querySelector('.ird-warning').textContent).toContain('These are upper bounds; you are billed only for what runs.')
    expect(runButton().textContent.trim()).toBe('Run for up to $0.24')
    expect(runButton().disabled).toBe(false)
    // Engine checkboxes with what is left to analyze.
    expect(dialog().textContent).toContain('ChatGPT · 22 not analyzed')
    expect(dialog().textContent).toContain('Analyze again answers already analyzed')
  })

  it('re-estimates 300 ms after a control changes, the old estimate dimmed meanwhile', async () => {
    const options = runOptions('answer_analysis', {
      choices: { engines: [{ key: 'chatgpt', label: 'ChatGPT', unanalyzed: 22 }, { key: 'claude', label: 'Claude', unanalyzed: 18 }], evidence: { facts: 2 } },
    })
    const ctx = await setup('answer_analysis', { options })
    await openWith(ctx, { period: '30d', engines: null, reanalyze: false })
    expect(api.estimate).toHaveBeenCalledTimes(1)
    const claude = [...dialog().querySelectorAll('label')].find((l) => l.textContent.includes('Claude ·')).querySelector('input')
    claude.click()
    await flushPromises()
    expect(dialog().querySelector('.ird-estimate').classList.contains('is-stale')).toBe(true)
    expect(runButton().disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(api.estimate).toHaveBeenLastCalledWith('w1', {
      kind: 'answer_analysis',
      params: { period: '30d', engines: ['chatgpt'], reanalyze: false },
    })
    expect(dialog().querySelector('.ird-estimate').classList.contains('is-stale')).toBe(false)
  })

  it('drops the allowance left part with an unlimited allowance', async () => {
    const estimate = runEstimate('answer_analysis', { allowance: { unlimited: true, cap_usd: '0.00', left_usd: '0.00', enough: true } })
    const ctx = await setup('answer_analysis', { estimate, options: runOptions('answer_analysis', { choices: { evidence: { facts: 3 } } }) })
    await openWith(ctx, { period: '7d' })
    expect(lines()).toContain('AI: up to 80 requests, up to $0.24 of your AI allowance.')
    expect(lines()[0]).toBe('40 answers that name you, last 7 days.')
  })

  it('crawler audit: a free run with its own label', async () => {
    const options = runOptions('site_audit', {
      limits: { max_units: 20 },
      choices: { domain: 'notion.so', competitors: [{ key: 'b1', name: 'Evernote', domain: 'evernote.com' }], pages_planned: 12, cooldown_until: null },
    })
    const estimate = runEstimate('site_audit', {
      units: { pages: 12, competitors: 1 },
      ai: { calls_max: 0, usd_max: '0.0000' },
      fetches: { pages_max: 19 },
      confirm: { ai_calls: 0, ai_usd_max: '0.0000', google_pages: 0 },
      warnings: [],
    })
    const ctx = await setup('site_audit', { options, estimate })
    await openWith(ctx, { competitors: true })
    expect(dialog().textContent).toContain('Audit crawler access')
    expect(dialog().textContent).toContain(
      'Cansee fetches robots.txt, llms.txt and up to 20 pages of notion.so without running JavaScript, plus the home pages of the competitors you track. It fetches as CanseeAgent and never pretends to be another crawler. Nothing is billed.',
    )
    expect(lines()).toEqual(['12 pages of notion.so and 1 competitor home page.'])
    expect(runButton().textContent.trim()).toBe('Run audit')

    api.startRun.mockResolvedValue({ data: run({ kind: 'site_audit', kind_label: 'Crawler audit', status: 'queued' }) })
    runButton().click()
    await flushPromises()
    // A free run still sends its all-zero confirm.
    expect(api.startRun).toHaveBeenCalledWith('w1', {
      kind: 'site_audit',
      params: { competitors: true },
      confirm: { ai_calls: 0, ai_usd_max: '0.0000', google_pages: 0 },
    })
    expect(toast.success).toHaveBeenCalledWith('Crawler audit started.')
  })

  it('prompt research: AI and Google lines, pages left today, and a label with credits', async () => {
    const options = runOptions('prompt_research', {
      limits: { max_units: 5 },
      choices: {
        prompts: [
          { prompt_id: 'p1', text: 'best note taking app for teams', location: 'us', last_google_at: null, questions_recorded: false },
          { prompt_id: 'p2', text: 'notion alternatives', location: '', last_google_at: '2026-11-01T08:00:00Z', questions_recorded: true },
        ],
        context: { ready: true },
      },
    })
    const estimate = runEstimate('prompt_research', {
      units: { prompts: 2 },
      ai: { calls_max: 1, usd_max: '0.0100' },
      google: { pages_max: 2, credits_max: 50, usd_max: '0.0000', daily_left: 58, daily_limit: 60 },
      confirm: { ai_calls: 1, ai_usd_max: '0.0100', google_pages: 2 },
    })
    const ctx = await setup('prompt_research', { options, estimate })
    await openWith(ctx, { suggest: true, google_prompt_ids: ['p1', 'p2'] })
    expect(dialog().textContent).toContain('Find prompt ideas')
    expect(lines()).toEqual([
      'AI suggestions: up to $0.01 of your AI allowance.',
      'Google: 2 results pages, about 50 ScraperAPI credits.',
      '58 of 60 Google pages left today.',
    ])
    expect(runButton().textContent.trim()).toBe('Run for up to $0.01 and 50 credits')
    expect(dialog().textContent).toContain('Never read')
    expect(dialog().textContent).toContain('Suggest prompts from my brand context')
    expect(dialog().textContent).toContain('Read Google for these prompts')
  })

  it('reads Google costs in dollars with SerpAPI', async () => {
    const options = runOptions('fanout_google', {
      configured: { ai: true, google: true, google_provider: 'serpapi', google_provider_label: 'SerpAPI', shopping: false },
    })
    const estimate = runEstimate('fanout_google', {
      units: { queries: 3 },
      ai: { calls_max: 0, usd_max: '0.0000' },
      google: { pages_max: 3, credits_max: 0, usd_max: '0.0450', daily_left: 60, daily_limit: 60 },
      confirm: { ai_calls: 0, ai_usd_max: '0.0000', google_pages: 3 },
    })
    const ctx = await setup('fanout_google', { options, estimate })
    await openWith(ctx, { queries: [{ prompt_id: 'p1', text: 'best note apps 2026' }] })
    expect(dialog().textContent).toContain('Check searches on Google')
    expect(lines()).toEqual(['3 searches, page one only: up to $0.05.', '60 of 60 Google pages left today.'])
    expect(runButton().textContent.trim()).toBe('Run for up to $0.05')
  })

  it('labels a Google-only ScraperAPI run in credits', async () => {
    const estimate = runEstimate('fanout_google', {
      ai: { calls_max: 0, usd_max: '0.0000' },
      google: { pages_max: 4, credits_max: 100, usd_max: '0.0000', daily_left: 60, daily_limit: 60 },
      confirm: { ai_calls: 0, ai_usd_max: '0.0000', google_pages: 4 },
    })
    const ctx = await setup('fanout_google', { estimate, options: runOptions('fanout_google') })
    await openWith(ctx, { queries: [] })
    expect(lines()[0]).toBe('4 searches, page one only: about 100 ScraperAPI credits.')
    expect(runButton().textContent.trim()).toBe('Run for 100 credits')
  })

  it('shopping check: products and engines to choose, both lines', async () => {
    const estimate = runEstimate('shopping_check', {
      units: { pages: 2, answers: 4 },
      ai: { calls_max: 4, usd_max: '0.3200' },
      google: { pages_max: 2, credits_max: 50, usd_max: '0.0000', daily_left: 60, daily_limit: 60 },
      confirm: { ai_calls: 4, ai_usd_max: '0.3200', google_pages: 2 },
    })
    const extra = {
      products: [{ id: 'p1', name: 'Acme X200 running shoe' }],
      engines: [
        { key: 'chatgpt', label: 'ChatGPT', configured: true },
        { key: 'gemini', label: 'Gemini', configured: false },
      ],
    }
    const ctx = await setup('shopping_check', { estimate, extra, options: runOptions('shopping_check') })
    await openWith(ctx, { product_ids: ['p1'], engines: ['chatgpt'], google_shopping: true })
    expect(dialog().textContent).toContain('Run a shopping check')
    expect(lines()).toEqual([
      'Google Shopping: 2 pages, about 50 ScraperAPI credits.',
      'AI engines: 4 answers, up to $0.32 of your AI allowance ($4.08 left this month).',
      '60 of 60 Google pages left today.',
    ])
    const gemini = [...dialog().querySelectorAll('label')].find((l) => l.textContent.includes('Gemini'))
    expect(gemini.textContent).toContain('Not configured')
    expect(gemini.querySelector('input').disabled).toBe(true)
    expect(dialog().textContent).toContain('Acme X200 running shoe')
    expect(dialog().textContent).toContain('Check Google Shopping')
  })

  it('disables the run while blocked and shows the blockers', async () => {
    const estimate = runEstimate('answer_analysis', {
      can_run: false,
      blockers: [{ code: 'nothing_to_run', status: 400, message: 'Every answer that names you in this period is already analyzed.' }],
      units: { answers: 0 },
    })
    const ctx = await setup('answer_analysis', { estimate })
    await openWith(ctx, { period: '30d' })
    expect(dialog().querySelector('.ird-blocker').textContent).toContain('Every answer that names you in this period is already analyzed.')
    expect(lines()[0]).not.toContain('0 answers')
    expect(runButton().disabled).toBe(true)
  })

  it('sends the confirm, replaces a changed estimate, and closes on 202', async () => {
    const changed = runEstimate('answer_analysis', {
      ai: { calls_max: 90, usd_max: '0.2700' },
      confirm: { ai_calls: 90, ai_usd_max: '0.2700', google_pages: 0 },
    })
    const ctx = await setup('answer_analysis')
    await openWith(ctx, { period: '30d' })
    api.startRun.mockRejectedValueOnce(apiError(409, 'estimate_changed', 'The estimate changed.', { estimate: changed }))
    runButton().click()
    await flushPromises()
    expect(api.startRun).toHaveBeenCalledWith('w1', expect.objectContaining({ confirm: { ai_calls: 80, ai_usd_max: '0.2400', google_pages: 0 } }))
    expect(dialog().querySelector('.ird-note').textContent).toBe('The cost changed. Check the new estimate and confirm again.')
    expect(runButton().textContent.trim()).toBe('Run for up to $0.27')

    api.startRun.mockRejectedValueOnce(apiError(403, 'insufficient_allowance', 'This run needs up to $0.27 of AI allowance and $0.10 is left this month.'))
    runButton().click()
    await flushPromises()
    expect(dialog().querySelector('[role="alert"]').textContent).toContain('This run needs up to $0.27 of AI allowance and $0.10 is left this month.')

    api.startRun.mockResolvedValueOnce({ data: run({ status: 'queued' }) })
    runButton().click()
    await flushPromises()
    expect(api.startRun).toHaveBeenLastCalledWith('w1', expect.objectContaining({ confirm: changed.confirm }))
    expect(dialog()).toBeNull()
    expect(ctx.started).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
    expect(toast.success).toHaveBeenCalledWith('Answer analysis started.')
  })

  it('opens from v-model with the page selection and reports closing', async () => {
    const ctx = await setup('site_audit', {
      vModel: true,
      params: { competitors: false },
      options: runOptions('site_audit', { choices: { domain: 'notion.so', competitors: [], pages_planned: 3 } }),
      estimate: runEstimate('site_audit', { units: { pages: 3, competitors: 0 }, warnings: [] }),
    })
    expect(dialog()).toBeNull()
    ctx.open.value = true
    await flushPromises()
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(api.estimate).toHaveBeenCalledWith('w1', { kind: 'site_audit', params: { competitors: false } })
    expect(lines()).toEqual(['3 pages of notion.so and 0 competitor home pages.'])
    const cancel = [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel')
    cancel.click()
    await flushPromises()
    expect(dialog()).toBeNull()
    expect(ctx.open.value).toBe(false)
  })
})
