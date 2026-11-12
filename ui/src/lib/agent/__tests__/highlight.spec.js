import { describe, expect, it } from 'vitest'
import {
  MAX_TERM_LENGTH,
  MAX_TERMS,
  captureTerms,
  compileTerms,
  createMarker,
  keywordTerms,
  splitHighlight,
  uniqueNames,
} from '../highlight'

const split = (text, groups) => splitHighlight(text, compileTerms(groups))
const marks = (segments) => (segments || []).filter((s) => s.kind).map((s) => [s.text, s.kind])
const joined = (segments) => segments.map((s) => s.text).join('')

describe('compileTerms', () => {
  it('drops empty and non-string terms and keeps the higher-ranked kind for a duplicate', () => {
    const terms = compileTerms({
      find: ['  ', null, 'Acme'],
      keyword: ['acme', 'pricing'],
      brand: [{}, 'ACME'],
      competitor: [42],
    })
    expect(terms.map((t) => [t.text, t.kind])).toEqual([
      ['Acme', 'find'],
      ['pricing', 'keyword'],
      ['42', 'competitor'],
    ])
  })

  it('caps the number and length of terms', () => {
    const many = Array.from({ length: MAX_TERMS + 10 }, (_, i) => `term${i}`)
    expect(compileTerms({ find: many })).toHaveLength(MAX_TERMS)
    const long = compileTerms({ find: ['x'.repeat(MAX_TERM_LENGTH + 50)] })
    expect(Array.from(long[0].text)).toHaveLength(MAX_TERM_LENGTH)
  })

  it('collapses whitespace inside a term', () => {
    expect(compileTerms({ find: ['  best \n crm  '] })[0].text).toBe('best crm')
  })
})

describe('splitHighlight', () => {
  it('returns null with no terms or no match', () => {
    expect(splitHighlight('Some text', [])).toBeNull()
    expect(split('Some text', { find: ['absent'] })).toBeNull()
    expect(split('', { find: ['a'] })).toBeNull()
  })

  it('keeps the text intact around the marks', () => {
    const text = 'Acme ranks #3, ahead of Globex.'
    const segments = split(text, { brand: ['Acme'], competitor: ['Globex'] })
    expect(joined(segments)).toBe(text)
    expect(marks(segments)).toEqual([
      ['Acme', 'brand'],
      ['Globex', 'competitor'],
    ])
  })

  it('treats regular-expression syntax as literal text', () => {
    const segments = split('Price: $5.00 (approx.) for [a+b] or a.*b', {
      find: ['$5.00', '(approx.)', '[a+b]', 'a.*b'],
    })
    expect(marks(segments).map(([t]) => t)).toEqual(['$5.00', '(approx.)', '[a+b]', 'a.*b'])
  })

  it('matches whole words only', () => {
    expect(marks(split('category cat cats concat', { find: ['cat'] }))).toEqual([['cat', 'find']])
  })

  it('needs no boundary at a punctuation edge of a term', () => {
    expect(marks(split('We use node.js and C++ daily', { find: ['C++', '.js'] }))).toEqual([
      ['.js', 'find'],
      ['C++', 'find'],
    ])
  })

  it('ignores case and keeps the original casing in the marks', () => {
    expect(marks(split('CanSee, CANSEE and cansee', { brand: ['cansee'] }))).toEqual([
      ['CanSee', 'brand'],
      ['CANSEE', 'brand'],
      ['cansee', 'brand'],
    ])
  })

  it('folds dotted capital I and final sigma', () => {
    expect(marks(split('İstanbul offices', { keyword: ['istanbul'] }))).toEqual([
      ['İstanbul', 'keyword'],
    ])
    expect(marks(split('ΟΔΟΣ', { find: ['οδος'] }))).toEqual([['ΟΔΟΣ', 'find']])
  })

  it('matches across composed and decomposed accents', () => {
    const decomposed = 'café menu'
    const segments = split(decomposed, { find: ['café'] })
    expect(marks(segments)).toEqual([['café', 'find']])
    expect(joined(segments)).toBe(decomposed.normalize('NFC'))
  })

  it('treats letters of unspaced scripts as word boundaries', () => {
    expect(marks(split('CanSeeの分析', { brand: ['CanSee'] }))).toEqual([['CanSee', 'brand']])
    expect(marks(split('東京都の天気', { keyword: ['東京'] }))).toEqual([['東京', 'keyword']])
  })

  it('applies whole-word matching to non-Latin letters', () => {
    expect(marks(split('Москва и москвичи', { find: ['москва'] }))).toEqual([['Москва', 'find']])
  })

  it('keeps astral characters whole', () => {
    const segments = split('Launch 🚀 day: 🚀 Acme', { brand: ['Acme'], find: ['🚀'] })
    expect(joined(segments)).toBe('Launch 🚀 day: 🚀 Acme')
    expect(marks(segments)).toEqual([
      ['🚀', 'find'],
      ['🚀', 'find'],
      ['Acme', 'brand'],
    ])
  })

  it('lets a find match win over a longer overlapping term', () => {
    expect(marks(split('best crm software', { find: ['crm'], keyword: ['crm software'] }))).toEqual([
      ['crm', 'find'],
    ])
  })

  it('lets the longer match win among keyword, brand and competitor', () => {
    expect(
      marks(split('Acme Cloud pricing', { brand: ['Acme'], competitor: ['Acme Cloud'] }))
    ).toEqual([['Acme Cloud', 'competitor']])
  })

  it('ranks keyword over brand over competitor for equal-length overlaps', () => {
    expect(marks(split('x-y-z', { keyword: ['x-y'], brand: ['y-z'] }))).toEqual([['x-y', 'keyword']])
    expect(marks(split('x-y-z', { brand: ['y-z'], competitor: ['x-y'] }))).toEqual([['y-z', 'brand']])
  })

  it('marks adjacent repeats separately', () => {
    expect(marks(split('Acme Acme', { brand: ['Acme'] }))).toEqual([
      ['Acme', 'brand'],
      ['Acme', 'brand'],
    ])
  })

  it('bounds the work on very long text', () => {
    const text = 'a '.repeat(10000)
    const info = {}
    const segments = splitHighlight(text, compileTerms({ find: ['a'] }), info)
    expect(marks(segments).length).toBeLessThanOrEqual(2000)
    expect(joined(segments)).toBe(text)
    expect([...info.truncated]).toEqual(['find'])
  })

  it('still searches the later terms when one term is cut short', () => {
    const text = `CanSee ${'seo '.repeat(2100)}best seo tools CanSee`
    const segments = split(text, { keyword: ['seo', 'best seo tools'], brand: ['CanSee'] })
    const found = marks(segments)
    expect(found[0]).toEqual(['CanSee', 'brand'])
    expect(found.at(-1)).toEqual(['CanSee', 'brand'])
    expect(found).toContainEqual(['best seo tools', 'keyword'])
  })
})

describe('createMarker', () => {
  it('numbers marks across strings in reading order', () => {
    const marker = createMarker(compileTerms({ brand: ['Acme'] }))
    const first = marker.mark('Acme and Acme')
    const second = marker.mark('then Acme')
    expect(first.filter((s) => s.kind).map((s) => s.index)).toEqual([0, 1])
    expect(second.filter((s) => s.kind).map((s) => s.index)).toEqual([2])
    expect(marker.count).toBe(3)
    expect(marker.total).toBe(3)
  })

  it('steps through find marks only while a find term is set', () => {
    const marker = createMarker(compileTerms({ find: ['pricing'], brand: ['Acme'] }))
    const segments = marker.mark('Acme pricing and Acme pricing')
    expect(segments.filter((s) => s.kind).map((s) => [s.kind, s.index])).toEqual([
      ['brand', undefined],
      ['find', 0],
      ['brand', undefined],
      ['find', 1],
    ])
    expect(marker.count).toBe(2)
    expect(marker.total).toBe(4)
  })

  it('stops marking at the limit and reports it', () => {
    const marker = createMarker(compileTerms({ find: ['a'] }), { limit: 3 })
    const segments = marker.mark('a a a a a')
    expect(segments.filter((s) => s.kind)).toHaveLength(3)
    expect(joined(segments)).toBe('a a a a a')
    expect(marker.capped).toBe(true)
    expect(marker.mark('a again')).toBeNull()
  })

  it('is not capped when the matches end exactly at the limit', () => {
    const marker = createMarker(compileTerms({ find: ['a'] }), { limit: 2 })
    marker.mark('a a')
    expect(marker.mark('nothing here')).toBeNull()
    expect(marker.capped).toBe(false)
  })

  it('never lets other marks crowd out find matches', () => {
    const marker = createMarker(compileTerms({ find: ['pricing'], brand: ['Acme'] }), { limit: 3 })
    const segments = marker.mark('Acme Acme Acme Acme pricing')
    expect(segments.filter((s) => s.kind).map((s) => s.kind)).toEqual(['brand', 'brand', 'brand', 'find'])
    expect(marker.count).toBe(1)
    expect(marker.total).toBe(4)
    expect(marker.capped).toBe(false)
  })

  it('reports a find term cut short inside one string as capped', () => {
    const marker = createMarker(compileTerms({ find: ['a'] }), { limit: 5000 })
    marker.mark('a '.repeat(2500))
    expect(marker.count).toBe(2000)
    expect(marker.capped).toBe(true)
  })
})

describe('keywordTerms', () => {
  it('returns the phrase plus its content words', () => {
    expect(keywordTerms('What is the best CRM for small businesses?')).toEqual([
      'What is the best CRM for small businesses?',
      'CRM',
      'small',
      'businesses',
    ])
  })

  it('keeps two-letter acronyms', () => {
    expect(keywordTerms('AI visibility tools')).toEqual(['AI visibility tools', 'AI', 'visibility', 'tools'])
  })

  it('returns a single-word keyword once', () => {
    expect(keywordTerms('crm')).toEqual(['crm'])
    expect(keywordTerms('')).toEqual([])
  })
})

describe('captureTerms', () => {
  it('reads the query, brand and competitors from a Google results capture', () => {
    const terms = captureTerms({
      query: '  best   ai visibility tools ',
      brand: { name: 'Cansee', domain: 'www.cansee.ai' },
      results: [
        { is_competitor: true, competitor_name: 'Profound' },
        { is_competitor: true, domain: 'peec.ai' },
        { is_competitor: true, competitor_name: 'profound' },
        { is_yours: true, is_competitor: true, competitor_name: 'Self' },
        { domain: 'example.com' },
      ],
    })
    expect(terms).toEqual({
      keyword: 'best ai visibility tools',
      brand: ['Cansee', 'cansee.ai'],
      competitors: ['Profound', 'peec.ai'],
    })
  })

  it('tolerates a missing or partial capture', () => {
    expect(captureTerms(null)).toEqual({ keyword: '', brand: [], competitors: [] })
    expect(captureTerms({ brand: 'x', results: 'y' })).toEqual({ keyword: '', brand: [], competitors: [] })
  })
})

describe('uniqueNames', () => {
  it('dedupes case-insensitively and caps the list', () => {
    expect(uniqueNames(['Acme', 'ACME', ' acme ', 'Globex'])).toEqual(['Acme', 'Globex'])
    expect(uniqueNames(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
  })
})
