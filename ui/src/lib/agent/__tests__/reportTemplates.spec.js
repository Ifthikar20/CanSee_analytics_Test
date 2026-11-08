import { describe, expect, it } from 'vitest'
import {
  PROMPT_PICKS,
  REPORT_TEMPLATE_KEYS,
  SECTION_VIEWS,
  asksEngines,
  draftText,
  fallbackTemplates,
  findTemplate,
  isReportTemplateKey,
  normalizeTemplate,
  promptRunsLine,
  requirementBadges,
  sectionView,
  templatesFromCatalog,
} from '../reportTemplates'

// One catalog item as GET agent/report-templates/ serves it (reports-be contract).
function item(overrides = {}) {
  return {
    id: 'prompt_deep_dive',
    name: 'Prompt deep dive',
    purpose: 'One tracked prompt, end to end.',
    header_fields: ['template', 'project', 'captured_at', 'data', 'engines', 'locations', 'prompts'],
    sections: [
      { title: 'Verdict and gap', shows: 'The gap.', source: 'Prompt gap', repeat: null },
      { title: 'Method', shows: 'When.', source: 'Tools', repeat: null },
    ],
    requirements: { google: 'required', engines: 'saved', research_agents: false, runs_checks: true, note: 'Searches Google.' },
    available: true,
    unavailable: null,
    limitations: [],
    ...overrides,
  }
}

describe('report template keys', () => {
  it('are the seven of the backend catalog, in its order', () => {
    expect(REPORT_TEMPLATE_KEYS).toEqual([
      'executive_summary',
      'google_ai_gap',
      'competitor_comparison',
      'prompt_deep_dive',
      'sources_citations',
      'brand_accuracy',
      'change_log',
    ])
    expect(Object.isFrozen(REPORT_TEMPLATE_KEYS)).toBe(true)
  })

  it('recognises only those keys', () => {
    for (const key of REPORT_TEMPLATE_KEYS) expect(isReportTemplateKey(key)).toBe(true)
    for (const bad of ['', 'Executive_summary', 'weekly', null, undefined, 3, {}, ['change_log'], '__proto__', 'toString']) {
      expect(isReportTemplateKey(bad)).toBe(false)
    }
  })

  it('has a prompt picker setting and a section map for every key', () => {
    expect(Object.keys(PROMPT_PICKS)).toEqual(REPORT_TEMPLATE_KEYS)
    expect(Object.keys(SECTION_VIEWS)).toEqual(REPORT_TEMPLATE_KEYS)
    expect(PROMPT_PICKS.prompt_deep_dive).toEqual({ min: 1, max: 1 })
    expect(PROMPT_PICKS.google_ai_gap).toEqual({ min: 0, max: 4 })
    expect(PROMPT_PICKS.executive_summary.max).toBe(0)
  })
})

describe('fallbackTemplates', () => {
  it('lists the seven with every section ending in Method, availability unknown', () => {
    const list = fallbackTemplates()
    expect(list.map((t) => t.id)).toEqual(REPORT_TEMPLATE_KEYS)
    for (const t of list) {
      expect(t.name).toBeTruthy()
      expect(t.purpose).toBeTruthy()
      expect(t.sections.at(-1).title).toBe('Method')
      expect(t.available).toBe(true)
      expect(t.unavailable).toBeNull()
      expect(t.limitations).toEqual([])
      expect(t.checked).toBe(false)
      expect(t.requirements.note).toBeTruthy()
    }
  })

  it('repeats one section per prompt only in the Google vs AI gap', () => {
    const repeated = fallbackTemplates().flatMap((t) => t.sections.filter((s) => s.repeat === 'prompt').map(() => t.id))
    expect(repeated).toEqual(['google_ai_gap'])
  })

  it('gives each template the extra header field of the contract', () => {
    const extra = Object.fromEntries(fallbackTemplates().map((t) => [t.id, t.header_fields.slice(6)]))
    expect(extra).toEqual({
      executive_summary: [],
      google_ai_gap: [],
      competitor_comparison: ['competitors'],
      prompt_deep_dive: ['prompts'],
      sources_citations: [],
      brand_accuracy: [],
      change_log: ['compared'],
    })
  })

  it('returns fresh copies, so a caller cannot change the next list', () => {
    const first = fallbackTemplates()
    first[0].sections.push({ title: 'Changed' })
    first[0].header_fields.push('changed')
    const second = fallbackTemplates()
    expect(second[0].sections.map((s) => s.title)).not.toContain('Changed')
    expect(second[0].header_fields).not.toContain('changed')
  })

  it('says no dollars and has no emoji in any text', () => {
    const text = JSON.stringify(fallbackTemplates())
    expect(text).not.toMatch(/\$/)
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})

describe('normalizeTemplate', () => {
  it('keeps the catalog text and marks it checked', () => {
    const t = normalizeTemplate(item())
    expect(t).toMatchObject({
      id: 'prompt_deep_dive',
      name: 'Prompt deep dive',
      purpose: 'One tracked prompt, end to end.',
      available: true,
      unavailable: null,
      checked: true,
      prompts: { min: 1, max: 1 },
    })
    expect(t.sections).toEqual([
      { title: 'Verdict and gap', shows: 'The gap.', repeat: null },
      { title: 'Method', shows: 'When.', repeat: null },
    ])
    expect(t.requirements).toEqual({
      google: 'required',
      engines: 'saved',
      research_agents: false,
      runs_checks: true,
      note: 'Searches Google.',
    })
  })

  it('returns null for anything but a known key', () => {
    expect(normalizeTemplate(null)).toBeNull()
    expect(normalizeTemplate('prompt_deep_dive')).toBeNull()
    expect(normalizeTemplate(item({ id: 'weekly_digest' }))).toBeNull()
    expect(normalizeTemplate(item({ id: undefined }))).toBeNull()
  })

  it('fills missing or malformed fields from the local copy', () => {
    const t = normalizeTemplate({
      id: 'change_log',
      name: '  ',
      sections: [{ shows: 'no title' }, null, 'x'],
      header_fields: 'compared',
      requirements: { google: 'sometimes', engines: 42, research_agents: 'yes', runs_checks: null, note: '' },
    })
    expect(t.name).toBe('Change log since the last run')
    expect(t.purpose).toBe('What moved since the previous check of each prompt, and what to do next.')
    expect(t.sections.map((s) => s.title)).toEqual(['What changed', 'Unchanged', 'Visibility trend', 'Next actions', 'Method'])
    expect(t.header_fields).toContain('compared')
    expect(t.requirements).toEqual({
      google: 'saved',
      engines: 'saved',
      research_agents: false,
      runs_checks: false,
      note: "Compares each prompt's latest engine answer with the one before it. Runs no new checks.",
    })
  })

  it('reads an unknown repeat as no repeat', () => {
    const t = normalizeTemplate(item({ sections: [{ title: 'A', shows: '', repeat: 'engine' }] }))
    expect(t.sections[0].repeat).toBeNull()
  })

  it('keeps the plain reason of an unavailable template, and the setting only when the server sent it', () => {
    const customer = normalizeTemplate(
      item({ available: false, unavailable: { code: 'google_not_configured', message: "Google search isn't set up on this workspace." } }),
    )
    expect(customer.available).toBe(false)
    expect(customer.unavailable).toEqual({ code: 'google_not_configured', message: "Google search isn't set up on this workspace." })
    const staff = normalizeTemplate(
      item({
        available: false,
        unavailable: { code: 'google_not_configured', message: "Google search isn't set up on this workspace.", setting: 'SERPAPI_KEY' },
      }),
    )
    expect(staff.unavailable.setting).toBe('SERPAPI_KEY')
  })

  it('names a reason when the server said unavailable without one', () => {
    const t = normalizeTemplate(item({ available: false, unavailable: null }))
    expect(t.available).toBe(false)
    expect(t.unavailable).toEqual({ code: '', message: "Prompt deep dive isn't available on this workspace." })
  })

  it('treats a reason with available true as unavailable', () => {
    const t = normalizeTemplate(item({ available: true, unavailable: { code: 'tools_missing', message: 'Not here.' } }))
    expect(t.available).toBe(false)
    expect(t.unavailable.message).toBe('Not here.')
  })

  it('keeps only limitations with a message', () => {
    const t = normalizeTemplate(
      item({
        limitations: [
          { code: 'engine_not_configured', message: "Grok isn't set up on this workspace.", setting: 'XAI_API_KEY' },
          { code: 'engine_not_configured', message: "Claude isn't set up on this workspace." },
          { code: 'empty', message: '   ' },
          null,
          'text',
        ],
      }),
    )
    expect(t.limitations).toEqual([
      { code: 'engine_not_configured', message: "Grok isn't set up on this workspace.", setting: 'XAI_API_KEY' },
      { code: 'engine_not_configured', message: "Claude isn't set up on this workspace." },
    ])
  })

  it('ignores availability in the fallback: the server decides on send', () => {
    const t = normalizeTemplate(item({ available: false, unavailable: { message: 'No' }, limitations: [{ message: 'x' }] }), {
      fallback: true,
    })
    expect(t.available).toBe(true)
    expect(t.unavailable).toBeNull()
    expect(t.limitations).toEqual([])
    expect(t.checked).toBe(false)
  })
})

describe('templatesFromCatalog', () => {
  it('keeps the catalog order and drops unknown keys and repeats', () => {
    const list = templatesFromCatalog([
      item({ id: 'change_log', name: 'Change log' }),
      item({ id: 'nope' }),
      item({ id: 'executive_summary', name: 'Exec' }),
      item({ id: 'change_log', name: 'Second copy' }),
    ])
    expect(list.map((t) => [t.id, t.name])).toEqual([
      ['change_log', 'Change log'],
      ['executive_summary', 'Exec'],
    ])
  })

  it('reads a paginated body too', () => {
    expect(templatesFromCatalog({ results: [item()] }).map((t) => t.id)).toEqual(['prompt_deep_dive'])
  })

  it('returns an empty list for nothing usable', () => {
    for (const bad of [null, undefined, {}, 'x', [], [null], [{ id: 'unknown' }]]) expect(templatesFromCatalog(bad)).toEqual([])
  })
})

describe('findTemplate', () => {
  it('prefers the loaded list, then the local copy', () => {
    const loaded = [normalizeTemplate(item({ name: 'From the server' }))]
    expect(findTemplate('prompt_deep_dive', loaded).name).toBe('From the server')
    expect(findTemplate('change_log', loaded).name).toBe('Change log since the last run')
    expect(findTemplate('change_log').id).toBe('change_log')
    expect(findTemplate('unknown', loaded)).toBeNull()
    expect(findTemplate(null)).toBeNull()
  })
})

describe('sectionView', () => {
  it('maps each known section to its preview view', () => {
    const t = findTemplate('executive_summary')
    expect(t.sections.map((s) => sectionView(t.id, s))).toEqual(['kpis', 'gap_mix', 'leaderboard', 'gap_rows', 'actions', 'method'])
  })

  it('previews a per-prompt section as the prompt detail, whatever its title', () => {
    expect(sectionView('google_ai_gap', { title: 'Anything', repeat: 'prompt' })).toBe('prompt_detail')
  })

  it('falls back to text for an unknown title, template or section', () => {
    expect(sectionView('executive_summary', { title: 'New section' })).toBe('text')
    expect(sectionView('unknown', { title: 'Key numbers' })).toBe('text')
    expect(sectionView('executive_summary', null)).toBe('text')
  })

  it('gives every fallback section a view other than text', () => {
    for (const t of fallbackTemplates()) {
      for (const s of t.sections) expect(sectionView(t.id, s), `${t.id}: ${s.title}`).not.toBe('text')
    }
  })
})

describe('requirementBadges', () => {
  it('says what each template needs', () => {
    const labels = Object.fromEntries(fallbackTemplates().map((t) => [t.id, requirementBadges(t).map((b) => b.label)]))
    expect(labels).toEqual({
      executive_summary: ['Saved engine answers', 'No new checks'],
      google_ai_gap: ['Google results if set up', 'Asks the AI engines', 'Research agents'],
      competitor_comparison: ['Google results if set up', 'Asks the AI engines', 'Research agents'],
      prompt_deep_dive: ['Needs Google results', 'Saved engine answers'],
      sources_citations: ['Saved engine answers', 'No new checks'],
      brand_accuracy: ['Saved engine answers', 'No new checks'],
      change_log: ['Saved engine answers', 'No new checks'],
    })
  })

  it('handles required engines and nothing at all', () => {
    const t = normalizeTemplate(item({ requirements: { google: 'not_used', engines: 'required', runs_checks: true } }))
    expect(requirementBadges(t).map((b) => b.key)).toEqual(['engines'])
    expect(requirementBadges(null)).toEqual([])
    expect(requirementBadges({})).toEqual([])
  })
})

describe('promptRunsLine', () => {
  const gap = () => findTemplate('google_ai_gap')

  it('counts the free prompt runs left for a template that asks the engines', () => {
    expect(promptRunsLine(gap(), { unlimited: false, limit: 20, remaining: 12 })).toBe(
      'Each AI engine answer uses a free prompt run. 12 free prompt runs left.',
    )
    expect(promptRunsLine(gap(), { unlimited: false, remaining: 1 })).toBe(
      'Each AI engine answer uses a free prompt run. 1 free prompt run left.',
    )
    expect(promptRunsLine(gap(), { unlimited: false, remaining: 0 })).toBe(
      "Each AI engine answer uses a free prompt run, and this month's are used up.",
    )
    expect(promptRunsLine(gap(), { unlimited: false, remaining: -3 })).toBe(
      "Each AI engine answer uses a free prompt run, and this month's are used up.",
    )
  })

  it('says nothing for paid plans, an unknown balance or a template that asks no engine', () => {
    expect(promptRunsLine(gap(), { unlimited: true, remaining: null })).toBe('')
    expect(promptRunsLine(gap(), null)).toBe('')
    expect(promptRunsLine(gap(), { unlimited: false, remaining: null })).toBe('')
    expect(promptRunsLine(gap(), { unlimited: false, remaining: 'many' })).toBe('')
    expect(promptRunsLine(gap(), { remaining: 5 })).toBe('')
    expect(promptRunsLine(findTemplate('executive_summary'), { unlimited: false, remaining: 5 })).toBe('')
    expect(promptRunsLine(findTemplate('prompt_deep_dive'), { unlimited: false, remaining: 5 })).toBe('')
  })

  it('never shows dollars', () => {
    expect(promptRunsLine(gap(), { unlimited: false, remaining: 7 })).not.toMatch(/\$/)
  })

  it('agrees with asksEngines', () => {
    expect(fallbackTemplates().filter(asksEngines).map((t) => t.id)).toEqual(['google_ai_gap', 'competitor_comparison'])
    expect(asksEngines(null)).toBe(false)
  })

  it('needs both new checks and an engine requirement that asks', () => {
    const t = (requirements) => normalizeTemplate({ id: 'google_ai_gap', requirements })
    // A catalog that says the gap report runs no new checks today: no runs line.
    const saved = t({ engines: 'optional', runs_checks: false })
    expect(asksEngines(saved)).toBe(false)
    expect(promptRunsLine(saved, { unlimited: false, remaining: 5 })).toBe('')
    expect(asksEngines(t({ engines: 'required', runs_checks: true }))).toBe(true)
    expect(asksEngines(t({ engines: 'saved', runs_checks: true }))).toBe(false)
    expect(asksEngines(t({ engines: 'not_used', runs_checks: true }))).toBe(false)
  })
})

describe('draftText', () => {
  it('drafts each template for the project', () => {
    const drafts = Object.fromEntries(REPORT_TEMPLATE_KEYS.map((key) => [key, draftText(key, { brand: 'Notion' })]))
    expect(drafts).toEqual({
      executive_summary: 'Write an executive summary report for Notion.',
      google_ai_gap: 'Write a Google vs AI gap report for Notion.',
      competitor_comparison: 'Write a competitor comparison report for Notion.',
      prompt_deep_dive: 'Write a prompt deep dive report for Notion.',
      sources_citations: 'Write a sources and citations report for Notion.',
      brand_accuracy: 'Write a brand accuracy report for Notion.',
      change_log: 'Write a change log report for Notion: what changed since the last check of each prompt.',
    })
  })

  it('lists the picked prompts, numbered, up to the template maximum', () => {
    const prompts = ['a', 'b', { text: ' c ' }, 'd', 'e'].map((p) => p)
    expect(draftText('google_ai_gap', { brand: 'Notion', prompts })).toBe(
      'Write a Google vs AI gap report for Notion.\nResearch these prompts:\n1. "a"\n2. "b"\n3. "c"\n4. "d"',
    )
    expect(draftText('prompt_deep_dive', { brand: 'Notion', prompts: ['best notes app', 'second'] })).toBe(
      'Write a prompt deep dive report for Notion.\nThe tracked prompt:\n1. "best notes app"',
    )
  })

  it('ignores prompts for a template without a picker and drops empty ones', () => {
    expect(draftText('executive_summary', { brand: 'N', prompts: ['a'] })).toBe('Write an executive summary report for N.')
    expect(draftText('sources_citations', { brand: 'N', prompts: ['', null, { text: '  ' }] })).toBe(
      'Write a sources and citations report for N.',
    )
  })

  it('names up to three competitors with their domains', () => {
    const competitors = [
      { name: 'Evernote', domain: 'evernote.com' },
      { name: 'coda.io', domain: 'coda.io' },
      { name: '', domain: 'obsidian.md' },
      { name: 'Fourth', domain: 'fourth.test' },
    ]
    expect(draftText('competitor_comparison', { brand: 'Notion', competitors, prompts: ['p'] })).toBe(
      'Write a competitor comparison report for Notion.\nCompare with Evernote (evernote.com), coda.io and obsidian.md.\nResearch these prompts:\n1. "p"',
    )
    expect(draftText('competitor_comparison', { brand: 'Notion', competitors: [competitors[0]] })).toContain(
      'Compare with Evernote (evernote.com).',
    )
  })

  it('says this project without a brand, and nothing for an unknown key', () => {
    expect(draftText('brand_accuracy')).toBe('Write a brand accuracy report for this project.')
    expect(draftText('brand_accuracy', null)).toBe('Write a brand accuracy report for this project.')
    expect(draftText('nope', { brand: 'x' })).toBe('')
  })
})
