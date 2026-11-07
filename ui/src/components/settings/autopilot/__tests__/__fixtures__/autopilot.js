// Autopilot payloads as autopilot_contract.md 3a and 3c give them. Numbers
// show shapes, not measurements. Each builder takes overrides; object
// overrides merge one level deep (settings, sms, cost...).

const CONSENT_TEXT =
    'I agree to receive one automated text a day from Cansee about Notion at this number. Msg & data rates may apply. Reply STOP to cancel or HELP for help. Consent is not a condition of purchase.'

function merge(base, overrides) {
    const out = { ...base }
    for (const [key, value] of Object.entries(overrides || {})) {
        const current = base[key]
        const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v)
        out[key] = isObject(current) && isObject(value) ? { ...current, ...value } : value
    }
    return out
}

export const MINE = { id: 'sub-mine', phone_masked: '•••-•••-1234', yours: true }
export const MINE_TOO = { id: 'sub-mine-2', phone_masked: '•••-•••-5678', yours: true }
export const THEIRS = {
    id: 'sub-theirs',
    phone_masked: '•••-•••-9876',
    status: 'verified',
    set_by_name: 'Ifthikar',
    yours: false,
}

export function settingsPayload(overrides = {}) {
    return merge(
        {
            available: true,
            saved: true,
            plan: { id: 'prompts_100', name: '100 prompts', autopilot: true, sms_digest: true },
            tracked: { limit: 100, used: 9, over_limit: 0 },
            settings: {
                enabled: false,
                run_time: '07:00',
                timezone: 'UTC',
                run_engines: true,
                run_google: true,
                google_cadence: 'daily',
                run_analysis: true,
                sms_digest: false,
                sms_subscription_id: null,
                quiet_start: '21:00',
                quiet_end: '08:00',
                paused_reason: '',
            },
            engines: [
                { key: 'chatgpt', label: 'ChatGPT', configured: true },
                { key: 'claude', label: 'Claude', configured: true },
            ],
            google: { configured: true, provider_label: 'ScraperAPI', credits_per_page: 25 },
            sms: {
                available: true,
                numbers: [MINE],
                recipient: null,
                consent_text: CONSENT_TEXT,
                consent_version: 'digest-v1',
            },
            allowance: {
                unlimited: false,
                cap_usd: '52.00',
                spent_usd: '3.10',
                left_usd: '48.90',
                reserve_pct: 10,
                resets_on: '2026-12-01',
            },
            cost: {
                last_run: { ai_usd: '1.2700', answers: 200, google_pages: 100, credits: 2500 },
                month_projection_usd: '38.10',
                runs_out_on: null,
                bound: { ai_usd_max: '6.0000', google_pages_max: 100 },
            },
            next_run_at: '2026-11-05T12:00:00Z',
            today_run: null,
            runs: [],
        },
        overrides,
    )
}

export function runSummary(overrides = {}) {
    return merge(
        {
            id: 'run-1',
            local_date: '2026-11-04',
            trigger: 'schedule',
            status: 'done',
            stage: 'finished',
            started_at: '2026-11-04T07:00:12Z',
            finished_at: '2026-11-04T07:09:40Z',
            prompts: { planned: 100, done: 100, failed: 0, skipped: 0, over_limit: 0 },
            answers: { asked: 200, answered: 198, named: 41, share_pct: 20.7 },
            change_pts: 3.1,
            google: { status: 'done', measured: 100, checked: 96, reused: 4, page_one: 2, pages: 96, credits: 2400 },
            analysis: { status: 'done', answers: 41, new_contradicted: 1 },
            cost: { ai_usd: '1.2700' },
            text: { status: 'sent', reason: '', due_at: '2026-11-04T08:00:00Z', sent_at: '2026-11-04T08:00:05Z' },
            error: null,
        },
        overrides,
    )
}

// The Run now estimate of the Notion test project (ownership 8, step 4).
export function runEstimate(overrides = {}) {
    return merge(
        {
            prompts: 9,
            over_limit: 0,
            limited_by: null,
            engines: [
                { key: 'chatgpt', label: 'ChatGPT' },
                { key: 'claude', label: 'Claude' },
            ],
            answers_max: 18,
            usd_max: '1.4400',
            usd_expected: '0.3600',
            pages_max: 9,
            credits_max: 225,
            allowance: { unlimited: false, cap_usd: '5.00', left_usd: '2.24', reserve_pct: 10, usable_usd: '1.74' },
            blockers: [],
            can_run: true,
            confirm: { answers: 18, ai_usd_max: '1.4400', google_pages: 9 },
        },
        overrides,
    )
}
