import { describe, expect, it } from 'vitest'
import { asList, errorCode, errorMessage, errorStatus, hostOf, plainText, relativeTime } from '../agentText'

describe('plainText', () => {
  it('strips Markdown syntax for speech', () => {
    const md = [
      '## Findings',
      '',
      'You rank **#14** on Google, but [Perplexity](https://perplexity.ai) names you *first*.',
      '',
      '- one',
      '- two',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '| Engine | Rank |',
      '| --- | --- |',
      '| Claude | 3 |',
    ].join('\n')
    expect(plainText(md)).toBe('Findings You rank #14 on Google, but Perplexity names you first. one two Engine Rank Claude 3')
  })

  it('cuts at a word boundary and marks the cut', () => {
    const text = 'word '.repeat(200)
    const out = plainText(text, 40)
    expect(out.length).toBeLessThanOrEqual(41)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/\s…$/)
  })

  it('handles empty input', () => {
    expect(plainText('')).toBe('')
    expect(plainText(null)).toBe('')
  })
})

describe('asList', () => {
  it('accepts arrays and list wrappers', () => {
    expect(asList([1])).toEqual([1])
    expect(asList({ results: [2] })).toEqual([2])
    expect(asList({ items: [3] })).toEqual([3])
    expect(asList(null)).toEqual([])
    expect(asList({})).toEqual([])
  })
})

describe('errors', () => {
  it('reads status, code and message from axios and store errors', () => {
    const axiosErr = { response: { status: 409, data: { error: { code: 'revision_conflict', message: 'Stale' } } } }
    expect(errorStatus(axiosErr)).toBe(409)
    expect(errorCode(axiosErr)).toBe('revision_conflict')
    expect(errorMessage(axiosErr, 'fallback')).toBe('Stale')

    const agentErr = Object.assign(new Error('The agent is turned off.'), { name: 'AgentError', status: 503, code: 'agent_disabled' })
    expect(errorStatus(agentErr)).toBe(503)
    expect(errorCode(agentErr)).toBe('agent_disabled')
    expect(errorMessage(agentErr, 'fallback')).toBe('The agent is turned off.')

    expect(errorMessage(new Error('TypeError: x is undefined'), 'Something failed.')).toBe('Something failed.')
  })
})

describe('hostOf', () => {
  it('returns the bare host', () => {
    expect(hostOf('https://www.example.com/pricing')).toBe('example.com')
    expect(hostOf('example.org')).toBe('example.org')
    expect(hostOf('')).toBe('')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-11-02T12:00:00Z')
  it('describes recent times in words', () => {
    expect(relativeTime('2026-11-02T11:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-11-02T11:55:00Z', now)).toBe('5 min ago')
    expect(relativeTime('2026-11-02T11:00:00Z', now)).toBe('1 hour ago')
    expect(relativeTime('2026-11-02T09:00:00Z', now)).toBe('3 hours ago')
    expect(relativeTime('2026-11-01T11:00:00Z', now)).toBe('yesterday')
    expect(relativeTime('2026-10-29T12:00:00Z', now)).toBe('4 days ago')
  })

  it('falls back to a date, and to nothing for bad input', () => {
    expect(relativeTime('2026-09-01T12:00:00Z', now)).toMatch(/Sep/)
    expect(relativeTime('nonsense', now)).toBe('')
    expect(relativeTime(null, now)).toBe('')
  })
})
