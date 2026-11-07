// Test fixtures copied from pages_contract.md (sections 2d-2g, 4b-4e and 5),
// trimmed to the sparse shape a new project has: two days of answers, two
// prompts, two engines. Each builder returns a fresh copy; pass overrides
// to change top-level keys.

const clone = (value) => JSON.parse(JSON.stringify(value))

const VISIBILITY = {
  website: { id: 'w1', name: 'Notion' },
  window: { period: '30d', interval: 'day', start: '2026-10-06', end: '2026-11-04', buckets: ['2026-10-06', '2026-10-07'] },
  filters: { engine: null, prompt_id: null },
  engines: [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
    { key: 'gemini', label: 'Gemini', configured: false },
    { key: 'grok', label: 'Grok', configured: false },
    { key: 'perplexity', label: 'Perplexity', configured: false },
  ],
  prompts: [
    { prompt_id: 'p1', text: 'best note taking app for teams', location: 'us' },
    { prompt_id: 'p2', text: 'notion alternatives for small startups', location: '' },
  ],
  has_data: true,
  empty_reason: null,
  headline: {
    answers: 12,
    answers_prev: 8,
    visibility_pct: 34.2,
    visibility_prev_pct: 30.1,
    avg_rank: 3.2,
    avg_rank_prev: 3.8,
    share_of_voice_pct: 18.2,
    share_of_voice_prev_pct: null,
    citations: 340,
    your_citations: 12,
  },
  visibility: {
    by_engine: [
      { key: 'chatgpt', visibility_pct: [40.0, null], answers: [5, 0], avg_rank: [2.0, null] },
      { key: 'claude', visibility_pct: [28.6, null], answers: [7, 0], avg_rank: [null, null] },
    ],
    all: { visibility_pct: [33.3, null], answers: [12, 0] },
  },
  share_of_voice: {
    brands: [
      { key: 'you', name: 'Notion', is_you: true, is_competitor: false, mentions: 4, share_pct: 18.2 },
      { key: 'b1', name: 'Evernote', is_you: false, is_competitor: true, mentions: 6, share_pct: 27.3 },
      { key: 'other', name: 'Other brands', is_you: false, is_competitor: false, mentions: 3, share_pct: 13.6 },
    ],
    series: { you: [20.0, null], b1: [30.0, null], other: [10.0, null] },
  },
  sentiment: {
    totals: { positive: 2, neutral: 1, negative: 1 },
    series: { positive: [2, 0], neutral: [1, 0], negative: [1, 0] },
  },
  citations: {
    has_data: true,
    totals: { total: 340, yours: 12, competitors: 40, other: 288 },
    series: { yours: [1, 0], competitors: [2, 0], other: [9, 0] },
    top_domains: [
      { domain: 'g2.com', citations: 18, answers: 15, is_yours: false, is_competitor: false, engines: ['chatgpt'] },
      { domain: 'notion.so', citations: 12, answers: 9, is_yours: true, is_competitor: false, engines: ['claude'] },
      { domain: 'evernote.com', citations: 7, answers: 6, is_yours: false, is_competitor: true, engines: ['chatgpt'] },
    ],
  },
  by_engine: [
    {
      key: 'chatgpt', label: 'ChatGPT', configured: true, answers: 5, mentioned: 2, visibility_pct: 40.0, avg_rank: 2.0,
      sentiment: { positive: 1, neutral: 1, negative: 0 }, citations: 6, your_citations: 1,
    },
    {
      key: 'claude', label: 'Claude', configured: true, answers: 7, mentioned: 2, visibility_pct: 28.6, avg_rank: null,
      sentiment: { positive: 1, neutral: 0, negative: 1 }, citations: 6, your_citations: 0,
    },
    {
      key: 'gemini', label: 'Gemini', configured: false, answers: 0, mentioned: 0, visibility_pct: null, avg_rank: null,
      sentiment: { positive: 0, neutral: 0, negative: 0 }, citations: 0, your_citations: 0,
    },
  ],
  by_prompt: [
    {
      prompt_id: 'p1', text: 'best note taking app for teams', answers: 7, visibility_pct: 42.9,
      engines: { chatgpt: { answers: 3, visibility_pct: 66.7, avg_rank: 2.0 }, claude: { answers: 4, visibility_pct: 25.0, avg_rank: null } },
    },
    {
      prompt_id: 'p2', text: 'notion alternatives for small startups', answers: 5, visibility_pct: 20.0,
      engines: { chatgpt: { answers: 2, visibility_pct: 0.0, avg_rank: null }, claude: null },
    },
  ],
  google_history: null,
}

export function visibilityPayload(overrides = {}) {
  return { ...clone(VISIBILITY), ...clone(overrides) }
}

const OPTIONS = {
  enabled: true,
  limits: { max_countries: 5, max_prompts: 10, max_pages: 2, max_google_pages: 50, max_engine_answers: 100 },
  google: {
    configured: true, provider: 'scraperapi', provider_label: 'ScraperAPI',
    credits_per_page: 25, usd_per_page: '0.0000', daily: { limit: 100, used: 12, left: 88 },
  },
  engines: [
    { key: 'chatgpt', label: 'ChatGPT', configured: true, method: 'asked', method_label: 'Asked to answer for each country', usd_per_answer_max: '0.0200' },
    { key: 'claude', label: 'Claude', configured: true, method: 'asked', method_label: 'Asked to answer for each country', usd_per_answer_max: '0.0200' },
    { key: 'gemini', label: 'Gemini', configured: false, method: 'asked', method_label: 'Asked to answer for each country', usd_per_answer_max: '0.0200' },
    { key: 'grok', label: 'Grok', configured: false, method: 'asked', method_label: 'Asked to answer for each country', usd_per_answer_max: '0.0200' },
    { key: 'perplexity', label: 'Perplexity', configured: false, method: 'searched', method_label: 'Searched from each country', usd_per_answer_max: '0.0300' },
  ],
  countries: [
    { country: 'de', name: 'Germany', google_method: 'google_setting', google_method_label: 'Google set to DE, US connection' },
    { country: 'fr', name: 'France', google_method: 'google_setting', google_method_label: 'Google set to FR, US connection' },
    { country: 'gb', name: 'United Kingdom', google_method: 'google_setting', google_method_label: 'Google set to GB, US connection' },
    { country: 'us', name: 'United States', google_method: 'proxy', google_method_label: 'Searched from US' },
  ],
  prompts: [
    { prompt_id: 'p1', text: 'best note taking app for teams', location: 'us' },
    { prompt_id: 'p2', text: 'notion alternatives for small startups', location: '' },
  ],
  allowance: { unlimited: false, cap_usd: '5.00', spent_usd: '0.92', left_usd: '4.08' },
  active_run: null,
  last_run: null,
}

export function countryOptions(overrides = {}) {
  return { ...clone(OPTIONS), ...clone(overrides) }
}

const ESTIMATE = {
  cells: 12,
  google: {
    included: true, pages_max: 4, credits_max: 100, usd_max: '0.0000',
    provider: 'scraperapi', provider_label: 'ScraperAPI',
    daily_limit: 100, daily_left: 88, enough_daily: true,
    countries: [{ country: 'gb', method: 'google_setting', method_label: 'Google set to GB, US connection' }],
  },
  engines: {
    answers: 8, usd_max: '0.1600',
    by_engine: [
      { key: 'chatgpt', label: 'ChatGPT', answers: 4, usd_max: '0.0800', method: 'asked', method_label: 'Asked to answer for each country' },
      { key: 'claude', label: 'Claude', answers: 4, usd_max: '0.0800', method: 'asked', method_label: 'Asked to answer for each country' },
    ],
  },
  allowance: { unlimited: false, cap_usd: '5.00', left_usd: '4.08', enough: true },
  confirm: { google_pages: 4, engine_answers: 8, ai_usd_max: '0.1600' },
  warnings: [
    { code: 'asked_not_searched', message: 'ChatGPT and Claude answer without web search here, so they are asked to answer for each country instead of searching from it.' },
    { code: 'upper_bound', message: 'These are upper bounds; checks stop early when your site is found and failed requests are not billed.' },
  ],
  blockers: [],
  can_run: true,
}

export function countryEstimate(overrides = {}) {
  return { ...clone(ESTIMATE), ...clone(overrides) }
}

const RUN = {
  id: 'run-1',
  status: 'running',
  created_at: '2026-11-04T10:00:00Z',
  started_at: '2026-11-04T10:00:01Z',
  finished_at: null,
  duration_ms: null,
  created_by_name: 'Site Owner',
  countries: [
    { country: 'gb', name: 'United Kingdom', status: 'running', google_method: 'google_setting', google_method_label: 'Google set to GB, US connection' },
    { country: 'de', name: 'Germany', status: 'queued', google_method: 'google_setting', google_method_label: 'Google set to DE, US connection' },
  ],
  prompts: [{ prompt_id: 'p1', text: 'best note taking app for teams' }],
  engines: [{ key: 'chatgpt', label: 'ChatGPT', method: 'asked', method_label: 'Asked to answer for each country' }],
  include_google: true,
  google_pages: 1,
  provider: 'scraperapi',
  confirmed: { google_pages: 4, engine_answers: 8, ai_usd_max: '0.1600' },
  progress: { total: 12, queued: 6, running: 2, done: 3, failed: 1, skipped: 0, cancelled: 0 },
  cost: { google_pages_fetched: 2, scraperapi_credits: 50, google_usd: '0.0000', ai_usd: '0.0412' },
  cancel_requested: false,
  error: null,
}

export function countryRun(overrides = {}) {
  return { ...clone(RUN), ...clone(overrides) }
}

export function finishedRun(overrides = {}) {
  return countryRun({
    status: 'done',
    finished_at: '2026-11-04T10:01:12Z',
    duration_ms: 72000,
    countries: RUN.countries.map((c) => ({ ...c, status: 'done' })),
    progress: { total: 12, queued: 0, running: 0, done: 12, failed: 0, skipped: 0, cancelled: 0 },
    cost: { google_pages_fetched: 4, scraperapi_credits: 100, google_usd: '0.0000', ai_usd: '0.0890' },
    ...overrides,
  })
}

const CELLS = [
  {
    id: 'c1', run_id: 'run-0', prompt_id: 'p1', country: 'gb', engine: 'google', status: 'done', state: 'ok',
    method: 'google_setting', method_label: 'Google set to GB, US connection',
    position: 4, depth: 10, url: 'https://www.notion.so/product', pages_fetched: 1,
    ai_overview: { shown: true, content_captured: false, mentions_you: null, cites_you: null },
    mentioned: null, rank: null, sentiment: null, error: null, checked_at: '2026-11-04T10:00:20Z',
  },
  {
    id: 'c2', run_id: 'run-0', prompt_id: 'p1', country: 'gb', engine: 'chatgpt', status: 'done', state: 'ok',
    method: 'asked', method_label: 'Asked to answer for GB',
    position: null, depth: null, url: '', pages_fetched: 0, ai_overview: null,
    mentioned: true, rank: 2, sentiment: 'positive', error: null, checked_at: '2026-11-04T10:00:22Z',
  },
  {
    id: 'c3', run_id: 'run-0', prompt_id: 'p1', country: 'de', engine: 'google', status: 'done', state: 'not_found',
    method: 'google_setting', method_label: 'Google set to DE, US connection',
    position: null, depth: 10, url: '', pages_fetched: 1, ai_overview: { shown: false },
    mentioned: null, rank: null, sentiment: null, error: null, checked_at: '2026-11-04T10:00:30Z',
  },
  {
    id: 'c4', run_id: 'run-0', prompt_id: 'p1', country: 'de', engine: 'chatgpt', status: 'failed', state: 'failed',
    method: 'asked', method_label: 'Asked to answer for DE',
    position: null, depth: null, url: '', pages_fetched: 0, ai_overview: null,
    mentioned: null, rank: null, sentiment: null,
    error: { code: 'timeout', message: 'The engine did not respond in time.' }, checked_at: '2026-11-04T10:00:40Z',
  },
]

const MATRIX = {
  google: { configured: true, provider: 'scraperapi' },
  engines: [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
    { key: 'gemini', label: 'Gemini', configured: false },
  ],
  prompts: [
    { prompt_id: 'p1', text: 'best note taking app for teams', location: 'us' },
    { prompt_id: 'p2', text: 'notion alternatives for small startups', location: '' },
  ],
  countries: [
    {
      country: 'de', name: 'Germany', last_checked_at: '2026-11-04T10:00:40Z',
      google: { state: 'ok', checked: 1, found: 0, not_found: 1, failed: 0, avg_position: null, best_position: null, depth: 10, method: 'google_setting', method_label: 'Google set to DE, US connection' },
      engines: {
        chatgpt: { state: 'failed', method: 'asked', method_label: 'Asked to answer for DE' },
        claude: { state: 'not_checked' },
      },
      ai_visibility_pct: null,
      gap_counts: { ai_ahead: 0, google_ahead: 0, strong_both: 0, invisible_both: 0, even: 0, no_data: 1 },
    },
    {
      country: 'gb', name: 'United Kingdom', last_checked_at: '2026-11-04T10:00:22Z',
      google: { state: 'ok', checked: 1, found: 1, not_found: 0, failed: 0, avg_position: 4, best_position: 4, depth: 10, method: 'google_setting', method_label: 'Google set to GB, US connection' },
      engines: {
        chatgpt: { state: 'ok', answered: 1, mentioned: 1, visibility_pct: 100.0, avg_rank: 2.0, method: 'asked', method_label: 'Asked to answer for GB' },
        claude: { state: 'not_checked' },
      },
      ai_visibility_pct: 100.0,
      gap_counts: { ai_ahead: 1, google_ahead: 0, strong_both: 0, invisible_both: 0, even: 0, no_data: 0 },
    },
  ],
  cells: CELLS,
  gaps: [
    { prompt_id: 'p1', country: 'gb', class: 'ai_ahead', value: 25, definite: true, ai_score: 85, search_score: 60, search_score_max: null },
    { prompt_id: 'p1', country: 'de', class: 'no_data', value: null, definite: false, ai_score: null, search_score: null, search_score_max: 40 },
  ],
  last_checked_at: '2026-11-04T10:00:40Z',
  active_run: null,
}

export function countryMatrix(overrides = {}) {
  return { ...clone(MATRIX), ...clone(overrides) }
}

export function emptyMatrix(overrides = {}) {
  return countryMatrix({ countries: [], cells: [], gaps: [], last_checked_at: null, ...overrides })
}

export function cellDetail(overrides = {}) {
  return {
    ...clone(CELLS[1]),
    answer_text: 'For teams, Notion and Evernote are common picks.\nNotion suits shared docs.',
    brands: [{ name: 'Evernote', position: 1 }, { name: 'Notion', position: 2 }],
    citations: ['https://www.g2.com/categories/note-taking'],
    model_id: 'gpt-4o-mini',
    extraction_model: 'claude-haiku',
    prompt_text: 'best note taking app for teams',
    country_name: 'United Kingdom',
    ...clone(overrides),
  }
}

const SOURCES = {
  default_source: 'pixel',
  sources: [
    {
      key: 'pixel', label: 'Cansee pixel', connected: true, has_data: true, status: 'ok',
      detail: 'Last event 2026-11-04T09:58:00Z', measured_since: '2026-10-20',
      measures: { visitors: 'visitors', countries: true, referrers: true, ai_referrals: true, ai_crawlers: false },
    },
    {
      key: 'ga4', label: 'Google Analytics 4', connected: false, has_data: false, status: 'not_connected',
      detail: '', measured_since: null,
      measures: { visitors: 'users', countries: true, referrers: true, ai_referrals: true, ai_crawlers: false },
    },
    {
      key: 'ga_hosted', label: 'Cansee Google tag', connected: false, has_data: false, status: 'not_connected',
      detail: '', measured_since: null,
      measures: { visitors: 'live_only', countries: false, referrers: false, ai_referrals: false, ai_crawlers: false },
    },
    {
      key: 'cloudflare', label: 'Cloudflare', connected: true, has_data: true, status: 'ok',
      detail: 'example.com', measured_since: null,
      measures: { visitors: 'requests', countries: true, referrers: false, ai_referrals: false, ai_crawlers: 'unknown' },
    },
  ],
}

export function trafficSources(overrides = {}) {
  return { ...clone(SOURCES), ...clone(overrides) }
}

const TRAFFIC = {
  source: 'pixel', source_label: 'Cansee pixel', period: '30d',
  available_sources: ['pixel', 'cloudflare'],
  metric: 'visitors', metric_label: 'Unique visitors', sampled: false, stale: false,
  measured_since: '2026-10-07',
  empty_reason: null,
  overview: { visitors: 41, visitors_change_pct: null, pageviews: 95, pageviews_change_pct: null, sessions: 51, sessions_change_pct: null },
  series: { labels: ['2026-10-06', '2026-10-07'], visitors: [null, 41], pageviews: [null, 95], sessions: [null, 51] },
  countries: [{ code: 'US', value: 30, share_pct: 73.2 }, { code: 'GB', value: 8, share_pct: 19.5 }],
  countries_unknown: 3,
  referrers: [
    { source: 'google', medium: 'organic', sessions: 20, is_ai: false },
    { source: 'chatgpt.com', medium: 'referral', sessions: 4, is_ai: true },
  ],
  pages: [{ path: '/pricing', views: 41 }, { path: '/', views: 30 }],
  devices: [{ name: 'Desktop', value: 30, share_pct: 73.2 }, { name: 'Mobile', value: 11, share_pct: 26.8 }],
  notes: ['The Cansee pixel started recording on 2026-10-07; earlier days are not measured.'],
}

export function trafficPayload(overrides = {}) {
  return { ...clone(TRAFFIC), ...clone(overrides) }
}

export function cloudflareTraffic(overrides = {}) {
  return trafficPayload({
    source: 'cloudflare', source_label: 'Cloudflare', metric: 'requests', metric_label: 'Requests', sampled: true,
    measured_since: null,
    overview: { visitors: 5400, visitors_change_pct: 12.7, pageviews: 3010, pageviews_change_pct: -4.2, sessions: null, sessions_change_pct: null },
    series: { labels: ['2026-10-06', '2026-10-07'], visitors: [2600, 2800], pageviews: [1500, 1510], sessions: [null, null] },
    referrers: null,
    countries_unknown: null,
    notes: [
      'Cloudflare counts every request to your site, including bots and crawlers, so these numbers are not visitors.',
      'Cloudflare samples its breakdowns, so countries, pages and devices are estimates.',
      'Cloudflare does not report referrers on this plan.',
    ],
    ...overrides,
  })
}

export function emptyTraffic(reason, overrides = {}) {
  return trafficPayload({
    empty_reason: reason, overview: null, series: null, countries: [], countries_unknown: null,
    referrers: [], pages: [], devices: [], notes: [], ...overrides,
  })
}

export function trafficCountries(overrides = {}) {
  return {
    source: 'pixel', source_label: 'Cansee pixel', period: '30d', available_sources: ['pixel'],
    metric: 'visitors', metric_label: 'Unique visitors', sampled: false, stale: false, empty_reason: null,
    countries: [{ code: 'US', value: 30, share_pct: 73.2 }, { code: 'GB', value: 8, share_pct: 19.5 }, { code: 'DE', value: 3, share_pct: 7.3 }],
    countries_unknown: 3, total: 44, notes: [],
    ...clone(overrides),
  }
}

const AI_TRAFFIC = {
  period: '30d',
  referrals: {
    source: 'pixel', source_label: 'Cansee pixel', available: true, reason: null,
    total_sessions: 51, ai_sessions: 4, ai_share_pct: 7.8,
    assistants: [
      { key: 'chatgpt', label: 'ChatGPT', sessions: 3, share_pct: 75.0 },
      { key: 'perplexity', label: 'Perplexity', sessions: 1, share_pct: 25.0 },
    ],
    series: { labels: ['2026-10-06', '2026-10-07'], by_assistant: { chatgpt: [null, 3], perplexity: [null, 1] } },
    landing_pages: [{ path: '/pricing', sessions: 3, by_assistant: { chatgpt: 2, perplexity: 1 } }],
    countries: [{ code: 'US', sessions: 3 }, { code: 'GB', sessions: 1 }],
    measured_since: '2026-10-07',
    notes: [],
  },
  crawlers: {
    source: 'cloudflare', available: true, reason: null,
    window_days: 7, window_start: '2026-10-28', sampled: true, verified: false,
    total_requests: 2500,
    bots: [
      { key: 'gptbot', name: 'GPTBot', operator: 'OpenAI', purpose: 'training', requests: 2100, share_pct: 84.0 },
      { key: 'claudebot', name: 'ClaudeBot', operator: 'Anthropic', purpose: 'training', requests: 300, share_pct: 12.0 },
      { key: 'ccbot', name: 'CCBot', operator: 'Common Crawl', purpose: 'training', requests: 60, share_pct: 2.4 },
      { key: 'amazonbot', name: 'Amazonbot', operator: 'Amazon', purpose: 'search', requests: 40, share_pct: 1.6 },
    ],
    purposes: [{ key: 'training', label: 'Model training', requests: 2460 }, { key: 'search', label: 'AI search index', requests: 40 }],
    series: {
      labels: ['2026-10-28', '2026-10-29'],
      by_bot: { gptbot: [1000, 1100], claudebot: [100, 200], ccbot: [30, 30], amazonbot: [null, 40] },
    },
    paths: [{ path: '/blog/how-to', requests: 320, bots: ['gptbot', 'claudebot'] }],
    notes: ['Counted from user-agent strings, which bots can fake. Cloudflare samples these numbers.'],
  },
}

export function aiTrafficPayload({ referrals = {}, crawlers = {}, ...rest } = {}) {
  const base = clone(AI_TRAFFIC)
  return {
    ...base,
    ...clone(rest),
    referrals: { ...base.referrals, ...clone(referrals) },
    crawlers: { ...base.crawlers, ...clone(crawlers) },
  }
}

/** The axios client's resolved value: the unwrapped envelope. */
export const ok = (data) => ({ success: true, data })

/** A rejected request in the client's shape (status, envelope error, displayMessage). */
export function apiError(status, code = '', message = '', details = undefined) {
  const err = new Error(message || `HTTP ${status}`)
  err.response = { status, data: { success: false, error: { code, message, ...(details ? { details } : {}) } } }
  err.displayMessage = message || 'Something went wrong on our end. Please try again.'
  return err
}
