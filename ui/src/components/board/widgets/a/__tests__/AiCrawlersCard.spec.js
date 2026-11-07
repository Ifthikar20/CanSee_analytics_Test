import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { aiTrafficPayload, failureOf } = await import('./__fixtures__/payloads')
const { default: AiCrawlersCard } = await import('../AiCrawlersCard.vue')

const mounted = []

async function render() {
  const out = await mountOnBoard(AiCrawlersCard, { props: { size: 'third' } })
  mounted.push(out.wrapper)
  return out
}

const bars = (wrapper) =>
  wrapper.findAll('.bd-bars-row').map((r) => [r.find('.bd-bars-label').text(), r.find('.bd-bars-value').text()])

beforeEach(() => resetSources())

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AiCrawlersCard', () => {
  it("counts crawler requests in Cloudflare's 7 days and names the top three with their operator", async () => {
    setSource('aiTraffic', { data: aiTrafficPayload() })
    const { wrapper } = await render()
    const tile = wrapper.find('.viz-stat')
    expect(tile.find('.viz-stat-label').text()).toBe('Crawler requests')
    expect(tile.find('.viz-stat-value').text()).toBe('5,400')
    expect(tile.find('.viz-stat-hint').text()).toBe('last 7 days')
    expect(bars(wrapper)).toEqual([
      ['GPTBot · OpenAI', '2,100'],
      ['ClaudeBot · Anthropic', '1,800'],
      ['PerplexityBot · Perplexity', '900'],
    ])
    expect(wrapper.find('.bd-foot-text').text()).toBe('From Cloudflare · last 7 days · sampled · counted by user agent')
  })

  it.each([
    ['plan_unsupported', 'Not available on this Cloudflare plan.', null],
    ['no_cloudflare', 'Not available: connect Cloudflare.', 'Connect Cloudflare'],
  ])('says when crawlers cannot be counted: %s', async (reason, title, link) => {
    setSource('aiTraffic', { data: aiTrafficPayload({ crawlers: { available: false, reason, total_requests: null, bots: [] } }) })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe(title)
    if (link) expect(wrapper.find('.wa-state a').text()).toBe(link)
    else expect(wrapper.find('.wa-state a').exists()).toBe(false)
    expect(wrapper.find('.viz-stat').exists()).toBe(false)
    expect(wrapper.find('.bd-foot').exists()).toBe(false)
  })

  it('keeps a measured zero', async () => {
    setSource('aiTraffic', { data: aiTrafficPayload({ crawlers: { total_requests: 0, bots: [] } }) })
    const { wrapper } = await render()
    expect(wrapper.find('.viz-stat-value').text()).toBe('0')
    expect(wrapper.find('.wa-state-title').text()).toBe('No AI crawler requests in the last 7 days.')
  })

  it('retries Cloudflare and shows the load failure', async () => {
    setSource('aiTraffic', { data: aiTrafficPayload({ crawlers: { available: false, reason: 'source_error' } }) })
    const unreachable = await render()
    expect(unreachable.wrapper.find('.wa-state-title').text()).toBe("We couldn't reach Cloudflare just now.")
    await unreachable.wrapper.find('.wa-state button').trigger('click')
    expect(reloadOf('aiTraffic')).toHaveBeenCalledTimes(1)

    setSource('aiTraffic', { failure: failureOf(500) })
    const failed = await render()
    expect(failed.wrapper.find('.wa-state-title').text()).toBe("We couldn't load AI crawlers.")
  })
})
