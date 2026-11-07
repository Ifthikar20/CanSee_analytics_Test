import { describe, expect, it } from 'vitest'
import { neighborMap } from '@/lib/charts/geo/keyboard'

// Roughly where these sit on the 1000 x 440 map (y grows downward).
const MARKS = [
  { code: 'GB', cx: 480, cy: 95 },
  { code: 'FR', cx: 492, cy: 120 },
  { code: 'DE', cx: 520, cy: 100 },
  { code: 'NO', cx: 515, cy: 60 },
  { code: 'ES', cx: 470, cy: 140 },
  { code: 'US', cx: 200, cy: 130 },
  { code: 'AU', cx: 860, cy: 330 },
]

describe('neighborMap', () => {
  const map = neighborMap(MARKS)

  it('moves to the nearest country in each direction, keeping to the row or column', () => {
    expect(map.GB.right).toBe('DE')
    expect(map.GB.left).toBe('US')
    expect(map.GB.down).toBe('FR')
    expect(map.GB.up).toBe('NO')
    expect(map.DE.left).toBe('GB')
    expect(map.FR.down).toBe('ES')
  })

  it('falls back to the half-plane when nothing is inside the cone', () => {
    // Nothing lies within 45 degrees below the US or above Australia: the
    // nearest in that half wins, across distance counted twice.
    expect(map.US.down).toBe('ES')
    expect(map.AU.up).toBe('DE')
  })

  it('gives null at the edges', () => {
    expect(map.US.left).toBeNull()
    expect(map.AU.right).toBeNull()
    expect(map.AU.down).toBeNull()
  })

  it('skips marks without a code or a position and keeps the first of a repeated code', () => {
    const out = neighborMap([
      { code: 'GB', cx: 0, cy: 0 },
      { code: '', cx: 5, cy: 0 },
      { code: 'DE', cx: Number.NaN, cy: 0 },
      { code: 'GB', cx: 50, cy: 0 },
      { code: 'FR', cx: 10, cy: 0 },
    ])
    expect(Object.keys(out)).toEqual(['GB', 'FR'])
    expect(out.GB.right).toBe('FR')
    expect(neighborMap(null)).toEqual({})
  })
})
