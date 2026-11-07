import { describe, expect, it } from 'vitest'
import { countryName, formatDateLabel, formatDelta, formatTick, formatValue, toNumber } from '@/lib/charts/format'

describe('formatValue', () => {
  it('returns null for values that were not measured', () => {
    expect(formatValue(null)).toBe(null)
    expect(formatValue(undefined, { value: 'percent' })).toBe(null)
    expect(formatValue('', { value: 'count' })).toBe(null)
    expect(formatValue(Number.NaN)).toBe(null)
    expect(formatValue('abc')).toBe(null)
    expect(formatValue(true)).toBe(null)
  })

  it('formats percents with one decimal under 10', () => {
    expect(formatValue(42, { value: 'percent' })).toBe('42%')
    expect(formatValue(42.4, { value: 'percent' })).toBe('42%')
    expect(formatValue(4.5, { value: 'percent' })).toBe('4.5%')
    expect(formatValue(0, { value: 'percent' })).toBe('0%')
    expect(formatValue(100, { value: 'percent' })).toBe('100%')
  })

  it('formats counts with separators, compact on request', () => {
    expect(formatValue(1204, { value: 'count' })).toBe('1,204')
    expect(formatValue(0, { value: 'count' })).toBe('0')
    expect(formatValue(12900, { value: 'count', compact: true })).toBe('12.9K')
    expect(formatValue(999, { value: 'count', compact: true })).toBe('999')
  })

  it('formats ranks with a hash and their decimals', () => {
    expect(formatValue(4, { value: 'rank' })).toBe('#4')
    expect(formatValue(3.2, { value: 'rank' })).toBe('#3.2')
    expect(formatValue(5.25, { value: 'rank' })).toBe('#5.3')
  })

  it('formats dollars with four decimals under one cent', () => {
    expect(formatValue(0.42, { value: 'usd' })).toBe('$0.42')
    expect(formatValue(0.0042, { value: 'usd' })).toBe('$0.0042')
    expect(formatValue(0, { value: 'usd' })).toBe('$0.00')
    expect(formatValue('0.4000', { value: 'usd' })).toBe('$0.40')
    expect(formatValue(4200000, { value: 'usd', compact: true })).toBe('$4.2M')
  })

  it('formats plain numbers with the unit', () => {
    expect(formatValue(1204, { unit: 'visits' })).toBe('1,204 visits')
    expect(formatValue(1204)).toBe('1,204')
    expect(formatValue(42, { unit: '%' })).toBe('42%')
    expect(formatValue(3.14159)).toBe('3.14')
    expect(formatValue(15300, { compact: true, unit: 'visits' })).toBe('15.3K visits')
  })
})

describe('formatTick', () => {
  it('compacts from 1,000 up', () => {
    expect(formatTick(0, 'count')).toBe('0')
    expect(formatTick(500, 'count')).toBe('500')
    expect(formatTick(1000, 'count')).toBe('1K')
    expect(formatTick(2500, 'number')).toBe('2.5K')
  })

  it('reads ranks, percents and dollars', () => {
    expect(formatTick(1, 'rank')).toBe('#1')
    expect(formatTick(25, 'percent')).toBe('25%')
    expect(formatTick(0.05, 'usd')).toBe('$0.05')
    expect(formatTick(12000, 'usd')).toBe('$12K')
    expect(formatTick(40, 'number', '%')).toBe('40%')
  })
})

describe('formatDateLabel', () => {
  it('reads days, weeks and months in UTC', () => {
    expect(formatDateLabel('2026-11-03', 'day')).toBe('3 Nov')
    expect(formatDateLabel('2026-11-03', 'week')).toBe('Week of 3 Nov')
    expect(formatDateLabel('2026-11-03', 'month')).toBe('Nov 2026')
    expect(formatDateLabel('2026-09-01')).toBe('1 Sep')
  })

  it('does not shift a date across midnight', () => {
    expect(formatDateLabel('2026-01-01T00:00:00Z', 'day')).toBe('1 Jan')
    expect(formatDateLabel('2026-12-31T23:30:00Z', 'month')).toBe('Dec 2026')
  })

  it('returns text that is not a date unchanged', () => {
    expect(formatDateLabel('Q3', 'day')).toBe('Q3')
    expect(formatDateLabel(null)).toBe('')
  })
})

describe('formatDelta', () => {
  it('signs changes with a true minus', () => {
    expect(formatDelta(12.66, 'pct')).toBe('+12.7%')
    expect(formatDelta(-3.2, 'pct')).toBe('−3.2%')
    expect(formatDelta(4.1, 'pts')).toBe('+4.1 pts')
    expect(formatDelta(-0.6, 'rank')).toBe('−0.6')
    expect(formatDelta(0.6, 'rank')).toBe('+0.6')
  })

  it('reads a change that rounds to nothing without a sign', () => {
    expect(formatDelta(0, 'pts')).toBe('0 pts')
    expect(formatDelta(0.04, 'pct')).toBe('0%')
  })

  it('returns null when the change is unknown', () => {
    expect(formatDelta(null, 'pct')).toBe(null)
  })
})

describe('countryName', () => {
  it('names countries in any case and maps UK to the United Kingdom', () => {
    expect(countryName('gb')).toBe('United Kingdom')
    expect(countryName('DE')).toBe('Germany')
    expect(countryName('uk')).toBe('United Kingdom')
  })

  it('falls back to the code', () => {
    expect(countryName('ZZ')).toBe('ZZ')
    expect(countryName('not a code')).toBe('not a code')
    expect(countryName('')).toBe('')
  })
})

describe('toNumber', () => {
  it('accepts numbers and numeric text only', () => {
    expect(toNumber(3)).toBe(3)
    expect(toNumber('3.5')).toBe(3.5)
    expect(toNumber(' ')).toBe(null)
    expect(toNumber(false)).toBe(null)
    expect(toNumber(Infinity)).toBe(null)
  })
})
