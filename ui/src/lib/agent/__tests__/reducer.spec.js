import { describe, expect, it } from 'vitest'
import { initialRunState, isPartActive, parseTabId, reduceEvent, reduceEvents } from '../reducer'
import {
    ASSISTANT_ID,
    CHAT_ID,
    SERP_CAPTURE,
    emptyAssistant,
    eventFactory,
    researchRunEvents,
} from './__fixtures__/runEvents'
import {
    CAPTURE_ID,
    SERP_CAPTURE as SWARM_SERP_CAPTURE,
    SWARM_MESSAGE_ID,
    SWARM_PART_ID,
    SWARM_RUN_ID,
    contractEvents,
    expectedSwarmPart,
    swarmAssistant,
    swarmRunEvents,
    swarmTable,
} from './__fixtures__/swarmEvents'

function snapshot(overrides = {}) {
    return {
        message: emptyAssistant(overrides.message),
        run: initialRunState(overrides.run),
        drafts: overrides.drafts || {},
    }
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        Object.values(value).forEach(deepFreeze)
    }
    return value
}

const types = (effects) => effects.map((fx) => fx.type)

describe('reduceEvents: a full research turn', () => {
    const events = researchRunEvents()
    const out = reduceEvents(snapshot(), events)

    it('builds the parts in arrival order with their final values', () => {
        expect(out.message.parts.map((p) => p.id)).toEqual(['p-think', 'p-serp', 'p-claude', 'p-grok', 'p-text'])
        const [think, serp, claude, grok, text] = out.message.parts
        expect(think).toMatchObject({ type: 'thinking', text: 'Checking Google first.', duration_ms: 2000 })
        expect(serp).toMatchObject({ status: 'done', brand_positions: [14], result_count: 3, tab_id: 'serp:cap-1' })
        expect(claude).toMatchObject({ status: 'done', mentioned: true, rank: 3 })
        expect(grok).toMatchObject({ status: 'unavailable', error: 'XAI_API_KEY is not set' })
        expect(text.text).toBe('# Turonote on Google and AI\n\nYou rank #14 on Google.')
    })

    it('finishes the message and the run', () => {
        expect(out.message.status).toBe('complete')
        expect(out.message.parts_seq).toBe(18)
        expect(out.message.duration_ms).toBe(9000)
        expect(out.message.model).toBe('claude-opus-5-5')
        expect(out.run).toMatchObject({ phase: 'done', lastSeq: 18, durationMs: 9000, stopReason: 'end_turn', outcome: 'complete' })
        expect(out.run.startedAt).toBe(Date.parse('2026-11-02T10:00:01Z'))
        expect(out.run.usage).toEqual({
            requests: 2,
            input_tokens: 1200,
            output_tokens: 300,
            cache_read_tokens: 900,
            cache_write_tokens: 100,
            web_search_requests: 0,
            cost_usd: 0.0125,
        })
    })

    it('keeps the Google capture in the message research store', () => {
        const stored = out.message.research.serp['cap-1']
        expect(stored.results).toEqual(SERP_CAPTURE.results)
        expect(stored.brand_positions).toEqual([14])
        expect(stored.query).toBe('best note app')
        expect(out.message.research.pages).toEqual({})
    })

    it('reports pane, title and terminal effects in order', () => {
        expect(types(out.effects)).toEqual(['pane.open', 'pane.update', 'chat.updated', 'terminal'])
        const [open, update, title, terminal] = out.effects
        expect(open).toMatchObject({ activate: true, tab: { id: 'serp:cap-1', kind: 'serp', status: 'loading', title: 'Google · best note app · p2' } })
        expect(open.tab.data.capture_id).toBe('cap-1')
        expect(update).toMatchObject({ tabId: 'serp:cap-1', kind: 'serp', patch: { status: 'ready' } })
        expect(update.patch.data.results).toHaveLength(3)
        expect(title).toEqual({ type: 'chat.updated', chatId: CHAT_ID, title: 'Turonote visibility' })
        expect(terminal).toEqual({ type: 'terminal', phase: 'done', status: 'complete' })
    })

    it('ignores the same events applied again', () => {
        const again = reduceEvents({ message: out.message, run: out.run, drafts: out.drafts }, events)
        expect(again.message).toBe(out.message)
        expect(again.run).toBe(out.run)
        expect(again.effects).toEqual([])
    })

    it('gives the same result when the batch is split', () => {
        let state = snapshot()
        for (const chunk of [events.slice(0, 5), events.slice(5, 11), events.slice(11)]) {
            const step = reduceEvents(state, chunk)
            state = { message: step.message, run: step.run, drafts: step.drafts }
        }
        expect(state.message).toEqual(out.message)
        expect(state.run).toEqual(out.run)
    })

    it('never mutates its inputs', () => {
        const input = deepFreeze(snapshot())
        const frozenEvents = deepFreeze(researchRunEvents())
        expect(() => reduceEvents(input, frozenEvents)).not.toThrow()
        expect(input.message.parts).toEqual([])
    })
})

describe('reduceEvent', () => {
    it('drops events at or below lastSeq', () => {
        const e = eventFactory({ start: 4 })
        const state = snapshot({ run: { lastSeq: 5 } })
        const stale = reduceEvent(state, { ...e('part.added', { part: { id: 'x', type: 'text', text: '' } }), seq: 5 })
        expect(stale.state).toBe(state)
        const fresh = reduceEvent(state, { ...e('part.added', { part: { id: 'x', type: 'text', text: '' } }), seq: 6 })
        expect(fresh.state.message.parts).toHaveLength(1)
        expect(fresh.state.run.lastSeq).toBe(6)
    })

    it('ignores unknown event types but advances lastSeq', () => {
        const out = reduceEvent(snapshot(), { v: 1, seq: 3, type: 'something.new' })
        expect(out.state.message.parts).toEqual([])
        expect(out.state.run.lastSeq).toBe(3)
        expect(out.effects).toEqual([])
    })

    it('ignores malformed input', () => {
        const state = snapshot()
        expect(reduceEvent(state, null).state).toBe(state)
        expect(reduceEvent(state, { seq: 1 }).state).toBe(state)
    })
})

describe('parts', () => {
    const e = eventFactory()
    const base = reduceEvents(snapshot(), [
        e('part.added', { part: { id: 'a', type: 'text', request: 1, text: 'Hello' } }),
        e('part.added', { part: { id: 'b', type: 'tool', request: 1, name: 'get_project_overview', label: 'Read the overview', status: 'running' } }),
    ])
    const state = { message: base.message, run: base.run, drafts: base.drafts }

    it('appends deltas to the named field and keeps other parts by identity', () => {
        const out = reduceEvent(state, e('part.delta', { part_id: 'a', field: 'text', append: ' world' }))
        expect(out.state.message.parts[0].text).toBe('Hello world')
        expect(out.state.message.parts[1]).toBe(state.message.parts[1])
    })

    it('ignores a delta for an unknown part', () => {
        const out = reduceEvent(state, e('part.delta', { part_id: 'nope', field: 'text', append: 'x' }))
        expect(out.state.message).toBe(state.message)
    })

    it('shallow-merges part.updated and keeps the id', () => {
        const out = reduceEvent(state, e('part.updated', { part_id: 'b', patch: { status: 'done', summary: '3 prompts', id: 'other' } }))
        expect(out.state.message.parts[1]).toMatchObject({ id: 'b', status: 'done', summary: '3 prompts', label: 'Read the overview' })
    })

    it('replaces a part re-added with the same id', () => {
        const out = reduceEvent(state, e('part.added', { part: { id: 'a', type: 'text', request: 1, text: 'Replaced' } }))
        expect(out.state.message.parts).toHaveLength(2)
        expect(out.state.message.parts[0].text).toBe('Replaced')
    })
})

describe('turn.reset', () => {
    it('drops the parts of that request and the drafts it started', () => {
        const e = eventFactory()
        const built = reduceEvents(snapshot(), [
            e('part.added', { part: { id: 'keep', type: 'text', request: 1, text: 'Kept' } }),
            e('part.added', { part: { id: 'call', type: 'agent_call', request: 2, agent: 'landing_page', status: 'drafting', artifact_id: 'art-1' } }),
            e('artifact.started', { artifact_id: 'art-1', kind: 'page', title: 'Battery page', agent_key: 'landing_page', base_version: null }),
            e('artifact.delta', { artifact_id: 'art-1', append: '<!DOCTYPE html>' }),
            e('part.added', { part: { id: 'drop', type: 'text', request: 2, text: 'Partial' } }),
        ])
        expect(built.drafts['art-1'].request).toBe(2)
        const out = reduceEvents({ message: built.message, run: built.run, drafts: built.drafts }, [e('turn.reset', { request: 2 })])
        expect(out.message.parts.map((p) => p.id)).toEqual(['keep'])
        expect(out.drafts).toEqual({})
        expect(out.effects).toEqual([{ type: 'artifact.reset', artifactId: 'art-1' }])
    })

    it('matches requests across number and string', () => {
        const e = eventFactory()
        const built = reduceEvents(snapshot(), [e('part.added', { part: { id: 'x', type: 'text', request: '3', text: '' } })])
        const out = reduceEvents({ message: built.message, run: built.run, drafts: built.drafts }, [e('turn.reset', { request: 3 })])
        expect(out.message.parts).toEqual([])
    })
})

describe('lifecycle', () => {
    it('keeps a requested cancel through run.started', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot({ run: { phase: 'cancelling' } }), [e('run.started', { model: 'claude-opus-5-5' })])
        expect(out.run.phase).toBe('cancelling')
        expect(out.message.status).toBe('streaming')
    })

    it('records retries and clears them on the next part event', () => {
        const e = eventFactory()
        const retrying = reduceEvents(snapshot(), [e('run.retrying', { attempt: 1, reason: 'overloaded', delay_ms: 2000 })])
        expect(retrying.run.retrying).toMatchObject({ attempt: 1, reason: 'overloaded', delayMs: 2000 })
        const resumed = reduceEvents(
            { message: retrying.message, run: retrying.run, drafts: retrying.drafts },
            [e('part.added', { part: { id: 't', type: 'text', text: '' } })]
        )
        expect(resumed.run.retrying).toBeNull()
    })

    it.each([
        ['run.failed', { error: { code: 'allowance_exceeded', message: 'Allowance used up.', retryable: false } }, 'failed', 'failed'],
        ['run.cancelled', {}, 'cancelled', 'cancelled'],
        ['run.interrupted', { reason: 'worker restarted' }, 'failed', 'interrupted'],
        ['run.completed', { status: 'truncated', stop_reason: 'max_tokens', parts_seq: 4, duration_ms: 100 }, 'done', 'truncated'],
        ['run.completed', { status: 'refused', stop_reason: 'refusal', parts_seq: 4, duration_ms: 100 }, 'done', 'refused'],
    ])('%s sets the phase and the message status', (type, payload, phase, messageStatus) => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [e(type, payload)])
        expect(out.run.phase).toBe(phase)
        expect(out.message.status).toBe(messageStatus)
        expect(out.effects).toEqual([{ type: 'terminal', phase, status: messageStatus }])
        expect(out.message.finished_at).toBeTruthy()
    })

    it('copies the failure onto the run and the message', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [e('run.failed', { error: { code: 'upstream_overloaded', message: 'Busy.', retryable: true } })])
        expect(out.run.error).toEqual({ code: 'upstream_overloaded', message: 'Busy.', retryable: true })
        expect(out.message).toMatchObject({ error_code: 'upstream_overloaded', error_message: 'Busy.' })
    })

    it('reports interrupted runs as retryable failures', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [e('run.interrupted', { reason: 'worker restarted' })])
        expect(out.run.error).toEqual({ code: 'interrupted', message: 'worker restarted', retryable: true })
    })

    it('turns resync into an effect', () => {
        const e = eventFactory()
        expect(reduceEvents(snapshot(), [e('resync', { reason: 'buffer_expired' })]).effects).toEqual([
            { type: 'resync', reason: 'buffer_expired' },
        ])
    })
})

describe('artifacts', () => {
    it('drafts a page from deltas and completes it', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [
            e('part.added', { part: { id: 'call', type: 'agent_call', request: 1, agent: 'landing_page', status: 'drafting', artifact_id: 'art-1' } }),
            e('artifact.started', { artifact_id: 'art-1', kind: 'page', title: 'Battery page', agent_key: 'landing_page', base_version: null }),
            e('artifact.delta', { artifact_id: 'art-1', append: '<!DOCTYPE html><html>' }),
            e('artifact.delta', { artifact_id: 'art-1', append: '</html>' }),
            e('artifact.completed', { artifact_id: 'art-1', version: 1, title: 'Battery landing page', summary: '5 sections', warnings: [] }),
        ])
        expect(out.drafts['art-1']).toMatchObject({
            artifactId: 'art-1',
            kind: 'page',
            agentKey: 'landing_page',
            status: 'done',
            content: '<!DOCTYPE html><html></html>',
            version: 1,
            title: 'Battery landing page',
            summary: '5 sections',
            request: 1,
        })
        expect(out.effects).toEqual([
            { type: 'artifact.started', artifactId: 'art-1', kind: 'page', title: 'Battery page' },
            { type: 'artifact.completed', artifactId: 'art-1', version: 1 },
        ])
    })

    it('keeps the latest sheet snapshot, parsing JSON text', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [
            e('artifact.started', { artifact_id: 'art-2', kind: 'sheet', title: 'Ads', agent_key: 'ad_campaign', base_version: null }),
            e('artifact.snapshot', { artifact_id: 'art-2', content: { campaign: { name: 'Draft' } } }),
            e('artifact.snapshot', { artifact_id: 'art-2', content: '{"campaign":{"name":"Notes"},"ad_groups":[]}' }),
        ])
        expect(out.drafts['art-2'].data).toEqual({ campaign: { name: 'Notes' }, ad_groups: [] })
    })

    it('marks a failed draft and reports it', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [
            e('artifact.started', { artifact_id: 'art-3', kind: 'document', title: 'Article', agent_key: 'aeo_article', base_version: 2 }),
            e('artifact.failed', { artifact_id: 'art-3', error: { code: 'insufficient_allowance', message: 'Not enough allowance.' } }),
        ])
        expect(out.drafts['art-3']).toMatchObject({ status: 'failed', baseVersion: 2, error: { code: 'insufficient_allowance', message: 'Not enough allowance.' } })
        expect(out.effects[1]).toEqual({
            type: 'artifact.failed',
            artifactId: 'art-3',
            error: { code: 'insufficient_allowance', message: 'Not enough allowance.' },
        })
    })

    it('creates a draft for a delta whose start it missed', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [e('artifact.delta', { artifact_id: 'art-4', append: '# Title' })])
        expect(out.drafts['art-4']).toMatchObject({ status: 'drafting', content: '# Title', partial: true })
    })

    // A reload mid-draft resumes after parts_seq, which the sub-agent's
    // checkpoints have moved past artifact.started: only the persisted
    // agent_call part says what is being written.
    it('takes kind, title and agent from the agent_call part when it resumed past artifact.started', () => {
        const e = eventFactory({ start: 40 })
        const resumed = snapshot({
            message: {
                parts: [
                    {
                        id: 'call',
                        type: 'agent_call',
                        request: 2,
                        agent: 'landing_page',
                        agent_name: 'Landing Page Agent',
                        status: 'drafting',
                        artifact_id: 'art-5',
                        title: 'Battery page',
                        kind: 'page',
                    },
                ],
                parts_seq: 40,
            },
            run: { lastSeq: 40 },
        })
        const out = reduceEvents(resumed, [e('artifact.delta', { artifact_id: 'art-5', append: '<section>tail</section>' })])
        expect(out.drafts['art-5']).toMatchObject({
            kind: 'page',
            title: 'Battery page',
            agentKey: 'landing_page',
            request: 2,
            status: 'drafting',
            // Only the text since the resume point: not the document.
            partial: true,
            content: '<section>tail</section>',
        })
    })

    it('keeps a sheet first seen through a snapshot whole, with the kind from its agent_call part', () => {
        const e = eventFactory({ start: 40 })
        const resumed = snapshot({
            message: {
                parts: [{ id: 'call', type: 'agent_call', request: 1, agent: 'ad_campaign', status: 'drafting', artifact_id: 'art-6', title: 'Ads', kind: 'sheet' }],
            },
            run: { lastSeq: 40 },
        })
        const out = reduceEvents(resumed, [e('artifact.snapshot', { artifact_id: 'art-6', content: '{"campaign":{"name":"Notes"}}' })])
        expect(out.drafts['art-6']).toMatchObject({ kind: 'sheet', title: 'Ads', agentKey: 'ad_campaign', partial: false })
        expect(out.drafts['art-6'].data).toEqual({ campaign: { name: 'Notes' } })
    })

    it('a draft that saw artifact.started is whole', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [
            e('artifact.started', { artifact_id: 'art-7', kind: 'document', title: 'Article', agent_key: 'aeo_article', base_version: null }),
            e('artifact.delta', { artifact_id: 'art-7', append: '# Article' }),
        ])
        expect(out.drafts['art-7']).toMatchObject({ kind: 'document', partial: false, content: '# Article' })
    })
})

describe('browser events', () => {
    it('stores page captures under pages and infers a ready tab from its facts', () => {
        const e = eventFactory()
        const capture = {
            capture_id: 'pg-1',
            url: 'https://turonote.com/',
            final_url: 'https://turonote.com/',
            captured_at: '2026-11-02T10:00:09Z',
            frameable: true,
            status_code: 200,
            seo: { title: 'Turonote', title_length: 8 },
            reader: null,
            error: null,
        }
        const out = reduceEvents(snapshot(), [e('browser.open', { tab: { id: 'page:pg-1', kind: 'page', title: 'Turonote', data: capture }, activate: false })])
        expect(out.message.research.pages['pg-1']).toEqual(capture)
        expect(out.effects[0]).toMatchObject({ type: 'pane.open', activate: false, tab: { id: 'page:pg-1', kind: 'page', status: 'ready' } })
    })

    it('settles an updated tab from its data when the patch has no status', () => {
        const e = eventFactory()
        const opened = reduceEvents(snapshot(), [
            e('browser.open', { tab: { id: 'serp:c9', kind: 'serp', title: 'Google · q', status: 'loading', data: { capture_id: 'c9', query: 'q' } }, activate: true }),
        ])
        const state = { message: opened.message, run: opened.run, drafts: opened.drafts }
        const ready = reduceEvent(state, e('browser.update', { tab_id: 'serp:c9', patch: { results: [] } }))
        expect(ready.effects[0].patch.status).toBe('ready')
        expect(ready.effects[0].patch.data).toMatchObject({ capture_id: 'c9', query: 'q', results: [] })

        const failed = reduceEvent(state, e('browser.update', { tab_id: 'serp:c9', patch: { error: { code: 'serp_failed', message: 'SerpAPI error' } } }))
        expect(failed.effects[0].patch.status).toBe('error')

        const titled = reduceEvent(state, e('browser.update', { tab_id: 'serp:c9', patch: { title: 'Renamed' } }))
        expect(titled.effects[0].patch).not.toHaveProperty('status')
        expect(titled.effects[0].patch.title).toBe('Renamed')
    })

    it('takes the status and title sent beside the patch', () => {
        const e = eventFactory()
        const opened = reduceEvents(snapshot(), [
            e('browser.open', { tab: { id: 'page:pg-2', kind: 'page', title: 'turonote.com', status: 'loading', data: { capture_id: 'pg-2', url: 'https://turonote.com/' } }, activate: true }),
        ])
        const state = { message: opened.message, run: opened.run, drafts: opened.drafts }
        // Nothing in this data settles the tab by itself; the explicit status does.
        const capture = { capture_id: 'pg-2', url: 'https://turonote.com/', seo: null, reader: null, error: null }
        const out = reduceEvent(state, e('browser.update', { tab_id: 'page:pg-2', status: 'ready', title: 'Turonote: notes that sync', patch: capture }))
        expect(out.effects[0].patch).toMatchObject({ status: 'ready', title: 'Turonote: notes that sync' })
        expect(out.state.message.research.pages['pg-2']).not.toHaveProperty('title')
    })

    it('ignores a browser.open without a tab id', () => {
        const e = eventFactory()
        const out = reduceEvents(snapshot(), [e('browser.open', { tab: { kind: 'serp' }, activate: true })])
        expect(out.effects).toEqual([])
    })
})

describe('research agents', () => {
    // The swarm events start at seq 41 of their run (contract 4b).
    function swarmSnapshot(message = {}) {
        return { message: swarmAssistant(message), run: initialRunState({ lastSeq: 40, phase: 'running' }), drafts: {} }
    }

    function stateAfter(events) {
        const out = reduceEvents(swarmSnapshot(), events)
        return { message: out.message, run: out.run, drafts: out.drafts }
    }

    const swarmEvent = (seq, type, payload) => ({
        v: 1,
        seq,
        type,
        run_id: SWARM_RUN_ID,
        message_id: SWARM_MESSAGE_ID,
        ts: '2026-11-04T10:16:00.000Z',
        ...payload,
    })
    const taskEvent = (seq, type, taskId, rev, patch) =>
        swarmEvent(seq, type, { part_id: SWARM_PART_ID, task_id: taskId, rev, patch })

    // The full run up to its three queued agents.
    const queued = () => stateAfter(swarmRunEvents().slice(0, 3))

    it('replays the contract examples', () => {
        const out = reduceEvents(swarmSnapshot(), contractEvents())
        expect(out.message.parts.map((p) => [p.id, p.type])).toEqual([
            ['p4', 'swarm'],
            ['p5', 'swarm_table'],
        ])
        const [swarm, table] = out.message.parts
        expect(swarm).toMatchObject({ status: 'partial', ended_at: '2026-11-04T10:17:18.510Z', duration_ms: 134201, table_version: 1 })
        expect(swarm.tasks).toHaveLength(1)
        expect(swarm.tasks[0]).toMatchObject({
            id: 'google.p1.page1',
            status: 'done',
            step: '',
            attempt: 1,
            started_at: '2026-11-04T10:15:04.401Z',
            result: "You're #4 · AI Overview shown",
            tone: 'good',
            pane: { kind: 'serp', tab_id: 'serp:3f2a9c1d0e7b' },
            rev: 4,
        })
        expect(table).toMatchObject({ swarm_id: '5d0c...', version: 1, status: 'partial' })
        expect(out.message.research.serp[CAPTURE_ID]).toEqual(SWARM_SERP_CAPTURE)
        expect(out.run.lastSeq).toBe(142)
        // The Google page opens as a background tab; this event predates
        // task_id, so its place among the swarm's pages is unknown.
        expect(out.effects).toEqual([
            {
                type: 'pane.open',
                tab: { id: `serp:${CAPTURE_ID}`, kind: 'serp', title: '', status: 'ready', data: SWARM_SERP_CAPTURE },
                activate: false,
                background: true,
                order: null,
            },
        ])
    })

    it('replays a full run to the part the backend persists', () => {
        const out = reduceEvents(swarmSnapshot(), swarmRunEvents())
        expect(out.message.parts.map((p) => p.id)).toEqual(['p4', 'p5', 'p6'])
        expect(out.message.parts[0]).toEqual(expectedSwarmPart())
        expect(out.message.parts[1].table).toEqual(swarmTable(1))
        expect(out.message.parts[2].text).toBe('# Notion on Google and AI')
        expect(out.message.research).toEqual({ serp: { [CAPTURE_ID]: SWARM_SERP_CAPTURE }, pages: {} })
        expect(out.message.status).toBe('complete')
        expect(out.message.parts_seq).toBe(145)
        // One background tab for its Google page, then the end of the run.
        expect(types(out.effects)).toEqual(['pane.open', 'terminal'])
        expect(out.effects[0]).toMatchObject({ tab: { id: `serp:${CAPTURE_ID}` }, activate: false, background: true })
    })

    it('gives the same part when the run arrives in several batches, or again after a resume', () => {
        const events = swarmRunEvents()
        let state = swarmSnapshot()
        for (const chunk of [events.slice(0, 4), events.slice(4, 9), events.slice(9)]) {
            const step = reduceEvents(state, chunk)
            state = { message: step.message, run: step.run, drafts: step.drafts }
        }
        expect(state.message.parts[0]).toEqual(expectedSwarmPart())

        // A resumed stream replays task events the checkpoint already holds.
        const resumed = reduceEvents({ ...state, run: { ...state.run, lastSeq: 50 } }, events.slice(6, 14))
        expect(resumed.message.parts[0]).toEqual(expectedSwarmPart())
    })

    it('never mutates its inputs', () => {
        const input = deepFreeze(swarmSnapshot())
        const events = deepFreeze(swarmRunEvents())
        expect(() => reduceEvents(input, events)).not.toThrow()
        expect(input.message.parts).toEqual([])
        expect(input.message.research).toEqual({ serp: {}, pages: {} })
    })

    it('applies task events in rev order and ignores a stale or repeated rev', () => {
        const state = queued()
        const progress = taskEvent(50, 'task.progress', 'engines.p1.claude', 3, { step: 'Claude was busy; trying again', attempt: 2 })
        const late = taskEvent(51, 'task.started', 'engines.p1.claude', 2, { status: 'running', step: 'Asking Claude', attempt: 1 })
        const out = reduceEvents(state, [progress, late])
        expect(out.message.parts[0].tasks[2]).toMatchObject({ status: 'queued', step: 'Claude was busy; trying again', attempt: 2, rev: 3 })
        expect(out.run.lastSeq).toBe(51)

        const again = reduceEvent(
            { message: out.message, run: out.run, drafts: out.drafts },
            taskEvent(52, 'task.progress', 'engines.p1.claude', 3, { step: 'Something else' })
        )
        expect(again.state.message).toBe(out.message)
        expect(again.state.run.lastSeq).toBe(52)
    })

    it('ignores task events for an unknown part, a part that is not a swarm, or an unknown task', () => {
        const state = queued()
        const text = reduceEvents(state, [
            swarmEvent(50, 'part.added', { part: { id: 'p9', type: 'text', request: 2, text: 'Hello', tasks: [{ id: 'x', rev: 1 }] } }),
        ])
        const base = { message: text.message, run: text.run, drafts: text.drafts }
        for (const event of [
            swarmEvent(51, 'task.started', { part_id: 'nope', task_id: 'google.p1.page1', rev: 2, patch: { status: 'running' } }),
            swarmEvent(52, 'task.started', { part_id: 'p9', task_id: 'x', rev: 2, patch: { status: 'running' } }),
            taskEvent(53, 'task.started', 'sources.p1.cited', 2, { status: 'running' }),
            swarmEvent(54, 'task.started', { part_id: SWARM_PART_ID, rev: 2, patch: { status: 'running' } }),
            taskEvent(55, 'task.started', 'google.p1.page1', 'not a number', { status: 'running' }),
        ]) {
            const out = reduceEvent(base, event)
            expect(out.state.message).toBe(base.message)
            expect(out.effects).toEqual([])
        }
    })

    it('ignores task events while the swarm is still planning', () => {
        const planning = stateAfter(swarmRunEvents().slice(0, 1))
        const out = reduceEvent(planning, taskEvent(50, 'task.started', 'google.p1.page1', 2, { status: 'running' }))
        expect(out.state.message).toBe(planning.message)
    })

    it('keeps untouched parts, tasks and research by identity', () => {
        const before = reduceEvents(queued(), [swarmEvent(50, 'part.added', { part: { id: 'p9', type: 'text', request: 2, text: '' } })])
        const state = { message: before.message, run: before.run, drafts: before.drafts }
        const out = reduceEvent(state, taskEvent(51, 'task.started', 'engines.p1.chatgpt', 2, { status: 'running', step: 'Asking ChatGPT' }))
        const [swarmBefore, textBefore] = state.message.parts
        const [swarmAfter, textAfter] = out.state.message.parts
        expect(swarmAfter).not.toBe(swarmBefore)
        expect(textAfter).toBe(textBefore)
        expect(swarmAfter.tasks[0]).toBe(swarmBefore.tasks[0])
        expect(swarmAfter.tasks[2]).toBe(swarmBefore.tasks[2])
        expect(swarmAfter.tasks[1]).toMatchObject({ status: 'running', step: 'Asking ChatGPT', rev: 2 })
        expect(swarmAfter.categories).toBe(swarmBefore.categories)
        expect(out.state.message.research).toBe(state.message.research)
    })

    it('never lets a patch change the task id or its rev', () => {
        const out = reduceEvent(
            queued(),
            taskEvent(50, 'task.progress', 'google.p1.page1', 2, { step: 'Fetching', id: 'other', rev: 99 })
        )
        expect(out.state.message.parts[0].tasks[0]).toMatchObject({ id: 'google.p1.page1', step: 'Fetching', rev: 2 })
    })

    it('clears a retry notice when a task moves', () => {
        const state = queued()
        const retrying = { ...state, run: { ...state.run, retrying: { attempt: 1, reason: 'overloaded', delayMs: 0, at: null } } }
        const out = reduceEvent(retrying, taskEvent(50, 'task.started', 'google.p1.page1', 2, { status: 'running' }))
        expect(out.state.run.retrying).toBeNull()
    })

    it('keeps the planning part through part.updated and replaces it when execution starts', () => {
        const titled = stateAfter(swarmRunEvents().slice(0, 2))
        expect(titled.message.parts[0]).toMatchObject({ id: 'p4', status: 'planning', title: 'Research Notion', tasks: [] })
        const running = reduceEvent(titled, swarmRunEvents()[2])
        expect(running.state.message.parts).toHaveLength(1)
        expect(running.state.message.parts[0]).toMatchObject({ status: 'running', version: 1, swarm_id: '5d0c...' })
        expect(running.state.message.parts[0].tasks.map((t) => t.id)).toEqual([
            'google.p1.page1',
            'engines.p1.chatgpt',
            'engines.p1.claude',
        ])
    })

    it('drops the planning part with its request on turn.reset', () => {
        const planning = stateAfter(swarmRunEvents().slice(0, 2))
        const out = reduceEvent(planning, swarmEvent(43, 'turn.reset', { request: 1 }))
        expect(out.state.message.parts).toEqual([])
    })

    it('merges research.recorded captures into serp and pages; only a Google page opens a tab', () => {
        const state = queued()
        const page = {
            capture_id: 'a1b2c3d4e5f6',
            url: 'https://evernote.com/',
            final_url: 'https://evernote.com/',
            status_code: 200,
            seo: { title: 'Evernote', title_length: 8 },
            error: null,
        }
        const out = reduceEvents(state, [
            swarmEvent(50, 'research.recorded', { kind: 'page', capture_id: 'a1b2c3d4e5f6', capture: page, task_id: 'competitors.p1.c1' }),
            swarmEvent(51, 'research.recorded', { kind: 'serp', capture_id: CAPTURE_ID, capture: SWARM_SERP_CAPTURE, task_id: 'google.p1.page1' }),
        ])
        expect(out.message.research.pages).toEqual({ a1b2c3d4e5f6: page })
        expect(out.message.research.serp[CAPTURE_ID]).toEqual(SWARM_SERP_CAPTURE)
        expect(out.message.parts).toBe(state.message.parts)
        // The page capture waits for a click on its task row.
        expect(out.effects).toEqual([
            {
                type: 'pane.open',
                tab: { id: `serp:${CAPTURE_ID}`, kind: 'serp', title: '', status: 'ready', data: SWARM_SERP_CAPTURE },
                activate: false,
                background: true,
                order: { group: '5d0c...:1', index: 0 },
            },
        ])

        // A later copy of the same capture merges over the stored one.
        const again = reduceEvent(
            { message: out.message, run: out.run, drafts: out.drafts },
            swarmEvent(52, 'research.recorded', { kind: 'page', capture_id: 'a1b2c3d4e5f6', capture: { status_code: 301 } })
        )
        expect(again.state.message.research.pages.a1b2c3d4e5f6).toEqual({ ...page, status_code: 301 })
    })

    it('ignores research.recorded without a capture id or with another kind', () => {
        const state = queued()
        for (const payload of [
            { kind: 'serp', capture: SWARM_SERP_CAPTURE },
            { kind: 'artifact', capture_id: 'x1', capture: {} },
            { kind: 'serp', capture_id: '', capture: SWARM_SERP_CAPTURE },
        ]) {
            const out = reduceEvent(state, swarmEvent(50, 'research.recorded', payload))
            expect(out.state.message).toBe(state.message)
        }
    })

    it('keeps a capture id when the capture omits it', () => {
        const out = reduceEvent(queued(), swarmEvent(50, 'research.recorded', { kind: 'page', capture_id: 'f00', capture: { url: 'https://a.test/' } }))
        expect(out.state.message.research.pages.f00).toEqual({ capture_id: 'f00', url: 'https://a.test/' })
    })

    describe('Google pages open as background tabs in task order', () => {
        // A swarm of two prompts and two Google pages each, in task order:
        // per prompt its pages, then its engines.
        const TASKS = ['google.p1.page1', 'google.p1.page2', 'engines.p1.chatgpt', 'google.p2.page1', 'google.p2.page2', 'engines.p2.chatgpt']

        function twoPrompts() {
            const [planning, , running] = swarmRunEvents()
            const tasks = TASKS.map((id) => ({ ...running.part.tasks[0], id }))
            return stateAfter([planning, { ...running, part: { ...running.part, tasks } }])
        }

        const recorded = (seq, captureId, fields) =>
            swarmEvent(seq, 'research.recorded', {
                kind: 'serp',
                capture_id: captureId,
                capture: { ...SWARM_SERP_CAPTURE, capture_id: captureId },
                ...fields,
            })

        it('places each page by the position of the task that took it', () => {
            const out = reduceEvents(twoPrompts(), [
                recorded(60, 'c-p2-1', { task_id: 'google.p2.page1' }),
                recorded(61, 'c-p1-2', { task_id: 'google.p1.page2' }),
                recorded(62, 'c-p1-1', { task_id: 'google.p1.page1' }),
            ])
            expect(out.effects.map((fx) => [fx.tab.id, fx.order])).toEqual([
                ['serp:c-p2-1', { group: '5d0c...:1', index: 3 }],
                ['serp:c-p1-2', { group: '5d0c...:1', index: 1 }],
                ['serp:c-p1-1', { group: '5d0c...:1', index: 0 }],
            ])
            expect(out.effects.every((fx) => fx.type === 'pane.open' && fx.activate === false && fx.background === true)).toBe(true)
        })

        it('gives no order when the task is missing, unknown or not in a swarm part', () => {
            const state = twoPrompts()
            for (const fields of [{}, { task_id: null }, { task_id: '' }, { task_id: 'google.p9.page1' }]) {
                const out = reduceEvent(state, recorded(60, 'c-x', fields))
                expect(out.effects).toHaveLength(1)
                expect(out.effects[0].order).toBeNull()
            }
            // Before execution starts the swarm part has no tasks.
            const planning = stateAfter(swarmRunEvents().slice(0, 1))
            const out = reduceEvent(planning, recorded(60, 'c-x', { task_id: 'google.p1.page1' }))
            expect(out.effects[0].order).toBeNull()
        })

        it('takes the order from the newest swarm part naming the task', () => {
            const state = twoPrompts()
            const [, , running] = swarmRunEvents()
            const rerun = { ...running.part, id: 'p9', version: 2, tasks: [{ ...running.part.tasks[0], id: 'google.p2.page1' }] }
            const next = reduceEvents(state, [swarmEvent(59, 'part.added', { part: rerun })])
            const out = reduceEvent({ message: next.message, run: next.run, drafts: next.drafts }, recorded(60, 'c-r', { task_id: 'google.p2.page1' }))
            expect(out.effects[0].order).toEqual({ group: '5d0c...:2', index: 0 })
        })

        it('opens a failed search as an error tab', () => {
            const failed = { ...SWARM_SERP_CAPTURE, results: [], error: { code: 'serp_failed', message: 'Google search failed.' } }
            const out = reduceEvent(twoPrompts(), recorded(60, CAPTURE_ID, { capture: failed, task_id: 'google.p1.page1' }))
            expect(out.effects[0].tab).toMatchObject({ id: `serp:${CAPTURE_ID}`, status: 'error' })
            expect(out.effects[0].tab.data.error.code).toBe('serp_failed')
        })

        it('opens nothing for a replayed event at or below lastSeq', () => {
            const first = reduceEvents(twoPrompts(), [recorded(60, 'c-p1-1', { task_id: 'google.p1.page1' })])
            const again = reduceEvents({ message: first.message, run: first.run, drafts: first.drafts }, [
                recorded(60, 'c-p1-1', { task_id: 'google.p1.page1' }),
            ])
            expect(again.effects).toEqual([])
            expect(again.message).toBe(first.message)
        })
    })
})

describe('helpers', () => {
    it('parses tab ids', () => {
        expect(parseTabId('serp:abc')).toEqual({ kind: 'serp', captureId: 'abc' })
        expect(parseTabId('page:a:b')).toEqual({ kind: 'page', captureId: 'a:b' })
        expect(parseTabId('plain')).toEqual({ kind: '', captureId: 'plain' })
    })

    it('treats a running part as live only while the message streams', () => {
        const part = { id: 'x', type: 'tool', status: 'running' }
        expect(isPartActive(part, { id: ASSISTANT_ID, status: 'streaming' })).toBe(true)
        expect(isPartActive(part, { id: ASSISTANT_ID, status: 'cancelled' })).toBe(false)
        expect(isPartActive({ ...part, status: 'done' }, { status: 'streaming' })).toBe(false)
    })
})
