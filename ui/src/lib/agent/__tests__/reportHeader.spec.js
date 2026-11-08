import { describe, expect, it } from 'vitest'
import { ENGINE_STATUS_TEXT, dayText, headerMarkdown, headerModel, windowText } from '../reportHeader'

// data.header as services/reports.report_header saves it (reports-be contract).
function header(overrides = {}) {
  return {
    template: { id: 'executive_summary', name: 'Executive summary' },
    project: { name: 'Notion', url: 'https://www.notion.so/' },
    captured_at: '2026-11-08T12:00:00Z',
    data: [
      { key: 'tracked_data', label: 'Tracked prompt data', window_days: 120 },
      { key: 'google', label: 'Google results captured for this reply', window_days: null },
    ],
    engines: [
      { key: 'chatgpt', label: 'ChatGPT', status: 'asked', configured: true },
      { key: 'claude', label: 'Claude', status: 'failed', configured: true },
      { key: 'gemini', label: 'Gemini', status: 'not_selected', configured: true },
      { key: 'grok', label: 'Grok', status: 'not_configured', configured: false },
      { key: 'perplexity', label: 'Perplexity', status: 'not_asked', configured: true },
    ],
    locations: ['US', 'GB'],
    prompts: [{ prompt_id: 'p1', text: 'best notes app', location: 'US' }],
    competitors: [{ name: 'Evernote', domain: 'evernote.com' }],
    compared: { kind: 'research_versions', version: 3, previous_version: 2, captured_at: '2026-11-08T12:00:00Z', previous_captured_at: '2026-11-01T12:00:00Z' },
    ...overrides,
  }
}

describe('dayText and windowText', () => {
  it('writes a day and a data window ending on the capture date', () => {
    expect(dayText('2026-11-08T12:00:00Z')).toBe('Nov 8, 2026')
    expect(windowText('2026-11-08T12:00:00Z', 120)).toBe('Jul 11, 2026 to Nov 8, 2026 (last 120 days)')
    expect(windowText('2026-11-08T12:00:00Z', 90)).toBe('Aug 10, 2026 to Nov 8, 2026 (last 90 days)')
  })

  it('keeps the window length without a capture date, and nothing without a window', () => {
    expect(windowText(null, 120)).toBe('Last 120 days')
    expect(windowText('not a date', 90)).toBe('Last 90 days')
    expect(windowText('2026-11-08T12:00:00Z', null)).toBe('')
    expect(windowText('2026-11-08T12:00:00Z', 0)).toBe('')
    expect(windowText('2026-11-08T12:00:00Z', 'x')).toBe('')
  })

  it('returns nothing for a bad date', () => {
    for (const bad of [null, undefined, '', 'yesterday', 12]) expect(dayText(bad)).toBe('')
  })
})

describe('headerModel', () => {
  it('is null for a report saved before headers (old reports stay unlabelled)', () => {
    for (const bad of [null, undefined, 'x', [], 3]) expect(headerModel(bad)).toBeNull()
  })

  it('turns the header into display text', () => {
    const m = headerModel(header(), 'executive_summary')
    expect(m.template).toEqual({ id: 'executive_summary', name: 'Executive summary' })
    expect(m.project).toEqual({ name: 'Notion', url: 'https://www.notion.so/', host: 'notion.so' })
    expect(m.captured).toBe('Nov 8, 2026')
    expect(m.data.map((d) => d.text)).toEqual([
      'Tracked prompt data, Jul 11, 2026 to Nov 8, 2026 (last 120 days)',
      'Google results captured for this reply',
    ])
    expect(m.engines.map((e) => `${e.label}: ${e.statusText}`)).toEqual([
      'ChatGPT: Asked',
      'Claude: Failed',
      'Gemini: Not selected',
      'Grok: Not set up',
      'Perplexity: Not asked',
    ])
    expect(m.locations).toEqual(['United States', 'United Kingdom'])
  })

  it('has a word for every engine status of the contract', () => {
    expect(Object.keys(ENGINE_STATUS_TEXT)).toEqual(['asked', 'failed', 'not_selected', 'not_configured', 'not_asked'])
  })

  it('reads an unknown engine status as not asked and fills a missing label', () => {
    const m = headerModel(header({ engines: [{ key: 'gpt4', status: 'exploded' }, { status: 'asked' }] }))
    expect(m.engines).toEqual([{ key: 'gpt4', label: 'ChatGPT', status: 'not_asked', statusText: 'Not asked' }])
  })

  it('shows the prompts only for the deep dive', () => {
    expect(headerModel(header(), 'executive_summary').prompts).toEqual([])
    expect(headerModel(header({ template: { id: 'prompt_deep_dive', name: 'Prompt deep dive' } })).prompts).toEqual([
      { text: 'best notes app', location: 'United States' },
    ])
  })

  it('shows the competitors only for the comparison', () => {
    expect(headerModel(header()).competitors).toEqual([])
    expect(headerModel(header(), 'competitor_comparison').competitors).toEqual([{ name: 'Evernote', domain: 'evernote.com' }])
    const m = headerModel(header({ competitors: [{ name: '', domain: 'coda.io' }, { name: '' }, null] }), 'competitor_comparison')
    expect(m.competitors).toEqual([{ name: 'coda.io', domain: 'coda.io' }])
  })

  it('says what a change log compared, only for the change log', () => {
    expect(headerModel(header()).compared).toBe('')
    expect(headerModel(header(), 'change_log').compared).toBe('Research v3 (Nov 8, 2026) compared with v2 (Nov 1, 2026)')
    const checks = header({
      compared: { kind: 'engine_checks', window_days: 90, latest_check_at: '2026-11-08T12:00:00Z', previous_check_at: '2026-11-01T12:00:00Z' },
    })
    expect(headerModel(checks, 'change_log').compared).toBe(
      'Latest engine checks (Nov 8, 2026) compared with the previous ones (Nov 1, 2026) (last 90 days)',
    )
    const first = header({ compared: { kind: 'engine_checks', window_days: 90, latest_check_at: '2026-11-08T12:00:00Z', previous_check_at: null } })
    expect(headerModel(first, 'change_log').compared).toBe('Latest engine checks (Nov 8, 2026); no earlier check to compare (last 90 days)')
    for (const compared of [null, { kind: 'other' }, { kind: 'engine_checks' }, { kind: 'research_versions', version: 'x' }]) {
      expect(headerModel(header({ compared }), 'change_log').compared).toBe('')
    }
    const undated = header({ compared: { kind: 'research_versions', version: 2, previous_version: 1 } })
    expect(headerModel(undated, 'change_log').compared).toBe('Research v2 compared with v1')
  })

  it('takes the template from data.template, then the header, and names it from the local copy if needed', () => {
    expect(headerModel(header({ template: null })).template).toBeNull()
    expect(headerModel(header({ template: null }), 'change_log').template).toEqual({ id: 'change_log', name: 'Change log since the last run' })
    expect(headerModel(header({ template: { id: 'brand_accuracy', name: '' } })).template).toEqual({
      id: 'brand_accuracy',
      name: 'Brand accuracy',
    })
    // An unknown key is no template at all.
    expect(headerModel(header({ template: { id: 'weekly', name: 'Weekly' } })).template).toBeNull()
  })

  it('copes with a sparse header', () => {
    const m = headerModel({ project: { name: 'Solo' } })
    expect(m).toMatchObject({ template: null, captured: '', data: [], engines: [], locations: [], prompts: [], competitors: [], compared: '' })
    expect(m.project).toEqual({ name: 'Solo', url: '', host: '' })
  })
})

describe('headerMarkdown', () => {
  it('is empty for a report without a header', () => {
    expect(headerMarkdown(null)).toBe('')
    expect(headerMarkdown(undefined, 'change_log')).toBe('')
  })

  it('writes the template, then one bullet per field and a rule', () => {
    expect(headerMarkdown(header({ locations: ['US'] }), 'executive_summary')).toBe(
      [
        '**Template: Executive summary**',
        '',
        '- Project: Notion (https://www.notion.so/)',
        '- Captured: Nov 8, 2026',
        '- Data: Tracked prompt data, Jul 11, 2026 to Nov 8, 2026 \\(last 120 days\\); Google results captured for this reply',
        '- Engines: ChatGPT asked, Claude failed, Gemini not selected, Grok not set up, Perplexity not asked',
        '- Locations: United States',
        '',
        '---',
        '',
        '',
      ].join('\n'),
    )
  })

  it('adds the per-template lines and escapes Markdown in data', () => {
    const md = headerMarkdown(
      header({ template: null, project: { name: 'Acme *Pro*', url: '' }, prompts: [{ text: 'best [tool] #1', location: '' }] }),
      'prompt_deep_dive',
    )
    expect(md.startsWith('**Template: Prompt deep dive**')).toBe(true)
    expect(md).toContain('- Project: Acme \\*Pro\\*\n')
    expect(md).toContain('- Prompts: "best \\[tool\\] \\#1"')
    expect(md).not.toContain('Competitors')
  })

  it('leaves out the template line for a report saved without one', () => {
    const md = headerMarkdown(header({ template: null }))
    expect(md).not.toContain('Template')
    expect(md.startsWith('- Project: Notion')).toBe(true)
  })

  it('lists competitors and what was compared for their templates', () => {
    expect(headerMarkdown(header(), 'competitor_comparison')).toContain('- Competitors: Evernote (evernote.com)')
    expect(headerMarkdown(header(), 'change_log')).toContain('- Compared: Research v3 \\(Nov 8, 2026\\) compared with v2 \\(Nov 1, 2026\\)')
  })
})
