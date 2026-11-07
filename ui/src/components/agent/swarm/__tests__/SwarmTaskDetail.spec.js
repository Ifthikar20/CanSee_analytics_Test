import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import SwarmTaskDetail from '../SwarmTaskDetail.vue'
import { SWARM_TREE } from '../swarmView'
import {
  COMPETITOR_TAB,
  OWN_TAB,
  SERP_TAB,
  citationsDetail,
  engineDetail,
  finishedTasks,
  pageDetail,
  serpDetail,
  task,
} from './__fixtures__/swarmParts.js'

enableAutoUnmount(afterEach)

const INJECTED = '<img src=x onerror="window.__swarmPwned=1">'

function makeTree(fields = {}) {
  const tasks = new Map(finishedTasks().map((t) => [t.id, t]))
  return reactive({
    swarmLive: false,
    rerun: { visible: true, disabled: false, reason: 'Wait for the current reply to finish.' },
    findTask: (id) => tasks.get(id) || null,
    openCapture: vi.fn(),
    openUrl: vi.fn(),
    rerunTask: vi.fn(async () => null),
    noteToggle: vi.fn(),
    ...fields,
  })
}

function render(t, tree = makeTree()) {
  const wrapper = mount(SwarmTaskDetail, {
    props: { task: t, id: 'ag-swarm-m1-p4-t0' },
    global: { provide: { [SWARM_TREE]: tree } },
    attachTo: document.body,
  })
  return { wrapper, tree }
}

// dt text -> dd text
function fields(wrapper) {
  return Object.fromEntries(
    wrapper.findAll('dt').map((dt) => [dt.text(), dt.element.nextElementSibling.textContent.replace(/\s+/g, ' ').trim()])
  )
}

const byLabel = (label) => finishedTasks().find((t) => t.label === label)
const button = (wrapper, text) => wrapper.findAll('button').find((b) => b.text() === text)

describe('SwarmTaskDetail per worker', () => {
  it('shows a Google results page', async () => {
    const { wrapper, tree } = render(byLabel('Google page 1'))
    const f = fields(wrapper)
    expect(f.Target).toBe('best note taking app for teams')
    expect(f.Status).toBe('Done in 15s')
    expect(f.Started).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(f.Query).toBe('best note taking app for teams')
    expect(f.Location).toBe('United States')
    expect(f['Your position']).toBe('#4')
    expect(f['AI Overview']).toBe('Shown, not named')
    expect(f['People also ask']).toBe('What is the best free note taking app?')
    expect(f.Captured).toMatch(/^\d{2}:\d{2} via ScraperAPI$/)
    const top = wrapper.findAll('.ag-swarm-top')
    expect(top).toHaveLength(2)
    expect(top[0].text()).toContain('#1')
    expect(top[0].text()).toContain('evernote.com')
    expect(top[0].find('.ag-swarm-badge.is-competitor').text()).toBe('Competitor')
    expect(top[1].find('.ag-swarm-badge.is-you').text()).toBe('You')

    await button(wrapper, 'Open in browser').trigger('click')
    expect(tree.openCapture).toHaveBeenCalledWith(SERP_TAB, expect.any(HTMLElement))
    await button(wrapper, 'Re-run this agent').trigger('click')
    expect(tree.rerunTask).toHaveBeenCalledWith('google.p1.page1')
  })

  it('shows an engine answer and its analysis', () => {
    const { wrapper } = render(byLabel('ChatGPT'))
    const f = fields(wrapper)
    expect(f.Engine).toBe('ChatGPT · gpt-4o-mini')
    expect(f.Named).toBe('No')
    expect(f.Sentiment).toBeUndefined()
    expect(f.Mention).toBeUndefined()
    const chips = wrapper.findAll('.ag-swarm-chip')
    expect(chips.map((c) => c.text())).toEqual(['Evernote #1', 'OneNote #2', 'zapier.com', 'notion.so'])
    expect(chips[0].classes()).toContain('is-above')
    expect(chips[1].classes()).not.toContain('is-above')
    expect(chips[3].classes()).toContain('is-you')
    expect(f.Analysis).toContain('ChatGPT recommends Evernote, OneNote and Obsidian and does not name Notion.')
    expect(wrapper.findAll('.ag-swarm-bullets li').map((li) => li.text())).toEqual(['Strong offline mode', 'Free tier'])
    expect(f.Analysis).toContain('Opportunity: Publish a comparison page that names offline support and pricing.')
    // An answer has no capture to open.
    expect(button(wrapper, 'Open in browser')).toBeUndefined()
  })

  it('quotes the mention when the engine names you, and says when the analysis failed', () => {
    const t = task({
      id: 'engines.p1.claude',
      category: 'engines',
      worker: 'engine_answer',
      label: 'Claude',
      status: 'done',
      detail: engineDetail({
        engine: 'claude',
        engine_label: 'Claude',
        model_id: '',
        mentioned: true,
        rank: 3,
        sentiment: 'positive',
        snippet: 'Notion is a flexible workspace.',
        analysis: null,
        analysis_error: { code: 'refused', message: 'The analysis model declined this input.' },
      }),
    })
    const f = fields(render(t).wrapper)
    expect(f.Engine).toBe('Claude')
    expect(f.Named).toBe('Yes, #3')
    expect(f.Sentiment).toBe('positive')
    expect(f.Mention).toBe('“Notion is a flexible workspace.”')
    expect(f.Analysis).toBe('Analysis not available: The analysis model declined this input.')
  })

  it('shows the facts of a page it read', async () => {
    const t = byLabel('Competitor page 1')
    const tree = makeTree()
    const { wrapper } = render({ ...t, detail: pageDetail({ reused_from: 'site.p1.page' }) }, tree)
    const f = fields(wrapper)
    expect(f.Page).toBe('evernote.com')
    expect(f['Why this page']).toBe('Ranks #1 on Google for this prompt')
    expect(f.Title).toBe('Evernote: Best Note Taking App (34 characters)')
    expect(f['Meta description']).toBe('Capture notes everywhere. (120 characters)')
    expect(f.H1).toBe('Remember everything')
    const h2 = wrapper.findAll('dt').find((dt) => dt.text() === 'H2').element.nextElementSibling
    expect([...h2.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Evernote vs. OneNote', 'Pricing'])
    expect(f.Words).toMatch(/^2.?140$/)
    expect(f['Structured data']).toBe('Organization, FAQPage')
    expect(f.Links).toBe('80 internal · 12 external')
    expect(f.Images).toBe('24, 3 missing alt text')
    expect(f.Reused).toBe('Same page as Your page')
    await wrapper.find('dd .ag-swarm-link').trigger('click')
    expect(tree.openCapture).toHaveBeenCalledWith(COMPETITOR_TAB, expect.any(HTMLElement))
  })

  it('says Missing for page facts the page lacks', () => {
    const t = byLabel('Your page')
    const detail = pageDetail({ seo: { ...pageDetail().seo, meta_description: '', h1: [], structured_data: [] } })
    const f = fields(render({ ...t, detail }).wrapper)
    expect(f['Meta description']).toBe('Missing')
    expect(f.H1).toBe('Missing')
    expect(f['Structured data']).toBe('None')
  })

  it('shows the content gaps with their pages and severities', async () => {
    const tree = makeTree()
    const { wrapper } = render(byLabel('Content gaps'), tree)
    const f = fields(wrapper)
    expect(f.Compared).toContain('Your page')
    expect(f.Compared).toContain('Competitor')
    expect(f.Headline).toBe("Evernote's page answers the buyer question directly; yours does not.")
    const gaps = wrapper.findAll('.ag-swarm-gap')
    expect(gaps).toHaveLength(2)
    expect(gaps[0].find('.ag-swarm-sev').text()).toBe('High')
    expect(gaps[0].find('.ag-swarm-sev').classes()).toContain('is-high')
    expect(gaps[1].find('.ag-swarm-sev').classes()).toContain('is-low')
    expect(gaps[0].find('.ag-swarm-gap-issue').text()).toBe('No comparison with alternatives')
    expect(gaps[0].text()).toContain("Evidence: Evernote's H2 'Evernote vs. OneNote'; your page has none.")
    expect(gaps[0].text()).toContain('Fix: Add a section comparing Notion')

    // The compared pages and a target on your page open their captures.
    const compared = wrapper.findAll('dd .ag-swarm-link')
    await compared[0].trigger('click')
    expect(tree.openCapture).toHaveBeenLastCalledWith(OWN_TAB, expect.any(HTMLElement))
    await compared[1].trigger('click')
    expect(tree.openCapture).toHaveBeenLastCalledWith(COMPETITOR_TAB, expect.any(HTMLElement))
    await gaps[0].find('.ag-swarm-link').trigger('click')
    expect(tree.openCapture).toHaveBeenLastCalledWith(OWN_TAB, expect.any(HTMLElement))

    // Any other target is a link that opens in the pane on a plain click.
    const external = gaps[1].find('a.ag-swarm-link')
    expect(external.attributes('href')).toBe('https://docs.example.test/faq')
    expect(external.attributes('rel')).toBe('noopener noreferrer nofollow')
    await external.trigger('click', { button: 0 })
    expect(tree.openUrl).toHaveBeenCalledWith('https://docs.example.test/faq', expect.any(HTMLElement))
  })

  it('shows the cited sources and the opportunities', () => {
    const { wrapper } = render(byLabel('Cited sources'))
    expect(fields(wrapper).Headline).toBe('Engines lean on review sites you are not listed on.')
    const sources = wrapper.findAll('.ag-swarm-source')
    expect(sources.map((s) => s.find('.ag-swarm-source-domain').text())).toEqual(['g2.com', 'evernote.com'])
    expect(sources[0].find('.ag-swarm-source-meta').text()).toBe('3 citations · ChatGPT, Claude')
    expect(sources[1].find('.ag-swarm-badge.is-competitor').text()).toBe('Evernote')
    const opp = wrapper.find('.ag-swarm-opp')
    expect(opp.text()).toContain('g2.com')
    expect(opp.text()).toContain('Claim and complete the Notion listing on G2.')
  })

  it('names Google’s AI Overview among a source’s citers, never its key', () => {
    // The citations worker lists `ai_overview` beside the engine keys for a
    // source the first Google page's AI Overview referenced.
    const t = {
      ...byLabel('Cited sources'),
      detail: citationsDetail({
        sources: [
          { domain: 'zapier.com', citations: 2, engines: ['chatgpt', 'ai_overview'], is_yours: false, is_competitor: false },
          { domain: 'notion.so', citations: 1, engines: ['ai_overview'], is_yours: true, is_competitor: false },
        ],
      }),
    }
    const { wrapper } = render(t)
    const meta = wrapper.findAll('.ag-swarm-source-meta').map((m) => m.text())
    expect(meta).toEqual(['2 citations · ChatGPT, Google AI Overview', '1 citation · Google AI Overview'])
    expect(wrapper.text()).not.toContain('ai_overview')
  })

  it('shows only the reason for an agent that failed, was skipped or stopped', () => {
    const failed = render(byLabel('Claude')).wrapper
    const f = fields(failed)
    expect(f.Status).toBe('Failed after 1m 2s · attempt 2')
    expect(f.Reason).toBe('The engine was busy or rate limited.')
    expect(f.Engine).toBeUndefined()
    expect(button(failed, 'Re-run this agent')).toBeDefined()

    const skipped = render(
      task({ status: 'skipped', error: { code: 'daily_limit', message: 'This project used its daily Google search allowance.' } })
    ).wrapper
    expect(fields(skipped)).toEqual({
      Target: 'best note taking app for teams',
      Status: 'Skipped: This project used its daily Google search allowance.',
    })
  })

  it('hides re-run when the research cannot be re-run', () => {
    const tree = makeTree({ rerun: { visible: false, disabled: true, reason: '' } })
    const { wrapper } = render(byLabel('Google page 1'), tree)
    expect(button(wrapper, 'Re-run this agent')).toBeUndefined()
    expect(button(wrapper, 'Open in browser')).toBeDefined()
  })

  it('emits close on Escape', async () => {
    const { wrapper } = render(byLabel('Google page 1'))
    await wrapper.find('.ag-swarm-detail').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('SwarmTaskDetail and third-party text', () => {
  it('renders injected markup as text, never as HTML', () => {
    const serp = task({
      status: 'done',
      detail: serpDetail({
        query: INJECTED,
        top: [{ position: 1, title: INJECTED, url: 'https://evil.test/', domain: 'evil.test', is_yours: false, is_competitor: false }],
        people_also_ask: [INJECTED],
      }),
    })
    const engine = task({
      worker: 'engine_answer',
      status: 'done',
      detail: engineDetail({
        mentioned: true,
        snippet: INJECTED,
        brands: [{ name: INJECTED, position: 1 }],
        analysis: { summary: INJECTED, reasons: [INJECTED], opportunity: INJECTED },
      }),
    })
    const page = task({
      worker: 'page_inspect',
      status: 'done',
      detail: pageDetail({ chosen_because: INJECTED, seo: { ...pageDetail().seo, title: INJECTED, h1: [INJECTED], h2: [INJECTED] } }),
    })
    const gaps = task({
      worker: 'content_gap',
      status: 'done',
      detail: {
        compared: [{ role: 'own', url: 'https://www.notion.so/', title: INJECTED }],
        headline: INJECTED,
        gaps: [{ issue: INJECTED, evidence: INJECTED, fix: INJECTED, target: '', severity: 'high' }],
        analysis_error: null,
      },
    })
    const sources = task({
      worker: 'citations',
      status: 'done',
      detail: citationsDetail({
        sources: [{ domain: INJECTED, citations: 1, engines: ['chatgpt'], is_yours: false, is_competitor: false }],
        analysis: { headline: INJECTED, opportunities: [{ domain: INJECTED, why: INJECTED, action: INJECTED }] },
      }),
    })
    for (const t of [serp, engine, page, gaps, sources]) {
      const { wrapper } = render(t)
      expect(wrapper.find('img').exists()).toBe(false)
      expect(wrapper.text()).toContain(INJECTED)
    }
    expect(window.__swarmPwned).toBeUndefined()
  })
})
