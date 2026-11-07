import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { pagesPayload } from '@/lib/analytics/__tests__/__fixtures__/sitePayloads'
import { apiError, runEstimate, runOptions } from '@/composables/analytics/__tests__/__fixtures__/insightRuns'

const api = vi.hoisted(() => ({
  pages: vi.fn(),
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}))
vi.mock('@/api/insights', () => ({ default: api }))

const askAgent = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/agent/askAgent', async (importOriginal) => ({ ...(await importOriginal()), askAgent }))

const { default: SitePagesPage } = await import('../SitePagesPage.vue')

const mounted = []
const ok = (data) => ({ data })

async function mountPage(path = '/projects/w1/pages') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://notion.so/' }])
  useAppStore().setActiveWebsite({ id: 'w1', name: 'Notion', url: 'https://notion.so/' })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/pages', name: 'site-pages', component: SitePagesPage, props: true, meta: { analytics: 'pages' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router], stubs: { VizChart: true } }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const specs = (wrapper) => wrapper.findAllComponents({ name: 'VizChart' }).map((c) => c.props('spec'))
const select = (wrapper, label) => wrapper.findAll('label.an-select').find((l) => l.text().startsWith(label)).find('select')

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset())
  askAgent.mockClear()
  api.pages.mockResolvedValue(ok(pagesPayload()))
  api.runOptions.mockResolvedValue(ok(runOptions('site_audit', { choices: { domain: 'notion.so', competitors: [], pages_planned: 2 } })))
  api.estimate.mockResolvedValue(ok(runEstimate('site_audit', { units: { pages: 2, competitors: 0 }, warnings: [] })))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('SitePagesPage', () => {
  it('shows the sources, tiles, chart and pages in words', async () => {
    const { wrapper } = await mountPage()
    expect(api.pages).toHaveBeenCalledWith('w1', { period: '30d', filter: 'all' })
    expect(wrapper.find('h1').text()).toBe('Pages')
    expect(wrapper.text()).toContain(
      'Each page of your site with what Google, the AI engines, AI visitors and AI crawlers do with it.',
    )
    const chips = wrapper.findAll('.ss-chip').map((c) => c.text())
    expect(chips).toEqual(expect.arrayContaining(['Google rankings: On', 'AI visits: Cansee pixel', 'AI crawlers: Not connected']))

    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles).toHaveLength(5)
    expect(tiles[0]).toContain('Pages seen')
    expect(tiles[4]).toContain('Crawled by AI bots')
    expect(tiles[4]).toContain('Not connected')

    expect(specs(wrapper).map((s) => s.id)).toEqual(['pages.top'])
    const table = wrapper.find('.spt').text()
    expect(table).toContain('/pricing')
    expect(table).toContain('#3')
    expect(table).toContain('Retrieved, never cited')
    expect(table).toContain('Not ranking')
    expect(table).toContain('Not audited')
    expect(wrapper.text()).toContain(
      "Crawler requests are Cloudflare's sampled counts for the most crawled paths it reports each day (top 50 over the last 7 days).",
    )
  })

  it('keeps the filters in the query and sends them to the API', async () => {
    const { wrapper, router } = await mountPage('/projects/w1/pages?filter=cited&period=90d')
    expect(api.pages).toHaveBeenCalledWith('w1', { period: '90d', filter: 'cited' })
    await select(wrapper, 'Show').setValue('failing_checks')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ period: '90d', filter: 'failing_checks' })
    expect(api.pages).toHaveBeenLastCalledWith('w1', { period: '90d', filter: 'failing_checks' })
    // An unknown filter reads as All pages.
    await router.replace({ query: { filter: 'nope' } })
    await flushPromises()
    expect(api.pages).toHaveBeenLastCalledWith('w1', { period: '30d', filter: 'all' })
  })

  it('drafts a page optimization with what was measured on that page', async () => {
    const { wrapper } = await mountPage()
    const row = wrapper.find('.spt').findAll('tbody tr').find((tr) => tr.text().includes('/pricing'))
    await row.findAll('button').find((b) => b.text() === 'Ask the agent').trigger('click')
    await flushPromises()
    expect(askAgent).toHaveBeenCalledTimes(1)
    const [, args] = askAgent.mock.calls[0]
    expect(args).toMatchObject({ websiteId: 'w1', agent: 'page_optimizer', from: 'pages' })
    expect(args.text).toBe(
      'Optimize https://notion.so/pricing so AI engines read and cite it.\n' +
        'What Cansee measured:\n' +
        '- Google: #3 for "notion pricing"\n' +
        '- AI citations: 6 in 4 answers (ChatGPT)\n' +
        '- Retrieved by engines but never cited in the answer text\n' +
        '- AI visits: 12 in the last 30 days\n' +
        '- Audit: 7 of 9 checks pass; failing: Has a meta description and Text without JavaScript\n' +
        'Suggest concrete changes to this page and draft them.',
    )
  })

  it('invites an audit when no page is known, and offers all pages when a filter matches none', async () => {
    api.pages.mockResolvedValue(ok(pagesPayload({ pages: [], totals: { pages: 0, ranking: 0, cited: 0, retrieved_not_cited: 0, ai_visits: 0, crawled: null, audited: 0 } })))
    let ctx = await mountPage()
    expect(ctx.wrapper.text()).toContain('No pages seen yet.')
    await ctx.wrapper.findAll('.viz-state button').find((b) => b.text() === 'Run audit').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]').textContent).toContain('Audit crawler access')

    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
    ctx = await mountPage('/projects/w1/pages?filter=crawled')
    expect(ctx.wrapper.text()).toContain('No pages match this filter.')
    await ctx.wrapper.findAll('.viz-state button').find((b) => b.text() === 'Show all pages').trigger('click')
    await flushPromises()
    expect(ctx.router.currentRoute.value.query).toEqual({})
  })

  it('says when the pages could not load', async () => {
    api.pages.mockRejectedValue(apiError(500, 'server_error', 'Boom.'))
    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain("We couldn't load your pages.")
    api.pages.mockResolvedValue(ok(pagesPayload()))
    await wrapper.findAll('button').find((b) => b.text() === 'Try again').trigger('click')
    await flushPromises()
    expect(wrapper.find('.spt').exists()).toBe(true)
  })
})
