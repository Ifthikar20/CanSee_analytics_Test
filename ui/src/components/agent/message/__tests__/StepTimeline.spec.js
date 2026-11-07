import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StepTimeline from '@/components/agent/message/StepTimeline.vue'
import { engineCheckLine, errorCopy, errorInfo, messageText, splitParts, stepLine } from '@/components/agent/message/parts'

const pane = {
  activateTab: vi.fn(),
  openUrl: vi.fn(() => 'url:1'),
  openSerp: vi.fn(),
  openPage: vi.fn(),
  openArtifact: vi.fn(),
  setReturnFocus: vi.fn(),
}

vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => pane }))

// Contract-shaped parts (agent_contract.md section 3).
const serp = {
  id: 'p1',
  type: 'serp',
  query: 'best note app',
  page: 2,
  location: 'us',
  status: 'done',
  tab_id: 'serp:c1',
  brand_positions: [14],
  result_count: 10,
  ai_overview_shown: false,
}
const inspect = {
  id: 'p2',
  type: 'page_inspect',
  url: 'https://example.com/notes',
  status: 'done',
  tab_id: 'page:c2',
  title: 'Notes app',
  summary: 'Title 58 chars, one H1.',
}
const checks = [
  { id: 'e1', type: 'engine_check', prompt_id: 7, prompt_text: 'best note app', engine: 'claude', engine_label: 'Claude', status: 'done', mentioned: true, rank: 3 },
  { id: 'e2', type: 'engine_check', prompt_id: 7, prompt_text: 'best note app', engine: 'perplexity', engine_label: 'Perplexity', status: 'done', mentioned: false, rank: null },
  { id: 'e3', type: 'engine_check', prompt_id: 7, prompt_text: 'best note app', engine: 'grok', engine_label: 'Grok', status: 'unavailable', error: 'XAI_API_KEY is not set' },
  { id: 'e4', type: 'engine_check', prompt_id: 7, prompt_text: 'best note app', engine: 'chatgpt', engine_label: 'ChatGPT', status: 'running' },
]

beforeEach(() => {
  Object.values(pane).forEach((fn) => fn.mockClear())
})

describe('StepTimeline', () => {
  it('opens the Google results tab from a serp line', async () => {
    const w = mount(StepTimeline, { props: { steps: [serp], checks: [], live: false } })
    const line = w.find('button.ag-step-link')
    expect(line.text()).toContain("Searched Google for “best note app” · page 2 · you're #14")
    await line.trigger('click')
    expect(pane.activateTab).toHaveBeenCalledWith('serp:c1')
  })

  it('opens the inspected page tab from a page_inspect line', async () => {
    const w = mount(StepTimeline, { props: { steps: [inspect], checks: [], live: false } })
    await w.find('button.ag-step-link').trigger('click')
    expect(pane.activateTab).toHaveBeenCalledWith('page:c2')
    expect(w.text()).toContain('Title 58 chars, one H1.')
  })

  it('lists background engine checks without any control that opens a tab', async () => {
    const w = mount(StepTimeline, { props: { steps: [], checks, live: true } })
    const section = w.find('section.ag-checks')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('Background checks')
    expect(section.text()).toContain('Claude')
    expect(section.text()).toContain('named #3')
    expect(section.text()).toContain('not named')
    expect(section.text()).toContain('not available')
    expect(section.text()).toContain('XAI_API_KEY is not set')
    expect(section.findAll('button')).toHaveLength(0)
    expect(section.findAll('a')).toHaveLength(0)
    await section.trigger('click')
    expect(pane.activateTab).not.toHaveBeenCalled()
    expect(pane.openSerp).not.toHaveBeenCalled()
    expect(pane.openPage).not.toHaveBeenCalled()
  })

  it('shows serp_not_configured honestly and without a tab link', () => {
    const failed = {
      ...serp,
      id: 'p3',
      status: 'error',
      tab_id: null,
      brand_positions: [],
      error: { code: 'serp_not_configured', message: 'SERPAPI_KEY is not set.' },
    }
    const w = mount(StepTimeline, { props: { steps: [failed], checks: [], live: false } })
    expect(w.text()).toContain("Google search isn't available yet.")
    expect(w.find('button.ag-step-link').exists()).toBe(false)
  })

  it('stops showing steps as live once the reply has finished', () => {
    const running = { ...serp, status: 'running' }
    const live = mount(StepTimeline, { props: { steps: [running], checks: [], live: true } })
    expect(live.find('.ag-step').classes()).toContain('is-live')
    const done = mount(StepTimeline, { props: { steps: [running], checks: [], live: false } })
    expect(done.find('.ag-step').classes()).not.toContain('is-live')
  })
})

describe('parts helpers', () => {
  it('splits parts into steps, checks, body and deliverables in arrival order', () => {
    const parts = [
      { id: 't0', type: 'thinking', text: 'Planning' },
      serp,
      { id: 'x1', type: 'text', text: 'Hello' },
      checks[0],
      { id: 'a1', type: 'agent_call', agent: 'landing_page', status: 'done', artifact_id: 'a' },
      { id: 'c1', type: 'chart', spec: {} },
      { id: 'n1', type: 'notice', level: 'info', message: 'Fallback model used' },
    ]
    const out = splitParts(parts)
    expect(out.steps.map((p) => p.id)).toEqual(['t0', 'p1'])
    expect(out.checks.map((p) => p.id)).toEqual(['e1'])
    expect(out.body.map((p) => p.id)).toEqual(['x1', 'c1', 'n1'])
    expect(out.calls.map((p) => p.id)).toEqual(['a1'])
  })

  it('says when the brand is not on a results page', () => {
    expect(stepLine({ ...serp, brand_positions: [] }).text).toContain('you are not on this page')
  })

  it('reports engine checks with only the part fields', () => {
    expect(engineCheckLine(checks[0])).toMatchObject({ label: 'Claude', status: 'named #3', tone: 'good' })
    expect(engineCheckLine(checks[1])).toMatchObject({ status: 'not named' })
    expect(engineCheckLine(checks[2])).toMatchObject({ status: 'not available', reason: 'XAI_API_KEY is not set' })
  })

  it('joins only the text parts for copy and save', () => {
    const message = { parts: [{ type: 'thinking', text: 'x' }, { type: 'text', text: ' A ' }, { type: 'text', text: 'B' }] }
    expect(messageText(message)).toBe('A\n\nB')
  })

  it('reads codes from envelopes, store errors and network failures', () => {
    expect(errorInfo({ isAxiosError: true, response: { status: 409, data: { error: { code: 'already_saved', details: { artifact_id: 'r1' } } } } }))
      .toMatchObject({ status: 409, code: 'already_saved', details: { artifact_id: 'r1' } })
    expect(errorInfo({ isAxiosError: true, code: 'ERR_NETWORK' }).code).toBe('network')
    expect(errorInfo({ status: 503, code: 'agent_not_configured', message: 'No key' })).toMatchObject({ code: 'agent_not_configured', message: 'No key' })
    expect(errorInfo({ isAxiosError: true, response: { status: 400, data: { error: 'serpapi_not_configured' } } }).code).toBe('serpapi_not_configured')
  })

  it('uses the server message for unknown error codes', () => {
    expect(errorCopy('weird_code', 'The model returned nothing.', 'failed').body).toBe('The model returned nothing.')
    expect(errorCopy('allowance_exceeded', '', 'failed')).toMatchObject({ retry: false, billing: true })
    expect(errorCopy('', '', 'interrupted').title).toContain('interrupted')
  })
})
