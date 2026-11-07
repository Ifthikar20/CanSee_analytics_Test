import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { VizChartStub, mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { cloudflareTraffic, countryMatrix, emptyMatrix, emptyTraffic, failureOf, trafficPayload } = await import(
  './__fixtures__/payloads'
)
const { default: CountriesCard } = await import('../CountriesCard.vue')

const mounted = []

async function render({ stubs = { VizChart: VizChartStub } } = {}) {
  const out = await mountOnBoard(CountriesCard, { props: { size: 'half' }, stubs })
  mounted.push(out.wrapper)
  return out
}

const chart = (wrapper) => wrapper.findComponent(VizChartStub)
const measures = (wrapper) => wrapper.findAll('[role="radio"]').map((r) => r.text())
const bars = (wrapper) =>
  wrapper.findAll('.bd-bars-row').map((r) => [r.find('.bd-bars-label').text(), r.find('.bd-bars-value').text()])
const foot = (wrapper) => wrapper.find('.bd-foot-text').text()

async function pick(wrapper, label) {
  await wrapper.findAll('[role="radio"]').find((r) => r.text() === label).trigger('click')
  await nextTick()
}

beforeEach(() => {
  resetSources()
  localStorage.clear()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('CountriesCard', () => {
  it('maps AI visibility first, with the top five and the source', async () => {
    setSource('countryMatrix', { data: countryMatrix() })
    setSource('traffic', { data: trafficPayload() })
    const { wrapper } = await render()
    expect(measures(wrapper)).toEqual(['AI', 'Google', 'Unique visitors'])
    expect(wrapper.find('[role="radiogroup"]').attributes('aria-label')).toBe('Measure')
    expect(chart(wrapper).props()).toMatchObject({ compact: true, hideSwitcher: true })
    expect(chart(wrapper).props('spec')).toMatchObject({ id: 'board.countries.ai', title: 'AI visibility by country' })
    expect(bars(wrapper)).toEqual([
      ['Germany', '80%'],
      ['Singapore', '60%'],
      ['United Kingdom', '35%'],
      ['Canada', '20%'],
      ['Australia', '0%'],
    ])
    expect(foot(wrapper)).toBe('From your latest country checks.')
  })

  it('reads Google as words, and traffic by its own measure', async () => {
    setSource('countryMatrix', { data: countryMatrix() })
    setSource('traffic', { data: trafficPayload() })
    const { wrapper } = await render()
    await pick(wrapper, 'Google')
    expect(chart(wrapper).props('spec').id).toBe('board.countries.google')
    expect(bars(wrapper)[0]).toEqual(['India', '#2'])
    // Ranks draw no bar: lower is better.
    expect(wrapper.find('.bd-bars-track').exists()).toBe(false)
    await pick(wrapper, 'Unique visitors')
    expect(chart(wrapper).props('spec')).toMatchObject({ id: 'board.countries.traffic', title: 'Visitors by country', scale: 'log' })
    expect(bars(wrapper)[0]).toEqual(['United States', '600'])
    expect(foot(wrapper)).toBe('Unique visitors from Cansee pixel, last 30 days.')
  })

  it('calls Cloudflare traffic requests, never visitors', async () => {
    setSource('countryMatrix', { data: emptyMatrix() })
    setSource('traffic', { data: cloudflareTraffic() })
    const { wrapper } = await render()
    // One measure: no switcher.
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
    expect(chart(wrapper).props('spec').title).toBe('Requests by country')
    expect(foot(wrapper)).toBe('Requests from Cloudflare, last 30 days. Bots included.')
    expect(wrapper.text()).not.toContain('Visitors')
  })

  it('shows the rankings while traffic still loads', async () => {
    setSource('countryMatrix', { data: countryMatrix() })
    const { wrapper } = await render()
    expect(measures(wrapper)).toEqual(['AI', 'Google'])
    expect(wrapper.find('.bd-skel').exists()).toBe(false)
  })

  it('waits for both sources before it says there is nothing', async () => {
    setSource('countryMatrix', { data: emptyMatrix() })
    const { wrapper } = await render()
    expect(wrapper.find('.bd-skel').exists()).toBe(true)
  })

  it('says there is no country data once both answered empty', async () => {
    setSource('countryMatrix', { data: emptyMatrix() })
    setSource('traffic', { data: emptyTraffic('no_source') })
    const { wrapper, board } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe('No country data yet.')
    expect(wrapper.find('.wa-state-body').text()).toBe(
      'Check how Google and the AI engines rank you in other countries, or connect a traffic source to see traffic by country.',
    )
    await wrapper.findAll('button').find((b) => b.text() === 'Check countries').trigger('click')
    expect(board.open).toHaveBeenCalledWith('countries', { check: '1' })
    const link = wrapper.findAll('a').find((a) => a.text() === 'Connect traffic')
    expect(link.attributes('href')).toBe('/settings/connections')
  })

  it('shows the load failure, never "No country data yet.", when one source failed and the other has nothing', async () => {
    setSource('countryMatrix', { failure: failureOf(500) })
    setSource('traffic', { data: emptyTraffic('no_source') })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe("We couldn't load Countries.")
    await wrapper.find('.wa-state button').trigger('click')
    expect(reloadOf('countryMatrix')).toHaveBeenCalled()
    expect(reloadOf('traffic')).not.toHaveBeenCalled()
  })

  it('retries a traffic source that could not reach its upstream', async () => {
    setSource('countryMatrix', { data: emptyMatrix() })
    setSource('traffic', { data: emptyTraffic('source_error', { source: 'cloudflare', source_label: 'Cloudflare' }) })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe("We couldn't load Countries.")
    await wrapper.find('.wa-state button').trigger('click')
    expect(reloadOf('traffic')).toHaveBeenCalledTimes(1)
    expect(reloadOf('countryMatrix')).not.toHaveBeenCalled()
  })

  it('opens Countries for rankings and Traffic for traffic', async () => {
    setSource('countryMatrix', { data: countryMatrix() })
    setSource('traffic', { data: trafficPayload() })
    const { wrapper, board } = await render()
    chart(wrapper).vm.$emit('select', { label: 'DE' })
    expect(board.open).toHaveBeenLastCalledWith('countries')
    await pick(wrapper, 'Unique visitors')
    await wrapper.findAll('.bd-bars-row')[0].trigger('click')
    expect(board.open).toHaveBeenLastCalledWith('traffic')
  })

  it('draws the real world map, by keyboard too', async () => {
    setSource('countryMatrix', { data: countryMatrix() })
    setSource('traffic', { data: trafficPayload() })
    const { wrapper, board } = await render({ stubs: {} })
    await vi.waitFor(() => expect(wrapper.find('svg.viz-geo-svg').exists()).toBe(true))
    const de = wrapper.find('[data-code="DE"]')
    expect(de.attributes('aria-label')).toBe('Germany: 80%')
    // Singapore has no polygon at this scale: a dot.
    expect(wrapper.find('circle[data-code="SG"]').exists()).toBe(true)
    await de.trigger('keydown', { key: 'Enter' })
    expect(board.open).toHaveBeenCalledWith('countries')
    // A card has no representation switcher, only the measure.
    expect(wrapper.findAll('[role="radiogroup"]').map((g) => g.attributes('aria-label'))).toEqual(['Measure'])
  })
})
