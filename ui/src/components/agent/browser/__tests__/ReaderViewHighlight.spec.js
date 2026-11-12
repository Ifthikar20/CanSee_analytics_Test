import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { compileTerms } from '../../../../lib/agent/highlight'
import ReaderView from '../views/ReaderView.vue'

const reader = {
  title: 'Acme pricing guide',
  blocks: [
    { type: 'heading', level: 1, text: 'Why Acme beats Globex' },
    { type: 'paragraph', text: 'Acme and Globex both sell CRM software. <img src=x onerror="alert(1)">' },
    { type: 'list', ordered: false, items: ['Acme is fast', 'Globex is old'] },
    { type: 'table', rows: [['Vendor', 'Price'], ['Acme', '$10'], ['Globex', '$12']] },
    { type: 'code', text: 'const vendor = "Acme"' },
  ],
  links: [{ text: 'Acme home', href: 'https://acme.example/' }],
}

function mountReader(props = {}) {
  return mount(ReaderView, { props: { reader, baseUrl: 'https://acme.example/guide', ...props } })
}

const markTexts = (wrapper, kind) =>
  wrapper.findAll(`mark.ag-hl.is-${kind}`).map((m) => m.text().replace(/^(Brand|Competitor): /, ''))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReaderView highlighting', () => {
  it('renders no marks without terms and reports zero matches', () => {
    const wrapper = mountReader()
    expect(wrapper.findAll('mark')).toHaveLength(0)
    expect(wrapper.emitted('matches').at(-1)[0]).toEqual({ count: 0, total: 0, capped: false })
  })

  it('marks every kind of block, keeping the text intact', () => {
    const plain = mountReader().text()
    const wrapper = mountReader({ terms: compileTerms({ brand: ['Acme'], competitor: ['Globex'] }) })
    // Title, heading, paragraph, list, table, code, link.
    expect(markTexts(wrapper, 'brand')).toHaveLength(7)
    expect(markTexts(wrapper, 'competitor')).toHaveLength(4)
    const withoutLabels = wrapper.text().replace(/(Brand|Competitor): /g, '')
    expect(withoutLabels).toBe(plain)
  })

  it('never turns page text into markup', () => {
    const wrapper = mountReader({ terms: compileTerms({ find: ['img'] }) })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('p.ag-rd-p').text()).toContain('<img src=x onerror="alert(1)">')
    expect(wrapper.find('mark.is-find').text()).toBe('img')
  })

  it('labels brand and competitor marks for screen readers', () => {
    const wrapper = mountReader({ terms: compileTerms({ brand: ['Acme'], competitor: ['Globex'] }) })
    const brand = wrapper.find('mark.is-brand .ag-sr-only')
    const competitor = wrapper.find('mark.is-competitor .ag-sr-only')
    expect(brand.text()).toBe('Brand:')
    expect(competitor.text()).toBe('Competitor:')
  })

  it('reports counts and steps through find matches only', () => {
    const wrapper = mountReader({ terms: compileTerms({ find: ['Globex'], brand: ['Acme'] }) })
    expect(wrapper.emitted('matches').at(-1)[0]).toEqual({ count: 4, total: 11, capped: false })
    const indexed = wrapper.findAll('mark[data-hl-index]')
    expect(indexed).toHaveLength(4)
    expect(indexed.every((m) => m.classes('is-find'))).toBe(true)
  })

  it('marks the current match and scrolls to it on a jump', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const wrapper = mountReader({ terms: compileTerms({ find: ['Globex'] }), current: 0, navToken: 0 })
    await wrapper.setProps({ current: 2, navToken: 1 })
    const current = wrapper.find('mark.is-current')
    expect(current.attributes('data-hl-index')).toBe('2')
    expect(current.attributes('aria-current')).toBe('true')
    expect(wrapper.findAll('mark.is-current')).toHaveLength(1)
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.instances[0]).toBe(current.element)
  })

  it('does not scroll when only the marks change', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const wrapper = mountReader({ terms: compileTerms({ find: ['Acme'] }), current: 0, navToken: 3 })
    await wrapper.setProps({ terms: compileTerms({ find: ['Globex'] }) })
    expect(scroll).not.toHaveBeenCalled()
  })
})
