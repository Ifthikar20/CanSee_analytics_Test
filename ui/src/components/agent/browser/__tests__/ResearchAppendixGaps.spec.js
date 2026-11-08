import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ResearchAppendix from '../views/ResearchAppendix.vue'
import { promptGap } from './__fixtures__/reportHeader.js'

function render(data, expanded = true) {
  return mount(ResearchAppendix, { props: { data, expanded } })
}

function gapSection(wrapper) {
  return wrapper.findAll('.ag-apx-section').find((s) => s.find('h3').text() === 'Prompt gaps')
}

describe('ResearchAppendix: prompt gaps', () => {
  it('shows each saved prompt gap: prompt, Google, engines naming the brand and the gap', () => {
    const wrapper = render({ gaps: [promptGap()] })
    const section = gapSection(wrapper)
    expect(section).toBeTruthy()
    expect(section.findAll('th').map((th) => th.text())).toEqual(['Prompt', 'Google', 'AI engines', 'Gap'])
    const cells = section.findAll('tbody td').map((td) => td.text())
    expect(cells).toEqual(['best notes app for teams · United States', '#4', 'Named by 1 of 2', 'Google ahead -35'])
    expect(wrapper.text()).not.toContain('saved without research data')
  })

  it('reads missing data plainly: no answers, Google not checked, no gap', () => {
    const wrapper = render({
      gaps: [
        promptGap({
          prompt: { id: 'p2', text: 'notes app with ai', location: '' },
          google: { status: 'not_checked', position: null },
          engines: [{ key: 'grok', answers: 0, mentioned: null }],
          gap: { class: 'no_data', value: null },
        }),
        promptGap({ prompt: { id: 'p3', text: 'third' }, google: { status: 'ok', position: null, depth: 100 }, engines: null, gap: null }),
      ],
    })
    const rows = gapSection(wrapper).findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => td.text()))
    expect(rows).toEqual([
      ['notes app with ai', 'Not checked', 'No answers yet', 'Not checked'],
      ['third', 'Not in top 100', 'No answers yet', 'Not checked'],
    ])
    expect(gapSection(wrapper).find('td.is-muted').exists()).toBe(true)
  })

  it('never counts an answer whose mention is unknown as naming the brand', () => {
    const wrapper = render({
      gaps: [promptGap({ engines: [{ key: 'chatgpt', answers: 2 }, { key: 'claude', answers: 1, mentioned: null }] })],
    })
    expect(gapSection(wrapper).findAll('tbody td')[2].text()).toBe('Named by 0 of 2')
  })

  it('counts gaps in the collapsed summary', () => {
    const one = render({ gaps: [promptGap()] }, false)
    expect(one.find('.ag-apx-count').text()).toBe('1 prompt gap')
    const two = render({ gaps: [promptGap(), promptGap({ prompt: { id: 'p2', text: 'two' } })], engines: [] }, false)
    expect(two.find('.ag-apx-count').text()).toBe('2 prompt gaps')
  })

  it('shows no gap section without gaps, and skips malformed entries', () => {
    expect(gapSection(render({ gaps: [] }))).toBeUndefined()
    expect(gapSection(render({}))).toBeUndefined()
    expect(gapSection(render({ gaps: 'x' }))).toBeUndefined()
    const wrapper = render({ gaps: [null, 'x', promptGap()] })
    expect(gapSection(wrapper).findAll('tbody tr')).toHaveLength(1)
  })

  it('still says the report has no research data when nothing at all was saved', () => {
    expect(render({ gaps: [], serp: [], engines: [], pages: [] }).text()).toContain('This report was saved without research data.')
  })
})
