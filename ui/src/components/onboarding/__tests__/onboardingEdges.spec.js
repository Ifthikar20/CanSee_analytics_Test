// Onboarding edge cases: stale scans and statuses, timers after unmount,
// the limits of each list, and what Start research needs (prompts x
// engines runs, a ticked engine, an engine set up).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const post = vi.fn()
vi.mock('@/api/client', () => ({ default: { post: (...args) => post(...args), get: vi.fn() } }))

const agentApi = { status: vi.fn(), getContext: vi.fn(), createContextEntry: vi.fn() }
vi.mock('@/api/agent', () => ({ default: agentApi }))

const websitesApi = { list: vi.fn() }
vi.mock('@/api/websites', () => ({ default: websitesApi }))

const toast = { warning: vi.fn(), error: vi.fn(), success: vi.fn() }
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const auth = reactive({ session: { next_route: 'dashboard' }, fetchSession: vi.fn() })
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

vi.mock('@/stores/app', () => ({ useAppStore: () => ({ setWebsites: vi.fn() }) }))

const { LIMITS, MAX_COMPETITORS, MAX_PROMPTS, provideOnboardingFlow, SCAN_SETTLE_MS } = await import('../useOnboardingFlow')
const { default: RunStep } = await import('../steps/RunStep.vue')

const TOPICS = [
  'what is the best wiki for startups',
  'notion vs confluence for small teams',
  'how do teams organize documentation',
  'best note taking app for teams',
  'which project tool has docs built in',
  'free knowledge base software',
  'best tool for meeting notes',
  'how to replace google docs for a team',
  'what do startups use for an intranet',
  'best all in one workspace app',
  'notion alternatives that work offline',
  'team wiki with permissions',
]

const GOOGLE_OK = {
  configured: true,
  provider: 'serpapi',
  label: 'SerpAPI',
  error: '',
  searches: 3,
  queries: [
    { query: 'notion alternatives', purpose: 'competitors', error: '', results: 10 },
    { query: 'best wiki software', purpose: 'questions', error: '', results: 10 },
  ],
}

// A scan payload after onb-search: sources, evidence, 12 topics (the cap is 10).
const SCAN = {
  url: 'https://notion.so',
  success: true,
  error: null,
  business_name: 'Notion',
  domain: 'notion.so',
  industry: 'Software',
  description_short: 'One workspace for docs and wikis.',
  description_raw: '',
  products: ['Docs'],
  audience: '',
  voice: '',
  logo_url: '',
  topics: TOPICS,
  topics_source: 'both',
  topic_sources: ['search', 'search', 'ai', 'both', 'ai', 'ai', 'ai', 'ai', 'ai', 'ai', 'ai', 'ai'],
  topic_evidence: [
    { kind: 'question', text: 'What is the best wiki for startups?', query: 'best wiki software' },
    { kind: 'related', text: 'notion vs confluence', query: 'notion alternatives' },
    null,
    { kind: 'related', text: 'note taking app teams', query: 'best wiki software' },
    null, null, null, null, null, null, null, null,
  ],
  topic_brands: [],
  missing_keys: [],
  competitors: [
    { name: 'Confluence', domain: 'atlassian.com', source: 'search', evidence: { query: 'notion alternatives', rank: 2, url: 'https://www.atlassian.com/software/confluence' } },
    { name: 'Coda', domain: 'coda.io', source: 'both', evidence: { query: 'notion competitors', rank: 4, url: 'https://coda.io' } },
    // An AI suggestion never carries Google evidence, even if one slipped in.
    { name: 'Obsidian', domain: 'obsidian.md', source: 'ai', evidence: { query: 'x', rank: 1, url: 'https://obsidian.md' } },
    // Legacy Custom Search: from Google, but no evidence.
    { name: 'Slite', domain: '', source: 'search', evidence: null },
    { name: 'Craft', domain: 'craft.do', source: 'weird', evidence: { query: 'craft', rank: 'first', url: 'javascript:alert(1)' } },
  ],
  competitors_source: 'both',
  google: GOOGLE_OK,
}

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
  by_engine: {},
  by_feature: {},
}

function engine(key, label, configured, keySetting = '') {
  return { key, provider: key, label, configured, key_setting: keySetting, reason: configured ? '' : 'not_configured' }
}

// GET agent/status/ for a free customer (no setting names).
const STATUS = {
  enabled: true,
  live_available: true,
  configured: true,
  serp_configured: true,
  engines: [
    engine('chatgpt', 'ChatGPT', true),
    engine('claude', 'Claude', true),
    engine('gemini', 'Gemini', false),
    engine('grok', 'Grok', false),
    engine('perplexity', 'Perplexity', true),
  ],
  google: { configured: true, provider: 'serpapi', label: 'SerpAPI', key_settings: [], reliable_pages: 3 },
  allowance: { cap_usd: 3, spent_usd: 0.5, exceeded: false, warning: false, show_usd: false },
  prompt_runs: RUNS,
  research: { available: true, reason: null, message: '' },
  setup: { ready: true, issues: [] },
  swarm: { enabled: true, max_agents: 50, worker_model: 'claude-haiku-4-5' },
}

const mounted = []

function host(child = null) {
  let flow
  const Host = defineComponent({
    setup() {
      flow = provideOnboardingFlow({ onComplete: vi.fn() })
      return () => (child ? h(child) : h('div'))
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  mounted.push(wrapper)
  return { flow, wrapper }
}

async function scanned({ child = null, scan = {}, status = STATUS } = {}) {
  agentApi.status.mockResolvedValue({ data: status })
  post.mockImplementation((url) =>
    url === '/onboarding/scan/' ? Promise.resolve({ data: { ...SCAN, ...scan } }) : Promise.resolve({ data: {} }),
  )
  const ctx = host(child)
  ctx.flow.urlInput.value = 'notion.so'
  await ctx.flow.startScan()
  vi.advanceTimersByTime(SCAN_SETTLE_MS)
  await nextTick()
  return ctx
}

async function atStep(index, opts = {}) {
  const ctx = await scanned(opts)
  ctx.flow.goTo(index)
  await flushPromises()
  return ctx
}

function finishMocks({ prompts = { data: { created_count: 3, scan_audit_id: 'a1', scan_error: null } } } = {}) {
  post.mockReset()
  post.mockImplementation((url) => {
    if (url === '/onboarding/save/') return Promise.resolve({ data: { website_id: 'w1' } })
    if (typeof prompts === 'function') return prompts(url)
    return Promise.resolve(prompts)
  })
  agentApi.getContext.mockResolvedValue({ data: { totals: { entries: 1, suggested: 0 } } })
  websitesApi.list.mockResolvedValue({ data: [] })
}

function engineBoxes(wrapper) {
  return wrapper.findAll('.ob-engine').map((row) => {
    const box = row.find('input[type="checkbox"]')
    const describedBy = box.attributes('aria-describedby')
    return [
      row.find('.ob-engine-label').text(),
      box.element.checked,
      box.element.disabled,
      describedBy ? document.getElementById(describedBy)?.textContent.replace(/\s+/g, ' ').trim() || '' : '',
    ]
  })
}

/** An element's words, its child elements read one after another (as a screen reader does). */
function words(el) {
  const kids = [...el.element.children]
  const parts = kids.length ? kids.map((k) => k.textContent) : [el.element.textContent]
  return parts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
}

function row(wrapper, label) {
  const found = wrapper.findAll('.ob-summary-row').find((r) => r.find('dt').text() === label)
  return found ? words(found.find('dd')) : undefined
}

const buttons = (wrapper) => wrapper.findAll('.ob-step-actions button').map((b) => b.text())
const startButton = (wrapper) => wrapper.findAll('.ob-step-actions button').find((b) => b.text() === 'Start research')

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  localStorage.clear()
  post.mockReset()
  push.mockReset()
  Object.values(agentApi).forEach((fn) => fn.mockReset())
  websitesApi.list.mockReset()
  Object.values(toast).forEach((fn) => fn.mockReset())
  auth.session = { next_route: 'dashboard' }
  auth.fetchSession = vi.fn(async () => auth.session)
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllEnvs()
})


/** A scan request the test settles by hand. */
function pendingScan() {
  const pending = {}
  post.mockImplementation((url) =>
    url === '/onboarding/scan/'
      ? new Promise((resolve, reject) => {
          pending.resolve = resolve
          pending.reject = reject
        })
      : Promise.resolve({ data: {} }),
  )
  return pending
}

describe('website step: stale scans and the settle timer', () => {
  it('ignores a scan answer that arrives after Fill in by hand', async () => {
    const pending = pendingScan()
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    const scan = flow.startScan()
    expect(flow.scanState.value).toBe('scanning')
    flow.fillByHand()
    expect(flow.step.value).toBe(1)
    pending.resolve({ data: { ...SCAN } })
    await scan
    await flushPromises()
    vi.advanceTimersByTime(SCAN_SETTLE_MS * 2)
    expect(flow.form.value.business_name).toBe('')
    expect(flow.form.value.prompts).toEqual([])
    expect(flow.form.value.competitors).toEqual([])
    expect(flow.form.value.url).toBe('https://notion.so')
    expect(flow.scanState.value).toBe('idle')
    expect(flow.step.value).toBe(1)
  })

  it('ignores a scan failure that arrives after Fill in by hand', async () => {
    const pending = pendingScan()
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    const scan = flow.startScan()
    flow.fillByHand()
    pending.reject(Object.assign(new Error('x'), { response: { status: 500 } }))
    await scan
    expect(flow.scanError.value).toBe('')
    expect(flow.urlError.value).toBe('')
    expect(flow.step.value).toBe(1)
  })

  it('does not move on by itself once the flow is gone', async () => {
    post.mockImplementation(() => Promise.resolve({ data: { ...SCAN } }))
    const { flow, wrapper } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    expect(flow.scanState.value).toBe('resolved')
    expect(flow.step.value).toBe(0)
    mounted.splice(mounted.indexOf(wrapper), 1)
    wrapper.unmount()
    vi.advanceTimersByTime(SCAN_SETTLE_MS)
    expect(flow.step.value).toBe(0)
  })

  it('moves on exactly when the settle time is over', async () => {
    post.mockImplementation(() => Promise.resolve({ data: { ...SCAN } }))
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    vi.advanceTimersByTime(SCAN_SETTLE_MS - 1)
    expect(flow.step.value).toBe(0)
    vi.advanceTimersByTime(1)
    expect(flow.step.value).toBe(1)
  })
})

describe('review steps: limits', () => {
  it('takes a prompt of exactly the minimum length, not one shorter', async () => {
    const { flow } = await atStep(3)
    flow.form.value.prompts.forEach((p, i) => flow.setPromptSelected(i, false))
    flow.newPrompt.value = 'ab'
    expect(flow.addPrompt()).toBe(false)
    expect(flow.newPrompt.value).toBe('ab')
    flow.newPrompt.value = '  a  b  '
    expect(flow.addPrompt()).toBe(true)
    expect(flow.form.value.prompts.at(-1)).toMatchObject({ text: 'a b', custom: true, selected: true })
    expect(LIMITS.promptMin).toBe(3)
  })

  it('clips a prompt to the longest the research takes', async () => {
    const { flow } = await atStep(3)
    flow.newPrompt.value = 'x'.repeat(LIMITS.prompt + 20)
    expect(flow.addPrompt()).toBe(true)
    expect(flow.form.value.prompts.at(-1).text).toHaveLength(LIMITS.prompt)
  })

  it('selects a re-added prompt instead of adding it twice, while under the cap', async () => {
    const { flow } = await atStep(3)
    const text = flow.form.value.prompts[5].text
    expect(flow.form.value.prompts[5].selected).toBe(false)
    flow.newPrompt.value = text.toUpperCase()
    expect(flow.addPrompt()).toBe(false)
    expect(flow.form.value.prompts[5].selected).toBe(true)
    expect(flow.form.value.prompts.filter((p) => p.text.toLowerCase() === text.toLowerCase())).toHaveLength(1)
  })

  it(`keeps at most ${MAX_PROMPTS} prompts selected, and one more is added unselected`, async () => {
    const { flow } = await atStep(3)
    for (let i = 3; i < 5; i += 1) expect(flow.setPromptSelected(i, true)).toBe(true)
    expect(flow.selectedPrompts.value).toHaveLength(MAX_PROMPTS)
    expect(flow.promptCapReached.value).toBe(true)
    expect(flow.setPromptSelected(6, true)).toBe(false)
    flow.newPrompt.value = 'a brand new buyer question'
    expect(flow.addPrompt()).toBe(true)
    expect(flow.form.value.prompts.at(-1).selected).toBe(false)
    expect(flow.canContinue.value).toBe(true)
  })

  it(`keeps at most ${MAX_COMPETITORS} competitors selected from the scan`, async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `C${i}`, domain: `c${i}.com`, source: 'ai' }))
    const { flow } = await atStep(2, { scan: { competitors: many } })
    expect(flow.form.value.competitors.map((c) => c.selected)).toEqual([true, true, true, true, true, false, false])
    expect(flow.setCompetitorSelected(5, true)).toBe(false)
    expect(flow.setCompetitorSelected(0, false)).toBe(true)
    expect(flow.setCompetitorSelected(5, true)).toBe(true)
  })
})

describe('last step: what Start research needs', () => {
  it('reads an older status without engines as available, asking every engine', async () => {
    const { engines, ...old } = STATUS
    expect(engines).toBeTruthy()
    const { flow, wrapper } = await atStep(4, { child: RunStep, status: old })
    expect(flow.availability.value).toBe('available')
    expect(flow.engineRows.value).toEqual([])
    expect(flow.researchBlock.value).toBe('')
    expect(startButton(wrapper).element.disabled).toBe(false)
    expect(wrapper.find('.ob-engines').exists()).toBe(false)

    finishMocks()
    await flow.skipResearch()
    // No engine choice to send: the server asks every configured engine.
    expect(post.mock.calls[1][1]).toEqual({ text: TOPICS.slice(0, 3).join('\n'), location: 'us' })
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['false', false],
  ])('reads enabled %s as not available: only an explicit true is on', async (_, enabled) => {
    const { flow, wrapper } = await atStep(4, { child: RunStep, status: { ...STATUS, enabled } })
    expect(flow.availability.value).toBe('unavailable')
    expect(buttons(wrapper)).toEqual(['Back', 'Finish setup'])
  })

  it('counts runs as the selected prompts times the ticked engines', async () => {
    const { flow, wrapper } = await atStep(4, { child: RunStep })
    expect(flow.runsNeeded.value).toBe(9)
    flow.setPromptSelected(0, false)
    await nextTick()
    expect(flow.runsNeeded.value).toBe(6)
    expect(row(wrapper, 'Prompt runs')).toContain('Your first research uses 6 runs (2 prompts × 3 engines).')
    flow.setPromptSelected(1, false)
    flow.setEngineSelected('claude', false)
    flow.setEngineSelected('perplexity', false)
    await nextTick()
    expect(flow.runsNeeded.value).toBe(1)
    expect(row(wrapper, 'Prompt runs')).toContain('Your first research uses 1 run (1 prompt × 1 engine).')
  })

  it('blocks Start one run short, and allows it at exactly the runs left', async () => {
    const short = await atStep(4, { child: RunStep, status: { ...STATUS, prompt_runs: { ...RUNS, remaining: 8 } } })
    expect(short.flow.researchBlock.value).toBe('runs')
    expect(startButton(short.wrapper).element.disabled).toBe(true)
    expect(short.wrapper.find('#ob-run-block').text()).toBe(
      'This needs 9 free prompt runs and 8 of your 20 are left this month. Choose fewer prompts or engines.',
    )
    // No "uses N runs" line while it does not fit.
    expect(row(short.wrapper, 'Prompt runs')).toBe('8 free prompt runs left')
    mounted.pop().unmount()

    const exact = await atStep(4, { child: RunStep, status: { ...STATUS, prompt_runs: { ...RUNS, remaining: 9 } } })
    expect(exact.flow.researchBlock.value).toBe('')
    expect(startButton(exact.wrapper).element.disabled).toBe(false)
    expect(exact.wrapper.find('#ob-run-block').exists()).toBe(false)
  })

  it('never shows dollars to a free account, even with a dollar cap in the status', async () => {
    const status = { ...STATUS, allowance: { cap_usd: 30, spent_usd: 5, exceeded: false, show_usd: true } }
    const { flow, wrapper } = await atStep(4, { child: RunStep, status })
    expect(flow.hideUsd.value).toBe(true)
    expect(row(wrapper, 'AI allowance')).toBeUndefined()
    expect(wrapper.text()).not.toContain('$')
  })

  it('shows no dollars to a free account whose runs block cannot be read', async () => {
    // show_usd false and a runs block with no count: neither runs nor dollars.
    const status = { ...STATUS, prompt_runs: { unlimited: false, plan: 'free' }, allowance: { cap_usd: 3, spent_usd: 1, show_usd: false } }
    const { wrapper } = await atStep(4, { child: RunStep, status })
    expect(row(wrapper, 'Prompt runs')).toBeUndefined()
    expect(row(wrapper, 'AI allowance')).toBeUndefined()
    expect(wrapper.text()).not.toContain('$')
  })

  it('names an engine setting only for staff', async () => {
    vi.stubEnv('DEV', false)
    const customer = await atStep(4, { child: RunStep })
    expect(engineBoxes(customer.wrapper)[2]).toEqual(['Gemini', false, true, "Gemini isn't set up on this workspace."])
    expect(customer.wrapper.text()).not.toContain('Setting')
    expect(customer.flow.showSettings.value).toBe(false)
    expect(customer.flow.settingNames(['google', 'ANTHROPIC_API_KEY'])).toBe('')
  })

  it('lets the research start when the status could not be read, with Try again', async () => {
    agentApi.status.mockRejectedValue(new Error('offline'))
    post.mockImplementation(() => Promise.resolve({ data: { ...SCAN } }))
    const { flow, wrapper } = host(RunStep)
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    flow.goTo(4)
    await flushPromises()
    expect(flow.availability.value).toBe('unknown')
    expect(buttons(wrapper)).toEqual(['Back', 'Skip for now', 'Start research'])
    expect(startButton(wrapper).element.disabled).toBe(false)

    agentApi.status.mockResolvedValue({ data: STATUS })
    await wrapper.findAll('.ob-notice button').find((b) => b.text() === 'Try again').trigger('click')
    await flushPromises()
    expect(flow.availability.value).toBe('available')
    expect(flow.form.value.engines).toEqual(['chatgpt', 'claude', 'perplexity'])
  })

  it('drops a failed status answer that arrives after the flow is gone', async () => {
    let reject
    agentApi.status.mockImplementationOnce(() => new Promise((_, r) => (reject = r)))
    post.mockImplementation(() => Promise.resolve({ data: { ...SCAN } }))
    const { flow, wrapper } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    flow.goTo(4)
    await nextTick()
    expect(flow.statusState.value).toBe('loading')
    mounted.splice(mounted.indexOf(wrapper), 1)
    wrapper.unmount()
    reject(new Error('offline'))
    await flushPromises()
    expect(flow.statusState.value).toBe('loading')
  })

  it('lists an engine the status names twice once', async () => {
    const twice = { ...STATUS, engines: [...STATUS.engines, engine('chatgpt', 'ChatGPT again', true), { label: 'No key' }, null] }
    const { flow, wrapper } = await atStep(4, { child: RunStep, status: twice })
    expect(flow.engineRows.value.map((e) => e.key)).toEqual(['chatgpt', 'claude', 'gemini', 'grok', 'perplexity'])
    expect(engineBoxes(wrapper).map(([label]) => label)).toEqual(['ChatGPT', 'Claude', 'Gemini', 'Grok', 'Perplexity'])
    expect(flow.runsNeeded.value).toBe(9)
  })

  it('saves the project once when Start is pressed twice', async () => {
    const { flow } = await atStep(4)
    finishMocks()
    const first = flow.startResearch()
    const second = flow.startResearch()
    const third = flow.skipResearch()
    await Promise.all([first, second, third])
    expect(post.mock.calls.filter(([url]) => url === '/onboarding/save/')).toHaveLength(1)
    // The second press was a research, not a skip: no prompts were tracked.
    expect(post.mock.calls.filter(([url]) => url.startsWith('/prompt-library/'))).toHaveLength(0)
    expect(auth.fetchSession).toHaveBeenCalledTimes(1)
    expect(flow.finishing.value).toBe('')
  })
})
