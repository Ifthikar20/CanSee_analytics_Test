import { describe, expect, it } from 'vitest'
import { normalizeNext, normalizeReading, READING_MAX } from '../reading'

describe('normalizeReading', () => {
  it('keeps a sentence and tidies its spacing', () => {
    expect(normalizeReading({ line: '  You are 4th   of 6 brands. ' })).toEqual({ line: 'You are 4th of 6 brands.', next: null })
  })

  it.each([null, undefined, 'text', 7, {}, { line: '' }, { line: '   ' }, { line: 12 }])('gives nothing for %j', (value) => {
    expect(normalizeReading(value)).toBeNull()
  })

  it.each(['AI names you in undefined% of answers.', 'Up NaN points.', 'Leader: null.', 'Infinity answers.'])(
    'drops a sentence with a hole in it: %s',
    (line) => {
      expect(normalizeReading({ line })).toBeNull()
    },
  )

  it('does not mistake ordinary words for holes', () => {
    expect(normalizeReading({ line: 'Nullify is named most.' })?.line).toBe('Nullify is named most.')
  })

  it('leaves room for one sentence, not a paragraph', () => {
    expect(READING_MAX).toBeGreaterThanOrEqual(90)
    expect(READING_MAX).toBeLessThanOrEqual(140)
  })
})

describe('normalizeNext', () => {
  it('opens a block panel with its query', () => {
    expect(normalizeNext({ label: ' Open the prompts ', widget: 'prompts', query: { filter: 'missing' } })).toEqual({
      label: 'Open the prompts',
      widget: 'prompts',
      query: { filter: 'missing' },
      to: null,
    })
  })

  it('follows a route when there is no block to open', () => {
    expect(normalizeNext({ label: 'Make a report', to: { name: 'reports' } })).toEqual({
      label: 'Make a report',
      widget: '',
      query: {},
      to: { name: 'reports' },
    })
  })

  it('prefers the block over the route when both are given', () => {
    expect(normalizeNext({ label: 'Open', widget: 'prompts', to: '/x' }).to).toBeNull()
  })

  it.each([null, {}, { label: 'Open' }, { widget: 'prompts' }, { label: '  ', widget: 'prompts' }, { label: 'Open', to: 5 }])(
    'drops a step that leads nowhere: %j',
    (value) => {
      expect(normalizeNext(value)).toBeNull()
    },
  )

  it('carries a reading with its next step through together', () => {
    const reading = normalizeReading({ line: 'Four claims are wrong.', next: { label: 'See the claims', widget: 'fact-check' } })
    expect(reading.next.widget).toBe('fact-check')
    expect(normalizeReading({ line: 'Four claims are wrong.', next: { label: 'See' } }).next).toBeNull()
  })
})
