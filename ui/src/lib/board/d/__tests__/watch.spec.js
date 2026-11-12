import { describe, expect, it } from 'vitest'
import { gaze, gazeText, watchFacts, watchReadouts, watchSentence, watchStatus } from '../watch'

const ENGINES = [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
    { key: 'gemini', label: 'Gemini', configured: false },
]
const overview = (fields = {}) => ({ engines: ENGINES, kpis: { prompts: 2 }, prompts: [{ prompt_id: 'a' }, { prompt_id: 'b' }], ...fields })

describe('watchFacts', () => {
    it('is null without a payload', () => {
        for (const bad of [null, undefined, 'x', 0]) expect(watchFacts(bad)).toBeNull()
    })

    it('counts the tracked prompts and the engines that are set up', () => {
        expect(watchFacts(overview())).toEqual({
            prompts: 2,
            engines: [
                { key: 'chatgpt', label: 'ChatGPT', ready: true },
                { key: 'claude', label: 'Claude', ready: true },
                { key: 'gemini', label: 'Gemini', ready: false },
            ],
            ready: 2,
            total: 3,
        })
    })

    it('counts the list itself, and falls back to the kpi only when the list is missing', () => {
        expect(watchFacts(overview({ prompts: [], kpis: { prompts: 9 } })).prompts).toBe(0)
        expect(watchFacts(overview({ prompts: [{}, null, {}] })).prompts).toBe(2)
        expect(watchFacts(overview({ prompts: undefined, kpis: { prompts: 7 } })).prompts).toBe(7)
        expect(watchFacts(overview({ prompts: undefined, kpis: { prompts: 7.9 } })).prompts).toBe(7)
        for (const bad of [NaN, -2, '5', null, undefined]) {
            expect(watchFacts(overview({ prompts: undefined, kpis: { prompts: bad } })).prompts, String(bad)).toBe(0)
        }
        expect(watchFacts({}).prompts).toBe(0)
    })

    it('reads engines defensively', () => {
        const facts = watchFacts(overview({ engines: [null, {}, { key: 'grok' }, { label: 'Perplexity', configured: 1 }] }))
        expect(facts.engines).toEqual([
            { key: 'grok', label: 'grok', ready: false },
            { key: 'Perplexity', label: 'Perplexity', ready: true },
        ])
        expect(watchFacts(overview({ engines: 'nope' })).total).toBe(0)
    })
})

describe('watchStatus', () => {
    it('is live only with prompts and an engine to ask them', () => {
        expect(watchStatus(watchFacts(overview()))).toBe('live')
        expect(watchStatus(watchFacts(overview({ prompts: [] })))).toBe('empty')
        expect(watchStatus(watchFacts(overview({ engines: ENGINES.map((e) => ({ ...e, configured: false })) })))).toBe('setup')
        expect(watchStatus(watchFacts(overview({ engines: [] })))).toBe('setup')
        expect(watchStatus(null)).toBe('empty')
    })
})

describe('watchReadouts', () => {
    it('says what is tracked and how many engines are set up', () => {
        expect(watchReadouts(watchFacts(overview()))).toEqual({ prompts: '2 prompts tracked', engines: '2 of 3 engines' })
        expect(watchReadouts(watchFacts(overview({ prompts: [{}] }))).prompts).toBe('1 prompt tracked')
        expect(watchReadouts(watchFacts(overview({ engines: [ENGINES[0]] }))).engines).toBe('1 of 1 engine')
    })

    it('is honest when nothing is tracked or no engine is listed', () => {
        expect(watchReadouts(watchFacts(overview({ prompts: [] }))).prompts).toBe('No prompts tracked yet')
        expect(watchReadouts(watchFacts(overview({ engines: [] }))).engines).toBe('')
        expect(watchReadouts(null)).toEqual({ prompts: '', engines: '' })
    })
})

describe('watchSentence', () => {
    it('carries the same facts in words', () => {
        expect(watchSentence(watchFacts(overview()))).toBe('Cansee is watching 2 prompts on 2 of 3 AI engines: ChatGPT and Claude. Not set up: Gemini.')
        expect(watchSentence(watchFacts(overview({ engines: ENGINES.slice(0, 1), prompts: [{}] })))).toBe('Cansee is watching 1 prompt on 1 of 1 AI engine: ChatGPT.')
    })

    it('covers nothing tracked, no engine set up and no engine listed', () => {
        expect(watchSentence(watchFacts(overview({ prompts: [] })))).toBe('Nothing is tracked yet.')
        expect(watchSentence(watchFacts(overview({ engines: ENGINES.map((e) => ({ ...e, configured: false })) })))).toBe('2 prompts tracked, but no AI engine is set up to ask.')
        expect(watchSentence(watchFacts(overview({ engines: [] })))).toBe('Cansee is watching 2 prompts.')
        expect(watchSentence(null)).toBe('')
    })
})

describe('gaze', () => {
    const box = { left: 100, top: 100, width: 200, height: 100 } // centre 200, 150

    it('looks straight ahead at its own centre and for anything unusable', () => {
        expect(gaze({ x: 200, y: 150 }, box)).toEqual({ x: 0, y: 0 })
        expect(gaze(null, box)).toEqual({ x: 0, y: 0 })
        expect(gaze({ x: 10, y: 10 }, null)).toEqual({ x: 0, y: 0 })
        expect(gaze({ x: NaN, y: 10 }, box)).toEqual({ x: 0, y: 0 })
        expect(gaze({ x: 10, y: 10 }, { ...box, width: Infinity })).toEqual({ x: 0, y: 0 })
        expect(gaze({ x: 10, y: 10 }, box, 0)).toEqual({ x: 0, y: 0 })
    })

    it('points toward the pointer, further the further away it is', () => {
        expect(gaze({ x: 290, y: 150 }, box, 360)).toEqual({ x: 0.25, y: 0 })
        expect(gaze({ x: 200, y: 60 }, box, 360)).toEqual({ x: 0, y: -0.25 })
        const near = gaze({ x: 230, y: 190 }, box, 360)
        const far = gaze({ x: 260, y: 230 }, box, 360)
        expect(near.x).toBeGreaterThan(0)
        expect(near.y).toBeGreaterThan(0)
        expect(far.x).toBeGreaterThan(near.x)
        expect(far.y).toBeGreaterThan(near.y)
    })

    it('never looks further than the edge of its reach', () => {
        expect(gaze({ x: 5000, y: 150 }, box, 360)).toEqual({ x: 1, y: 0 })
        const corner = gaze({ x: -5000, y: -5000 }, box, 360)
        expect(Math.hypot(corner.x, corner.y)).toBeLessThanOrEqual(1.01)
        expect(corner.x).toBeLessThan(0)
        expect(corner.y).toBeLessThan(0)
    })

    it('never returns a negative zero', () => {
        const look = gaze({ x: 199.999, y: 150 }, box)
        expect(Object.is(look.x, -0)).toBe(false)
        expect(Object.is(look.y, -0)).toBe(false)
    })
})

describe('gazeText', () => {
    it('prints both axes signed, to two places', () => {
        expect(gazeText({ x: -0.16, y: 0.11 })).toBe('-0.16, +0.11')
        expect(gazeText({ x: 1, y: -1 })).toBe('+1.00, -1.00')
        expect(gazeText({ x: 0, y: -0 })).toBe('+0.00, +0.00')
        expect(gazeText(null)).toBe('+0.00, +0.00')
        expect(gazeText({ x: NaN, y: 'a' })).toBe('+0.00, +0.00')
    })
})
