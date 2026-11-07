import { describe, expect, it } from 'vitest'
import {
    COPY,
    alsoNamed,
    answerStatus,
    askedLine,
    autopilotLine,
    changeCell,
    changeSuffix,
    changeWords,
    endLine,
    engineCell,
    engineColumns,
    engineResult,
    estimateBlocker,
    estimateLine,
    failureLine,
    failureOf,
    googleCell,
    namedCell,
    namedLine,
    normalizeOrder,
    normalizeQuestion,
    orderedRows,
    overCapLine,
    progressLine,
    questionReady,
    questionTooLong,
    rankCell,
    rankingEmpty,
    rankingFoot,
    rankingHeadline,
    rankingItem,
    rankingLists,
    recentRow,
    sourcesText,
    toneWord,
    usdCost,
    usdUpTo,
    whenText,
    withoutLineBreaks,
} from '../specs'
import {
    answerPayload,
    doneRun,
    enginePayload,
    estimatePayload,
    httpError,
    rankedRows,
    rankingPayload,
    rankingRow,
    runPayload,
    runSummary,
} from './__fixtures__/payloads'

describe('the question', () => {
    it('is one line with its spaces collapsed, from 3 to 300 characters', () => {
        expect(normalizeQuestion('  best  crm\n for   startups ')).toBe('best crm for startups')
        expect(withoutLineBreaks('best crm\r\nfor startups\n')).toBe('best crm for startups ')
        expect(questionReady('ab')).toBe(false)
        expect(questionReady(' abc ')).toBe(true)
        expect(questionReady('x'.repeat(300))).toBe(true)
        expect(questionTooLong('x'.repeat(301))).toBe(true)
        expect(questionReady('x'.repeat(301))).toBe(false)
        expect(COPY.tooLong).toBe('Ask one question, up to 300 characters.')
    })
})

describe('the estimate line', () => {
    it('says how many answers and what they may cost against the allowance', () => {
        expect(estimateLine(estimatePayload())).toBe('6 answers, up to $0.48 of your AI allowance ($2.24 left this month).')
        expect(estimateLine(estimatePayload({ answers: 1, usd_max: '0.0800' }))).toBe(
            '1 answer, up to $0.08 of your AI allowance ($2.24 left this month).',
        )
        expect(estimateLine(estimatePayload({ allowance: { unlimited: true, left_usd: null } }))).toBe('6 answers, up to $0.48.')
        expect(estimateLine(null)).toBe('')
    })

    it('rounds an upper bound up to the cent and a cost to the nearest cent', () => {
        expect(usdUpTo('0.4800')).toBe('$0.48')
        expect(usdUpTo('0.0700')).toBe('$0.07')
        expect(usdUpTo('0.0312')).toBe('$0.04')
        expect(usdUpTo('1234.5')).toBe('$1,234.50')
        expect(usdCost('0.0712')).toBe('$0.07')
        expect(usdCost('0.0031')).toBe('<$0.01')
        expect(usdCost('0.0000')).toBe('$0.00')
        expect(usdCost(null)).toBe('')
    })

    it('names the first blocker', () => {
        const blocked = estimatePayload({
            can_run: false,
            blockers: [
                { code: 'daily_limit', message: 'This project used its 100 Ask AI answers for today. Try again tomorrow.' },
                { code: 'run_in_progress', message: 'A question is already being asked for this project.' },
            ],
        })
        expect(estimateBlocker(blocked)).toEqual({
            code: 'daily_limit',
            message: 'This project used its 100 Ask AI answers for today. Try again tomorrow.',
        })
        expect(estimateBlocker(estimatePayload())).toBeNull()
    })
})

describe('a run on the card', () => {
    it('counts the answers that came back or failed while it asks, and how it ended', () => {
        expect(progressLine(runPayload())).toBe('Asking... 2 of 6 answers')
        expect(progressLine(runPayload({ progress: { total: 1, done: 0, failed: 0, running: 1 } }))).toBe('Asking... 0 of 1 answer')
        expect(progressLine(runPayload({ progress: { total: 6, done: 2, failed: 1, running: 1 } }))).toBe('Asking... 3 of 6 answers')
        expect(endLine(runPayload({ status: 'cancelled', progress: { total: 6, done: 2, failed: 1, running: 0 } }))).toBe(
            'Stopped after 3 of 6 answers.',
        )
        expect(endLine(runPayload({ status: 'interrupted', progress: { total: 6, done: 2, failed: 4, running: 0 } }))).toBe(
            'Interrupted after 2 of 6 answers.',
        )
        expect(endLine(doneRun())).toBe('')
    })

    it("reads each engine's share with its likely range, its rank when named and its failures", () => {
        const [chatgpt, claude] = doneRun().engines
        expect(engineResult(claude)).toEqual({
            key: 'claude',
            item: {
                key: 'claude',
                label: 'Claude: named in 2 of 3 answers',
                value: 66.7,
                text: '67%',
                emphasis: true,
                hint: 'Likely 21% to 94%',
            },
            rank: 'Average rank #1.5 when named',
            failures: '',
        })
        // No answer back is a state, never 0%.
        expect(engineResult(chatgpt)).toEqual({
            key: 'chatgpt',
            item: { key: 'chatgpt', label: 'ChatGPT', value: null, text: 'No answers', emphasis: true, hint: '' },
            rank: '',
            failures: '3 answers failed: The engine did not respond in time.',
        })
        expect(engineResult(chatgpt, { active: true }).item.text).toBe('No answers yet')
        expect(engineResult(enginePayload('claude', { answered: 1, named: 1, avg_rank: 2 })).item.label).toBe(
            'Claude: named in 1 of 1 answer',
        )
        expect(engineResult(enginePayload('claude', { avg_rank: 2 })).rank).toBe('Average rank #2 when named')
    })

    it('names the most common failure, and never counts a stopped answer as one', () => {
        const err = (code, message) => answerPayload({ status: 'failed', error: { code, message } })
        expect(
            failureLine([err('timeout', 'Slow.'), err('engine_error', 'Broken.'), err('engine_error', 'Broken.'), answerPayload()]),
        ).toBe('3 answers failed: Broken.')
        expect(failureLine([answerPayload({ status: 'skipped', error: { code: 'daily_limit', message: 'Daily.' } })])).toBe(
            '1 answer failed: Daily.',
        )
        expect(failureLine([answerPayload({ status: 'cancelled', error: { code: 'cancelled', message: 'Stopped before it ran.' } })])).toBe('')
        expect(failureLine([answerPayload({ status: 'failed', error: null })])).toBe('1 answer failed.')
    })
})

describe('a run in the panel', () => {
    it('says when it was asked, how many times per engine and what it cost', () => {
        expect(askedLine(runPayload({ created_at: new Date().toISOString() }))).toBe('Asked just now, 3 per engine, AI $0.07')
    })

    it('reads every answer in words', () => {
        expect(answerStatus(answerPayload({ rank: 2 }))).toBe('Named, rank #2')
        expect(answerStatus(answerPayload({ rank: null }))).toBe('Named')
        expect(answerStatus(answerPayload({ mentioned: false, rank: null }))).toBe('Not named')
        expect(answerStatus(answerPayload({ status: 'failed', error: { code: 'timeout', message: 'The engine did not respond in time.' } }))).toBe(
            'Failed: The engine did not respond in time.',
        )
        expect(answerStatus(answerPayload({ status: 'cancelled' }))).toBe('Stopped')
        expect(answerStatus(answerPayload({ status: 'running' }))).toBe('Asking...')
        expect(answerStatus(answerPayload({ status: 'queued' }))).toBe('Waiting')
        expect(toneWord('positive')).toBe('Positive')
        expect(toneWord('mixed')).toBe('')
        expect(alsoNamed([{ name: 'OneNote', position: 3 }, { name: 'Evernote', position: 1 }, { name: 'Bear', position: null }])).toBe(
            'Also named: Evernote, OneNote, Bear',
        )
        expect(alsoNamed([])).toBe('')
        expect(sourcesText(4)).toBe('4 sources')
        expect(sourcesText(1)).toBe('1 source')
        expect(sourcesText(0)).toBe('0 sources')
        expect(namedLine(doneRun().engines[1])).toBe('Named in 2 of 3 answers')
        expect(namedLine(doneRun().engines[0])).toBe('No answers')
    })

    it('lists a recent question with its day and each engine as {m}/{n}', () => {
        const row = recentRow(doneRun({ id: 'r-9', created_at: '2026-11-03T15:00:00Z' }))
        expect(row.id).toBe('r-9')
        expect(row.text).toBe('best note taking app for small teams')
        expect(row.date).toMatch(/^Nov [34]$/)
        expect(row.engines).toEqual([
            { key: 'chatgpt', text: 'ChatGPT: No answers' },
            { key: 'claude', text: 'Claude: 2/3' },
        ])
    })

    it('reads an API error, with the server words first', () => {
        expect(failureOf(httpError(409, 'estimate_changed', 'The cost changed.', { estimate: { answers: 6 } }))).toEqual({
            status: 409,
            code: 'estimate_changed',
            message: 'The cost changed.',
            details: { estimate: { answers: 6 } },
        })
        expect(failureOf(new Error('offline'))).toMatchObject({ status: 0, code: '', message: COPY.fallbackError })
    })
})

describe('Prompt ranking on the card', () => {
    it('reads a prompt as a bar of its share, {named}/{answers} with the change, and its Google cell', () => {
        expect(rankingItem(rankingRow('p-1'))).toEqual({
            key: 'p-1',
            label: 'prompt p-1',
            value: 85.7,
            text: '12/14 (+14)',
            emphasis: true,
            hint: 'Google #4',
        })
        expect(changeSuffix(-3.2)).toBe(' (-3)')
        expect(changeSuffix(0.3)).toBe(' (0)')
        expect(changeSuffix(null)).toBe('')
        expect(googleCell({ status: 'ok', position: null, depth: 10 })).toBe("Not in Google's top 10")
        expect(googleCell({ status: 'not_checked', position: null, depth: 10 })).toBe('Google not checked')
        expect(googleCell({ status: 'error' })).toBe('Google check failed')
        expect(googleCell(null)).toBe('Google not checked')
    })

    it('splits the ranked prompts into two lists that never share a row', () => {
        const keys = (list) => list.map((item) => item.key)
        expect(rankingLists([])).toEqual({ top: [], weakest: [] })
        expect(keys(rankingLists(rankedRows(1)).top)).toEqual(['p-1'])
        expect(rankingLists(rankedRows(1)).weakest).toEqual([])
        expect(keys(rankingLists(rankedRows(2)).top)).toEqual(['p-1'])
        expect(keys(rankingLists(rankedRows(2)).weakest)).toEqual(['p-2'])
        expect(keys(rankingLists(rankedRows(5)).top)).toEqual(['p-1', 'p-2', 'p-3'])
        expect(keys(rankingLists(rankedRows(5)).weakest)).toEqual(['p-5', 'p-4'])
        const nine = rankingLists(rankedRows(9))
        expect(keys(nine.top)).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5'])
        expect(keys(nine.weakest)).toEqual(['p-9', 'p-8', 'p-7'])
        // Unranked prompts are in neither list.
        const mixed = [...rankedRows(2), rankingRow('p-x', { ranked: false, rank: null, answers: 2 })]
        expect([...keys(rankingLists(mixed).top), ...keys(rankingLists(mixed).weakest)]).toEqual(['p-1', 'p-2'])
    })

    it('says what the shares are and how many prompts need more answers', () => {
        expect(rankingFoot(rankingPayload())).toBe('Share of answers that name you, last 7 days.')
        expect(
            rankingFoot(rankingPayload({ prompts: [rankingRow('p-1'), rankingRow('p-2', { ranked: false }), rankingRow('p-3', { ranked: false })] })),
        ).toBe('Share of answers that name you, last 7 days. 2 prompts need more answers to rank.')
        expect(rankingFoot(rankingPayload({ prompts: [rankingRow('p-1'), rankingRow('p-2', { ranked: false })] }))).toBe(
            'Share of answers that name you, last 7 days. 1 prompt needs more answers to rank.',
        )
        expect(rankingFoot(rankingPayload({ prompts: [] }))).toBe('')
    })

    it('has a state for no prompts and for none ranked', () => {
        expect(rankingEmpty(rankingPayload({ prompts: [] }))).toEqual({ title: 'Track a prompt first.', action: 'Add prompts' })
        expect(rankingEmpty(rankingPayload({ prompts: [rankingRow('p-1', { ranked: false })] }))).toEqual({
            title: 'Prompts are ranked once they have 4 answers in 7 days.',
            action: '',
        })
        expect(rankingEmpty(rankingPayload())).toBeNull()
    })

    it('says when the account tracks more than its plan covers', () => {
        expect(overCapLine({ count: 120, limit: 100, over_limit: 20 })).toBe(
            'You track 120 prompts and your plan covers 100. Autopilot checks the 100 oldest.',
        )
        expect(overCapLine({ count: 9, limit: 100, over_limit: 0 })).toBe('')
        expect(overCapLine({ count: 900, limit: -1, over_limit: 0 })).toBe('')
    })

    it("says what Autopilot did last, when it runs first, or that it is off", () => {
        const now = new Date(2026, 10, 4, 12, 0)
        const at = (day, h, m) => new Date(2026, 10, day, h, m).toISOString()
        expect(autopilotLine({ enabled: true, last_run: runSummary({ finished_at: at(4, 7, 4) }) }, now)).toEqual({
            text: 'Autopilot ran today at 7:04 AM: named in 15 of 18 answers (83%).',
            turnOn: false,
        })
        expect(autopilotLine({ enabled: true, last_run: runSummary({ finished_at: at(3, 7, 4) }) }, now).text).toBe(
            'Autopilot ran yesterday at 7:04 AM: named in 15 of 18 answers (83%).',
        )
        expect(autopilotLine({ enabled: true, last_run: runSummary({ finished_at: at(1, 19, 30) }) }, now).text).toBe(
            'Autopilot ran on Nov 1 at 7:30 PM: named in 15 of 18 answers (83%).',
        )
        // A run with no AI answer measured nothing: no share.
        expect(
            autopilotLine({ enabled: true, last_run: runSummary({ finished_at: at(4, 7, 4), answers: { asked: 0, answered: 0, named: 0, share_pct: null } }) }, now).text,
        ).toBe('Autopilot ran today at 7:04 AM: no AI answers.')
        expect(autopilotLine({ enabled: true, last_run: null, next_run_at: at(5, 7, 0) }, now)).toEqual({
            text: 'Autopilot runs first tomorrow at 7:00 AM.',
            turnOn: false,
        })
        expect(autopilotLine({ enabled: false, last_run: runSummary() }, now)).toEqual({
            text: 'Autopilot is off for this project.',
            turnOn: true,
        })
        expect(autopilotLine(null, now)).toBeNull()
        expect(whenText(at(9, 7, 0), now)).toBe('on Nov 9 at 7:00 AM')
    })
})

describe('Prompt ranking in the panel', () => {
    it('reads the headline, leaving the change out when it was not measured', () => {
        expect(rankingHeadline(rankingPayload().headline)).toBe(
            'Named in 49 of 126 answers in the last 7 days (39%), up 6 pts on the 7 days before.',
        )
        expect(rankingHeadline({ answers: 126, named: 49, share_pct: 38.9, prev_share_pct: null, change_pts: null })).toBe(
            'Named in 49 of 126 answers in the last 7 days (39%).',
        )
        expect(rankingHeadline({ answers: 0, named: 0, share_pct: null, change_pts: null })).toBe('No AI answers in the last 7 days.')
        expect(changeWords(-1.2)).toBe('down 1 pt')
        expect(changeWords(0.4)).toBe('no change')
        expect(changeWords(null)).toBe('')
    })

    it('orders ranked prompts best or weakest first, then the ones that need more answers', () => {
        const rows = [rankingRow('w', { ranked: false, rank: null }), ...rankedRows(3)]
        expect(orderedRows(rows, 'best').map((r) => r.prompt_id)).toEqual(['p-1', 'p-2', 'p-3', 'w'])
        expect(orderedRows(rows, 'weakest').map((r) => r.prompt_id)).toEqual(['p-3', 'p-2', 'p-1', 'w'])
        expect(normalizeOrder('weakest')).toBe('weakest')
        expect(normalizeOrder(['weakest'])).toBe('weakest')
        expect(normalizeOrder('nope')).toBe('best')
        expect(normalizeOrder(undefined)).toBe('best')
    })

    it('reads each cell in words when it was not measured', () => {
        expect(rankCell(rankingRow('p-1', { rank: 3 }))).toBe('3')
        expect(rankCell(rankingRow('p-1', { ranked: false, rank: null }))).toBe('Needs more answers')
        expect(namedCell(rankingRow('p-1'))).toBe('86%, likely 60-96%')
        expect(namedCell(rankingRow('p-1', { answers: 0, named: 0, share_pct: null }))).toBe('No answers')
        expect(changeCell(14.3)).toBe('+14 pts')
        expect(changeCell(-1)).toBe('-1 pt')
        expect(changeCell(0.2)).toBe('0 pts')
        expect(changeCell(null)).toBe('Not measured')
        expect(engineCell({ answers: 7, named: 5 })).toBe('5/7')
        expect(engineCell({ answers: 0, named: 0 })).toBe('No answers')
        expect(engineColumns([rankingRow('p-1'), rankingRow('p-2', { engines: { gemini: { answers: 1, named: 0 } } })])).toEqual([
            { key: 'chatgpt', label: 'ChatGPT' },
            { key: 'claude', label: 'Claude' },
            { key: 'gemini', label: 'Gemini' },
        ])
    })
})
