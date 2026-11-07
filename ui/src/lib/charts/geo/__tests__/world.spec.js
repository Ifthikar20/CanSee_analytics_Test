import { describe, expect, it } from 'vitest'
import { loadWorld, WORLD_HEIGHT, WORLD_WIDTH } from '@/lib/charts/geo/world'

// Every number of a path's "M x,y L x,y Z" commands, as [x, y] pairs.
function points(d) {
  const numbers = (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number)
  const out = []
  for (let i = 0; i + 1 < numbers.length; i += 2) out.push([numbers[i], numbers[i + 1]])
  return out
}

describe('loadWorld', () => {
  it('draws 176 shapes with no Antarctica, inside the viewBox', async () => {
    const world = await loadWorld()
    expect(world.width).toBe(WORLD_WIDTH)
    expect(world.height).toBe(WORLD_HEIGHT)
    expect(world.shapes).toHaveLength(176)
    expect(world.shapes.some((s) => s.code === 'AQ' || s.key === '010')).toBe(false)
    expect(new Set(world.shapes.map((s) => s.key)).size).toBe(176)
    for (const shape of world.shapes) {
      expect(shape.d, shape.name).toMatch(/^M/)
      for (const [x, y] of points(shape.d)) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(1000)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(440)
      }
    }
  })

  it('names each shape by its code, and the two that are not countries by null', async () => {
    const { shapes } = await loadWorld()
    const byName = Object.fromEntries(shapes.map((s) => [s.name, s]))
    expect(byName.Australia.code).toBe('AU')
    expect(byName.Kosovo.code).toBe('XK')
    expect(byName['N. Cyprus'].code).toBeNull()
    expect(byName.Somaliland.code).toBeNull()
  })

  it('anchors a country on its largest polygon and marks the tiny ones', async () => {
    const { shapes, points: dots } = await loadWorld()
    const of = (code) => shapes.find((s) => s.code === code)
    // France's anchor is in Europe, east of the UK, not out by French Guiana.
    expect(of('FR').cx).toBeGreaterThan(of('GB').cx - 20)
    expect(Math.abs(of('FR').cy - of('DE').cy)).toBeLessThan(40)
    // The contiguous United States, not pulled north by Alaska.
    expect(of('US').cy).toBeGreaterThan(of('CA').cy)
    expect(of('LU').tiny).toBe(true)
    expect(of('US').tiny).toBe(false)
    expect(dots.map((p) => p.code)).toEqual(['SG', 'HK', 'BH', 'MT'])
    for (const p of dots) {
      expect(p.cx).toBeGreaterThan(0)
      expect(p.cx).toBeLessThan(1000)
      expect(p.cy).toBeGreaterThan(0)
      expect(p.cy).toBeLessThan(440)
    }
  })

  it('is memoized for the session', async () => {
    const first = loadWorld()
    expect(loadWorld()).toBe(first)
    expect(await loadWorld()).toBe(await first)
  })
})
