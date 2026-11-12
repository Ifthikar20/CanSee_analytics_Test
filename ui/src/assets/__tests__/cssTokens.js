// Test helpers for the design tokens: a small reader for the custom
// properties of a CSS block, a var() resolver and WCAG contrast.

/** Strip comments so a selector or value quoted in one is never matched. */
export function stripComments(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * The custom properties of every rule whose selector list includes
 * `selector` exactly (one of its comma-separated selectors), merged in
 * source order. `{ '--paper': '#f3f2ee', ... }`
 */
export function blockVars(css, selector) {
  const out = {}
  const clean = stripComments(css)
  const rule = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = rule.exec(clean))) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ').replace(/'/g, '"'))
    if (!selectors.includes(selector.replace(/'/g, '"'))) continue
    const decl = /(--[\w-]+)\s*:\s*([^;]+);/g
    let d
    while ((d = decl.exec(m[2]))) out[d[1]] = d[2].trim()
  }
  return out
}

/** Follow var(--x) references through `vars` until a literal is left. */
export function resolve(value, vars, depth = 0) {
  if (depth > 12) throw new Error(`var() cycle at ${value}`)
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(value).trim())
  if (!m) return String(value).trim()
  if (!(m[1] in vars)) throw new Error(`unknown token ${m[1]}`)
  return resolve(vars[m[1]], vars, depth + 1)
}

/** '#rrggbb' or '#rgb' -> [r, g, b] (0-255). */
export function rgb(hex) {
  const h = String(hex).trim().replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`)
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two hex colours. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** Hue (0-360) and saturation (0-1, HSL) of a hex colour. */
export function hueSat(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return { hue: 0, sat: 0 }
  const l = (max + min) / 2
  const sat = d / (1 - Math.abs(2 * l - 1))
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  hue = (hue * 60 + 360) % 360
  return { hue, sat }
}

/**
 * True when a colour belongs to the palette: a gray (channels within a few
 * steps of each other, warm or neutral, never blue-leaning) or the orange
 * accent. Chroma, not HSL saturation, decides what is gray: saturation
 * blows up near white, where paper (#f3f2ee) lives.
 */
export function inPalette(hex) {
  const [r, g, b] = rgb(hex)
  if (Math.max(r, g, b) - Math.min(r, g, b) <= 14) return b <= r + 2
  const { hue } = hueSat(hex)
  return hue >= 8 && hue <= 32
}
