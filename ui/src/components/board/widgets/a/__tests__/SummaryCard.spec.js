import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { failureOf, overviewPayload, visibilityPayload } = await import('./__fixtures__/payloads')
const { default: SummaryCard } = await import('../SummaryCard.vue')

const mounted = []

async function render(props = {}) {
  const out = await mountOnBoard(SummaryCard, { props: { size: 'full', ...props } })
  mounted.push(out.wrapper)
  return out
}

// Each tile as [label, value or state word].
const tiles = (wrapper) =>
  wrapper.findAll('.viz-stat').map((t) => [t.find('.viz-stat-label').text(), t.find('.viz-stat-value, .viz-stat-state').text()])

beforeEach(() => resetSources())

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('SummaryCard', () => {
  it('shows a skeleton until the overview answers', async () => {
    const { wrapper } = await render()
    expect(wrapper.find('.bd-skel').exists()).toBe(true)
    expect(wrapper.find('.viz-stat').exists()).toBe(false)
  })

  it('reads the headline and four numbers, AI visibility with its change', async () => {
    setSource('overview', { data: overviewPayload() })
    setSource('visibility', { data: visibilityPayload() })
    const { wrapper } = await render()
    expect(wrapper.find('.sm-headline').text()).toBe('AI ranks you higher than Google on 1 prompt. Google ranks you higher on 0.')
    expect(tiles(wrapper)).toEqual([
      ['AI visibility', '34%'],
      ['Avg. Google position', '#5.3'],
      ['AI ahead', '1'],
      // A measured zero reads 0.
      ['Google ahead', '0'],
    ])
    expect(wrapper.find('.viz-stat-delta').text()).toBe('+4.1 pts vs previous 30 days')
    // No identity dots on the board.
    expect(wrapper.find('.viz-stat-dot').exists()).toBe(false)
  })

  it('reads the gap counts as Not checked before any Google check, never 0', async () => {
    const overview = overviewPayload()
    setSource('overview', { data: { ...overview, kpis: { ...overview.kpis, google_checked: 0, ai_ahead: 0, google_ahead: 0 } } })
    const { wrapper } = await render()
    expect(wrapper.find('.sm-headline').text()).toBe('Tracking 3 prompts. Check Google to see the gap.')
    expect(tiles(wrapper).slice(2)).toEqual([
      ['AI ahead', 'Not checked'],
      ['Google ahead', 'Not checked'],
    ])
  })

  it('asks for prompts when none is tracked', async () => {
    setSource('overview', { data: overviewPayload({ prompts: [], kpis: { prompts: 0 } }) })
    const { wrapper, board } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe('No prompts tracked yet.')
    await wrapper.find('.wa-state button').trigger('click')
    expect(board.open).toHaveBeenCalledWith('prompts', { add: '1' })
  })

  it('shows the load failure with Try again', async () => {
    setSource('overview', { failure: failureOf(500) })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe("We couldn't load Summary.")
    await wrapper.find('.wa-state button').trigger('click')
    expect(reloadOf('overview')).toHaveBeenCalledTimes(1)
  })

  it("keeps the last numbers when a refresh failed and says so in the foot", async () => {
    setSource('overview', { data: overviewPayload(), failure: failureOf(502), stale: true })
    const { wrapper } = await render()
    expect(wrapper.findAll('.viz-stat')).toHaveLength(4)
    expect(wrapper.find('.bd-foot').text()).toBe("Couldn't refresh.")
  })
})
