import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { aiTrafficPayload, apiError, ok, trafficSources } from './__fixtures__/analyticsPayloads'

vi.mock('@/api/traffic', () => ({ default: { sources: vi.fn(), aiTraffic: vi.fn() } }))

const { default: trafficApi } = await import('@/api/traffic')
const { default: AiTrafficPage } = await import('../AiTrafficPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function mountPage(path = '/projects/w1/ai-traffic', focus = '') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/connections', name: 'settings-connections', component: Blank },
      {
        path: '/projects/:websiteId/ai-traffic',
        name: 'ai-traffic',
        component: AiTrafficPage,
        props: (route) => ({ websiteId: route.params.websiteId, focus }),
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router], stubs: { VizChart: true } } })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const ids = (wrapper) => wrapper.findAllComponents({ name: 'VizChart' }).map((c) => c.props('spec').id)
const section = (wrapper, index) => wrapper.findAll('.an-section')[index]

beforeEach(() => {
  localStorage.clear()
  trafficApi.sources.mockReset()
  trafficApi.aiTraffic.mockReset()
  trafficApi.sources.mockResolvedValue(ok(trafficSources()))
  trafficApi.aiTraffic.mockResolvedValue(ok(aiTrafficPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
})

describe('AiTrafficPage', () => {
  it('shows AI visits and AI crawlers with their sources', async () => {
    const { wrapper } = await mountPage()
    expect(trafficApi.aiTraffic).toHaveBeenCalledWith('w1', { period: '30d', source: 'auto' })
    expect(wrapper.find('h1').text()).toBe('AI traffic')
    expect(wrapper.text()).toContain('Visits that came from AI assistants, and AI crawlers reading your site.')

    const visits = section(wrapper, 0)
    expect(visits.find('h2').text()).toBe('Visits from AI assistants')
    expect(visits.find('.an-section-sub').text()).toBe('Cansee pixel · Last 30 days')
    const visitTiles = visits.findAll('.viz-stat').map((t) => t.text())
    expect(visitTiles[0]).toContain('AI-referred sessions')
    expect(visitTiles[0]).toContain('4')
    expect(visitTiles[1]).toContain('7.8%')
    expect(visitTiles[2]).toContain('ChatGPT')

    const crawlers = section(wrapper, 1)
    expect(crawlers.find('h2').text()).toBe('AI crawlers')
    expect(crawlers.find('.an-section-sub').text()).toBe(
      'From Cloudflare · last 7 days · sampled · counted by user agent',
    )
    const crawlerTiles = crawlers.findAll('.viz-stat').map((t) => t.text())
    expect(crawlerTiles[0]).toContain('2,500')
    expect(crawlerTiles[2]).toContain('GPTBot')
    expect(crawlerTiles[2]).toContain('OpenAI')
    expect(crawlers.find('.cpt').text()).toContain('/blog/how-to')
    expect(crawlers.find('.cpt').text()).toContain('GPTBot, ClaudeBot')
    expect(crawlers.find('.an-foot').text()).toContain(
      "Verified-bot detection needs Cloudflare Bot Management, so a request that fakes a crawler's name is counted as that crawler.",
    )

    expect(ids(wrapper)).toEqual([
      'ai.series',
      'ai.assistants',
      'ai.countries',
      'ai.landing',
      'crawlers.bots',
      'crawlers.series',
      'crawlers.purposes',
    ])
  })

  it('puts the focused section first, in the DOM as on screen', async () => {
    const titles = (wrapper) => wrapper.findAll('.an-section h2').map((h) => h.text())
    const visits = await mountPage('/projects/w1/ai-traffic', 'visits')
    expect(titles(visits.wrapper)).toEqual(['Visits from AI assistants', 'AI crawlers'])
    const crawlers = await mountPage('/projects/w1/ai-traffic', 'crawlers')
    expect(titles(crawlers.wrapper)).toEqual(['AI crawlers', 'Visits from AI assistants'])
    expect(ids(crawlers.wrapper)).toEqual([
      'crawlers.bots',
      'crawlers.series',
      'crawlers.purposes',
      'ai.series',
      'ai.assistants',
      'ai.countries',
      'ai.landing',
    ])
  })

  it('offers the pixel and GA4 for AI visits and keeps the choice in the query', async () => {
    const { wrapper, router } = await mountPage()
    const source = wrapper.findAll('select')[0]
    expect(source.findAll('option').map((o) => [o.text(), o.element.disabled])).toEqual([
      ['Auto (Cansee pixel)', false],
      ['Cansee pixel', false],
      ['Google Analytics 4 (not connected)', true],
    ])
    await wrapper.findAll('select')[1].setValue('7d')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ period: '7d' })
    expect(trafficApi.aiTraffic).toHaveBeenLastCalledWith('w1', { period: '7d', source: 'auto' })
  })

  it.each([
    ['no_source', 'No traffic source can show AI visits yet.', 'Connect a source'],
    ['not_connected', 'No traffic source can show AI visits yet.', 'Connect a source'],
    ['no_data', 'No visits recorded in this period.', null],
  ])('says when AI visits are not available: %s', async (reason, title, action) => {
    trafficApi.aiTraffic.mockResolvedValue(
      ok(aiTrafficPayload({ referrals: { available: false, reason, total_sessions: null, ai_sessions: null } })),
    )
    const { wrapper } = await mountPage()
    const visits = section(wrapper, 0)
    expect(visits.find('.viz-state-title').text()).toBe(title)
    if (action) expect(visits.find('.viz-state a').text()).toBe(action)
    else expect(visits.find('.viz-state a').exists()).toBe(false)
    expect(visits.findAll('.viz-stat')).toHaveLength(0)
    // The crawler half is independent.
    expect(section(wrapper, 1).findAll('.viz-stat')).toHaveLength(3)
  })

  it('retries when the visits source could not be reached', async () => {
    trafficApi.aiTraffic.mockResolvedValue(
      ok(aiTrafficPayload({ referrals: { available: false, reason: 'source_error', source: 'ga4', source_label: 'Google Analytics 4' } })),
    )
    const { wrapper } = await mountPage()
    expect(section(wrapper, 0).find('.viz-state-title').text()).toBe("We couldn't reach Google Analytics 4 just now.")
    await section(wrapper, 0).find('.viz-state button').trigger('click')
    await flushPromises()
    expect(trafficApi.aiTraffic).toHaveBeenCalledTimes(2)
  })

  it('shows a measured zero and says no AI assistant sent a visit', async () => {
    trafficApi.aiTraffic.mockResolvedValue(
      ok(aiTrafficPayload({ referrals: { ai_sessions: 0, ai_share_pct: 0, assistants: [], landing_pages: [], countries: [] } })),
    )
    const { wrapper } = await mountPage()
    const visits = section(wrapper, 0)
    const tiles = visits.findAll('.viz-stat').map((t) => t.text())
    expect(tiles[0]).toContain('0')
    expect(tiles[2]).toContain('None yet')
    expect(visits.find('.viz-state-title').text()).toBe('No visits from AI assistants in this period.')
    expect(visits.find('.viz-state-body').text()).toBe(
      'A visit counts as AI-referred when it arrives from ChatGPT, Claude, Gemini, Perplexity, Copilot, Meta AI, Poe or You.com.',
    )
    expect(ids(wrapper).filter((id) => id.startsWith('ai.'))).toEqual([])
  })

  it.each([
    [
      'no_cloudflare',
      'Not available: connect Cloudflare.',
      "AI crawlers don't run JavaScript, so the Cansee pixel and Google Analytics never see them. Cloudflare sees every request to your site; connect it to count crawler visits.",
      'Connect Cloudflare',
    ],
    [
      'plan_unsupported',
      'Not available on this Cloudflare plan.',
      "Cloudflare refused the user-agent query for this zone, so crawler requests can't be counted.",
      null,
    ],
    ['disabled', "Cloudflare traffic isn't available on this server.", '', null],
  ])('says when AI crawlers are not available: %s', async (reason, title, body, action) => {
    trafficApi.aiTraffic.mockResolvedValue(ok(aiTrafficPayload({ crawlers: { available: false, reason, total_requests: null, bots: [] } })))
    const { wrapper } = await mountPage()
    const crawlers = section(wrapper, 1)
    expect(crawlers.find('.viz-state-title').text()).toBe(title)
    if (body) expect(crawlers.find('.viz-state-body').text()).toBe(body)
    if (action) expect(crawlers.find('.viz-state a').text()).toBe(action)
    else expect(crawlers.find('.viz-state a').exists()).toBe(false)
    expect(crawlers.findAll('.viz-stat')).toHaveLength(0)
    expect(crawlers.find('.an-foot').exists()).toBe(false)
  })

  it('retries Cloudflare and says when no crawler came', async () => {
    trafficApi.aiTraffic.mockResolvedValue(ok(aiTrafficPayload({ crawlers: { available: false, reason: 'source_error' } })))
    const { wrapper } = await mountPage()
    expect(section(wrapper, 1).find('.viz-state-title').text()).toBe("We couldn't reach Cloudflare just now.")
    trafficApi.aiTraffic.mockResolvedValue(
      ok(aiTrafficPayload({ crawlers: { total_requests: 0, bots: [], purposes: [], paths: [], series: { labels: [], by_bot: {} } } })),
    )
    await section(wrapper, 1).find('.viz-state button').trigger('click')
    await flushPromises()
    const crawlers = section(wrapper, 1)
    expect(crawlers.find('.viz-state-title').text()).toBe('No AI crawler requests in the last 7 days.')
    expect(crawlers.find('.viz-state-body').text()).toBe("Counted from Cloudflare's requests for this zone.")
    expect(crawlers.findAll('.viz-stat')[0].text()).toContain('0')
  })

  it('shows a load error with Try again', async () => {
    trafficApi.aiTraffic.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe("We couldn't load AI traffic.")
  })
})
