import { describe, expect, it } from 'vitest'
import widgetSource from '@/components/board/BoardWidget.vue?raw'
import { SPLIT_MIN_PX, WIDE_MIN_PX, boardMode, dropIndex, edgeSpeed, flowLayout, keyTarget, spanOf } from '../flow'

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
    expect(boardMode(0)).toBe('wide')
    expect(boardMode(639)).toBe('single')
    expect(boardMode(640)).toBe('medium')
    expect(boardMode(1039)).toBe('medium')
    expect(boardMode(1040)).toBe('wide')
    // Just over a breakpoint is the wider mode, as max-width: 1039px no longer matches.
    expect(boardMode(1039.5)).toBe('wide')
    expect(boardMode(639.5)).toBe('medium')
  })

  it('spans the columns of each size in each mode', () => {
    expect(['third', 'half', 'full'].map((s) => spanOf(s, 'wide'))).toEqual([4, 6, 12])
    expect(['third', 'half', 'full'].map((s) => spanOf(s, 'medium'))).toEqual([6, 6, 12])
    expect(['third', 'half', 'full'].map((s) => spanOf(s, 'single'))).toEqual([12, 12, 12])
  })

  it('keeps the thresholds equal to the container queries in BoardWidget.vue', () => {
    expect(widgetSource).toContain(`@container board (max-width: ${WIDE_MIN_PX - 1}px)`)
    expect(widgetSource).toContain(`@container board (max-width: ${SPLIT_MIN_PX - 1}px)`)
    expect(WIDE_MIN_PX - 1).toBe(1039)
    expect(SPLIT_MIN_PX - 1).toBe(639)
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
