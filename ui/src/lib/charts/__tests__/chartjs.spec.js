import { describe, expect, it } from 'vitest'
import { buildChartConfig, pointReadout } from '@/lib/charts/chartjs'
import { normalizeVizSpec } from '@/lib/charts/spec'

const time = (extra = {}) =>
  normalizeVizSpec({
    title: 'Visibility',
    x: 'time',
    value: 'percent',
    labels: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'],
    datasets: [
      { key: 'chatgpt', label: 'ChatGPT', data: [10, null, 30, null, 50], entity: 'engine:chatgpt' },
      { key: 'claude', label: 'Claude', data: [20, 25, null, null, null], entity: 'engine:claude' },
    ],
    ...extra,
  })

describe('buildChartConfig: lines and areas', () => {
  it('draws 2px round lines with a ringed dot on the last value and on lone values', () => {
    const cfg = buildChartConfig(time(), 'line', { surface: '#ffffff' })
    expect(cfg.component).toBe('line')
    const [chatgpt, claude] = cfg.data.datasets
    expect(chatgpt).toMatchObject({ borderWidth: 2, borderCapStyle: 'round', spanGaps: false, cubicInterpolationMode: 'monotone' })
    expect(chatgpt.pointRadius).toEqual([4, 0, 4, 0, 4])
    expect(claude.pointRadius).toEqual([0, 4, 0, 0, 0])
    expect(chatgpt.pointBorderColor).toBe('#ffffff')
    expect(chatgpt.borderColor).toBe('#2a78d6')
    expect(claude.borderColor).toBe('#eb6834')
    // A missing value stays a gap, never a zero.
    expect(chatgpt.data).toEqual([10, null, 30, null, 50])
  })

  it('formats the axis and labels by the spec', () => {
    const cfg = buildChartConfig(time(), 'line')
    expect(cfg.data.labels).toEqual(['1 Oct', '2 Oct', '3 Oct', '4 Oct', '5 Oct'])
    expect(cfg.options.scales.y.max).toBe(100)
    expect(cfg.options.scales.y.beginAtZero).toBe(true)
    expect(cfg.options.scales.y.ticks.maxTicksLimit).toBe(5)
    expect(cfg.options.scales.y.ticks.callback(40)).toBe('40%')
    expect(cfg.options.scales.x.grid.display).toBe(false)
    expect(cfg.options.animation).toBe(false)
    expect(cfg.options.plugins.vizCrosshair.enabled).toBe(true)
    expect(cfg.options.plugins.vizEndLabels.enabled).toBe(true)
    // A narrow plot leaves the names to the legend instead of reserving room.
    const narrow = buildChartConfig(time(), 'line', { width: 240 })
    expect(narrow.options.plugins.vizEndLabels.enabled).toBe(false)
    expect(narrow.options.layout.padding.right).toBe(4)
  })

  it('washes a single area at 10% and stacks stacked areas', () => {
    const one = buildChartConfig(time(), 'area', { hidden: ['claude'] })
    expect(one.data.datasets[0]).toMatchObject({ fill: 'origin', backgroundColor: 'rgba(42, 120, 214, 0.1)' })
    expect(one.data.datasets[1].hidden).toBe(true)
    const stacked = buildChartConfig(time({ stacked: true }), 'area')
    expect(stacked.data.datasets.map((d) => d.fill)).toEqual(['stack', 'stack'])
    expect(stacked.options.scales.y.stacked).toBe(true)
  })

  it('reverses rank axes from #1', () => {
    const cfg = buildChartConfig(
      normalizeVizSpec({ title: 'G', x: 'time', value: 'rank', labels: ['2026-10-01'], datasets: [{ key: 'g', data: [4] }] }),
      'line',
    )
    expect(cfg.options.scales.y).toMatchObject({ reverse: true, min: 1, beginAtZero: false })
    expect(cfg.options.scales.y.ticks.callback(1)).toBe('#1')
  })
})

describe('buildChartConfig: bars and donuts', () => {
  const brands = normalizeVizSpec({
    title: 'Share of voice',
    value: 'percent',
    labels: ['Notion', 'Evernote', 'Other brands'],
    stacked: true,
    datasets: [{ key: 'sov', label: 'Share', data: [18.2, 27.3, 13.6] }],
  })

  it('caps bar thickness, rounds the data end and leaves a 2px surface gap where marks touch', () => {
    const cfg = buildChartConfig(brands, 'bar', { surface: '#0e0e10' })
    expect(cfg.data.datasets[0]).toMatchObject({
      maxBarThickness: 24,
      borderRadius: 4,
      borderSkipped: 'start',
      borderWidth: { top: 0, right: 1, bottom: 0, left: 1 },
      borderColor: '#0e0e10',
    })
    expect(cfg.options.plugins.vizBarTips.enabled).toBe(true)
    expect(cfg.options.plugins.vizBarTips.texts).toEqual(['18%', '27%', '14%'])
    expect(buildChartConfig(brands, 'hbar').data.datasets[0].borderWidth).toEqual({ top: 1, right: 0, bottom: 1, left: 0 })
    const stacked = buildChartConfig(time({ stacked: true }), 'stacked_bar')
    expect(stacked.data.datasets[0].borderWidth).toEqual({ top: 2, right: 0, bottom: 0, left: 0 })
  })

  it('fits horizontal bar labels to the plot width', () => {
    const long = normalizeVizSpec({
      title: 'Domains',
      labels: ['a-very-long-domain-name-for-testing.example.com'],
      datasets: [{ key: 'c', label: 'Citations', data: [3] }],
    })
    const narrow = buildChartConfig(long, 'hbar', { width: 240 })
    expect(narrow.options.scales.y.ticks.callback(0)).toBe('a-very-long-d…')
    const wide = buildChartConfig(long, 'hbar', { width: 900 })
    expect(wide.options.scales.y.ticks.callback(0)).toHaveLength(28)
  })

  it('names every vertical category bar, wrapping long names; dates may skip', () => {
    const types = normalizeVizSpec({
      title: 'URL types',
      value: 'percent',
      labels: ['Listicle', 'Other', 'Article', 'Comparison', 'Homepage', 'How-To Guide', 'Product Page', 'Category Page'],
      datasets: [{ key: 'share', label: 'Share', data: [36, 27, 21, 5, 4, 3, 2, 1] }],
    })
    const cfg = buildChartConfig(types, 'bar', { width: 606 })
    const ticks = cfg.options.scales.x.ticks
    expect(ticks.autoSkip).toBe(false)
    expect(ticks.callback(0)).toBe('Listicle')
    expect(ticks.callback(3)).toBe('Comparison')
    expect(ticks.callback(6)).toEqual(['Product', 'Page'])
    // Past two lines a name is clipped.
    const prompts = normalizeVizSpec({
      title: 'By prompt',
      labels: ['best software for teams to think and work together', 'x'],
      datasets: [
        { key: 'a', label: 'A', data: [1, 2] },
        { key: 'b', label: 'B', data: [2, 1] },
      ],
    })
    expect(buildChartConfig(prompts, 'bar', { width: 400 }).options.scales.x.ticks.callback(0)).toEqual([
      'best software for teams',
      'to think and work toget…',
    ])
    // Too thin a slot for a word, and dates, skip labels as before.
    expect(buildChartConfig(types, 'bar', { width: 200 }).options.scales.x.ticks.autoSkip).toBe(true)
    expect(buildChartConfig(time(), 'bar', { width: 606 }).options.scales.x.ticks.autoSkip).toBe(true)
  })

  it('keeps the selected bar in the series colour and mutes the others', () => {
    const cfg = buildChartConfig(brands, 'hbar', { selected: 'notion' })
    expect(cfg.data.datasets[0].backgroundColor).toEqual(['#2a78d6', '#a5a5a0', '#a5a5a0'])
    expect(cfg.options.indexAxis).toBe('y')
    expect(cfg.height).toBe(3 * 28 + 48)
  })

  it('shows the top 15 countries as horizontal bars, largest first', () => {
    const codes = Array.from({ length: 20 }, (_, i) => String.fromCharCode(65 + i) + 'A')
    const spec = normalizeVizSpec({
      title: 'Visitors',
      x: 'country',
      value: 'count',
      labels: codes,
      datasets: [{ key: 'v', label: 'Visitors', data: codes.map((_, i) => i) }],
    })
    const cfg = buildChartConfig(spec, 'hbar')
    expect(cfg.order).toHaveLength(15)
    expect(cfg.order[0]).toBe(19)
    expect(cfg.data.datasets[0].data[0]).toBe(19)
  })

  it('stacks both axes for stacked bars', () => {
    const cfg = buildChartConfig(time({ stacked: true, value: 'count' }), 'stacked_bar')
    expect(cfg.options.scales.x.stacked).toBe(true)
    expect(cfg.options.scales.y.stacked).toBe(true)
    expect(cfg.options.scales.y.ticks.precision).toBe(0)
  })

  it('draws donut slices with label colours and a surface gap', () => {
    const cfg = buildChartConfig(brands, 'doughnut', { surface: '#ffffff' })
    expect(cfg.component).toBe('doughnut')
    expect(cfg.options.cutout).toBe('62%')
    expect(cfg.data.datasets[0].backgroundColor).toEqual(['#2a78d6', '#eb6834', '#1baf7a'])
    expect(cfg.data.datasets[0]).toMatchObject({ borderWidth: 2, borderColor: '#ffffff' })
    expect(cfg.options.interaction.mode).toBe('nearest')
  })

  it('draws the picked dataset of a pick_one spec in slot 1', () => {
    const spec = normalizeVizSpec({
      title: 'By engine',
      pick_one: true,
      labels: ['ChatGPT', 'Claude'],
      datasets: [
        { key: 'vis', label: 'AI visibility', data: [40, 20], value: 'percent' },
        { key: 'answers', label: 'Answers', data: [50, 30], value: 'count' },
      ],
    })
    const cfg = buildChartConfig(spec, 'bar', { picked: 'answers' })
    expect(cfg.data.datasets).toHaveLength(1)
    expect(cfg.data.datasets[0].label).toBe('Answers')
    expect(cfg.data.datasets[0].backgroundColor).toBe('#2a78d6')
    expect(cfg.kind).toBe('count')
  })
})

describe('pointReadout', () => {
  it('lists every visible series at a position, with state words', () => {
    const spec = time({
      datasets: [
        { key: 'chatgpt', label: 'ChatGPT', data: [10, null, 30, null, 50] },
        { key: 'claude', label: 'Claude', data: [20, null, null, null, null], states: [null, 'not_measured'] },
      ],
    })
    const cfg = buildChartConfig(spec, 'line')
    const readout = pointReadout(spec, cfg, 1)
    expect(readout.title).toBe('2 Oct')
    expect(readout.rows.map((r) => [r.label, r.text, r.shape])).toEqual([
      ['ChatGPT', 'No data', 'line'],
      ['Claude', 'Not measured', 'line'],
    ])
    expect(pointReadout(spec, cfg, 0, { hidden: ['claude'] }).rows).toHaveLength(1)
    expect(pointReadout(spec, cfg, 99)).toBe(null)
  })
})
