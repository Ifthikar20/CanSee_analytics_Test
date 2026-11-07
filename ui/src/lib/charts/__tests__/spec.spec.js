import { describe, expect, it } from 'vitest'
import {
  defaultRepresentation,
  labelText,
  normalizeVizSpec,
  pointText,
  representationsFor,
  STATE_LABELS,
  tableModel,
} from '@/lib/charts/spec'

const days = (n) => Array.from({ length: n }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
const series = (key, data, extra = {}) => ({ key, label: key.toUpperCase(), data, ...extra })

describe('normalizeVizSpec', () => {
  it('clips strings to the contract lengths', () => {
    const s = normalizeVizSpec({
      title: 't'.repeat(200),
      subtitle: 's'.repeat(300),
      unit: 'visitors-long',
      footnote: 'f'.repeat(400),
      labels: ['a'],
      datasets: [series('a', [1])],
    })
    expect(s.title).toHaveLength(120)
    expect(s.subtitle).toHaveLength(200)
    expect(s.unit).toBe('visitors')
    expect(s.footnote).toHaveLength(300)
  })

  it('stringifies labels and pads or cuts every dataset to them', () => {
    const s = normalizeVizSpec({
      title: 'T',
      labels: [1, 2, null],
      datasets: [series('a', [5]), series('b', [1, 2, 3, 4, 5])],
    })
    expect(s.labels).toEqual(['1', '2', ''])
    expect(s.datasets[0].data).toEqual([5, null, null])
    expect(s.datasets[1].data).toEqual([1, 2, 3])
  })

  it('turns values that are not finite numbers into null, never 0', () => {
    const s = normalizeVizSpec({
      title: 'T',
      labels: ['a', 'b', 'c', 'd', 'e', 'f'],
      datasets: [series('a', [1, 'x', null, undefined, Number.NaN, '2.5'])],
    })
    expect(s.datasets[0].data).toEqual([1, null, null, null, null, 2.5])
  })

  it('lets a state force the point to null', () => {
    const s = normalizeVizSpec({
      title: 'T',
      labels: ['a', 'b'],
      datasets: [series('a', [40, 12], { states: [null, 'not_found'] })],
    })
    expect(s.datasets[0].data).toEqual([40, null])
    expect(s.datasets[0].states).toEqual([null, 'not_found'])
  })

  it('ignores unknown states', () => {
    const s = normalizeVizSpec({ title: 'T', labels: ['a'], datasets: [series('a', [3], { states: ['bogus'] })] })
    expect(s.datasets[0].states).toEqual([null])
    expect(s.datasets[0].data).toEqual([3])
  })

  it('drops datasets with neither a value nor a state, and returns null when nothing is left', () => {
    const s = normalizeVizSpec({
      title: 'T',
      labels: ['a'],
      datasets: [series('a', [null]), series('b', [null], { states: ['not_checked'] }), series('c', [2])],
    })
    expect(s.datasets.map((d) => d.key)).toEqual(['b', 'c'])
    expect(normalizeVizSpec({ title: 'T', labels: ['a'], datasets: [series('a', [null])] })).toBe(null)
    expect(normalizeVizSpec({ title: 'T', labels: [], datasets: [series('a', [1])] })).toBe(null)
    expect(normalizeVizSpec(null)).toBe(null)
    expect(normalizeVizSpec([])).toBe(null)
  })

  it('keeps 8 datasets and says how many there were', () => {
    const datasets = Array.from({ length: 11 }, (_, i) => series(`k${i}`, [i + 1]))
    const s = normalizeVizSpec({ title: 'T', labels: ['a'], datasets })
    expect(s.datasets).toHaveLength(8)
    expect(s.truncated).toBe(true)
    expect(s.total_datasets).toBe(11)
    expect(normalizeVizSpec({ title: 'T', labels: ['a'], datasets: [series('a', [1])] }).truncated).toBe(false)
  })

  it('accepts tighter limits', () => {
    const s = normalizeVizSpec(
      { title: 'T', labels: ['a', 'b', 'c'], datasets: [series('a', [1, 2, 3]), series('b', [1, 2, 3])] },
      { limits: { labels: 2, datasets: 1 } },
    )
    expect(s.labels).toEqual(['a', 'b'])
    expect(s.datasets).toHaveLength(1)
  })

  it('upper-cases country labels and their names, UK as GB', () => {
    const s = normalizeVizSpec({
      title: 'T',
      x: 'country',
      labels: ['gb', 'de', 'uk'],
      label_names: { gb: 'United Kingdom' },
      datasets: [series('a', [1, 2, 3])],
    })
    expect(s.labels).toEqual(['GB', 'DE', 'GB'])
    expect(s.label_names).toEqual({ GB: 'United Kingdom' })
  })

  it('keeps a log scale and reads anything else as linear', () => {
    const spec = (scale) => normalizeVizSpec({ title: 'T', x: 'country', labels: ['us'], datasets: [series('a', [1])], scale })
    expect(spec('log').scale).toBe('log')
    expect(spec('linear').scale).toBe('linear')
    expect(spec('sqrt').scale).toBe('linear')
    expect(spec(undefined).scale).toBe('linear')
  })

  it('fills defaults and makes dataset keys unique', () => {
    const s = normalizeVizSpec({ title: 'T', labels: ['a'], datasets: [{ data: [1] }, { key: 'x', data: [2] }, { key: 'x', data: [3] }] })
    expect(s.x).toBe('category')
    expect(s.value).toBe('number')
    expect(s.scale).toBe('linear')
    expect(s.missing_label).toBe('No data')
    expect(s.datasets.map((d) => d.key)).toEqual(['s1', 'x', 'x-3'])
    expect(s.datasets[0].label).toBe('Series 1')
    expect(s.representations).toEqual(['bar', 'heatmap', 'table'])
  })
})

describe('representationsFor (contract 8b)', () => {
  const rep = (spec, opts) => representationsFor({ title: 'T', ...spec }, opts)

  it('country: map, bars, table; no bars for ranks', () => {
    expect(rep({ x: 'country', value: 'percent', labels: ['gb', 'de'], datasets: [series('a', [1, 2])] })).toEqual([
      'map',
      'hbar',
      'table',
    ])
    expect(rep({ x: 'country', value: 'rank', labels: ['gb'], datasets: [series('a', [3])] })).toEqual(['map', 'table'])
  })

  it('time with ranks: a reversed line and the table', () => {
    expect(rep({ x: 'time', value: 'rank', labels: days(3), datasets: [series('a', [1, 2, 3]), series('b', [3, 2, 1])] })).toEqual([
      'line',
      'table',
    ])
  })

  it('time, one series: line, area, bars, table', () => {
    expect(rep({ x: 'time', labels: days(3), datasets: [series('a', [1, 2, 3])] })).toEqual(['line', 'area', 'bar', 'table'])
  })

  it('time, several series: stacked only when stacked, heatmap only up to 31 labels', () => {
    const two = [series('a', [1, 2, 3]), series('b', [3, 2, 1])]
    expect(rep({ x: 'time', labels: days(3), datasets: two })).toEqual(['line', 'area', 'bar', 'heatmap', 'table'])
    expect(rep({ x: 'time', labels: days(3), datasets: two, stacked: true })).toEqual([
      'line',
      'area',
      'bar',
      'stacked_bar',
      'heatmap',
      'table',
    ])
    const long = days(31).concat(['2026-11-01'])
    expect(rep({ x: 'time', labels: long, datasets: [series('a', long.map(() => 1)), series('b', long.map(() => 2))] })).toEqual([
      'line',
      'area',
      'bar',
      'table',
    ])
  })

  it('category with ranks: heatmap for two or more series, else the table only', () => {
    expect(rep({ value: 'rank', labels: ['a', 'b'], datasets: [series('a', [1, 2]), series('b', [2, 1])] })).toEqual([
      'heatmap',
      'table',
    ])
    expect(rep({ value: 'rank', labels: ['a', 'b'], datasets: [series('a', [1, 2])] })).toEqual(['table'])
  })

  it('category, one series: bars, horizontal for long or many labels or when asked', () => {
    expect(rep({ labels: ['a', 'b'], datasets: [series('a', [1, 2])] })).toEqual(['bar', 'table'])
    expect(rep({ labels: ['a much longer label', 'b'], datasets: [series('a', [1, 2])] })).toEqual(['hbar', 'table'])
    const nine = Array.from({ length: 9 }, (_, i) => `l${i}`)
    expect(rep({ labels: nine, datasets: [series('a', nine.map(() => 1))] })).toEqual(['hbar', 'table'])
    expect(rep({ type: 'hbar', labels: ['a'], datasets: [series('a', [1])] })).toEqual(['hbar', 'table'])
  })

  it('reads label names when measuring label length', () => {
    expect(
      rep({ labels: ['p1'], label_names: { p1: 'best note taking app for teams' }, datasets: [series('a', [1])] }),
    ).toEqual(['hbar', 'table'])
  })

  it('category, one series: a donut only for a stacked whole of up to 6 non-negative parts', () => {
    const parts = { labels: ['a', 'b', 'c'], datasets: [series('a', [1, 2, 3])] }
    expect(rep({ ...parts, stacked: true })).toEqual(['bar', 'doughnut', 'table'])
    expect(rep(parts)).toEqual(['bar', 'table'])
    expect(rep({ labels: ['a', 'b'], stacked: true, datasets: [series('a', [1, -2])] })).toEqual(['bar', 'table'])
    expect(rep({ labels: ['a', 'b'], stacked: true, datasets: [series('a', [1, null])] })).toEqual(['bar', 'table'])
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(rep({ labels: seven, stacked: true, datasets: [series('a', seven.map(() => 1))] })).toEqual([
      'bar',
      'table',
    ])
  })

  it('category, several series: bars, stacked when stacked, heatmap', () => {
    const two = [series('a', [1, 2]), series('b', [2, 1])]
    expect(rep({ labels: ['a', 'b'], datasets: two })).toEqual(['bar', 'heatmap', 'table'])
    expect(rep({ labels: ['a', 'b'], datasets: two, stacked: true })).toEqual(['bar', 'stacked_bar', 'heatmap', 'table'])
  })

  it('lets an explicit list win, filtered to what can draw the spec, table last', () => {
    expect(rep({ labels: ['a'], datasets: [series('a', [1])], representations: ['custom', 'table'] })).toEqual([
      'custom',
      'table',
    ])
    expect(rep({ labels: ['a'], datasets: [series('a', [1])], representations: ['table', 'custom', 'hbar'] })).toEqual([
      'custom',
      'hbar',
      'table',
    ])
    expect(rep({ labels: ['a'], datasets: [series('a', [1])], representations: ['map', 'doughnut', 'bogus'] })).toEqual([
      'table',
    ])
  })

  it('never offers bar and hbar together', () => {
    expect(rep({ labels: ['a'], datasets: [series('a', [1])], representations: ['bar', 'hbar'] })).toEqual(['bar', 'table'])
    expect(
      rep({ labels: ['a label over fourteen'], datasets: [series('a', [1])], representations: ['bar', 'hbar'] }),
    ).toEqual(['hbar', 'table'])
  })

  it('offers what suits the picked dataset of a pick_one spec', () => {
    const spec = {
      x: 'country',
      pick_one: true,
      labels: ['gb', 'de'],
      datasets: [
        series('ai', [40, 20], { value: 'percent' }),
        series('google', [3, 7], { value: 'rank' }),
      ],
    }
    expect(rep(spec)).toEqual(['map', 'hbar', 'table'])
    expect(rep(spec, { picked: 'google' })).toEqual(['map', 'table'])
    const byEngine = {
      pick_one: true,
      labels: ['chatgpt', 'claude'],
      datasets: [series('vis', [40, 20], { value: 'percent' }), series('rank', [2, 3], { value: 'rank' })],
    }
    expect(rep(byEngine)).toEqual(['bar', 'table'])
    expect(rep(byEngine, { picked: 'rank' })).toEqual(['table'])
  })
})

describe('defaultRepresentation', () => {
  const two = [series('a', [1, 2]), series('b', [2, 1])]

  it('uses the type when offered, else the first offered', () => {
    expect(defaultRepresentation({ title: 'T', labels: ['a', 'b'], datasets: two, type: 'heatmap' })).toBe('heatmap')
    expect(defaultRepresentation({ title: 'T', labels: ['a', 'b'], datasets: two, type: 'doughnut' })).toBe('bar')
    expect(defaultRepresentation({ title: 'T', labels: ['a', 'b'], datasets: two })).toBe('bar')
  })

  it('keeps a map a map at any width: it scales', () => {
    const map = { title: 'T', x: 'country', labels: ['gb'], datasets: [series('a', [40])] }
    expect(defaultRepresentation(map)).toBe('map')
    // The old option is ignored.
    expect(defaultRepresentation(map, { narrow: true })).toBe('map')
    expect(defaultRepresentation({ ...map, value: 'rank' })).toBe('map')
  })

  it('falls back to the table for nothing to draw', () => {
    expect(defaultRepresentation(null)).toBe('table')
  })

  it('starts as the table when every point of the plot is a state word', () => {
    // Google checks of one prompt that all missed: an empty line plot otherwise.
    const missed = {
      title: 'Google position',
      x: 'time',
      value: 'rank',
      labels: ['2026-11-03T15:04:19Z', '2026-11-04T15:04:19Z'],
      state_labels: { not_found: 'Not in top 30' },
      datasets: [series('google', [null, null], { states: ['not_found', 'failed'] })],
    }
    expect(representationsFor(missed)).toEqual(['line', 'table'])
    expect(defaultRepresentation(missed)).toBe('table')
    expect(defaultRepresentation({ ...missed, datasets: [series('google', [null, 4], { states: ['not_found', null] })] })).toBe('line')

    // pick_one: decided by the drawn measure; maps and heatmaps show states as they are.
    const picked = {
      title: 'By engine',
      labels: ['chatgpt', 'claude'],
      pick_one: true,
      datasets: [series('vis', [null, null], { value: 'percent', states: ['not_checked', 'not_checked'] }), series('n', [0, 3], { value: 'count' })],
    }
    expect(defaultRepresentation(picked)).toBe('table')
    expect(defaultRepresentation(picked, { picked: 'n' })).toBe('bar')
    const map = { title: 'T', x: 'country', labels: ['gb'], datasets: [series('a', [null], { states: ['not_checked'] })] }
    expect(defaultRepresentation(map)).toBe('map')
  })
})

describe('pointText and tableModel', () => {
  const spec = normalizeVizSpec({
    title: 'Visibility',
    value: 'percent',
    labels: ['p1', 'p2', 'p3'],
    label_names: { p1: 'best crm' },
    missing_label: 'No answers',
    state_labels: { not_found: 'Not in top 10' },
    datasets: [
      series('chatgpt', [40, null, null], { label: 'ChatGPT', states: [null, 'not_checked', null] }),
      series('rank', [2, 5.5, null], { label: 'Google', value: 'rank', states: [null, null, 'not_found'] }),
    ],
  })

  it('reads values in their own kind, states as words, and missing points as the missing label', () => {
    expect(pointText(spec, 0, 0)).toBe('40%')
    expect(pointText(spec, 0, 1)).toBe(STATE_LABELS.not_checked)
    expect(pointText(spec, 0, 2)).toBe('No answers')
    expect(pointText(spec, 1, 1)).toBe('#5.5')
    expect(pointText(spec, 1, 2)).toBe('Not in top 10')
    expect(pointText(spec, 9, 0)).toBe('')
  })

  it('builds one row per label and one column per dataset', () => {
    const model = tableModel(spec)
    expect(model.caption).toBe('Visibility')
    expect(model.labelHeader).toBe('Name')
    expect(model.columns).toEqual([
      { key: 'chatgpt', label: 'ChatGPT', align: 'right', text: false },
      { key: 'rank', label: 'Google', align: 'right', text: false },
    ])
    expect(model.rows.map((r) => r.label)).toEqual(['best crm', 'p2', 'p3'])
    expect(model.rows[1].cells[0]).toEqual({ text: 'Not checked', value: null, state: 'not_checked', kind: 'state' })
    expect(model.rows[0].cells.map((c) => c.text)).toEqual(['40%', '#2'])
  })

  it('reads a point by its own text first, and keeps text-only datasets as table columns', () => {
    const s = normalizeVizSpec({
      title: 'The gap',
      labels: ['p1', 'p2'],
      datasets: [
        { key: 'google', label: 'Google', value: 'rank', data: [94, null], states: [null, 'failed'], texts: [null, 'Check failed'] },
        { key: 'score', label: 'AI score', data: [40, 70] },
        { key: 'gap', label: 'Gap', texts: ['Google ahead', 'AI ahead'] },
        { key: 'none', label: 'Nothing', data: [null, null] },
      ],
    })
    expect(s.datasets.map((d) => d.key)).toEqual(['google', 'score'])
    expect(s.text_columns.map((d) => d.key)).toEqual(['gap'])
    expect(pointText(s, 0, 0)).toBe('#94')
    expect(pointText(s, 0, 1)).toBe('Check failed')
    expect(representationsFor(s)).toEqual(['bar', 'heatmap', 'table'])
    const model = tableModel(s)
    expect(model.columns.map((c) => [c.label, c.align])).toEqual([
      ['Google', 'right'],
      ['AI score', 'right'],
      ['Gap', 'left'],
    ])
    expect(model.rows[1].cells.map((c) => [c.text, c.kind])).toEqual([
      ['Check failed', 'text'],
      ['70', 'value'],
      ['AI ahead', 'text'],
    ])
    expect(normalizeVizSpec({ title: 'T', labels: ['a'], datasets: [{ key: 'gap', texts: ['Even'] }] })).toBe(null)
  })

  it('names dates and countries in the label column', () => {
    const time = normalizeVizSpec({ title: 'T', x: 'time', time_unit: 'week', labels: ['2026-11-02'], datasets: [series('a', [1])] })
    expect(labelText(time, 0)).toBe('Week of 2 Nov')
    expect(tableModel(time).labelHeader).toBe('Week')
    const map = normalizeVizSpec({ title: 'T', x: 'country', labels: ['de'], datasets: [series('a', [1])], label_header: 'Market' })
    expect(labelText(map, 0)).toBe('Germany')
    expect(tableModel(map).labelHeader).toBe('Market')
  })
})
