// Test fixtures only (never imported by app code). Contract-shaped run
// events (design/agent_contract.md section 2) for one research turn:
// thinking, a Google results page shown in the pane, two background engine
// checks, the streamed reply, usage, the generated title and completion.

export const RUN_ID = 'run-1'
export const CHAT_ID = 'chat-1'
export const USER_MESSAGE_ID = 'msg-user-1'
export const ASSISTANT_ID = 'msg-asst-1'

export function eventFactory({ runId = RUN_ID, messageId = ASSISTANT_ID, start = 0 } = {}) {
    let seq = start
    return function event(type, payload = {}) {
        seq += 1
        const second = String(seq % 60).padStart(2, '0')
        return { v: 1, seq, type, run_id: runId, message_id: messageId, ts: `2026-11-02T10:00:${second}Z`, ...payload }
    }
}

export const SERP_CAPTURE = {
    capture_id: 'cap-1',
    query: 'best note app',
    page: 2,
    start: 10,
    location: 'US',
    captured_at: '2026-11-02T10:00:05Z',
    brand: { name: 'Turonote', domain: 'turonote.com' },
    brand_positions: [14],
    results: [
        {
            position: 11,
            title: 'Note apps compared',
            url: 'https://reviews.example/notes',
            display_url: 'reviews.example › notes',
            domain: 'reviews.example',
            snippet: 'A comparison.',
            is_yours: false,
            is_competitor: false,
        },
        {
            position: 12,
            title: 'Notion',
            url: 'https://www.notion.so/',
            display_url: 'notion.so',
            domain: 'notion.so',
            snippet: 'Workspace.',
            is_yours: false,
            is_competitor: true,
            competitor_name: 'Notion',
        },
        {
            position: 14,
            title: 'Turonote',
            url: 'https://turonote.com/',
            display_url: 'turonote.com',
            domain: 'turonote.com',
            snippet: 'Notes.',
            is_yours: true,
            is_competitor: false,
        },
    ],
    ai_overview: { shown: false, mentions_you: false, cites_you: false, references: [] },
    people_also_ask: ['What is the best free note app?'],
    error: null,
}

export function emptyAssistant(overrides = {}) {
    return {
        id: ASSISTANT_ID,
        chat_id: CHAT_ID,
        parent_id: USER_MESSAGE_ID,
        role: 'assistant',
        status: 'streaming',
        parts: [],
        parts_seq: 0,
        sibling_ids: [ASSISTANT_ID],
        research: { serp: {}, pages: {} },
        run_id: RUN_ID,
        ...overrides,
    }
}

/** The full research turn, seq 1..N. */
export function researchRunEvents() {
    const e = eventFactory()
    const { results, brand_positions, ai_overview, people_also_ask, ...loading } = SERP_CAPTURE
    return [
        e('run.started', { chat_id: CHAT_ID, user_message_id: USER_MESSAGE_ID, model: 'claude-opus-5-5' }),
        e('part.added', { part: { id: 'p-think', type: 'thinking', request: 1, text: '', started_at: '2026-11-02T10:00:02Z' } }),
        e('part.delta', { part_id: 'p-think', field: 'text', append: 'Checking Google ' }),
        e('part.delta', { part_id: 'p-think', field: 'text', append: 'first.' }),
        e('part.updated', { part_id: 'p-think', patch: { ended_at: '2026-11-02T10:00:04Z', duration_ms: 2000 } }),
        e('part.added', {
            part: { id: 'p-serp', type: 'serp', request: 1, query: 'best note app', page: 2, location: 'US', status: 'running', tab_id: 'serp:cap-1' },
        }),
        e('browser.open', {
            tab: { id: 'serp:cap-1', kind: 'serp', title: 'Google · best note app · p2', status: 'loading', data: { ...loading, error: null } },
            activate: true,
        }),
        e('browser.update', { tab_id: 'serp:cap-1', patch: { status: 'ready', results, brand_positions, ai_overview, people_also_ask } }),
        e('part.updated', {
            part_id: 'p-serp',
            patch: { status: 'done', brand_positions: [14], result_count: 3, ai_overview_shown: false },
        }),
        e('part.added', {
            part: { id: 'p-claude', type: 'engine_check', request: 1, prompt_id: 7, prompt_text: 'best note app', engine: 'claude', engine_label: 'Claude', status: 'queued' },
        }),
        e('part.added', {
            part: { id: 'p-grok', type: 'engine_check', request: 1, prompt_id: 7, prompt_text: 'best note app', engine: 'grok', engine_label: 'Grok', status: 'unavailable', error: 'XAI_API_KEY is not set' },
        }),
        e('part.updated', { part_id: 'p-claude', patch: { status: 'done', mentioned: true, rank: 3, sentiment: 'positive' } }),
        e('part.added', { part: { id: 'p-text', type: 'text', request: 2, text: '', citations: [] } }),
        e('part.delta', { part_id: 'p-text', field: 'text', append: '# Turonote on Google and AI\n\n' }),
        e('part.delta', { part_id: 'p-text', field: 'text', append: 'You rank #14 on Google.' }),
        e('run.usage', {
            requests: 2,
            input_tokens: 1200,
            output_tokens: 300,
            cache_read_tokens: 900,
            cache_write_tokens: 100,
            web_search_requests: 0,
            cost_usd: 0.0125,
        }),
        e('chat.updated', { chat_id: CHAT_ID, title: 'Turonote visibility' }),
        e('run.completed', { status: 'complete', stop_reason: 'end_turn', parts_seq: 18, duration_ms: 9000 }),
    ]
}
