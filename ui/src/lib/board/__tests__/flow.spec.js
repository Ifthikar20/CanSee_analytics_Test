import { describe, expect, it } from 'vitest'
import gridSource from '@/components/board/BoardGrid.vue?raw'
import {
  DEFAULT_DENSITY,
  DENSE_MIN_PX,
  DENSITIES,
  SPLIT_MIN_PX,
  WIDE_MIN_PX,
  boardMode,
  cleanDensity, dropIndex, edgeSpeed, flowLayout, keyTarget, spanOf } from '../flow'
import { defaultLayout } from '../layout'

const third = (key) => ({ key, size: 'third' })
const half = (key) => ({ key, size: 'half' })
const full = (key) => ({ key, size: 'full' })
const at = (layout) => layout.map(({ key, row, col, span }) => `${key}:${row}/${col}/${span}`)

// Layout boxes of a 1200px wide board: 16px gaps, 300px rows.
const GAP = 16
const ROW = 300
const COL = (1200 - 11 * GAP) / 12
function boxes(items) {
  return flowLayout(items, 'wide').map(({ key, row, col, span }) => ({
    key,
    x: col * (COL + GAP),
    y: row * (ROW + GAP),
    w: span * COL + (span - 1) * GAP,
    h: ROW,
  }))
}

describe('boardMode and spanOf', () => {
  it('reads the column mode from the board width, like the container queries', () => {
    // Three columns of thirds, as wide as the board allows.
    expect(boardMode(0, 3)).toBe('wide')
    expect(boardMode(639, 3)).toBe('single')
    expect(boardMode(640, 3)).toBe('medium')
    expect(boardMode(919, 3)).toBe('medium')
    expect(boardMode(920, 3)).toBe('wide')
    expect(boardMode(4000, 3)).toBe('wide')
    // Just over a breakpoint is the wider mode, as max-width: 919px no longer matches.
    expect(boardMode(919.5, 3)).toBe('wide')
    expect(boardMode(639.5, 3)).toBe('medium')
  })

  it('shows the density on a board wide enough for it, else two columns', () => {
    // Four: only on a board wide enough. A narrower one folds in half, to
    // two columns, and never shows three.
    expect(boardMode(0, 4)).toBe('dense')
    expect(boardMode(1240, 4)).toBe('dense')
    expect(boardMode(1239.5, 4)).toBe('dense')
    expect(boardMode(1239, 4)).toBe('medium')
    expect(boardMode(1232, 4)).toBe('medium') // a 1280px laptop
    expect(boardMode(976, 4)).toBe('medium') // a tablet on its side
    expect(boardMode(920, 4)).toBe('medium')
    expect(boardMode(919, 4)).toBe('medium')
    expect(boardMode(640, 4)).toBe('medium')
    expect(boardMode(639, 4)).toBe('single')
    for (let w = SPLIT_MIN_PX; w < DENSE_MIN_PX; w += 1) expect(boardMode(w, 4), w).toBe('medium')
    // Three keeps its three columns on the same widths: the user asked for them.
    expect(boardMode(1239, 3)).toBe('wide')
    expect(boardMode(1232, 3)).toBe('wide')
    // Two: never more, whatever the width.
    expect(boardMode(0, 2)).toBe('medium')
    expect(boardMode(4000, 2)).toBe('medium')
    expect(boardMode(640, 2)).toBe('medium')
    expect(boardMode(639, 2)).toBe('single')
    // A phone is one column at every density.
    for (const n of DENSITIES) expect(boardMode(390, n), n).toBe('single')
  })

  it('falls back to the default density for a missing or unknown one', () => {
    expect(DENSITIES).toEqual([2, 3, 4])
    expect(DEFAULT_DENSITY).toBe(4)
    expect(DENSITIES.map(cleanDensity)).toEqual([2, 3, 4])
    // The grid's data-columns attribute is a string.
    expect(['2', '3', '4'].map(cleanDensity)).toEqual([2, 3, 4])
    for (const bad of [undefined, null, '', 'many', 0, 1, 5, 3.5, NaN, {}, true]) expect(cleanDensity(bad), String(bad)).toBe(4)
    expect(boardMode(2000)).toBe('dense')
    expect(boardMode(2000, 'many')).toBe('dense')
    expect(boardMode(2000, '3')).toBe('wide')
    expect(boardMode(2000, '2')).toBe('medium')
  })

  it('spans the columns of each size in each mode', () => {
    expect(['third', 'half', 'full'].map((s) => spanOf(s, 'dense'))).toEqual([3, 6, 12])
    expect(['third', 'half', 'full'].map((s) => spanOf(s, 'wide'))).toEqual([4, 6, 12])
    expect(['third', 'half', 'full'].map((s) => spanOf(s, 'medium'))).toEqual([6, 6, 12])
    expect(['third', 'half', 'full'].map((s) => spanOf(s, 'single'))).toEqual([12, 12, 12])
    // An unknown size takes the row; an unknown mode is the three-column one.
    expect(spanOf('huge', 'dense')).toBe(12)
    expect(spanOf('third', 'nope')).toBe(4)
  })

  it('keeps the thresholds and spans equal to the rules in BoardGrid.vue', () => {
    const css = gridSource.replace(/\s+/g, ' ')
    expect(css).toContain(`@container board (max-width: ${DENSE_MIN_PX - 1}px)`)
    expect(css).toContain(`@container board (max-width: ${WIDE_MIN_PX - 1}px)`)
    expect(css).toContain(`@container board (max-width: ${SPLIT_MIN_PX - 1}px)`)
    expect([DENSE_MIN_PX - 1, WIDE_MIN_PX - 1, SPLIT_MIN_PX - 1]).toEqual([1239, 919, 639])
    // Each density's own span of a third, on a board wide enough for it.
    expect(css).toContain(`.bd-grid.is-cols-2 { --bd-span-third: ${spanOf('third', 'medium')}; }`)
    expect(css).toContain(`.bd-grid.is-cols-3 { --bd-span-third: ${spanOf('third', 'wide')}; }`)
    expect(css).toContain(`.bd-grid.is-cols-4 { --bd-span-third: ${spanOf('third', 'dense')}; }`)
    // A board too narrow for four columns shows two, not three; one too
    // narrow for three shows two; a phone shows one.
    expect(css).toContain(
      `@container board (max-width: 1239px) { .bd-grid.is-cols-4 { --bd-span-third: ${spanOf('third', 'medium')}; } }`,
    )
    expect(css).toContain(
      `@container board (max-width: 919px) { .bd-grid.is-cols-3 { --bd-span-third: ${spanOf('third', 'medium')}; } }`,
    )
    expect(css).toContain(
      '@container board (max-width: 639px) { .bd-grid.is-cols-2, .bd-grid.is-cols-3, .bd-grid.is-cols-4 { --bd-span-third: 12; --bd-span-half: 12; } }',
    )
  })
})

// The spans the rules in BoardGrid.vue give a board `width` px wide at a
// density: each density's own rule, then every container query that matches,
// in source order (as the cascade does).
function cssSpans(width, density) {
  const css = gridSource.slice(gridSource.indexOf('<style scoped>')).replace(/\/\*[\s\S]*?\*\//g, '')
  const spans = { third: 0, half: 6, full: 12 }
  const apply = (block) => {
    for (const [, selectors, body] of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selectors.split(',').some((sel) => sel.trim() === `.bd-grid.is-cols-${density}`)) continue
      for (const [, size, n] of body.matchAll(/--bd-span-(third|half):\s*(\d+)/g)) spans[size] = Number(n)
    }
  }
  const queries = [...css.matchAll(/@container board \(max-width: (\d+)px\)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)]
  apply(css.replace(/@container[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, ''))
  for (const [, max, block] of queries) if (width <= Number(max)) apply(block)
  return spans
}

// The rows of a layout as the columns each one fills, e.g. [12, 12, 4].
function rowFills(items, span) {
  const rows = []
  let col = 0
  for (const item of items) {
    const n = span(item.size)
    if (col > 0 && col + n > 12) col = 0
    if (col === 0) rows.push(0)
    rows[rows.length - 1] += n
    col += n
  }
  return rows
}

describe('the default board at each width', () => {
  // A 1280px laptop's board is 1232px wide; 976px is a tablet on its side.
  const WIDTHS = [640, 700, 768, 919, 920, 976, 1024, 1100, 1232, 1239, 1240, 1392, 1920, 2560]

  it('starts with four thirds, the row of four', () => {
    expect(defaultLayout().slice(0, 4).map((w) => w.size)).toEqual(['third', 'third', 'third', 'third'])
  })

  it('never leaves a lone third, or any gap, in a row at four columns', () => {
    for (let w = SPLIT_MIN_PX; w <= 2600; w += 1) {
      const mode = boardMode(w, 4)
      const layout = flowLayout(defaultLayout(), mode)
      const fills = rowFills(defaultLayout(), (size) => spanOf(size, mode))
      expect(fills.every((n) => n === 12), `${w}px: ${fills}`).toBe(true)
      // The four small blocks are one row of four or two rows of two.
      const rows = layout.slice(0, 4).map((c) => c.row)
      expect([[0, 0, 0, 0], [0, 0, 1, 1]], `${w}px`).toContainEqual(rows)
    }
  })

  it('fills every row at four columns under the rules of BoardGrid.vue too', () => {
    for (const w of WIDTHS) {
      const spans = cssSpans(w, 4)
      const fills = rowFills(defaultLayout(), (size) => spans[size])
      expect(fills.every((n) => n === 12), `${w}px: ${fills}`).toBe(true)
    }
  })

  it('gives each width and density the same spans in the CSS as in boardMode', () => {
    for (const density of DENSITIES) {
      for (const w of [...WIDTHS, 639, 390]) {
        const mode = boardMode(w, density)
        const spans = cssSpans(w, density)
        expect([spans.third, spans.half], `${density} columns at ${w}px`).toEqual([spanOf('third', mode), spanOf('half', mode)])
      }
    }
  })

  it('reads the spans from the CSS, not from a constant', () => {
    expect(cssSpans(2000, 4)).toEqual({ third: 3, half: 6, full: 12 })
    expect(cssSpans(2000, 3)).toEqual({ third: 4, half: 6, full: 12 })
    expect(cssSpans(2000, 2)).toEqual({ third: 6, half: 6, full: 12 })
    expect(cssSpans(390, 4)).toEqual({ third: 12, half: 12, full: 12 })
    // Three columns is the user's choice: a row of four thirds is then three and one.
    expect(rowFills(defaultLayout(), (size) => cssSpans(1232, 3)[size])).toEqual([12, 4, 12, 12])
  })
})

describe('flowLayout', () => {
  it('fills rows in order, and a cell that does not fit starts the next row', () => {
    expect(at(flowLayout([third('a'), third('b'), third('c')], 'wide'))).toEqual(['a:0/0/4', 'b:0/4/4', 'c:0/8/4'])
    // A half then a full wraps.
    expect(at(flowLayout([half('a'), full('b')], 'wide'))).toEqual(['a:0/0/6', 'b:1/0/12'])
    // A full after a third starts a new row.
    expect(at(flowLayout([third('a'), full('b')], 'wide'))).toEqual(['a:0/0/4', 'b:1/0/12'])
    // A third and a half share a row; a third after them starts the next one.
    expect(at(flowLayout([third('a'), half('b'), third('c')], 'wide'))).toEqual(['a:0/0/4', 'b:0/4/6', 'c:1/0/4'])
  })

  it('puts four thirds in a row of a dense board, and a half takes two of them', () => {
    expect(at(flowLayout([third('a'), third('b'), third('c'), third('d'), full('e')], 'dense'))).toEqual([
      'a:0/0/3',
      'b:0/3/3',
      'c:0/6/3',
      'd:0/9/3',
      'e:1/0/12',
    ])
    expect(at(flowLayout([third('a'), half('b'), third('c'), third('d')], 'dense'))).toEqual([
      'a:0/0/3',
      'b:0/3/6',
      'c:0/9/3',
      'd:1/0/3',
    ])
    // Down from the last of four lands under it, on the full row.
    const row = [third('a'), third('b'), third('c'), third('d'), full('e')]
    expect(keyTarget(row, 'd', 'ArrowDown', 'dense')).toEqual({ index: 4, edge: null })
    expect(keyTarget(row, 'd', 'ArrowUp', 'dense')).toEqual({ index: 3, edge: 'top' })
  })

  it('lays out the medium and single modes', () => {
    expect(at(flowLayout([third('a'), third('b'), third('c'), full('d')], 'medium'))).toEqual([
      'a:0/0/6',
      'b:0/6/6',
      'c:1/0/6',
      'd:2/0/12',
    ])
    expect(at(flowLayout([third('a'), half('b')], 'single'))).toEqual(['a:0/0/12', 'b:1/0/12'])
    expect(flowLayout([], 'wide')).toEqual([])
  })
})

describe('keyTarget', () => {
  const four = [third('a'), third('b'), third('c'), third('d')]
  const six = [...four, third('e'), third('f')]

  it('moves one place with Left and Right, to the ends with Home and End, and says when it cannot', () => {
    expect(keyTarget(four, 'b', 'ArrowLeft', 'wide')).toEqual({ index: 0, edge: null })
    expect(keyTarget(four, 'b', 'ArrowRight', 'wide')).toEqual({ index: 2, edge: null })
    expect(keyTarget(four, 'b', 'Home', 'wide')).toEqual({ index: 0, edge: null })
    expect(keyTarget(four, 'b', 'End', 'wide')).toEqual({ index: 3, edge: null })
    expect(keyTarget(four, 'a', 'ArrowLeft', 'wide')).toEqual({ index: 0, edge: 'first' })
    expect(keyTarget(four, 'a', 'Home', 'wide')).toEqual({ index: 0, edge: 'first' })
    expect(keyTarget(four, 'd', 'ArrowRight', 'wide')).toEqual({ index: 3, edge: 'last' })
    expect(keyTarget(four, 'd', 'End', 'wide')).toEqual({ index: 3, edge: 'last' })
    expect(keyTarget(four, 'b', 'ArrowUp', 'wide')).toEqual({ index: 1, edge: 'top' })
    // d is alone on the last row.
    expect(keyTarget(four, 'd', 'ArrowDown', 'wide')).toEqual({ index: 3, edge: 'bottom' })
    expect(keyTarget(four, 'x', 'ArrowLeft', 'wide')).toEqual({ index: -1, edge: null })
  })

  it('keeps the column with Up and Down in a grid of thirds', () => {
    // b is in the middle of the top row: Down puts it in the middle of the next one.
    expect(keyTarget(six, 'b', 'ArrowDown', 'wide')).toEqual({ index: 4, edge: null })
    expect(at(flowLayout([six[0], six[2], six[3], six[4], six[1], six[5]], 'wide'))[4]).toBe('b:1/4/4')
    expect(keyTarget(six, 'e', 'ArrowUp', 'wide')).toEqual({ index: 1, edge: null })
    expect(keyTarget(six, 'a', 'ArrowDown', 'wide')).toEqual({ index: 3, edge: null })
    expect(keyTarget(six, 'f', 'ArrowUp', 'wide')).toEqual({ index: 2, edge: null })
    expect(keyTarget(six, 'e', 'ArrowDown', 'wide')).toEqual({ index: 4, edge: 'bottom' })
  })

  it('takes a third over or under a full-width card, which then has the row to itself', () => {
    // Below it, Up puts the third above it.
    expect(keyTarget([full('a'), third('b')], 'b', 'ArrowUp', 'wide')).toEqual({ index: 0, edge: null })
    // Above it, Down puts the third after it.
    expect(keyTarget([third('b'), full('a')], 'b', 'ArrowDown', 'wide')).toEqual({ index: 1, edge: null })
    // Two rows down: the full card's row has no room, so the third lands after it,
    // under its own column.
    expect(keyTarget([third('a'), third('b'), full('c'), third('d')], 'a', 'ArrowDown', 'wide')).toEqual({
      index: 2,
      edge: null,
    })
  })

  it('moves one place with Up and Down on a one-column board', () => {
    const three = [third('a'), half('b'), full('c')]
    expect(keyTarget(three, 'b', 'ArrowUp', 'single')).toEqual({ index: 0, edge: null })
    expect(keyTarget(three, 'b', 'ArrowDown', 'single')).toEqual({ index: 2, edge: null })
    expect(keyTarget(three, 'a', 'ArrowUp', 'single')).toEqual({ index: 0, edge: 'top' })
    expect(keyTarget(three, 'c', 'ArrowDown', 'single')).toEqual({ index: 2, edge: 'bottom' })
  })
})

describe('dropIndex', () => {
  it('changes nothing over the slot', () => {
    const cells = boxes([third('s'), third('a'), third('b')])
    expect(dropIndex(cells, 's', { x: 100, y: 100 }, 1200)).toBe(0)
  })

  it("puts the widget before a third's leading half and after its trailing half", () => {
    // s, a, b on the top row, c below; b spans x 810.67 to 1200.
    const cells = boxes([third('s'), third('a'), third('b'), third('c')])
    expect(dropIndex(cells, 's', { x: 900, y: 100 }, 1200)).toBe(1)
    expect(dropIndex(cells, 's', { x: 1100, y: 100 }, 1200)).toBe(2)
    expect(dropIndex(cells, 's', { x: 300, y: 400 }, 1200)).toBe(3)
  })

  it("puts the widget before a half's leading half and after its trailing half", () => {
    // a spans x 0 to 592, b 608 to 1200; s is on the next row.
    const cells = boxes([half('a'), half('b'), third('s')])
    expect(dropIndex(cells, 's', { x: 100, y: 100 }, 1200)).toBe(0)
    expect(dropIndex(cells, 's', { x: 400, y: 100 }, 1200)).toBe(1)
    expect(dropIndex(cells, 's', { x: 700, y: 100 }, 1200)).toBe(1)
  })

  it("splits a full-width card into top and bottom halves", () => {
    // A third over the top half of a full card goes above it, alone on its row.
    expect(dropIndex(boxes([full('a'), third('s')]), 's', { x: 1100, y: 100 }, 1200)).toBe(0)
    // s first, a full below it (y 316 to 616), then b.
    const cells = boxes([third('s'), full('a'), third('b')])
    expect(dropIndex(cells, 's', { x: 600, y: 400 }, 1200)).toBe(0)
    expect(dropIndex(cells, 's', { x: 100, y: 500 }, 1200)).toBe(1)
  })

  it("goes after a row's last card from the empty end of the row", () => {
    // a and b leave the right third of the top row empty; c is full width.
    const cells = boxes([third('a'), third('b'), full('c'), third('s')])
    expect(dropIndex(cells, 's', { x: 1000, y: 100 }, 1200)).toBe(2)
  })

  it('changes nothing from the empty end of the row the slot ends', () => {
    const cells = boxes([third('a'), third('s'), full('b')])
    expect(dropIndex(cells, 's', { x: 1000, y: 100 }, 1200)).toBe(1)
  })

  it('goes first above the grid and last below it', () => {
    expect(dropIndex(boxes([third('a'), third('b'), third('s')]), 's', { x: 100, y: -20 }, 1200)).toBe(0)
    expect(dropIndex(boxes([third('s'), third('a'), third('b')]), 's', { x: 100, y: 400 }, 1200)).toBe(2)
  })

  it('changes nothing in a gap between cards or rows', () => {
    const cells = boxes([third('a'), third('b'), third('c'), third('s')])
    // a ends at 389.33 and b starts at 405.33.
    expect(dropIndex(cells, 's', { x: 397, y: 100 }, 1200)).toBe(3)
    // The top row ends at 300 and the next starts at 316.
    expect(dropIndex(cells, 's', { x: 100, y: 308 }, 1200)).toBe(3)
  })
})

describe('edgeSpeed', () => {
  it('is 0 outside the zone, ramps up inside it and is at its maximum at and beyond the edge', () => {
    expect(edgeSpeed(72)).toBe(0)
    expect(edgeSpeed(200)).toBe(0)
    expect(edgeSpeed(36)).toBe(225)
    expect(edgeSpeed(18)).toBeCloseTo(506.25)
    expect(edgeSpeed(0)).toBe(900)
    expect(edgeSpeed(-40)).toBe(900)
    expect(edgeSpeed(50, { zone: 100, max: 1000 })).toBe(250)
    expect(edgeSpeed(Number.NaN)).toBe(0)
  })
})
