// Test fixtures only (never imported by app code). The payloads of the
// board's sources that group A reads (board_contract.md 5), copied from
// the contracts: the search-gap overview, the visibility dashboard
// (pages_contract.md 5), the country matrix (2g), traffic (4c, with the
// wave 3 `breakdown_hours`) and AI traffic (4e). Each builder takes
// overrides.

const clone = (value) => JSON.parse(JSON.stringify(value))

export const WEBSITE_ID = 'c9a1e5c2-0000-4000-8000-000000000001'

function engines(cells = {}) {
    const base = { configured: true, answers: 3, mentioned: true, rank: 2, visibility_pct: 67, score: 70, class: 'even' }
    return {
        chatgpt: { ...base, ...cells.chatgpt },
        claude: { ...base, answers: 2, mentioned: false, rank: null, visibility_pct: 0, score: 0, class: 'google_ahead', ...cells.claude },
        gemini: {
            ...base,
            configured: false,
            answers: 0,
            mentioned: false,
            rank: null,
            visibility_pct: null,
            score: null,
            class: 'no_data',
            ...cells.gemini,
        },
    }
}

/** One row of the overview's `prompts`. */
export function overviewRow(id, fields = {}) {
    return {
        prompt_id: id,
        brand_prompt_id: `bp-${id}`,
        text: `prompt ${id}`,
        location: 'us',
        google: { status: 'ok', position: 4, page: 1, url: 'https://notion.so/', title: 'Notion', score: 80, checked_at: '2026-11-01T10:00:00Z', depth: 10, error: '' },
        engines: engines(),
        gap: { ai_score: 70, search_score: 80, value: -10, class: 'even', by_engine: {} },
        top_action: null,
        ...fields,
    }
}

/** GET /search-gap/websites/<id>/overview/ */
export function overviewPayload(overrides = {}) {
    return {
        website: { id: WEBSITE_ID, name: 'Notion', url: 'https://notion.so' },
        serp_configured: true,
        engines: [
            { key: 'chatgpt', label: 'ChatGPT', configured: true },
            { key: 'claude', label: 'Claude', configured: true },
            { key: 'gemini', label: 'Gemini', configured: false },
        ],
        kpis: {
            prompts: 3,
            ai_visibility_pct: 34,
            avg_google_position: 5.3,
            google_checked: 2,
            not_in_google: 0,
            ai_ahead: 1,
            google_ahead: 0,
            strong_both: 1,
            invisible_both: 0,
            even: 0,
            not_definite: 0,
            no_data: 1,
        },
        prompts: [
            overviewRow('p-1', {
                text: 'best note taking app for teams',
                gap: { ai_score: 90, search_score: 20, value: 70, class: 'ai_ahead', by_engine: {} },
            }),
            overviewRow('p-2', {
                text: 'notion alternatives for startups',
                google: { status: 'ok', position: null, page: null, url: '', title: '', score: 0, checked_at: '2026-11-01T10:00:00Z', depth: 10, error: '' },
                engines: engines({ chatgpt: { mentioned: false, rank: null, visibility_pct: 0 } }),
                gap: { ai_score: 0, search_score: null, value: null, value_min: null, class: 'no_data', definite: false, search_score_max: 40, by_engine: {} },
            }),
            overviewRow('p-3', {
                text: 'team wiki software',
                location: '',
                google: { status: 'not_checked', position: null, page: null, url: '', title: '', score: null, checked_at: null, depth: 10, error: '' },
                engines: engines({ chatgpt: { answers: 0, mentioned: false, rank: null }, claude: { answers: 0 } }),
                gap: { ai_score: null, search_score: null, value: null, class: 'no_data', by_engine: {} },
            }),
        ],
        leaderboard: [
            { name: 'Evernote', is_you: false, visibility_pct: 60, by_engine: {} },
            { name: 'Notion', is_you: true, visibility_pct: 25, by_engine: {} },
        ],
        ...clone(overrides),
    }
}

/** GET /llm-ranking/<wid>/visibility-dashboard/?period=30d (the parts group A reads). */
export function visibilityPayload(overrides = {}) {
    return {
        website: { id: WEBSITE_ID, name: 'Notion' },
        window: { period: '30d', interval: 'day', start: '2026-10-06', end: '2026-11-04' },
        engines: [
            { key: 'chatgpt', label: 'ChatGPT', configured: true },
            { key: 'claude', label: 'Claude', configured: true },
        ],
        prompts: [
            { prompt_id: 'p-3', text: 'team wiki software', location: '' },
            { prompt_id: 'p-1', text: 'best note taking app for teams', location: 'us' },
            { prompt_id: 'p-2', text: 'notion alternatives for startups', location: 'us' },
        ],
        has_data: true,
        empty_reason: null,
        headline: { answers: 120, answers_prev: 98, visibility_pct: 34.2, visibility_prev_pct: 30.1 },
        ...clone(overrides),
    }
}

/** GET /search-gap/websites/<wid>/countries/ (contract 2g). */
export function countryMatrix(overrides = {}) {
    return {
        google: { configured: true, provider: 'scraperapi' },
        engines: [
            { key: 'chatgpt', label: 'ChatGPT', configured: true },
            { key: 'claude', label: 'Claude', configured: true },
        ],
        prompts: [{ prompt_id: 'p-1', text: 'best note taking app for teams', location: 'us' }],
        countries: [
            {
                country: 'gb', name: 'United Kingdom', last_checked_at: '2026-11-04T10:02:00Z',
                google: { state: 'ok', checked: 5, found: 3, not_found: 2, failed: 0, avg_position: 5.3, best_position: 2, depth: 10, method: 'google_setting', method_label: 'Google set to GB, US connection' },
                engines: { chatgpt: { state: 'ok', answered: 5, mentioned: 2, visibility_pct: 40.0, avg_rank: 2.5 } },
                ai_visibility_pct: 35.0,
            },
            {
                country: 'de', name: 'Germany', last_checked_at: '2026-11-04T10:02:00Z',
                google: { state: 'ok', checked: 5, found: 0, not_found: 5, failed: 0, avg_position: null, best_position: null, depth: 10 },
                engines: { chatgpt: { state: 'ok', answered: 5, mentioned: 4, visibility_pct: 80.0, avg_rank: 1.5 } },
                ai_visibility_pct: 80.0,
            },
            {
                country: 'in', name: 'India', last_checked_at: '2026-11-04T10:02:00Z',
                google: { state: 'ok', checked: 5, found: 5, not_found: 0, failed: 0, avg_position: 2, best_position: 1, depth: 10 },
                engines: { chatgpt: { state: 'failed' } },
                ai_visibility_pct: null,
            },
            {
                country: 'au', name: 'Australia', last_checked_at: '2026-11-04T10:02:00Z',
                google: { state: 'failed', checked: 0, found: 0, not_found: 0, failed: 5, avg_position: null, best_position: null, depth: null },
                engines: { chatgpt: { state: 'ok', answered: 5, mentioned: 0, visibility_pct: 0, avg_rank: null } },
                ai_visibility_pct: 0,
            },
            {
                country: 'ca', name: 'Canada', last_checked_at: '2026-11-04T10:02:00Z',
                google: { state: 'not_checked' },
                engines: { chatgpt: { state: 'ok', answered: 5, mentioned: 1, visibility_pct: 20.0, avg_rank: 4 } },
                ai_visibility_pct: 20.0,
            },
            {
                country: 'sg', name: 'Singapore', last_checked_at: '2026-11-04T10:02:00Z',
                google: { state: 'ok', checked: 5, found: 1, not_found: 4, failed: 0, avg_position: 8, best_position: 8, depth: 10 },
                engines: { chatgpt: { state: 'ok', answered: 5, mentioned: 3, visibility_pct: 60.0, avg_rank: 2 } },
                ai_visibility_pct: 60.0,
            },
        ],
        cells: [{ id: 'c1', prompt_id: 'p-1', country: 'gb', engine: 'google', status: 'done', state: 'ok', position: 4, depth: 10 }],
        gaps: [],
        last_checked_at: '2026-11-04T10:02:00Z',
        active_run: null,
        ...clone(overrides),
    }
}

export function emptyMatrix(overrides = {}) {
    return countryMatrix({ countries: [], cells: [], gaps: [], last_checked_at: null, ...overrides })
}

/** GET /web-analytics/<wid>/traffic/?period=30d&source=auto from the pixel. */
export function trafficPayload(overrides = {}) {
    return {
        source: 'pixel', source_label: 'Cansee pixel', period: '30d',
        available_sources: ['pixel'],
        metric: 'visitors', metric_label: 'Unique visitors', sampled: false, stale: false,
        measured_since: '2026-10-01',
        empty_reason: null,
        overview: { visitors: 1240, visitors_change_pct: 12.7, pageviews: 3010, pageviews_change_pct: 7.5, sessions: 1500, sessions_change_pct: 11.1 },
        series: { labels: ['2026-11-02', '2026-11-03'], visitors: [40, 52], pageviews: [95, 120], sessions: [51, 60] },
        countries: [
            { code: 'US', value: 600, share_pct: 62.0 },
            { code: 'DE', value: 90, share_pct: 9.3 },
            { code: 'IN', value: 40, share_pct: 4.1 },
            { code: 'GB', value: 30, share_pct: 3.1 },
        ],
        countries_unknown: 70,
        referrers: [{ source: 'google', medium: 'organic', sessions: 500, is_ai: false }],
        pages: [
            { path: '/pricing', views: 410 },
            { path: '/', views: 300 },
            { path: '/blog/how-to', views: 120 },
            { path: '/docs', views: 60 },
            { path: '/about', views: 12 },
            { path: '/careers', views: 3 },
        ],
        devices: [{ name: 'Desktop', value: 800, share_pct: 64.5 }],
        breakdown_hours: null,
        notes: [],
        ...clone(overrides),
    }
}

/** The same from Cloudflare: requests, bots included; sampled paths. */
export function cloudflareTraffic(overrides = {}) {
    return trafficPayload({
        source: 'cloudflare', source_label: 'Cloudflare', metric: 'requests', metric_label: 'Requests', sampled: true,
        measured_since: null,
        overview: { visitors: 48210, visitors_change_pct: -4.2, pageviews: 30100, pageviews_change_pct: 1.5, sessions: null, sessions_change_pct: null },
        series: { labels: ['2026-11-02', '2026-11-03'], visitors: [2600, 2800], pageviews: [1500, 1510], sessions: [null, null] },
        countries: [
            { code: 'US', value: 30000, share_pct: 62.2 },
            { code: 'MO', value: 4000, share_pct: 8.3 },
            { code: 'DE', value: 2500, share_pct: 5.2 },
        ],
        countries_unknown: 120,
        referrers: null,
        pages: [{ path: '/pricing', views: 9000 }, { path: '/', views: 7000 }],
        notes: ['Cloudflare counts every request to your site, including bots and crawlers, so these numbers are not visitors.'],
        ...overrides,
    })
}

export function emptyTraffic(reason, overrides = {}) {
    return trafficPayload({
        empty_reason: reason, source: null, source_label: null, overview: null, series: null, countries: [],
        countries_unknown: null, referrers: [], pages: [], devices: [], notes: [], ...overrides,
    })
}

/** GET /web-analytics/<wid>/ai-traffic/?period=30d&source=auto (contract 4e). */
export function aiTrafficPayload({ referrals = {}, crawlers = {} } = {}) {
    return {
        period: '30d',
        referrals: {
            source: 'pixel', source_label: 'Cansee pixel', available: true, reason: null,
            total_sessions: 1500, ai_sessions: 42, ai_share_pct: 2.8,
            assistants: [
                { key: 'chatgpt', label: 'ChatGPT', sessions: 30, share_pct: 71.4 },
                { key: 'perplexity', label: 'Perplexity', sessions: 8, share_pct: 19.0 },
                { key: 'claude', label: 'Claude', sessions: 3, share_pct: 7.1 },
                { key: 'gemini', label: 'Gemini', sessions: 1, share_pct: 2.4 },
            ],
            series: { labels: ['2026-11-03'], by_assistant: { chatgpt: [1] } },
            landing_pages: [],
            countries: [{ code: 'US', sessions: 20 }],
            measured_since: '2026-10-01',
            notes: [],
            ...clone(referrals),
        },
        crawlers: {
            source: 'cloudflare', available: true, reason: null,
            window_days: 7, window_start: '2026-10-28', sampled: true, verified: false,
            total_requests: 5400,
            bots: [
                { key: 'gptbot', name: 'GPTBot', operator: 'OpenAI', purpose: 'training', requests: 2100, share_pct: 38.9 },
                { key: 'claudebot', name: 'ClaudeBot', operator: 'Anthropic', purpose: 'training', requests: 1800, share_pct: 33.3 },
                { key: 'perplexitybot', name: 'PerplexityBot', operator: 'Perplexity', purpose: 'search', requests: 900, share_pct: 16.7 },
                { key: 'ccbot', name: 'CCBot', operator: 'Common Crawl', purpose: 'training', requests: 600, share_pct: 11.1 },
            ],
            purposes: [],
            series: { labels: [], by_bot: {} },
            paths: [],
            notes: [],
            ...clone(crawlers),
        },
    }
}

/** A failed request as useBoardSource reports it. */
export function failureOf(status = 500, code = '', message = '') {
    return { status, code, message }
}
