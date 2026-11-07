// Test fixtures only (never imported by app code). The payloads group C
// reads, copied from autopilot_contract.md: the prompt box estimate and Run
// (4), the ranking and the RunSummary inside it (3c), and the overview's
// engines (board_contract.md 5). Numbers show shapes, not measurements.
// Each builder takes overrides.

const clone = (value) => JSON.parse(JSON.stringify(value))

/** POST /prompt-box/websites/<id>/estimate/ */
export function estimatePayload(overrides = {}) {
    return {
        answers: 6,
        usd_max: '0.4800',
        engines: [
            { key: 'chatgpt', label: 'ChatGPT' },
            { key: 'claude', label: 'Claude' },
        ],
        allowance: { unlimited: false, left_usd: '2.24' },
        daily: { limit: 100, left: 94 },
        tracked: { prompt_id: null, brand_prompt_id: null },
        blockers: [],
        can_run: true,
        confirm: { answers: 6, ai_usd_max: '0.4800' },
        ...clone(overrides),
    }
}

/** One answer of a Run. */
export function answerPayload(fields = {}) {
    return {
        id: 'a-1',
        sample: 1,
        status: 'done',
        mentioned: true,
        rank: 1,
        sentiment: 'positive',
        excerpt: 'Obsidian and Notion are the usual picks for small teams.',
        brands: [{ name: 'Obsidian', position: 2 }],
        citations: 4,
        error: null,
        ...fields,
    }
}

const TIMEOUT = { code: 'timeout', message: 'The engine did not respond in time.' }

/** One engine of a Run: Claude named in 2 of 2, as in the contract. */
export function enginePayload(key = 'claude', fields = {}) {
    const label = { chatgpt: 'ChatGPT', claude: 'Claude' }[key] || key
    return {
        key,
        label,
        asked: 3,
        answered: 2,
        named: 2,
        share_pct: 100.0,
        share_low_pct: 34.2,
        share_high_pct: 100.0,
        avg_rank: 1.5,
        answers: [
            answerPayload({ id: `${key}-1`, sample: 1, rank: 1 }),
            answerPayload({ id: `${key}-2`, sample: 2, rank: 2, sentiment: 'neutral', brands: [], citations: 0 }),
            answerPayload({ id: `${key}-3`, sample: 3, status: 'running', mentioned: null, rank: null, sentiment: null, excerpt: null, brands: [], citations: 0 }),
        ],
        ...fields,
    }
}

/** A Run (POST and GET /prompt-box/websites/<id>/runs/...). */
export function runPayload(overrides = {}) {
    return {
        id: 'r-1',
        text: 'best note taking app for small teams',
        samples: 3,
        status: 'running',
        created_at: new Date(Date.now() - 20_000).toISOString(),
        finished_at: null,
        progress: { total: 6, done: 2, failed: 0, running: 2 },
        engines: [enginePayload('chatgpt', { answered: 0, named: 0, share_pct: null, share_low_pct: null, share_high_pct: null, avg_rank: null, answers: [] }), enginePayload('claude')],
        cost: { ai_usd: '0.0712' },
        tracked: { prompt_id: null, brand_prompt_id: null },
        error: null,
        ...overrides,
    }
}

/** A finished run: ChatGPT's three answers failed, Claude named you in 2 of 3. */
export function doneRun(overrides = {}) {
    const failed = (i) =>
        answerPayload({ id: `chatgpt-${i}`, sample: i, status: 'failed', mentioned: null, rank: null, sentiment: null, excerpt: null, brands: [], citations: 0, error: TIMEOUT })
    return runPayload({
        status: 'done',
        finished_at: new Date().toISOString(),
        progress: { total: 6, done: 3, failed: 3, running: 0 },
        engines: [
            {
                key: 'chatgpt',
                label: 'ChatGPT',
                asked: 3,
                answered: 0,
                named: 0,
                share_pct: null,
                share_low_pct: null,
                share_high_pct: null,
                avg_rank: null,
                answers: [failed(1), failed(2), failed(3)],
            },
            {
                key: 'claude',
                label: 'Claude',
                asked: 3,
                answered: 3,
                named: 2,
                share_pct: 66.7,
                share_low_pct: 20.8,
                share_high_pct: 93.9,
                avg_rank: 1.5,
                answers: [
                    answerPayload({ id: 'claude-1', sample: 1, rank: 1 }),
                    answerPayload({ id: 'claude-2', sample: 2, rank: 2, sentiment: 'neutral', brands: [], citations: 0 }),
                    answerPayload({ id: 'claude-3', sample: 3, mentioned: false, rank: null, sentiment: null, brands: [{ name: 'Evernote', position: 1 }] }),
                ],
            },
        ],
        ...overrides,
    })
}

/** A run as the runs list sends it: the same, without answers. */
export function summaryOf(run) {
    return { ...run, engines: run.engines.map(({ answers: _answers, ...engine }) => engine) }
}

/** The full run (?full=1): each answer's text, citation URLs and searches. */
export function fullRun(run) {
    return {
        ...run,
        engines: run.engines.map((engine) => ({
            ...engine,
            answers: (engine.answers || []).map((a) => ({
                ...a,
                answer_text: a.status === 'done' ? `Full answer ${a.id}.\nSecond paragraph.` : '',
                citation_urls: a.status === 'done' ? ['https://example.com/notes', 'javascript:alert(1)'] : [],
                search_queries: [],
            })),
        })),
    }
}

/** RunSummary (contract 3c). */
export function runSummary(overrides = {}) {
    return {
        id: 'ap-1',
        local_date: '2026-11-04',
        trigger: 'schedule',
        status: 'done',
        stage: 'finished',
        started_at: '2026-11-04T07:00:00Z',
        finished_at: '2026-11-04T07:04:00Z',
        prompts: { planned: 9, done: 9, failed: 0, skipped: 0, over_limit: 0 },
        answers: { asked: 18, answered: 18, named: 15, share_pct: 83.3 },
        change_pts: 6.0,
        google: { status: 'done', measured: 9, checked: 0, reused: 9, page_one: 0, pages: 0, credits: 0 },
        analysis: { status: 'done', answers: 15, new_contradicted: 0 },
        cost: { ai_usd: '0.3600' },
        text: { status: 'sent', reason: '', due_at: null, sent_at: '2026-11-04T08:00:00Z' },
        error: null,
        ...overrides,
    }
}

/** One prompt of the ranking (contract 3c). */
export function rankingRow(id, fields = {}) {
    return {
        prompt_id: id,
        brand_prompt_id: `bp-${id}`,
        text: `prompt ${id}`,
        rank: 1,
        ranked: true,
        answers: 14,
        named: 12,
        share_pct: 85.7,
        share_low_pct: 60.1,
        share_high_pct: 96.0,
        prev_share_pct: 71.4,
        change_pts: 14.3,
        avg_rank: 2.1,
        engines: { chatgpt: { answers: 7, named: 7 }, claude: { answers: 7, named: 5 } },
        google: { status: 'ok', position: 4, page_one: true, depth: 10, checked_at: '2026-11-03T10:00:00Z' },
        ...fields,
    }
}

/** `n` ranked prompts, best first: p-1 at 90%, then 10 points less each. */
export function rankedRows(n) {
    return Array.from({ length: n }, (_, i) =>
        rankingRow(`p-${i + 1}`, { rank: i + 1, share_pct: 90 - i * 10, named: 12 - i, text: `prompt ${i + 1}` }),
    )
}

/** GET /autopilot/websites/<id>/ranking/ */
export function rankingPayload(overrides = {}) {
    return {
        window: { days: 7, start: '2026-10-29', end: '2026-11-04' },
        min_answers: 4,
        tracked: { count: 9, limit: 100, over_limit: 0 },
        autopilot: { enabled: true, last_run: runSummary(), next_run_at: '2026-11-05T07:00:00Z' },
        headline: { answers: 126, named: 49, share_pct: 38.9, prev_share_pct: 33.3, change_pts: 5.6 },
        prompts: [rankingRow('p-1')],
        ...overrides,
    }
}

/** The overview's engines: ChatGPT and Claude configured, Gemini not. */
export function overviewEngines(configured = ['chatgpt', 'claude']) {
    return {
        engines: [
            { key: 'chatgpt', label: 'ChatGPT', configured: configured.includes('chatgpt') },
            { key: 'claude', label: 'Claude', configured: configured.includes('claude') },
            { key: 'gemini', label: 'Gemini', configured: configured.includes('gemini') },
        ],
    }
}

/** An API error as the client rejects with it. */
export function httpError(status, code = 'error', message = 'Something went wrong.', details = undefined) {
    const error = { code, message }
    if (details !== undefined) error.details = details
    return Object.assign(new Error(String(status)), {
        response: { status, data: { success: false, error } },
        displayMessage: message,
    })
}

/** What the API client resolves with: the unwrapped envelope. */
export const ok = (data) => ({ success: true, data })
