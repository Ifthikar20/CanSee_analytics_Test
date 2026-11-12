// The design tokens (assets/tailwind.css) and the alias files that map the
// older token names onto them: the palette, contrast, shape and the shared
// classes the redesign is built from.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { blockVars, contrast, inPalette, resolve, stripComments } from './cssTokens'

// Read from disk: vitest hands back an empty module for a stylesheet import.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const tailwind = read('../tailwind.css')
const theme = read('../css/theme.css')
const agent = read('../agent/tokens.css')
const viz = read('../css/viz.css')
const base = read('../css/base.css')
const hljs = read('../agent/hljs.css')

const primitives = blockVars(tailwind, ':root')
const LIGHT = { ...primitives }
const DARK = { ...primitives, ...blockVars(tailwind, '[data-theme="dark"]') }
// A contrast surface in the light theme: the dark values, on near-black.
const CONTRAST_LIGHT = { ...DARK, ...blockVars(tailwind, ':root:not([data-theme="dark"]) .cs-contrast') }
const hex = (vars, name) => resolve(`var(${name})`, vars)

describe('palette', () => {
  it('is paper, ink, warm grays and one orange', () => {
    expect(primitives['--paper']).toBe('#f3f2ee')
    expect(primitives['--ink']).toBe('#0b0b0b')
    expect(primitives['--gray-100']).toBe('#e7e6e1')
    expect(primitives['--orange']).toBe('#ff4a00')
    const literals = Object.entries(primitives).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v))
    expect(literals.length).toBeGreaterThanOrEqual(14)
    for (const [name, value] of literals) expect(inPalette(value), `${name}: ${value}`).toBe(true)
  })

  it('maps the light theme onto it: paper page, light gray cards, ink text', () => {
    expect(hex(LIGHT, '--background')).toBe('#f3f2ee')
    expect(hex(LIGHT, '--foreground')).toBe('#0b0b0b')
    expect(hex(LIGHT, '--card')).toBe('#e7e6e1')
    expect(hex(LIGHT, '--primary')).toBe('#0b0b0b')
    expect(hex(LIGHT, '--primary-foreground')).toBe('#f3f2ee')
    expect(hex(LIGHT, '--ring')).toBe('#0b0b0b')
    expect(hex(LIGHT, '--signal')).toBe('#ff4a00')
  })

  it('maps the dark theme onto it: black page, #141414 cards, the same orange', () => {
    expect(hex(DARK, '--background')).toBe('#000000')
    expect(hex(DARK, '--card')).toBe('#141414')
    expect(hex(DARK, '--foreground')).toBe('#f3f2ee')
    expect(hex(DARK, '--primary')).toBe('#f3f2ee')
    expect(hex(DARK, '--ring')).toBe('#f3f2ee')
    expect(hex(DARK, '--signal')).toBe('#ff4a00')
  })

  it('defines every semantic token in both themes', () => {
    const light = Object.keys(primitives).filter((k) => !/^--(paper|ink|white|black|gray-\d+|orange(-strong)?|radius)$/.test(k))
    const dark = Object.keys(blockVars(tailwind, '[data-theme="dark"]'))
    expect(light.length).toBeGreaterThan(30)
    expect(dark.sort()).toEqual(light.sort())
  })

  it('keeps hover fills gray: the shadcn accent is not the brand accent', () => {
    expect(inPalette(hex(LIGHT, '--accent'))).toBe(true)
    expect(hex(LIGHT, '--accent')).not.toBe('#ff4a00')
    expect(hex(DARK, '--accent')).not.toBe('#ff4a00')
  })

  it('draws the user series in orange and every other chart slot in ink and grays', () => {
    for (const vars of [LIGHT, DARK]) {
      expect(hex(vars, '--chart-1')).toBe('#ff4a00')
      for (const n of [2, 3, 4, 5]) expect(hex(vars, `--chart-${n}`)).not.toBe('#ff4a00')
    }
    expect(hex(LIGHT, '--chart-2')).toBe('#0b0b0b')
    expect(hex(DARK, '--chart-2')).toBe('#f3f2ee')
  })

  it('tells severities and gap classes apart by weight, with the accent on one of each', () => {
    for (const vars of [LIGHT, DARK]) {
      const severity = ['high', 'medium', 'low'].map((k) => hex(vars, `--severity-${k}`))
      expect(new Set(severity).size).toBe(3)
      const gap = ['ai', 'google', 'strong', 'invisible'].map((k) => hex(vars, `--gap-${k}`))
      expect(new Set(gap).size).toBe(4)
      expect(gap.filter((c) => c === '#ff4a00')).toHaveLength(1)
      for (const c of [...severity, ...gap]) expect(inPalette(c), c).toBe(true)
    }
  })
})

describe('contrast', () => {
  const AA = 4.5
  const pairs = [
    ['--foreground', '--background', 7],
    ['--foreground', '--card', 7],
    ['--card-foreground', '--card', 7],
    ['--popover-foreground', '--popover', 7],
    ['--primary-foreground', '--primary', 7],
    ['--secondary-foreground', '--secondary', 7],
    ['--muted-foreground', '--background', AA],
    ['--muted-foreground', '--card', AA],
    ['--muted-foreground', '--muted', AA],
    ['--subtle-foreground', '--background', AA],
    ['--subtle-foreground', '--card', AA],
    ['--destructive-foreground', '--destructive', AA],
    ['--signal-foreground', '--signal', AA],
    ['--signal-text', '--background', AA],
    ['--signal-text', '--card', AA],
    ['--signal-text', '--popover', AA],
    ['--severity-high', '--card', AA],
    ['--severity-low', '--card', AA],
  ]
  for (const [name, vars] of [['light', LIGHT], ['dark', DARK], ['contrast surface', CONTRAST_LIGHT]]) {
    it(`passes for text in the ${name} theme`, () => {
      for (const [fg, bg, min] of pairs) {
        expect(contrast(hex(vars, fg), hex(vars, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min)
      }
    })
  }

  it('uses the darker accent for small text on light surfaces and the vivid one on dark', () => {
    expect(hex(LIGHT, '--signal-text')).toBe(primitives['--orange-strong'])
    expect(hex(DARK, '--signal-text')).toBe('#ff4a00')
    // The vivid orange fails for small text on paper, which is why the token exists.
    expect(contrast('#ff4a00', '#f3f2ee')).toBeLessThan(AA)
    expect(contrast(primitives['--orange-strong'], '#e7e6e1')).toBeGreaterThanOrEqual(AA)
  })

  it('gives form controls an edge that can be seen (3:1) in both themes', () => {
    const over = (alpha, fg, bg) => {
      const mix = (i) => Math.round(parseInt(fg.slice(1 + i * 2, 3 + i * 2), 16) * alpha + parseInt(bg.slice(1 + i * 2, 3 + i * 2), 16) * (1 - alpha))
      return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`
    }
    const alphaOf = (v) => Number(/,\s*([\d.]+)\s*\)$/.exec(v)[1])
    expect(contrast(over(alphaOf(LIGHT['--input']), '#0b0b0b', '#f3f2ee'), '#f3f2ee')).toBeGreaterThanOrEqual(3)
    expect(contrast(over(alphaOf(DARK['--input']), '#f3f2ee', '#000000'), '#000000')).toBeGreaterThanOrEqual(3)
  })
})

describe('shape and depth', () => {
  it('keeps every radius token at 2px or less', () => {
    expect(primitives['--radius']).toBe('2px')
    const radii = [...stripComments(tailwind).matchAll(/--radius-(?:xs|sm|md|lg|xl|2xl|3xl|4xl):\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(radii).toHaveLength(8)
    for (const r of radii) expect(parseFloat(r)).toBeLessThanOrEqual(2)
    const legacy = blockVars(theme, ':root')
    for (const k of ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl']) expect(legacy[k]).toBe('var(--radius)')
  })

  it('has no shadow token that casts anything', () => {
    const shadows = [...stripComments(tailwind).matchAll(/--(?:drop-)?shadow-[\w-]+:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(shadows.length).toBeGreaterThanOrEqual(10)
    for (const s of shadows) expect(s).toBe('0 0 #0000')
    const legacy = blockVars(theme, ':root')
    for (const k of ['--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-card', '--shadow-card-hover']) expect(legacy[k]).toBe('none')
    const ag = blockVars(agent, ':root')
    for (const k of ['--ag-shadow-pop', '--ag-composer-shadow', '--ag-seg-thumb-shadow']) expect(ag[k]).toBe('none')
  })

  it('has no gradient in any token file', () => {
    for (const css of [tailwind, theme, agent, viz, base]) expect(stripComments(css)).not.toMatch(/gradient\(/)
  })

  it('draws one focus ring: 2px of the ring token, offset', () => {
    const rule = /\*:focus-visible\s*\{([^}]*)\}/.exec(stripComments(base))[1]
    expect(rule).toMatch(/outline:\s*2px solid var\(--ring\)/)
    expect(rule).toMatch(/outline-offset:\s*2px/)
    expect(rule).not.toMatch(/border-radius/)
  })
})

describe('alias files', () => {
  it('hold no literal colour: the old names point at the semantic tokens', () => {
    for (const [name, css] of [['theme.css', theme], ['agent/tokens.css', agent], ['agent/hljs.css', hljs]]) {
      const clean = stripComments(css)
      expect(clean, name).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(clean, name).not.toMatch(/rgba?\(/)
    }
  })

  it('declare the aliases for contrast surfaces too, so they invert with them', () => {
    for (const css of [theme, agent, viz]) {
      expect(Object.keys(blockVars(css, '.cs-contrast')).length).toBeGreaterThan(8)
    }
    expect(blockVars(theme, '.cs-contrast')['--text-primary']).toBe('var(--foreground)')
    expect(blockVars(agent, '.cs-contrast')['--ag-fg-1']).toBe('var(--foreground)')
  })

  it('carry status without a hue of its own', () => {
    const legacy = blockVars(theme, ':root')
    expect(legacy['--color-success']).toBe('var(--foreground)')
    expect(legacy['--color-warning']).toBe('var(--signal-text)')
    expect(legacy['--color-danger']).toBe('var(--signal-text)')
    expect(legacy['--brand-accent']).toBe('var(--signal-text)')
    const ag = blockVars(agent, ':root')
    expect(ag['--ag-accent']).toBe('var(--foreground)')
    expect(ag['--ag-you']).toBe('var(--signal-text)')
    expect(ag['--ag-danger']).toBe('var(--signal-text)')
    expect(ag['--ag-serp-title']).toBe('var(--foreground)')
  })

  it('keep the chart ramps in the palette, with the accent on the user series only', () => {
    const lightViz = blockVars(viz, ':root')
    const darkViz = { ...lightViz, ...blockVars(viz, "[data-theme='dark']") }
    expect(lightViz['--viz-you']).toBe('var(--signal)')
    for (const vars of [lightViz, darkViz]) {
      const steps = Array.from({ length: 8 }, (_, i) => vars[`--viz-step-${i + 1}`])
      expect(new Set(steps).size).toBe(8)
      for (const c of [...steps, ...[1, 2, 3, 4, 5].map((n) => vars[`--viz-seq-${n}`]), vars['--viz-grid'], vars['--viz-axis']]) {
        expect(inPalette(c), c).toBe(true)
        expect(c).not.toBe('#ff4a00')
      }
      // Text set inside a sequential bin stays readable.
      for (const n of [1, 2, 3, 4, 5]) {
        expect(contrast(vars[`--viz-seq-ink-${n}`], vars[`--viz-seq-${n}`]), `seq ${n}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('type and shared classes', () => {
  const clean = stripComments(tailwind)
  const rule = (selector) => {
    const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(clean)
    if (!m) throw new Error(`no rule for ${selector}`)
    return m[1]
  }

  it('adds a monospace token from the system stack, with no webfont', () => {
    const mono = /--font-mono:\s*([^;]+);/.exec(clean)[1]
    expect(mono).toMatch(/^ui-monospace,/)
    expect(mono).toMatch(/monospace$/)
    expect(clean).not.toMatch(/@font-face|@import url|https?:\/\//)
    expect(/--font-display:\s*([^;]+);/.exec(clean)[1]).toMatch(/^'Geist', 'Inter'/)
  })

  it('has the mono uppercase label', () => {
    const label = rule('.cs-label')
    expect(label).toMatch(/font-family:\s*var\(--font-mono\)/)
    expect(label).toMatch(/text-transform:\s*uppercase/)
    expect(label).toMatch(/letter-spacing:\s*0\.04em/)
    // Small text on a light surface uses the text-safe accent, never the vivid one.
    expect(rule('.cs-label--signal')).toMatch(/color:\s*var\(--signal-text\)/)
  })

  it('has the hairline rule, the live chip, the caption line and the big numeral', () => {
    expect(rule('.cs-rule')).toMatch(/height:\s*1px/)
    expect(rule('.cs-rule')).toMatch(/background:\s*var\(--rule\)/)
    const chip = rule('.cs-chip')
    // The chip inverts the surface it sits on.
    expect(chip).toMatch(/background:\s*var\(--foreground\)/)
    expect(chip).toMatch(/color:\s*var\(--background\)/)
    expect(chip).toMatch(/border-radius:\s*0/)
    expect(rule('.cs-chip--live::before')).toMatch(/background:\s*var\(--signal\)/)
    expect(rule('.cs-caption')).toMatch(/font-family:\s*var\(--font-mono\)/)
    expect(rule('.cs-caption__code')).toMatch(/font-weight:\s*700/)
    const numeral = rule('.cs-numeral')
    expect(numeral).toMatch(/font-family:\s*var\(--font-display\)/)
    expect(numeral).toMatch(/font-variant-numeric:\s*tabular-nums/)
    expect(numeral).toMatch(/letter-spacing:\s*-0\.06em/)
  })

  it('keeps cards flat: no border, no shadow, the radius token', () => {
    const card = rule('.cs-card')
    expect(card).toMatch(/background:\s*var\(--card\)/)
    expect(card).toMatch(/border-radius:\s*var\(--radius\)/)
    expect(card).not.toMatch(/border:|box-shadow/)
  })

  it('puts the shared classes in the components layer, below Tailwind utilities', () => {
    const layer = clean.slice(clean.indexOf('@layer components'))
    for (const cls of ['.cs-card', '.cs-label', '.cs-rule', '.cs-chip', '.cs-caption', '.cs-numeral', '.cs-dot', '.cs-mark', '.cs-btn']) {
      expect(layer, cls).toContain(`${cls} {`)
    }
  })
})
