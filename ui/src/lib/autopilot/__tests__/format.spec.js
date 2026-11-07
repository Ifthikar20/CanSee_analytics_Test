import { describe, expect, it } from 'vitest'
import {
    QUARTER_HOURS,
    clockTime,
    consentNeeded,
    costLines,
    hhmm,
    isActiveRun,
    joinLabels,
    limitedLine,
    planLine,
    runNowSentence,
    runStatusWord,
    shortDate,
    textStatusLine,
    timeZones,
    usd,
} from '../format'
import { runEstimate, settingsPayload } from '@/components/settings/autopilot/__tests__/__fixtures__/autopilot'

const NOW = new Date('2026-11-05T15:00:00Z')

describe('quarter hours and time zones', () => {
    it('lists the 96 quarter hours of a day', () => {
        expect(QUARTER_HOURS).toHaveLength(96)
        expect(QUARTER_HOURS.slice(0, 5)).toEqual(['00:00', '00:15', '00:30', '00:45', '01:00'])
        expect(QUARTER_HOURS.at(-1)).toBe('23:45')
        expect(QUARTER_HOURS).toContain('07:00')
    })

    it('reads server times as HH:MM', () => {
        expect(hhmm('07:00:00')).toBe('07:00')
        expect(hhmm('7:15')).toBe('07:15')
        expect(hhmm('')).toBe('')
        expect(hhmm(null)).toBe('')
    })

    it('puts UTC first and keeps zones the browser does not list', () => {
        const zones = timeZones('Asia/Kolkata', 'Mars/Base')
        expect(zones[0]).toBe('UTC')
        expect(zones.filter((z) => z === 'UTC')).toHaveLength(1)
        expect(zones).toContain('America/New_York')
        expect(zones).toContain('Asia/Kolkata')
        expect(zones).toContain('Mars/Base')
        expect(new Set(zones).size).toBe(zones.length)
    })

    it('falls back to a short list without Intl.supportedValuesOf', () => {
        const original = Intl.supportedValuesOf
        Intl.supportedValuesOf = undefined
        try {
            const zones = timeZones()
            expect(zones[0]).toBe('UTC')
            expect(zones).toContain('Europe/London')
            expect(zones.length).toBeLessThan(30)
        } finally {
            Intl.supportedValuesOf = original
        }
    })
})

describe('words', () => {
    it('names every run status', () => {
        expect(
            ['queued', 'running', 'done', 'partial', 'failed', 'skipped', 'cancelled', 'interrupted'].map(runStatusWord),
        ).toEqual([
            'Waiting to start',
            'Running',
            'Done',
            'Partly done',
            'Failed',
            'Skipped',
            'Stopped',
            'Stopped before it finished',
        ])
        expect(runStatusWord('nope')).toBe('')
        expect(isActiveRun({ status: 'queued' })).toBe(true)
        expect(isActiveRun({ status: 'running' })).toBe(true)
        expect(isActiveRun({ status: 'done' })).toBe(false)
    })

    it('joins engine labels', () => {
        expect(joinLabels([])).toBe('')
        expect(joinLabels(['ChatGPT'])).toBe('ChatGPT')
        expect(joinLabels(['ChatGPT', 'Claude'])).toBe('ChatGPT and Claude')
        expect(joinLabels(['ChatGPT', 'Claude', 'Gemini'])).toBe('ChatGPT, Claude and Gemini')
    })

    it('formats money and calendar dates, and says nothing for unmeasured values', () => {
        expect(usd('1.2700')).toBe('$1.27')
        expect(usd('0.0060')).toBe('$0.0060')
        expect(usd('0.0000')).toBe('$0.00')
        expect(usd('1234.5')).toBe('$1,234.50')
        expect(usd(null)).toBe('')
        expect(usd(undefined)).toBe('')
        expect(shortDate('2026-12-01')).toBe('Dec 1')
        expect(shortDate('2026-11-20')).toBe('Nov 20')
        expect(shortDate(null)).toBe('')
    })

    it('tells the time in the project zone, with the day when it is not today', () => {
        expect(clockTime('2026-11-05T13:02:00Z', 'America/New_York', NOW)).toBe('08:02')
        expect(clockTime('2026-11-04T13:02:00Z', 'America/New_York', NOW)).toBe('Nov 4, 08:02')
        expect(clockTime('2026-11-05T13:02:00Z', 'Not/AZone', NOW)).toBe('13:02')
        expect(clockTime('', 'UTC', NOW)).toBe('')
    })
})

describe('textStatusLine', () => {
    const line = (text) => textStatusLine(text, 'America/New_York', NOW)

    it('says when the text went or when it will', () => {
        expect(line({ status: 'sent', sent_at: '2026-11-05T13:00:05Z' })).toBe('Sent at 08:00')
        expect(line({ status: 'waiting', due_at: '2026-11-05T21:30:00Z' })).toBe('Waiting for quiet hours to end (16:30)')
        expect(line({ status: 'waiting', due_at: '2026-11-06T13:00:00Z' })).toBe('Waiting for quiet hours to end (Nov 6, 08:00)')
        // Due already: it goes out on the next tick, there is nothing to wait for.
        expect(line({ status: 'waiting', due_at: '2026-11-05T14:00:00Z' })).toBe('')
        expect(line({ status: 'failed' })).toBe("Couldn't send the text.")
    })

    it('gives every skip reason its words', () => {
        const skipped = (reason) => line({ status: 'skipped', reason })
        expect(skipped('opted_out')).toBe('Not sent: this number texted STOP.')
        expect(skipped('consent_needed')).toBe('Not sent: agree to the daily text again for this number.')
        expect(skipped('superseded')).toBe("Not sent: a newer run's text replaced it.")
        expect(skipped('unavailable')).toBe("Not sent: text messages aren't set up on this server.")
        expect(skipped('no_access')).toBe("Not sent: the number's owner can no longer open this project.")
        expect(skipped('notice_sent')).toBe('')
    })

    it('says nothing when no text was asked for', () => {
        expect(line({ status: 'not_requested' })).toBe('')
        expect(line({ status: 'sending' })).toBe('')
        expect(line(null)).toBe('')
    })
})

describe('planLine', () => {
    it('reads the plan, over the plan and unlimited', () => {
        expect(planLine({ limit: 100, used: 9 })).toBe('Your plan covers 100 tracked prompts; this account tracks 9.')
        expect(planLine({ limit: 100, used: 140 })).toBe(
            'This account tracks 140 prompts and your plan covers 100. Autopilot checks the 100 oldest.',
        )
        expect(planLine({ limit: -1, used: 9 })).toBe('This account tracks 9 prompts.')
        expect(planLine({ limit: -1, used: 1 })).toBe('This account tracks 1 prompt.')
        expect(planLine({ limit: 100, used: 0 })).toBe('Your plan covers 100 tracked prompts; this account tracks 0.')
        expect(planLine(null)).toBe('')
    })
})

describe('costLines', () => {
    it('reads the last run and the month it projects', () => {
        expect(costLines(settingsPayload())).toEqual([
            'Last run: 200 answers, $1.27 of AI, 100 Google pages (2,500 ScraperAPI credits).',
            'At this rate a month of daily runs costs about $38.10 of AI. Your plan includes $52.00.',
            'Autopilot stops for the month when 90% of your AI allowance is used, so the rest stays free for your own questions.',
        ])
    })

    it('says when the allowance runs out, and leaves out credits it did not measure', () => {
        const payload = settingsPayload({
            cost: { runs_out_on: '2026-11-20', last_run: { ai_usd: '1.2700', answers: 200, google_pages: 100, credits: null } },
        })
        expect(costLines(payload)).toEqual([
            'Last run: 200 answers, $1.27 of AI, 100 Google pages.',
            'At this rate a month of daily runs costs about $38.10 of AI. Your plan includes $52.00.',
            'At this rate the allowance runs out around Nov 20. Autopilot then pauses until Dec 1.',
            'Autopilot stops for the month when 90% of your AI allowance is used, so the rest stays free for your own questions.',
        ])
    })

    it('gives the bound before the first run', () => {
        const payload = settingsPayload({ cost: { last_run: null, month_projection_usd: null } })
        expect(costLines(payload)).toEqual([
            'The first run measures the real cost. Each run costs at most $6.00 of AI and 100 Google pages.',
            'Autopilot stops for the month when 90% of your AI allowance is used, so the rest stays free for your own questions.',
        ])
    })

    it('has no reserve or plan amount with an unlimited allowance', () => {
        const payload = settingsPayload({ allowance: { unlimited: true, cap_usd: null, reserve_pct: 10 } })
        expect(costLines(payload)).toEqual([
            'Last run: 200 answers, $1.27 of AI, 100 Google pages (2,500 ScraperAPI credits).',
            'At this rate a month of daily runs costs about $38.10 of AI.',
        ])
    })
})

describe('consentNeeded', () => {
    const saved = (on, id) => ({ sms_digest: on, sms_subscription_id: id })
    it('asks when the text turns on or its number changes while on', () => {
        expect(consentNeeded({ sms_digest: true, sms_subscription_id: 'a' }, saved(false, null))).toBe(true)
        expect(consentNeeded({ sms_digest: true, sms_subscription_id: 'a' }, saved(false, 'a'))).toBe(true)
        expect(consentNeeded({ sms_digest: true, sms_subscription_id: 'b' }, saved(true, 'a'))).toBe(true)
        expect(consentNeeded({ sms_digest: true, sms_subscription_id: 'a' }, saved(true, 'a'))).toBe(false)
        expect(consentNeeded({ sms_digest: false, sms_subscription_id: 'a' }, saved(true, 'a'))).toBe(false)
    })
})

describe('Run now words', () => {
    it('names what the run does', () => {
        expect(runNowSentence(runEstimate())).toBe(
            "Checks 9 prompts with ChatGPT and Claude, then Google page one, then analyzes new answers. This counts as today's run.",
        )
        expect(runNowSentence(runEstimate({ pages_max: 0 }), { analysis: false })).toBe(
            "Checks 9 prompts with ChatGPT and Claude. This counts as today's run.",
        )
        expect(runNowSentence(runEstimate({ prompts: 1, engines: [{ key: 'claude', label: 'Claude' }] }))).toBe(
            "Checks 1 prompt with Claude, then Google page one, then analyzes new answers. This counts as today's run.",
        )
        expect(runNowSentence(runEstimate({ engines: [] }))).toBe("Checks 9 prompts on Google page one. This counts as today's run.")
    })

    it('says when the allowance fits fewer prompts', () => {
        expect(limitedLine(runEstimate())).toBe('')
        expect(limitedLine(runEstimate({ limited_by: 'allowance', prompts: 6 }))).toBe(
            'Only 6 prompts fit in your allowance today; the rest wait for the next run.',
        )
        expect(limitedLine(runEstimate({ limited_by: 'allowance', prompts: 1 }))).toBe(
            'Only 1 prompt fits in your allowance today; the rest wait for the next run.',
        )
    })
})
