import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIRST_RESEARCH_KEY,
  FIRST_RESEARCH_MAX_AGE_MS,
  useFirstResearch,
} from '../useFirstResearch'

const TEXT = 'Research Notion (notion.so) on Google and the AI engines for these prompts:\n1. best note taking app for teams'

function stored() {
  const raw = sessionStorage.getItem(FIRST_RESEARCH_KEY)
  return raw ? JSON.parse(raw) : null
}

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useFirstResearch', () => {
  it('stashes the first message for a project with its time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'))
    const { stash } = useFirstResearch()
    expect(stash({ websiteId: 'w1', text: `  ${TEXT}\n` })).toBe(true)
    expect(stored()).toEqual({ websiteId: 'w1', text: TEXT, createdAt: Date.parse('2026-11-04T10:00:00Z') })
  })

  it('refuses an entry without a project or a message', () => {
    const { stash } = useFirstResearch()
    expect(stash({ websiteId: '', text: TEXT })).toBe(false)
    expect(stash({ websiteId: 'w1', text: '   ' })).toBe(false)
    expect(stash()).toBe(false)
    expect(stored()).toBeNull()
  })

  it('peeks at the entry of the same project only, and leaves it stored', () => {
    const { stash, peek } = useFirstResearch()
    stash({ websiteId: 'w1', text: TEXT })
    expect(peek('w1')).toMatchObject({ websiteId: 'w1', text: TEXT })
    expect(peek('w2')).toBeNull()
    expect(peek(null)).toBeNull()
    expect(stored()).not.toBeNull()
  })

  it('ignores an entry older than the age limit', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'))
    const { stash, peek } = useFirstResearch()
    stash({ websiteId: 'w1', text: TEXT })
    vi.setSystemTime(Date.now() + 5 * 60_000)
    expect(peek('w1', 60_000)).toBeNull()
    expect(peek('w1')).not.toBeNull()
    vi.setSystemTime(Date.now() + FIRST_RESEARCH_MAX_AGE_MS)
    expect(peek('w1')).toBeNull()
  })

  it('takes the entry once', () => {
    const { stash, take } = useFirstResearch()
    stash({ websiteId: 'w1', text: TEXT })
    expect(take('w2')).toBeNull()
    expect(stored()).not.toBeNull()
    expect(take('w1')).toMatchObject({ websiteId: 'w1', text: TEXT })
    expect(stored()).toBeNull()
    expect(take('w1')).toBeNull()
  })

  it('drops an expired entry when taking it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'))
    const { stash, take } = useFirstResearch()
    stash({ websiteId: 'w1', text: TEXT })
    vi.setSystemTime(Date.now() + FIRST_RESEARCH_MAX_AGE_MS + 1)
    expect(take('w1')).toBeNull()
    expect(stored()).toBeNull()
  })

  it('discards whatever is stored', () => {
    const { stash, discard, peek } = useFirstResearch()
    stash({ websiteId: 'w1', text: TEXT })
    discard()
    expect(peek('w1')).toBeNull()
  })

  it('treats corrupt or partial entries as nothing', () => {
    const { peek, take } = useFirstResearch()
    sessionStorage.setItem(FIRST_RESEARCH_KEY, '{not json')
    expect(peek('w1')).toBeNull()
    sessionStorage.setItem(FIRST_RESEARCH_KEY, JSON.stringify({ websiteId: 'w1', text: '', createdAt: Date.now() }))
    expect(take('w1')).toBeNull()
    sessionStorage.setItem(FIRST_RESEARCH_KEY, JSON.stringify({ websiteId: 'w1', text: TEXT }))
    expect(peek('w1')).toBeNull()
  })

  it('survives storage that throws on every call', () => {
    const { stash, peek, take, discard } = useFirstResearch()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(stash({ websiteId: 'w1', text: TEXT })).toBe(false)
    expect(peek('w1')).toBeNull()
    expect(take('w1')).toBeNull()
    expect(() => discard()).not.toThrow()
  })

  it('works without sessionStorage at all', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const { stash, peek, take, discard } = useFirstResearch()
    expect(stash({ websiteId: 'w1', text: TEXT })).toBe(false)
    expect(peek('w1')).toBeNull()
    expect(take('w1')).toBeNull()
    expect(() => discard()).not.toThrow()
  })
})
