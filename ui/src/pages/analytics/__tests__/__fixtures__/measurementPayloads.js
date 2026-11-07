// Test fixtures only (never imported by app code). Insights payloads copied
// from design/p2_contract.md (sections 1e, 3c, 3d, 4a, 4b, 7, 8 and 9) and
// trimmed to a small project: two days, three prompts, two engines with
// keys, two competitors. Each builder returns a fresh copy; overrides
// replace top-level keys.

const clone = (value) => JSON.parse(JSON.stringify(value))

const ENGINES = [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
    { key: 'gemini', label: 'Gemini', configured: false },
    { key: 'grok', label: 'Grok', configured: false },
    { key: 'perplexity', label: 'Perplexity', configured: false },
]

const PROMPTS = [
    { prompt_id: 'p1', text: 'best note taking app for teams' },
    { prompt_id: 'p2', text: 'notion alternatives for small startups' },
]

const WINDOW = {
    period: '30d',
    interval: 'day',
    start: '2026-10-07',
    end: '2026-11-05',
    buckets: ['2026-11-04', '2026-11-05'],
}

const SENTIMENT = {
    window: WINDOW,
    filters: { engine: null, prompt_id: null },
    engines: ENGINES,
    prompts: PROMPTS,
    empty_reason: null,
    coverage: { named_answers: 52, analyzed: 40, not_analyzed: 12, failed: 0 },
    tone: {
        positive: 30,
        neutral: 15,
        negative: 4,
        series: { positive: [2, 1], neutral: [1, 0], negative: [0, 1] },
    },
    themes: [
        {
            key: 'easy to set up|positive',
            label: 'easy to set up',
            tone: 'positive',
            answers: 9,
            prev_answers: 4,
            engines: ['chatgpt', 'claude'],
            prompts: 3,
            last_seen_at: '2026-11-04T09:00:00Z',
            quotes: [
                { quote: 'takes minutes to set up', engine: 'chatgpt', result_id: 'a1', answered_at: '2026-11-04T09:00:00Z' },
            ],
        },
        {
            key: 'expensive for large teams|negative',
            label: 'expensive for large teams',
            tone: 'negative',
            answers: 3,
            prev_answers: null,
            engines: ['claude'],
            prompts: 1,
            last_seen_at: '2026-11-03T09:00:00Z',
            quotes: [
                { quote: 'gets expensive as teams grow', engine: 'claude', result_id: 'a2', answered_at: '2026-11-03T09:00:00Z' },
            ],
        },
        {
            key: 'flexible|positive',
            label: 'flexible',
            tone: 'positive',
            answers: 5,
            prev_answers: 0,
            engines: ['claude'],
            prompts: 2,
            last_seen_at: '2026-11-02T09:00:00Z',
            quotes: [],
        },
    ],
    by_engine: [
        { key: 'chatgpt', named: 20, positive: 12, neutral: 6, negative: 2, themes_positive: 14, themes_negative: 3 },
        { key: 'claude', named: 32, positive: 18, neutral: 9, negative: 2, themes_positive: null, themes_negative: null },
    ],
    by_prompt: [
        { prompt_id: 'p1', text: 'best note taking app for teams', named: 8, positive: 5, neutral: 2, negative: 1 },
        { prompt_id: 'p2', text: 'notion alternatives for small startups', named: 3, positive: 0, neutral: 3, negative: 0 },
    ],
    active_run: null,
    last_run: null,
}

const FACT_CHECK = {
    window: WINDOW,
    filters: { engine: null, prompt_id: null, verdict: null, topic: null },
    engines: ENGINES,
    prompts: PROMPTS,
    empty_reason: null,
    coverage: { named_answers: 52, analyzed: 40, not_analyzed: 12, failed: 0 },
    evidence: {
        facts: 14,
        facts_pending: 3,
        pages: [
            { url: 'https://notion.so/', state: 'ok', read_at: '2026-11-05T10:00:02Z' },
            { url: 'https://notion.so/pricing', state: 'ok', read_at: '2026-11-05T10:00:03Z' },
        ],
    },
    totals: { claims: 57, supported: 30, contradicted: 4, not_verifiable: 21, unchecked: 2 },
    series: { supported: [3, 1], contradicted: [0, 1], not_verifiable: [2, 0] },
    by_topic: [
        { topic: 'pricing', label: 'Pricing', claims: 12, supported: 5, contradicted: 3, not_verifiable: 4, unchecked: 0 },
        { topic: 'company', label: 'Company', claims: 6, supported: 2, contradicted: 0, not_verifiable: 4, unchecked: 0 },
    ],
    by_engine: [
        { key: 'chatgpt', claims: 20, supported: 12, contradicted: 2, not_verifiable: 6, unchecked: 0 },
        { key: 'claude', claims: 37, supported: 18, contradicted: 2, not_verifiable: 15, unchecked: 2 },
    ],
    claims: [
        {
            key: '9f2c41aa0b1d77e3|contradicted',
            text: "Notion's Plus plan costs $8 per user per month",
            topic: 'pricing',
            verdict: 'contradicted',
            answers: 3,
            engines: ['chatgpt'],
            prompts: [{ prompt_id: 'p1', text: 'best note taking app for teams' }],
            occurrences: [
                { result_id: 'a1', engine: 'chatgpt', answered_at: '2026-11-04T09:00:00Z', quote: 'Plus at $8 per user' },
            ],
            evidence: { kind: 'page', url: 'https://notion.so/pricing', quote: 'Plus $10 per seat/month', fact: null },
            note: 'The pricing page lists $10 per seat, not $8.',
            last_seen_at: '2026-11-04T09:00:00Z',
        },
        {
            key: '1b77aa90c3d2e411|not_verifiable',
            text: 'Notion was founded in 2016',
            topic: 'company',
            verdict: 'not_verifiable',
            answers: 2,
            engines: ['claude'],
            prompts: [{ prompt_id: 'p2', text: 'notion alternatives for small startups' }],
            occurrences: [
                { result_id: 'a3', engine: 'claude', answered_at: '2026-11-03T09:00:00Z', quote: 'founded in 2016' },
            ],
            evidence: null,
            note: 'Neither the brand facts nor the pages state a founding year.',
            last_seen_at: '2026-11-03T09:00:00Z',
        },
        {
            key: '0c9e2a17ffb35d08|supported',
            text: 'Notion integrates with Slack',
            topic: 'integrations',
            verdict: 'supported',
            answers: 5,
            engines: ['chatgpt', 'claude'],
            prompts: [{ prompt_id: 'p1', text: 'best note taking app for teams' }],
            occurrences: [
                { result_id: 'a4', engine: 'claude', answered_at: '2026-11-02T09:00:00Z', quote: 'integrates with Slack' },
            ],
            evidence: {
                kind: 'fact',
                url: null,
                quote: 'Slack',
                fact: {
                    id: 'f1',
                    subject: 'Notion',
                    predicate: 'integrates with',
                    object: 'Slack',
                    source_url: 'https://notion.so/integrations',
                },
            },
            note: 'The brand fact lists Slack among the integrations.',
            last_seen_at: '2026-11-02T09:00:00Z',
        },
    ],
    active_run: null,
    last_run: null,
}

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
            b2: { named: 6, visibility_pct: 5.0, avg_rank: null, first_place: 0, series: [5.0, null] },
        },
    },
    head_to_head: [
        { key: 'b1', both_named: 25, you_ahead: 10, they_ahead: 13, no_order: 2 },
        { key: 'b2', both_named: 4, you_ahead: 3, they_ahead: 0, no_order: 1 },
    ],
    citations: {
        has_data: true,
        brands: {
            you: { citations: 12, pages: 5, answers: 9 },
            b1: { citations: 20, pages: 7, answers: 15 },
            b2: { citations: 0, pages: 0, answers: 0 },
        },
    },
    google: {
        configured: true,
        prompts_checked: 2,
        oldest_check_at: '2026-10-20T08:00:00Z',
        brands: {
            you: { on_page_one: 1, best_position: 2 },
            b1: { on_page_one: 2, best_position: 1 },
            b2: { on_page_one: 0, best_position: null },
        },
    },
    by_prompt: [
        {
            prompt_id: 'p1',
            text: 'best note taking app for teams',
            answers: 12,
            ai: { you: 25.0, b1: 50.0, b2: 0.0 },
            google_state: 'ok',
            google_checked_at: '2026-10-28T08:00:00Z',
            google: { you: { position: 14, depth: 20 }, b1: { position: null, depth: 10 }, b2: { position: 3, depth: 10 } },
        },
        {
            prompt_id: 'p2',
            text: 'notion alternatives for small startups',
            answers: 0,
            ai: { you: null, b1: null, b2: null },
            google_state: 'not_checked',
            google_checked_at: null,
            google: null,
        },
        {
            prompt_id: 'p3',
            text: 'note app with offline mode',
            answers: 6,
            ai: { you: 16.7, b1: 16.7, b2: 66.7 },
            google_state: 'failed',
            google_checked_at: '2026-10-29T08:00:00Z',
            google: null,
        },
    ],
    site: {
        you: { audited_at: '2026-11-05T10:05:00Z', checks_passed: 7, checks_total: 9, ai_search_allowed: true },
        b1: null,
        b2: { audited_at: '2026-11-05T10:05:00Z', checks_passed: 6, checks_total: 9, ai_search_allowed: false },
    },
}

const CITATIONS = {
    window: WINDOW,
    filters: { engine: null },
    has_data: true,
    totals: { answers: 120, answers_with_sources: 80, citations: 340, cited_in_text: 210, retrieved_only: 130, your_pages: 31 },
    by_class: [
        { key: 'reddit', label: 'Reddit', citations: 40, answers: 30 },
        { key: 'your_site', label: 'Your Site', citations: 31, answers: 20 },
        { key: 'competitor_site', label: 'Competitor', citations: 25, answers: 18 },
    ],
    by_engine: [
        { key: 'chatgpt', label: 'ChatGPT', answers: 50, answers_with_sources: 40, citations: 160, your_citations: 5 },
        { key: 'claude', label: 'Claude', answers: 70, answers_with_sources: 40, citations: 180, your_citations: 0 },
    ],
    your_pages: [
        {
            url: 'https://notion.so/pricing',
            citations: 6,
            cited_in_text: 4,
            answers: 4,
            engines: ['chatgpt'],
            prompts: 2,
            last_cited_at: '2026-11-04T09:00:00Z',
        },
    ],
    competitor_pages: [
        {
            url: 'https://evernote.com/compare',
            brand_key: 'b1',
            brand_name: 'Evernote',
            citations: 9,
            answers: 7,
            engines: ['claude'],
        },
    ],
    gaps: [
        {
            prompt_id: 'p1',
            text: 'best note taking app for teams',
            competitor_citations: 6,
            your_citations: 0,
            top_domains: [
                { domain: 'g2.com', citations: 4 },
                { domain: 'reddit.com', citations: 2 },
            ],
        },
    ],
}

const PROMPT_IDEAS = {
    sources: {
        paa: { state: 'ok', checks: 8 },
        related_search: { state: 'none_seen', checks: 8 },
        fanout: { state: 'web_search_off', answers: 0 },
        ai_suggestion: { state: 'not_run', generated_at: null },
        sub_query: { state: 'ok', prompts: 5 },
    },
    counts: {
        new: 20,
        tracked: 3,
        dismissed: 2,
        by_source: { paa: 9, related_search: 0, fanout: 0, ai_suggestion: 0, sub_query: 4 },
    },
    track: {
        engines: [
            { key: 'chatgpt', label: 'ChatGPT' },
            { key: 'claude', label: 'Claude' },
        ],
        usd_max_per_prompt: '0.0400',
        allowance: { unlimited: false, cap_usd: '5.00', left_usd: '4.08' },
    },
    ideas: [
        {
            id: 'e5',
            text: 'is notion free for teams',
            sources: ['paa', 'sub_query'],
            status: 'new',
            tracked_prompt_id: null,
            seen: { prompts: 2, engines: 0, times: 3 },
            first_seen_at: '2026-10-20T08:00:00Z',
            last_seen_at: '2026-11-04T09:00:00Z',
            evidence: [
                {
                    source: 'paa',
                    prompt_id: 'p1',
                    prompt_text: 'best note taking app for teams',
                    seen_at: '2026-11-04T09:00:00Z',
                    url: 'https://www.google.com/search?q=best+note+taking+app+for+teams',
                },
                { source: 'sub_query', prompt_id: 'p2', prompt_text: 'notion alternatives for small startups', seen_at: '2026-11-03T09:00:00Z' },
            ],
        },
        {
            id: 'e6',
            text: 'notion vs evernote for students',
            sources: ['sub_query'],
            status: 'new',
            tracked_prompt_id: null,
            seen: { prompts: 1, engines: 0, times: 1 },
            first_seen_at: '2026-10-21T08:00:00Z',
            last_seen_at: '2026-11-01T09:00:00Z',
            evidence: [
                { source: 'sub_query', prompt_id: 'p1', prompt_text: 'best note taking app for teams', seen_at: '2026-11-01T09:00:00Z' },
            ],
        },
    ],
    active_run: null,
    last_run: null,
}

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
    by_engine: [
        { key: 'chatgpt', answers: 20, recorded: 20, searched: 14, searches: 30, queries: 30 },
        { key: 'claude', answers: 20, recorded: 10, searched: 8, searches: 31, queries: 28 },
    ],
    prompts: [
        {
            prompt_id: 'p1',
            text: 'best note taking app for teams',
            location: 'us',
            answers: 6,
            searched: 4,
            queries: [
                {
                    key: 'best note apps 2026',
                    text: 'best note apps 2026',
                    engines: ['chatgpt'],
                    answers: 2,
                    last_seen_at: '2026-11-04T09:00:00Z',
                    google: { state: 'found', position: 4, depth: 10, checked_at: '2026-11-05T10:00:00Z', url: 'https://notion.so/blog/x' },
                },
                {
                    key: 'evernote vs notion',
                    text: 'evernote vs notion',
                    engines: ['chatgpt', 'claude'],
                    answers: 1,
                    last_seen_at: '2026-11-03T09:00:00Z',
                    google: { state: 'not_found', position: null, depth: 10, checked_at: '2026-11-05T10:00:00Z', url: '' },
                },
                {
                    key: 'notion pricing for teams',
                    text: 'notion pricing for teams',
                    engines: ['claude'],
                    answers: 1,
                    last_seen_at: '2026-11-02T09:00:00Z',
                    google: { state: 'not_checked', position: null, depth: null, checked_at: null, url: '' },
                },
            ],
        },
        {
            prompt_id: 'p2',
            text: 'notion alternatives for small startups',
            location: '',
            answers: 3,
            searched: 0,
            queries: [],
        },
    ],
    active_run: null,
    last_run: null,
}

const PRODUCTS = {
    limits: { max_products: 10, max_queries: 3, max_terms: 5 },
    shopping: { configured: true, provider_label: 'ScraperAPI', credits_per_page: 25 },
    engines: ENGINES,
    products: [
        {
            id: 'pr1',
            name: 'Acme X200 running shoe',
            match_terms: ['x200'],
            url: 'https://acme.com/x200',
            queries: ['best running shoes for flat feet'],
            own_sellers: ['Acme'],
            created_at: '2026-11-05T10:00:00Z',
            latest: {
                checked_at: '2026-11-05T10:10:00Z',
                google: { state: 'found', queries_checked: 1, queries_found: 1, best_position: 3, sold_by_you: true, sellers: 4 },
                engines: {
                    answers: 2,
                    named: 1,
                    by_engine: { chatgpt: { answers: 1, named: 1, rank: 2 }, claude: { answers: 1, named: 0, rank: null } },
                },
            },
        },
        {
            id: 'pr2',
            name: 'Acme trail sock',
            match_terms: ['trail', 'sock'],
            url: '',
            queries: ['warm socks for trail running'],
            own_sellers: ['Acme'],
            created_at: '2026-11-05T10:01:00Z',
            latest: null,
        },
    ],
    active_run: null,
    last_run: null,
}

const PRODUCT_DETAIL = {
    ...PRODUCTS.products[0],
    queries: [
        {
            query: 'best running shoes for flat feet',
            google: {
                state: 'found',
                position: 3,
                results: 40,
                checked_at: '2026-11-05T10:10:00Z',
                error: null,
                matches: [{ position: 3, title: 'Acme X200', seller: 'Acme', price: '$89.99', sold_by_you: true }],
                lowest: { title: 'Generic runner', seller: 'Walmart', price: '$39.00' },
                top: [
                    { position: 1, title: 'Brooks Adrenaline', seller: 'Zappos', price: '$139.95', is_match: false },
                    { position: 3, title: 'Acme X200', seller: 'Acme', price: '$89.99', is_match: true },
                ],
            },
            engines: [
                {
                    key: 'chatgpt',
                    label: 'ChatGPT',
                    state: 'named',
                    rank: 2,
                    excerpt: '2. Acme X200: a stable shoe for flat feet',
                    answer_text: '1. Brooks Adrenaline\n2. Acme X200: a stable shoe for flat feet',
                    checked_at: '2026-11-05T10:10:00Z',
                    error: null,
                },
                {
                    key: 'claude',
                    label: 'Claude',
                    state: 'failed',
                    rank: null,
                    excerpt: '',
                    answer_text: '',
                    checked_at: '2026-11-05T10:10:00Z',
                    error: { code: 'engine_error', message: 'The engine returned an error.' },
                },
            ],
        },
    ],
    history: [{ checked_at: '2026-11-05T10:10:00Z', google_best_position: 3, engines_named: 1, engines_answers: 2 }],
}

const RUN = {
    id: 'run-1',
    kind: 'answer_analysis',
    kind_label: 'Answer analysis',
    status: 'running',
    summary: '40 answers that name you, last 30 days',
    created_at: '2026-11-05T10:00:00Z',
    started_at: '2026-11-05T10:00:01Z',
    finished_at: null,
    duration_ms: null,
    created_by_name: 'Site Owner',
    progress: { total: 40, queued: 30, running: 2, done: 7, failed: 1, skipped: 0, cancelled: 0 },
    cost: { ai_usd: '0.0123', google_pages: 0, scraperapi_credits: null },
    confirmed: { ai_calls: 80, ai_usd_max: '0.2400', google_pages: 0 },
    cancel_requested: false,
    error: null,
}

function build(base, overrides) {
    return { ...clone(base), ...clone(overrides) }
}

export const sentimentPayload = (overrides = {}) => build(SENTIMENT, overrides)
export const factCheckPayload = (overrides = {}) => build(FACT_CHECK, overrides)
export const competitorsPayload = (overrides = {}) => build(COMPETITORS, overrides)
export const citationsPayload = (overrides = {}) => build(CITATIONS, overrides)
export const promptIdeasPayload = (overrides = {}) => build(PROMPT_IDEAS, overrides)
export const fanOutsPayload = (overrides = {}) => build(FAN_OUTS, overrides)
export const productsPayload = (overrides = {}) => build(PRODUCTS, overrides)
export const productDetail = (overrides = {}) => build(PRODUCT_DETAIL, overrides)
export const insightRun = (overrides = {}) => build(RUN, overrides)

/** An axios-style success: the client unwraps the envelope to `data`. */
export const ok = (data) => ({ data })

/** An axios-style failure carrying the API's error envelope. */
export function apiError(status, code = 'error', message = '', details = undefined) {
    const err = new Error(message || code)
    err.response = { status, data: { success: false, error: { code, message, ...(details ? { details } : {}) } } }
    return err
}
