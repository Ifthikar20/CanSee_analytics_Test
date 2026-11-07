import { describe, expect, it } from 'vitest'
import { ASK_TEMPLATES, askAgentKey, askText, googlePlace, listText, pageFactLines } from '../askTemplates'
import { AGENT_KEY_LIST } from '@/lib/agent/types'
import { ASK_FROM_LABELS } from '@/lib/agent/askAgent'

describe('ASK_TEMPLATES', () => {
  it('lists the contract templates with their tab and agents', () => {
    expect(Object.keys(ASK_TEMPLATES)).toEqual([
      'fact_contradicted',
      'fact_unverifiable',
      'fact_publishers',
      'theme',
      'competitor_prompt',
      'citation_gap',
      'page_optimize',
      'crawler_fix',
      'idea',
      'fanout',
      'product',
    ])
    for (const t of Object.values(ASK_TEMPLATES)) {
      expect(ASK_FROM_LABELS[t.from], t.id).toBeTruthy()
      for (const agent of t.agents) expect(AGENT_KEY_LIST, t.id).toContain(agent)
      expect(t.agents).toContain(t.agent)
    }
    expect(ASK_TEMPLATES.fact_publishers).toMatchObject({ from: 'fact-check', agents: ['pr_writer'] })
    expect(ASK_TEMPLATES.citation_gap.from).toBe('citations')
  })
})

describe('askText', () => {
  it('fills fact_contradicted with page evidence, and picks the Page Optimizer', () => {
    const values = {
      engines: ['chatgpt', 'claude'],
      answers: 3,
      claim: "Notion's Plus plan costs $8 per user per month",
      evidence_quote: 'Plus $10 per seat/month',
      evidenceKind: 'page',
      evidence_url: 'https://notion.so/pricing',
    }
    expect(askText('fact_contradicted', values)).toBe(
      'AI engines state something about us that our own evidence contradicts.\n' +
        'Claim (ChatGPT and Claude, 3 answers): "Notion\'s Plus plan costs $8 per user per month"\n' +
        'Our evidence (https://notion.so/pricing): "Plus $10 per seat/month"\n' +
        'Draft the correction for https://notion.so/pricing, so the engines can find the right fact, and tell me where to publish it.',
    )
    expect(askAgentKey('fact_contradicted', values)).toBe('page_optimizer')
  })

  it('fills fact_contradicted with a brand fact as evidence, for our site, with the AEO Article Agent', () => {
    const values = { engines: ['chatgpt'], answers: 1, claim: 'Founded in 2015', evidence_quote: 'founded in 2013', evidenceKind: 'fact' }
    const text = askText('fact_contradicted', values)
    expect(text).toContain('Our evidence (brand fact): "founded in 2013"')
    expect(text).toContain('Draft the correction for our site, so')
    expect(text).toContain('Claim (ChatGPT, 1 answers): "Founded in 2015"')
    expect(askAgentKey('fact_contradicted', values)).toBe('aeo_article')
  })

  it('fills fact_unverifiable and fact_publishers', () => {
    expect(askText('fact_unverifiable', { claim: 'Notion has 100 million users', answers: 4 })).toBe(
      'AI engines state "Notion has 100 million users" about us (4 answers), and none of our pages or brand facts covers it. ' +
        'Check whether it is true and, if it is, draft a short section for our site that states it clearly.',
    )
    expect(
      askText('fact_publishers', {
        claim: 'Plus costs $8',
        key: '9f2c41aa0b1d77e3|contradicted',
        evidenceKind: 'page',
        evidence_url: 'https://notion.so/pricing',
        evidence_quote: 'Plus $10 per seat/month',
      }),
    ).toBe(
      'Draft correction requests to the publishers whose pages repeat this claim: "Plus costs $8" (Fact check claim 9f2c41aa0b1d77e3|contradicted).\n' +
        'Our evidence (https://notion.so/pricing): "Plus $10 per seat/month"',
    )
    expect(askAgentKey('fact_publishers', {})).toBe('pr_writer')
  })

  it('fills theme with an engine list and its example', () => {
    expect(
      askText('theme', {
        theme: 'easy to set up',
        tone: 'positive',
        answers: 9,
        engines: ['chatgpt', 'claude', 'perplexity'],
        quote: 'takes minutes to set up',
      }),
    ).toBe(
      'AI engines describe us as "easy to set up" (positive) in 9 answers (ChatGPT, Claude and Perplexity). Example: "takes minutes to set up"\n' +
        'Find what drives this description and draft content that reinforces or corrects it honestly.',
    )
    expect(askAgentKey('theme', {})).toBe('gap_analyst')
  })

  it('fills competitor_prompt and drops only the Google line without a Google check', () => {
    const base = { prompt: 'best note taking app for teams', competitor: 'Evernote', their_pct: 50, our_pct: 25 }
    expect(askText('competitor_prompt', { ...base, our_google: googlePlace(14), their_google: googlePlace(null) })).toBe(
      'For "best note taking app for teams", AI engines name Evernote in 50% of answers and us in 25%.\n' +
        'On Google we are #14 and they are not on page one.\n' +
        'Find why and draft a plan to close the gap.',
    )
    expect(askText('competitor_prompt', { ...base, our_google: null, their_google: undefined })).toBe(
      'For "best note taking app for teams", AI engines name Evernote in 50% of answers and us in 25%.\n' +
        'Find why and draft a plan to close the gap.',
    )
    expect(askText('competitor_prompt', { ...base, our_pct: 4.5 })).toContain('and us in 4.5%.')
  })

  it('fills citation_gap, crawler_fix, idea, fanout and product', () => {
    expect(
      askText('citation_gap', {
        prompt: 'best crm',
        competitor_citations: 6,
        domains: ['g2.com', 'capterra.com', 'reddit.com'],
      }),
    ).toBe(
      'For "best crm", AI engines cited competitor pages 6 times and ours never. Most cited domains: g2.com, capterra.com and reddit.com.\n' +
        'Draft a page that answers this prompt well enough to be cited.',
    )
    expect(
      askText('crawler_fix', { url: 'https://notion.so/pricing', failed_checks: ['Has a meta description', 'Text without JavaScript'] }),
    ).toBe(
      'Make https://notion.so/pricing readable for AI crawlers. Failed checks: Has a meta description and Text without JavaScript.\n' +
        'Explain each fix and draft the changes.',
    )
    expect(
      askText('idea', { idea: 'is notion free for teams', sources: ['People also ask', 'Engine search'], prompts: [] }),
    ).toBe('Draft an answer page for this question: "is notion free for teams".\nWhere it came from: People also ask and Engine search.')
    expect(
      askText('fanout', { prompt: 'best note app', engines: ['chatgpt'], query: 'best note apps 2026', google: googlePlace(4) }),
    ).toBe(
      'While answering "best note app", ChatGPT searched the web for "best note apps 2026".\n' +
        'On Google we are #4 for that search.\n' +
        'Draft a page that answers that search.',
    )
    // Not checked on Google: that line goes.
    expect(askText('fanout', { prompt: 'p', engines: ['claude'], query: 'q', google: googlePlace(null, { checked: false }) })).not.toContain(
      'On Google',
    )
    const product = {
      product: 'Acme X200 running shoe',
      google: '#3 of 40 results',
      named: 1,
      answers: 2,
      url: 'https://acme.com/x200',
      urlOnSite: true,
    }
    expect(askText('product', product)).toBe(
      'Improve how shopping answers show Acme X200 running shoe.\n' +
        'Google Shopping: #3 of 40 results.\n' +
        'Engines named it in 1 of 2 answers.\n' +
        'Product page: https://acme.com/x200.\n' +
        'Suggest fixes to the page and its product data, and draft them.',
    )
    expect(askAgentKey('product', product)).toBe('page_optimizer')
    expect(askAgentKey('product', { ...product, urlOnSite: false })).toBe('aeo_article')
    expect(askText('product', { ...product, url: '' })).not.toContain('Product page')
  })

  it('fills page_optimize with the measured facts, one per line', () => {
    const text = askText('page_optimize', {
      url: 'https://notion.so/pricing',
      facts: ['- Google: #3 for "notion pricing"', '- AI visits: 12 in the last 30 days'],
    })
    expect(text).toBe(
      'Optimize https://notion.so/pricing so AI engines read and cite it.\n' +
        'What Cansee measured:\n' +
        '- Google: #3 for "notion pricing"\n' +
        '- AI visits: 12 in the last 30 days\n' +
        'Suggest concrete changes to this page and draft them.',
    )
    expect(askText('page_optimize', { url: 'https://notion.so/', facts: [] })).not.toContain('{facts}')
  })

  it('formats counts and never writes null', () => {
    expect(askText('fact_unverifiable', { claim: 'x', answers: 1204 })).toContain('(1,204 answers)')
    expect(askText('fact_unverifiable', { claim: 'x', answers: null })).toBe('')
    expect(askText('nope', {})).toBe('')
    expect(askAgentKey('nope', {})).toBeNull()
  })
})

describe('helpers', () => {
  it('joins lists in prose', () => {
    expect(listText([])).toBe('')
    expect(listText(['a'])).toBe('a')
    expect(listText(['a', 'b'])).toBe('a and b')
    expect(listText(['a', 'b', 'c'])).toBe('a, b and c')
  })

  it('places a page on Google in words', () => {
    expect(googlePlace(4)).toBe('#4')
    expect(googlePlace(null)).toBe('not on page one')
    expect(googlePlace(null, { checked: false })).toBeNull()
  })

  it('builds the page_optimize facts from a Pages row, measured signals only', () => {
    const row = {
      url: 'https://notion.so/pricing',
      google: {
        best_position: 3,
        prompts: [
          { prompt_id: 'p2', text: 'notion plans', position: 7 },
          { prompt_id: 'p1', text: 'notion pricing', position: 3 },
        ],
      },
      citations: { citations: 6, cited_in_text: 0, answers: 4, engines: ['chatgpt', 'perplexity'] },
      ai_visits: { sessions: 12, by_assistant: { chatgpt: 9, perplexity: 3 } },
      crawler_requests: { requests: 40 },
      audit: { passed: 7, total: 9, failed: ['meta_description', 'text_without_js'], audited_at: '2026-11-05T10:05:00Z' },
    }
    expect(pageFactLines(row, { days: 30 })).toEqual([
      '- Google: #3 for "notion pricing"',
      '- Google: #7 for "notion plans"',
      '- AI citations: 6 in 4 answers (ChatGPT and Perplexity)',
      '- Retrieved by engines but never cited in the answer text',
      '- AI visits: 12 in the last 30 days',
      '- AI crawler requests: 40 in the last 7 days',
      '- Audit: 7 of 9 checks pass; failing: Has a meta description and Text without JavaScript',
    ])
  })

  it('sends no line for a source that is off, a zero or a page never audited', () => {
    const row = {
      google: { best_position: null, prompts: [] },
      citations: { citations: 0, cited_in_text: 0, answers: 0, engines: [] },
      ai_visits: null,
      crawler_requests: { requests: null, state: 'not_in_top' },
      audit: { passed: null, total: null, state: 'not_audited' },
    }
    expect(pageFactLines(row)).toEqual([])
    expect(pageFactLines({ audit: { passed: 9, total: 9, failed: [] } })).toEqual(['- Audit: 9 of 9 checks pass'])
    expect(pageFactLines(null)).toEqual([])
  })
})
