import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HINTS,
  HINT_KEYS,
  clearHintState,
  hintOf,
  hintsKey,
  loadHintState,
  pickHint,
  saveHintState,
} from '../hints'
import { USER_KEY_PREFIXES, clearUserData } from '@/lib/agent/storage'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('hint registry', () => {
  it('has the six first-visit hints, in order, each with a title and a body', () => {
    expect(HINT_KEYS).toEqual([
      'board.ask-ai',
      'shell.project',
      'board.add-widget',
      'board.track',
      'agent.chips',
      'agent.findings-select',
    ])
    HINTS.forEach((hint, i) => {
      expect(hint.order).toBe(i)
      expect(hint.title.trim()).not.toBe('')
      expect(hint.body.trim()).not.toBe('')
      if (hint.after) expect(HINT_KEYS.indexOf(hint.after)).toBeLessThan(i)
    })
    expect(hintOf('board.track').after).toBe('board.ask-ai')
    expect(hintOf('nope')).toBeNull()
  })
})

describe('hint state in localStorage', () => {
  it('round-trips seen and skipped per user, dropping unknown keys', () => {
    expect(saveHintState('7', { seen: ['board.ask-ai', 'board.ask-ai', 'nope'], skipped: false })).toBe(true)
    expect(loadHintState('7')).toEqual({ seen: ['board.ask-ai'], skipped: false })
    expect(loadHintState('8')).toEqual({ seen: [], skipped: false })
    saveHintState('7', { seen: [], skipped: true })
    expect(loadHintState('7').skipped).toBe(true)
    clearHintState('7')
    expect(localStorage.getItem(hintsKey('7'))).toBeNull()
  })

  it('reads corrupt data, no user or a throwing storage as nothing seen', () => {
    localStorage.setItem(hintsKey('7'), '{not json')
    expect(loadHintState('7')).toEqual({ seen: [], skipped: false })
    localStorage.setItem(hintsKey('7'), JSON.stringify(['board.ask-ai']))
    expect(loadHintState('7')).toEqual({ seen: [], skipped: false })
    expect(loadHintState(null)).toEqual({ seen: [], skipped: false })
    expect(saveHintState('', { seen: ['board.ask-ai'] })).toBe(false)

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(loadHintState('7')).toEqual({ seen: [], skipped: false })
    expect(saveHintState('7', { seen: ['board.ask-ai'] })).toBe(false)
  })

  it('survives logout: the key is not one logout clears', () => {
    saveHintState('7', { seen: ['board.ask-ai'], skipped: false })
    expect(USER_KEY_PREFIXES.some((prefix) => hintsKey('7').startsWith(prefix))).toBe(false)
    clearUserData()
    expect(loadHintState('7').seen).toEqual(['board.ask-ai'])
  })
})

describe('pickHint', () => {
  it('shows the first waiting hint in order whose prerequisite was seen', () => {
    const waiting = ['board.add-widget', 'shell.project', 'board.ask-ai']
    expect(pickHint({ waiting, seen: [] })).toBe('board.ask-ai')
    expect(pickHint({ waiting, seen: ['board.ask-ai'] })).toBe('shell.project')
    expect(pickHint({ waiting, seen: ['board.ask-ai', 'shell.project'] })).toBe('board.add-widget')
    expect(pickHint({ waiting: ['board.add-widget'], seen: ['board.ask-ai'] })).toBeNull()
    expect(pickHint({ waiting: ['agent.chips'], seen: [] })).toBe('agent.chips')
    expect(pickHint({ waiting: [], seen: [] })).toBeNull()
  })

  it('keeps the hint on screen while it qualifies, so it never swaps mid-read', () => {
    expect(pickHint({ waiting: ['board.ask-ai', 'agent.chips'], seen: [], current: 'agent.chips' })).toBe('agent.chips')
    expect(pickHint({ waiting: ['board.ask-ai'], seen: [], current: 'agent.chips' })).toBe('board.ask-ai')
  })
})
