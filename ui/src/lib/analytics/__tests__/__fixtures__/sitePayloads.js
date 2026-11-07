// Contract fixtures (p2_contract.md 5d and 6) for Crawler access and Pages.

export const BOTS = [
    { key: 'gptbot', token: 'GPTBot', operator: 'OpenAI', purpose: 'training', purpose_label: 'Model training', robots: 'yes' },
    { key: 'oai-searchbot', token: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'search', purpose_label: 'AI search', robots: 'yes' },
    { key: 'chatgpt-user', token: 'ChatGPT-User', operator: 'OpenAI', purpose: 'user', purpose_label: 'User request', robots: 'may_not' },
    { key: 'claudebot', token: 'ClaudeBot', operator: 'Anthropic', purpose: 'training', purpose_label: 'Model training', robots: 'yes' },
    { key: 'claude-searchbot', token: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'search', purpose_label: 'AI search', robots: 'yes' },
    { key: 'perplexitybot', token: 'PerplexityBot', operator: 'Perplexity', purpose: 'search', purpose_label: 'AI search', robots: 'yes' },
    { key: 'google-extended', token: 'Google-Extended', operator: 'Google', purpose: 'training', purpose_label: 'Model training', robots: 'token_only' },
]

export const CHECKS = [
    { key: 'status_ok', label: 'Loads', rule: 'The final response status is 200-299.' },
    { key: 'indexable', label: 'Indexable', rule: 'No noindex.' },
    { key: 'title', label: 'Has a title', rule: 'The title is not empty.' },
    { key: 'meta_description', label: 'Has a meta description', rule: 'The meta description is not empty.' },
    { key: 'h1', label: 'Has an H1', rule: 'At least one H1.' },
    { key: 'text_without_js', label: 'Text without JavaScript', rule: 'At least 150 words before any script runs.' },
    { key: 'structured_data', label: 'Structured data', rule: 'At least one JSON-LD type.' },
    { key: 'canonical', label: 'Canonical link', rule: 'A rel=canonical link is present.' },
    { key: 'ai_search_allowed', label: 'Open to AI search bots', rule: 'robots.txt lets the three AI search bots fetch the URL.' },
]

const allPass = {
    status_ok: true,
    indexable: true,
    title: true,
    meta_description: true,
    h1: true,
    text_without_js: true,
    structured_data: true,
    canonical: true,
    ai_search_allowed: true,
}

export function youAudit(overrides = {}) {
    return {
        brand_key: 'you',
        name: 'Notion',
        domain: 'notion.so',
        audited_at: '2026-11-05T10:05:00Z',
        run_id: '2c1e0000-0000-4000-8000-000000000009',
        robots: { state: 'found', url: 'https://notion.so/robots.txt', status_code: 200, groups: 4, sitemaps: 1, bytes: 1200 },
        bots: [
            { key: 'gptbot', home: 'blocked', group: 'GPTBot', rule: 'Disallow: /', pages_blocked: 2 },
            { key: 'oai-searchbot', home: 'allowed', group: '*', rule: null, pages_blocked: 0 },
            { key: 'chatgpt-user', home: 'allowed', group: null, rule: null, pages_blocked: 0 },
            { key: 'claudebot', home: 'allowed', group: null, rule: null, pages_blocked: 0 },
            { key: 'claude-searchbot', home: 'allowed', group: null, rule: null, pages_blocked: 0 },
            { key: 'perplexitybot', home: 'blocked', group: 'PerplexityBot', rule: 'Disallow: /', pages_blocked: 2 },
            { key: 'google-extended', home: 'blocked', group: 'Google-Extended', rule: 'Disallow: /', pages_blocked: 2 },
        ],
        llms_txt: { state: 'found', url: 'https://notion.so/llms.txt', status_code: 200, title: 'Notion', sections: 3, links: 18, full: 'missing' },
        pages: [
            {
                url: 'https://notion.so/',
                final_url: 'https://www.notion.so/',
                status_code: 200,
                checks: { ...allPass, ai_search_allowed: false },
                passed: 8,
                total: 9,
                words: 640,
                jsonld_types: ['Organization'],
                canonical: 'https://www.notion.so/',
                noindex_source: null,
                blocked_bots: ['gptbot', 'perplexitybot', 'google-extended'],
                error: null,
            },
            {
                url: 'https://notion.so/pricing',
                final_url: 'https://www.notion.so/pricing',
                status_code: 200,
                checks: { ...allPass, meta_description: false, text_without_js: false, ai_search_allowed: false },
                passed: 6,
                total: 9,
                words: 120,
                jsonld_types: [],
                canonical: 'https://www.notion.so/pricing',
                noindex_source: null,
                blocked_bots: ['gptbot', 'perplexitybot'],
                error: null,
            },
            {
                url: 'https://notion.so/old',
                final_url: 'https://notion.so/old',
                status_code: null,
                checks: { status_ok: false, indexable: null, title: null, meta_description: null, h1: null, text_without_js: null, structured_data: null, canonical: null, ai_search_allowed: null },
                passed: 0,
                total: 1,
                words: null,
                jsonld_types: [],
                canonical: '',
                noindex_source: null,
                blocked_bots: [],
                error: { code: 'timeout', message: 'The page took too long to load.' },
            },
        ],
        summary: {
            pages: 3,
            passed: 14,
            total: 19,
            by_check: {
                status_ok: { passed: 2, failed: 1, not_checked: 0 },
                indexable: { passed: 2, failed: 0, not_checked: 1 },
                title: { passed: 2, failed: 0, not_checked: 1 },
                meta_description: { passed: 1, failed: 1, not_checked: 1 },
                h1: { passed: 2, failed: 0, not_checked: 1 },
                text_without_js: { passed: 1, failed: 1, not_checked: 1 },
                structured_data: { passed: 2, failed: 0, not_checked: 1 },
                canonical: { passed: 2, failed: 0, not_checked: 1 },
                ai_search_allowed: { passed: 0, failed: 2, not_checked: 1 },
            },
        },
        ...overrides,
    }
}

export function competitorAudit(overrides = {}) {
    return {
        brand_key: 'b1',
        name: 'Evernote',
        domain: 'evernote.com',
        audited_at: '2026-11-05T10:06:00Z',
        run_id: '2c1e0000-0000-4000-8000-000000000009',
        robots: { state: 'missing', url: 'https://evernote.com/robots.txt', status_code: 404, groups: 0, sitemaps: 0, bytes: 0 },
        bots: BOTS.map((b) => ({ key: b.key, home: 'allowed', group: null, rule: null, pages_blocked: 0 })),
        llms_txt: { state: 'missing', url: 'https://evernote.com/llms.txt', status_code: 404, title: '', sections: 0, links: 0, full: 'missing' },
        pages: [
            {
                url: 'https://evernote.com/',
                final_url: 'https://evernote.com/',
                status_code: 200,
                checks: allPass,
                passed: 9,
                total: 9,
                words: 800,
                jsonld_types: ['Organization'],
                canonical: 'https://evernote.com/',
                noindex_source: null,
                blocked_bots: [],
                error: null,
            },
        ],
        summary: { pages: 1, passed: 9, total: 9, by_check: {} },
        ...overrides,
    }
}

export function crawlerAccess(overrides = {}) {
    return {
        bots: BOTS,
        checks: CHECKS,
        you: youAudit(),
        competitors: [competitorAudit()],
        active_run: null,
        last_run: null,
        ...overrides,
    }
}

export const TRACKED = [
    { key: 'b1', name: 'Evernote', domain: 'evernote.com' },
    { key: 'b2', name: 'Obsidian', domain: 'obsidian.md' },
]

export function pagesPayload(overrides = {}) {
    return {
        window: { period: '30d', start: '2026-10-07', end: '2026-11-05' },
        filter: 'all',
        sources: {
            google: { state: 'ok', checked_prompts: 8 },
            citations: { state: 'ok', answers_with_sources: 80 },
            ai_visits: { state: 'ok', source: 'pixel', source_label: 'Cansee pixel' },
            crawlers: { state: 'no_cloudflare', window_days: 7 },
            audit: { state: 'ok', audited_at: '2026-11-05T10:05:00Z' },
        },
        totals: { pages: 2, ranking: 1, cited: 1, retrieved_not_cited: 1, ai_visits: 1, crawled: null, audited: 2 },
        pages: [
            {
                url: 'https://notion.so/pricing',
                path: '/pricing',
                signals: 4,
                google: { best_position: 3, prompts: [{ prompt_id: 'p1', text: 'notion pricing', position: 3 }] },
                citations: { citations: 6, cited_in_text: 0, answers: 4, engines: ['chatgpt'] },
                ai_visits: { sessions: 12, by_assistant: { chatgpt: 9, perplexity: 3 } },
                crawler_requests: null,
                audit: { passed: 7, total: 9, failed: ['meta_description', 'text_without_js'], audited_at: '2026-11-05T10:05:00Z' },
            },
            {
                url: 'https://notion.so/about',
                path: '/about',
                signals: 1,
                google: { best_position: null, prompts: [] },
                citations: { citations: 0, cited_in_text: 0, answers: 0, engines: [] },
                ai_visits: { sessions: 0, by_assistant: {} },
                crawler_requests: null,
                audit: { passed: null, total: null, state: 'not_audited' },
            },
        ],
        ...overrides,
    }
}
