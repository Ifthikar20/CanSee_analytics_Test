import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { h } from 'vue'
import { IN_PANEL } from '@/lib/board/context'
import AnalyticsHeader from '../AnalyticsHeader.vue'

enableAutoUnmount(afterEach)

const props = { eyebrow: 'Answer engines', title: 'Sentiment', subtitle: 'How the engines describe you.' }
const slots = { actions: () => h('button', { type: 'button', class: 'stub-action' }, 'Analyze') }

describe('AnalyticsHeader', () => {
  it('shows the eyebrow, the title, the subtitle and the actions on a page', () => {
    const wrapper = mount(AnalyticsHeader, { props, slots })
    expect(wrapper.find('.an-eyebrow').text()).toBe('Answer engines')
    expect(wrapper.find('h1').text()).toBe('Sentiment')
    expect(wrapper.find('.an-sub').text()).toBe('How the engines describe you.')
    expect(wrapper.find('.stub-action').exists()).toBe(true)
  })

  it("keeps only the subtitle and the actions in the board's panel, which names the widget itself", () => {
    const wrapper = mount(AnalyticsHeader, { props, slots, global: { provide: { [IN_PANEL]: true } } })
    expect(wrapper.find('.an-eyebrow').exists()).toBe(false)
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.find('.an-sub').text()).toBe('How the engines describe you.')
    expect(wrapper.find('.stub-action').exists()).toBe(true)

    const bare = mount(AnalyticsHeader, { props: { title: 'Pages' }, global: { provide: { [IN_PANEL]: true } } })
    expect(bare.find('.an-head-text').exists()).toBe(false)
    expect(bare.text()).toBe('')
  })
})
