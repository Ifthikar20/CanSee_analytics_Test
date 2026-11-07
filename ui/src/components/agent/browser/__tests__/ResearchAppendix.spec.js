import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ResearchAppendix from '../views/ResearchAppendix.vue'
import { downloadText } from '@/lib/agent/download'
import { serpCapture } from './__fixtures__/stores.js'
import { swarmTable } from '../../swarm/__tests__/__fixtures__/swarmParts.js'

vi.mock('@/lib/agent/download', async (importOriginal) => ({ ...(await importOriginal()), downloadText: vi.fn() }))

function render(data, { expanded = true } = {}) {
  return mount(ResearchAppendix, { props: { data, expanded } })
}

// ArtifactVersion.data.swarm of a report (swarm_contract.md 6e).
function swarmData(overrides = {}) {
  const counts = (total, done, failed = 0, skipped = 0) => ({ total, done, failed, skipped, stopped: 0 })
  return {
    swarm_id: '5d0c6a1e-8b0f-4d0e-9a3e-0b3e2a6f9c11',
    version: 1,
    title: 'Research Notion',
    status: 'partial',
    duration_ms: 134201,
    counts: counts(21, 18, 1, 2),
    categories: [
      { key: 'google', label: 'Google (SEO)', counts: counts(3, 3) },
      { key: 'engines', label: 'AI engines (GEO)', counts: counts(6, 5, 1) },
      { key: 'site', label: 'Your site and content gaps', counts: counts(0, 0) },
    ],
    table: swarmTable({ version: 1 }),
    ...overrides,
  }
}

describe('ResearchAppendix', () => {
  it('keeps the reason an engine check failed or was not available', () => {
    const wrapper = render({
      serp: [],
      pages: [],
      engines: [
        { id: 'e1', prompt_text: 'best note app', engine: 'chatgpt', engine_label: 'ChatGPT', status: 'unavailable', error: 'OPENAI_API_KEY is not set' },
        { id: 'e2', prompt_text: 'best note app', engine: 'perplexity', engine_label: 'Perplexity', status: 'error', error: 'The engine did not answer.' },
        { id: 'e3', prompt_text: 'best note app', engine: 'claude', engine_label: 'Claude', status: 'error', error: 'Stopped' },
        { id: 'e4', prompt_text: 'best note app', engine: 'gemini', engine_label: 'Gemini', status: 'error', error: { message: 'Rate limited' } },
        { id: 'e5', prompt_text: 'best note app', engine: 'grok', engine_label: 'Grok', status: 'error', error: null },
      ],
    })
    const results = wrapper.findAll('tbody tr').map((row) => row.findAll('td')[2].text())
    expect(results).toEqual([
      'Not available: OPENAI_API_KEY is not set',
      'Error: The engine did not answer.',
      'Error: Stopped',
      'Error: Rate limited',
      'Error',
    ])
  })

  it('never turns an AI Overview that was not measured into a no', () => {
    const wrapper = render({
      engines: [],
      pages: [],
      serp: [
        serpCapture({ capture_id: 's1', ai_overview: { shown: true, content_captured: false, mentions_you: null, cites_you: null, references: [] } }),
        serpCapture({ capture_id: 's2', ai_overview: { shown: true, mentions_you: true, cites_you: null, references: [] } }),
        serpCapture({ capture_id: 's3', ai_overview: { shown: true, mentions_you: false, cites_you: true, references: [] } }),
      ],
    })
    const lines = wrapper.findAll('.ag-apx-line').map((p) => p.text()).filter((t) => t.startsWith('AI Overview'))
    expect(lines).toEqual([
      'AI Overview: shown, but its content was not captured, so mentions and citations were not measured.',
      'AI Overview: mentions you yes, cites you not measured.',
      'AI Overview: mentions you no, cites you yes.',
    ])
  })
})

describe('ResearchAppendix research agents', () => {
  it('sums up the research agents before the Google results', () => {
    const wrapper = render({ swarm: swarmData(), serp: [serpCapture()], engines: [], pages: [] })
    const headings = wrapper.findAll('.ag-apx-sub').map((h) => h.text())
    expect(headings).toEqual(['Research agents', 'Google results'])
    const section = wrapper.find('.ag-apx-swarm')
    expect(section.find('.ag-apx-line').text()).toBe('Ran 21 agents in 2m 14s: 18 done, 1 failed, 2 skipped.')
    // Categories without agents are left out.
    expect(section.findAll('.ag-apx-list li').map((li) => li.text())).toEqual([
      'Google (SEO): 3 of 3 done',
      'AI engines (GEO): 5 of 6 done',
    ])
    // The table is in the report Markdown; the export copy has no buttons.
    expect(section.find('table').exists()).toBe(false)
    expect(section.find('button').exists()).toBe(false)
  })

  it('downloads each sheet as CSV in the app', async () => {
    const wrapper = render({ swarm: swarmData(), serp: [], engines: [], pages: [] }, { expanded: false })
    expect(wrapper.find('.ag-apx-count').text()).toBe('21 research agents')
    await wrapper.find('.ag-apx-toggle').trigger('click')
    const buttons = wrapper.findAll('.ag-apx-swarm button')
    expect(buttons.map((b) => b.text())).toEqual(['Download Prompts CSV', 'Download Content gaps CSV'])
    await buttons[1].trigger('click')
    const [text, name, type] = downloadText.mock.calls.at(-1)
    expect(name).toBe('Research Notion v1 Content gaps.csv')
    expect(type).toBe('text/csv;charset=utf-8')
    expect(text).toContain('No comparison with alternatives')
  })

  it('leaves a report without research agents as it was', () => {
    const wrapper = render({ swarm: null, serp: [], engines: [], pages: [] })
    expect(wrapper.find('.ag-apx-swarm').exists()).toBe(false)
    expect(wrapper.find('.ag-apx-empty').text()).toBe('This report was saved without research data.')
  })
})
