import { afterEach, describe, expect, it } from 'vitest'
import {
  colorOf,
  datasetToken,
  entityToken,
  labelToken,
  resolveColor,
  seqInk,
  seqToken,
  stableSlots,
  withAlpha,
} from '@/lib/charts/palette'
import { normalizeVizSpec } from '@/lib/charts/spec'

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('entityToken (contract 8c)', () => {
  it('colours engines by their fixed slots', () => {
    expect(['chatgpt', 'claude', 'gemini', 'grok', 'perplexity'].map((k) => entityToken(`engine:${k}`, 7))).toEqual([
      '--viz-cat-1',
      '--viz-cat-2',
      '--viz-cat-3',
      '--viz-cat-4',
      '--viz-cat-5',
    ])
    expect(entityToken('engine:gpt4')).toBe('--viz-cat-1')
    expect(entityToken('ENGINE:Claude')).toBe('--viz-cat-2')
  })

  it('colours assistants, with Other for the rest', () => {
    const keys = ['chatgpt', 'claude', 'gemini', 'grok', 'perplexity', 'copilot', 'meta-ai']
    expect(keys.map((k) => entityToken(`assistant:${k}`))).toEqual(keys.map((_, i) => `--viz-cat-${i + 1}`))
    expect(entityToken('assistant:poe', 0)).toBe('--viz-other')
  })

  it('colours operators, with Other for the rest', () => {
    const keys = ['openai', 'anthropic', 'google', 'apple', 'perplexity', 'microsoft', 'meta', 'bytedance']
    expect(keys.map((k) => entityToken(`operator:${k}`))).toEqual(keys.map((_, i) => `--viz-cat-${i + 1}`))
    expect(entityToken('operator:common-crawl', 1)).toBe('--viz-other')
  })

  it('colours brands: you first, five competitors, then Other', () => {
    expect(['you', 'b1', 'b2', 'b3', 'b4', 'b5'].map((k) => entityToken(`brand:${k}`))).toEqual([
      '--viz-cat-1',
      '--viz-cat-2',
      '--viz-cat-3',
      '--viz-cat-4',
      '--viz-cat-5',
      '--viz-cat-6',
    ])
    expect(entityToken('brand:other', 0)).toBe('--viz-other')
  })

  it('colours sentiment on the diverging poles, muted and status series', () => {
    expect(entityToken('sentiment:positive')).toBe('--viz-div-pos')
    expect(entityToken('sentiment:neutral')).toBe('--viz-div-mid')
    expect(entityToken('sentiment:negative')).toBe('--viz-div-neg')
    expect(entityToken('muted', 0)).toBe('--viz-other')
    expect(['good', 'warning', 'serious', 'critical'].map((k) => entityToken(`status:${k}`))).toEqual([
      '--viz-good',
      '--viz-warning',
      '--viz-serious',
      '--viz-critical',
    ])
  })

  it('takes slot index + 1 without an entity, and Other past eight', () => {
    expect(entityToken(null, 0)).toBe('--viz-cat-1')
    expect(entityToken('', 3)).toBe('--viz-cat-4')
    expect(entityToken(undefined, 7)).toBe('--viz-cat-8')
    expect(entityToken(undefined, 8)).toBe('--viz-other')
    expect(entityToken('slot:6')).toBe('--viz-cat-6')
    expect(entityToken('slot:other')).toBe('--viz-other')
  })
})

describe('datasetToken', () => {
  const spec = (extra) =>
    normalizeVizSpec({
      title: 'T',
      labels: ['a'],
      datasets: [
        { key: 'x', label: 'X', data: [1] },
        { key: 'y', label: 'Y', data: [2] },
        { key: 'z', label: 'Z', data: [3], entity: 'engine:grok' },
      ],
      ...extra,
    })

  it('follows the entity, else the position', () => {
    const s = spec()
    expect(s.datasets.map((d, i) => datasetToken(s, d, i))).toEqual(['--viz-cat-1', '--viz-cat-2', '--viz-cat-4'])
  })

  it('gives the emphasis dataset slot 1 and every other dataset Other', () => {
    const s = spec({ palette: 'emphasis', emphasis: 'y' })
    expect(s.datasets.map((d, i) => datasetToken(s, d, i))).toEqual(['--viz-other', '--viz-cat-1', '--viz-other'])
  })

  it('draws one series without an entity in slot 1', () => {
    const s = spec()
    expect(datasetToken(s, s.datasets[1], 1, { drawn: 1 })).toBe('--viz-cat-1')
    expect(datasetToken(s, s.datasets[2], 2, { drawn: 1 })).toBe('--viz-cat-4')
  })
})

describe('labelToken', () => {
  it('colours donut slices by their label entity, else by position', () => {
    const s = normalizeVizSpec({
      title: 'T',
      labels: ['claude', 'chatgpt', 'misc'],
      label_entities: { claude: 'engine:claude', chatgpt: 'engine:chatgpt' },
      datasets: [{ key: 'a', data: [1, 2, 3] }],
    })
    expect([0, 1, 2].map((j) => labelToken(s, j))).toEqual(['--viz-cat-2', '--viz-cat-1', '--viz-cat-3'])
  })
})

describe('stableSlots', () => {
  it('keeps every key on its slot across key changes', () => {
    const memory = new Map()
    const first = stableSlots(['g2.com', 'reddit.com', 'wikipedia.org'], memory)
    expect([...first.values()]).toEqual([1, 2, 3])
    const second = stableSlots(['wikipedia.org', 'nytimes.com', 'g2.com'], memory)
    expect(second.get('wikipedia.org')).toBe(3)
    expect(second.get('g2.com')).toBe(1)
    // A new key takes the lowest slot no key has held.
    expect(second.get('nytimes.com')).toBe(4)
    const third = stableSlots(['reddit.com'], memory)
    expect(third.get('reddit.com')).toBe(2)
  })

  it('folds keys past the eighth on screen into Other', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`)
    const slots = stableSlots(keys, new Map())
    expect(keys.slice(0, 8).map((k) => slots.get(k))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(slots.get('k8')).toBe('other')
    expect(slots.get('k9')).toBe('other')
  })

  it('reuses a slot of a key that is no longer shown once every slot has been held', () => {
    const memory = new Map()
    stableSlots(Array.from({ length: 8 }, (_, i) => `old${i}`), memory)
    const next = stableSlots(['old3', 'fresh'], memory)
    expect(next.get('old3')).toBe(4)
    expect(next.get('fresh')).toBe(1)
    expect(memory.get('old0')).toBe(undefined)
  })
})

describe('colours', () => {
  it('resolves tokens from the stylesheet, with light fallbacks', () => {
    expect(colorOf('engine:claude')).toBe('#eb6834')
    document.documentElement.style.setProperty('--viz-cat-2', '#d95926')
    expect(colorOf('engine:claude')).toBe('#d95926')
  })

  it('steps through the sequential ramp', () => {
    expect(seqToken(0)).toBe('--viz-seq-1')
    expect(seqToken(3)).toBe('--viz-seq-3')
    expect(seqToken(9)).toBe('--viz-seq-5')
    expect(seqInk(1)).toBe('#0b0b0b')
    expect(seqInk(5)).toBe('#ffffff')
  })

  it('resolves surfaces written as var() and adds alpha', () => {
    expect(resolveColor('#123456')).toBe('#123456')
    expect(resolveColor('')).toBe('#ffffff')
    document.documentElement.style.setProperty('--ag-pane-bg', '#0e0e10')
    expect(resolveColor('var(--ag-pane-bg)')).toBe('#0e0e10')
    expect(resolveColor('var(--missing-token, #abcdef)')).toBe('#abcdef')
    expect(withAlpha('#2a78d6', 0.1)).toBe('rgba(42, 120, 214, 0.1)')
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgba(1, 2, 3, 0.5)')
  })
})
