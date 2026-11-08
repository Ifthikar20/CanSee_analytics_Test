import { describe, expect, it } from 'vitest'
import { isReactive, reactive } from 'vue'
import { RESEARCH_AGENTS } from '../researchAgents'
import { RESEARCH_AGENTS_TEAMS, AGENT_TEAMS } from '../teams'
import { RESEARCH_AGENTS_KEY, entryAgentOf } from '../taskTemplates'
import { AGENT_KEY_LIST } from '../types'

describe('the research agents', () => {
  it('are not an agent key: their chat opens as the Gap Analyst', () => {
    expect(RESEARCH_AGENTS.key).toBe('research_agents')
    expect(RESEARCH_AGENTS.key).toBe(RESEARCH_AGENTS_KEY)
    expect(AGENT_KEY_LIST).not.toContain(RESEARCH_AGENTS.key)
    expect(Object.keys(AGENT_TEAMS)).not.toContain(RESEARCH_AGENTS.key)
    expect(RESEARCH_AGENTS.entryAgent).toBe('gap_analyst')
    expect(entryAgentOf(RESEARCH_AGENTS.key)).toBe(RESEARCH_AGENTS.entryAgent)
  })

  it('sit in the AEO and SEO team, like the backend AGENT_TEAMS research_agents', () => {
    expect(RESEARCH_AGENTS_TEAMS).toEqual(['aeo_seo'])
    expect(RESEARCH_AGENTS.teams).toEqual([{ key: 'aeo_seo', label: 'AEO and SEO' }])
  })

  it('describe what they do in plain text', () => {
    expect(RESEARCH_AGENTS.name).toBe('Research Agents')
    expect(RESEARCH_AGENTS.description).toMatch(/Google results page/)
    expect(RESEARCH_AGENTS.description).toMatch(/AI engine/)
    expect(RESEARCH_AGENTS.description).not.toMatch(/\p{Extended_Pictographic}|\$/u)
  })

  it('keep the icon out of reactive proxies', () => {
    const state = reactive({ agent: RESEARCH_AGENTS })
    expect(isReactive(state.agent.icon)).toBe(false)
  })
})
