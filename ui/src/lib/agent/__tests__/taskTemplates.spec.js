import { describe, expect, it } from 'vitest'
import { channelsText, fillTemplate, taskText } from '../taskTemplates'

describe('taskText (p2_contract.md 15d)', () => {
  it('drafts the Page Optimizer task, leaving out lines without values', () => {
    expect(
      taskText('page_optimizer', { url: 'https://notion.so/pricing', prompt: 'notion pricing', notes: 'Answer first' })
    ).toBe('Optimize https://notion.so/pricing so AI engines read and cite it.\nTarget prompt: "notion pricing".\nFocus: Answer first')
    expect(taskText('page_optimizer', { url: 'https://notion.so/pricing', prompt: '', notes: '  ' })).toBe(
      'Optimize https://notion.so/pricing so AI engines read and cite it.'
    )
  })

  it('drafts the comparison page task', () => {
    expect(
      taskText('comparison_page', {
        brand: 'Notion',
        competitor: 'Evernote',
        domain: 'evernote.com',
        url: 'https://evernote.com/pricing',
        prompt: 'notion vs evernote',
        notes: '',
      })
    ).toBe(
      'Write a comparison page: Notion compared with Evernote (evernote.com).\nAlso read their page https://evernote.com/pricing.\nTarget prompt: "notion vs evernote".'
    )
  })

  it('drafts social posts from a draft or a topic', () => {
    expect(
      taskText('social_posts', { channels: ['x', 'linkedin'], artifact_id: 'a1', artifact_title: 'Wiki guide', notes: 'Launch week' })
    ).toBe('Write LinkedIn posts and X posts that promote "Wiki guide" (artifact a1).\nFocus: Launch week')
    expect(taskText('social_posts', { channels: ['x_thread'], notes: 'Our new AI add-on' })).toBe(
      'Write an X thread about: Our new AI add-on'
    )
  })

  it('drafts each PR format, corrections with the fact_publishers text', () => {
    expect(taskText('pr_writer', { format: 'press_release', notes: 'Series C' })).toBe('Write a press release about: Series C')
    expect(taskText('pr_writer', { format: 'media_pitch', notes: 'AI add-on' })).toBe('Write a media pitch about: AI add-on')
    expect(
      taskText('pr_writer', {
        format: 'correction_request',
        claim: "Notion's Plus plan costs $8 per user per month",
        key: '9f2c|contradicted',
        evidence_label: 'https://notion.so/pricing',
        evidence_quote: 'Plus $10 per seat/month',
      })
    ).toBe(
      'Draft correction requests to the publishers whose pages repeat this claim: "Notion\'s Plus plan costs $8 per user per month" (Fact check claim 9f2c|contradicted).\nOur evidence (https://notion.so/pricing): "Plus $10 per seat/month"'
    )
  })

  it('drafts the llms.txt and messaging brief tasks, and the starter for the rest', () => {
    expect(taskText('llms_txt', { domain: 'notion.so', notes: '' })).toBe('Draft an llms.txt file for notion.so.')
    expect(taskText('messaging_brief', { brand: 'Notion', notes: 'Teams' })).toBe('Write a messaging brief for Notion.\nFocus: Teams')
    expect(taskText('gap_analyst', { starter: 'Research our brand' })).toBe('Research our brand')
  })
})

describe('channelsText', () => {
  it('joins the networks with commas and "and", in network order', () => {
    expect(channelsText(['linkedin'])).toBe('LinkedIn posts')
    expect(channelsText(['x_thread', 'linkedin', 'x'])).toBe('LinkedIn posts, X posts and an X thread')
    expect(channelsText([])).toBe('')
  })
})

describe('fillTemplate', () => {
  it('never prints a missing value', () => {
    expect(fillTemplate('A {a}.\nB {b}.\nC', { a: 'one', b: null })).toBe('A one.\nC')
    expect(fillTemplate('{a} and {b}', { a: 'x', b: undefined })).toBe('')
  })
})
