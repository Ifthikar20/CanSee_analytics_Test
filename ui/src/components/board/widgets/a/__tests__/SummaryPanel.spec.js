import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const searchGap = vi.hoisted(() => ({ checkGoogle: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))
vi.mock('@/api/searchGap', () => ({ default: searchGap }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { VizChartStub, mountOnBoard, resetSources, setSource } = await import('./__fixtures__/board')
const { failureOf, overviewPayload, visibilityPayload } = await import('./__fixtures__/payloads')
const { default: SummaryPanel } = await import('../SummaryPanel.vue')

const GapMapStub = defineComponent({
  name: 'GapMap',
  props: { prompts: { type: Array, required: true } },
  emits: ['open'],
  render: () => h('div', { class: 'gap-map-stub' }),
})

const mounted = []

async function render() {
  const out = await mountOnBoard(SummaryPanel, { stubs: { VizChart: VizChartStub, GapMap: GapMapStub } })
  mounted.push(out.wrapper)
  return out
}

beforeEach(() => {
  resetSources()
  searchGap.checkGoogle.mockReset()
  Object.values(toast).forEach((fn) => fn.mockClear())
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('SummaryPanel', () => {
  it('shows the headline and its line, all five numbers and the gap map', async () => {
    setSource('overview', { data: overviewPayload() })
    setSource('visibility', { data: visibilityPayload() })
    const { wrapper } = await render()
    expect(wrapper.find('.smp-headline').text()).toBe('AI ranks you higher than Google on 1 prompt. Google ranks you higher on 0.')
    expect(wrapper.find('.smp-subline').text()).toBe('1 strong in both, 0 invisible in both, out of 3 tracked prompts.')
    expect(wrapper.findAll('.viz-stat .viz-stat-label').map((l) => l.text())).toEqual([
      'AI visibility',
      'Avg. Google position',
      'AI ahead',
      'Google ahead',
      'Invisible in both',
    ])
    const chart = wrapper.findComponent(VizChartStub)
    expect(chart.props('spec').id).toBe('overview.gap_map')
    expect(wrapper.findComponent(GapMapStub).props('prompts')).toHaveLength(3)
  })

  it('opens a prompt from its dot', async () => {
    setSource('overview', { data: overviewPayload() })
    const { wrapper, board } = await render()
    wrapper.findComponent(GapMapStub).vm.$emit('open', overviewPayload().prompts[1])
    expect(board.open).toHaveBeenCalledWith('prompts', { prompt: 'p-2' })
  })

  it('checks Google for the prompts without a check, then refetches the overview', async () => {
    setSource('overview', { data: overviewPayload() })
    searchGap.checkGoogle.mockResolvedValue({})
    const { wrapper, board } = await render()
    const button = wrapper.findAll('button').find((b) => b.text() === 'Check Google for 1')
    await button.trigger('click')
    await flushPromises()
    expect(searchGap.checkGoogle).toHaveBeenCalledWith('w1', 'p-3')
    expect(toast.success).toHaveBeenCalledWith('Google checks queued for 1 prompt.')
    expect(board.invalidate).toHaveBeenCalledWith('overview')
  })

  it('offers no Google check while Google is not configured', async () => {
    setSource('overview', { data: overviewPayload({ serp_configured: false }) })
    const { wrapper } = await render()
    expect(wrapper.findAll('button').some((b) => b.text().startsWith('Check Google'))).toBe(false)
  })

  it('reads no gap line before a Google check', async () => {
    const overview = overviewPayload()
    setSource('overview', { data: { ...overview, kpis: { ...overview.kpis, google_checked: 0 } } })
    const { wrapper } = await render()
    expect(wrapper.find('.smp-subline').exists()).toBe(false)
    expect(wrapper.findAll('.viz-stat-state').map((s) => s.text())).toEqual(['Not checked', 'Not checked', 'Not checked'])
  })

  it('asks for prompts when none is tracked, and shows a failure with Try again', async () => {
    setSource('overview', { data: overviewPayload({ prompts: [] }) })
    const empty = await render()
    expect(empty.wrapper.find('.wa-state-title').text()).toBe('No prompts tracked yet.')
    await empty.wrapper.find('.wa-state button').trigger('click')
    expect(empty.board.open).toHaveBeenCalledWith('prompts', { add: '1' })

    resetSources()
    setSource('overview', { failure: failureOf(500) })
    const failed = await render()
    expect(failed.wrapper.find('.wa-state-title').text()).toBe("We couldn't load Summary.")
  })
})
