import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USER_KEY_PREFIXES, clearUserData, storageKeys } from '@/lib/agent/storage'
import {
  FIRST_LANDING_MAX_AGE_MS,
  dismissSetup,
  isFirstLanding,
  noteFirstResearchChat,
  noteSetupFinished,
  readSetup,
  setSetupCollapsed,
} from '../storage'

const KEY = 'cs-setup-v1:7:w1'
const EMPTY = { mode: '', chatId: null, createdAt: null, dismissed: false, collapsed: false }

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('setup record storage', () => {
  it('is keyed per user and project, and cleared with the other per-user keys on logout', () => {
    expect(storageKeys.setup('7', 'w1')).toBe(KEY)
    expect(USER_KEY_PREFIXES.some((p) => KEY.startsWith(p))).toBe(true)
    noteSetupFinished('7', 'w1', 'skip', 1000)
    noteSetupFinished('8', 'w1', 'skip', 1000)
    clearUserData('7')
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(localStorage.getItem('cs-setup-v1:8:w1')).not.toBeNull()
  })

  it('reads an empty record when nothing, junk or another shape is stored', () => {
    expect(readSetup('7', 'w1')).toEqual(EMPTY)
    localStorage.setItem(KEY, '{not json')
    expect(readSetup('7', 'w1')).toEqual(EMPTY)
    localStorage.setItem(KEY, '[1,2]')
    expect(readSetup('7', 'w1')).toEqual(EMPTY)
    localStorage.setItem(KEY, JSON.stringify({ mode: 'other', chatId: 12, createdAt: 'soon', dismissed: 'yes', collapsed: 1 }))
    expect(readSetup('7', 'w1')).toEqual({ ...EMPTY, chatId: '12' })
  })

  it('needs a user and a project', () => {
    expect(readSetup('', 'w1')).toEqual(EMPTY)
    expect(readSetup('7', null)).toEqual(EMPTY)
    expect(noteSetupFinished(null, 'w1', 'skip')).toBeNull()
    expect(noteFirstResearchChat('7', '', 'c1')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('records the end of onboarding as a fresh first landing', () => {
    localStorage.setItem(KEY, JSON.stringify({ mode: 'research', chatId: 'old', createdAt: 5, dismissed: true, collapsed: true }))
    expect(noteSetupFinished('7', 'w1', 'research', 2000)).toEqual({ ...EMPTY, mode: 'research', createdAt: 2000 })
    expect(JSON.parse(localStorage.getItem(KEY))).toEqual({ ...EMPTY, mode: 'research', createdAt: 2000 })
    expect(noteSetupFinished('7', 'w1', 'nope', 3000)).toBeNull()
    expect(readSetup('7', 'w1').createdAt).toBe(2000)
  })

  it('adds the first research chat, keeping the onboarding time, or starting one after the paywall', () => {
    noteSetupFinished('7', 'w1', 'research', 2000)
    expect(noteFirstResearchChat('7', 'w1', 42, 9000)).toEqual({ ...EMPTY, mode: 'research', chatId: '42', createdAt: 2000 })
    expect(noteFirstResearchChat('7', 'w2', 'c9', 9000)).toEqual({ ...EMPTY, mode: 'research', chatId: 'c9', createdAt: 9000 })
    expect(noteFirstResearchChat('7', 'w1', '')).toBeNull()
  })

  it('remembers a dismissal and a fold per project', () => {
    noteSetupFinished('7', 'w1', 'skip', 2000)
    setSetupCollapsed('7', 'w1', true)
    expect(readSetup('7', 'w1').collapsed).toBe(true)
    expect(readSetup('7', 'w2').collapsed).toBe(false)
    setSetupCollapsed('7', 'w1', false)
    expect(readSetup('7', 'w1').collapsed).toBe(false)
    dismissSetup('7', 'w1')
    expect(readSetup('7', 'w1')).toMatchObject({ dismissed: true, createdAt: 2000, mode: 'skip' })
  })

  it('degrades to nothing stored when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(readSetup('7', 'w1')).toEqual(EMPTY)
    expect(noteSetupFinished('7', 'w1', 'skip')).toBeNull()
    expect(dismissSetup('7', 'w1')).toBeNull()
    expect(setSetupCollapsed('7', 'w1', true)).toBeNull()
  })

  it('counts a first landing for a week after onboarding, until dismissed', () => {
    const at = 1_000_000
    const record = { ...EMPTY, mode: 'skip', createdAt: at }
    expect(isFirstLanding(record, at)).toBe(true)
    expect(isFirstLanding(record, at + FIRST_LANDING_MAX_AGE_MS)).toBe(true)
    expect(isFirstLanding(record, at + FIRST_LANDING_MAX_AGE_MS + 1)).toBe(false)
    // A clock set back before onboarding is not a landing.
    expect(isFirstLanding(record, at - 1)).toBe(false)
    expect(isFirstLanding({ ...record, dismissed: true }, at)).toBe(false)
    expect(isFirstLanding({ ...record, createdAt: null }, at)).toBe(false)
    expect(isFirstLanding(null, at)).toBe(false)
  })
})
