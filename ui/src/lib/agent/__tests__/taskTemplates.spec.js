import { describe, expect, it } from 'vitest'
import {
  FORM_FIELDS,
  RESEARCH_AGENTS_KEY,
  TASK_FORMS,
  channelsText,
  competitorsText,
  entryAgentOf,
  fieldLabel,
  fillTemplate,
  formTaskText,
  formTemplate,
  formTemplates,
  hasTaskForm,
  missingFields,
  taskText,
  templatePlan,
} from '../taskTemplates'
import { AGENT_KEY_LIST } from '../types'

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

describe('task templates of the general agents and the research agents', () => {
  const GENERAL = ['gap_analyst', 'landing_page', 'aeo_article', 'ad_campaign']
  const EVERNOTE = { name: 'Evernote', domain: 'evernote.com' }
  const CODA = { name: 'Coda', domain: 'coda.io' }

  it('gives the four general agents and the research agents 2 to 4 templates each, and no specialist', () => {
    expect(Object.keys(TASK_FORMS).sort()).toEqual([...GENERAL, RESEARCH_AGENTS_KEY].sort())
    for (const agent of Object.keys(TASK_FORMS)) {
      const list = formTemplates(agent)
      expect(list.length, agent).toBeGreaterThanOrEqual(2)
      expect(list.length, agent).toBeLessThanOrEqual(4)
      expect(new Set(list.map((t) => t.key)).size, agent).toBe(list.length)
      for (const t of list) {
        expect(t.label, `${agent}.${t.key}`).toBeTruthy()
        expect(t.summary, `${agent}.${t.key}`).toMatch(/\.$/)
        // Every field a template shows or needs is a known field, and every needed one is shown.
        for (const f of t.fields) expect(FORM_FIELDS[f], `${agent}.${t.key}.${f}`).toBeTruthy()
        for (const f of t.required) expect(t.fields, `${agent}.${t.key}`).toContain(f)
        // Every {name} in the text is a field of the template or max_prompts.
        const names = [...t.text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1])
        for (const n of names) expect([...t.fields, 'max_prompts'], `${agent}.${t.key}`).toContain(n)
        // Plain text: no emoji, no dollar amounts.
        expect(t.text + t.label + t.summary).not.toMatch(/\p{Extended_Pictographic}|\$/u)
      }
    }
    for (const agent of ['page_optimizer', 'comparison_page', 'social_posts', 'pr_writer', 'llms_txt', 'messaging_brief', 'nope', '', null]) {
      expect(hasTaskForm(agent), String(agent)).toBe(false)
      expect(formTemplates(agent)).toEqual([])
      expect(formTemplate(agent)).toBeNull()
      expect(formTaskText(agent, 'x', { notes: 'a' })).toBe('')
      expect(missingFields(agent, 'x', {})).toEqual([])
    }
  })

  it('opens the research agents in a Gap Analyst chat and the others as themselves', () => {
    expect(entryAgentOf(RESEARCH_AGENTS_KEY)).toBe('gap_analyst')
    for (const agent of GENERAL) expect(entryAgentOf(agent)).toBe(agent)
    expect(entryAgentOf('page_optimizer')).toBe('page_optimizer')
    // Every chat agent is a real agent key.
    for (const agent of Object.keys(TASK_FORMS)) expect(AGENT_KEY_LIST).toContain(entryAgentOf(agent))
  })

  it('falls back to the first template for an unknown key', () => {
    expect(formTemplate('landing_page', 'nope').key).toBe('search')
    expect(formTemplate('landing_page').key).toBe('search')
    expect(formTemplate('landing_page', 'offering').key).toBe('offering')
  })

  it('labels optional fields', () => {
    const search = formTemplate('landing_page', 'search')
    expect(fieldLabel(search, 'search')).toBe('Search or prompt')
    expect(fieldLabel(search, 'offering')).toBe('Offering (optional)')
    expect(fieldLabel(search, 'notes')).toBe('Focus (optional)')
    expect(fieldLabel(formTemplate('landing_page', 'offering'), 'offering')).toBe('Offering')
    expect(fieldLabel(null, 'cta')).toBe('Call to action (optional)')
  })

  it('drafts the research presets with the prompts one research covers', () => {
    expect(formTaskText(RESEARCH_AGENTS_KEY, 'gap', { max_prompts: 5 })).toBe(
      'Run the research agents on our tracked prompts and compare where Google ranks us with how each AI engine answers.\nUse up to 5 of our tracked prompts.'
    )
    // Without a known count the line is left out rather than guessed.
    expect(formTaskText(RESEARCH_AGENTS_KEY, 'gap', { max_prompts: null, notes: 'Pricing prompts first' })).toBe(
      'Run the research agents on our tracked prompts and compare where Google ranks us with how each AI engine answers.\nFocus: Pricing prompts first'
    )
    expect(formTaskText(RESEARCH_AGENTS_KEY, 'competitors', { competitors: [EVERNOTE, CODA], max_prompts: 3 })).toBe(
      'Run the research agents to compare us with Evernote (evernote.com) and Coda (coda.io) on our tracked prompts.\nRead 2 competitor pages per prompt and list what their pages do that ours do not.\nUse up to 3 of our tracked prompts.'
    )
    expect(formTaskText(RESEARCH_AGENTS_KEY, 'sources', { max_prompts: 4 })).toBe(
      'Run the research agents on our tracked prompts to find the sources the AI engines cite.\nList which sources mention us, which mention only our competitors, and where we should be listed.\nUse up to 4 of our tracked prompts.'
    )
    expect(formTaskText(RESEARCH_AGENTS_KEY, 'prompt', { prompt: '  best note app  ', max_prompts: 5 })).toBe(
      'Run the research agents on one prompt: "best note app".\nCompare where Google ranks us with how each AI engine answers it.'
    )
  })

  it('states the research plan a preset asks for beyond the default', () => {
    // The competitor check asks for 2 competitor pages a prompt, and says so.
    expect(templatePlan(RESEARCH_AGENTS_KEY, 'competitors')).toEqual({ competitorPages: 2 })
    expect(formTemplate(RESEARCH_AGENTS_KEY, 'competitors').text).toContain('Read 2 competitor pages per prompt')
    for (const key of ['gap', 'sources', 'prompt']) {
      expect(templatePlan(RESEARCH_AGENTS_KEY, key), key).toEqual({})
      expect(formTemplate(RESEARCH_AGENTS_KEY, key).text, key).not.toMatch(/competitor pages/)
    }
    expect(templatePlan('landing_page', 'search')).toEqual({})
    expect(templatePlan('page_optimizer', 'x')).toEqual({})
    expect(templatePlan(null)).toEqual({})
  })

  it('drafts the Gap Analyst templates', () => {
    expect(formTaskText('gap_analyst', 'tracked', {})).toBe(
      'Research how we rank on Google and in AI answers for our tracked prompts, and compare the two.'
    )
    expect(formTaskText('gap_analyst', 'prompt', { prompt: 'notion pricing', notes: 'Mobile' })).toBe(
      'Research how we rank on Google and in AI answers for this prompt: "notion pricing", and compare the two.\nFocus: Mobile'
    )
    expect(formTaskText('gap_analyst', 'competitors', { competitors: [EVERNOTE] })).toBe(
      'Compare how Google and the AI engines rank us against Evernote (evernote.com) for our tracked prompts.'
    )
  })

  it('drafts the Landing Page, AEO Article and Ad Campaign templates', () => {
    expect(formTaskText('landing_page', 'search', { search: 'team wiki', offering: 'Notion Teams', cta: 'Start free' })).toBe(
      'Draft a landing page for the search "team wiki".\nOffering: Notion Teams\nCall to action: Start free'
    )
    expect(formTaskText('landing_page', 'missing', {})).toBe('Draft a landing page for the tracked prompt where we are missing the most.')
    expect(formTaskText('landing_page', 'offering', { offering: 'Notion AI', cta: '' })).toBe('Draft a landing page for our offering: Notion AI.')
    expect(formTaskText('aeo_article', 'question', { question: 'What is a team wiki?', audience: 'IT leads' })).toBe(
      'Write an answer-first article for the question "What is a team wiki?".\nAudience: IT leads'
    )
    expect(formTaskText('aeo_article', 'top', { audience: '' })).toBe(
      'Write an article that answers the question our buyers ask most, from our tracked prompts.'
    )
    expect(formTaskText('aeo_article', 'uncited', {})).toBe(
      'Write an article for the tracked prompt where AI engines cite other sites but not ours.'
    )
    expect(
      formTaskText('ad_campaign', 'offering', { offering: 'Notion AI', region: 'United States', url: 'https://notion.so/ai', notes: 'B2B only' })
    ).toBe('Build a Google Search ad campaign for Notion AI.\nRegion: United States\nLanding page: https://notion.so/ai\nFocus: B2B only')
    expect(formTaskText('ad_campaign', 'main', { region: 'UK' })).toBe('Build a Google Search ad campaign for our main offering.\nRegion: UK')
    expect(formTaskText('ad_campaign', 'gaps', {})).toBe(
      'Build a Google Search ad campaign for the tracked prompts where Google and the AI engines do not show us.'
    )
  })

  it('ignores values of fields the template does not show', () => {
    // Typed under "For one search", then switched to "Where we are missing most".
    expect(formTaskText('landing_page', 'missing', { search: 'team wiki', offering: 'Teams' })).toBe(
      'Draft a landing page for the tracked prompt where we are missing the most.\nOffering: Teams'
    )
    expect(formTaskText('gap_analyst', 'tracked', { competitors: [EVERNOTE], prompt: 'x' })).toBe(
      'Research how we rank on Google and in AI answers for our tracked prompts, and compare the two.'
    )
  })

  it('clips each field to its limit', () => {
    const long = 'a'.repeat(400)
    const text = formTaskText('gap_analyst', 'prompt', { prompt: long })
    expect(text).toContain(`"${'a'.repeat(FORM_FIELDS.prompt.max)}"`)
    expect(text).not.toContain('a'.repeat(FORM_FIELDS.prompt.max + 1))
    const notes = formTaskText('gap_analyst', 'tracked', { notes: 'b'.repeat(1200) })
    expect(notes.endsWith(`Focus: ${'b'.repeat(1000)}`)).toBe(true)
  })

  it('names the required fields that are still empty', () => {
    expect(missingFields('landing_page', 'search', {})).toEqual(['search'])
    expect(missingFields('landing_page', 'search', { search: '   ' })).toEqual(['search'])
    expect(missingFields('landing_page', 'search', { search: 'wiki' })).toEqual([])
    expect(missingFields('landing_page', 'missing', {})).toEqual([])
    expect(missingFields(RESEARCH_AGENTS_KEY, 'competitors', { competitors: [] })).toEqual(['competitors'])
    expect(missingFields(RESEARCH_AGENTS_KEY, 'competitors', { competitors: 'Evernote' })).toEqual(['competitors'])
    expect(missingFields(RESEARCH_AGENTS_KEY, 'competitors', { competitors: [EVERNOTE] })).toEqual([])
    expect(missingFields(RESEARCH_AGENTS_KEY, 'prompt', { prompt: '' })).toEqual(['prompt'])
    expect(missingFields('ad_campaign', 'offering', null)).toEqual(['offering'])
  })

  it('words competitors with their domains, without repeating a domain-only name', () => {
    expect(competitorsText([])).toBe('')
    expect(competitorsText(null)).toBe('')
    expect(competitorsText([EVERNOTE])).toBe('Evernote (evernote.com)')
    expect(competitorsText([{ domain: 'coda.io' }])).toBe('coda.io')
    expect(competitorsText([{ name: 'Coda', domain: '' }, null, {}, EVERNOTE, { name: 'Obsidian', domain: 'obsidian.md' }])).toBe(
      'Coda, Evernote (evernote.com) and Obsidian (obsidian.md)'
    )
  })
})
