import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ResearchAgentsCard from '../ResearchAgentsCard.vue'

enableAutoUnmount(afterEach)

const ENGINES = [
  { key: 'chatgpt', label: 'ChatGPT', configured: true },
  { key: 'claude', label: 'Claude', configured: true },
  { key: 'gemini', label: 'Gemini', configured: true },
  { key: 'grok', label: 'Grok', configured: true },
  { key: 'perplexity', label: 'Perplexity', configured: true },
]
const STATUS = {
  enabled: true,
  configured: true,
  live_available: true,
  engines: ENGINES,
  google: { configured: true, key_settings: [] },
  swarm: { enabled: true, max_agents: 50 },
  research: { available: true, reason: null, message: '' },
}
const BLOCK = {
  code: 'research_disabled',
  scope: 'research',
  title: 'The research agents are turned off on this workspace.',
  action: 'Ask your workspace admin to turn them on.',
  setting: '',
}

async function mountCard(props = {}) {
  const wrapper = mount(ResearchAgentsCard, { props: { status: STATUS, ...props }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const presetButtons = (w) => w.findAll('button.ag-research-preset')
const useButton = (w) => w.find('button[aria-label="Use Research Agents"]')

describe('ResearchAgentsCard', () => {
  it('explains what the research agents do and their team', async () => {
    const w = await mountCard()
    expect(w.find('h2').text()).toBe('Research Agents')
    expect(w.findAll('.ag-research-team').map((t) => t.text())).toEqual(['AEO and SEO'])
    expect(w.find('.ag-research-desc').text()).toContain('work in parallel')
  })

  it('states the configured ceiling and the prompts it covers', async () => {
    const w = await mountCard()
    expect(w.find('.ag-research-meta').text()).toContain('Up to 50 agents per research, enough for 5 prompts with what is set up here.')
    await w.setProps({ status: { ...STATUS, swarm: { enabled: true, max_agents: 30 } } })
    expect(w.find('.ag-research-meta').text()).toContain('Up to 30 agents per research, enough for 3 prompts with what is set up here.')
    await w.setProps({ status: { ...STATUS, swarm: { enabled: true, max_agents: 10 } } })
    expect(w.find('.ag-research-meta').text()).toContain('enough for 1 prompt with')
    // The ceiling has a HelpTip explaining how agents add up.
    const tip = w.find('.ag-research-meta button.cs-helptip')
    expect(tip.attributes('aria-label')).toBe('About the research agent limit')
    expect(document.getElementById(tip.attributes('aria-describedby')).textContent).toMatch(/per Google results page/)
  })

  it('states the ceiling alone when nothing can be measured, and nothing without status', async () => {
    const none = { ...STATUS, engines: ENGINES.map((e) => ({ ...e, configured: false })), google: { configured: false } }
    const w = await mountCard({ status: none })
    expect(w.find('.ag-research-meta').text()).toContain('Up to 50 agents per research.')
    await w.setProps({ status: null })
    expect(w.find('.ag-research-meta').exists()).toBe(false)
  })

  it('offers four presets that open the dialog on that template', async () => {
    const w = await mountCard()
    const presets = presetButtons(w)
    expect(presets.map((b) => b.find('.ag-research-preset-name').text())).toEqual([
      'Google vs AI gap',
      'Competitor check',
      'Sources audit',
      'Check one prompt',
    ])
    // Each preset is described by its summary.
    const desc = document.getElementById(presets[2].attributes('aria-describedby'))
    expect(desc.textContent).toContain('sources the AI engines cite')
    await presets[1].trigger('click')
    await presets[3].trigger('click')
    await useButton(w).trigger('click')
    expect(w.emitted('use')).toEqual([['competitors'], ['prompt'], ['']])
  })

  it('turns presets and Use off with the reason and what to do', async () => {
    const w = await mountCard({ block: BLOCK })
    expect(w.find('.ag-research-why').text()).toContain('The research agents are turned off on this workspace.')
    const why = w.find('#ag-research-why')
    expect(why.text()).toBe('The research agents are turned off on this workspace.')
    for (const b of [...presetButtons(w), useButton(w)]) {
      expect(b.attributes('aria-disabled')).toBe('true')
      expect(b.attributes('disabled')).toBeUndefined()
      expect(b.attributes('aria-describedby')).toBe('ag-research-why')
      await b.trigger('click')
    }
    expect(w.emitted('use')).toBeUndefined()
    const tip = w.find('.ag-research-why button.cs-helptip')
    expect(document.getElementById(tip.attributes('aria-describedby')).textContent).toBe('Ask your workspace admin to turn them on.')
    expect(w.findAll('[title]')).toHaveLength(0)
  })

  it('shows the setting to staff', async () => {
    const w = await mountCard({ block: { ...BLOCK, setting: 'AGENT_SWARM_ENABLED' } })
    const tip = w.find('.ag-research-why button.cs-helptip')
    expect(document.getElementById(tip.attributes('aria-describedby')).textContent).toBe(
      'Ask your workspace admin to turn them on. Setting: AGENT_SWARM_ENABLED.'
    )
  })

  it('needs a project', async () => {
    const w = await mountCard({ noProject: true })
    expect(w.find('#ag-research-why').text()).toBe('Pick a project first.')
    await presetButtons(w)[0].trigger('click')
    expect(w.emitted('use')).toBeUndefined()
  })

  it('reaches every preset with the keyboard', async () => {
    const w = await mountCard()
    const focusables = [...w.element.querySelectorAll('button')].filter((b) => !b.disabled && b.tabIndex >= 0)
    const names = focusables.map((b) => b.getAttribute('aria-label') || b.querySelector('.ag-research-preset-name')?.textContent)
    expect(names).toContain('Use Research Agents')
    for (const n of ['Google vs AI gap', 'Competitor check', 'Sources audit', 'Check one prompt']) expect(names).toContain(n)
  })
})
