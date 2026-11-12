import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CARD_STATUSES, boardHeadline, cardStatus, readDensity, statusChip, writeDensity } from '../frame'

describe('statusChip', () => {
  it('has a chip for every status a card can report', () => {
    expect(CARD_STATUSES).toEqual(['live', 'stale', 'empty', 'setup', 'error', 'loading', 'ready'])
    expect(Object.fromEntries(CARD_STATUSES.map((s) => [s, statusChip(s).label]))).toEqual({
      live: 'Live',
      stale: 'Stale',
      empty: 'No data',
      setup: 'Setup',
      error: 'Error',
      loading: 'Loading',
      ready: 'Ready',
    })
  })

  it('claims Live, with the orange dot, only for fresh numbers', () => {
    for (const status of CARD_STATUSES) {
      const chip = statusChip(status)
      expect(chip.live, status).toBe(status === 'live')
      expect(chip.label === 'Live', status).toBe(status === 'live')
    }
    // The filled chips are the two that say the card works; the rest are outlined.
    expect(CARD_STATUSES.filter((s) => !statusChip(s).quiet)).toEqual(['live', 'ready'])
  })

  it('draws no chip for a status it does not know', () => {
    for (const unknown of [null, undefined, '', 'LIVE', 'fresh', 0, {}]) expect(statusChip(unknown)).toBeNull()
  })
})

describe('cardStatus', () => {
  it('is live only with numbers on show from a refresh that worked', () => {
    expect(cardStatus({})).toBe('live')
    expect(cardStatus()).toBe('live')
    expect(cardStatus({ stale: true })).toBe('stale')
  })

  it('is loading until the first answer, whatever else is said', () => {
    expect(cardStatus({ loading: true })).toBe('loading')
    expect(cardStatus({ loading: true, failed: true, emptyKind: 'empty', stale: true })).toBe('loading')
  })

  it('reads a failed load as an error, or as setup when the feature is off', () => {
    expect(cardStatus({ failed: true })).toBe('error')
    expect(cardStatus({ failed: true, failedKind: 'error' })).toBe('error')
    expect(cardStatus({ failed: true, failedKind: 'disabled' })).toBe('setup')
    expect(cardStatus({ failed: true, failedKind: 'not_available' })).toBe('setup')
    // A failure wins over what the card would have shown.
    expect(cardStatus({ failed: true, emptyKind: 'empty', stale: true })).toBe('error')
  })

  it("never calls a card's own empty state live", () => {
    expect(cardStatus({ emptyKind: 'empty' })).toBe('empty')
    expect(cardStatus({ emptyKind: 'not_connected' })).toBe('setup')
    expect(cardStatus({ emptyKind: 'not_available' })).toBe('setup')
    expect(cardStatus({ emptyKind: 'disabled' })).toBe('setup')
    expect(cardStatus({ emptyKind: 'error' })).toBe('error')
    // A kind the frame has not heard of is still not data.
    expect(cardStatus({ emptyKind: 'something_new' })).toBe('empty')
    // Nor does a failed refresh turn an empty card into a stale one.
    expect(cardStatus({ emptyKind: 'empty', stale: true })).toBe('empty')
    for (const kind of ['empty', 'not_connected', 'not_available', 'disabled', 'error', 'x']) {
      expect(cardStatus({ emptyKind: kind }), kind).not.toBe('live')
    }
  })
})

describe('boardHeadline', () => {
  const NOW = new Date('2026-11-12T10:00:00Z')

  it("leads with the project's name, then what is true of the board", () => {
    expect(boardHeadline({ name: 'Wrenfield', url: 'https://www.wrenfield.co/pricing' }, NOW)).toEqual({
      name: 'Wrenfield',
      descriptors: ['AI visibility', 'wrenfield.co', '2026'],
    })
  })

  it('does not repeat a site that is already the name', () => {
    expect(boardHeadline({ name: 'wrenfield.co', url: 'https://wrenfield.co' }, NOW).descriptors).toEqual(['AI visibility', '2026'])
    expect(boardHeadline({ name: 'Wrenfield.CO', url: 'wrenfield.co' }, NOW).descriptors).toEqual(['AI visibility', '2026'])
  })

  it('falls back to the site for a project without a name, and to nothing without either', () => {
    expect(boardHeadline({ name: '  ', url: 'wrenfield.co' }, NOW)).toEqual({ name: 'wrenfield.co', descriptors: ['AI visibility', '2026'] })
    expect(boardHeadline({ domain: 'shop.wrenfield.co' }, NOW).name).toBe('shop.wrenfield.co')
    expect(boardHeadline(null, NOW)).toEqual({ name: '', descriptors: ['AI visibility', '2026'] })
    expect(boardHeadline(undefined, NOW).name).toBe('')
    expect(boardHeadline({ name: 42, url: {} }, NOW)).toEqual({ name: '', descriptors: ['AI visibility', '2026'] })
  })

  it('leaves out a site it cannot read and a year it does not know', () => {
    expect(boardHeadline({ name: 'Acme', url: 'http://' }, NOW).descriptors).toEqual(['AI visibility', '2026'])
    expect(boardHeadline({ name: 'Acme', url: 'acme.io' }, new Date('nope')).descriptors).toEqual(['AI visibility', 'acme.io'])
    expect(boardHeadline({ name: 'Acme' }, 'today').descriptors).toEqual(['AI visibility'])
  })

  it("uses today's year by default", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2031-03-04T00:00:00'))
    try {
      expect(boardHeadline({ name: 'Acme' }).descriptors).toEqual(['AI visibility', '2031'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the remembered density', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('starts at four columns and remembers a choice per user', () => {
    expect(readDensity(7)).toBe(4)
    writeDensity(7, 2)
    expect(readDensity(7)).toBe(2)
    expect(localStorage.getItem('cs-board-columns-v1:7')).toBe('2')
    // Another account on this browser keeps its own.
    expect(readDensity(8)).toBe(4)
    writeDensity(8, 3)
    expect([readDensity(7), readDensity(8)]).toEqual([2, 3])
  })

  it('keeps one more for a browser with nobody signed in', () => {
    writeDensity('', 3)
    expect(localStorage.getItem('cs-board-columns-v1:anon')).toBe('3')
    expect([readDensity(''), readDensity(null), readDensity(undefined)]).toEqual([3, 3, 3])
    expect(readDensity(7)).toBe(4)
  })

  it('reads anything but 2, 3 or 4 as the default, and never stores it', () => {
    for (const junk of ['5', '1', '0', 'three', '', '{"n":2}', '2.5']) {
      localStorage.setItem('cs-board-columns-v1:7', junk)
      expect(readDensity(7), junk).toBe(4)
    }
    writeDensity(7, 9)
    expect(localStorage.getItem('cs-board-columns-v1:7')).toBe('4')
    writeDensity(7, '3')
    expect(readDensity(7)).toBe(3)
  })

  it('survives a browser that refuses storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(readDensity(7)).toBe(4)
    expect(() => writeDensity(7, 2)).not.toThrow()
  })
})
