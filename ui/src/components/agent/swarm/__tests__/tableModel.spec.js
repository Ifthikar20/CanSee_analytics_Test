import { describe, expect, it } from 'vitest'
import { toCsv } from '@/lib/agent/csv'
import {
  addableRowKeys,
  ariaSort,
  cellClasses,
  csvFilename,
  csvRows,
  isCarried,
  nextSort,
  rowLabel,
  sortRows,
  tableSheets,
} from '../tableModel'
import { swarmTable } from './__fixtures__/swarmParts.js'

const row = (key, v) => ({ key, cells: { c: { text: String(v ?? ''), v } } })
const keys = (rows) => rows.map((r) => r.key)

describe('sortRows', () => {
  const rows = [row('a', 3), row('b', null), row('c', 1), row('d', 3), row('e', 1000), row('f', null)]

  it('sorts by the cell sort key with null last in both directions', () => {
    expect(keys(sortRows(rows, 'c', 'asc'))).toEqual(['c', 'a', 'd', 'e', 'b', 'f'])
    expect(keys(sortRows(rows, 'c', 'desc'))).toEqual(['e', 'a', 'd', 'c', 'b', 'f'])
  })

  it('is stable: equal keys keep the server order in both directions', () => {
    expect(keys(sortRows(rows, 'c', 'asc')).filter((k) => k === 'a' || k === 'd')).toEqual(['a', 'd'])
    expect(keys(sortRows(rows, 'c', 'desc')).filter((k) => k === 'a' || k === 'd')).toEqual(['a', 'd'])
  })

  it('compares strings without case and keeps the order when unsorted', () => {
    const words = [row('x', 'beta'), row('y', 'Alpha'), row('z', 'alpha')]
    expect(keys(sortRows(words, 'c', 'asc'))).toEqual(['y', 'z', 'x'])
    expect(keys(sortRows(rows, 'c', null))).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(sortRows(rows, 'c', 'asc')).not.toBe(rows)
  })

  it('cycles ascending, descending and none, with aria-sort to match', () => {
    let sort = nextSort(null, 'google')
    expect(sort).toEqual({ key: 'google', dir: 'asc' })
    expect(ariaSort(sort, 'google')).toBe('ascending')
    sort = nextSort(sort, 'google')
    expect(ariaSort(sort, 'google')).toBe('descending')
    sort = nextSort(sort, 'google')
    expect(sort).toEqual({ key: null, dir: null })
    expect(ariaSort(sort, 'google')).toBe('none')
    expect(nextSort({ key: 'google', dir: 'desc' }, 'chatgpt')).toEqual({ key: 'chatgpt', dir: 'asc' })
  })
})

describe('sheets, drafts and cells', () => {
  it('shows prompts always and other sheets only with rows, in the fixed order', () => {
    const table = swarmTable()
    expect(tableSheets(table).map((s) => s.key)).toEqual(['prompts', 'gaps'])
    const reordered = { ...table, sheets: [table.sheets[2], table.sheets[1], table.sheets[0]] }
    expect(tableSheets(reordered).map((s) => s.key)).toEqual(['prompts', 'gaps'])
    expect(tableSheets(null)).toEqual([])
  })

  it('offers only rows with a finding draft that are not in Findings yet', () => {
    const prompts = swarmTable().sheets[0]
    expect(addableRowKeys(prompts)).toEqual(['p1', 'p3'])
    expect(addableRowKeys(prompts, (key) => key === 'p1')).toEqual(['p3'])
    expect(rowLabel(prompts, prompts.rows[1])).toBe('notes app with offline mode')
  })

  it('classes cells by state and tone, and spots carried values', () => {
    const [p1, p2] = swarmTable().sheets[0].rows
    expect(cellClasses(p1.cells.google)).toEqual(['is-ok'])
    expect(cellClasses(p1.cells.chatgpt)).toEqual(['is-not-found', 'is-tone-warn'])
    expect(cellClasses(p1.cells.gemini)).toEqual(['is-not-configured'])
    expect(cellClasses(p2.cells.google)).toEqual(['is-failed'])
    expect(cellClasses(p2.cells.chatgpt)).toEqual(['is-ok', 'is-tone-good'])
    expect(cellClasses(null)).toEqual(['is-empty'])
    expect(isCarried(p1.cells.chatgpt, 2)).toBe(true)
    expect(isCarried(p1.cells.google, 2)).toBe(false)
  })
})

describe('CSV', () => {
  it('writes the column labels, then each cell text per column', () => {
    const prompts = swarmTable().sheets[0]
    const rows = csvRows(prompts)
    expect(rows[0]).toEqual(['Prompt', 'Google', 'ChatGPT', 'Gemini', 'Ahead of you', 'Finding'])
    expect(rows[1].slice(0, 4)).toEqual(['best note taking app for teams', '#4', 'Not named', 'Not configured'])
    expect(rows).toHaveLength(4)
  })

  it('guards formula cells', () => {
    const text = toCsv(csvRows(swarmTable().sheets[0]))
    expect(text).toContain(`"'=HYPERLINK(""https://evil.test"",""x"")"`)
    expect(text).not.toMatch(/(^|,)"?=HYPERLINK/m)
  })

  it('names the file after the research, version and sheet', () => {
    const table = swarmTable()
    expect(csvFilename(table, table.sheets[1])).toBe('Research Notion v2 Content gaps.csv')
  })
})
