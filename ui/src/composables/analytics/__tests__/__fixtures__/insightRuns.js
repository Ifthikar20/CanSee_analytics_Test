// Contract fixtures (p2_contract.md 1e) for the insights run pieces.

export const ALLOWANCE = { unlimited: false, cap_usd: '5.00', spent_usd: '0.92', left_usd: '4.08' }

export function runOptions(kind = 'answer_analysis', overrides = {}) {
    return {
        kind,
        enabled: true,
        configured: { ai: true, google: true, google_provider: 'scraperapi', google_provider_label: 'ScraperAPI', shopping: true },
        limits: { max_units: 60 },
        allowance: ALLOWANCE,
        google_daily: { limit: 60, used: 0, left: 60, credits_per_page: 25 },
        choices: {},
        active_run: null,
        last_run: null,
        ...overrides,
    }
}

export function runEstimate(kind = 'answer_analysis', overrides = {}) {
    return {
        kind,
        summary: '40 answers that name you, last 30 days',
        units: { answers: 40 },
        ai: { calls_max: 80, usd_max: '0.2400', model_label: 'Claude Haiku 5.5' },
        google: { pages_max: 0, credits_max: 0, usd_max: '0.0000', daily_left: 60, daily_limit: 60 },
        fetches: { pages_max: 5 },
        allowance: { unlimited: false, cap_usd: '5.00', left_usd: '4.08', enough: true },
        confirm: { ai_calls: 80, ai_usd_max: '0.2400', google_pages: 0 },
        warnings: [{ code: 'upper_bound', message: 'These are upper bounds; you are billed only for what runs.' }],
        blockers: [],
        can_run: true,
        ...overrides,
    }
}

export function run(overrides = {}) {
    return {
        id: '2c1e0000-0000-4000-8000-000000000001',
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
        ...overrides,
    }
}

/** An axios-like rejection with the API's error envelope. */
export function apiError(status, code, message, details = undefined) {
    return Object.assign(new Error(message), {
        response: { status, data: { success: false, error: { code, message, details } } },
        displayMessage: message,
    })
}
