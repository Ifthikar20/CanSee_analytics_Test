import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import AgentChips from '../AgentChips.vue'
import { AGENT_ORDER, agentList } from '@/lib/agent/agentsMeta'

enableAutoUnmount(afterEach)

const WHY = 'Needs at least $0.32 of AI allowance; $0.20 left this month.'

const AGENTS = [
  { key: 'gap_analyst', name: 'Gap Analyst', unavailable: '', description: 'Researches where Google and AI disagree.' },
  { key: 'landing_page', name: 'Landing Page Agent', unavailable: WHY },
  { key: 'aeo_article', name: 'AEO Article Agent', unavailable: WHY },
  { key: 'ad_campaign', name: 'Ad Campaign Agent', unavailable: '' },
]

describe('AgentChips', () => {
  it('shows a writer the allowance cannot start as disabled, with the reason', async () => {
    const wrapper = mount(AgentChips, { props: { agents: AGENTS, agent: null } })
    const chips = wrapper.findAll('button.ag-chip')
    expect(chips[1].attributes('aria-disabled')).toBe('true')
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

  it('puts the description and the reason in a tooltip and the description, never in title=', async () => {
    const wrapper = mount(AgentChips, { props: { agents: AGENTS, agent: null }, attachTo: document.body })
    const chips = wrapper.findAll('button.ag-chip')
    for (const chip of chips) expect(chip.attributes('title')).toBeUndefined()

    // A description is the chip's accessible description, open or not.
    const desc = document.getElementById(chips[0].attributes('aria-describedby'))
    expect(desc.textContent).toBe('Researches where Google and AI disagree.')

    // Keyboard focus shows it, and the reason an agent is off.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    chips[0].element.focus()
    await flushPromises()
    expect(document.body.querySelector('.ag-tooltip').textContent).toContain('Researches where Google and AI disagree.')
    chips[1].element.focus()
    await flushPromises()
    expect(document.body.querySelector('.ag-tooltip').textContent).toContain(WHY)
  })

  it('adds no note when every agent can start', () => {
    const wrapper = mount(AgentChips, { props: { agents: AGENTS.map((a) => ({ ...a, unavailable: '' })) } })
    expect(wrapper.find('.ag-chips-note').exists()).toBe(false)
  })

  it('shows all ten agents, in catalog order, each its own button', () => {
    const wrapper = mount(AgentChips, { props: { agents: agentList(), agent: null } })
    const chips = wrapper.findAll('button.ag-chip')
    expect(chips).toHaveLength(10)
    expect(AGENT_ORDER).toHaveLength(10)
    expect(chips.map((c) => c.find('.ag-chip-name').text())).toEqual(agentList().map((a) => a.name))
    expect(chips.every((c) => c.attributes('aria-pressed') === 'false')).toBe(true)
  })
})
