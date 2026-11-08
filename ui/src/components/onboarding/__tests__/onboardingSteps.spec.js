// Onboarding steps 3 to 5 against the wave 1 contracts: where each
// competitor and question came from (the scan's source and evidence), up to
// 10 suggested questions, the honest notes when Google or Claude is not set
// up, the engine checkboxes of the last step, the free prompt runs the first
// research uses, and the engines that travel with the first research.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { useFirstResearch } from '@/composables/agent/useFirstResearch'

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

const {
  competitorNote,
  competitorSourceText,
  FIRST_RUN_KEY,
  MAX_SUGGESTED_PROMPTS,
  promptNote,
  promptSource,
  provideOnboardingFlow,
  SCAN_SETTLE_MS,
} = await import('../useOnboardingFlow')
const { default: CompetitorsStep } = await import('../steps/CompetitorsStep.vue')
const { default: PromptsStep } = await import('../steps/PromptsStep.vue')
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

// The same workspace as staff see it: setting names filled in.
const STAFF_STATUS = {
  ...STATUS,
  engines: [
    engine('chatgpt', 'ChatGPT', true, 'OPENAI_API_KEY'),
    engine('claude', 'Claude', true, 'ANTHROPIC_API_KEY'),
    engine('gemini', 'Gemini', false, 'GEMINI_API_KEY'),
    engine('grok', 'Grok', false, 'XAI_API_KEY'),
    engine('perplexity', 'Perplexity', true, 'PERPLEXITY_API_KEY'),
  ],
  google: { configured: false, provider: '', label: '', key_settings: ['SERPAPI_KEY', 'SCRAPERAPI_KEY'], reliable_pages: 0 },
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

describe('scan: sources and evidence', () => {
  it('keeps where each competitor came from, and only real Google evidence', async () => {
    const { flow } = await scanned()
    expect(flow.form.value.competitors.map((c) => [c.name, c.source, c.evidence])).toEqual([
      ['Confluence', 'search', { query: 'notion alternatives', rank: 2, url: 'https://www.atlassian.com/software/confluence' }],
      ['Coda', 'both', { query: 'notion competitors', rank: 4, url: 'https://coda.io' }],
      ['Obsidian', 'ai', null],
      ['Slite', 'search', null],
      // An unknown source is not guessed; a bad rank or a non-web address is dropped.
      ['Craft', '', { query: 'craft', rank: null, url: '' }],
    ])
    expect(flow.form.value.scan.competitors_source).toBe('both')
    expect(flow.form.value.scan.google).toEqual({ configured: true, label: 'SerpAPI', error: '' })
  })

  it('keeps at most 10 questions with their own source and evidence, the first 3 picked', async () => {
    const { flow } = await scanned()
    const prompts = flow.form.value.prompts
    expect(MAX_SUGGESTED_PROMPTS).toBe(10)
    expect(prompts).toHaveLength(10)
    expect(prompts.map((p) => p.text)).toEqual(TOPICS.slice(0, 10))
    expect(prompts.filter((p) => p.selected).map((p) => p.text)).toEqual(TOPICS.slice(0, 3))
    expect(prompts.slice(0, 4).map((p) => [p.source, p.evidence?.kind ?? null, p.evidence?.query ?? null])).toEqual([
      ['search', 'question', 'best wiki software'],
      ['search', 'related', 'notion alternatives'],
      ['ai', null, null],
      ['both', 'related', 'best wiki software'],
    ])
    expect(flow.form.value.scan.topics).toBe(10)
  })

  it('keeps each question paired with its own source when a duplicate or a short one is dropped', async () => {
    const { flow } = await scanned({
      scan: {
        topics: ['ab', 'Best wiki', 'BEST WIKI', 'team notes app'],
        topic_sources: ['ai', 'search', 'ai', 'both'],
        topic_evidence: [null, { kind: 'question', text: 'Best wiki?', query: 'wiki' }, null, { kind: 'related', text: 'notes', query: 'notes' }],
      },
    })
    expect(flow.form.value.prompts.map((p) => [p.text, p.source, p.evidence?.query ?? null])).toEqual([
      ['Best wiki', 'search', 'wiki'],
      ['team notes app', 'both', 'notes'],
    ])
  })

  it('reads a scan without the parallel lists as rows of unknown source', async () => {
    const { flow } = await scanned({ scan: { topic_sources: undefined, topic_evidence: 'bad', topics: ['one question here'] } })
    expect(flow.form.value.prompts).toEqual([
      { text: 'one question here', source: '', evidence: null, selected: true, custom: false },
    ])
  })

  it.each([
    [{ topics_source: 'search', competitors_source: 'search' }, ['10 questions found on Google', '5 competitors found on Google']],
    [{ topics_source: 'both', competitors_source: 'both' }, ['10 prompts from Google and AI', '5 competitors found on Google']],
    [{ topics_source: 'ai', competitors_source: 'ai' }, ['10 prompts drafted', '5 competitors suggested by AI']],
    [
      { topics_source: 'search', competitors_source: 'ai', topics: ['only one question'], competitors: [{ name: 'Coda', domain: 'coda.io', source: 'ai' }] },
      ['1 question found on Google', '1 competitor suggested by AI'],
    ],
  ])('says in the scan rows where the rows came from (%o)', async (scan, texts) => {
    const { flow } = await scanned({ scan })
    expect(flow.scanRows.value.slice(1).map((r) => r.text)).toEqual(texts)
  })
})

describe('source words', () => {
  it.each([
    [{ source: 'search', evidence: { query: 'notion alternatives' } }, 'Found on Google for "notion alternatives"'],
    [{ source: 'search', evidence: null }, 'Found on Google'],
    [{ source: 'both', evidence: { query: 'notion competitors' } }, 'Found on Google for "notion competitors" and suggested by AI'],
    [{ source: 'both', evidence: null }, 'Found on Google and suggested by AI'],
    [{ source: 'ai', evidence: null }, 'Suggested by AI'],
    [{ source: '', evidence: null }, ''],
    [{ source: 'search', custom: true }, 'Added by you'],
    [null, ''],
  ])('names the competitor source for %o', (c, text) => {
    expect(competitorSourceText(c)).toBe(text)
  })

  it.each([
    [{ source: 'search', evidence: { kind: 'question', query: 'best wiki' } }, { badge: 'From Google', detail: 'People also ask on Google for "best wiki"' }],
    [{ source: 'search', evidence: { kind: 'related', query: '' } }, { badge: 'From Google', detail: 'Related search on Google' }],
    [{ source: 'both', evidence: { kind: 'related', query: 'wiki' } }, { badge: 'From Google, worded by AI', detail: 'Related search on Google for "wiki"' }],
    [{ source: 'search', evidence: null }, { badge: 'From Google', detail: '' }],
    [{ source: 'ai', evidence: null }, { badge: 'Suggested by AI', detail: '' }],
    [{ source: '', evidence: null }, { badge: '', detail: '' }],
    [{ source: 'search', custom: true }, { badge: '', detail: '' }],
  ])('names the question source for %o', (p, words) => {
    expect(promptSource(p)).toEqual(words)
  })
})

describe('notes when Google or Claude could not help', () => {
  const scan = (over = {}) => ({ competitors: 3, topics: 5, missing_keys: [], topics_source: 'both', google: { configured: true, label: 'SerpAPI', error: '' }, ...over })

  it('says nothing when both worked, or when an older scan did not say', () => {
    expect(competitorNote(scan())).toBeNull()
    expect(promptNote(scan())).toBeNull()
    expect(competitorNote(scan({ google: null }))).toBeNull()
    expect(promptNote(scan({ google: null }))).toBeNull()
  })

  it.each([
    ['Google is not set up', { google: { configured: false, label: '', error: 'serpapi_not_configured' } }, "Google search isn't set up on this workspace, so these are AI suggestions, not Google results.", ['google']],
    ['Google says not configured while configured is true', { google: { configured: true, label: '', error: 'serpapi_not_configured' } }, "Google search isn't set up on this workspace, so these are AI suggestions, not Google results.", ['google']],
    ['the daily limit is reached', { google: { configured: true, label: 'SerpAPI', error: 'daily_limit' } }, "Google search reached today's limit for setup scans, so these are AI suggestions, not Google results.", []],
    ['Google answered for another name', { google: { configured: true, error: 'no_brand_results' } }, 'Google showed results for a different name, so these are AI suggestions, not Google results.', []],
    ['Google timed out', { google: { configured: true, error: 'timeout' } }, "Google search didn't answer this time, so these are AI suggestions, not Google results.", []],
    ['Google returned an HTTP error', { google: { configured: true, error: 'http_502' } }, "Google search didn't answer this time, so these are AI suggestions, not Google results.", []],
    ['Claude is not set up', { missing_keys: ['ANTHROPIC_API_KEY'] }, "The AI service isn't set up on this workspace, so these come straight from Google results, without an AI check.", ['ANTHROPIC_API_KEY']],
  ])('step 3 says so when %s', (_, over, text, settings) => {
    expect(competitorNote(scan(over))).toEqual({ text, settings })
  })

  it.each([
    ['nothing is set up', { competitors: 0, missing_keys: ['ANTHROPIC_API_KEY'], google: { configured: false } }, "Google search isn't set up on this workspace and the AI service isn't set up, so we couldn't suggest competitors."],
    ['Google failed and Claude found none', { competitors: 0, google: { configured: true, error: 'empty_results' } }, 'Google found no results for your brand, and the AI service suggested none.'],
    ['Claude is missing and Google named none', { competitors: 0, missing_keys: ['ANTHROPIC_API_KEY'] }, "The AI service isn't set up on this workspace, and Google results named no competitors."],
  ])('step 3 explains an empty list when %s', (_, over, text) => {
    expect(competitorNote(scan(over)).text).toBe(text)
  })

  it.each([
    ['Claude is not set up', { missing_keys: ['ANTHROPIC_API_KEY'], topics_source: 'search' }, "The AI service isn't set up on this workspace, so these are Google's own questions and searches."],
    ['Google is not set up', { google: { configured: false } }, "Google search isn't set up on this workspace, so these are AI suggestions, not Google's questions."],
    ['Google hit its limit', { google: { configured: true, error: 'daily_limit' } }, "Google search reached today's limit for setup scans, so these are AI suggestions, not Google's questions."],
    ['nothing could suggest any', { topics: 0, topics_source: 'unavailable', missing_keys: ['ANTHROPIC_API_KEY'], google: { configured: false } }, 'Suggesting questions needs Google search or the AI service, and neither is set up here. Write 1 to 5 questions your buyers ask.'],
    ['the drafting failed', { topics: 0, topics_source: 'failed' }, "We couldn't suggest questions for your homepage. Write 1 to 5 questions your buyers ask."],
  ])('step 4 says so when %s', (_, over, text) => {
    expect(promptNote(scan(over)).text).toBe(text)
  })
})

describe('step 3: competitors', () => {
  it('shows where each competitor came from', async () => {
    const { wrapper } = await atStep(2, { child: CompetitorsStep })
    expect(wrapper.findAll('.ob-competitor').map((r) => [r.find('.ob-competitor-name').text(), r.find('.ob-competitor-source').exists() ? r.find('.ob-competitor-source').text() : ''])).toEqual([
      ['Confluence', 'Found on Google for "notion alternatives"'],
      ['Coda', 'Found on Google for "notion competitors" and suggested by AI'],
      ['Obsidian', 'Suggested by AI'],
      ['Slite', 'Found on Google'],
      ['Craft', ''],
    ])
    expect(wrapper.find('.ob-source-note').exists()).toBe(false)
  })

  it('marks a competitor the user adds as theirs', async () => {
    const { flow, wrapper } = await atStep(2, { child: CompetitorsStep })
    flow.newCompetitorName.value = 'Slab'
    flow.addCompetitor()
    await nextTick()
    expect(wrapper.findAll('.ob-competitor-source').at(-1).text()).toBe('Added by you')
  })

  it('tells a customer Google is not set up, without setting names', async () => {
    vi.stubEnv('DEV', false)
    const { wrapper } = await atStep(2, {
      child: CompetitorsStep,
      scan: { google: { ...GOOGLE_OK, configured: false, error: 'serpapi_not_configured' }, competitors_source: 'ai' },
    })
    const note = wrapper.find('.ob-source-note')
    expect(note.attributes('role')).toBe('note')
    expect(note.text()).toBe("Google search isn't set up on this workspace, so these are AI suggestions, not Google results.")
    expect(wrapper.text()).not.toContain('SERPAPI_KEY')
  })

  it('also names the settings for staff', async () => {
    vi.stubEnv('DEV', false)
    const { wrapper } = await atStep(2, {
      child: CompetitorsStep,
      status: STAFF_STATUS,
      scan: { google: { ...GOOGLE_OK, configured: false, error: '' }, missing_keys: ['ANTHROPIC_API_KEY'], competitors: [], competitors_source: 'unavailable' },
    })
    expect(words(wrapper.find('.ob-source-note'))).toBe(
      "Google search isn't set up on this workspace and the AI service isn't set up, so we couldn't suggest competitors. Setting to add: SERPAPI_KEY or SCRAPERAPI_KEY; ANTHROPIC_API_KEY.",
    )
    expect(wrapper.find('.ob-empty-note').text()).toBe('Add the companies you lose deals to.')
  })

  it('loads the status on step 3 once, so the note knows who may see settings', async () => {
    await atStep(2, { child: CompetitorsStep })
    expect(agentApi.status).toHaveBeenCalledTimes(1)
  })
})

describe('step 4: prompts', () => {
  it('shows all suggested questions with their source and picks the first 3', async () => {
    const { wrapper } = await atStep(3, { child: PromptsStep })
    const rows = wrapper.findAll('.ob-prompt')
    expect(rows).toHaveLength(10)
    expect(rows.slice(0, 4).map((r) => words(r.find('.ob-prompt-source')))).toEqual([
      'From Google People also ask on Google for "best wiki software"',
      'From Google Related search on Google for "notion alternatives"',
      'Suggested by AI',
      'From Google, worded by AI Related search on Google for "best wiki software"',
    ])
    expect(rows.map((r) => r.find('input').element.checked)).toEqual([true, true, true, false, false, false, false, false, false, false])
    expect(wrapper.text()).toContain('10 suggested questions. The first 3 are picked to start.')
    expect(wrapper.find('.ob-sub').text()).toContain('Choose up to 5.')
  })

  it('allows up to 5 and locks the rest, then keeps Add your own working', async () => {
    const { flow, wrapper } = await atStep(3, { child: PromptsStep })
    const boxes = () => wrapper.findAll('.ob-prompt input')
    await boxes()[3].setValue(true)
    await boxes()[4].setValue(true)
    expect(flow.selectedPrompts.value).toHaveLength(5)
    expect(boxes().slice(5).every((b) => b.element.disabled)).toBe(true)
    expect(boxes()[5].attributes('aria-describedby')).toBe('ob-prompt-cap')
    expect(wrapper.find('#ob-prompt-cap').text()).toBe('Unselect one to add another.')

    // Typed and added with Enter: on the list, not picked at the cap.
    const input = wrapper.find('input[aria-label="Add your own prompt"]')
    await input.setValue('which wiki has the best search')
    await input.trigger('keydown', { key: 'Enter' })
    expect(flow.form.value.prompts).toHaveLength(11)
    expect(flow.form.value.prompts.at(-1)).toMatchObject({ text: 'which wiki has the best search', selected: false, custom: true })
    expect(wrapper.findAll('.ob-prompt').at(-1).find('.ob-prompt-source').exists()).toBe(false)
  })

  it('says the questions are Google-only when Claude is not set up', async () => {
    vi.stubEnv('DEV', false)
    const { wrapper } = await atStep(3, {
      child: PromptsStep,
      scan: { missing_keys: ['ANTHROPIC_API_KEY'], topics_source: 'search', topic_sources: TOPICS.map(() => 'search') },
    })
    expect(wrapper.find('.ob-source-note').text()).toBe(
      "The AI service isn't set up on this workspace, so these are Google's own questions and searches.",
    )
    expect(wrapper.text()).not.toContain('ANTHROPIC_API_KEY')
  })

  it('names the setting to staff when nothing could suggest questions', async () => {
    vi.stubEnv('DEV', false)
    const { wrapper } = await atStep(3, {
      child: PromptsStep,
      status: STAFF_STATUS,
      scan: { topics: [], topics_source: 'unavailable', missing_keys: ['ANTHROPIC_API_KEY'], google: { ...GOOGLE_OK, configured: false } },
    })
    expect(wrapper.find('.ob-empty-note').text()).toBe(
      'Suggesting questions needs Google search or the AI service, and neither is set up here. Write 1 to 5 questions your buyers ask.',
    )
    expect(wrapper.text()).toContain('Setting to add: SERPAPI_KEY or SCRAPERAPI_KEY; ANTHROPIC_API_KEY.')
    expect(wrapper.text()).not.toContain('suggested questions.')
  })
})

describe('step 5: engines and prompt runs', () => {
  it('lists the choices, pre-selects every configured engine and disables the others with a reason', async () => {
    vi.stubEnv('DEV', false)
    const { flow, wrapper } = await atStep(4, { child: RunStep })
    expect(wrapper.findAll('.ob-summary-plain li').map((li) => li.text().replace(/\s+/g, ' '))).toEqual([
      'Confluence · from Google',
      'Coda · from Google and AI',
      'Obsidian · AI suggestion',
      'Slite · from Google',
      'Craft',
    ])
    expect(wrapper.findAll('.ob-summary-list li').map((li) => li.text())).toEqual(TOPICS.slice(0, 3))
    expect(row(wrapper, 'Google results')).toBe('Available')
    expect(flow.form.value.engines).toEqual(['chatgpt', 'claude', 'perplexity'])
    expect(engineBoxes(wrapper)).toEqual([
      ['ChatGPT', true, false, ''],
      ['Claude', true, false, ''],
      ['Gemini', false, true, "Gemini isn't set up on this workspace."],
      ['Grok', false, true, "Grok isn't set up on this workspace."],
      ['Perplexity', true, false, ''],
    ])
    expect(wrapper.find('fieldset.ob-engines legend').text()).toBe('AI engines for the first research')
    expect(wrapper.text()).toContain('Your choice applies to this first research only.')
  })

  it('shows free prompt runs, never dollars, and what the first research uses', async () => {
    const { wrapper } = await atStep(4, { child: RunStep })
    expect(row(wrapper, 'Prompt runs')).toBe('13 free prompt runs left Your first research uses 9 runs (3 prompts × 3 engines).')
    expect(row(wrapper, 'AI allowance')).toBeUndefined()
    expect(wrapper.text()).not.toContain('$')
    expect(buttons(wrapper)).toEqual(['Back', 'Skip for now', 'Start research'])
    expect(startButton(wrapper).element.disabled).toBe(false)
  })

  it('counts again as engines are unticked, and needs at least one to start', async () => {
    const { flow, wrapper } = await atStep(4, { child: RunStep })
    const box = (label) => wrapper.findAll('.ob-engine').find((r) => r.text().startsWith(label)).find('input')
    await box('Perplexity').setValue(false)
    await box('Claude').setValue(false)
    expect(flow.runsNeeded.value).toBe(3)
    expect(row(wrapper, 'Prompt runs')).toContain('Your first research uses 3 runs (3 prompts × 1 engine).')

    await box('ChatGPT').setValue(false)
    expect(flow.chosenEngines.value).toEqual([])
    const start = startButton(wrapper)
    expect(start.element.disabled).toBe(true)
    expect(start.attributes('aria-describedby')).toBe('ob-run-block')
    expect(wrapper.find('#ob-run-block').text()).toBe('Pick at least one AI engine to run research.')
    // Skipping still finishes setup.
    expect(wrapper.findAll('.ob-step-actions button').find((b) => b.text() === 'Skip for now').element.disabled).toBe(false)

    await box('Claude').setValue(true)
    expect(startButton(wrapper).element.disabled).toBe(false)
    expect(wrapper.find('#ob-run-block').exists()).toBe(false)
  })

  it('never ticks an engine that is not set up', async () => {
    const { flow, wrapper } = await atStep(4, { child: RunStep })
    expect(flow.setEngineSelected('gemini', true)).toBe(false)
    expect(flow.setEngineSelected('bing', true)).toBe(false)
    const gemini = wrapper.findAll('.ob-engine input')[2]
    expect(gemini.element.disabled).toBe(true)
    await gemini.trigger('click')
    await gemini.trigger('change')
    expect(flow.form.value.engines).toEqual(['chatgpt', 'claude', 'perplexity'])
  })

  it('says when the first research needs more runs than are left, and blocks only Start', async () => {
    const { wrapper } = await atStep(4, { child: RunStep, status: { ...STATUS, prompt_runs: { ...RUNS, used: 16, remaining: 4 } } })
    expect(row(wrapper, 'Prompt runs')).toBe('4 free prompt runs left')
    expect(wrapper.find('#ob-run-block').text()).toBe(
      'This needs 9 free prompt runs and 4 of your 20 are left this month. Choose fewer prompts or engines.',
    )
    expect(startButton(wrapper).element.disabled).toBe(true)
  })

  it('lets research start again once the user chooses fewer engines', async () => {
    const { flow, wrapper } = await atStep(4, { child: RunStep, status: { ...STATUS, prompt_runs: { ...RUNS, remaining: 6 } } })
    expect(flow.researchBlock.value).toBe('runs')
    flow.setEngineSelected('perplexity', false)
    await nextTick()
    // 3 prompts x 2 engines = 6, exactly what is left.
    expect(flow.researchBlock.value).toBe('')
    expect(startButton(wrapper).element.disabled).toBe(false)
    expect(row(wrapper, 'Prompt runs')).toContain('Your first research uses 6 runs')
  })

  it('says the runs are used up, with the renewal day', async () => {
    const { wrapper } = await atStep(4, { child: RunStep, status: { ...STATUS, prompt_runs: { ...RUNS, used: 20, remaining: 0 } } })
    expect(row(wrapper, 'Prompt runs')).toBe('No free prompt runs left')
    expect(wrapper.find('#ob-run-block').text()).toBe("You have used this month's 20 free prompt runs. They renew on November 30.")
    expect(startButton(wrapper).element.disabled).toBe(true)
  })

  it('keeps the dollar allowance for a paid account and shows no runs', async () => {
    const paid = {
      ...STATUS,
      allowance: { cap_usd: 30, spent_usd: 5, exceeded: false, warning: false, show_usd: true },
      prompt_runs: { ...RUNS, unlimited: true, limit: null, remaining: null, plan: 'prompts_100' },
    }
    const { flow, wrapper } = await atStep(4, { child: RunStep, status: paid })
    expect(row(wrapper, 'AI allowance')).toBe('$25.00 of $30.00 left this month')
    expect(row(wrapper, 'Prompt runs')).toBeUndefined()
    expect(flow.runsCheck.value).toBeNull()
    expect(startButton(wrapper).element.disabled).toBe(false)
  })

  it('hides dollars when the status says so, even without a runs block', async () => {
    const { wrapper } = await atStep(4, { child: RunStep, status: { ...STATUS, prompt_runs: undefined } })
    expect(row(wrapper, 'AI allowance')).toBeUndefined()
    expect(row(wrapper, 'Prompt runs')).toBeUndefined()
    expect(wrapper.text()).not.toContain('$')
  })

  it('says research cannot run when no engine is set up, and setup still finishes', async () => {
    const none = { ...STATUS, engines: STATUS.engines.map((e) => ({ ...e, configured: false, reason: 'not_configured' })) }
    const { flow, wrapper } = await atStep(4, { child: RunStep, status: none })
    expect(flow.availability.value).toBe('no_engines')
    expect(wrapper.find('.ob-notice').text()).toBe(
      "No AI engine is set up on this workspace, so research can't run. Your project will still be set up.",
    )
    expect(buttons(wrapper)).toEqual(['Back', 'Finish setup'])
    expect(engineBoxes(wrapper).every(([, checked, disabled]) => !checked && disabled)).toBe(true)
    expect(wrapper.text()).not.toContain('Your choice applies')

    finishMocks()
    await wrapper.findAll('.ob-step-actions button')[1].trigger('click')
    await flushPromises()
    // Nothing to ask: the prompts are tracked without a scan.
    expect(post).toHaveBeenCalledWith(
      '/prompt-library/websites/w1/prompts/',
      { text: TOPICS.slice(0, 3).join('\n'), location: 'us', scan: false },
      { _silentError: true },
    )
  })

  it.each([
    ['research_disabled', 'unavailable'],
    ['agent_unavailable', 'unavailable'],
    ['allowance_exceeded', 'allowance'],
  ])('reads research.reason %s as %s', async (reason, availability) => {
    const { flow } = await atStep(4, { status: { ...STATUS, research: { available: false, reason, message: '' } } })
    expect(flow.availability.value).toBe(availability)
  })

  it('words a used-up free allowance without dollars', async () => {
    const { wrapper } = await atStep(4, { child: RunStep, status: { ...STATUS, allowance: { ...STATUS.allowance, exceeded: true } } })
    expect(wrapper.find('.ob-notice').text()).toBe("You've used this month's free AI allowance, so research can't start now.")
    expect(buttons(wrapper)).toEqual(['Back', 'Finish setup'])
  })

  it('says Google is not set up; staff also see the settings', async () => {
    vi.stubEnv('DEV', false)
    const customer = await atStep(4, { child: RunStep, status: { ...STATUS, google: { ...STATUS.google, configured: false } } })
    expect(row(customer.wrapper, 'Google results')).toBe("Google results aren't set up on this workspace, so rankings on Google are skipped.")
    mounted.pop().unmount()

    const staff = await atStep(4, { child: RunStep, status: STAFF_STATUS })
    expect(row(staff.wrapper, 'Google results')).toBe(
      "Google results aren't set up on this workspace, so rankings on Google are skipped. Setting to add: SERPAPI_KEY or SCRAPERAPI_KEY.",
    )
    expect(engineBoxes(staff.wrapper)[2]).toEqual(['Gemini', false, true, "Gemini isn't set up on this workspace. Setting: GEMINI_API_KEY."])
  })

  it('says when Google covers page one only', async () => {
    const { wrapper } = await atStep(4, { child: RunStep, status: { ...STATUS, google: { ...STATUS.google, provider: 'scraperapi', reliable_pages: 1 } } })
    expect(row(wrapper, 'Google results')).toBe('Available (page one of Google only)')
  })

  it('keeps the user choice when the status is read again, dropping engines no longer set up', async () => {
    const { flow } = await atStep(4)
    flow.setEngineSelected('claude', false)
    agentApi.status.mockResolvedValueOnce({
      data: { ...STATUS, engines: STATUS.engines.map((e) => (e.key === 'perplexity' ? { ...e, configured: false } : e)) },
    })
    await flow.loadAgentStatus()
    expect(flow.form.value.engines).toEqual(['chatgpt'])
  })

  it('drops a status answer that arrives after the flow is gone', async () => {
    let resolve
    agentApi.status.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    post.mockImplementation(() => Promise.resolve({ data: { ...SCAN } }))
    const { flow, wrapper } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    flow.goTo(4)
    await nextTick()
    expect(flow.statusState.value).toBe('loading')
    mounted.splice(mounted.indexOf(wrapper), 1)
    wrapper.unmount()
    resolve({ data: STATUS })
    await flushPromises()
    expect(flow.agentStatus.value).toBeNull()
    expect(flow.form.value.engines).toEqual([])
  })
})

describe('step 5: the engines travel with the first research', () => {
  it('stashes the chosen engines with the research and says them in the first message', async () => {
    const { flow } = await atStep(4)
    flow.setEngineSelected('chatgpt', false)
    finishMocks()
    await flow.startResearch()
    const entry = useFirstResearch().take('w1')
    expect(entry.engines).toEqual(['claude', 'perplexity'])
    expect(entry.text.split('\n').at(-1)).toBe('Ask only these AI engines: Claude, Perplexity.')
    expect(JSON.parse(sessionStorage.getItem(FIRST_RUN_KEY))).toEqual({
      websiteId: 'w1',
      chatId: null,
      mode: 'research',
      auditId: null,
      engines: ['claude', 'perplexity'],
      createdAt: expect.any(Number),
    })
  })

  it('limits the skipped scan to the chosen engines and remembers its audit', async () => {
    const { flow } = await atStep(4)
    flow.setEngineSelected('perplexity', false)
    finishMocks()
    await flow.skipResearch()
    expect(post).toHaveBeenCalledWith(
      '/prompt-library/websites/w1/prompts/',
      { text: TOPICS.slice(0, 3).join('\n'), location: 'us', engines: ['chatgpt', 'claude'] },
      { _silentError: true },
    )
    expect(JSON.parse(sessionStorage.getItem(FIRST_RUN_KEY))).toMatchObject({ mode: 'skip', auditId: 'a1', engines: ['chatgpt', 'claude'] })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('tracks the prompts without a scan when every engine is unticked', async () => {
    const { flow } = await atStep(4)
    ;['chatgpt', 'claude', 'perplexity'].forEach((k) => flow.setEngineSelected(k, false))
    finishMocks()
    await flow.skipResearch()
    expect(post.mock.calls[1][1]).toEqual({ text: TOPICS.slice(0, 3).join('\n'), location: 'us', scan: false })
  })

  it.each([
    [
      'insufficient_prompt_runs',
      { error: 'insufficient_prompt_runs', message: 'This needs 9 free prompt runs and 4 of your 20 are left this month. Choose fewer prompts or engines.', details: {} },
      'Your project and prompts are saved, but the AI engines were not asked yet. This needs 9 free prompt runs and 4 of your 20 are left this month. Choose fewer prompts or engines.',
    ],
    [
      'prompt_runs_exhausted without a message',
      { error: 'prompt_runs_exhausted', details: { needed: 9, remaining: 0, limit: 20, resets_at: RUNS.resets_at } },
      "Your project and prompts are saved, but the AI engines were not asked yet. You have used this month's 20 free prompt runs. They renew on November 30.",
    ],
  ])('says why the skipped scan did not start for %s', async (_, scanError, text) => {
    const { flow } = await atStep(4)
    finishMocks({ prompts: { data: { created_count: 3, scan_audit_id: null, scan_error: scanError } } })
    await flow.skipResearch()
    expect(toast.warning).toHaveBeenCalledWith(text)
    expect(JSON.parse(sessionStorage.getItem(FIRST_RUN_KEY)).auditId).toBeNull()
  })

  it('stays quiet about other scan errors', async () => {
    const { flow } = await atStep(4)
    finishMocks({ prompts: { data: { created_count: 3, scan_error: { error: 'no_llm_provider_configured', missing: [] } } } })
    await flow.skipResearch()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('sends no engines when the status could not be read', async () => {
    agentApi.status.mockRejectedValue(new Error('offline'))
    post.mockImplementation(() => Promise.resolve({ data: { ...SCAN } }))
    const { flow, wrapper } = host(RunStep)
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    flow.goTo(4)
    await flushPromises()
    expect(flow.availability.value).toBe('unknown')
    expect(wrapper.find('.ob-engines').exists()).toBe(false)
    expect(startButton(wrapper).element.disabled).toBe(false)

    finishMocks()
    await flow.skipResearch()
    expect(post.mock.calls[1][1]).toEqual({ text: TOPICS.slice(0, 3).join('\n'), location: 'us' })
  })

  it('stashes no engines and no engine line when the status could not be read', async () => {
    agentApi.status.mockRejectedValue(new Error('offline'))
    post.mockImplementation(() => Promise.resolve({ data: { ...SCAN } }))
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    flow.goTo(4)
    await flushPromises()
    finishMocks()
    await flow.startResearch()
    const entry = useFirstResearch().take('w1')
    expect(entry.engines).toBeNull()
    expect(entry.text).not.toContain('Ask only these AI engines')
  })

  it('still finishes when session storage refuses the first-run entry', async () => {
    const { flow } = await atStep(4)
    finishMocks()
    const original = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === FIRST_RUN_KEY) throw new Error('QuotaExceededError')
      return original.call(this, key, value)
    })
    try {
      await flow.skipResearch()
    } finally {
      spy.mockRestore()
    }
    expect(auth.fetchSession).toHaveBeenCalled()
    expect(sessionStorage.getItem(FIRST_RUN_KEY)).toBeNull()
  })
})
