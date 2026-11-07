import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { TRACKED, crawlerAccess, youAudit } from '@/lib/analytics/__tests__/__fixtures__/sitePayloads'
import { apiError, run, runEstimate, runOptions } from '@/composables/analytics/__tests__/__fixtures__/insightRuns'

const api = vi.hoisted(() => ({
  crawlerAccess: vi.fn(),
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}))
vi.mock('@/api/insights', () => ({ default: api }))

const askAgent = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/agent/askAgent', async (importOriginal) => ({ ...(await importOriginal()), askAgent }))

const { default: CrawlerAccessPage } = await import('../CrawlerAccessPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []
const ok = (data) => ({ data })

const AUDIT_OPTIONS = runOptions('site_audit', {
  limits: { max_units: 20 },
  choices: { domain: 'notion.so', competitors: TRACKED, pages_planned: 3, cooldown_until: null },
})
const FREE = runEstimate('site_audit', {
  units: { pages: 3, competitors: 2 },
  ai: { calls_max: 0, usd_max: '0.0000' },
  confirm: { ai_calls: 0, ai_usd_max: '0.0000', google_pages: 0 },
  warnings: [],
})

async function mountPage(path = '/projects/w1/crawler-access') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://notion.so/' }])
  useAppStore().setActiveWebsite({ id: 'w1', name: 'Notion', url: 'https://notion.so/' })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/project', name: 'settings-project', component: Blank },
      {
        path: '/projects/:websiteId/crawler-access',
        name: 'crawler-access',
        component: CrawlerAccessPage,
        props: true,
        meta: { analytics: 'crawler-access' },
      },
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
const runButton = (wrapper) => wrapper.findAll('button').find((b) => b.text() === 'Run audit')

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset())
  askAgent.mockClear()
  api.crawlerAccess.mockResolvedValue(ok(crawlerAccess()))
  api.runOptions.mockResolvedValue(ok(AUDIT_OPTIONS))
  api.estimate.mockResolvedValue(ok(FREE))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('CrawlerAccessPage', () => {
  it('shows the audit: tiles, bots, checks, pages and the competitor benchmark', async () => {
    const { wrapper } = await mountPage()
    expect(api.crawlerAccess).toHaveBeenCalledWith('w1')
    expect(wrapper.find('h1').text()).toBe('Crawler access')
    expect(wrapper.text()).toContain('Whether AI crawlers may read your site and what they find without running JavaScript.')
    expect(wrapper.text()).toContain('Last audited')

    const tiles = wrapper.findAll('.viz-stat').map((t) => t.text())
    expect(tiles[0]).toContain('Checks passed')
    expect(tiles[0]).toContain('14 of 19')
    expect(tiles[1]).toContain('2 of 3')
    expect(tiles[2]).toContain('Found')

    expect(wrapper.text()).toContain('llms.txt: "Notion", 3 sections, 18 links. llms-full.txt: Missing.')
    expect(wrapper.find('.bat').text()).toContain('Disallow: / from group GPTBot')
    expect(wrapper.find('.pat').text()).toContain('/pricing')
    expect(wrapper.find('.pat').text()).toContain('Content needs JavaScript')
    expect(wrapper.find('.pat').text()).toContain('The page took too long to load.')

    expect(specs(wrapper).map((s) => s.id)).toEqual(['crawler.checks', 'crawler.benchmark'])
    const benchmark = wrapper.find('.ca-bench').text()
    expect(benchmark).toContain('Obsidian')
    expect(benchmark).toContain('Not audited')
    expect(runButton(wrapper).attributes('aria-disabled')).toBeUndefined()
  })

  it('offers Ask the agent on pages with failing checks', async () => {
    const { wrapper } = await mountPage()
    const asks = wrapper.find('.pat').findAll('button').filter((b) => b.text() === 'Ask the agent')
    // The home page, /pricing and /old each fail a check.
    expect(asks).toHaveLength(3)
    const pricingRow = wrapper.find('.pat').findAll('tbody tr').find((tr) => tr.text().includes('/pricing'))
    await pricingRow.find('button').trigger('click')
    await flushPromises()
    expect(askAgent).toHaveBeenCalledTimes(1)
    const [, args] = askAgent.mock.calls[0]
    expect(args).toMatchObject({ websiteId: 'w1', agent: 'page_optimizer', from: 'crawler-access' })
    expect(args.text).toBe(
      'Make https://notion.so/pricing readable for AI crawlers. Failed checks: Has a meta description, Text without JavaScript and Open to AI search bots.\n' +
        'Explain each fix and draft the changes.',
    )
  })

  it('says when robots.txt or llms.txt need a word', async () => {
    api.crawlerAccess.mockResolvedValue(
      ok(crawlerAccess({ you: youAudit({ robots: { state: 'unreachable' }, llms_txt: { state: 'invalid' } }) })),
    )
    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain(
      "robots.txt didn't respond. Crawlers that follow the standard treat your whole site as blocked until it does.",
    )
    expect(wrapper.text()).toContain('llms.txt has no title line (# Name), the one required part.')
  })

  it('invites the first audit and runs it from the dialog with its free confirm', async () => {
    api.crawlerAccess.mockResolvedValue(ok(crawlerAccess({ you: null, competitors: [] })))
    api.startRun.mockResolvedValue(ok(run({ kind: 'site_audit', kind_label: 'Crawler audit', status: 'queued' })))
    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain('No audit yet.')
    expect(wrapper.text()).toContain(
      'Cansee reads your robots.txt and llms.txt and fetches up to 20 pages without running JavaScript, the HTML a crawler receives first. Cansee fetches as CanseeAgent, so a site that answers AI crawlers differently can serve them other pages. Nothing is billed.',
    )
    const tileTexts = wrapper.findAll('.viz-stat')
    expect(tileTexts).toHaveLength(0)

    await wrapper.find('.viz-state button').trigger('click')
    await new Promise((r) => setTimeout(r, 350))
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog.textContent).toContain('Audit crawler access')
    expect(api.estimate).toHaveBeenLastCalledWith('w1', { kind: 'site_audit', params: { competitors: true } })
    ;[...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run audit').click()
    await flushPromises()
    expect(api.startRun).toHaveBeenCalledWith('w1', {
      kind: 'site_audit',
      params: { competitors: true },
      confirm: { ai_calls: 0, ai_usd_max: '0.0000', google_pages: 0 },
    })
    expect(wrapper.text()).toContain('Crawler audit running')
  })

  it("disables Run audit with the server's reason while the audit cannot run", async () => {
    const cooldown = 'An audit ran 3 minutes ago. Run it again after 10:15.'
    api.estimate.mockResolvedValue(
      ok({ ...FREE, can_run: false, blockers: [{ code: 'cooldown', status: 409, message: cooldown }] }),
    )
    const { wrapper } = await mountPage()
    const button = runButton(wrapper)
    expect(button.attributes('aria-disabled')).toBe('true')
    await button.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(api.estimate).toHaveBeenCalledWith('w1', { kind: 'site_audit', params: { competitors: true } })
    // The reason shows on focus.
    await button.trigger('focus')
    await flushPromises()
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(cooldown)
  })

  it('shows a running audit and blocks another one', async () => {
    api.runOptions.mockResolvedValue(ok({ ...AUDIT_OPTIONS, active_run: run({ kind: 'site_audit', kind_label: 'Crawler audit' }) }))
    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain('Crawler audit running')
    expect(runButton(wrapper).attributes('aria-disabled')).toBe('true')
  })

  it('asks to track competitors when there are none', async () => {
    api.runOptions.mockResolvedValue(ok({ ...AUDIT_OPTIONS, choices: { ...AUDIT_OPTIONS.choices, competitors: [] } }))
    api.crawlerAccess.mockResolvedValue(ok(crawlerAccess({ competitors: [] })))
    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain('Track competitors in Project settings to compare their sites.')
    const link = wrapper.findAll('a').find((a) => a.text() === 'Open project settings')
    expect(link.attributes('href')).toBe('/settings/project')
    expect(specs(wrapper).map((s) => s.id)).toEqual(['crawler.checks'])
  })

  it('says when the page could not load, and why when insights are off', async () => {
    api.crawlerAccess.mockRejectedValue(apiError(500, 'server_error', 'Something went wrong.'))
    let ctx = await mountPage()
    expect(ctx.wrapper.text()).toContain("We couldn't load crawler access.")
    expect(ctx.wrapper.text()).not.toContain('Something went wrong.')

    api.crawlerAccess.mockRejectedValue(apiError(503, 'insights_disabled', 'Insights are turned off on this server.'))
    ctx = await mountPage()
    expect(ctx.wrapper.text()).toContain('Insights are turned off on this server.')
    api.crawlerAccess.mockResolvedValue(ok(crawlerAccess()))
    await ctx.wrapper.findAll('button').find((b) => b.text() === 'Try again').trigger('click')
    await flushPromises()
    expect(ctx.wrapper.find('h1').text()).toBe('Crawler access')
    expect(ctx.wrapper.findAll('.viz-stat')).toHaveLength(4)
  })
})
