// Test fixtures only (never imported by app code). The payloads group E
// reads: the runs block (GET agent/status/ prompt_runs and the session's
// limits.prompt_runs), the agent status with its setup issues, the parts
// of the ranking payload Next steps reads, and the saved reports with one
// report's detail. Numbers show shapes, not measurements. Each builder
// takes overrides.

/** A Free account's runs block. */
export function freeRuns(over = {}) {
    return {
        unlimited: false, limit: 20, used: 7, reserved: 0, remaining: 13, plan: 'free', scope: 'account',
        period_start: '2026-11-01T00:00:00Z', resets_at: '2026-12-01T00:00:00Z',
        by_engine: { chatgpt: 4, claude: 3 }, by_feature: { autopilot: 7 }, ...over,
    }
}

/** A paid account's runs block: no limit, runs counted all the same. */
export function paidRuns(over = {}) {
    return {
        unlimited: true, limit: null, used: 1248, reserved: 0, remaining: null, plan: 'pro', scope: 'account',
        period_start: '2026-11-01T00:00:00Z', resets_at: '2026-12-01T00:00:00Z',
        by_engine: { chatgpt: 412, claude: 388, gemini: 301, perplexity: 147 }, by_feature: {}, ...over,
    }
}

/** One setup issue, as GET agent/status/ setup.issues[] carries it. */
export function setupIssue(over = {}) {
    return {
        code: 'engine_not_configured', severity: 'limited', subject: 'engine', engine: 'grok', setting: null,
        title: "Grok isn't set up on this workspace.", action: 'Grok is skipped; the other engines still answer.', ...over,
    }
}

export const GOOGLE_ISSUE = setupIssue({
    code: 'google_not_configured', subject: 'google', engine: null,
    title: "Google results aren't set up on this workspace.", action: 'Google positions stay empty until they are.',
})

/** GET agent/status/: everything set up, on the Free plan. */
export function agentStatus(over = {}) {
    return {
        enabled: true, configured: true, live_available: true,
        engines: [
            { key: 'chatgpt', label: 'ChatGPT', configured: true },
            { key: 'claude', label: 'Claude', configured: true },
        ],
        google: { configured: true, key_settings: [] },
        research: { available: true, reason: null, message: '' },
        prompt_runs: freeRuns(),
        allowance: { show_usd: false, cap_usd: 3, spent_usd: 1.25 },
        setup: { ready: true, issues: [] },
        ...over,
    }
}

/** The parts of the ranking payload Next steps reads. */
export function rankingPayload(count = 9, enabled = true) {
    return { tracked: { count, limit: 100, over_limit: 0 }, autopilot: { enabled, last_run: null, next_run_at: null }, prompts: [] }
}

/** One saved report, as the artifact list carries it. */
export function reportRow(over = {}) {
    return {
        id: 'r1', kind: 'report', title: 'Where Wrenfield stands in AI answers', agent_key: 'gap_analyst',
        latest_version: 3, created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-08T12:00:00Z',
        created_by_name: 'Mara Lindqvist', source_chat_id: null, review: null, ...over,
    }
}

/** A report's detail: the summary plus the latest version's structured header. */
export function reportDetail(over = {}, header = {}) {
    return {
        ...reportRow(),
        version: 3, content: '# Report', content_type: 'text/markdown', summary: '', warnings: [],
        data: {
            template: 'google_ai_gap',
            header: {
                template: { id: 'google_ai_gap', name: 'Google vs AI gap' },
                project: { name: 'Wrenfield', url: 'https://wrenfield.co' },
                captured_at: '2026-11-08T12:00:00Z',
                data: [],
                engines: [
                    { key: 'chatgpt', label: 'ChatGPT', status: 'asked' },
                    { key: 'claude', label: 'Claude', status: 'asked' },
                    { key: 'grok', label: 'Grok', status: 'not_configured' },
                ],
                locations: ['us'],
                ...header,
            },
        },
        ...over,
    }
}
