import { describe, expect, it } from 'vitest'
import {
  CHART_TYPES,
  formatChartValue,
  MAX_DATASETS,
  MAX_LABELS,
  normalizeChartSpec,
  parseChartSpec,
  toVizSpec,
} from '@/lib/agent/chartSpec'
import { representationsFor } from '@/lib/charts/spec'

const part = (extra = {}) => ({
  type: 'bar',
  title: 'Answers by engine',
  labels: ['ChatGPT', 'Claude'],
  datasets: [{ label: 'Answers', data: [12, 7] }],
  ...extra,
})

describe('normalizeChartSpec', () => {
  it('keeps the known types and turns anything else into bar', () => {
    expect(CHART_TYPES).toEqual(['bar', 'line', 'doughnut', 'area', 'stacked_bar', 'heatmap', 'table'])
    expect(normalizeChartSpec(part({ type: 'line' })).type).toBe('line')
    expect(normalizeChartSpec(part({ type: 'heatmap' })).type).toBe('heatmap')
    expect(normalizeChartSpec(part({ type: 'pie' })).type).toBe('bar')
    expect(normalizeChartSpec(part({ type: undefined })).type).toBe('bar')
  })

  it('keeps at most 12 labels and 3 datasets', () => {
    const labels = Array.from({ length: 15 }, (_, i) => `L${i}`)
    const datasets = Array.from({ length: 5 }, (_, i) => ({ label: `S${i}`, data: labels.map(() => i + 1) }))
    const spec = normalizeChartSpec(part({ labels, datasets }))
    expect(spec.labels).toHaveLength(MAX_LABELS)
    expect(spec.datasets).toHaveLength(MAX_DATASETS)
    expect(spec.datasets[0].data).toHaveLength(MAX_LABELS)
  })

  it('keeps numbers, turns everything else into null and drops empty datasets', () => {
    const spec = normalizeChartSpec(
      part({ labels: ['a', 'b', 'c', 'd'], datasets: [{ label: 'x', data: [1, '2', 'n/a', true] }, { label: 'empty', data: [null] }] }),
    )
    expect(spec.datasets).toEqual([{ label: 'x', data: [1, 2, null, null] }])
  })

  it('clips the title and unit', () => {
    const spec = normalizeChartSpec(part({ title: 'x'.repeat(200), unit: 'kilometres' }))
    expect(spec.title).toHaveLength(120)
    expect(spec.unit).toBe('kilometr')
  })

  it('returns null when nothing can be plotted', () => {
    expect(normalizeChartSpec(null)).toBe(null)
    expect(normalizeChartSpec([])).toBe(null)
    expect(normalizeChartSpec(part({ labels: [] }))).toBe(null)
    expect(normalizeChartSpec(part({ datasets: [{ label: 'x', data: [null, null] }] }))).toBe(null)
  })

  it('parses JSON text and refuses broken text', () => {
    expect(parseChartSpec(JSON.stringify(part())).labels).toEqual(['ChatGPT', 'Claude'])
    expect(parseChartSpec('{broken')).toBe(null)
  })

  it('formats values with the unit', () => {
    expect(formatChartValue(42, '%')).toBe('42%')
    expect(formatChartValue(null)).toBe('No data')
  })
})

describe('toVizSpec', () => {
  it('maps a bar part to a category chart with bars and the table', () => {
    const viz = toVizSpec(part({ unit: 'answers' }))
    expect(viz).toMatchObject({
      title: 'Answers by engine',
      x: 'category',
      value: 'number',
      unit: 'answers',
      labels: ['ChatGPT', 'Claude'],
      type: 'bar',
      representations: ['bar', 'table'],
      stacked: false,
    })
    expect(viz.datasets).toEqual([{ key: 's1', label: 'Answers', data: [12, 7] }])
    expect(representationsFor(viz)).toEqual(['bar', 'table'])
  })

  it('adds the heatmap to a bar part with two or more series', () => {
    const viz = toVizSpec(part({ datasets: [{ label: 'A', data: [1, 2] }, { label: '', data: [3, 4] }] }))
    expect(viz.datasets.map((d) => [d.key, d.label])).toEqual([
      ['s1', 'A'],
      ['s2', 'Series 2'],
    ])
    expect(representationsFor(viz)).toEqual(['bar', 'heatmap', 'table'])
  })

  it('offers line, area, bars and the table for a line part', () => {
    const viz = toVizSpec(part({ type: 'line' }))
    expect(viz.type).toBe('line')
    expect(representationsFor(viz)).toEqual(['line', 'area', 'bar', 'table'])
  })

  it('offers a donut, bars and the table for a doughnut part', () => {
    const viz = toVizSpec(part({ type: 'doughnut' }))
    expect(viz.stacked).toBe(true)
    expect(representationsFor(viz)).toEqual(['doughnut', 'bar', 'table'])
  })

  it('falls back to bars when a donut cannot draw the data', () => {
    const viz = toVizSpec(part({ type: 'doughnut', datasets: [{ label: 'x', data: [3, -1] }] }))
    expect(representationsFor(viz)).toEqual(['bar', 'table'])
  })

  it('reads a % unit as percent', () => {
    const viz = toVizSpec(part({ unit: '%' }))
    expect(viz.value).toBe('percent')
    expect(viz.unit).toBe('')
  })

  it('accepts the forward-compatible types', () => {
    expect(toVizSpec(part({ type: 'area' })).type).toBe('area')
    const stacked = toVizSpec(part({ type: 'stacked_bar', datasets: [{ label: 'A', data: [1, 2] }, { label: 'B', data: [3, 4] }] }))
    expect(stacked.stacked).toBe(true)
    expect(representationsFor(stacked)).toEqual(['bar', 'stacked_bar', 'heatmap', 'table'])
    expect(toVizSpec(part({ type: 'table' })).type).toBe('table')
    expect(toVizSpec(part({ type: 'heatmap' })).type).toBe('heatmap')
    expect(toVizSpec(part({ type: 'scatter' })).type).toBe('bar')
  })

  it('turns one series with long labels into horizontal bars', () => {
    const viz = toVizSpec(part({ labels: ['best note taking app for teams', 'crm'] }))
    expect(viz.type).toBe('hbar')
    expect(representationsFor(viz)).toEqual(['hbar', 'table'])
  })

  it('returns null for a part with nothing to plot', () => {
    expect(toVizSpec(null)).toBe(null)
    expect(toVizSpec(part({ labels: [] }))).toBe(null)
  })
})
