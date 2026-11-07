// Test fixtures only (never imported by app code). Payloads the polished
// pages read, copied from the contracts (design/pages_contract.md sections
// 2g, 3, 4b and 5) and from the existing search-gap overview and prompt
// endpoints. Each builder takes overrides.

export const WEBSITE_ID = 'c9a1e5c2-0000-4000-8000-000000000001'
export const PROMPT_ID = '6f1c0c6e-0000-4000-8000-000000000001'

function engines(cells = {}) {
    const base = {
        configured: true,
        answers: 3,
        mentioned: true,
        rank: 2,
        visibility_pct: 67,
        score: 70,
        class: 'even',
    }
    return {
        chatgpt: { ...base, ...cells.chatgpt },
        claude: { ...base, answers: 0, mentioned: false, rank: null, visibility_pct: null, score: null, class: 'no_data', ...cells.claude },
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
        google: {
            status: 'ok',
            position: 4,
            page: 1,
            url: 'https://notion.so/',
            title: 'Notion',
            score: 80,
            checked_at: '2026-11-01T10:00:00Z',
            depth: 100,
            error: '',
        },
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
            google_checked: 3,
            not_in_google: 0,
            ai_ahead: 1,
            google_ahead: 0,
            strong_both: 1,
            invisible_both: 1,
            even: 0,
            no_data: 0,
        },
        prompts: [
            overviewRow('p-1', {
                text: 'best note taking app for teams',
                gap: { ai_score: 90, search_score: 20, value: 70, class: 'ai_ahead', by_engine: {} },
            }),
            overviewRow('p-2', {
                text: 'notion alternatives for startups',
                location: 'gb',
                google: {
                    status: 'ok',
                    position: 1,
                    page: 1,
                    url: '',
                    title: '',
                    score: 100,
                    checked_at: '2026-11-01T10:00:00Z',
                    depth: 100,
                    error: '',
                },
                gap: { ai_score: 50, search_score: 100, value: -50, class: 'google_ahead', by_engine: {} },
            }),
            overviewRow('p-3', {
                text: 'team wiki software',
                location: '',
                google: {
                    status: 'not_checked',
                    position: null,
                    page: null,
                    url: '',
                    title: '',
                    score: null,
                    checked_at: null,
                    depth: 100,
                    error: '',
                },
                gap: { ai_score: null, search_score: null, value: null, class: 'no_data', by_engine: {} },
            }),
        ],
        leaderboard: [
            { name: 'Evernote', is_you: false, visibility_pct: 60, by_engine: {} },
            { name: 'Notion', is_you: true, visibility_pct: 25, by_engine: {} },
        ],
        ...overrides,
    }
}

/** GET /llm-ranking/<wid>/visibility-dashboard/ (contract 5). */
export function dashboardPayload(overrides = {}) {
    return {
        website: { id: WEBSITE_ID, name: 'Notion' },
        window: { period: '30d', interval: 'day', start: '2026-10-06', end: '2026-10-07', buckets: ['2026-10-06', '2026-10-07'] },
        filters: { engine: null, prompt_id: null },
        engines: [
            { key: 'chatgpt', label: 'ChatGPT', configured: true },
            { key: 'claude', label: 'Claude', configured: true },
        ],
        prompts: [
            { prompt_id: 'p-3', text: 'team wiki software', location: '' },
            { prompt_id: 'p-1', text: 'best note taking app for teams', location: 'us' },
            { prompt_id: 'p-2', text: 'notion alternatives for startups', location: 'gb' },
        ],
        has_data: true,
        empty_reason: null,
        headline: {
            answers: 120,
            answers_prev: 98,
            visibility_pct: 34.2,
            visibility_prev_pct: 30.1,
            avg_rank: 3.2,
            avg_rank_prev: 3.8,
            share_of_voice_pct: 18.2,
            share_of_voice_prev_pct: 15.0,
            citations: 340,
            your_citations: 12,
        },
        visibility: {
            by_engine: [
                { key: 'chatgpt', visibility_pct: [40.0, null], answers: [5, 0], avg_rank: [2.0, null] },
                { key: 'claude', visibility_pct: [25.0, null], answers: [4, 0], avg_rank: [3.0, null] },
            ],
            all: { visibility_pct: [35.0, null], answers: [12, 0] },
        },
        share_of_voice: { brands: [], series: {} },
        sentiment: { totals: { positive: 0, neutral: 0, negative: 0 }, series: {} },
        citations: { has_data: false, totals: null, series: {}, top_domains: [] },
        by_engine: [],
        by_prompt: [],
        google_history: null,
        ...overrides,
    }
}

/** GET /search-gap/websites/<wid>/prompts/<pid>/ with contract 3's `google.method`. */
export function promptDetail(overrides = {}, googleOverrides = {}) {
    return {
        prompt: { id: PROMPT_ID, brand_prompt_id: 'bp-1', text: 'best note taking app for teams', location: 'gb', tags: [] },
        website: { id: WEBSITE_ID, name: 'Notion', url: 'https://notion.so' },
        serp_configured: true,
        google: {
            status: 'ok',
            position: 4,
            page: 1,
            url: 'https://notion.so/',
            title: 'Notion',
            score: 80,
            checked_at: '2026-11-01T10:00:00Z',
            depth: 100,
            error: '',
            top_results: [],
            ai_overview: {},
            gsc: null,
            method: { method: 'google_setting', label: 'Google set to GB, US connection' },
            ...googleOverrides,
        },
        engines: [],
        gap: { ai_score: 70, search_score: 80, value: -10, class: 'even', by_engine: {} },
        verdict: 'ChatGPT lists you #2. Google has you at #4 (page 1).',
        actions: [],
        ...overrides,
    }
}

/** GET /search-gap/websites/<wid>/countries/?prompt_id= (contract 2g). */
export function countryMatrix(overrides = {}) {
    const cell = (fields) => ({
        id: `r-${fields.country}-${fields.engine}`,
        run_id: 'run-1',
        prompt_id: PROMPT_ID,
        status: 'done',
        state: 'ok',
        method: 'google_setting',
        method_label: 'Google set to GB, US connection',
        position: null,
        depth: null,
        url: '',
        pages_fetched: 0,
        ai_overview: null,
        mentioned: null,
        rank: null,
        sentiment: null,
        error: null,
        checked_at: '2026-11-04T10:00:20Z',
        ...fields,
    })
    return {
        google: { configured: true, provider: 'scraperapi' },
        engines: [
            { key: 'chatgpt', label: 'ChatGPT', configured: true },
            { key: 'claude', label: 'Claude', configured: true },
        ],
        prompts: [{ prompt_id: PROMPT_ID, text: 'best note taking app for teams', location: 'gb' }],
        countries: [
            { country: 'de', name: 'Germany', last_checked_at: '2026-11-04T10:02:00Z' },
            { country: 'gb', name: 'United Kingdom', last_checked_at: '2026-11-04T10:02:00Z' },
        ],
        cells: [
            cell({ country: 'gb', engine: 'google', position: 4, depth: 10, pages_fetched: 1 }),
            cell({
                country: 'gb',
                engine: 'chatgpt',
                method: 'asked',
                method_label: 'Asked to answer for GB',
                mentioned: true,
                rank: 2,
            }),
            cell({
                country: 'de',
                engine: 'google',
                state: 'not_found',
                method_label: 'Google set to DE, US connection',
                depth: 10,
            }),
            cell({
                country: 'de',
                engine: 'claude',
                state: 'failed',
                status: 'failed',
                method: 'asked',
                method_label: 'Asked to answer for DE',
                error: { code: 'timeout', message: 'The engine did not respond in time.' },
            }),
        ],
        gaps: [
            {
                prompt_id: PROMPT_ID,
                country: 'gb',
                class: 'google_ahead',
                value: -40,
                definite: true,
                ai_score: 40,
                search_score: 80,
                search_score_max: null,
            },
            {
                prompt_id: PROMPT_ID,
                country: 'de',
                class: 'no_data',
                value: null,
                definite: false,
                ai_score: null,
                search_score: null,
                search_score_max: 60,
            },
        ],
        last_checked_at: '2026-11-04T10:02:00Z',
        active_run: null,
        ...overrides,
    }
}

/** GET /web-analytics/<wid>/traffic/sources/ (contract 4b). */
export function trafficSources(overrides = {}) {
    return {
        default_source: 'pixel',
        sources: [
            {
                key: 'pixel',
                label: 'Cansee pixel',
                connected: true,
                has_data: true,
                status: 'ok',
                detail: 'Last event 2026-11-04T09:58:00Z',
                measured_since: '2026-10-20',
                measures: { visitors: 'visitors', countries: true, referrers: true, ai_referrals: true, ai_crawlers: false },
            },
            {
                key: 'ga4',
                label: 'Google Analytics 4',
                connected: false,
                has_data: false,
                status: 'not_connected',
                detail: '',
                measured_since: null,
                measures: { visitors: 'users', countries: true, referrers: true, ai_referrals: true, ai_crawlers: false },
            },
            {
                key: 'ga_hosted',
                label: 'Cansee Google tag',
                connected: false,
                has_data: false,
                status: 'not_connected',
                detail: '',
                measured_since: null,
                measures: { visitors: 'live_only', countries: false, referrers: false, ai_referrals: false, ai_crawlers: false },
            },
            {
                key: 'cloudflare',
                label: 'Cloudflare',
                connected: true,
                has_data: true,
                status: 'ok',
                detail: 'example.com',
                measured_since: null,
                measures: { visitors: 'requests', countries: true, referrers: false, ai_referrals: false, ai_crawlers: 'unknown' },
            },
        ],
        ...overrides,
    }
}
