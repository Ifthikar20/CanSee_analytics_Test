import { describe, expect, it } from 'vitest'
import { answerGap, answerSentence, askedAnswered, namedSummary, rowSentence, rowValue, youSegment } from '../askedAnswered'

const ENGINES = [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
    { key: 'gemini', label: 'Gemini', configured: true },
    { key: 'grok', label: 'Grok', configured: false },
]
const cell = (fields = {}) => ({ configured: true, answers: 3, mentioned: false, rank: null, ...fields })
const prompt = (id, text, engines, fields = {}) => ({ prompt_id: id, text, location: 'us', engines, ...fields })
const ANSWERED = { chatgpt: cell({ mentioned: true, rank: 2 }), claude: cell(), gemini: cell({ answers: 0 }), grok: cell({ configured: false, answers: 0 }) }
const SILENT = { chatgpt: cell({ answers: 0 }), claude: cell({ answers: 0 }), gemini: cell({ answers: 0 }), grok: cell({ configured: false, answers: 0 }) }
const overview = (prompts, engines = ENGINES) => ({ engines, prompts })

describe('askedAnswered', () => {
    it('is null when nothing is tracked', () => {
        expect(askedAnswered(null)).toBeNull()
        expect(askedAnswered({})).toBeNull()
        expect(askedAnswered(overview([]))).toBeNull()
        expect(askedAnswered(overview([null, { prompt_id: 'x', text: '   ' }, { prompt_id: 'y' }]))).toBeNull()
    })

    it('shows the one prompt, with each engine that is set up or has answered', () => {
        expect(askedAnswered(overview([prompt('p1', ' best note app? ', ANSWERED)]))).toEqual({
            id: 'p1',
            text: 'best note app?',
            location: 'US',
            rows: [
                { key: 'chatgpt', label: 'ChatGPT', state: 'named', rank: 2 },
                { key: 'claude', label: 'Claude', state: 'absent', rank: null },
                { key: 'gemini', label: 'Gemini', state: 'waiting', rank: null },
            ],
            answered: 2,
            named: 1,
            newest: true,
        })
    })

    it('takes the newest prompt (the last tracked) when it has answers', () => {
        const block = askedAnswered(overview([prompt('old', 'old question', ANSWERED), prompt('new', 'new question', ANSWERED)]))
        expect(block.id).toBe('new')
        expect(block.newest).toBe(true)
    })

    it('steps back to the newest prompt that has answers, and says it is not the newest', () => {
        const block = askedAnswered(overview([prompt('a', 'first', ANSWERED), prompt('b', 'second', ANSWERED), prompt('c', 'third', SILENT)]))
        expect(block.id).toBe('b')
        expect(block.newest).toBe(false)
        expect(block.answered).toBe(2)
    })

    it('shows the newest prompt, waiting, when no prompt has answers', () => {
        const block = askedAnswered(overview([prompt('a', 'first', SILENT), prompt('b', 'second', SILENT)]))
        expect(block.id).toBe('b')
        expect(block.newest).toBe(true)
        expect(block.answered).toBe(0)
        expect(block.named).toBe(0)
        expect(block.rows.map((r) => r.state)).toEqual(['waiting', 'waiting', 'waiting'])
    })

    it('keeps an engine that answered even if it is no longer set up', () => {
        const engines = { ...SILENT, grok: cell({ configured: false, answers: 2, mentioned: true, rank: 1 }) }
        const block = askedAnswered(overview([prompt('a', 'q', engines)]))
        expect(block.rows.at(-1)).toEqual({ key: 'grok', label: 'Grok', state: 'named', rank: 1 })
        expect(block.answered).toBe(1)
    })

    it('has no rows when no engine is set up', () => {
        const off = ENGINES.map((e) => ({ ...e, configured: false }))
        const cells = Object.fromEntries(off.map((e) => [e.key, cell({ configured: false, answers: 0 })]))
        expect(askedAnswered(overview([prompt('a', 'q', cells)], off)).rows).toEqual([])
    })

    it('only gives a rank to a named row, as a whole place from 1', () => {
        const engines = {
            chatgpt: cell({ mentioned: true, rank: 0 }),
            claude: cell({ mentioned: false, rank: 3 }),
            gemini: cell({ mentioned: true, rank: 2.6 }),
            grok: cell({ configured: false, answers: 1, mentioned: true, rank: NaN }),
        }
        expect(askedAnswered(overview([prompt('a', 'q', engines)])).rows.map((r) => [r.state, r.rank])).toEqual([
            ['named', null],
            ['absent', null],
            ['named', 3],
            ['named', null],
        ])
    })

    it('reads missing fields without failing', () => {
        const bare = askedAnswered(overview([{ prompt_id: 7, text: 'q' }]))
        expect(bare).toMatchObject({ id: '7', text: 'q', location: '', answered: 0, named: 0 })
        expect(bare.rows.map((r) => r.state)).toEqual(['waiting', 'waiting', 'waiting'])
        expect(askedAnswered({ prompts: [{ text: 'q' }] })).toMatchObject({ id: '', rows: [] })
        // No engine list: the prompt's own cells name the engines.
        const own = askedAnswered({ prompts: [prompt('a', 'q', { chatgpt: cell({ mentioned: true }), grok: cell({ configured: false, answers: 0 }) })] })
        expect(own.rows).toEqual([{ key: 'chatgpt', label: 'chatgpt', state: 'named', rank: null }])
        // Answers that are not a number count as none.
        expect(askedAnswered(overview([prompt('a', 'q', { chatgpt: cell({ answers: '3', mentioned: true }) })])).rows[0].state).toBe('waiting')
    })
})

describe('answerGap', () => {
    it('is null once an engine has answered', () => {
        expect(answerGap(askedAnswered(overview([prompt('a', 'q', ANSWERED)])))).toBeNull()
        expect(answerGap(null)).toBeNull()
    })

    it('asks for setup when no engine can answer, and waits otherwise', () => {
        expect(answerGap({ rows: [], answered: 0 })).toEqual({ kind: 'not_connected', title: 'No AI engine is set up to answer yet.' })
        const waiting = answerGap(askedAnswered(overview([prompt('a', 'q', SILENT)])))
        expect(waiting.kind).toBe('empty')
        expect(waiting.title).toMatch(/No engine has answered this yet/)
    })
})

describe('the words of an answer', () => {
    const block = askedAnswered(overview([prompt('a', 'q', { ...ANSWERED, gemini: cell({ mentioned: true, rank: null }) })]))

    it('counts who named you among those who answered', () => {
        expect(namedSummary(block)).toBe('You in 2 of 3')
        expect(namedSummary(askedAnswered(overview([prompt('a', 'q', SILENT)])))).toBe('')
        expect(namedSummary(null)).toBe('')
    })

    it('gives each row a short value and a full sentence', () => {
        expect(block.rows.map(rowValue)).toEqual(['#2', 'Not named', 'Named'])
        expect(block.rows.map(rowSentence)).toEqual([
            'ChatGPT named you, at number 2 of the brands in its answer.',
            'Claude did not name you.',
            'Gemini named you.',
        ])
        const waiting = { key: 'x', label: 'Grok', state: 'waiting', rank: null }
        expect(rowValue(waiting)).toBe('No answer yet')
        expect(rowSentence(waiting)).toBe('Grok has not answered yet.')
        expect(rowValue(null)).toBe('No answer yet')
        expect(rowSentence(null)).toBe('This engine has not answered yet.')
    })

    it('sums the answer up in a sentence', () => {
        expect(answerSentence(block)).toBe('ChatGPT and Gemini named you. Claude did not.')
        expect(answerSentence(askedAnswered(overview([prompt('a', 'q', { chatgpt: cell() })], ENGINES.slice(0, 1))))).toBe('ChatGPT did not.')
        expect(answerSentence(askedAnswered(overview([prompt('a', 'q', SILENT)])))).toBe('')
        expect(answerSentence(null)).toBe('')
    })
})

describe('youSegment', () => {
    const named = (rank) => ({ state: 'named', rank })

    it('draws nothing unless the answer named you', () => {
        expect(youSegment({ state: 'absent', rank: null })).toBeNull()
        expect(youSegment({ state: 'waiting', rank: null })).toBeNull()
        expect(youSegment(null)).toBeNull()
    })

    it('sits further left the earlier you are named, and stays on the bar', () => {
        expect(youSegment(named(1))).toEqual({ left: 0, width: 22 })
        expect(youSegment(named(2)).left).toBeGreaterThan(youSegment(named(1)).left)
        expect(youSegment(named(3)).left).toBeGreaterThan(youSegment(named(2)).left)
        for (const rank of [1, 2, 5, 7, 8, 40, 1000]) {
            const s = youSegment(named(rank))
            expect(s.left, rank).toBeGreaterThanOrEqual(0)
            expect(s.left + s.width, rank).toBeLessThanOrEqual(100)
        }
        expect(youSegment(named(40))).toEqual(youSegment(named(7)))
    })

    it('sits in the middle when the engine gave no order', () => {
        const s = youSegment(named(null))
        expect(s.left + s.width / 2).toBe(50)
    })
})
