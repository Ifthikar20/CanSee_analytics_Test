// ContextOverview payloads (p2_contract.md 11b) for the Context page specs.

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString()

export const SECTIONS = [
  { key: 'company', label: 'Company', help: 'Who you are: what you do, for whom, since when, and proof such as customers and awards.', entries: 1, suggested: 1, references: 2 },
  { key: 'audience', label: 'Audience', help: 'Who buys, what they need, what holds them back and how they decide.', entries: 1, suggested: 0, references: 1 },
  { key: 'competitors', label: 'Competitors', help: 'The competitors you track and how you differ from each.', entries: 0, suggested: 0, references: 0 },
  { key: 'offerings', label: 'Offerings', help: 'Products, plans, prices, features and integrations.', entries: 3, suggested: 0, references: 5 },
  { key: 'strategy', label: 'Strategy', help: 'What you are trying to win: positioning, priorities, target questions and markets.', entries: 0, suggested: 0, references: 0 },
  { key: 'execution', label: 'Execution', help: 'How to write for you: voice, words to use or avoid, rules and review steps.', entries: 0, suggested: 0, references: 0 },
]

export function entry(overrides = {}) {
  return {
    id: 'e1',
    section: 'company',
    title: 'Founded in 2013',
    body: 'Notion was founded in 2013 in San Francisco.',
    status: 'active',
    origin: 'user',
    position: 0,
    revision: 2,
    updated_at: hoursAgo(3),
    updated_by_name: 'Sam',
    build_run_id: null,
    references: [],
    ...overrides,
  }
}

export function pageRef(overrides = {}) {
  return {
    id: 'r1',
    kind: 'page',
    label: '/about',
    url: 'https://notion.so/about',
    quote: 'Founded in 2013',
    fact_id: null,
    document_id: null,
    competitor_domain: '',
    state: 'ok',
    checked_at: hoursAgo(2),
    ...overrides,
  }
}

export function overview(overrides = {}) {
  return {
    sections: SECTIONS,
    entries: [
      entry({ id: 'e1', references: [pageRef(), pageRef({ id: 'r2', label: '/pricing', url: 'https://notion.so/pricing', quote: '', state: 'changed' })] }),
      entry({
        id: 'e2',
        title: 'Used by 4 million teams',
        body: '',
        status: 'suggested',
        origin: 'built',
        position: 1,
        revision: 1,
        build_run_id: 'run-1',
        references: [pageRef({ id: 'r3', label: '/customers', url: 'https://notion.so/customers', quote: 'Trusted by teams' })],
      }),
      entry({ id: 'e3', section: 'audience', title: 'Audience', body: 'Operations leads', origin: 'migrated', revision: 1, references: [] }),
      entry({ id: 'e4', section: 'offerings', title: 'Plus plan', body: '$10 per seat', position: 0 }),
      entry({ id: 'e5', section: 'offerings', title: 'Business plan', body: '', position: 1 }),
      entry({ id: 'e6', section: 'offerings', title: 'AI add-on', body: '', position: 2 }),
    ],
    documents: [{ id: 'd1', title: 'Positioning notes', chars: 5200, cited_by: 2, updated_at: hoursAgo(5), updated_by_name: 'Sam' }],
    facts: { approved: 14, pending: 3 },
    competitors: [{ name: 'Evernote', domain: 'evernote.com' }],
    totals: { entries: 5, suggested: 1, references: 8 },
    build: { available: true, reason: null, active_run: null, last_run: null },
    can_edit: true,
    ...overrides,
  }
}

export function emptyOverview(overrides = {}) {
  return overview({
    sections: SECTIONS.map((s) => ({ ...s, entries: 0, suggested: 0, references: 0 })),
    entries: [],
    documents: [],
    totals: { entries: 0, suggested: 0, references: 0 },
    ...overrides,
  })
}

// RunOptions and RunEstimate of kind context_build (contract 1e, 11c).
export const BUILD_OPTIONS = {
  kind: 'context_build',
  enabled: true,
  configured: { ai: true },
  limits: {},
  allowance: { unlimited: false, cap_usd: '5.00', spent_usd: '0.92', left_usd: '4.08' },
  choices: {
    domain: 'notion.so',
    documents: [{ id: 'd1', title: 'Positioning notes', chars: 5200 }],
    facts: { approved: 14, pending: 3 },
    competitors: 1,
    recheck: 6,
    runs_today: 1,
    runs_limit: 5,
  },
  active_run: null,
  last_run: null,
}

export function buildEstimate(overrides = {}) {
  return {
    kind: 'context_build',
    summary: 'Up to 8 pages of notion.so and 1 documents; re-checks 6 cited pages',
    units: { pages: 8, rechecks: 6, documents: 1, requests: 2 },
    ai: { calls_max: 2, usd_max: '0.0200', model_label: 'Claude Haiku 5.5' },
    google: { pages_max: 0, credits_max: 0, usd_max: '0.0000', daily_left: 60, daily_limit: 60 },
    fetches: { pages_max: 14 },
    allowance: { unlimited: false, cap_usd: '5.00', left_usd: '4.08', enough: true },
    confirm: { ai_calls: 2, ai_usd_max: '0.0200', google_pages: 0 },
    warnings: [{ code: 'upper_bound', message: 'These are upper bounds; you are billed only for what runs.' }],
    blockers: [],
    can_run: true,
    ...overrides,
  }
}

export function buildRun(overrides = {}) {
  return {
    id: 'run-1',
    kind: 'context_build',
    kind_label: 'Context build',
    status: 'done',
    summary: '',
    created_at: hoursAgo(1),
    started_at: hoursAgo(1),
    finished_at: hoursAgo(1),
    duration_ms: 12000,
    created_by_name: 'Sam',
    progress: { total: 16, queued: 0, running: 0, done: 16, failed: 0, skipped: 0, cancelled: 0 },
    cost: { ai_usd: '0.0061', google_pages: 0, scraperapi_credits: null },
    confirmed: { ai_calls: 2, ai_usd_max: '0.0200', google_pages: 0 },
    cancel_requested: false,
    error: null,
    result: { pages: [], suggested: { company: 2, offerings: 1 }, rechecked: { ok: 4, changed: 1, failed: 1 } },
    ...overrides,
  }
}
