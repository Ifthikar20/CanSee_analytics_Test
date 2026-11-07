// Test fixtures only (never imported by app code). Research agent events
// (design/swarm_contract.md 4b): contractEvents() is a literal copy of the
// contract's examples; swarmRunEvents() extends them to a full run of three
// agents (one Google page, ChatGPT done, Claude failed) that ends partial,
// adds its results table, and is followed by the report and run.completed.
// expectedSwarmPart() is the persisted swarm part that run leaves, written
// out by hand.

export const SWARM_RUN_ID = '8c1e...'
export const SWARM_MESSAGE_ID = 'b77a...'
export const SWARM_ID = '5d0c...'
export const SWARM_PART_ID = 'p4'
export const TABLE_PART_ID = 'p5'
export const CAPTURE_ID = '3f2a9c1d0e7b'
export const PROMPT = 'best note taking app for teams'

const envelope = (seq, type, ts) => ({ v: 1, seq, type, run_id: SWARM_RUN_ID, message_id: SWARM_MESSAGE_ID, ts })

/** The assistant message the swarm events apply to, before seq 41. */
export function swarmAssistant(overrides = {}) {
    return {
        id: SWARM_MESSAGE_ID,
        chat_id: 'c1d2...',
        parent_id: 'u1',
        role: 'assistant',
        status: 'streaming',
        parts: [],
        parts_seq: 40,
        sibling_ids: [SWARM_MESSAGE_ID],
        research: { serp: {}, pages: {} },
        run_id: SWARM_RUN_ID,
        ...overrides,
    }
}

const GOOGLE_CATEGORY = {
    key: 'google',
    label: 'Google (SEO)',
    notes: [],
    subcategories: [{ key: 'p1', label: PROMPT }],
}

const ENGINES_CATEGORY = {
    key: 'engines',
    label: 'AI engines (GEO)',
    notes: [
        {
            level: 'info',
            code: 'engines_not_configured',
            text: 'Gemini, Grok and Perplexity are not configured, so they were not asked.',
        },
    ],
    subcategories: [{ key: 'p1', label: PROMPT }],
}

function queuedTask(fields) {
    return {
        status: 'queued',
        step: '',
        result: '',
        tone: null,
        depends_on: [],
        started_at: null,
        ended_at: null,
        duration_ms: null,
        attempt: 0,
        error: null,
        pane: null,
        detail: null,
        rev: 1,
        ...fields,
    }
}

const GOOGLE_TASK = queuedTask({
    id: 'google.p1.page1',
    category: 'google',
    subcategory: 'p1',
    worker: 'serp_page',
    label: 'Google page 1',
    target: PROMPT,
})

const CHATGPT_TASK = queuedTask({
    id: 'engines.p1.chatgpt',
    category: 'engines',
    subcategory: 'p1',
    worker: 'engine_answer',
    label: 'ChatGPT',
    target: PROMPT,
})

const CLAUDE_TASK = queuedTask({
    id: 'engines.p1.claude',
    category: 'engines',
    subcategory: 'p1',
    worker: 'engine_answer',
    label: 'Claude',
    target: PROMPT,
})

export const SERP_CAPTURE = {
    capture_id: CAPTURE_ID,
    query: PROMPT,
    page: 1,
    start: 0,
    location: 'us',
    captured_at: '2026-11-04T10:15:19.004Z',
    provider: 'scraperapi',
    brand: { name: 'Notion', domain: 'notion.so' },
    brand_positions: [4],
    results: [],
    ai_overview: null,
    people_also_ask: [],
    error: null,
    cost_usd: 0.0,
}

const GOOGLE_FINISH = {
    status: 'done',
    step: '',
    ended_at: '2026-11-04T10:15:19.149Z',
    duration_ms: 14748,
    result: "You're #4 · AI Overview shown",
    tone: 'good',
    pane: { kind: 'serp', tab_id: `serp:${CAPTURE_ID}` },
    error: null,
    detail: {
        query: PROMPT,
        page: 1,
        location: 'us',
        provider: 'scraperapi',
        captured_at: '2026-11-04T10:15:19.004Z',
        reused: false,
        brand_positions: [4],
        result_count: 10,
        top: [],
        ai_overview: { shown: true, content_captured: true, mentions_you: false, cites_you: false, references: [] },
        people_also_ask: [],
    },
}

const CHATGPT_DETAIL = {
    engine: 'chatgpt',
    engine_label: 'ChatGPT',
    variant: null,
    model_id: 'gpt-4o-mini',
    prompt_text: PROMPT,
    answered_at: '2026-11-04T10:15:31.220Z',
    mentioned: false,
    rank: null,
    sentiment: null,
    brands: [
        { name: 'Evernote', position: 1 },
        { name: 'OneNote', position: 2 },
    ],
    brands_above: [
        { name: 'Evernote', position: 1 },
        { name: 'OneNote', position: 2 },
    ],
    snippet: '',
    citations: [{ url: 'https://zapier.com/blog/best-note-taking-apps/', domain: 'zapier.com', is_yours: false }],
    analysis: {
        summary: 'ChatGPT recommends Evernote and OneNote and does not name Notion.',
        reasons: ['Strong offline mode', 'Free tier'],
        opportunity: 'Publish a comparison page that names offline support and pricing.',
    },
    analysis_error: null,
    result_id: 'c2b1...',
}

const CLAUDE_ERROR = { code: 'rate_limited', message: 'The engine was busy or rate limited.' }

function cell(text, fields = {}) {
    return { text, v: null, state: 'ok', tone: null, note: null, task_id: null, version: 1, previous: null, ...fields }
}

const NOT_CONFIGURED = (key) =>
    cell('Not configured', { state: 'not_configured', tone: 'muted', note: `${key} is not set` })

/** A SwarmTable (contract 5e) for the run; `version` and `overrides` vary it. */
export function swarmTable(version = 1, overrides = {}) {
    const finding = {
        title: `Not named by ChatGPT for “${PROMPT}”`,
        detail: 'Google ranks you #4, and ChatGPT lists Evernote and OneNote without naming you.',
        category: 'engines',
        severity: 'high',
        prompt_text: PROMPT,
        evidence: [{ kind: 'serp', label: "Google page 1 · you're #4", tab_id: `serp:${CAPTURE_ID}`, url: null }],
    }
    const at = (fields) => ({ version, ...fields })
    return {
        swarm_id: SWARM_ID,
        version,
        title: 'Research Notion',
        status: 'partial',
        generated_at: '2026-11-04T10:17:18.880Z',
        previous_version: version > 1 ? version - 1 : null,
        counts: { total: 3, done: 2, failed: 1, skipped: 0, stopped: 0 },
        notes: [],
        changes: [],
        sheets: [
            {
                key: 'prompts',
                title: 'Prompts',
                columns: [
                    { key: 'prompt', label: 'Prompt', kind: 'text', align: 'left', sortable: true },
                    { key: 'google', label: 'Google', kind: 'rank', align: 'right', sortable: true },
                    { key: 'ai_overview', label: 'AI Overview', kind: 'status', align: 'left', sortable: true },
                    { key: 'chatgpt', label: 'ChatGPT', kind: 'rank', align: 'left', sortable: true },
                    { key: 'claude', label: 'Claude', kind: 'rank', align: 'left', sortable: true },
                    { key: 'gemini', label: 'Gemini', kind: 'rank', align: 'left', sortable: true },
                    { key: 'grok', label: 'Grok', kind: 'rank', align: 'left', sortable: true },
                    { key: 'perplexity', label: 'Perplexity', kind: 'rank', align: 'left', sortable: true },
                    { key: 'ahead', label: 'Ahead of you', kind: 'text', align: 'left', sortable: false },
                    { key: 'cited', label: 'Cited sources', kind: 'text', align: 'left', sortable: true },
                    { key: 'gap', label: 'Gap', kind: 'class', align: 'left', sortable: true },
                    { key: 'finding', label: 'Finding', kind: 'text', align: 'left', sortable: false },
                ],
                rows: [
                    {
                        key: 'p1',
                        cells: {
                            prompt: cell(PROMPT, at({ v: PROMPT })),
                            google: cell('#4', at({ v: 4, note: 'Page 1 of 1 searched', task_id: 'google.p1.page1' })),
                            ai_overview: cell('Shown, not named', at({ v: 2, tone: 'warn', task_id: 'google.p1.page1' })),
                            chatgpt: cell(
                                'Not named',
                                at({ v: 1000, state: 'not_found', tone: 'warn', note: 'Lists Evernote, OneNote', task_id: 'engines.p1.chatgpt' })
                            ),
                            claude: cell(
                                'Failed',
                                at({ state: 'failed', tone: 'bad', note: CLAUDE_ERROR.message, task_id: 'engines.p1.claude' })
                            ),
                            gemini: NOT_CONFIGURED('GEMINI_API_KEY'),
                            grok: NOT_CONFIGURED('XAI_API_KEY'),
                            perplexity: NOT_CONFIGURED('PERPLEXITY_API_KEY'),
                            ahead: cell('Evernote, OneNote', at({ task_id: 'engines.p1.chatgpt' })),
                            cited: cell('Not measured', at({ state: 'not_measured', tone: 'muted' })),
                            gap: cell('Google ahead (−45)', at({ v: -45, tone: 'warn' })),
                            finding: cell(finding.title, at({})),
                        },
                        task_ids: ['google.p1.page1', 'engines.p1.chatgpt', 'engines.p1.claude'],
                        finding,
                        links: [{ kind: 'serp', label: 'Google page 1', tab_id: `serp:${CAPTURE_ID}`, url: null }],
                    },
                ],
            },
        ],
        ...overrides,
    }
}

/** The contract's examples (4b), exactly as written there. */
export function contractEvents() {
    return [
        {
            ...envelope(41, 'part.added', '2026-11-04T10:15:01.902Z'),
            part: {
                id: 'p4',
                type: 'swarm',
                request: 1,
                swarm_id: null,
                version: null,
                title: '',
                scope: 'all',
                scope_label: '',
                status: 'planning',
                started_at: null,
                ended_at: null,
                duration_ms: null,
                categories: [],
                tasks: [],
                table_version: null,
                error: null,
                limits: null,
            },
        },
        {
            ...envelope(44, 'part.added', '2026-11-04T10:15:04.310Z'),
            part: {
                id: 'p4',
                type: 'swarm',
                request: 1,
                swarm_id: '5d0c...',
                version: 1,
                title: 'Research Notion',
                scope: 'all',
                scope_label: 'All agents',
                status: 'running',
                started_at: '2026-11-04T10:15:04.309Z',
                ended_at: null,
                duration_ms: null,
                table_version: null,
                error: null,
                limits: { max_tasks: 30, workers: 6 },
                categories: [GOOGLE_CATEGORY, ENGINES_CATEGORY],
                tasks: [GOOGLE_TASK],
            },
        },
        {
            ...envelope(45, 'task.started', '2026-11-04T10:15:04.402Z'),
            part_id: 'p4',
            task_id: 'google.p1.page1',
            rev: 2,
            patch: { status: 'running', started_at: '2026-11-04T10:15:04.401Z', step: 'Fetching Google page 1', attempt: 1 },
        },
        {
            ...envelope(52, 'task.progress', '2026-11-04T10:15:19.003Z'),
            part_id: 'p4',
            task_id: 'google.p1.page1',
            rev: 3,
            patch: { step: 'Reading the results' },
        },
        {
            ...envelope(53, 'research.recorded', '2026-11-04T10:15:19.120Z'),
            kind: 'serp',
            capture_id: '3f2a9c1d0e7b',
            capture: SERP_CAPTURE,
        },
        {
            ...envelope(54, 'task.finished', '2026-11-04T10:15:19.150Z'),
            part_id: 'p4',
            task_id: 'google.p1.page1',
            rev: 4,
            patch: GOOGLE_FINISH,
        },
        {
            ...envelope(140, 'part.updated', '2026-11-04T10:17:18.511Z'),
            part_id: 'p4',
            patch: { status: 'partial', ended_at: '2026-11-04T10:17:18.510Z', duration_ms: 134201 },
        },
        {
            ...envelope(141, 'part.added', '2026-11-04T10:17:18.900Z'),
            part: {
                id: 'p5',
                type: 'swarm_table',
                request: 1,
                swarm_id: '5d0c...',
                version: 1,
                title: 'Research Notion',
                status: 'partial',
                generated_at: '2026-11-04T10:17:18.880Z',
                table: { '...': 'SwarmTable, section 5e' },
            },
        },
        {
            ...envelope(142, 'part.updated', '2026-11-04T10:17:18.901Z'),
            part_id: 'p4',
            patch: { table_version: 1 },
        },
    ]
}

/**
 * The contract's run extended to three agents, in the order the backend
 * emits (contract 4d): the planning part and its title, the full part with
 * every task queued at rev 1, per task started < progress < finished (the
 * capture recorded before its task finishes), the swarm's end, its table,
 * then the report and run.completed.
 */
export function swarmRunEvents() {
    const [planning, , googleStarted, googleProgress, recorded, googleFinished, ended, , tableVersion] = contractEvents()
    const running = {
        ...envelope(44, 'part.added', '2026-11-04T10:15:04.310Z'),
        part: {
            ...contractEvents()[1].part,
            tasks: [GOOGLE_TASK, CHATGPT_TASK, CLAUDE_TASK],
        },
    }
    const table = {
        ...envelope(141, 'part.added', '2026-11-04T10:17:18.900Z'),
        part: {
            id: TABLE_PART_ID,
            type: 'swarm_table',
            request: 1,
            swarm_id: SWARM_ID,
            version: 1,
            title: 'Research Notion',
            status: 'partial',
            generated_at: '2026-11-04T10:17:18.880Z',
            table: swarmTable(1),
        },
    }
    const task = (seq, type, ts, taskId, rev, patch) => ({
        ...envelope(seq, type, ts),
        part_id: SWARM_PART_ID,
        task_id: taskId,
        rev,
        patch,
    })
    return [
        planning,
        { ...envelope(42, 'part.updated', '2026-11-04T10:15:02.410Z'), part_id: SWARM_PART_ID, patch: { title: 'Research Notion' } },
        running,
        googleStarted,
        task(46, 'task.started', '2026-11-04T10:15:04.405Z', 'engines.p1.chatgpt', 2, {
            status: 'running',
            started_at: '2026-11-04T10:15:04.404Z',
            step: 'Asking ChatGPT',
            attempt: 1,
        }),
        task(47, 'task.started', '2026-11-04T10:15:04.408Z', 'engines.p1.claude', 2, {
            status: 'running',
            started_at: '2026-11-04T10:15:04.407Z',
            step: 'Asking Claude',
            attempt: 1,
        }),
        task(48, 'task.progress', '2026-11-04T10:15:10.020Z', 'engines.p1.claude', 3, {
            step: 'Claude was busy; trying again',
            attempt: 2,
        }),
        googleProgress,
        recorded,
        googleFinished,
        task(60, 'task.progress', '2026-11-04T10:15:31.300Z', 'engines.p1.chatgpt', 3, { step: 'Analyzing the answer' }),
        task(61, 'task.finished', '2026-11-04T10:15:40.120Z', 'engines.p1.claude', 4, {
            status: 'failed',
            step: '',
            ended_at: '2026-11-04T10:15:40.119Z',
            duration_ms: 35712,
            result: '',
            tone: 'bad',
            pane: null,
            error: CLAUDE_ERROR,
            detail: null,
        }),
        task(75, 'task.finished', '2026-11-04T10:15:42.010Z', 'engines.p1.chatgpt', 4, {
            status: 'done',
            step: '',
            ended_at: '2026-11-04T10:15:42.009Z',
            duration_ms: 37605,
            result: 'Not named · lists Evernote, OneNote',
            tone: 'warn',
            pane: null,
            error: null,
            detail: CHATGPT_DETAIL,
        }),
        ended,
        table,
        tableVersion,
        {
            ...envelope(143, 'part.added', '2026-11-04T10:17:20.000Z'),
            part: { id: 'p6', type: 'text', request: 2, text: '', citations: [] },
        },
        { ...envelope(144, 'part.delta', '2026-11-04T10:17:21.000Z'), part_id: 'p6', field: 'text', append: '# Notion on Google and AI' },
        {
            ...envelope(145, 'run.completed', '2026-11-04T10:17:40.000Z'),
            status: 'complete',
            stop_reason: 'end_turn',
            parts_seq: 145,
            duration_ms: 160000,
        },
    ]
}

/** The swarm part swarmRunEvents() leaves, as the backend persists it. */
export function expectedSwarmPart() {
    return {
        id: SWARM_PART_ID,
        type: 'swarm',
        request: 1,
        swarm_id: SWARM_ID,
        version: 1,
        title: 'Research Notion',
        scope: 'all',
        scope_label: 'All agents',
        status: 'partial',
        started_at: '2026-11-04T10:15:04.309Z',
        ended_at: '2026-11-04T10:17:18.510Z',
        duration_ms: 134201,
        table_version: 1,
        error: null,
        limits: { max_tasks: 30, workers: 6 },
        categories: [GOOGLE_CATEGORY, ENGINES_CATEGORY],
        tasks: [
            {
                id: 'google.p1.page1',
                category: 'google',
                subcategory: 'p1',
                worker: 'serp_page',
                label: 'Google page 1',
                target: PROMPT,
                status: 'done',
                step: '',
                result: "You're #4 · AI Overview shown",
                tone: 'good',
                depends_on: [],
                started_at: '2026-11-04T10:15:04.401Z',
                ended_at: '2026-11-04T10:15:19.149Z',
                duration_ms: 14748,
                attempt: 1,
                error: null,
                pane: { kind: 'serp', tab_id: 'serp:3f2a9c1d0e7b' },
                detail: GOOGLE_FINISH.detail,
                rev: 4,
            },
            {
                id: 'engines.p1.chatgpt',
                category: 'engines',
                subcategory: 'p1',
                worker: 'engine_answer',
                label: 'ChatGPT',
                target: PROMPT,
                status: 'done',
                step: '',
                result: 'Not named · lists Evernote, OneNote',
                tone: 'warn',
                depends_on: [],
                started_at: '2026-11-04T10:15:04.404Z',
                ended_at: '2026-11-04T10:15:42.009Z',
                duration_ms: 37605,
                attempt: 1,
                error: null,
                pane: null,
                detail: CHATGPT_DETAIL,
                rev: 4,
            },
            {
                id: 'engines.p1.claude',
                category: 'engines',
                subcategory: 'p1',
                worker: 'engine_answer',
                label: 'Claude',
                target: PROMPT,
                status: 'failed',
                step: '',
                result: '',
                tone: 'bad',
                depends_on: [],
                started_at: '2026-11-04T10:15:04.407Z',
                ended_at: '2026-11-04T10:15:40.119Z',
                duration_ms: 35712,
                attempt: 2,
                error: { code: 'rate_limited', message: 'The engine was busy or rate limited.' },
                pane: null,
                detail: null,
                rev: 4,
            },
        ],
    }
}
