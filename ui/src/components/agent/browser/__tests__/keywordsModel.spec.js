import { describe, expect, it } from 'vitest'
import {
  SORT_OPTIONS,
  aiScoreText,
  answerText,
  changeSummary,
  changesByPrompt,
  engineText,
  isMoved,
  keywordTerms,
  sortKeywordRows,
  sortLabel,
} from '../keywordsModel'

const prompt = (id, { text = id, position = null, status = 'ok', ai = null } = {}) => ({
  prompt_id: id,
  text,
  google: { status, position },
  gap: { ai_score: ai },
})
const change = (prompt_id, engine, kind, latest = { named: true, rank: 2 }, previous = null) => ({
  prompt_id,
  engine,
  label: engine === 'chatgpt' ? 'ChatGPT' : 'Claude',
  change: kind,
  latest,
  previous,
})
const ids = (rows) => rows.map((r) => r.prompt_id)

describe('sortKeywordRows', () => {
  const rows = [
    prompt('a', { position: 9, ai: 40 }),
    prompt('b', { position: null, ai: 80 }),
    prompt('c', { position: 2, ai: null }),
    prompt('d', { status: 'not_checked', position: 1, ai: 10 }),
    prompt('e', { position: 9, ai: 70 }),
  ]

  it('keeps the server order for the gap sort', () => {
    expect(ids(sortKeywordRows(rows, 'gap'))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(sortKeywordRows(rows, null))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(sortKeywordRows(rows, 'nonsense'))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('sorts by Google position with unchecked and absent last, then AI score', () => {
    // d is not checked, so its stale position never counts.
    expect(ids(sortKeywordRows(rows, 'google'))).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  it('sorts by AI score, highest first, with no score last', () => {
    expect(ids(sortKeywordRows(rows, 'ai'))).toEqual(['b', 'e', 'a', 'd', 'c'])
  })

  it('lists moved keywords first in move order and keeps the rest in server order', () => {
    const changes = changesByPrompt([
      change('d', 'chatgpt', 'rank_down'),
      change('b', 'chatgpt', 'named_now'),
      change('a', 'chatgpt', 'first_check'),
      change('e', 'claude', 'unchanged'),
    ])
    expect(ids(sortKeywordRows(rows, 'changed', changes))).toEqual(['b', 'd', 'a', 'c', 'e'])
  })

  it('breaks ties alphabetically', () => {
    const tied = [prompt('x', { text: 'beta', position: 3, ai: 50 }), prompt('y', { text: 'Alpha', position: 3, ai: 50 })]
    expect(ids(sortKeywordRows(tied, 'google'))).toEqual(['y', 'x'])
  })
})

describe('changeSummary', () => {
  it('reports the first move across engines', () => {
    const summary = changeSummary([
      change('p', 'chatgpt', 'rank_down', { named: true, rank: 5 }, { named: true, rank: 2 }),
      change('p', 'claude', 'named_now', { named: true, rank: 3 }, { named: false, rank: null }),
    ])
    expect(summary).toMatchObject({ kind: 'named_now', label: 'Named now', moved: true })
    expect(summary.details).toEqual(['ChatGPT: #2 to #5', 'Claude: not named to #3'])
  })

  it('says First check, never Dropped, when every engine was checked once', () => {
    const summary = changeSummary([change('p', 'chatgpt', 'first_check'), change('p', 'claude', 'first_check')])
    expect(summary).toMatchObject({ kind: 'first_check', label: 'First check', moved: false })
    expect(summary.details[0]).toBe('ChatGPT: no earlier answer to #2')
  })

  it('says No change otherwise, and nothing without answers', () => {
    expect(changeSummary([change('p', 'chatgpt', 'unchanged'), change('p', 'claude', 'first_check')]).label).toBe(
      'No change'
    )
    expect(changeSummary([])).toBeNull()
    expect(changeSummary(undefined)).toBeNull()
  })

  it('tells moved keywords apart', () => {
    const changes = changesByPrompt([change('p', 'chatgpt', 'dropped'), change('q', 'chatgpt', 'first_check')])
    expect(isMoved({ prompt_id: 'p' }, changes)).toBe(true)
    expect(isMoved({ prompt_id: 'q' }, changes)).toBe(false)
    expect(isMoved({ prompt_id: 'r' }, changes)).toBe(false)
  })
})

describe('cells', () => {
  it('words an engine like the rest of the app', () => {
    expect(engineText({ configured: true, answers: 4, mentioned: true, rank: 2 })).toBe('Named #2')
    expect(engineText({ configured: true, answers: 4, mentioned: true, rank: null })).toBe('Named')
    expect(engineText({ configured: true, answers: 4, mentioned: false })).toBe('Not named')
    expect(engineText({ configured: true, answers: 0, mentioned: false })).toBe('No answers')
    expect(engineText({ configured: false, answers: 3 })).toBe('')
    expect(engineText(null)).toBe('')
  })

  it('shows the AI score or says it was not checked', () => {
    expect(aiScoreText({ gap: { ai_score: 0 } })).toBe('0')
    expect(aiScoreText({ gap: { ai_score: 73 } })).toBe('73')
    expect(aiScoreText({ gap: { ai_score: null } })).toBe('Not checked')
  })

  it('words a single answer', () => {
    expect(answerText(null)).toBe('no earlier answer')
    expect(answerText({ named: false })).toBe('not named')
    expect(answerText({ named: true, rank: 4 })).toBe('#4')
    expect(answerText({ named: true, rank: null })).toBe('named')
  })

  it('names every sort', () => {
    expect(SORT_OPTIONS.map((o) => o.key)).toEqual(['gap', 'google', 'ai', 'changed'])
    expect(sortLabel('google')).toBe('Google rank')
    expect(sortLabel(null)).toBe('Biggest gap')
  })
})

describe('keywordTerms', () => {
  it('highlights the keyword, your brand and the brands the AI answers rank', () => {
    const overview = {
      website: { name: 'Acme', url: 'https://www.acme.example/home' },
      leaderboard: [
        { name: 'Globex', is_you: false },
        { name: 'Acme', is_you: true },
        { name: 'Initech', is_you: false },
        { name: '', is_you: false },
      ],
    }
    expect(keywordTerms(overview, { text: 'best crm' })).toEqual({
      keyword: 'best crm',
      brand: ['Acme', 'acme.example'],
      competitors: ['Globex', 'Initech'],
    })
  })
})
