import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

// A preview never reaches the network: any API call fails the test.
const client = vi.hoisted(() => {
  const fail = vi.fn(() => {
    throw new Error('a preview must not call the API')
  })
  return { get: fail, post: fail, put: fail, patch: fail, delete: fail }
})
vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))

const { default: ReportTemplatePreview } = await import('../ReportTemplatePreview.vue')
const { REPORT_TEMPLATE_KEYS, fallbackTemplates, normalizeTemplate } = await import('@/lib/agent/reportTemplates')

enableAutoUnmount(afterEach)

let fetchSpy

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('a preview must not fetch')
  })
})

afterEach(() => {
  fetchSpy.mockRestore()
})

function render(template, props = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
  return mount(ReportTemplatePreview, { props: { template, ...props }, global: { plugins: [router] }, attachTo: document.body })
}

const titles = (wrapper) => wrapper.findAll('.ag-rtp-title').map((t) => t.text())

describe('ReportTemplatePreview', () => {
  it.each(REPORT_TEMPLATE_KEYS)('%s mounts from sample props alone, with no network call', (key) => {
    const template = fallbackTemplates().find((t) => t.id === key)
    const wrapper = render(template)
    expect(client.get).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    // The real header, marked as a sample.
    const header = wrapper.find('header.ag-rh')
    expect(header.exists()).toBe(true)
    expect(header.attributes('aria-label')).toBe('Sample report details')
    expect(header.text()).toContain(template.name)
    expect(header.text()).toContain('Sample brand')
    // Every section, in order, ending with Method.
    expect(titles(wrapper)).toHaveLength(template.sections.length)
    expect(titles(wrapper).at(-1)).toBe('Method')
  })

  it('is hidden from screen readers and inert, with a visible Sample tag', () => {
    const wrapper = render(fallbackTemplates()[0])
    const stage = wrapper.find('.ag-rtp-stage')
    expect(stage.attributes('aria-hidden')).toBe('true')
    expect(stage.attributes()).toHaveProperty('inert')
    const badge = wrapper.find('.ag-rtp-badge')
    expect(badge.text()).toBe('Sample')
    expect(badge.attributes('aria-hidden')).toBe('true')
  })

  it('renders the real components for each section of the executive summary', () => {
    const wrapper = render(fallbackTemplates().find((t) => t.id === 'executive_summary'))
    expect(titles(wrapper)).toEqual(['Key numbers', 'Gap mix', 'Who AI recommends', 'Biggest gaps', 'Top fixes', 'Method'])
    const sections = wrapper.findAll('.ag-rtp-sec')
    expect(sections[0].findAll('.viz-stat')).toHaveLength(4)
    expect(sections[0].text()).toContain('38%')
    expect(sections[1].findAll('.gap-badge')).toHaveLength(5)
    expect(sections[1].text()).toContain('AI ahead')
    expect(sections[2].findAll('.lb-row')).toHaveLength(3)
    expect(sections[2].find('.lb-row.is-you').text()).toContain('Sample brand')
    expect(sections[3].find('table.viz-table').exists()).toBe(true)
    expect(sections[3].text()).toContain('Not found')
    expect(sections[4].findAll('.al-item')).toHaveLength(2)
    expect(sections[5].text()).toContain('Sample: data captured')
  })

  it('titles the per-prompt section with the sample prompt and shows engine cards', () => {
    const wrapper = render(fallbackTemplates().find((t) => t.id === 'google_ai_gap'))
    expect(titles(wrapper)).toContain('"best project tool for small teams"')
    const section = wrapper.findAll('.ag-rtp-sec').find((s) => s.find('.ag-rtp-prompt').exists())
    expect(section.findAll('article.ec')).toHaveLength(2)
    expect(section.text()).toContain('One section like this per prompt.')
  })

  it('shows the sample competitors only in the comparison header', () => {
    const comparison = render(fallbackTemplates().find((t) => t.id === 'competitor_comparison'))
    expect(comparison.find('header.ag-rh').text()).toContain('Rival A')
    const summary = render(fallbackTemplates().find((t) => t.id === 'executive_summary'))
    expect(summary.find('header.ag-rh').text()).not.toContain('Rival A')
  })

  it('previews a section the UI does not know as its description', () => {
    const template = normalizeTemplate({
      id: 'executive_summary',
      sections: [
        { title: 'Brand new section', shows: 'Something the server added.', repeat: null },
        { title: 'Method', shows: 'When.', repeat: null },
      ],
    })
    const wrapper = render(template)
    expect(titles(wrapper)).toEqual(['Brand new section', 'Method'])
    expect(wrapper.findAll('.ag-rtp-sec')[0].text()).toContain('Something the server added.')
  })

  it('leaves nothing inside focusable outside the inert stage', () => {
    const wrapper = render(fallbackTemplates().find((t) => t.id === 'prompt_deep_dive'))
    const focusables = wrapper.element.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')
    for (const el of focusables) expect(el.closest('[inert]')).not.toBeNull()
  })

  it('scales the stage to the frame width, and keeps a default without a width', async () => {
    const plain = render(fallbackTemplates()[0])
    expect(plain.find('.ag-rtp').attributes('style')).toContain('--ag-rtp-scale: 0.42')
    expect(plain.find('.ag-rtp').attributes('style')).toContain('height: 210px')
    const spy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(320)
    try {
      const wide = render(fallbackTemplates()[0], { height: 160 })
      await wide.vm.$nextTick()
      expect(wide.find('.ag-rtp').attributes('style')).toContain('--ag-rtp-scale: 0.5')
      expect(wide.find('.ag-rtp').attributes('style')).toContain('height: 160px')
    } finally {
      spy.mockRestore()
    }
  })
})
