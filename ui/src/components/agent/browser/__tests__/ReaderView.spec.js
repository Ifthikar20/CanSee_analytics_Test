import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ReaderView from '../views/ReaderView.vue'
import readerSource from '../views/ReaderView.vue?raw'

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>'

const reader = {
  title: 'Battery care guide',
  blocks: [
    { type: 'heading', level: 1, text: 'Battery care guide' },
    { type: 'paragraph', text: `Keep it cool. ${HOSTILE}` },
    { type: 'heading', level: 2, text: 'Charging' },
    { type: 'list', ordered: true, items: ['Charge to 80%', HOSTILE] },
    { type: 'list', ordered: false, items: ['Store dry'] },
    { type: 'quote', text: 'Heat is the enemy.' },
    { type: 'code', text: '<b>not bold</b>' },
    { type: 'table', rows: [['Temp', 'Effect'], ['30C', 'Faster wear']] },
    { type: 'unknown', text: 'ignored' },
  ],
  links: [
    { text: 'Range tips', href: '/range' },
    { text: 'Evil', href: 'javascript:alert(1)' },
    { text: '', href: 'https://other.test/x' },
  ],
}

function render(props = {}) {
  return mount(ReaderView, { props: { reader, baseUrl: 'https://shop.test/guide/battery', ...props } })
}

describe('ReaderView', () => {
  it('does not use v-html or innerHTML', () => {
    expect(readerSource).not.toMatch(/v-html|innerHTML/)
  })

  it('renders hostile markup as text', () => {
    const wrapper = render()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror="alert(1)">')
    expect(wrapper.find('pre code').text()).toBe('<b>not bold</b>')
  })

  it('renders each block type and skips a title repeated by the first heading', () => {
    const wrapper = render()
    expect(wrapper.find('.ag-rd-title').exists()).toBe(false)
    expect(wrapper.find('h2.is-l1').text()).toBe('Battery care guide')
    expect(wrapper.find('h3.is-l2').text()).toBe('Charging')
    expect(wrapper.findAll('ol li')).toHaveLength(2)
    expect(wrapper.find('ul.ag-rd-list li').text()).toBe('Store dry')
    expect(wrapper.find('blockquote').text()).toBe('Heat is the enemy.')
    expect(wrapper.findAll('th').map((th) => th.text())).toEqual(['Temp', 'Effect'])
    expect(wrapper.text()).not.toContain('ignored')
  })

  it('resolves links against the page and drops unsafe ones', () => {
    const wrapper = render()
    const links = wrapper.findAll('.ag-rd-link')
    expect(links).toHaveLength(2)
    expect(links[0].attributes('href')).toBe('https://shop.test/range')
    expect(links[1].text()).toBe('other.test/x')
    expect(wrapper.html()).not.toContain('javascript:')
  })

  it('navigates in the tab on a plain click and leaves modified clicks to the browser', async () => {
    const wrapper = render()
    const link = wrapper.find('.ag-rd-link')
    await link.trigger('click', { button: 0, metaKey: true })
    expect(wrapper.emitted('navigate')).toBeUndefined()
    await link.trigger('click', { button: 0 })
    expect(wrapper.emitted('navigate')[0]).toEqual(['https://shop.test/range'])
  })

  it('says so when a page has no readable text', () => {
    const wrapper = mount(ReaderView, { props: { reader: { title: 'Empty', blocks: [], links: [] } } })
    expect(wrapper.text()).toContain('No readable text was found on this page.')
    expect(wrapper.find('.ag-rd-title').text()).toBe('Empty')
  })
})
