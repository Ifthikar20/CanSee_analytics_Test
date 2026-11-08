import { describe, expect, it } from 'vitest'
import { WIDGETS } from '@/lib/board/widgets'
import { CONTEXT_MAPS, helpContextFor } from '../context'
import { faqById } from '../faq'

describe('helpContextFor', () => {
  it('names only questions that exist', () => {
    for (const map of Object.values(CONTEXT_MAPS)) {
      for (const [key, ids] of Object.entries(map)) {
        for (const id of ids) expect(faqById(id), `${key} -> ${id}`).not.toBeNull()
      }
    }
  })

  it('maps only real board widgets', () => {
    const keys = new Set(WIDGETS.map((w) => w.key))
    for (const key of Object.keys(CONTEXT_MAPS.BY_WIDGET)) expect(keys).toContain(key)
  })

  it('reads the open panel on the board, then the route', () => {
    expect(helpContextFor({ name: 'analytics', query: { widget: 'citations' } })).toEqual(['gap-citations'])
    expect(helpContextFor({ name: 'analytics', query: { widget: ['prompt-box'] } })).toEqual(['pr-askai', 'eng-vary'])
    // A widget with no list of its own: the board's.
    expect(helpContextFor({ name: 'analytics', query: { widget: 'pages' } })).toEqual(['gs-board', 'pr-add', 'gap-score'])
    expect(helpContextFor({ name: 'analytics', query: {} })).toEqual(['gs-board', 'pr-add', 'gap-score'])
  })

  it('reads the Settings section, then the route', () => {
    expect(helpContextFor({ name: 'settings', query: { section: 'team' } })).toEqual(['acct-roles'])
    expect(helpContextFor({ name: 'settings', query: { section: 'subscription' } })).toEqual([
      'plan-paid',
      'plan-free',
      'plan-out',
    ])
    expect(helpContextFor({ name: 'settings-autopilot' })).toEqual(['pr-often', 'ts-autopilot'])
    expect(helpContextFor({ name: 'agent-findings' })).toEqual(['ag-findings'])
  })

  it('falls back to the section, then to Getting started, and is empty on Support and Docs', () => {
    expect(helpContextFor({ name: 'agent-something-new', meta: { section: 'agent' } })).toEqual([
      'ag-what',
      'ag-research',
      'ag-notready',
    ])
    expect(helpContextFor({ name: 'unknown' })).toEqual(['gs-what', 'gs-setup', 'gs-edit-setup'])
    expect(helpContextFor(null)).toEqual(['gs-what', 'gs-setup', 'gs-edit-setup'])
    expect(helpContextFor({ name: 'support' })).toEqual([])
    expect(helpContextFor({ name: 'docs' })).toEqual([])
  })

  it('returns at most four questions', () => {
    for (const name of Object.keys(CONTEXT_MAPS.BY_ROUTE)) {
      expect(helpContextFor({ name }).length).toBeLessThanOrEqual(4)
    }
  })
})
