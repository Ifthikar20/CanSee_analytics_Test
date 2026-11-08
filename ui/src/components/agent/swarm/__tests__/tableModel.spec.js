import { describe, expect, it } from 'vitest'
import { toCsv } from '@/lib/agent/csv'
import {
  addableRowKeys,
  ariaSort,
  cellClasses,
  changeIndex,
  changedColumns,
  csvFilename,
  csvRows,
  filterChangedRows,
  hasChanges,
  hasPrevious,
  isCarried,
  isChangedRow,
  nextSort,
  rowLabel,
  sortRows,
  tableSheets,
  unlistedChangedRows,
  isAddedRow,
} from '../tableModel'
import { overflowTable, swarmTable } from './__fixtures__/swarmParts.js'

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

describe('changes since the previous version', () => {
  const promptsOf = (table) => table.sheets[0]
  const gapsOf = (table) => table.sheets[1]

  it('reads a cell as changed only when it has a previous text', () => {
    expect(hasPrevious({ previous: { text: '#6', version: 1 } })).toBe(true)
    expect(hasPrevious({ previous: { text: '', version: 1 } })).toBe(true)
    expect(hasPrevious({ previous: { text: null, version: 1 } })).toBe(false)
    expect(hasPrevious({ previous: null })).toBe(false)
    expect(hasPrevious(null)).toBe(false)
  })

  it('indexes the listed changes by sheet and row, skipping incomplete entries', () => {
    const table = swarmTable({
      changes: [
        ...swarmTable().changes,
        { sheet: 'prompts', row: 'p1', column: 'chatgpt' },
        { sheet: 'prompts', column: 'google' },
        null,
      ],
    })
    const index = changeIndex(table)
    expect([...index.keys()]).toEqual(['prompts\u0000p1'])
    expect([...index.get('prompts\u0000p1')]).toEqual(['google', 'chatgpt'])
    expect(changeIndex(null).size).toBe(0)
  })

  it('finds the changed cells and rows', () => {
    const [p1, p2] = promptsOf(swarmTable()).rows
    expect(changedColumns(p1)).toEqual(['google'])
    expect(isChangedRow(p1)).toBe(true)
    expect(changedColumns(p2)).toEqual([])
    expect(isChangedRow(p2)).toBe(false)
    expect(isChangedRow({ key: 'x' })).toBe(false)
  })

  it('offers changes only when a previous version exists and something changed', () => {
    expect(hasChanges(swarmTable())).toBe(true)
    const first = swarmTable({ previous_version: null, changes: [] })
    first.sheets[0].rows[0].cells.google.previous = null
    expect(hasChanges(first)).toBe(false)
    const unchanged = swarmTable({ changes: [] })
    unchanged.sheets[0].rows[0].cells.google.previous = null
    expect(hasChanges(unchanged)).toBe(false)
    // An empty change list with previous markers still counts.
    expect(hasChanges(swarmTable({ changes: [] }))).toBe(true)
    expect(hasChanges(null)).toBe(false)
  })

  it('filters to the listed rows in their order, or every changed row', () => {
    const table = overflowTable()
    const rows = promptsOf(table).rows
    const keys = (list) => list.map((r) => r.key)
    expect(keys(filterChangedRows(table, promptsOf(table), rows))).toEqual(['p1'])
    expect(keys(filterChangedRows(table, promptsOf(table), rows, { unlisted: true }))).toEqual(['p1', 'p2', 'p3'])
    expect(keys(filterChangedRows(table, promptsOf(table), [...rows].reverse(), { unlisted: true }))).toEqual([
      'p3',
      'p2',
      'p1',
    ])
    expect(filterChangedRows(table, gapsOf(table), gapsOf(table).rows)).toEqual([])
  })

  it('counts the changed rows the list leaves out entirely, per sheet', () => {
    expect(unlistedChangedRows(swarmTable(), promptsOf(swarmTable()))).toBe(0)
    const table = overflowTable()
    expect(unlistedChangedRows(table, promptsOf(table))).toBe(2)
    expect(unlistedChangedRows(table, gapsOf(table))).toBe(0)
    // With no list at all, every changed row is unlisted.
    expect(unlistedChangedRows(overflowTable({ changes: [] }), promptsOf(overflowTable()))).toBe(3)
  })

  it('never counts a listed row again for a cell the list left out', () => {
    const table = overflowTable()
    // p1 is listed for Google; its ChatGPT change fell past the cap.
    promptsOf(table).rows[0].cells.chatgpt.previous = { text: 'Named #1', version: 1 }
    expect(unlistedChangedRows(table, promptsOf(table))).toBe(2)
  })
})

describe('rows new since the previous version', () => {
  const promptsOf = (table) => table.sheets[0]
  const gapsOf = (table) => table.sheets[1]

  function withNewGap(overrides = {}) {
    const table = swarmTable({ changes: [], ...overrides })
    table.sheets[0].rows[0].cells.google.previous = null
    gapsOf(table).rows[0].added = true
    return table
  }

  it('knows a new row only by the server mark', () => {
    const table = withNewGap()
    expect(isAddedRow(gapsOf(table).rows[0])).toBe(true)
    expect(isAddedRow(promptsOf(table).rows[0])).toBe(false)
    expect(isAddedRow({ key: 'x', added: 'yes' })).toBe(false)
    expect(isAddedRow(null)).toBe(false)
  })

  it('offers the filter when the only change is a new row', () => {
    expect(hasChanges(withNewGap())).toBe(true)
    expect(hasChanges(withNewGap({ previous_version: null }))).toBe(false)
  })

  it('always shows new rows under the filter, and never counts them as unlisted', () => {
    const table = withNewGap()
    const gaps = gapsOf(table)
    expect(filterChangedRows(table, gaps, gaps.rows).map((r) => r.key)).toEqual([gaps.rows[0].key])
    expect(unlistedChangedRows(table, gaps)).toBe(0)
    expect(filterChangedRows(table, promptsOf(table), promptsOf(table).rows)).toEqual([])
  })
})
