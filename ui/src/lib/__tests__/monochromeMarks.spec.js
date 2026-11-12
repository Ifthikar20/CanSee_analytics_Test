// Engines and brand badges have no hue of their own: the product has one
// accent and it marks the user, not a vendor.
import { describe, expect, it } from 'vitest'
import { ENGINES, engineMeta } from '../engines'
import { brandColor, brandInitial } from '../brandLogo'
import { contrast, inPalette } from '@/assets/__tests__/cssTokens'

describe('engine marks', () => {
  it('wear the chart slots, one each, in the fixed engine order', () => {
    expect(ENGINES.map((e) => [e.key, e.color])).toEqual([
      ['chatgpt', 'var(--viz-cat-1)'],
      ['claude', 'var(--viz-cat-2)'],
      ['gemini', 'var(--viz-cat-3)'],
      ['grok', 'var(--viz-cat-4)'],
      ['perplexity', 'var(--viz-cat-5)'],
    ])
  })

  it('give an unknown engine the Other gray, with its own name as the label', () => {
    expect(engineMeta('mistral')).toMatchObject({ key: 'mistral', label: 'mistral', color: 'var(--viz-other)' })
    expect(engineMeta('').color).toBe('var(--viz-other)')
    expect(engineMeta(null).label).toBe('Unknown')
  })
})

describe('brand badges', () => {
  const names = ['Notion', 'Evernote', 'Obsidian', 'Coda', 'Acme Inc', 'x', '', null, 'Ünïcödé', 'a very long brand name indeed']

  it('are ink or dark warm gray, readable under the white initial', () => {
    for (const name of names) {
      const colour = brandColor(name)
      expect(colour, String(name)).toMatch(/^#[0-9a-f]{6}$/)
      expect(inPalette(colour), colour).toBe(true)
      expect(colour).not.toBe('#ff4a00')
      expect(contrast('#ffffff', colour), colour).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('are stable for a name and spread over several tones', () => {
    expect(brandColor('Notion')).toBe(brandColor('Notion'))
    const tones = new Set(Array.from({ length: 60 }, (_, i) => brandColor(`brand-${i}`)))
    expect(tones.size).toBeGreaterThanOrEqual(4)
    expect(brandInitial('  notion')).toBe('N')
    expect(brandInitial('')).toBe('?')
  })
})
