// Test fixtures only (never imported by app code). The two payloads the
// group D cards read, shaped like the API's: the search-gap overview
// (GET /search-gap/websites/<id>/overview/: prompts oldest first, each
// with its engines' latest answers, and the leaderboard) and the
// visibility dashboard (GET /llm-ranking/<id>/visibility-dashboard/
// ?period=30d: the headline and the daily series). Numbers show shapes,
// not measurements. Each builder returns a fresh copy; overrides replace
// top-level keys.

const clone = (value) => JSON.parse(JSON.stringify(value))
const build = (base, overrides = {}) => ({ ...clone(base), ...clone(overrides) })

export const ENGINES = [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
    { key: 'gemini', label: 'Gemini', configured: true },
    { key: 'grok', label: 'Grok', configured: false },
    { key: 'perplexity', label: 'Perplexity', configured: false },
]

/** One engine's cell of a prompt row. */
export function cell(fields = {}) {
    return { configured: true, answers: 3, mentioned: false, rank: null, visibility_pct: 0, score: 0, class: 'even', ...fields }
}

const OFF = cell({ configured: false, answers: 0, visibility_pct: null, score: null, class: 'no_data' })

/** ChatGPT named you second, Claude did not, Gemini named you fourth. */
export const ANSWERED = {
    chatgpt: cell({ mentioned: true, rank: 2, visibility_pct: 67 }),
    claude: cell(),
    gemini: cell({ mentioned: true, rank: 4, visibility_pct: 33 }),
    grok: OFF,
    perplexity: OFF,
}

/** Every engine that is set up is still to answer. */
export const WAITING = {
    chatgpt: cell({ answers: 0, visibility_pct: null }),
    claude: cell({ answers: 0, visibility_pct: null }),
    gemini: cell({ answers: 0, visibility_pct: null }),
    grok: OFF,
    perplexity: OFF,
}

/** One row of the overview's `prompts`. */
export function promptRow(id, text, engines = ANSWERED, fields = {}) {
    return { prompt_id: id, brand_prompt_id: `bp-${id}`, text, location: 'us', engines: clone(engines), ...fields }
}

const OVERVIEW = {
    website: { id: 'w1', name: 'Notion', url: 'https://notion.so' },
    serp_configured: true,
    engines: ENGINES,
    kpis: { prompts: 3, ai_visibility_pct: 34 },
    prompts: [
        promptRow('p1', 'best note taking app for teams'),
        promptRow('p2', 'notion alternatives for small startups', ANSWERED, { location: '' }),
        promptRow('p3', 'Which tools should a small team shortlist?'),
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

const VISIBILITY = {
    website: { id: 'w1', name: 'Notion' },
    window: { period: '30d', interval: 'day', start: '2026-11-01', end: '2026-11-05', buckets: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'] },
    engines: ENGINES,
    has_data: true,
    empty_reason: null,
    headline: { answers: 120, answers_prev: 98, visibility_pct: 34.2, visibility_prev_pct: 30.1 },
    visibility: { by_engine: [], all: { visibility_pct: [10, 20, 40, 30, 20], answers: [12, 12, 12, 12, 12] } },
}

export const visibilityPayload = (overrides = {}) => build(VISIBILITY, overrides)

export const failure = (fields = {}) => ({ status: 500, code: 'server_error', message: 'Server error', ...fields })
