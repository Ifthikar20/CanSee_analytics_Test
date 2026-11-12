// The Prompt runs block's model: where the runs block comes from, the
// allowance drawn as marks, and the words and figures of both plans.
import { describe, expect, it } from 'vitest'
import { MAX_SEGMENTS, OUT_NOTE, RUN_NOTE, runSegments, runsByEngine, runsModel, runsSource } from '../runs'

const free = (over = {}) => ({
    unlimited: false, limit: 20, used: 7, reserved: 0, remaining: 13, plan: 'free',
    resets_at: '2026-12-01T00:00:00Z', period_start: '2026-11-01T00:00:00Z',
    by_engine: { chatgpt: 4, claude: 3 }, by_feature: {}, ...over,
})
const paid = (over = {}) => ({
    unlimited: true, limit: null, used: 1248, reserved: 0, remaining: null, plan: 'pro',
    resets_at: '2026-12-01T00:00:00Z', by_engine: { chatgpt: 800, claude: 448 }, ...over,
})
const states = (marks) => marks.map((m) => `${m.state[0]}${m.next ? '*' : ''}`).join('')

describe('runsSource', () => {
    it('reads the agent status first and the session as the fallback', () => {
        const session = free({ remaining: 5 })
        const own = free({ remaining: 13 })
        expect(runsSource({ status: { prompt_runs: own }, session })).toEqual({ phase: 'ready', raw: own, stale: false })
        expect(runsSource({ status: {}, session })).toEqual({ phase: 'ready', raw: session, stale: false })
        expect(runsSource({ status: null, loading: true, session }).raw).toBe(session)
        // A status block that cannot be read does not hide a readable session block.
        expect(runsSource({ status: { prompt_runs: { limit: 20 } }, session }).raw).toBe(session)
    })

    it('marks numbers kept from before a failed refresh as stale', () => {
        expect(runsSource({ status: { prompt_runs: free() }, failed: true }).stale).toBe(true)
        expect(runsSource({ status: null, failed: true, session: free() })).toMatchObject({ phase: 'ready', stale: true })
    })

    it('is loading, failed or none when there is no block', () => {
        expect(runsSource({ loading: true }).phase).toBe('loading')
        expect(runsSource({ loading: true, failed: true }).phase).toBe('loading')
        expect(runsSource({ failed: true }).phase).toBe('failed')
        // The status answered without a runs block (an older server).
        expect(runsSource({ status: { engines: [] } }).phase).toBe('none')
        expect(runsSource({ status: null, asked: true }).phase).toBe('none')
        // Nobody asked for the status yet: still on its way.
        expect(runsSource({ status: null, asked: false }).phase).toBe('loading')
        expect(runsSource().phase).toBe('none')
        expect(runsSource({ status: 'x', session: 'y', asked: false }).phase).toBe('loading')
    })
})

describe('runsByEngine', () => {
    it('lists engines by runs, most first, ties by name, with display names', () => {
        expect(runsByEngine({ claude: 3, chatgpt: 3, gemini: 9, grok: 0 })).toEqual([
            { key: 'gemini', label: 'Gemini', count: 9, text: '9' },
            { key: 'chatgpt', label: 'ChatGPT', count: 3, text: '3' },
            { key: 'claude', label: 'Claude', count: 3, text: '3' },
        ])
    })

    it('drops what is not a count and keeps unknown engines by their key', () => {
        expect(runsByEngine({ chatgpt: 'x', claude: NaN, gemini: -2, grok: Infinity, perplexity: 0.4, mistral: '12' })).toEqual([
            { key: 'mistral', label: 'mistral', count: 12, text: '12' },
        ])
        expect(runsByEngine({ chatgpt: 1234.9 })[0]).toMatchObject({ count: 1234, text: '1,234' })
        for (const bad of [null, undefined, [], 'x', 3]) expect(runsByEngine(bad)).toEqual([])
    })
})

describe('runSegments', () => {
    const block = (limit, remaining, reserved = 0) => ({ unlimited: false, limit, remaining, reserved, used: limit - remaining - reserved })

    it('draws one mark a run: spent first, then the ones left, the next one marked', () => {
        expect(states(runSegments(block(5, 3)))).toBe('uul*ll')
        expect(states(runSegments(block(5, 5)))).toBe('l*llll')
        expect(states(runSegments(block(5, 0)))).toBe('uuuuu')
        expect(states(runSegments(block(1, 1)))).toBe('l*')
    })

    it('shows the runs out right now between the spent and the left', () => {
        expect(states(runSegments(block(6, 2, 1)))).toBe('uuuol*l')
        // More reserved than spent cannot be: it is capped at what is spent.
        expect(states(runSegments({ unlimited: false, limit: 4, remaining: 3, reserved: 9, used: 0 }))).toBe('ol*ll')
    })

    it('scales a large allowance to at most MAX_SEGMENTS marks', () => {
        const marks = runSegments(block(500, 250))
        expect(marks).toHaveLength(MAX_SEGMENTS)
        expect(marks.filter((m) => m.state === 'left')).toHaveLength(12)
        expect(marks.filter((m) => m.next)).toHaveLength(1)
        expect(runSegments(block(MAX_SEGMENTS, 1))).toHaveLength(MAX_SEGMENTS)
    })

    it('never rounds the last run away, nor a spent run back', () => {
        const oneLeft = runSegments(block(500, 1))
        expect(oneLeft.filter((m) => m.state === 'left')).toHaveLength(1)
        expect(oneLeft.at(-1)).toEqual({ state: 'left', next: true })
        const oneSpent = runSegments(block(500, 499))
        expect(oneSpent.filter((m) => m.state === 'used')).toHaveLength(1)
        const oneOut = runSegments(block(500, 400, 1))
        expect(oneOut.filter((m) => m.state === 'out')).toHaveLength(1)
        expect(states(runSegments(block(500, 0)))).toBe('u'.repeat(MAX_SEGMENTS))
        expect(states(runSegments(block(500, 500)))).toBe(`l*${'l'.repeat(MAX_SEGMENTS - 1)}`)
    })

    it('keeps the marks inside the allowance when the server says more is left than the limit', () => {
        expect(states(runSegments({ unlimited: false, limit: 3, remaining: 7, reserved: 0, used: 0 }))).toBe('l*ll')
    })

    it('draws nothing without a limit', () => {
        expect(runSegments(null)).toEqual([])
        expect(runSegments({ unlimited: true, limit: null, remaining: null })).toEqual([])
        expect(runSegments({ unlimited: false, limit: null, remaining: 4 })).toEqual([])
        expect(runSegments({ unlimited: false, limit: 0, remaining: 0 })).toEqual([])
    })
})

describe('runsModel', () => {
    it('reads a Free account as runs left of the allowance, with the renewal date', () => {
        const m = runsModel(free())
        expect(m).toMatchObject({
            mode: 'free', numeral: '13', unit: '/ 20', cap: '', label: 'Free runs left',
            limit: 20, remaining: 13, used: 7, reserved: 0, exhausted: false, low: false,
            usedText: '7 used', outText: '', renews: 'Renews December 1', perMark: 0, notes: [RUN_NOTE],
        })
        expect(m.segments).toHaveLength(20)
        expect(m.engines.map((e) => e.key)).toEqual(['chatgpt', 'claude'])
        expect(m.sentence).toBe(
            '13 free prompt runs left. 7 of 20 free prompt runs used. By engine: ChatGPT 4, Claude 3. They renew on December 1.',
        )
    })

    it('never shows a dollar amount, whatever the block carries', () => {
        const m = runsModel(free({ usd: '4.20', cap_usd: 3, spent_usd: 1.25 }))
        expect(JSON.stringify(m)).not.toMatch(/\$|usd|4\.20|1\.25/i)
    })

    it('says when the runs are used up and what still works', () => {
        const m = runsModel(free({ used: 20, remaining: 0 }))
        expect(m).toMatchObject({ numeral: '0', exhausted: true, low: false, notes: [OUT_NOTE, RUN_NOTE] })
        expect(m.segments.every((s) => s.state === 'used')).toBe(true)
        expect(m.sentence).toContain('No free prompt runs left.')
    })

    it('calls a quarter or less of the allowance low', () => {
        expect(runsModel(free({ used: 15, remaining: 5 })).low).toBe(true)
        expect(runsModel(free({ used: 14, remaining: 6 })).low).toBe(false)
        // A small allowance: the last run is always low.
        expect(runsModel(free({ limit: 2, used: 1, remaining: 1 })).low).toBe(true)
        expect(runsModel(free({ limit: null, remaining: 1 })).low).toBe(false)
    })

    it('counts the runs out right now', () => {
        const m = runsModel(free({ used: 5, reserved: 2, remaining: 13 }))
        expect(m.outText).toBe('2 running now')
        expect(m.segments.filter((s) => s.state === 'out')).toHaveLength(2)
        expect(m.sentence).toContain('2 running now.')
    })

    it('falls back to what the block does state', () => {
        // No limit known: a number without a unit and without marks.
        const noLimit = runsModel({ unlimited: false, remaining: 4 })
        expect(noLimit).toMatchObject({ numeral: '4', unit: '', segments: [], renews: '', engines: [] })
        expect(noLimit.sentence).toBe('4 free prompt runs left.')
        // No remaining: limit - used - reserved.
        expect(runsModel({ unlimited: false, limit: 10, used: 3, reserved: 2 }).numeral).toBe('5')
        // A bad date is left out, not printed.
        expect(runsModel(free({ resets_at: 'soon' })).renews).toBe('')
        expect(runsModel(free({ limit: 5000, used: 0, remaining: 5000 }))).toMatchObject({ numeral: '5,000', unit: '/ 5,000' })
    })

    it('scales the marks of a large allowance and says what one stands for', () => {
        const m = runsModel(free({ limit: 120, used: 30, remaining: 90 }))
        expect(m.segments).toHaveLength(MAX_SEGMENTS)
        expect(m.perMark).toBe(5)
    })

    it('reads an account without a limit as runs used, with no allowance', () => {
        const m = runsModel(paid({ reserved: 3 }))
        expect(m).toMatchObject({
            mode: 'unlimited', numeral: '1,248', unit: 'runs', cap: 'No limit', label: 'Used this month',
            limit: null, remaining: null, segments: [], exhausted: false, low: false,
            usedText: '', outText: '3 running now', renews: 'Resets December 1', notes: [RUN_NOTE],
        })
        expect(m.sentence).toBe(
            '1,248 prompt runs used this month. This account has no monthly limit. 3 running now. By engine: ChatGPT 800, Claude 448. The count restarts on December 1.',
        )
        expect(runsModel(paid({ used: 1, by_engine: {} }))).toMatchObject({ numeral: '1', unit: 'run' })
        expect(runsModel(paid({ used: 0, by_engine: null })).sentence).toContain('0 prompt runs used this month.')
    })

    it('is null for a block it cannot read', () => {
        for (const bad of [null, undefined, 'x', 3, [], {}, { limit: 20, remaining: 3 }, { unlimited: false }, { unlimited: 'yes', limit: 3 }]) {
            expect(runsModel(bad)).toBeNull()
        }
        expect(runsModel({ unlimited: false, limit: NaN, remaining: Infinity })).toBeNull()
    })
})
