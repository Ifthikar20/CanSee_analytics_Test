import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { aiTrafficPayload, failureOf } = await import('./__fixtures__/payloads')
const { default: AiTrafficCard } = await import('../AiTrafficCard.vue')

const mounted = []

async function render() {
  const out = await mountOnBoard(AiTrafficCard, { props: { size: 'third' } })
  mounted.push(out.wrapper)
  return out
}

const tiles = (wrapper) =>
  wrapper.findAll('.viz-stat').map((t) => [t.find('.viz-stat-label').text(), t.find('.viz-stat-value, .viz-stat-state').text()])
const bars = (wrapper) =>
  wrapper.findAll('.bd-bars-row').map((r) => [r.find('.bd-bars-label').text(), r.find('.bd-bars-value').text()])

beforeEach(() => resetSources())

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AiTrafficCard', () => {
  it('shows AI sessions, their share and the top three assistants', async () => {
    setSource('aiTraffic', { data: aiTrafficPayload() })
    const { wrapper } = await render()
    expect(tiles(wrapper)).toEqual([
      ['AI-referred sessions', '42'],
      ['Share of all sessions', '2.8%'],
    ])
    expect(bars(wrapper)).toEqual([
      ['ChatGPT', '30'],
      ['Perplexity', '8'],
      ['Claude', '3'],
    ])
    expect(wrapper.find('.bd-foot-text').text()).toBe('Cansee pixel · last 30 days')
  })

  it('keeps a measured zero and says no assistant sent a visit', async () => {
    setSource('aiTraffic', { data: aiTrafficPayload({ referrals: { ai_sessions: 0, ai_share_pct: 0, assistants: [] } }) })
    const { wrapper } = await render()
    expect(tiles(wrapper)).toEqual([
      ['AI-referred sessions', '0'],
      ['Share of all sessions', '0%'],
    ])
    expect(wrapper.find('.wa-state-title').text()).toBe('No visits from AI assistants in this period.')
    expect(wrapper.find('.bd-bars').exists()).toBe(false)
  })

  it('says when no source can show AI visits', async () => {
    setSource('aiTraffic', {
      data: aiTrafficPayload({ referrals: { available: false, reason: 'no_source', total_sessions: null, ai_sessions: null } }),
    })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe('No traffic source can show AI visits yet.')
    expect(wrapper.find('.wa-state a').text()).toBe('Connect a source')
    expect(wrapper.find('.viz-stat').exists()).toBe(false)
    expect(wrapper.find('.bd-foot').exists()).toBe(false)
  })

  it('retries a source error and shows the load failure', async () => {
    setSource('aiTraffic', {
      data: aiTrafficPayload({ referrals: { available: false, reason: 'source_error', source_label: 'Google Analytics 4' } }),
    })
    const unreachable = await render()
    expect(unreachable.wrapper.find('.wa-state-title').text()).toBe("We couldn't reach Google Analytics 4 just now.")
    await unreachable.wrapper.find('.wa-state button').trigger('click')
    expect(reloadOf('aiTraffic')).toHaveBeenCalledTimes(1)

    setSource('aiTraffic', { failure: failureOf(500) })
    const failed = await render()
    expect(failed.wrapper.find('.wa-state-title').text()).toBe("We couldn't load AI traffic.")
  })
})
