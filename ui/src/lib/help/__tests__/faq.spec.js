import { describe, expect, it } from 'vitest'
import docsSource from '@/pages/DocsPage.vue?raw'
import { FAQ_GROUPS, allFaqs, faqById, featuredFaqs, searchFaq } from '../faq'

const docsIds = new Set([...docsSource.matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]))

const textOf = (it) => [it.q, ...it.a, ...it.list].join(' ')

describe('FAQ content', () => {
  it('has unique ids and no empty group or answer', () => {
    const ids = allFaqs().map((it) => it.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(FAQ_GROUPS.map((g) => g.id)).size).toBe(FAQ_GROUPS.length)
    for (const g of FAQ_GROUPS) {
      expect(g.title).toBeTruthy()
      expect(g.items.length).toBeGreaterThan(0)
      for (const it of g.items) {
        expect(it.q.trim()).toBeTruthy()
        expect(it.a.length).toBeGreaterThan(0)
        it.a.forEach((p) => expect(p.trim()).toBeTruthy())
      }
    }
  })

  it('links every "Read more" to a section the Docs page has', () => {
    const anchors = allFaqs()
      .map((it) => it.docs)
      .filter(Boolean)
    expect(anchors.length).toBeGreaterThan(10)
    for (const anchor of anchors) expect(docsIds, anchor).toContain(anchor)
  })

  it('is plain text: no HTML, no emoji, no placeholder flags', () => {
    for (const it of allFaqs()) {
      const text = textOf(it)
      expect(text).not.toMatch(/<[a-z/]/i)
      expect(text).not.toMatch(/\[FLAG\]|TODO/)
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  it('states the free plan as 20 prompt runs a month, one prompt answered by one engine', () => {
    const free = faqById('plan-free')
    const text = textOf(free)
    expect(text).toContain('20 prompt runs a month')
    expect(text).toContain('One run is one prompt answered by one AI engine')
    expect(text).toMatch(/shared by all your projects and all engines/)
    expect(text).toMatch(/Ask AI/)
    expect(text).toMatch(/Autopilot/)
    // Free users never see dollars.
    expect(text).not.toMatch(/\$/)
    expect(textOf(faqById('plan-out'))).not.toMatch(/\$/)
    expect(textOf(faqById('pr-askai'))).toMatch(/every engine answer from Ask AI counts as one prompt run/)
  })

  it('carries none of the stale Support copy', () => {
    const all = allFaqs().map(textOf).join(' ')
    expect(all).not.toMatch(/trial button/i)
    expect(all.replace(/AI Overview/g, '')).not.toMatch(/Overview/)
    expect(all).not.toMatch(/10 prompts a month/)
  })

  it('names unconfigured engines plainly and never fakes their answers', () => {
    const text = textOf(faqById('eng-missing'))
    expect(text).toContain("ChatGPT isn't set up on this workspace")
    expect(text).toMatch(/never fills in an answer/)
    expect(text).not.toMatch(/_API_KEY/)
  })

  it('lists the seven report templates', () => {
    const text = textOf(faqById('rep-templates'))
    for (const name of [
      'Executive summary',
      'Google vs AI gap',
      'Competitor comparison',
      'Prompt deep dive',
      'Sources and citations',
      'Brand accuracy',
      'Change log since the last run',
    ]) {
      expect(text).toContain(name)
    }
  })
})

describe('faqById and featuredFaqs', () => {
  it('finds an item with its group, and nothing for an unknown id', () => {
    expect(faqById('ts-paid')).toMatchObject({ id: 'ts-paid', group: 'plans' })
    expect(faqById('nope')).toBeNull()
    expect(faqById(null)).toBeNull()
  })

  it('features four questions on Support and seven on Docs', () => {
    expect(featuredFaqs('support').map((it) => it.id)).toEqual(['gs-edit-setup', 'plan-free', 'plan-paid', 'ts-paid'])
    expect(featuredFaqs('docs')).toHaveLength(7)
    expect(featuredFaqs('elsewhere')).toEqual([])
  })
})

describe('searchFaq', () => {
  it('matches every word, case-insensitively, over questions, answers, bullets and tags', () => {
    expect(searchFaq('').length).toBe(0)
    expect(searchFaq('   ').length).toBe(0)
    expect(searchFaq('PAYWALL').map((it) => it.id)).toEqual(['ts-paid'])
    // A bullet only.
    expect(searchFaq('cloudflare').map((it) => it.id)).toContain('gs-traffic')
    // Both words, in any order.
    expect(searchFaq('runs free').map((it) => it.id)).toContain('plan-free')
    expect(searchFaq('zebra quantum')).toEqual([])
  })

  it('drops an item that has only some of the words', () => {
    expect(searchFaq('paywall').length).toBeGreaterThan(0)
    expect(searchFaq('paywall zebra')).toEqual([])
    expect(searchFaq('autopilot paused').map((it) => it.id)).toEqual(['ts-autopilot'])
  })
})
