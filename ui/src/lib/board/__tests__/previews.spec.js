import { describe, expect, it } from 'vitest'
import { PREVIEW_BOX, PREVIEW_KINDS, previewShapes } from '../previews'
import { WIDGETS } from '../widgets'

const PAINTS = ['ink', 'bar', 'mute', 'rule', 'you']
const finite = (...values) => values.every((v) => typeof v === 'number' && Number.isFinite(v))

describe('the catalog drawings', () => {
  it('has a drawing for every preview kind the catalog names, and no spare', () => {
    const used = new Set(WIDGETS.map((w) => w.preview))
    expect([...used].filter((kind) => !PREVIEW_KINDS.includes(kind))).toEqual([])
    expect(PREVIEW_KINDS.filter((kind) => !used.has(kind))).toEqual([])
    for (const kind of PREVIEW_KINDS) expect(previewShapes(kind).length, kind).toBeGreaterThan(2)
  })

  it('draws the four blocks of a new board as the eye, the question, the rank and the numeral', () => {
    expect(WIDGETS.slice(0, 4).map((w) => w.preview)).toEqual(['eye', 'question', 'rank', 'numeral'])
  })

  it('uses the accent exactly once in each drawing', () => {
    for (const kind of PREVIEW_KINDS) {
      expect(previewShapes(kind).filter((s) => s.c === 'you'), kind).toHaveLength(1)
    }
  })

  it('paints only with the five named paints, and never a literal colour', () => {
    for (const kind of PREVIEW_KINDS) {
      for (const shape of previewShapes(kind)) {
        expect(PAINTS, `${kind} ${JSON.stringify(shape)}`).toContain(shape.c)
        expect(JSON.stringify(shape)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i)
      }
    }
  })

  it('keeps every bar, dot and label inside the box', () => {
    expect(PREVIEW_BOX).toEqual({ width: 160, height: 100 })
    for (const kind of PREVIEW_KINDS) {
      for (const s of previewShapes(kind)) {
        const where = `${kind} ${JSON.stringify(s)}`
        if (s.t === 'rect') {
          expect(finite(s.x, s.y, s.w, s.h), where).toBe(true)
          expect(s.w > 0 && s.h > 0, where).toBe(true)
          expect(s.x >= 0 && s.y >= 0 && s.x + s.w <= 160 && s.y + s.h <= 100, where).toBe(true)
        } else if (s.t === 'dot') {
          expect(finite(s.x, s.y, s.r), where).toBe(true)
          expect(s.x - s.r >= 0 && s.x + s.r <= 160 && s.y - s.r >= 0 && s.y + s.r <= 100, where).toBe(true)
        } else if (s.t === 'line') {
          const numbers = s.points.split(/[ ,]/).map(Number)
          expect(numbers.length % 2, where).toBe(0)
          numbers.forEach((n, i) => expect(n >= 0 && n <= (i % 2 ? 100 : 160), where).toBe(true))
        } else if (s.t === 'text') {
          expect(finite(s.x, s.y, s.size), where).toBe(true)
          expect(s.text.length > 0 && s.x >= 0 && s.y <= 100 && s.y - s.size >= 0, where).toBe(true)
        } else {
          expect(s.t, where).toBe('path')
          expect(s.d, where).toMatch(/^M[\d .,a-zA-Z-]+$/)
        }
      }
    }
  })

  it('answers an unknown kind with nothing to draw', () => {
    for (const kind of ['', 'nope', undefined, null, 'toString', 'constructor', '__proto__']) expect(previewShapes(kind)).toEqual([])
  })
})
