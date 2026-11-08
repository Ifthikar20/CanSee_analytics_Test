import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { FileText } from '@lucide/vue'
import AgentCard from '../AgentCard.vue'

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

const AGENT = {
  key: 'landing_page',
  name: 'Landing Page Agent',
  icon: FileText,
  outputKind: 'page',
  description: 'Drafts a complete landing page.',
  starter: 'Draft a landing page for the search where we are missing the most.',
  teams: [
    { key: 'growth', label: 'Growth' },
    { key: 'product_marketing', label: 'Product marketing' },
  ],
}

const BLOCK = {
  code: 'agent_disabled',
  scope: 'workspace',
  title: 'The AI agent is turned off on this workspace.',
  action: 'Ask your workspace admin to turn it on.',
  setting: '',
}

async function mountCard(props = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: Blank }],
  })
  await router.push('/')
  const wrapper = mount(AgentCard, { props: { agent: AGENT, ...props }, global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const useButton = (w) => w.find('button[aria-label="Use Landing Page Agent"]')

describe('AgentCard', () => {
  it('shows the agent, its teams, what it delivers and a starter', async () => {
    const w = await mountCard()
    expect(w.find('h2').text()).toBe('Landing Page Agent')
    expect(w.findAll('.ag-agent-team').map((t) => t.text())).toEqual(['Growth', 'Product marketing'])
    expect(w.text()).toContain('Drafts a complete landing page.')
    expect(w.text()).toContain('Builds a landing page')
    expect(w.text()).toContain('Draft a landing page for the search where we are missing the most.')
  })

  it('Use is a button that opens the task dialog when the agent can run', async () => {
    const w = await mountCard()
    const use = useButton(w)
    expect(use.element.tagName).toBe('BUTTON')
    expect(use.attributes('aria-disabled')).toBeUndefined()
    expect(use.attributes('disabled')).toBeUndefined()
    expect(use.attributes('aria-describedby')).toBeUndefined()
    expect(w.find('.ag-agent-why').exists()).toBe(false)
    await use.trigger('click')
    expect(w.emitted('use')).toEqual([[AGENT]])
  })

  it('shows why it cannot run, keeps Use focusable and describes it with the reason', async () => {
    const w = await mountCard({ block: BLOCK })
    const use = useButton(w)
    expect(w.find('.ag-agent-why').text()).toContain('The AI agent is turned off on this workspace.')
    expect(use.attributes('aria-disabled')).toBe('true')
    // Not a native disabled: keyboard users still reach it and hear why.
    expect(use.attributes('disabled')).toBeUndefined()
    const desc = document.getElementById(use.attributes('aria-describedby'))
    expect(desc.textContent).toBe('The AI agent is turned off on this workspace.')
    use.element.focus()
    expect(document.activeElement).toBe(use.element)
    // A click and the keyboard do nothing.
    await use.trigger('click')
    await use.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('use')).toBeUndefined()
  })

  it('says what to do in a HelpTip, with the setting only when the block names one', async () => {
    const w = await mountCard({ block: BLOCK })
    const tip = w.find('.ag-agent-why button.cs-helptip')
    expect(tip.attributes('aria-label')).toBe('What to do: Landing Page Agent')
    const help = document.getElementById(tip.attributes('aria-describedby'))
    expect(help.textContent).toBe('Ask your workspace admin to turn it on.')
    expect(help.textContent).not.toContain('AGENT_ENABLED')

    await w.setProps({ block: { ...BLOCK, setting: 'AGENT_ENABLED' } })
    await nextTick()
    const staff = document.getElementById(w.find('.ag-agent-why button.cs-helptip').attributes('aria-describedby'))
    expect(staff.textContent).toBe('Ask your workspace admin to turn it on. Setting: AGENT_ENABLED.')
  })

  it('has no HelpTip when there is nothing to do but wait', async () => {
    const w = await mountCard({ block: { ...BLOCK, action: '' } })
    expect(w.find('.ag-agent-why').text()).toContain('The AI agent is turned off on this workspace.')
    expect(w.find('.ag-agent-why button.cs-helptip').exists()).toBe(false)
  })

  it('without a project, says to pick one and does not open', async () => {
    const w = await mountCard({ noProject: true })
    expect(w.find('.ag-agent-why').text()).toBe('Pick a project first.')
    expect(useButton(w).attributes('aria-disabled')).toBe('true')
    await useButton(w).trigger('click')
    expect(w.emitted('use')).toBeUndefined()
  })

  it('never uses a title attribute for a reason', async () => {
    const w = await mountCard({ block: BLOCK })
    expect(w.findAll('[title]')).toHaveLength(0)
  })

  it('opens again once the block clears', async () => {
    const w = await mountCard({ block: BLOCK })
    await w.setProps({ block: null })
    expect(useButton(w).attributes('aria-disabled')).toBeUndefined()
    await useButton(w).trigger('click')
    expect(w.emitted('use')).toHaveLength(1)
  })
})
