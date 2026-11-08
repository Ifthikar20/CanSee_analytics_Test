import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ReportArtifactView from '../views/ReportArtifactView.vue'
import { promptGap, reportHeader } from './__fixtures__/reportHeader.js'

function render(data) {
  return mount(ReportArtifactView, {
    props: { markdown: '# Notion vs competitors\n\nSummary.', data, title: 'Report' },
    global: { plugins: [createPinia()] },
  })
}

describe('ReportArtifactView', () => {
  it('shows the header before the report text and the research data after it', () => {
    const wrapper = render({ serp: [], pages: [], engines: [], gaps: [promptGap()], swarm: null, template: 'competitor_comparison', header: reportHeader() })
    const html = wrapper.html()
    const header = wrapper.find('header.ag-rh')
    expect(header.exists()).toBe(true)
    expect(header.text()).toContain('Competitor comparison')
    expect(html.indexOf('ag-rh')).toBeLessThan(html.indexOf('Notion vs competitors'))
    expect(html.indexOf('Notion vs competitors')).toBeLessThan(html.indexOf('Research data'))
    expect(wrapper.find('header.ag-rh').text()).not.toContain('Sample')
  })

  it('leaves a report saved before templates unlabelled', () => {
    const wrapper = render({ serp: [], pages: [], engines: [], swarm: null })
    expect(wrapper.find('header.ag-rh').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Template')
    expect(wrapper.text()).toContain('Notion vs competitors')
  })

  it('ignores a malformed header and copes with no data at all', () => {
    expect(render({ header: 'x' }).find('header.ag-rh').exists()).toBe(false)
    expect(render({ header: [] }).find('header.ag-rh').exists()).toBe(false)
    expect(render(null).find('header.ag-rh').exists()).toBe(false)
  })

  it('takes the template from data.template over the header', () => {
    const wrapper = render({ template: 'change_log', header: reportHeader({ template: null }) })
    expect(wrapper.find('.ag-rh-template').text()).toBe('Change log since the last run')
  })
})
