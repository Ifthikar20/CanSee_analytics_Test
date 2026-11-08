import { describe, expect, it } from 'vitest'
import {
    estimateRuns,
    hidesUsd,
    isRunsError,
    meteredRuns,
    normalizeRuns,
    renewDate,
    renewSentence,
    runsErrorText,
    runsLeftText,
    runsNeeded,
    runsUsedText,
} from '../promptRuns'

// The runs block as GET billing/prompt-runs/ and agent/status/ send it.
const FREE = {
    unlimited: false,
    limit: 20,
    used: 7,
    reserved: 0,
    remaining: 13,
    plan: 'free',
    scope: 'account',
    period_start: '2026-11-01T00:00:00+00:00',
    resets_at: '2026-11-30T23:59:59+00:00',
    by_engine: { chatgpt: 4, claude: 3 },
    by_feature: { audit: 7 },
}
const PAID = { ...FREE, unlimited: true, limit: null, remaining: null, plan: 'prompts_100' }

describe('normalizeRuns', () => {
    it('reads a metered block', () => {
        expect(normalizeRuns(FREE)).toEqual({
            unlimited: false,
            limit: 20,
            used: 7,
            reserved: 0,
            remaining: 13,
            resetsAt: '2026-11-30T23:59:59+00:00',
        })
    })

    it('reads an unlimited block with no limit and no remaining', () => {
        expect(normalizeRuns(PAID)).toMatchObject({ unlimited: true, limit: null, remaining: null })
    })

    it('works out what is left when remaining is missing, never below zero', () => {
        expect(normalizeRuns({ unlimited: false, limit: 20, used: 15, reserved: 2 }).remaining).toBe(3)
        expect(normalizeRuns({ unlimited: false, limit: 20, used: 25 }).remaining).toBe(0)
    })

    it.each([
        ['nothing', undefined],
        ['null', null],
        ['a string', 'free'],
        ['no unlimited flag', { limit: 20, remaining: 3 }],
        ['a metered block with neither limit nor remaining', { unlimited: false }],
        ['non-numeric counts', { unlimited: false, limit: 'many', remaining: 'some' }],
    ])('gives null for %s', (_, raw) => {
        expect(normalizeRuns(raw)).toBeNull()
    })

    it('clamps negative and fractional counts', () => {
        expect(normalizeRuns({ unlimited: false, limit: 20.7, remaining: -3, used: -1 })).toMatchObject({
            limit: 20,
            remaining: 0,
            used: 0,
        })
    })

    it('meteredRuns keeps only metered blocks', () => {
        expect(meteredRuns(FREE)?.remaining).toBe(13)
        expect(meteredRuns(PAID)).toBeNull()
        expect(meteredRuns(null)).toBeNull()
    })
})

describe('hidesUsd', () => {
    it('hides dollars when status says show_usd is false', () => {
        expect(hidesUsd({ allowance: { cap_usd: 3, show_usd: false } })).toBe(true)
    })

    it('hides dollars when the runs block is metered, even without show_usd', () => {
        expect(hidesUsd({ allowance: { cap_usd: 3 }, prompt_runs: FREE })).toBe(true)
    })

    it('keeps dollars for paid accounts and for payloads that say nothing', () => {
        expect(hidesUsd({ allowance: { cap_usd: 30, show_usd: true }, prompt_runs: PAID })).toBe(false)
        expect(hidesUsd({ allowance: { cap_usd: 30 } })).toBe(false)
        expect(hidesUsd(null)).toBe(false)
        expect(hidesUsd('x')).toBe(false)
    })
})

describe('words', () => {
    it('says how many runs are left, in the singular for one', () => {
        expect(runsLeftText(FREE)).toBe('13 free prompt runs left')
        expect(runsLeftText({ ...FREE, remaining: 1 })).toBe('1 free prompt run left')
        expect(runsLeftText({ ...FREE, remaining: 0 })).toBe('No free prompt runs left')
    })

    it('says nothing for paid or unknown accounts', () => {
        expect(runsLeftText(PAID)).toBe('')
        expect(runsLeftText(null)).toBe('')
        expect(runsUsedText(PAID)).toBe('')
    })

    it('accepts a block normalizeRuns already made', () => {
        expect(runsLeftText(normalizeRuns(FREE))).toBe('13 free prompt runs left')
        expect(runsLeftText(normalizeRuns(PAID))).toBe('')
    })

    it('says how many are used out of the limit', () => {
        expect(runsUsedText(FREE)).toBe('7 of 20 free prompt runs used')
        expect(runsUsedText({ ...FREE, limit: 1, used: 1 })).toBe('1 of 1 free prompt run used')
        expect(runsUsedText({ unlimited: false, remaining: 4 })).toBe('')
    })

    it('names the renewal day in UTC', () => {
        expect(renewDate('2026-11-30T23:59:59+00:00')).toBe('November 30')
        // Late on the 30th in New York is already December 1 in UTC.
        expect(renewDate('2026-11-30T23:30:00-05:00')).toBe('December 1')
        expect(renewDate('not a date')).toBe('')
        expect(renewDate(null)).toBe('')
        expect(renewSentence(normalizeRuns(FREE))).toBe('They renew on November 30.')
        expect(renewSentence({ resets_at: '' })).toBe('')
    })
})

describe('runsNeeded', () => {
    it('says what a run uses when enough are left', () => {
        expect(runsNeeded(6, FREE)).toEqual({ enough: true, text: 'Uses 6 of your 13 free prompt runs left.' })
        expect(runsNeeded(13, FREE).enough).toBe(true)
    })

    it('says it is too many, one past the limit', () => {
        expect(runsNeeded(14, FREE)).toEqual({
            enough: false,
            text: 'This needs 14 free prompt runs and 13 of your 20 are left this month. Choose fewer prompts or engines.',
        })
        expect(runsNeeded(2, { ...FREE, remaining: 1 }).text).toBe(
            'This needs 2 free prompt runs and 1 of your 20 is left this month. Choose fewer prompts or engines.',
        )
    })

    it('says they are used up, with the renewal day', () => {
        expect(runsNeeded(1, { ...FREE, remaining: 0 })).toEqual({
            enough: false,
            text: "You have used this month's 20 free prompt runs. They renew on November 30.",
        })
    })

    it('gives null for paid accounts, unknown blocks and zero needed', () => {
        expect(runsNeeded(6, PAID)).toBeNull()
        expect(runsNeeded(6, null)).toBeNull()
        expect(runsNeeded(0, FREE)).toBeNull()
        expect(runsNeeded('x', FREE)).toBeNull()
    })
})

describe('estimateRuns', () => {
    const block = { needed: 6, remaining: 13, limit: 20, unlimited: false, enough: true, resets_at: FREE.resets_at }

    it('reads the estimate block', () => {
        expect(estimateRuns(block)).toEqual({ enough: true, text: 'Uses 6 of your 13 free prompt runs left.' })
        expect(estimateRuns({ ...block, needed: 20, enough: false }).enough).toBe(false)
    })

    it("lets the server's enough win", () => {
        expect(estimateRuns({ ...block, enough: false }).enough).toBe(false)
    })

    it('gives null for unlimited and missing blocks', () => {
        expect(estimateRuns({ ...block, unlimited: true, remaining: null, limit: null })).toBeNull()
        expect(estimateRuns(null)).toBeNull()
        expect(estimateRuns({ needed: 6 })).toBeNull()
    })
})

describe('runsErrorText', () => {
    it('knows only the two runs codes', () => {
        expect(isRunsError('prompt_runs_exhausted')).toBe(true)
        expect(isRunsError('insufficient_prompt_runs')).toBe(true)
        expect(isRunsError('allowance_exceeded')).toBe(false)
        expect(runsErrorText('allowance_exceeded', { message: 'x' })).toBe('')
    })

    it("uses the server's message when there is one", () => {
        expect(runsErrorText('prompt_runs_exhausted', { message: "  You have used this month's 20 free prompt runs.  " })).toBe(
            "You have used this month's 20 free prompt runs.",
        )
    })

    it('builds the words from the details otherwise', () => {
        const details = { needed: 6, remaining: 4, limit: 20, resets_at: FREE.resets_at }
        expect(runsErrorText('insufficient_prompt_runs', { details })).toBe(
            'This needs 6 free prompt runs and 4 of your 20 are left this month. Choose fewer prompts or engines.',
        )
        expect(runsErrorText('prompt_runs_exhausted', { details: { ...details, remaining: 0 } })).toBe(
            "You have used this month's 20 free prompt runs. They renew on November 30.",
        )
    })

    it('falls back to plain words without details, or with details that do not add up', () => {
        expect(runsErrorText('prompt_runs_exhausted')).toBe("This month's free prompt runs are used up.")
        expect(runsErrorText('insufficient_prompt_runs', { details: { needed: 2, remaining: 9, limit: 20 } })).toBe(
            'Not enough free prompt runs are left this month.',
        )
    })
})
