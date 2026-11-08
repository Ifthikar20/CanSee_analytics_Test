import { describe, expect, it } from 'vitest'
import { normalizeVizSpec, representationsFor } from '@/lib/charts/spec'
import {
  aiRequests,
  commandEmpty,
  requestsByCategory,
  commandTiles,
  runsByAgent,
  runsByTeam,
  runsOverTime,
  activeUsersOverTime,
  spendOverTime,
  topUserRows,
  RUNS_FOOTNOTE,
  SPEND_FOOTNOTE,
} from '../commandSpecs'
import { commandCenter, mineOnly } from './__fixtures__/commandCenter'

describe('commandTiles', () => {
  it('shows the five headline numbers with changes against the previous window', () => {
    const tiles = commandTiles(commandCenter())
    expect(tiles.map((t) => [t.key, t.label, t.value, t.kind])).toEqual([
      ['runs', 'Agent runs', 120, 'count'],
      ['active_users', 'Active users', 5, 'count'],
      ['drafts_saved', 'Drafts saved', 25, 'count'],
      ['ai_usd', 'AI spend', 12.3456, 'usd'],
      ['failed', 'Failed runs', '6 of 120', 'number'],
    ])
    expect(tiles[0].delta).toEqual({ value: 22.4, unit: 'pct', label: 'vs previous 7 days', goodWhen: 'up' })
    expect(tiles[1].delta.value).toBe(25)
    expect(tiles[3].delta).toMatchObject({ value: 23.3, goodWhen: 'down' })
    expect(tiles[2].delta).toBeNull()
  })

  it('keeps measured zeros and has no change to show from an empty previous window', () => {
    const tiles = commandTiles(
      commandCenter({ totals: { runs: 0, runs_prev: 0, failed: 0, drafts_saved: 0, active_users: 0, active_users_prev: 0, ai_usd: '0.0000', ai_usd_prev: '0.0000' } })
    )
    expect(tiles.map((t) => t.value)).toEqual([0, 0, 0, 0, '0 of 0'])
    expect(tiles.every((t) => t.delta === null)).toBe(true)
  })
})

describe('chart specs', () => {
  it('stacks runs by how they ended, colored by status', () => {
    const spec = runsOverTime(commandCenter())
    expect(spec).toMatchObject({ id: 'command.runs', title: 'Agent runs', subtitle: 'Replies the agent finished, by how they ended.', x: 'time', time_unit: 'day', value: 'count', stacked: true, type: 'stacked_bar' })
    expect(spec.datasets.map((d) => [d.key, d.label, d.entity])).toEqual([
      ['completed', 'Completed', 'status:good'],
      ['failed', 'Failed', 'status:critical'],
      ['cancelled', 'Stopped', 'muted'],
      ['interrupted', 'Interrupted', 'status:warning'],
    ])
    expect(spec.datasets[0].data).toEqual([3, 0, 5])
    expect(representationsFor(normalizeVizSpec(spec))).toContain('stacked_bar')
  })

  it('draws active users as a line', () => {
    const spec = activeUsersOverTime(commandCenter())
    expect(spec).toMatchObject({ id: 'command.users', title: 'Active users', subtitle: 'People who started at least one agent run.', type: 'line' })
    expect(spec.datasets[0].data).toEqual([2, 0, 3])
  })

  it('stacks AI spend in dollars by the seven categories', () => {
    const spec = spendOverTime(commandCenter())
    expect(spec).toMatchObject({ id: 'command.spend', title: 'AI spend', subtitle: 'Priced from the tokens each request recorded.', value: 'usd', stacked: true, type: 'stacked_bar', footnote: SPEND_FOOTNOTE })
    expect(spec.datasets.map((d) => d.label)).toEqual([
      'Agent replies',
      'Writing agents',
      'Research agents',
      'Context builds',
      'AI engine answers',
      'Insights runs',
      'Other',
    ])
    expect(spec.datasets[1].data).toEqual([0, 0, 1.2])
  })

  it('shows one measure per agent at a time, each in its own unit', () => {
    const spec = runsByAgent(commandCenter())
    expect(spec).toMatchObject({ id: 'command.agents', title: 'Runs by agent', pick_one: true, type: 'hbar', footnote: RUNS_FOOTNOTE })
    expect(spec.labels).toEqual(['page_optimizer', 'agent_only'])
    expect(spec.label_names).toEqual({ page_optimizer: 'Page Optimizer', agent_only: 'Agent only' })
    expect(spec.datasets.map((d) => [d.key, d.label, d.value])).toEqual([
      ['runs', 'Runs', 'count'],
      ['drafts_saved', 'Drafts saved', 'count'],
      ['ai_usd', 'AI spend', 'usd'],
    ])
    expect(spec.datasets[2].data).toEqual([1.23, 0])
  })

  it('counts runs by team', () => {
    const spec = runsByTeam(commandCenter())
    expect(spec).toMatchObject({ id: 'command.teams', title: 'Runs by team', type: 'bar' })
    expect(spec.label_names).toEqual({ aeo_seo: 'AEO and SEO' })
    expect(spec.datasets[0].data).toEqual([30])
  })
})

describe('topUserRows', () => {
  it('lists the organization users with their role, or none in your own scope', () => {
    const rows = topUserRows(commandCenter())
    expect(rows[0]).toMatchObject({ name: 'Site Owner', email: 'owner@example.com', role: 'Owner', runs: '40', active_days: '12', ai_usd: '$4.56' })
    expect(rows[1]).toMatchObject({ name: 'Lee (former member)', role: '', ai_usd: '$0.0040' })
    expect(topUserRows(mineOnly())).toBeNull()
  })
})

describe('commandEmpty', () => {
  it('says nothing ran in the window', () => {
    expect(commandEmpty(commandCenter({ empty_reason: 'no_activity' }))).toEqual({
      kind: 'empty',
      title: 'No agent runs or AI use in the last 7 days.',
      body: 'Runs and AI spend show up here when someone uses the agent or checks prompts.',
      action: { label: 'Open the agent', to: { name: 'agent' } },
    })
    expect(commandEmpty(commandCenter())).toBeNull()
  })
})

describe('the Free plan: counts in place of dollars', () => {
  const FREE = { hideUsd: true }
  const categories = [
    { key: 'engines', label: 'AI engine answers', usd: '0.1200', requests: 9 },
    { key: 'agent_replies', label: 'Agent replies', usd: '0.4200', requests: 14 },
    { key: 'context', label: '', usd: '0.0061', requests: 0 },
  ]

  it('adds up the AI requests the ledger recorded, and knows when there is no count', () => {
    expect(aiRequests(commandCenter({ spend_by_category: categories }))).toBe(23)
    expect(aiRequests(commandCenter({ spend_by_category: [{ key: 'writers', requests: 1 }] }))).toBe(1)
    expect(aiRequests(commandCenter({ spend_by_category: [{ key: 'writers', requests: 0 }] }))).toBe(0)
    expect(aiRequests(commandCenter({ spend_by_category: [] }))).toBeNull()
    expect(aiRequests(commandCenter({ spend_by_category: [{ key: 'writers', usd: '1.0000' }] }))).toBeNull()
    expect(aiRequests(commandCenter({ spend_by_category: null }))).toBeNull()
    expect(aiRequests(null)).toBeNull()
  })

  it('swaps the AI spend tile for AI requests, with no dollar value or change', () => {
    const tiles = commandTiles(commandCenter({ spend_by_category: categories }), FREE)
    expect(tiles.map((t) => [t.key, t.label, t.value, t.kind])).toEqual([
      ['runs', 'Agent runs', 120, 'count'],
      ['active_users', 'Active users', 5, 'count'],
      ['drafts_saved', 'Drafts saved', 25, 'count'],
      ['ai_requests', 'AI requests', 23, 'count'],
      ['failed', 'Failed runs', '6 of 120', 'number'],
    ])
    expect(tiles[3].delta).toBeNull()
    expect(tiles.some((t) => t.kind === 'usd')).toBe(false)
    // No count to show: an unknown value, never a made-up zero.
    expect(commandTiles(commandCenter({ spend_by_category: [] }), FREE)[3].value).toBeNull()
  })

  it('charts AI requests by category in the usual order, in counts', () => {
    const spec = requestsByCategory(commandCenter({ spend_by_category: categories }))
    expect(spec).toMatchObject({ id: 'command.requests', title: 'AI requests', value: 'count', type: 'hbar', x: 'category' })
    expect(spec.labels).toEqual(['agent_replies', 'context', 'engines'])
    expect(spec.label_names).toEqual({ agent_replies: 'Agent replies', context: 'Context builds', engines: 'AI engine answers' })
    expect(spec.datasets).toEqual([{ key: 'requests', label: 'Requests', data: [14, 0, 9] }])
    expect(JSON.stringify(spec)).not.toContain('usd')
    expect(representationsFor(normalizeVizSpec(spec))).toContain('hbar')
  })

  it('charts nothing for a payload with no request counts', () => {
    const spec = requestsByCategory(commandCenter({ spend_by_category: [{ key: 'writers', usd: '1.0000' }, null] }))
    expect(spec.labels).toEqual([])
    expect(spec.datasets[0].data).toEqual([])
    expect(requestsByCategory(null).labels).toEqual([])
  })

  it('drops AI spend from the agent measures', () => {
    const spec = runsByAgent(commandCenter(), FREE)
    expect(spec.datasets.map((d) => [d.key, d.value])).toEqual([
      ['runs', 'count'],
      ['drafts_saved', 'count'],
    ])
  })

  it('leaves the Top users AI spend empty', () => {
    const rows = topUserRows(commandCenter(), FREE)
    expect(rows.map((r) => r.ai_usd)).toEqual(['', ''])
    expect(rows[0]).toMatchObject({ name: 'Site Owner', runs: '40', active_days: '12' })
    expect(JSON.stringify(rows)).not.toContain('$')
  })

  it('says AI use, not spend, in the empty state', () => {
    expect(commandEmpty(commandCenter({ empty_reason: 'no_activity' }), '7d', FREE).body).toBe(
      'Runs and AI use show up here when someone uses the agent or checks prompts.',
    )
  })
})
