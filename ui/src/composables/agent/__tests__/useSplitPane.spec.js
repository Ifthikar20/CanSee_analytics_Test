import { describe, expect, it } from 'vitest'
import { HANDLE_WIDTH, MIN_CHAT, MIN_PANE, clampRatio, keyRatio, ratioBounds, ratioFromPointer } from '../useSplitPane'

const WIDTH = 1201 // 1200 usable plus the 1px handle

describe('split pane geometry', () => {
  it('keeps both columns at their minimum widths', () => {
    const { min, max, fits } = ratioBounds(WIDTH)
    expect(fits).toBe(true)
    expect(min).toBeCloseTo(MIN_CHAT / 1200)
    expect(max).toBeCloseTo(1 - MIN_PANE / 1200)
    expect(clampRatio(0.1, WIDTH)).toBeCloseTo(min)
    expect(clampRatio(0.95, WIDTH)).toBeCloseTo(max)
    expect(clampRatio(0.5, WIDTH)).toBe(0.5)
  })

  it('reports when the minimums cannot fit (overlay territory)', () => {
    const width = MIN_CHAT + MIN_PANE + HANDLE_WIDTH - 1
    expect(ratioBounds(width).fits).toBe(false)
    expect(clampRatio(0.99, width)).toBe(0.85)
    expect(clampRatio(Number.NaN, width)).toBe(0.5)
  })

  it('maps a pointer position to a ratio', () => {
    const rect = { left: 100, width: WIDTH }
    expect(ratioFromPointer(100 + 600.5, rect)).toBeCloseTo(0.5)
    expect(ratioFromPointer(100, { left: 100, width: 0 })).toBe(0.5)
  })

  it('moves 24px per arrow key and 48px with Shift', () => {
    expect(keyRatio('ArrowRight', { ratio: 0.5, width: WIDTH })).toBeCloseTo(0.52)
    expect(keyRatio('ArrowLeft', { ratio: 0.5, width: WIDTH })).toBeCloseTo(0.48)
    expect(keyRatio('ArrowLeft', { ratio: 0.5, width: WIDTH, shift: true })).toBeCloseTo(0.46)
  })

  it('sends Home and End to the minimum widths and Enter back to half', () => {
    expect(keyRatio('Home', { ratio: 0.5, width: WIDTH })).toBeCloseTo(MIN_CHAT / 1200)
    expect(keyRatio('End', { ratio: 0.5, width: WIDTH })).toBeCloseTo(1 - MIN_PANE / 1200)
    expect(keyRatio('Enter', { ratio: 0.7, width: WIDTH })).toBe(0.5)
    expect(keyRatio('a', { ratio: 0.5, width: WIDTH })).toBe(null)
  })

  it('never passes the bounds with repeated keys', () => {
    let r = 0.5
    for (let i = 0; i < 40; i++) r = keyRatio('ArrowRight', { ratio: r, width: WIDTH, shift: true })
    expect(r).toBeCloseTo(1 - MIN_PANE / 1200)
  })
})
