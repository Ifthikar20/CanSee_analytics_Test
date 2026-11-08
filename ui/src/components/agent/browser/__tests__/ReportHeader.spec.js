import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ReportHeader from '../views/ReportHeader.vue'
import { reportHeader } from './__fixtures__/reportHeader.js'

function rows(wrapper) {
  return Object.fromEntries(wrapper.findAll('.ag-rh-row').map((r) => [r.find('dt').text(), r.find('dd').text().replace(/\s+/g, ' ')]))
}

describe('ReportHeader', () => {
  it('renders nothing for a report saved before headers', () => {
    for (const header of [null, undefined]) {
      const wrapper = mount(ReportHeader, { props: { header } })
      expect(wrapper.find('header').exists()).toBe(false)
      expect(wrapper.text()).toBe('')
    }
  })

  it('shows the template, project, date, data, engines and location as a labelled list', () => {
    const wrapper = mount(ReportHeader, { props: { header: reportHeader({ template: null }), template: 'executive_summary' } })
    const header = wrapper.find('header')
    expect(header.attributes('aria-label')).toBe('Report details')
    expect(wrapper.find('.ag-rh-template').text()).toBe('Executive summary')
    expect(wrapper.find('.ag-rh-sample').exists()).toBe(false)
    expect(rows(wrapper)).toEqual({
      Project: 'Notion notion.so',
      Captured: 'Nov 8, 2026',
      Data: 'Tracked prompt data, Jul 11, 2026 to Nov 8, 2026 (last 120 days)Research agents run for this reply',
      Engines: 'ChatGPT: AskedClaude: AskedGemini: FailedGrok: Not set upPerplexity: Not selected',
      Location: 'United States',
    })
    expect(wrapper.find('time').attributes('datetime')).toBe('2026-11-08T12:00:00Z')
  })

  it('names each engine with its status in words, not colour alone', () => {
    const wrapper = mount(ReportHeader, { props: { header: reportHeader() } })
    const engines = wrapper.findAll('.ag-rh-engine')
    expect(engines.map((e) => e.text())).toEqual([
      'ChatGPT: Asked',
      'Claude: Asked',
      'Gemini: Failed',
      'Grok: Not set up',
      'Perplexity: Not selected',
    ])
    expect(engines[3].classes()).toContain('is-not_configured')
  })

  it('adds the competitors for the comparison and the prompt for the deep dive', () => {
    const comparison = mount(ReportHeader, { props: { header: reportHeader() } })
    expect(rows(comparison).Competitors).toBe('Evernote evernote.comCoda coda.io')
    expect(rows(comparison).Prompt).toBeUndefined()
    const deepDive = mount(ReportHeader, {
      props: { header: reportHeader({ template: { id: 'prompt_deep_dive', name: 'Prompt deep dive' } }) },
    })
    expect(rows(deepDive).Prompt).toBe('"best notes app for teams" United States')
    expect(rows(deepDive).Competitors).toBeUndefined()
  })

  it('shows a header saved without a template with no template line', () => {
    const wrapper = mount(ReportHeader, { props: { header: reportHeader({ template: null }) } })
    expect(wrapper.find('.ag-rh-top').exists()).toBe(false)
    expect(rows(wrapper).Project).toBe('Notion notion.so')
  })

  it('marks a sample header in its label and with a visible Sample tag', () => {
    const wrapper = mount(ReportHeader, { props: { header: reportHeader(), sample: true } })
    expect(wrapper.find('header').attributes('aria-label')).toBe('Sample report details')
    expect(wrapper.find('.ag-rh-sample').text()).toBe('Sample')
  })

  it('pluralises locations and leaves out empty rows', () => {
    const wrapper = mount(ReportHeader, {
      props: { header: reportHeader({ locations: ['US', 'DE'], data: [], engines: [], captured_at: null }), template: 'executive_summary' },
    })
    const r = rows(wrapper)
    expect(r.Locations).toBe('United States, Germany')
    expect(r.Captured).toBeUndefined()
    expect(r.Data).toBeUndefined()
    expect(r.Engines).toBeUndefined()
  })
})
