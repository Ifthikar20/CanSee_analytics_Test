// Test fixtures only (never imported by app code). The payloads of the
// board's data sources the group B cards read (board_contract.md 5), copied
// from design/pages_contract.md 5 (visibility dashboard), the search-gap
// overview and design/p2_contract.md 3c, 3d, 4a, 5d, 6, 7, 8 and 9, trimmed
// to a small project. Each builder returns a fresh copy; overrides replace
// top-level keys.

const clone = (value) => JSON.parse(JSON.stringify(value))
const build = (base, overrides = {}) => ({ ...clone(base), ...clone(overrides) })

const ENGINES = [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
    { key: 'gemini', label: 'Gemini', configured: false },
    { key: 'grok', label: 'Grok', configured: false },
    { key: 'perplexity', label: 'Perplexity', configured: false },
]

const WINDOW = {
    period: '30d',
    interval: 'day',
    start: '2026-10-06',
    end: '2026-11-04',
    buckets: ['2026-11-03', '2026-11-04'],
}

const VISIBILITY = {
    website: { id: 'w1', name: 'Notion' },
    window: WINDOW,
    filters: { engine: null, prompt_id: null },
    engines: ENGINES,
    prompts: [
        { prompt_id: 'p1', text: 'best note taking app for teams', location: 'us' },
        { prompt_id: 'p2', text: 'notion alternatives for small startups', location: '' },
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
            { key: 'claude', visibility_pct: [28.6, 0.0], answers: [7, 2], avg_rank: [null, null] },
        ],
        all: { visibility_pct: [35.0, null], answers: [12, 0] },
    },
    share_of_voice: {
        brands: [
            { key: 'you', name: 'Notion', is_you: true, is_competitor: false, mentions: 40, share_pct: 18.2 },
            { key: 'b1', name: 'Evernote', is_you: false, is_competitor: true, mentions: 60, share_pct: 27.3 },
            { key: 'b2', name: 'Obsidian', is_you: false, is_competitor: true, mentions: 50, share_pct: 22.7 },
            { key: 'b3', name: 'Coda', is_you: false, is_competitor: false, mentions: 45, share_pct: 20.5 },
            { key: 'other', name: 'Other brands', is_you: false, is_competitor: false, mentions: 25, share_pct: 11.4 },
        ],
        series: { you: [20.0, null], b1: [30.0, null], b2: [25.0, null], b3: [15.0, null], other: [10.0, null] },
    },
    sentiment: {
        totals: { positive: 25, neutral: 12, negative: 3 },
        series: { positive: [2, 0], neutral: [1, 0], negative: [0, 0] },
    },
    citations: {
        has_data: true,
        totals: { total: 340, yours: 12, competitors: 40, other: 288 },
        series: { yours: [1, 0], competitors: [2, 0], other: [9, 0] },
        top_domains: [
            { domain: 'g2.com', citations: 18, answers: 15, is_yours: false, is_competitor: false, engines: ['chatgpt', 'perplexity'] },
            { domain: 'notion.so', citations: 12, answers: 9, is_yours: true, is_competitor: false, engines: ['claude'] },
            { domain: 'evernote.com', citations: 7, answers: 6, is_yours: false, is_competitor: true, engines: ['chatgpt'] },
            { domain: 'reddit.com', citations: 6, answers: 6, is_yours: false, is_competitor: false, engines: ['claude'] },
            { domain: 'zapier.com', citations: 4, answers: 3, is_yours: false, is_competitor: false, engines: ['chatgpt'] },
            { domain: 'capterra.com', citations: 3, answers: 3, is_yours: false, is_competitor: false, engines: ['chatgpt'] },
        ],
    },
    by_engine: [
        {
            key: 'chatgpt', label: 'ChatGPT', configured: true, answers: 50, mentioned: 20, visibility_pct: 40.0, avg_rank: 2.6,
            sentiment: { positive: 12, neutral: 6, negative: 2 }, citations: 120, your_citations: 5,
        },
        {
            key: 'claude', label: 'Claude', configured: true, answers: 70, mentioned: 0, visibility_pct: 0.0, avg_rank: null,
            sentiment: { positive: 0, neutral: 0, negative: 0 }, citations: 80, your_citations: 0,
        },
        {
            key: 'gemini', label: 'Gemini', configured: false, answers: 0, mentioned: 0, visibility_pct: null, avg_rank: null,
            sentiment: { positive: 0, neutral: 0, negative: 0 }, citations: 0, your_citations: 0,
        },
    ],
    by_prompt: [],
    google_history: null,
}

export const visibilityPayload = (overrides = {}) => build(VISIBILITY, overrides)

// GET /search-gap/websites/{wid}/overview/: the parts the cards read.
const OVERVIEW = {
    website: { id: 'w1', name: 'Notion', url: 'https://notion.so' },
    serp_configured: true,
    engines: [
        { key: 'chatgpt', label: 'ChatGPT', configured: true },
        { key: 'claude', label: 'Claude', configured: true },
    ],
    kpis: { prompts: 2, ai_visibility_pct: 34, avg_google_position: 4.0, google_checked: 1, ai_ahead: 1, google_ahead: 0 },
    prompts: [
        { prompt_id: 'p1', brand_prompt_id: 'bp1', text: 'best note taking app for teams', location: 'us' },
        { prompt_id: 'p2', brand_prompt_id: 'bp2', text: 'notion alternatives for small startups', location: '' },
    ],
    leaderboard: [
        { name: 'Evernote', is_you: false, visibility_pct: 62, by_engine: { chatgpt: 5 } },
        { name: 'Obsidian', is_you: false, visibility_pct: 50, by_engine: { chatgpt: 4 } },
        { name: 'Coda', is_you: false, visibility_pct: 38, by_engine: { claude: 3 } },
        { name: 'Notion', is_you: true, visibility_pct: 25, by_engine: { chatgpt: 2 } },
        { name: 'Bear', is_you: false, visibility_pct: 13, by_engine: { claude: 1 } },
        { name: 'Roam', is_you: false, visibility_pct: 0, by_engine: {} },
    ],
}

export const overviewPayload = (overrides = {}) => build(OVERVIEW, overrides)

const SENTIMENT = {
    window: WINDOW,
    filters: { engine: null, prompt_id: null },
    engines: ENGINES,
    prompts: [{ prompt_id: 'p1', text: 'best note taking app for teams' }],
    empty_reason: null,
    coverage: { named_answers: 52, analyzed: 40, not_analyzed: 12, failed: 0 },
    tone: { positive: 30, neutral: 15, negative: 0, series: { positive: [2, 1], neutral: [1, 0], negative: [0, 0] } },
    themes: [
        {
            key: 'flexible|positive', label: 'flexible', tone: 'positive', answers: 5, prev_answers: null,
            engines: ['claude'], prompts: 2, last_seen_at: '2026-11-04T09:00:00Z', quotes: [],
        },
        {
            key: 'easy to set up|positive', label: 'easy to set up', tone: 'positive', answers: 9, prev_answers: 4,
            engines: ['chatgpt', 'claude'], prompts: 3, last_seen_at: '2026-11-04T09:00:00Z',
            quotes: [{ quote: 'takes minutes to set up', engine: 'chatgpt', result_id: 'a1', answered_at: '2026-11-04T09:00:00Z' }],
        },
    ],
    by_engine: [{ key: 'chatgpt', named: 20, positive: 12, neutral: 6, negative: 2, themes_positive: 14, themes_negative: 3 }],
    by_prompt: [{ prompt_id: 'p1', text: 'best note taking app for teams', named: 8, positive: 5, neutral: 2, negative: 1 }],
    active_run: null,
    last_run: null,
}

export const sentimentPayload = (overrides = {}) => build(SENTIMENT, overrides)

const FACT_CHECK = {
    window: WINDOW,
    filters: { engine: null, prompt_id: null, verdict: null, topic: null },
    engines: ENGINES,
    prompts: [],
    empty_reason: null,
    coverage: { named_answers: 52, analyzed: 40, not_analyzed: 12, failed: 0 },
    evidence: { facts: 14, facts_pending: 3, pages: [{ url: 'https://notion.so/pricing', state: 'ok', read_at: '2026-11-05T10:00:03Z' }] },
    totals: { claims: 57, supported: 30, contradicted: 4, not_verifiable: 21, unchecked: 2 },
    series: { supported: [3, 0], contradicted: [0, 1], not_verifiable: [2, 0] },
    by_topic: [],
    by_engine: [],
    claims: [
        {
            key: 'a|contradicted', text: 'Notion has no offline mode', topic: 'features', verdict: 'contradicted', answers: 1,
            engines: ['claude'], prompts: [], occurrences: [], evidence: null, note: '', last_seen_at: '2026-11-03T09:00:00Z',
        },
        {
            key: '9f2c41aa0b1d77e3|contradicted', text: "Notion's Plus plan costs $8 per user per month", topic: 'pricing',
            verdict: 'contradicted', answers: 3, engines: ['chatgpt'], prompts: [], occurrences: [],
            evidence: { kind: 'page', url: 'https://notion.so/pricing', quote: 'Plus $10 per seat/month', fact: null },
            note: 'The pricing page lists $10 per seat, not $8.', last_seen_at: '2026-11-04T09:00:00Z',
        },
        {
            key: 'b|supported', text: 'Notion offers a free plan', topic: 'pricing', verdict: 'supported', answers: 9,
            engines: ['chatgpt'], prompts: [], occurrences: [], evidence: null, note: '', last_seen_at: '2026-11-04T09:00:00Z',
        },
    ],
    active_run: null,
    last_run: null,
}

export const factCheckPayload = (overrides = {}) => build(FACT_CHECK, overrides)

/** Fact check before any analysis: every claim number is null, never 0. */
export const notAnalyzedFactCheck = () =>
    factCheckPayload({
        empty_reason: 'not_analyzed',
        coverage: { named_answers: 52, analyzed: 0, not_analyzed: 52, failed: 0 },
        totals: null,
        series: null,
        by_topic: null,
        by_engine: null,
        claims: [],
    })

const AUDIT = {
    brand_key: 'you',
    name: 'Notion',
    domain: 'notion.so',
    audited_at: '2026-11-05T10:05:00Z',
    run_id: 'run-1',
    robots: { state: 'found', url: 'https://notion.so/robots.txt', status_code: 200, groups: 4, sitemaps: 1, bytes: 1200 },
    bots: [
        { key: 'gptbot', home: 'blocked', group: 'GPTBot', rule: 'Disallow: /', pages_blocked: 12 },
        { key: 'oai-searchbot', home: 'allowed', group: '*', rule: '', pages_blocked: 0 },
        { key: 'claude-searchbot', home: 'allowed', group: '*', rule: '', pages_blocked: 0 },
        { key: 'perplexitybot', home: 'blocked', group: 'PerplexityBot', rule: 'Disallow: /', pages_blocked: 12 },
    ],
    llms_txt: { state: 'missing', url: 'https://notion.so/llms.txt', status_code: 404, title: '', sections: 0, links: 0, full: 'missing' },
    pages: [],
    summary: { pages: 12, passed: 80, total: 108, by_check: {} },
}

const CRAWLER_ACCESS = {
    bots: [],
    checks: [],
    you: AUDIT,
    competitors: [],
    active_run: null,
    last_run: null,
}

export const crawlerAccessPayload = (overrides = {}) => build(CRAWLER_ACCESS, overrides)

const PAGES = {
    window: WINDOW,
    filter: 'all',
    sources: {
        google: { state: 'ok', checked_prompts: 8 },
        citations: { state: 'ok', answers_with_sources: 80 },
        ai_visits: { state: 'ok', source: 'pixel', source_label: 'Cansee pixel' },
        crawlers: { state: 'no_cloudflare', window_days: 7 },
        audit: { state: 'ok', audited_at: '2026-11-05T10:05:00Z' },
    },
    totals: { pages: 7, ranking: 2, cited: 4, retrieved_not_cited: 1, ai_visits: 2, crawled: null, audited: 5 },
    pages: [
        { url: 'https://notion.so/', path: '/', signals: 4, citations: { citations: 2, cited_in_text: 1, answers: 2, engines: ['chatgpt'] } },
        { url: 'https://notion.so/pricing', path: '/pricing', signals: 4, citations: { citations: 6, cited_in_text: 4, answers: 4, engines: ['chatgpt'] } },
        { url: 'https://notion.so/blog/x', path: '/blog/x', signals: 2, citations: { citations: 1, cited_in_text: 0, answers: 1, engines: ['claude'] } },
        { url: 'https://notion.so/teams', path: '/teams', signals: 2, citations: { citations: 0, cited_in_text: 0, answers: 0, engines: [] } },
        { url: 'https://notion.so/ai', path: '/ai', signals: 1, citations: { citations: 9, cited_in_text: 9, answers: 5, engines: ['claude'] } },
        { url: 'https://notion.so/docs', path: '/docs', signals: 1, citations: { citations: 3, cited_in_text: 2, answers: 2, engines: ['claude'] } },
        { url: 'https://notion.so/help', path: '/help', signals: 1, citations: { citations: 0, cited_in_text: 0, answers: 0, engines: [] } },
    ],
}

export const pagesPayload = (overrides = {}) => build(PAGES, overrides)

const FAN_OUTS = {
    window: WINDOW,
    filters: { engine: null, prompt_id: null },
    web_search: {
        enabled: true,
        engines: [
            { key: 'chatgpt', reports_queries: true },
            { key: 'claude', reports_queries: true },
            { key: 'gemini', reports_queries: false },
            { key: 'grok', reports_queries: false },
            { key: 'perplexity', reports_queries: false },
        ],
    },
    empty_reason: null,
    totals: { answers: 40, recorded: 30, searched: 22, searches: 61, queries: 58, unique_queries: 45 },
    by_engine: [{ key: 'chatgpt', answers: 20, recorded: 20, searched: 14, searches: 30, queries: 30 }],
    prompts: [
        {
            prompt_id: 'p1',
            text: 'best note taking app for teams',
            location: 'us',
            answers: 6,
            searched: 4,
            queries: [
                {
                    key: 'evernote vs notion', text: 'evernote vs notion', engines: ['chatgpt', 'claude'], answers: 1,
                    last_seen_at: '2026-11-03T09:00:00Z',
                    google: { state: 'not_found', position: null, depth: 10, checked_at: '2026-11-05T10:00:00Z', url: '' },
                },
                {
                    key: 'best note apps 2026', text: 'best note apps 2026', engines: ['chatgpt'], answers: 4,
                    last_seen_at: '2026-11-04T09:00:00Z',
                    google: { state: 'found', position: 4, depth: 10, checked_at: '2026-11-05T10:00:00Z', url: 'https://notion.so/blog/x' },
                },
            ],
        },
        {
            prompt_id: 'p2',
            text: 'notion alternatives for small startups',
            location: '',
            answers: 3,
            searched: 2,
            queries: [
                {
                    key: 'notion pricing for teams', text: 'notion pricing for teams', engines: ['claude'], answers: 2,
                    last_seen_at: '2026-11-02T09:00:00Z',
                    google: { state: 'not_checked', position: null, depth: null, checked_at: null, url: '' },
                },
                {
                    key: 'free notion alternatives', text: 'free notion alternatives', engines: ['claude'], answers: 1,
                    last_seen_at: '2026-11-01T09:00:00Z',
                    google: { state: 'failed', position: null, depth: null, checked_at: '2026-11-05T10:00:00Z', url: '' },
                },
            ],
        },
    ],
    active_run: null,
    last_run: null,
}

export const fanOutsPayload = (overrides = {}) => build(FAN_OUTS, overrides)

const PROMPT_IDEAS = {
    sources: {
        paa: { state: 'ok', checks: 8 },
        related_search: { state: 'none_seen', checks: 8 },
        fanout: { state: 'web_search_off', answers: 0 },
        ai_suggestion: { state: 'not_run', generated_at: null },
        sub_query: { state: 'ok', prompts: 5 },
    },
    counts: { new: 20, tracked: 3, dismissed: 2, by_source: { paa: 0, related_search: 9, fanout: 6, ai_suggestion: 8, sub_query: 4 } },
    track: { engines: [{ key: 'chatgpt', label: 'ChatGPT' }], usd_max_per_prompt: '0.0400', allowance: { unlimited: false, cap_usd: '5.00', left_usd: '4.08' } },
    ideas: [
        { id: 'e1', text: 'is notion free for teams', sources: ['paa', 'fanout'], status: 'new', tracked_prompt_id: null, seen: { prompts: 2, engines: 1, times: 3 }, evidence: [] },
        { id: 'e2', text: 'notion vs evernote for students', sources: ['related_search'], status: 'new', tracked_prompt_id: null, seen: { prompts: 1, engines: 0, times: 1 }, evidence: [] },
        { id: 'e3', text: 'how to share a notion page', sources: ['sub_query'], status: 'new', tracked_prompt_id: null, seen: { prompts: 1, engines: 0, times: 1 }, evidence: [] },
        { id: 'e4', text: 'notion templates for agencies', sources: ['ai_suggestion'], status: 'new', tracked_prompt_id: null, seen: { prompts: 0, engines: 0, times: 1 }, evidence: [] },
    ],
    active_run: null,
    last_run: null,
}

export const promptIdeasPayload = (overrides = {}) => build(PROMPT_IDEAS, overrides)

const COMPETITORS = {
    window: WINDOW,
    filters: { engine: null },
    brands: [
        { key: 'you', name: 'Notion', domain: 'notion.so', is_you: true },
        { key: 'b1', name: 'Evernote', domain: 'evernote.com', is_you: false },
        { key: 'b2', name: 'Obsidian', domain: 'obsidian.md', is_you: false },
    ],
    empty_reason: null,
    ai: {
        answers: 120,
        brands: {
            you: { named: 40, visibility_pct: 33.3, avg_rank: 2.4, first_place: 12, series: [40.0, null] },
            b1: { named: 50, visibility_pct: 41.7, avg_rank: 1.8, first_place: 20, series: [45.0, null] },
            b2: { named: 0, visibility_pct: 0.0, avg_rank: null, first_place: 0, series: [0.0, null] },
        },
    },
    head_to_head: [],
    citations: { has_data: true, brands: { you: { citations: 12, pages: 5, answers: 9 } } },
    google: { configured: true, prompts_checked: 8, oldest_check_at: '2026-10-20T08:00:00Z', brands: null },
    by_prompt: [],
    site: { you: null, b1: null, b2: null },
}

export const competitorsPayload = (overrides = {}) => build(COMPETITORS, overrides)

const PRODUCTS = {
    limits: { max_products: 10, max_queries: 3, max_terms: 5 },
    shopping: { configured: true, provider_label: 'ScraperAPI', credits_per_page: 25 },
    engines: ENGINES,
    products: [
        {
            id: 'pr1', name: 'Acme X200 running shoe', match_terms: ['x200'], url: 'https://acme.com/x200',
            queries: ['best running shoes for flat feet'], own_sellers: ['Acme'], created_at: '2026-11-05T10:00:00Z',
            latest: {
                checked_at: '2026-11-05T10:10:00Z',
                google: { state: 'found', queries_checked: 1, queries_found: 1, best_position: 3, results: 40, sold_by_you: true, sellers: 4 },
                engines: { answers: 2, named: 1, by_engine: { chatgpt: { answers: 1, named: 1, rank: 2 } } },
            },
        },
        {
            id: 'pr2', name: 'Acme trail sock', match_terms: ['trail', 'sock'], url: '', queries: ['warm socks for trail running'],
            own_sellers: ['Acme'], created_at: '2026-11-05T10:01:00Z',
            latest: {
                checked_at: '2026-11-05T10:12:00Z',
                google: { state: 'not_found', queries_checked: 1, queries_found: 0, best_position: null, results: 40, sold_by_you: false, sellers: 0 },
                engines: { answers: 2, named: 0, by_engine: {} },
            },
        },
        {
            id: 'pr3', name: 'Acme rain jacket', match_terms: ['rain jacket'], url: '', queries: ['best rain jacket for hiking'],
            own_sellers: ['Acme'], created_at: '2026-11-05T10:02:00Z', latest: null,
        },
    ],
    active_run: null,
    last_run: null,
}

export const productsPayload = (overrides = {}) => build(PRODUCTS, overrides)

/** An axios-style failure carrying the API's error envelope, as useBoardSource reports it. */
export function failure(status, code = 'error', message = '') {
    return { status, code, message }
}
