import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import {
  apiError,
  cloudflareTraffic,
  emptyTraffic,
  ok,
  trafficPayload,
  trafficSources,
} from './__fixtures__/analyticsPayloads'

vi.mock('@/api/traffic', () => ({ default: { sources: vi.fn(), traffic: vi.fn() } }))

const { default: trafficApi } = await import('@/api/traffic')
const { default: TrafficPage } = await import('../TrafficPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function mountPage(path = '/projects/w1/traffic') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/connections', name: 'settings-connections', component: Blank },
      { path: '/projects/:websiteId/traffic', name: 'traffic', component: TrafficPage, props: true },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router], stubs: { VizChart: true } } })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const charts = (wrapper) => wrapper.findAllComponents({ name: 'VizChart' })
const chart = (wrapper, id) => charts(wrapper).find((c) => c.props('spec').id === id)

beforeEach(() => {
  localStorage.clear()
  trafficApi.sources.mockReset()
  trafficApi.traffic.mockReset()
  trafficApi.sources.mockResolvedValue(ok(trafficSources()))
  trafficApi.traffic.mockResolvedValue(ok(trafficPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
})

describe('TrafficPage', () => {
  it('shows the source, the tiles, every chart and what each source measures', async () => {
    const { wrapper } = await mountPage()
    expect(trafficApi.traffic).toHaveBeenCalledWith('w1', { period: '30d', source: 'auto' })
    expect(wrapper.find('h1').text()).toBe('Traffic')
    expect(wrapper.text()).toContain('Real visits to your site, from the source you connect.')
    expect(wrapper.find('.an-banner-title').text()).toBe('Cansee pixel · Unique visitors')
    expect(wrapper.find('.an-banner-notes').text()).toBe(
      'The Cansee pixel started recording on 2026-10-07; earlier days are not measured.',
    )
    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles).toHaveLength(3)
    expect(tiles[0]).toContain('Unique visitors')
    expect(tiles[0]).toContain('41')
    expect(charts(wrapper).map((c) => c.props('spec').id)).toEqual([
      'traffic.series',
      'traffic.countries',
      'traffic.referrers',
      'traffic.pages',
      'traffic.devices',
    ])
    // One measure at a time, never a dual axis.
    expect(chart(wrapper, 'traffic.series').props('spec').pick_one).toBe(true)
    expect(chart(wrapper, 'traffic.countries').props('spec').footnote).toBe('3 without a known country.')

    const rows = wrapper.findAll('.scap-table tbody tr').map((r) => r.findAll('th, td').map((c) => c.text()))
    expect(rows).toEqual([
      ['Cansee pixel', 'Connected', 'Unique visitors', 'Yes', 'Yes', 'No'],
      ['Google Analytics 4', 'Not connected', 'Users', 'Yes', 'Yes', 'No'],
      ['Cansee Google tag', 'Not connected', 'Live only (last 30 minutes)', 'No', 'No', 'No'],
      ['Cloudflare', 'Connected', 'Requests (bots included)', 'Yes', 'No', 'Checking...'],
    ])
    expect(wrapper.find('.scap-foot a').text()).toBe('Manage connections')
    expect(wrapper.find('.scap-foot a').attributes('href')).toBe('/settings/connections')
  })

  it('lists connected sources and keeps the choice in the query', async () => {
    const { wrapper, router } = await mountPage()
    const source = wrapper.findAll('select')[0]
    expect(source.findAll('option').map((o) => [o.text(), o.element.disabled])).toEqual([
      ['Auto (Cansee pixel)', false],
      ['Cansee pixel', false],
      ['Google Analytics 4 (not connected)', true],
      ['Cloudflare', false],
    ])
    trafficApi.traffic.mockResolvedValue(ok(cloudflareTraffic()))
    await source.setValue('cloudflare')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ source: 'cloudflare' })
    expect(trafficApi.traffic).toHaveBeenLastCalledWith('w1', { period: '30d', source: 'cloudflare' })
    await wrapper.findAll('select')[1].setValue('90d')
    await flushPromises()
    expect(trafficApi.traffic).toHaveBeenLastCalledWith('w1', { period: '90d', source: 'cloudflare' })
  })

  it('shows Cloudflare notes and what it cannot measure', async () => {
    trafficApi.traffic.mockResolvedValue(ok(cloudflareTraffic()))
    const { wrapper } = await mountPage('/projects/w1/traffic?source=cloudflare')
    const notes = wrapper.findAll('.an-banner-notes li').map((li) => li.text())
    expect(notes).toEqual([
      'Cloudflare counts every request to your site, including bots and crawlers, so these numbers are not visitors.',
      'Cloudflare samples its breakdowns, so countries, pages and devices are estimates.',
      'Cloudflare does not report referrers on this plan.',
    ])
    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles[0]).toContain('Requests')
    expect(tiles[0]).toContain('+12.7% vs previous 30 days')
    expect(tiles[2]).toContain('Not measured by Cloudflare')
    expect(chart(wrapper, 'traffic.referrers').props('empty')).toEqual({
      title: 'Not measured by Cloudflare.',
      body: 'Cloudflare does not report referrers on this plan.',
    })
    expect(chart(wrapper, 'traffic.countries').props('spec').footnote).toBeUndefined()
    // Requests, never visitors.
    expect(chart(wrapper, 'traffic.countries').props('spec').title).toBe('Requests by country')
  })

  it("says when Cloudflare's breakdown could not be loaded, and retries", async () => {
    trafficApi.traffic.mockResolvedValue(ok(cloudflareTraffic({ pages: null, devices: null })))
    const { wrapper } = await mountPage('/projects/w1/traffic?source=cloudflare')
    const failed = { kind: 'error', title: "Cloudflare's breakdown couldn't be loaded just now.", action: { label: 'Try again' } }
    expect(chart(wrapper, 'traffic.pages').props('empty')).toEqual(failed)
    expect(chart(wrapper, 'traffic.devices').props('empty')).toEqual(failed)
    trafficApi.traffic.mockResolvedValue(ok(cloudflareTraffic()))
    chart(wrapper, 'traffic.pages').vm.$emit('retry')
    await flushPromises()
    expect(trafficApi.traffic).toHaveBeenCalledTimes(2)
    expect(chart(wrapper, 'traffic.pages').props('empty')).toBeNull()
    expect(chart(wrapper, 'traffic.devices').props('empty')).toBeNull()
  })

  it('says when the source could not be reached and a saved copy is shown', async () => {
    trafficApi.traffic.mockResolvedValue(ok(trafficPayload({ stale: true, notes: [] })))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.an-banner-notes').text()).toBe(
      'Showing the last saved copy; Cansee pixel could not be reached.',
    )
  })

  it.each([
    [
      'no_source',
      {},
      'No traffic source is connected.',
      'Connect the Cansee pixel, Google Analytics 4 or Cloudflare to see who visits your site and from where.',
      'Connect a source',
    ],
    [
      'not_connected',
      { source: 'ga4', source_label: 'Google Analytics 4' },
      "Google Analytics 4 isn't connected.",
      'Connect it in Settings, or choose another source above.',
      'Open Connections',
    ],
    [
      'no_data',
      {},
      "The Cansee pixel hasn't recorded a visit yet.",
      'Check that the snippet is on every page. Visits appear within a minute.',
      'Open Connections',
    ],
    ['no_data', { source: 'ga4', source_label: 'Google Analytics 4' }, 'Google Analytics 4 has no data for this period.', '', null],
  ])('shows the %s copy instead of the charts', async (reason, extra, title, body, action) => {
    trafficApi.traffic.mockResolvedValue(ok(emptyTraffic(reason, extra)))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe(title)
    if (body) expect(wrapper.find('.viz-state-body').text()).toBe(body)
    else expect(wrapper.find('.viz-state-body').exists()).toBe(false)
    if (action) expect(wrapper.find('.viz-state a').text()).toBe(action)
    else expect(wrapper.find('.viz-state a').exists()).toBe(false)
    expect(charts(wrapper)).toHaveLength(0)
    expect(wrapper.findAll('.viz-stat')).toHaveLength(0)
    // What each source measures stays.
    expect(wrapper.find('.scap-table').exists()).toBe(true)
  })

  it('retries a source error', async () => {
    trafficApi.traffic.mockResolvedValue(
      ok(emptyTraffic('source_error', { source: 'ga4', source_label: 'Google Analytics 4' })),
    )
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe("We couldn't reach Google Analytics 4 just now.")
    expect(wrapper.find('.viz-state-body').text()).toBe('Try again in a minute.')
    trafficApi.traffic.mockResolvedValue(ok(trafficPayload()))
    await wrapper.find('.viz-state button').trigger('click')
    await flushPromises()
    expect(trafficApi.traffic).toHaveBeenCalledTimes(2)
    expect(charts(wrapper)).toHaveLength(5)
  })

  it('shows a load error, and keeps the last numbers when a refresh fails', async () => {
    trafficApi.traffic.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe("We couldn't load traffic.")
    trafficApi.traffic.mockResolvedValue(ok(trafficPayload()))
    await wrapper.find('.viz-state button').trigger('click')
    await flushPromises()
    trafficApi.traffic.mockRejectedValue(apiError(502))
    await wrapper.findAll('select')[1].setValue('7d')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain(
      "We couldn't refresh this page. Showing the last loaded numbers.",
    )
    expect(charts(wrapper)).toHaveLength(5)
  })
})
