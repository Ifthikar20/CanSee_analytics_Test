import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))
const visibility = vi.hoisted(() => ({ dashboard: vi.fn() }))
vi.mock('@/api/visibility', () => ({ default: visibility }))
const countries = vi.hoisted(() => ({ matrix: vi.fn() }))
vi.mock('@/api/countries', () => ({ default: countries }))
const traffic = vi.hoisted(() => ({ traffic: vi.fn(), aiTraffic: vi.fn() }))
vi.mock('@/api/traffic', () => ({ default: traffic }))
const insights = vi.hoisted(() => ({
  sentiment: vi.fn(),
  factCheck: vi.fn(),
  fanOuts: vi.fn(),
  pages: vi.fn(),
  competitors: vi.fn(),
  crawlerAccess: vi.fn(),
  products: vi.fn(),
  promptIdeas: vi.fn(),
}))
vi.mock('@/api/insights', () => ({ default: insights }))

const { SOURCES, SOURCE_KEYS } = await import('../sources')
const { BOARD_CONTEXT, IN_PANEL, useBoard, useInPanel } = await import('../context')

const answer = (data) => vi.fn(async () => ({ success: true, data }))

beforeEach(() => {
  client.get = answer({ from: 'overview' })
  visibility.dashboard = answer({ from: 'visibility' })
  countries.matrix = answer({ from: 'countries' })
  traffic.traffic = answer({ from: 'traffic' })
  traffic.aiTraffic = answer({ from: 'ai-traffic' })
  for (const key of Object.keys(insights)) insights[key] = answer({ from: key })
})

describe('SOURCES', () => {
  it('has exactly the keys of contract 5, and the ranking of autopilot contract 6', () => {
    expect(SOURCE_KEYS).toEqual([
      'overview',
      'visibility',
      'countryMatrix',
      'traffic',
      'aiTraffic',
      'sentiment',
      'factCheck',
      'fanOuts',
      'pages',
      'competitors',
      'crawlerAccess',
      'products',
      'promptIdeas',
      'ranking',
    ])
  })

  it('reads Prompt ranking from Autopilot, quietly, and resolves with the payload', async () => {
    client.get = answer({ from: 'ranking' })
    await expect(SOURCES.ranking('w1')).resolves.toEqual({ from: 'ranking' })
    expect(client.get).toHaveBeenCalledWith('/autopilot/websites/w1/ranking/', { _silentError: true })
  })

  it('asks each endpoint for the fixed window the cards read, and resolves with the payload', async () => {
    await expect(SOURCES.overview('w1')).resolves.toEqual({ from: 'overview' })
    expect(client.get).toHaveBeenCalledWith('/search-gap/websites/w1/overview/', { _silentError: true })
    await expect(SOURCES.visibility('w1')).resolves.toEqual({ from: 'visibility' })
    expect(visibility.dashboard).toHaveBeenCalledWith('w1', { period: '30d' })
    await SOURCES.countryMatrix('w1')
    expect(countries.matrix).toHaveBeenCalledWith('w1')
    await SOURCES.traffic('w1')
    expect(traffic.traffic).toHaveBeenCalledWith('w1', { period: '30d', source: 'auto' })
    await SOURCES.aiTraffic('w1')
    expect(traffic.aiTraffic).toHaveBeenCalledWith('w1', { period: '30d', source: 'auto' })
    for (const key of ['sentiment', 'factCheck', 'fanOuts', 'pages', 'competitors']) {
      await expect(SOURCES[key]('w1')).resolves.toEqual({ from: key })
      expect(insights[key]).toHaveBeenCalledWith('w1', { period: '30d' })
    }
    await SOURCES.crawlerAccess('w1')
    expect(insights.crawlerAccess).toHaveBeenCalledWith('w1')
    await SOURCES.products('w1')
    expect(insights.products).toHaveBeenCalledWith('w1')
    await SOURCES.promptIdeas('w1')
    expect(insights.promptIdeas).toHaveBeenCalledWith('w1', { status: 'new' })
  })
})

describe('the board context', () => {
  function probe(provide = {}, router = null) {
    let board
    let inPanel
    mount(
      defineComponent({
        setup() {
          board = useBoard()
          inPanel = useInPanel()
          return () => h('div')
        },
      }),
      { global: { provide, plugins: router ? [router] : [] } },
    )
    return { board, inPanel }
  }

  it('hands out what the board provides, and says whether it renders in the panel', () => {
    const ctx = { websiteId: computed(() => 'w1'), open: vi.fn(), close: vi.fn(), invalidate: vi.fn(), revalidate: vi.fn() }
    const { board, inPanel } = probe({ [BOARD_CONTEXT]: ctx, [IN_PANEL]: true })
    expect(board).toBe(ctx)
    expect(inPanel).toBe(true)
    expect(probe().inPanel).toBe(false)
  })

  it("outside a board, follows the route's project and opens the board", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/projects/:websiteId/prompts', name: 'somewhere', component: { render: () => null } },
        { path: '/projects/:websiteId/analytics', name: 'analytics', component: { render: () => null } },
      ],
    })
    await router.push('/projects/w3/prompts')
    const { board } = probe({}, router)
    expect(board.websiteId.value).toBe('w3')
    board.open('countries', { prompt: 'p1' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w3/analytics?prompt=p1&widget=countries')
    expect(() => board.invalidate('overview')).not.toThrow()
    expect(() => board.revalidate()).not.toThrow()
  })

  it('fills in what a partial context leaves out, and survives without a router', () => {
    const open = vi.fn()
    const { board } = probe({ [BOARD_CONTEXT]: { websiteId: 'w1', open } })
    expect(board.open).toBe(open)
    expect(board.websiteId).toBe('w1')
    expect(() => board.close()).not.toThrow()
    expect(() => board.invalidate('overview')).not.toThrow()
  })
})
