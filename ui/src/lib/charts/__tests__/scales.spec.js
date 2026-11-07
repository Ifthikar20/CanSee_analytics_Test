import { describe, expect, it } from 'vitest'
import { binOf, binsFor, fillOf } from '@/lib/charts/scales'
import { normalizeVizSpec } from '@/lib/charts/spec'

const spec = (value, data, extra = {}) =>
  normalizeVizSpec({ title: 'T', value, labels: data.map((_, i) => `l${i}`), datasets: [{ key: 'a', data }], ...extra })

describe('binsFor', () => {
  it('uses fixed percent bins', () => {
    const bins = binsFor(spec('percent', [3, 50]))
    expect(bins.map((b) => b.label)).toEqual(['0-19%', '20-39%', '40-59%', '60-79%', '80-100%'])
    expect(bins.map((b) => b.level)).toEqual([1, 2, 3, 4, 5])
  })

  it('uses ordinal rank buckets, best first and strongest', () => {
    const bins = binsFor(spec('rank', [1, 40]))
    expect(bins.map((b) => b.label)).toEqual(['#1-3', '#4-10', '#11-20', '#21-50', '#51-100'])
    expect(bins.map((b) => b.level)).toEqual([5, 4, 3, 2, 1])
  })

  it('splits counts into five equal bins up to a rounded max', () => {
    const bins = binsFor(spec('count', [600, 1240, 70]))
    expect(bins.map((b) => b.label)).toEqual(['0-249', '250-499', '500-749', '750-999', '1K-1.3K'])
    expect(bins[4]).toMatchObject({ min: 1000, max: 1250 })
  })

  it('keeps small counts whole', () => {
    expect(binsFor(spec('count', [0, 3])).map((b) => b.label)).toEqual(['0', '1', '2', '3', '4-5'])
    expect(binsFor(spec('count', [0, 0])).map((b) => b.label)).toEqual(['0', '1', '2', '3', '4-5'])
  })

  it('honours a fixed max', () => {
    expect(binsFor(spec('number', [12, 64], { max: 100 })).map((b) => b.label)).toEqual([
      '0-19',
      '20-39',
      '40-59',
      '60-79',
      '80-100',
    ])
  })

  describe('with a log scale', () => {
    const log = (data, extra = {}) => binsFor(spec('count', data, { scale: 'log', ...extra }))
    const read = (bins) => bins.map((b) => [b.label, b.level])

    it('keeps one bin up to a single-digit max', () => {
      expect(read(log([7, 2, 1]))).toEqual([['1-7', 5]])
    })

    it('uses one bin per decade up to the max, the last ending on it', () => {
      expect(read(log([480, 12, 3]))).toEqual([
        ['1-9', 1],
        ['10-99', 3],
        ['100-480', 5],
      ])
      const big = log([480213, 1204, 15])
      expect(read(big)).toEqual([
        ['1-99', 1],
        ['100-999', 2],
        ['1,000-9,999', 3],
        ['10,000-99,999', 4],
        ['100,000-480,213', 5],
      ])
      expect(big.every((b) => b.integer)).toBe(true)
      expect(binOf(99, big)).toBe(1)
      expect(binOf(100, big)).toBe(2)
      expect(binOf(480213, big)).toBe(5)
    })

    it('starts the first bin at 0 when a measured zero is drawn', () => {
      const bins = log([0, 480])
      expect(bins[0]).toMatchObject({ min: 0, max: 9, label: '0-9', level: 1 })
      expect(binOf(0, bins)).toBe(1)
    })

    it('falls back to the linear bins when the largest value is below 1', () => {
      const bins = binsFor(spec('usd', [0.12, 0.4], { scale: 'log' }))
      expect(bins).toHaveLength(5)
      expect(bins[0].min).toBe(0)
      expect(read(log([0, 0]))).toEqual(read(binsFor(spec('count', [0, 0]))))
    })

    it('leaves percents and ranks on their fixed bins', () => {
      expect(binsFor(spec('percent', [3, 50], { scale: 'log' }))[0].label).toBe('0-19%')
      expect(binsFor(spec('rank', [1, 40], { scale: 'log' }))[0].label).toBe('#1-3')
    })
  })

  it('bins one dataset of several by its own kind', () => {
    const s = normalizeVizSpec({
      title: 'T',
      labels: ['gb'],
      datasets: [
        { key: 'ai', data: [40], value: 'percent' },
        { key: 'google', data: [4], value: 'rank' },
      ],
    })
    expect(binsFor(s, s.datasets[1])[0].label).toBe('#1-3')
    expect(binsFor(s, s.datasets[0])[0].label).toBe('0-19%')
  })
})

describe('binOf', () => {
  const percent = binsFor(spec('percent', [1]))
  const rank = binsFor(spec('rank', [1]))

  it('places percents on the edges by what they read as', () => {
    expect(binOf(0, percent)).toBe(1)
    expect(binOf(19.4, percent)).toBe(1)
    expect(binOf(19.5, percent)).toBe(2)
    expect(binOf(20, percent)).toBe(2)
    expect(binOf(79, percent)).toBe(4)
    expect(binOf(80, percent)).toBe(5)
    expect(binOf(100, percent)).toBe(5)
    expect(binOf(130, percent)).toBe(5)
    expect(binOf(-5, percent)).toBe(1)
  })

  it('shades the best ranks strongest', () => {
    expect(binOf(1, rank)).toBe(5)
    expect(binOf(3, rank)).toBe(5)
    expect(binOf(3.4, rank)).toBe(5)
    expect(binOf(4, rank)).toBe(4)
    expect(binOf(10, rank)).toBe(4)
    expect(binOf(11, rank)).toBe(3)
    expect(binOf(50, rank)).toBe(2)
    expect(binOf(51, rank)).toBe(1)
    expect(binOf(240, rank)).toBe(1)
  })

  it('has no bin for a missing value', () => {
    expect(binOf(null, percent)).toBe(null)
    expect(binOf(undefined, rank)).toBe(null)
  })

  it('handles fractional bins', () => {
    const usd = binsFor(spec('usd', [0.12]))
    expect(usd).toHaveLength(5)
    expect(binOf(0, usd)).toBe(1)
    expect(binOf(0.12, usd)).toBe(5)
    expect(binOf(usd[4].max, usd)).toBe(5)
  })
})

describe('fillOf', () => {
  const percent = binsFor(spec('percent', [1]))

  it('fills by bin, or by state', () => {
    expect(fillOf(45, null, percent)).toEqual({ look: 'bin', level: 3 })
    expect(fillOf(null, 'not_found', percent)).toEqual({ look: 'absent', level: null })
    expect(fillOf(null, 'named', percent)).toEqual({ look: 'named', level: 3 })
    expect(fillOf(null, 'not_checked', percent)).toEqual({ look: 'nodata', level: null })
    expect(fillOf(null, null, percent)).toEqual({ look: 'nodata', level: null })
  })
})
