import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import AgentChips from '../AgentChips.vue'

enableAutoUnmount(afterEach)

const WHY = 'Needs at least $0.32 of AI allowance; $0.20 left this month.'

const AGENTS = [
  { key: 'gap_analyst', name: 'Gap Analyst', unavailable: '' },
  { key: 'landing_page', name: 'Landing Page Agent', unavailable: WHY },
  { key: 'aeo_article', name: 'AEO Article Agent', unavailable: WHY },
  { key: 'ad_campaign', name: 'Ad Campaign Agent', unavailable: '' },
]

describe('AgentChips', () => {
  it('shows a writer the allowance cannot start as disabled, with the reason', async () => {
    const wrapper = mount(AgentChips, { props: { agents: AGENTS, agent: null } })
    const chips = wrapper.findAll('button.ag-chip')
    expect(chips[1].attributes('aria-disabled')).toBe('true')
    expect(chips[1].attributes('title')).toBe(WHY)
    expect(chips[1].text()).toContain(WHY)
    expect(chips[0].attributes('aria-disabled')).toBeUndefined()
    expect(wrapper.find('.ag-chips-note').text()).toBe(`Landing Page Agent and AEO Article Agent: ${WHY}`)

    await chips[1].trigger('click')
    expect(wrapper.emitted('pick')).toBeUndefined()
    await chips[0].trigger('click')
    expect(wrapper.emitted('pick')).toEqual([['gap_analyst']])
  })

  it('still lets the user drop a picked agent that became unavailable', async () => {
    const wrapper = mount(AgentChips, { props: { agents: AGENTS, agent: 'landing_page' } })
    await wrapper.findAll('button.ag-chip')[1].trigger('click')
    expect(wrapper.emitted('pick')).toEqual([[null]])
  })

  it('adds no note when every agent can start', () => {
    const wrapper = mount(AgentChips, { props: { agents: AGENTS.map((a) => ({ ...a, unavailable: '' })) } })
    expect(wrapper.find('.ag-chips-note').exists()).toBe(false)
  })
})
