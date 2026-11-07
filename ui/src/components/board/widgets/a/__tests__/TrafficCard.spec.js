import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { VizChartStub, mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { cloudflareTraffic, emptyTraffic, failureOf, trafficPayload } = await import('./__fixtures__/payloads')
const { default: TrafficCard } = await import('../TrafficCard.vue')

const mounted = []

async function render(size = 'half') {
  const out = await mountOnBoard(TrafficCard, { props: { size }, stubs: { VizChart: VizChartStub } })
  mounted.push(out.wrapper)
  return out
}

const paths = (wrapper) =>
  wrapper.findAll('.bd-bars-row').map((r) => [r.find('.bd-bars-label').text(), r.find('.bd-bars-value').text()])

beforeEach(() => resetSources())

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('TrafficCard', () => {
  it('shows the pixel: unique visitors with their change, per day, top paths and countries', async () => {
    setSource('traffic', { data: trafficPayload() })
    const { wrapper } = await render()
    const tile = wrapper.find('.viz-stat')
    expect(tile.find('.viz-stat-label').text()).toBe('Unique visitors')
    expect(tile.find('.viz-stat-value').text()).toBe('1,240')
    expect(tile.find('.viz-stat-delta').text()).toBe('+12.7% vs previous 30 days')
    expect(tile.find('.viz-stat-hint').text()).toBe('Cansee pixel · last 30 days')
    const chart = wrapper.findComponent(VizChartStub)
    expect(chart.props()).toMatchObject({ compact: true, hideSwitcher: true, height: 120 })
    expect(chart.props('spec')).toMatchObject({ id: 'board.traffic.series', title: 'Unique visitors per day' })
    expect(wrapper.find('.tc-head').text()).toBe('Top pathsPage views')
    expect(paths(wrapper)).toHaveLength(5)
    expect(paths(wrapper)[0]).toEqual(['/pricing', '410'])
    expect(wrapper.find('.tc-countries').text()).toBe('Top countries: United States 62%, Germany 9.3%, India 4.1%')
    // The pixel's paths are not sampled: no foot.
    expect(wrapper.find('.bd-foot').exists()).toBe(false)
  })

  it('draws a taller line at full width', async () => {
    setSource('traffic', { data: trafficPayload() })
    const { wrapper } = await render('full')
    expect(wrapper.findComponent(VizChartStub).props('height')).toBe(160)
  })

  it('names Cloudflare requests, bots included, and its sampled paths', async () => {
    setSource('traffic', { data: cloudflareTraffic({ breakdown_hours: 24 }) })
    const { wrapper } = await render()
    expect(wrapper.find('.viz-stat-label').text()).toBe('Requests')
    expect(wrapper.find('.viz-stat-hint').text()).toBe('Cloudflare · last 30 days · requests, bots included')
    expect(wrapper.find('.tc-head').text()).toBe('Top pathsRequests')
    expect(wrapper.find('.bd-foot-text').text()).toBe('Top paths are sampled. They cover the last 24 hours.')
    expect(wrapper.text()).not.toContain('Visitors')
  })

  it("says the top paths couldn't load when Cloudflare's breakdown failed, never none recorded", async () => {
    setSource('traffic', { data: cloudflareTraffic({ pages: null, devices: null }) })
    const { wrapper } = await render()
    expect(wrapper.find('.tc-note').text()).toBe("Couldn't load top paths just now.")
    expect(wrapper.text()).not.toContain('No pages recorded')
    // The daily totals still came.
    expect(wrapper.find('.viz-stat-value').text()).toBe('48.2K')
  })

  it('asks for a traffic source when none is connected', async () => {
    setSource('traffic', { data: emptyTraffic('no_source') })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe('Connect a traffic source to see real traffic.')
    expect(wrapper.find('.wa-state-body').text()).toBe(
      'Cloudflare counts every request to your site, bots included. Google Analytics 4 and the Cansee pixel count visitors.',
    )
    const link = wrapper.find('.wa-state a')
    expect(link.text()).toBe('Open Connections')
    expect(link.attributes('href')).toBe('/settings/connections')
    expect(wrapper.find('.viz-stat').exists()).toBe(false)
  })

  it("uses the Traffic page's words for the other reasons, and retries a source error", async () => {
    setSource('traffic', { data: emptyTraffic('source_error', { source: 'cloudflare', source_label: 'Cloudflare' }) })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe("We couldn't reach Cloudflare just now.")
    await wrapper.find('.wa-state button').trigger('click')
    expect(reloadOf('traffic')).toHaveBeenCalledTimes(1)
  })

  it('shows the load failure and the stale note', async () => {
    setSource('traffic', { failure: failureOf(500) })
    const failed = await render()
    expect(failed.wrapper.find('.wa-state-title').text()).toBe("We couldn't load Traffic.")

    setSource('traffic', { data: cloudflareTraffic(), failure: failureOf(502), stale: true })
    const stale = await render()
    expect(stale.wrapper.find('.bd-foot-text').text()).toBe("Top paths are sampled. Couldn't refresh.")
  })
})
