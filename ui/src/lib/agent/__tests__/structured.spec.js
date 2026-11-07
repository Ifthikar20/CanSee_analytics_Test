import { describe, expect, it } from 'vitest'
import {
  CHANGE_KINDS,
  changeKindWord,
  comparison,
  corrections,
  hasStructuredView,
  pageRevision,
  postCopyText,
  socialPosts,
  structuredTabLabel,
  structuredType,
} from '../structured'
import {
  comparisonData,
  correctionsData,
  pageRevisionData,
  socialPostsData,
} from '@/components/agent/browser/__tests__/__fixtures__/structured'

describe('structuredType', () => {
  it('reads data.type and nothing else', () => {
    expect(structuredType(pageRevisionData())).toBe('page_revision')
    expect(structuredType({ type: 'press', format: 'press_release' })).toBe('press')
    expect(structuredType({ type: 'llms_txt', origin: 'https://notion.so' })).toBe('llms_txt')
    expect(structuredType({ type: 'whatever' })).toBe('')
    expect(structuredType(null)).toBe('')
    expect(structuredType('page_revision')).toBe('')
    expect(hasStructuredView({ type: 'press' })).toBe(false)
    expect(hasStructuredView({ type: 'llms_txt' })).toBe(false)
    expect(hasStructuredView(correctionsData())).toBe(true)
  })
})

describe('change kinds', () => {
  it('words each kind as contract 12d does', () => {
    expect(CHANGE_KINDS).toEqual({
      rewrite: 'Rewrite',
      add: 'Add',
      remove: 'Remove',
      metadata: 'Title and description',
      structured_data: 'Structured data',
    })
    expect(changeKindWord('metadata')).toBe('Title and description')
  })
})

describe('pageRevision', () => {
  it('resolves signal ids and drops unknown ones', () => {
    const view = pageRevision(pageRevisionData())
    expect(view.changes[0].signals.map((s) => s.id)).toEqual(['s2'])
    expect(view.changes[0].word).toBe('Rewrite')
    expect(view.source.words).toBe(1240)
    expect(view.current.meta_description).toBe('')
  })

  it('tolerates a first snapshot with only the parts read before writing', () => {
    const view = pageRevision({ type: 'page_revision', drafting: true, source: { url: 'https://notion.so/' } })
    expect(view.drafting).toBe(true)
    expect(view.changes).toEqual([])
    expect(view.source.words).toBeNull()
    expect(view.proposed).toEqual({ title: '', meta_description: '', h1: '', structured_data: [] })
  })

  it('reads the proposed metadata the model streams at the top level', () => {
    const view = pageRevision({ type: 'page_revision', drafting: true, title: 'Notion pricing', h1: 'Pricing', current: { title: 'Plans' } })
    expect(view.proposed).toMatchObject({ title: 'Notion pricing', meta_description: '', h1: 'Pricing' })
    expect(view.current.title).toBe('Plans')
  })
})

describe('comparison', () => {
  it('counts verified claims and leaves unchecked ones unknown', () => {
    const saved = comparison(comparisonData())
    expect(saved.verified).toBe(1)
    expect(saved.checked).toBe(true)
    expect(saved.claims[0].source.title).toBe('Evernote pricing')
    const partial = comparison({ type: 'comparison', drafting: true, claims: [{ about: 'you', text: 'x', source_id: 'p1', quote: 'y' }] })
    expect(partial.claims[0].verified).toBeNull()
    expect(partial.checked).toBe(false)
  })
})

describe('socialPosts', () => {
  it('takes the model strings while drafting and the server counts once saved', () => {
    const partial = socialPosts({ type: 'social_posts', drafting: true, posts: [{ channel: 'x', parts: ['Hello'] }] })
    expect(partial.posts[0].parts[0]).toEqual({ text: 'Hello', length: null, limit: null, over: null })
    const saved = socialPosts(socialPostsData())
    expect(saved.groups.map((g) => g.label)).toEqual(['LinkedIn', 'X thread'])
    expect(saved.posts[1].parts[1]).toMatchObject({ length: 301, limit: 280, over: true })
    expect(postCopyText(saved.posts[1])).toBe('Thread part one\n\nA very long part')
  })
})

describe('corrections', () => {
  it('reads saved letters and the model shape while drafting', () => {
    const saved = corrections(correctionsData())
    expect(saved.claim.engines).toEqual(['ChatGPT', 'Claude'])
    expect(saved.targets[0].letter).toContain('Dear G2 team')
    const partial = corrections({ type: 'corrections', drafting: true, targets: [{ source_id: 't1', quote: 'q', letter_markdown: 'Hi' }] })
    expect(partial.targets[0]).toMatchObject({ id: 't1', quote: 'q', letter: 'Hi' })
  })
})

describe('structuredTabLabel', () => {
  it('counts what each view shows', () => {
    expect(structuredTabLabel(pageRevisionData())).toBe('Changes (2)')
    expect(structuredTabLabel(comparisonData())).toBe('Sources and claims (1 of 2 verified)')
    expect(structuredTabLabel({ type: 'comparison', drafting: true, claims: [{ text: 'a' }] })).toBe('Sources and claims (1)')
    expect(structuredTabLabel(socialPostsData())).toBe('Posts (2)')
    expect(structuredTabLabel(correctionsData())).toBe('Letters (1)')
  })
})
