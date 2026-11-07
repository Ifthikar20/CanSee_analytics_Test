import { describe, expect, it } from 'vitest'
import { AGENT_TEAMS, TEAMS, agentTeams, teamLabel } from '../teams'
import { AGENT_KEY_LIST } from '../types'

describe('teams', () => {
  it('has the seven teams of contract 12a, in tab order', () => {
    expect(TEAMS).toEqual([
      { key: 'aeo_seo', label: 'AEO and SEO' },
      { key: 'content', label: 'Content' },
      { key: 'social', label: 'Social' },
      { key: 'growth', label: 'Growth' },
      { key: 'pr', label: 'PR and comms' },
      { key: 'product_marketing', label: 'Product marketing' },
      { key: 'brand', label: 'Brand' },
    ])
    expect(teamLabel('pr')).toBe('PR and comms')
    expect(teamLabel('nope')).toBe('')
  })

  it('gives every agent its teams, primary first (contract 12b)', () => {
    expect(Object.keys(AGENT_TEAMS).sort()).toEqual([...AGENT_KEY_LIST].sort())
    expect(AGENT_TEAMS).toEqual({
      gap_analyst: ['aeo_seo', 'growth'],
      page_optimizer: ['aeo_seo', 'content'],
      aeo_article: ['content', 'aeo_seo'],
      llms_txt: ['aeo_seo'],
      comparison_page: ['product_marketing', 'content', 'growth'],
      landing_page: ['growth', 'product_marketing'],
      ad_campaign: ['growth'],
      social_posts: ['social', 'content'],
      pr_writer: ['pr', 'brand'],
      messaging_brief: ['product_marketing', 'brand'],
    })
  })

  it('prefers the catalog teams and drops keys it does not know', () => {
    expect(agentTeams('gap_analyst', [{ key: 'growth' }, { key: 'made_up', label: 'X' }])).toEqual([
      { key: 'growth', label: 'Growth' },
    ])
    expect(agentTeams('llms_txt', [])).toEqual([{ key: 'aeo_seo', label: 'AEO and SEO' }])
    expect(agentTeams('unknown')).toEqual([])
  })
})
