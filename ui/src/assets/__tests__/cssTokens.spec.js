import { describe, expect, it } from 'vitest'
import { blockVars, contrast, hueSat, inPalette, resolve, rgb, stripComments } from './cssTokens'

describe('cssTokens helpers', () => {
  it('reads the custom properties of the rules that name a selector exactly', () => {
    const css = `
      /* :root { --ghost: red; } */
      :root, .x .y { --a: #111111; --b: var(--a); }
      :root:not([data-theme='dark']) .y { --a: #222222; }
      [data-theme="dark"] { --a: #333333; }
      :root { --c: 2px; }
    `
    expect(blockVars(css, ':root')).toEqual({ '--a': '#111111', '--b': 'var(--a)', '--c': '2px' })
    expect(blockVars(css, "[data-theme='dark']")).toEqual({ '--a': '#333333' })
    expect(blockVars(css, '.nope')).toEqual({})
    expect(stripComments('a /* b */ c')).toBe('a  c')
  })

  it('follows var() chains and refuses unknown tokens and cycles', () => {
    const vars = { '--a': 'var(--b)', '--b': 'var(--c)', '--c': '#0b0b0b', '--loop': 'var(--loop)' }
    expect(resolve('var(--a)', vars)).toBe('#0b0b0b')
    expect(resolve('2px', vars)).toBe('2px')
    expect(() => resolve('var(--missing)', vars)).toThrow(/unknown token --missing/)
    expect(() => resolve('var(--loop)', vars)).toThrow(/cycle/)
  })

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#777777')).toBe(1)
    expect(contrast('#fff', '#000')).toBeCloseTo(21, 5)
    expect(() => rgb('rgb(0,0,0)')).toThrow(/not a hex colour/)
  })

  it('accepts warm grays and the orange, and nothing else', () => {
    for (const ok of ['#f3f2ee', '#e7e6e1', '#0b0b0b', '#000000', '#ffffff', '#5f5e58', '#ff4a00', '#b83600']) {
      expect(inPalette(ok), ok).toBe(true)
    }
    // The old accents, and the colours the redesign removed.
    for (const bad of ['#7232e0', '#a78bfa', '#2a78d6', '#1d4ed8', '#e87ba4', '#3f8f5f', '#4ade80', '#fbbf24', '#c2483d', '#1e2132', '#6b7280']) {
      expect(inPalette(bad), bad).toBe(false)
    }
    expect(hueSat('#ff4a00').hue).toBeCloseTo(17.4, 0)
    expect(hueSat('#808080')).toEqual({ hue: 0, sat: 0 })
  })
})
