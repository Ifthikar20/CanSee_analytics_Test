import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
const copyText = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/agent/download', async (importOriginal) => ({ ...(await importOriginal()), copyText }))

import PageRevisionView from '../PageRevisionView.vue'
import ComparisonView from '../ComparisonView.vue'
import SocialPostsView from '../SocialPostsView.vue'
import CorrectionsView from '../CorrectionsView.vue'
import {
  comparisonData,
  correctionsData,
  pageRevisionData,
  socialPostsData,
} from '@/components/agent/browser/__tests__/__fixtures__/structured'

beforeEach(() => {
  toast.success.mockReset()
  copyText.mockClear()
})

describe('PageRevisionView', () => {
  it('shows the page read, the metadata now and proposed, and a card per change', async () => {
    const wrapper = mount(PageRevisionView, { props: { data: pageRevisionData() } })
    expect(wrapper.find('.ag-prv-source').text()).toContain('/pricing · read 2 hours ago · 1,240 words')
    expect(wrapper.find('.ag-prv-open').attributes('href')).toBe('https://notion.so/pricing')
    const rows = wrapper.findAll('.ag-prv-meta tbody tr')
    expect(rows.map((r) => r.find('th').text())).toEqual(['Title', 'Meta description', 'H1'])
    expect(rows[1].findAll('td')[0].text()).toBe('Not set')
    expect(rows[1].findAll('td')[1].text()).toBe('Compare the Free, Plus and Business plans.')

    const cards = wrapper.findAll('.ag-prv-change')
    expect(cards).toHaveLength(2)
    expect(cards[0].find('.ag-prv-word').text()).toBe('Rewrite')
    expect(cards[0].find('.ag-prv-section').text()).toBe('Pricing')
    expect(cards[0].find('.ag-prv-block.is-now').text()).toContain('Now')
    expect(cards[0].find('.ag-prv-block.is-now').text()).toContain('Plans for everyone')
    expect(cards[0].find('.ag-prv-block.is-proposed').text()).toContain('Proposed')
    expect(cards[0].find('.ag-prv-why').text()).toBe('Why: Engines search for the price.')
    // The unknown signal id is not shown.
    expect(cards[0].findAll('.ag-prv-signal').map((s) => s.text())).toEqual([
      'ChatGPT searched "notion pricing 2026" while answering "notion pricing" (2026-11-04)',
    ])
    // An added section has nothing to replace.
    expect(cards[1].find('.ag-prv-block.is-now').exists()).toBe(false)

    await cards[0].findAll('button').find((b) => b.text() === 'Copy proposed text').trigger('click')
    await flushPromises()
    expect(copyText).toHaveBeenCalledWith('Plus costs $10 per seat each month.')
    expect(toast.success).toHaveBeenCalledWith('Copied')
  })

  it('says when no change was proposed, and shows what arrived while drafting', () => {
    const none = mount(PageRevisionView, { props: { data: pageRevisionData({ changes: [] }) } })
    expect(none.text()).toContain('No changes were proposed.')
    const live = mount(PageRevisionView, { props: { data: { type: 'page_revision', drafting: true }, live: true } })
    expect(live.text()).not.toContain('No changes were proposed.')
    expect(live.find('.ag-prv-drafting').text()).toBe('Drafting…')
    expect(live.text()).not.toContain('Copy proposed text')
  })
})

describe('ComparisonView', () => {
  it('lists each statement with whom it is about, its source and whether its quote was found', () => {
    const wrapper = mount(ComparisonView, { props: { data: comparisonData() } })
    expect(wrapper.findAll('thead th').map((t) => t.text())).toEqual(['Statement', 'About', 'Source', 'Quote', 'Checked'])
    const rows = wrapper.findAll('tbody tr')
    expect(rows[0].findAll('td')[1].text()).toBe('Evernote')
    expect(rows[0].find('a').attributes('href')).toBe('https://evernote.com/pricing')
    expect(rows[0].text()).toContain('"$14.99/month"')
    expect(rows[0].find('.ag-cmv-check').text()).toBe('Verified')
    expect(rows[1].findAll('td')[1].text()).toBe('You')
    expect(rows[1].find('.ag-cmv-check').text()).toBe('Not verified')
    const sources = wrapper.findAll('.ag-cmv-source')
    expect(sources[0].text()).toContain('Read just now')
    expect(sources[1].text()).toContain("Couldn't load")
  })

  it('marks claims the server has not checked yet while drafting', () => {
    const wrapper = mount(ComparisonView, {
      props: { data: { type: 'comparison', drafting: true, claims: [{ about: 'you', text: 'We sync offline.', source_id: 'p1', quote: 'offline' }] } },
    })
    expect(wrapper.find('.ag-cmv-check').text()).toBe('Not checked')
    expect(wrapper.find('.ag-cmv-drafting').exists()).toBe(true)
  })
})

describe('SocialPostsView', () => {
  it('groups posts by network with the server counts and flags over-limit text without cutting it', async () => {
    const wrapper = mount(SocialPostsView, { props: { data: socialPostsData() } })
    expect(wrapper.findAll('.ag-spv-title').map((t) => t.text())).toEqual(['LinkedIn', 'X thread'])
    const counts = wrapper.findAll('.ag-spv-count').map((c) => c.text())
    expect(counts).toEqual(['22 / 3,000', '15 / 280', '301 / 280, over the limit'])
    expect(wrapper.findAll('.ag-spv-count.is-over')).toHaveLength(1)
    expect(wrapper.text()).toContain('A very long part')
    expect(wrapper.find('.ag-spv-note').text()).toBe('X counts each link as 23 characters and some characters as two.')
    const thread = wrapper.findAll('.ag-spv-post')[1]
    await thread.findAll('button').find((b) => b.text() === 'Copy').trigger('click')
    await flushPromises()
    expect(copyText).toHaveBeenCalledWith('Thread part one\n\nA very long part')
  })

  it('waits for the server count while drafting', () => {
    const wrapper = mount(SocialPostsView, {
      props: { data: { type: 'social_posts', drafting: true, posts: [{ channel: 'linkedin', parts: ['Hello'] }] }, live: true },
    })
    expect(wrapper.find('.ag-spv-count').text()).toBe('Counted when the draft is saved.')
    expect(wrapper.find('.ag-spv-note').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Copy')
  })
})

describe('CorrectionsView', () => {
  it('shows the claim, the evidence and a letter per page that repeats it', async () => {
    const wrapper = mount(CorrectionsView, { props: { data: correctionsData() } })
    expect(wrapper.find('.ag-crv-claim-text').text()).toBe('"Notion\'s Plus plan costs $8 per user per month"')
    expect(wrapper.find('.ag-crv-meta').text()).toBe('3 answers · ChatGPT, Claude')
    expect(wrapper.find('.ag-crv-evidence').text()).toContain('Your evidence: "Plus $10 per seat/month"')
    expect(wrapper.find('.ag-crv-evidence a').attributes('href')).toBe('https://notion.so/pricing')
    const target = wrapper.find('.ag-crv-target')
    expect(target.find('.ag-crv-publisher').text()).toBe('g2.com')
    expect(target.find('.ag-crv-says').text()).toBe('What it says: "Plus at $8 per user"')
    expect(target.find('.ag-crv-letter strong').text()).toBe('$10')
    await target.findAll('button').find((b) => b.text() === 'Copy letter').trigger('click')
    await flushPromises()
    expect(copyText).toHaveBeenCalledWith('Dear G2 team,\n\nThe Plus plan costs **$10** per seat.')
    const lists = wrapper.findAll('.ag-crv-list')
    expect(lists[0].text()).toContain("Pages that don't repeat the claim")
    expect(lists[0].text()).toContain('capterra.com')
    expect(lists[1].text()).toContain("Pages that couldn't be read")
    expect(lists[1].text()).toContain('The page took too long to load.')
  })

  it('says when none of the cited pages repeats the claim', () => {
    const wrapper = mount(CorrectionsView, { props: { data: correctionsData({ targets: [] }) } })
    expect(wrapper.find('.ag-crv-none').text()).toBe('None of the 2 pages these answers cite repeats the claim.')
  })
})
