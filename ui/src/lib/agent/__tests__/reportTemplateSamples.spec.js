import { describe, expect, it } from 'vitest'
import { REPORT_TEMPLATE_KEYS, fallbackTemplates, sectionView } from '../reportTemplates'
import { SAMPLES, SAMPLE_BRAND, SAMPLE_CAPTURED_AT, sampleFor, sampleHeader } from '../reportTemplateSamples'
import { headerModel } from '../reportHeader'

describe('report template samples', () => {
  it('has sample props for every preview view a template uses', () => {
    for (const t of fallbackTemplates()) {
      for (const s of t.sections) {
        const view = sectionView(t.id, s)
        expect(sampleFor(view), `${t.id}: ${s.title} (${view})`).not.toBeNull()
      }
    }
  })

  it('shares the prompt detail engines with the engine cards', () => {
    expect(sampleFor('engine_cards')).toBe(SAMPLES.prompt_detail)
    expect(sampleFor('unknown')).toBeNull()
  })

  it('uses only domains reserved for examples, and no real brand', () => {
    const text = JSON.stringify({ SAMPLES, headers: REPORT_TEMPLATE_KEYS.map(sampleHeader) })
    const domains = text.match(/\b[a-z0-9-]+\.(com|org|net|io|so|co)\b/g) || []
    for (const d of domains) expect(['example.com', 'example.org', 'example.net']).toContain(d)
    expect(text).not.toMatch(/notion|hubspot|asana|monday/i)
    expect(text).not.toMatch(/\$/)
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('labels free text as sample', () => {
    for (const key of ['summary', 'content_gaps', 'target_sources', 'outreach', 'claims', 'corrections']) {
      for (const line of SAMPLES[key]) expect(line, key).toMatch(/^Sample/)
    }
    expect(SAMPLES.verdict.line).toMatch(/^Sample/)
  })

  it('builds a header of the contract shape for every template', () => {
    for (const key of REPORT_TEMPLATE_KEYS) {
      const h = sampleHeader(key)
      expect(h.template.id).toBe(key)
      expect(h.project).toEqual({ name: SAMPLE_BRAND, url: 'https://www.example.com' })
      expect(h.captured_at).toBe(SAMPLE_CAPTURED_AT)
      expect(h.engines.map((e) => e.key)).toEqual(['chatgpt', 'claude', 'gemini', 'grok', 'perplexity'])
      expect(h.data.length).toBeGreaterThan(0)
      expect(headerModel(h, key)).not.toBeNull()
    }
  })

  it('shows one engine not set up only for templates that run new checks', () => {
    const notSetUp = (key) => sampleHeader(key).engines.filter((e) => e.status === 'not_configured').map((e) => e.key)
    expect(notSetUp('google_ai_gap')).toEqual(['grok'])
    expect(notSetUp('executive_summary')).toEqual([])
  })

  it('fills the extra header field of its template only', () => {
    expect(headerModel(sampleHeader('prompt_deep_dive'), 'prompt_deep_dive').prompts).toHaveLength(1)
    expect(headerModel(sampleHeader('competitor_comparison'), 'competitor_comparison').competitors).toHaveLength(2)
    expect(headerModel(sampleHeader('change_log'), 'change_log').compared).toMatch(/^Latest engine checks/)
    expect(sampleHeader('executive_summary')).toMatchObject({ prompts: [], competitors: [], compared: null })
  })

  it('falls back to the first template for an unknown key and returns fresh objects', () => {
    expect(sampleHeader('nope').template.id).toBe('executive_summary')
    const a = sampleHeader('executive_summary')
    a.data.push({ key: 'x' })
    expect(sampleHeader('executive_summary').data).toHaveLength(1)
  })
})
