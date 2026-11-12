import { describe, expect, it } from 'vitest'
import { bucketLabel, scoreChange, scoreFigure, scoreLine, scoreSentence, scoreWindow } from '../visibilityScore'

const BUCKETS = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
const payload = (series = [10, 20, 40, 30, 20], headline = { visibility_pct: 34.2, visibility_prev_pct: 30.1 }, window = {}) => ({
    window: { period: '30d', interval: 'day', buckets: BUCKETS, ...window },
    headline,
    visibility: { all: { visibility_pct: series } },
})

describe('scoreFigure', () => {
    it('is the dashboard headline, as a percent', () => {
        expect(scoreFigure(payload())).toEqual({ value: 34.2, figure: '34', unit: '%', exact: '34%' })
    })

    it('is null when the share was not measured', () => {
        for (const bad of [null, undefined, '34', NaN, Infinity]) expect(scoreFigure(payload([], { visibility_pct: bad })), String(bad)).toBeNull()
        expect(scoreFigure(null)).toBeNull()
        expect(scoreFigure({})).toBeNull()
    })

    it('keeps the figure to three characters: whole from 10, one decimal below', () => {
        const figure = (v) => scoreFigure(payload([], { visibility_pct: v })).figure
        expect(figure(0)).toBe('0')
        expect(figure(0.44)).toBe('0.4')
        expect(figure(6.5)).toBe('6.5')
        expect(figure(7)).toBe('7')
        expect(figure(9.94)).toBe('9.9')
        expect(figure(9.96)).toBe('10')
        expect(figure(10.4)).toBe('10')
        expect(figure(99.6)).toBe('100')
        expect(figure(100)).toBe('100')
        for (const v of [0, 0.05, 3.33, 9.99, 12.5, 55.55, 100]) expect(figure(v).length, v).toBeLessThanOrEqual(3)
    })

    it('measures a true zero as zero, never as nothing', () => {
        expect(scoreFigure(payload([], { visibility_pct: 0 }))).toMatchObject({ value: 0, figure: '0', exact: '0%' })
    })
})

describe('scoreWindow and scoreChange', () => {
    it('names the window the payload reads', () => {
        expect(scoreWindow(payload())).toBe('Last 30 days')
        expect(scoreWindow(payload([], {}, { period: '90d' }))).toBe('Last 90 days')
        expect(scoreWindow(null)).toBe('Last 30 days')
    })

    it('compares with the window before, in points', () => {
        expect(scoreChange(payload())).toEqual({ value: 4.1, direction: 'up', text: '+4.1 pts', label: 'vs previous 30 days' })
        expect(scoreChange(payload([], { visibility_pct: 20, visibility_prev_pct: 26.5 }))).toMatchObject({ value: -6.5, direction: 'down' })
        expect(scoreChange(payload([], { visibility_pct: 20, visibility_prev_pct: 20.04 }))).toMatchObject({ value: 0, direction: 'flat', text: '0 pts' })
    })

    it('shows no change when either side is unknown', () => {
        expect(scoreChange(payload([], { visibility_pct: 20, visibility_prev_pct: null }))).toBeNull()
        expect(scoreChange(payload([], { visibility_pct: null, visibility_prev_pct: 20 }))).toBeNull()
        expect(scoreChange(payload([], { visibility_pct: 20 }))).toBeNull()
        expect(scoreChange(null)).toBeNull()
    })
})

describe('bucketLabel', () => {
    it('prints a date as an axis label, in UTC', () => {
        expect(bucketLabel('2026-10-06')).toBe('Oct 06')
        expect(bucketLabel('2026-11-12')).toBe('Nov 12')
        expect(bucketLabel('2026-01-01T23:30:00-05:00')).toBe('Jan 02')
    })

    it('is empty for anything that is not a date', () => {
        for (const bad of ['', null, undefined, 'soon', '2026-13-45']) expect(bucketLabel(bad), String(bad)).toBe('')
    })
})

describe('scoreLine', () => {
    it('is null when no bucket was measured', () => {
        expect(scoreLine(null)).toBeNull()
        expect(scoreLine({})).toBeNull()
        expect(scoreLine(payload([]))).toBeNull()
        expect(scoreLine(payload([null, null, null, null, null]))).toBeNull()
        expect(scoreLine(payload('nope'))).toBeNull()
        expect(scoreLine(payload([1, 2, 3], undefined, { buckets: [] }))).toBeNull()
    })

    it('spreads the buckets left to right and scales to the highest reading, zero at the bottom', () => {
        const line = scoreLine(payload())
        expect(line.points.map((p) => [p.x, p.y])).toEqual([[0, 75], [25, 50], [50, 0], [75, 25], [100, 50]])
        expect(line.lines).toEqual(['M0 75 L25 50 L50 0 L75 25 L100 50'])
        expect(line.singles).toEqual([])
        expect(line.end).toMatchObject({ x: 100, y: 50, value: 20, label: 'Nov 05' })
        expect(line).toMatchObject({ from: 'Nov 01', to: 'Nov 05', low: 10, high: 40, top: 40 })
    })

    it('leaves a gap where a bucket has no answers, never a zero', () => {
        const line = scoreLine(payload([10, 20, null, 30, 40]))
        expect(line.lines).toEqual(['M0 75 L25 50', 'M75 25 L100 0'])
        expect(line.points).toHaveLength(4)
        expect(line.points.some((p) => p.x === 50)).toBe(false)
    })

    it('ends where the last reading is, not at the last bucket', () => {
        const line = scoreLine(payload([10, 20, 40, null, null]))
        expect(line.end).toMatchObject({ x: 50, y: 0, value: 40, label: 'Nov 03' })
        expect(line.to).toBe('Nov 05')
    })

    it('marks a reading with no measured neighbour as a single point, except the end', () => {
        const line = scoreLine(payload([10, null, 20, null, 40]))
        expect(line.lines).toEqual([])
        expect(line.singles.map((p) => p.x)).toEqual([0, 50])
        expect(line.end.x).toBe(100)
        const tail = scoreLine(payload([null, 10, null, 20, 40]))
        expect(tail.singles.map((p) => p.x)).toEqual([25])
        expect(tail.lines).toEqual(['M75 50 L100 0'])
    })

    it('draws one reading as the end dot alone', () => {
        const line = scoreLine(payload([null, null, 12, null, null]))
        expect(line.lines).toEqual([])
        expect(line.singles).toEqual([])
        expect(line.end).toMatchObject({ x: 50, y: 0, value: 12 })
        // One bucket in the whole window sits at the right edge: it is the latest.
        expect(scoreLine(payload([12], undefined, { buckets: ['2026-11-05'] })).end).toMatchObject({ x: 100, y: 0 })
    })

    it('keeps a line of zeros on the baseline', () => {
        const line = scoreLine(payload([0, 0, 0, 0, 0]))
        expect(line.points.every((p) => p.y === 100)).toBe(true)
        expect(line).toMatchObject({ low: 0, high: 0, top: 1 })
    })

    it('ignores values that are not finite numbers and extra values past the buckets', () => {
        const line = scoreLine(payload([10, 'x', NaN, Infinity, 20, 99, 99]))
        expect(line.points.map((p) => p.value)).toEqual([10, 20])
        expect(line.high).toBe(20)
        for (const p of line.points) {
            expect(p.x).toBeGreaterThanOrEqual(0)
            expect(p.x).toBeLessThanOrEqual(100)
            expect(p.y).toBeGreaterThanOrEqual(0)
            expect(p.y).toBeLessThanOrEqual(100)
        }
    })

    it('stays in the box for a long series', () => {
        const buckets = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10))
        const series = buckets.map((_, i) => (i * 37) % 101)
        const line = scoreLine(payload(series, undefined, { buckets }))
        expect(line.points).toHaveLength(90)
        expect(line.lines).toHaveLength(1)
        expect(Math.min(...line.points.map((p) => p.y))).toBe(0)
        expect(Math.max(...line.points.map((p) => p.y))).toBe(100)
        expect(line.points.at(-1).x).toBe(100)
    })
})

describe('scoreSentence', () => {
    it('says the figure, its change and the range of the line', () => {
        expect(scoreSentence(payload())).toBe(
            'AI named you in 34% of answers over the last 30 days, up 4.1 points on the period before. Between Nov 01 and Nov 05 it ranged from 10% to 40%; the latest reading is 20% on Nov 05.',
        )
    })

    it('covers a fall, no change, one point and no earlier period', () => {
        expect(scoreSentence(payload([20], { visibility_pct: 20, visibility_prev_pct: 21 }, { buckets: ['2026-11-05'] }))).toBe(
            'AI named you in 20% of answers over the last 30 days, down 1 point on the period before. One reading so far: 20% on Nov 05.',
        )
        expect(scoreSentence(payload([], { visibility_pct: 20, visibility_prev_pct: 20 }))).toBe('AI named you in 20% of answers over the last 30 days, the same as the period before.')
        expect(scoreSentence(payload([], { visibility_pct: 20 }))).toBe('AI named you in 20% of answers over the last 30 days.')
    })

    it('is empty when there is no figure', () => {
        expect(scoreSentence(payload([1, 2], { visibility_pct: null }))).toBe('')
        expect(scoreSentence(null)).toBe('')
    })
})
