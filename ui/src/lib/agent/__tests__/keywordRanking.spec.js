import { describe, expect, it } from 'vitest'
import { aiText, collectSerpCaptures, googleText, rankChatKeywords } from '../keywordRanking'
import { SERP_CAPTURE } from './__fixtures__/swarmEvents.js'

let seq = 0

// A research agent's Google page, stamped with its tracked prompt.
function serp(overrides = {}) {
  seq += 1
  return {
    ...SERP_CAPTURE,
    capture_id: `cap${seq}`,
    prompt_id: 'P1',
    brand_prompt_id: 'BP1',
    prompt_key: 'p1',
    results: [],
    ...overrides,
  }
}

const overview = (fields = {}) => ({ shown: true, content_captured: true, mentions_you: false, cites_you: false, ...fields })
const keywords = (ranking) => ranking.rows.map((r) => r.keyword)

describe('rankChatKeywords', () => {
  it('leaves out captures with no tracked prompt', () => {
    const ranking = rankChatKeywords([
      serp({ prompt_id: undefined }),
      serp({ prompt_id: '' }),
      serp({ prompt_id: null }),
    ])
    expect(ranking.rows).toEqual([])
    expect(ranking.byPromptId).toEqual({})
  })

  it('takes the best position across a keyword’s pages', () => {
    const { rows } = rankChatKeywords([serp({ page: 1, brand_positions: [] }), serp({ page: 2, brand_positions: [14] })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ position: 14, pages: [1, 2], googleText: '#14', fromPageOne: true })
  })

  it('lets the newest capture of a page win, even when you dropped off it', () => {
    const { rows } = rankChatKeywords([
      serp({ captured_at: '2026-11-01T10:00:00Z', brand_positions: [3] }),
      serp({ captured_at: '2026-11-05T10:00:00Z', brand_positions: [] }),
    ])
    expect(rows[0]).toMatchObject({ position: null, googleText: 'Not in top 10' })
  })

  it('never lets an errored or empty capture hide a good earlier page', () => {
    const { rows } = rankChatKeywords([
      serp({ captured_at: '2026-11-01T10:00:00Z', brand_positions: [5] }),
      serp({ captured_at: '2026-11-05T10:00:00Z', brand_positions: [], error: { code: 'upstream_error' } }),
      serp({ captured_at: '2026-11-06T10:00:00Z', results: undefined }),
    ])
    expect(rows[0].position).toBe(5)
  })

  it('says which pages were read when you are on none of them', () => {
    const only2 = rankChatKeywords([serp({ page: 2, brand_positions: [] })]).rows[0]
    expect(only2.googleText).toBe('Not on page 2')
    const two3 = rankChatKeywords([serp({ page: 2, brand_positions: [] }), serp({ page: 3, brand_positions: [] })]).rows[0]
    expect(two3.googleText).toBe('Not on pages 2 and 3')
    const one2 = rankChatKeywords([serp({ page: 1, brand_positions: [] }), serp({ page: 2, brand_positions: [] })]).rows[0]
    expect(one2.googleText).toBe('Not in top 20')
  })

  it('breaks equal positions on the AI Overview naming you, then citing you', () => {
    const ranking = rankChatKeywords([
      serp({ prompt_id: 'A', query: 'zebra crm', brand_positions: [4], ai_overview: overview({ mentions_you: true }) }),
      serp({ prompt_id: 'B', query: 'yak crm', brand_positions: [4], ai_overview: overview({ cites_you: true }) }),
      serp({ prompt_id: 'C', query: 'apple crm', brand_positions: [4], ai_overview: overview() }),
      serp({
        prompt_id: 'D',
        query: 'banana crm',
        brand_positions: [4],
        ai_overview: overview({ content_captured: false, mentions_you: null, cites_you: null }),
      }),
      serp({ prompt_id: 'E', query: 'kiwi crm', brand_positions: [4], ai_overview: overview({ mentions_you: true, cites_you: true }) }),
    ])
    expect(keywords(ranking)).toEqual(['kiwi crm', 'zebra crm', 'yak crm', 'apple crm', 'banana crm'])
    expect(ranking.rows.map((r) => r.aiTier)).toEqual([3, 2, 1, 0, 0])
    expect(ranking.byPromptId.D.aiText).toBe('Shown, not read')
    expect(ranking.byPromptId.E.aiText).toBe('Names you · cites you')
  })

  it('ranks keywords you are not on after every ranked one, and never at 0', () => {
    const ranking = rankChatKeywords([
      serp({ prompt_id: 'A', query: 'absent', brand_positions: [0] }),
      serp({ prompt_id: 'B', query: 'deep', brand_positions: [48] }),
      serp({ prompt_id: 'C', query: 'top', brand_positions: [1] }),
    ])
    expect(keywords(ranking)).toEqual(['top', 'deep', 'absent'])
    expect(ranking.byPromptId.A.position).toBeNull()
  })

  it('reads your positions from the results when brand_positions is missing', () => {
    const capture = serp({
      results: [
        { position: true, is_yours: true },
        { position: 0, is_yours: true },
        { position: 7, is_yours: false },
        { position: 2, is_yours: true },
      ],
    })
    delete capture.brand_positions
    expect(rankChatKeywords([capture]).rows[0].position).toBe(2)
  })

  it('breaks full ties alphabetically, then by prompt id', () => {
    const ranking = rankChatKeywords([
      serp({ prompt_id: 'Z', query: 'Same text', brand_positions: [3] }),
      serp({ prompt_id: 'M', query: 'beta', brand_positions: [3] }),
      serp({ prompt_id: 'A', query: 'same text', brand_positions: [3] }),
    ])
    expect(ranking.rows.map((r) => r.promptId)).toEqual(['M', 'A', 'Z'])
  })

  it('builds a row from the newest capture and merges brand and competitor names', () => {
    const ranking = rankChatKeywords([
      serp({
        captured_at: '2026-11-01T10:00:00Z',
        page: 2,
        query: 'old  text',
        location: 'gb',
        brand_positions: [],
        results: [{ position: 12, is_competitor: true, competitor_name: 'Globex' }],
      }),
      serp({
        captured_at: '2026-11-04T10:00:00Z',
        page: 1,
        query: '  best   crm ',
        location: 'gb',
        brand_positions: [6],
        results: [{ position: 3, is_competitor: true, competitor_name: 'Initech' }],
      }),
    ])
    const row = ranking.byPromptId.P1
    expect(row).toMatchObject({
      keyword: 'best crm',
      location: 'gb',
      brandPromptId: 'BP1',
      promptKey: 'p1',
      position: 6,
      capturedAt: '2026-11-04T10:00:00Z',
      brand: ['Notion', 'notion.so'],
      competitors: ['Globex', 'Initech'],
    })
    expect(row.captures.map((c) => [c.page, c.tabId])).toEqual([
      [1, `serp:${row.captures[0].captureId}`],
      [2, `serp:${row.captures[1].captureId}`],
    ])
  })
})

describe('rankChatKeywords across countries', () => {
  it('counts only the searches from the country of the newest one', () => {
    const { rows } = rankChatKeywords([
      // An earlier research from the US read pages 1 and 2.
      serp({ location: 'us', page: 1, brand_positions: [], captured_at: '2026-11-01T10:00:00Z' }),
      serp({ location: 'us', page: 2, brand_positions: [14], captured_at: '2026-11-01T10:00:01Z' }),
      // The prompt was re-tracked for GB and searched again, page 1 only.
      serp({ location: 'GB', page: 1, brand_positions: [], captured_at: '2026-11-02T10:00:00Z' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ location: 'GB', position: null, pages: [1], googleText: 'Not in top 10' })
  })

  it('takes the country of the latest search in the chat, not the newest timestamp', () => {
    // A research for GB shows an earlier GB page again: it keeps its older time.
    const { rows } = rankChatKeywords([
      serp({ location: 'us', page: 1, brand_positions: [3], captured_at: '2026-11-01T10:15:00Z' }),
      serp({ location: 'gb', page: 1, brand_positions: [], captured_at: '2026-11-01T10:00:00Z' }),
    ])
    expect(rows[0]).toMatchObject({ location: 'gb', position: null })
  })

  it('takes brand and competitor names from every country', () => {
    const { rows } = rankChatKeywords([
      serp({ location: 'us', results: [{ position: 2, is_competitor: true, competitor_name: 'Zoho' }] }),
      serp({ location: 'gb', results: [{ position: 3, is_competitor: true, competitor_name: 'Globex' }] }),
    ])
    expect(rows[0].competitors).toEqual(['Zoho', 'Globex'])
  })

  it('keeps every page of one country', () => {
    const { rows } = rankChatKeywords([
      serp({ location: 'us', page: 1, brand_positions: [], captured_at: '2026-11-01T10:00:00Z' }),
      serp({ location: 'US', page: 2, brand_positions: [12], captured_at: '2026-11-01T10:00:01Z' }),
    ])
    expect(rows[0]).toMatchObject({ position: 12, pages: [1, 2] })
  })
})

describe('collectSerpCaptures order', () => {
  it('moves a capture shown again in a later message to that later place', () => {
    const x = serp({ capture_id: 'x', location: 'gb' })
    const y = serp({ capture_id: 'y', location: 'us' })
    const messages = [
      { research: { serp: { x } } },
      { research: { serp: { y } } },
      { research: { serp: { x: { ...x } } } },
    ]
    expect(collectSerpCaptures(messages, []).map((c) => c.capture_id)).toEqual(['y', 'x'])
  })

  it('keeps the stamped copy in its place when an unstamped one comes later', () => {
    const x = serp({ capture_id: 'x' })
    const y = serp({ capture_id: 'y' })
    const messages = [
      { research: { serp: { x } } },
      { research: { serp: { y } } },
      { research: { serp: { x: { ...x, prompt_id: undefined } } } },
    ]
    const found = collectSerpCaptures(messages, [])
    expect(found.map((c) => c.capture_id)).toEqual(['x', 'y'])
    expect(found[0].prompt_id).toBe('P1')
  })
})

describe('collectSerpCaptures', () => {
  it('keeps one capture per id, preferring the stamped copy', () => {
    const plain = { ...serp({ capture_id: 'same', prompt_id: undefined }) }
    const stamped = { ...plain, prompt_id: 'P1' }
    const forward = collectSerpCaptures(
      [{ research: { serp: { same: plain } } }, { research: { serp: { same: stamped } } }],
      []
    )
    expect(forward).toEqual([stamped])
    const backward = collectSerpCaptures(
      [{ research: { serp: { same: stamped } } }, { research: { serp: { same: plain } } }],
      []
    )
    expect(backward).toEqual([stamped])
    expect(rankChatKeywords(backward).rows).toHaveLength(1)
  })

  it('adds the Google tabs and skips anything that is not a capture', () => {
    const live = serp({ capture_id: 'live' })
    const captures = collectSerpCaptures(
      [{ research: { serp: { a: serp({ capture_id: 'a' }), junk: null } } }, { research: null }, null],
      [{ kind: 'serp', data: live }, { kind: 'page', data: serp({ capture_id: 'page' }) }]
    )
    expect(captures.map((c) => c.capture_id)).toEqual(['a', 'live'])
  })
})

describe('labels', () => {
  it('words the Google cell like the research results table', () => {
    expect(googleText({ position: 4, pages: [1] })).toBe('#4')
    expect(googleText({ position: null, pages: [1, 2, 3], fromPageOne: true })).toBe('Not in top 30')
    expect(googleText({ position: null, pages: [2, 3, 4], fromPageOne: false })).toBe('Not on pages 2, 3 and 4')
    expect(googleText({ position: null, pages: [] })).toBe('')
  })

  it('words the AI Overview cell like the research results table', () => {
    expect(aiText({ aiOverview: null })).toBe('')
    expect(aiText({ aiOverview: { shown: false } })).toBe('Not shown')
    expect(aiText({ aiOverview: { shown: true, contentCaptured: true, mentionsYou: false, citesYou: false } })).toBe(
      'Shown, not named'
    )
    expect(aiText({ aiOverview: { shown: true, contentCaptured: true, mentionsYou: false, citesYou: true } })).toBe(
      'Cites you'
    )
  })

  it('reads no AI Overview when page 1 was not searched', () => {
    const row = rankChatKeywords([serp({ page: 2, brand_positions: [11], ai_overview: overview({ mentions_you: true }) })])
      .rows[0]
    expect(row.aiOverview).toBeNull()
    expect(row.aiText).toBe('')
    expect(row.aiTier).toBe(0)
  })
})
