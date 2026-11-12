// A guard over the whole UI source: the redesign's palette, flat surfaces
// and square corners must not drift back in through a stray literal. Each
// rule names the few files that are allowed to break it, and why.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { inPalette, stripComments } from './cssTokens'

// (Not `new URL('../../', import.meta.url)`: Vite rewrites that form into an asset URL.)
const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'test' || name === 'content') continue
      walk(path, out)
    } else if (/\.(vue|css|js)$/.test(name) && !/\.spec\.js$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

const files = walk(SRC).map((path) => ({ name: relative(SRC, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }))
const css = (file) => {
  if (file.name.endsWith('.css')) return stripComments(file.text)
  if (!file.name.endsWith('.vue')) return ''
  return stripComments([...file.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'))
}
const toHex = (r, g, b) => `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`

/** Every colour literal of a text: 6 or 8 digit hex, and rgb()/rgba() triples. */
export function colourLiterals(text) {
  const out = []
  for (const m of text.matchAll(/#([0-9a-f]{6})(?:[0-9a-f]{2})?\b/gi)) out.push(`#${m[1].toLowerCase()}`)
  for (const m of text.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) out.push(toHex(m[1], m[2], m[3]))
  return out
}

/** The box-shadow layers of a value that cast something: an offset or a blur, not inset. */
export function castShadows(value) {
  const layers = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      layers.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) layers.push(cur.trim())
  return layers.filter((layer) => {
    if (/^(none|inherit|initial|unset)$/.test(layer) || layer.startsWith('var(') || /\binset\b/.test(layer)) return false
    let bare = layer
    // Colour functions nest (color-mix(... var(--x) ...)); peel them inside out.
    for (let i = 0; i < 4; i++) bare = bare.replace(/[a-z-]+\([^()]*\)/gi, '')
    bare = bare.replace(/#[0-9a-f]{3,8}\b/gi, '')
    const [x = 0, y = 0, blur = 0] = (bare.match(/-?(?:\d*\.)?\d+/g) || []).map(Number)
    return x !== 0 || y !== 0 || blur !== 0
  })
}

describe('helpers', () => {
  it('finds hex and rgb() colours', () => {
    expect(colourLiterals('a{color:#FF4A00;b:rgba(11, 11, 11, 0.5);c:#0b0b0bcc;d:#abc}')).toEqual(['#ff4a00', '#0b0b0b', '#0b0b0b'])
    expect(colourLiterals('var(--signal)')).toEqual([])
  })

  it('tells a cast shadow from a ring, an inset edge and a token', () => {
    expect(castShadows('0 8px 24px rgba(0, 0, 0, 0.1)')).toHaveLength(1)
    expect(castShadows('0 1px 2px #0000001a, 0 0 0 1px var(--border)')).toEqual(['0 1px 2px #0000001a'])
    expect(castShadows('-6px 0 0 var(--card)')).toHaveLength(1)
    expect(castShadows('0 0 0 2px var(--ring)')).toEqual([])
    expect(castShadows('0 0 0 0 color-mix(in srgb, var(--ag-accent) 35%, transparent)')).toEqual([])
    expect(castShadows('inset 0 1px 0 var(--border)')).toEqual([])
    expect(castShadows('var(--ag-shadow-pop)')).toEqual([])
    expect(castShadows('none')).toEqual([])
  })
})

describe('the UI source', () => {
  it('is read', () => {
    expect(files.length).toBeGreaterThan(300)
    expect(files.some((f) => f.name === 'assets/tailwind.css')).toBe(true)
  })

  it('has no colour outside the palette: warm grays and the one orange', () => {
    // Third-party marks keep their makers' colours (the Google sign-in
    // mark must; the integration marks are then shown in grayscale).
    const VENDOR_MARKS = ['pages/auth/LoginPage.vue', 'components/settings/AlertChannels.vue']
    const offenders = []
    for (const file of files) {
      if (VENDOR_MARKS.includes(file.name)) continue
      for (const colour of colourLiterals(file.text)) {
        if (!inPalette(colour)) offenders.push(`${file.name}: ${colour}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps literal colours in the token files: everything else uses tokens', () => {
    const ALLOWED = [
      'assets/tailwind.css', // the tokens
      'assets/css/viz.css', // the gray steps of the chart ramps
      'lib/charts/palette.js', // their fallbacks where no stylesheet is loaded
      'lib/brandLogo.js', // badge fills behind white text
      'lib/agent/download.js', // a standalone exported document
      'components/gap/GapMap.vue', // canvas fallbacks
      'pages/auth/LoginPage.vue',
      'components/settings/AlertChannels.vue',
    ]
    const offenders = files.filter((f) => !ALLOWED.includes(f.name) && colourLiterals(f.text).length).map((f) => f.name)
    expect(offenders).toEqual([])
  })

  it('casts no shadow', () => {
    const offenders = []
    for (const file of files) {
      for (const m of css(file).matchAll(/(?<![-\w])(?:box|text)-shadow:\s*([^;{}]+)/g)) {
        if (castShadows(m[1]).length) offenders.push(`${file.name}: ${m[1].trim().slice(0, 60)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has square corners: no radius literal above 2px', () => {
    const offenders = []
    for (const file of files) {
      for (const m of css(file).matchAll(/(?<![-\w])border(?:-(?:top|bottom)-(?:left|right))?-radius:\s*([^;{}]+)/g)) {
        const px = [...m[1].matchAll(/(?<![\w.-])([\d.]+)(px|rem|em)\b/g)].map((n) => Number(n[1]) * (n[2] === 'px' ? 1 : 16))
        if (px.some((n) => n > 2)) offenders.push(`${file.name}: ${m[1].trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('paints no gradient', () => {
    const ALLOWED = [
      // A working-state shimmer across text, between two ink tokens.
      'components/agent/swarm/SwarmTaskRow.vue',
      'components/agent/swarm/SwarmBlock.vue',
      'components/agent/message/WorkedLabel.vue',
      'components/agent/message/AgentExecutedLine.vue',
      'components/onboarding/SetupStatusPanel.vue',
      // A fade that says the preview is cut off.
      'components/agent/reports/ReportTemplatePreview.vue',
      // The "system" theme swatch: a hard split, half paper and half black.
      'pages/SettingsPage.vue',
    ]
    const offenders = files.filter((f) => !ALLOWED.includes(f.name) && /gradient\(/.test(css(f))).map((f) => f.name)
    expect(offenders).toEqual([])
    // Inline styles and class bindings too.
    const inline = files.filter((f) => f.name.endsWith('.vue') && /style="[^"]*gradient\(|bg-gradient-|bg-linear-/.test(f.text)).map((f) => f.name)
    expect(inline).toEqual([])
  })

  it('uses no Tailwind hue utility and no pill', () => {
    const hue = /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|shadow|accent|caret|divide)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/
    expect(files.filter((f) => /\.(vue|js)$/.test(f.name) && hue.test(f.text)).map((f) => f.name)).toEqual([])
    // rounded-full is for dots, avatars and spinners only.
    const pills = []
    for (const file of files) {
      if (!/\.(vue|js)$/.test(file.name) || file.name.startsWith('components/ui/avatar/')) continue
      for (const line of file.text.split('\n')) {
        if (!line.includes('rounded-full')) continue
        if (/animate-spin/.test(line) || /\bsize-(?:1|1\.5|2)\b/.test(line)) continue
        pills.push(`${file.name}: ${line.trim().slice(0, 70)}`)
      }
    }
    expect(pills).toEqual([])
  })

  it('no longer ships the watercolor film or the gradient panel', () => {
    expect(files.some((f) => /WatercolorBackdrop|GradientCard/.test(f.name))).toBe(false)
    expect(files.filter((f) => /WatercolorBackdrop|GradientCard|watercolor-(main|second)\.mp4/.test(f.text)).map((f) => f.name)).toEqual([])
  })
})
