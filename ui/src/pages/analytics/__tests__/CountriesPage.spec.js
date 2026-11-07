import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BOARD_CONTEXT } from '@/lib/board/context'
import { useAppStore } from '@/stores/app'
import {
  apiError,
  countryEstimate,
  countryMatrix,
  countryOptions,
  countryRun,
  emptyMatrix,
  emptyTraffic,
  finishedRun,
  ok,
  trafficCountries,
} from './__fixtures__/analyticsPayloads'

vi.mock('@/api/countries', () => ({
  default: {
    options: vi.fn(),
    estimate: vi.fn(),
    startRun: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    cancelRun: vi.fn(),
    matrix: vi.fn(),
    result: vi.fn(),
  },
}))
vi.mock('@/api/traffic', () => ({ default: { countries: vi.fn() } }))

const { default: countriesApi } = await import('@/api/countries')
const { default: trafficApi } = await import('@/api/traffic')
const { default: CountriesPage } = await import('../CountriesPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const Shell = defineComponent({ render: () => h(TooltipProvider, null, () => h(RouterView)) })
const mounted = []
const board = {
  websiteId: computed(() => 'w1'),
  open: vi.fn(),
  close: vi.fn(),
  invalidate: vi.fn(),
  revalidate: vi.fn(),
}

async function mountPage(path = '/projects/w1/countries') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      { path: '/settings/connections', name: 'settings-connections', component: Blank },
      { path: '/projects/:websiteId/countries', name: 'countries', component: CountriesPage, props: true },
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(Shell, {
    global: { plugins: [pinia, router], provide: { [BOARD_CONTEXT]: board }, stubs: { VizChart: true } },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const charts = (wrapper) => wrapper.findAllComponents({ name: 'VizChart' })
const chart = (wrapper, id) => charts(wrapper).find((c) => c.props('spec').id === id)
const body = () => new DOMWrapper(document.body)
const stateTitle = (wrapper) => wrapper.find('.viz-state-title').text()

beforeEach(() => {
  localStorage.clear()
  board.open.mockClear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  for (const fn of Object.values(countriesApi)) fn.mockReset()
  trafficApi.countries.mockReset()
  countriesApi.options.mockResolvedValue(ok(countryOptions()))
  countriesApi.matrix.mockResolvedValue(ok(countryMatrix()))
  countriesApi.listRuns.mockResolvedValue(ok([]))
  trafficApi.countries.mockResolvedValue(ok(trafficCountries()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('CountriesPage', () => {
  it('renders the map, the table, the methods, visitors and recent checks', async () => {
    const { wrapper } = await mountPage()
    expect(countriesApi.matrix).toHaveBeenCalledWith('w1', {})
    expect(trafficApi.countries).toHaveBeenCalledWith('w1', { period: '30d', source: 'auto' })
    expect(wrapper.find('h1').text()).toBe('Countries')
    expect(wrapper.text()).toContain('Search vs AI by country')
    expect(charts(wrapper).map((c) => c.props('spec').id)).toEqual([
      'countries.map',
      'countries.prompts',
      'countries.visitors',
    ])
    expect(chart(wrapper, 'countries.visitors').props('spec').subtitle).toBe('Cansee pixel · last 30 days')
    expect(chart(wrapper, 'countries.visitors').props('spec').title).toBe('Visitors by country')
    expect(chart(wrapper, 'countries.visitors').props('empty')).toBeNull()
    // Prompts by country opens as the table; the heatmap is one click away.
    expect(chart(wrapper, 'countries.prompts').props('spec')).toMatchObject({ type: 'table', representations: ['heatmap'] })

    const rows = wrapper.findAll('.ct-row')
    expect(rows.map((r) => r.find('.ct-country-name').text())).toEqual(['Germany', 'United Kingdom'])
    const gb = rows[1].text()
    expect(gb).toContain('#4 avg')
    expect(gb).toContain('1 of 1 found')
    expect(gb).toContain('Google set to GB, US connection')
    expect(gb).toContain('100%')
    expect(gb).toContain('Asked to answer for GB')
    expect(gb).toContain('1 AI ahead')
    const de = rows[0].text()
    expect(de).toContain('Not in top 10')
    expect(de).toContain('Failed')
    expect(de).toContain('1 not definite')

    const methods = wrapper.findAll('.an-table tbody tr').map((r) => r.find('th').text())
    // Only the checked countries (GB and DE, both through Google's setting) are described.
    expect(methods).toEqual(['Google (ScraperAPI)', 'ChatGPT', 'Claude'])
    expect(wrapper.text()).toContain(
      'Plain chat engines answer from training data. Asking them to answer for a country steers the answer; it does not move them there.',
    )
    expect(wrapper.find('.rr-empty').text()).toBe('No checks yet.')
  })

  it('opens a country to list its prompts and a result in a dialog', async () => {
    countriesApi.result.mockResolvedValue(
      ok({ ...countryMatrix().cells[1], answer_text: 'Notion is a good pick.', brands: [], citations: [], prompt_text: 'best note taking app for teams', country_name: 'United Kingdom' }),
    )
    const { wrapper } = await mountPage()
    const toggle = wrapper.findAll('.ct-toggle')[1]
    expect(toggle.text()).toBe('Show prompts')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const inner = wrapper.find('.ct-inner').text()
    expect(inner).toContain('best note taking app for teams')
    expect(inner).toContain('#4')
    expect(inner).toContain('Named #2')
    await wrapper.findAll('.ct-details')[1].trigger('click')
    await flushPromises()
    expect(countriesApi.result).toHaveBeenCalledWith('w1', 'c2')
    const dialog = body().find('[role="dialog"]')
    expect(dialog.text()).toContain('ChatGPT in United Kingdom')
    expect(dialog.text()).toContain('Answer from ChatGPT · Asked to answer for GB')
    expect(dialog.text()).toContain('Notion is a good pick.')
  })

  it('opens a prompt picked by country in the Prompts panel', async () => {
    const { wrapper } = await mountPage()
    chart(wrapper, 'countries.prompts').vm.$emit('select', { label: 'p1' })
    await flushPromises()
    expect(board.open).toHaveBeenCalledWith('prompts', { prompt: 'p1' })
  })

  it('names Cloudflare requests as requests', async () => {
    trafficApi.countries.mockResolvedValue(
      ok(trafficCountries({ source: 'cloudflare', source_label: 'Cloudflare', metric: 'requests', metric_label: 'Requests' })),
    )
    const { wrapper } = await mountPage()
    const spec = chart(wrapper, 'countries.visitors').props('spec')
    expect(spec.title).toBe('Requests by country')
    expect(spec.datasets[0].label).toBe('Requests')
    expect(spec).toMatchObject({ scale: 'log', missing_label: 'None recorded' })
  })

  it('brings the row of a picked tile into view', async () => {
    const { wrapper } = await mountPage()
    chart(wrapper, 'countries.map').vm.$emit('select', { label: 'GB' })
    await flushPromises()
    expect(wrapper.findAll('.ct-row')[1].classes()).toContain('is-flash')
    expect(chart(wrapper, 'countries.map').props('selected')).toBe('GB')
  })

  it.each([
    ['turned off', { enabled: false }, 'Country checks are turned off on this server.'],
    ['no prompts', { prompts: [] }, 'Track a prompt first.'],
    [
      'nothing configured',
      {
        google: { configured: false },
        engines: countryOptions().engines.map((e) => ({ ...e, configured: false })),
      },
      "Country checks aren't available yet.",
    ],
  ])('says when checks cannot run: %s', async (_name, options, title) => {
    countriesApi.options.mockResolvedValue(ok(countryOptions(options)))
    countriesApi.matrix.mockResolvedValue(ok(emptyMatrix()))
    const { wrapper } = await mountPage()
    expect(stateTitle(wrapper)).toBe(title)
    expect(wrapper.find('.ct-table').exists()).toBe(false)
    // The header button stays focusable but blocked, with the reason.
    const button = wrapper.find('header button')
    expect(button.attributes('aria-disabled')).toBe('true')
  })

  it('sends a project without prompts to Add prompts', async () => {
    countriesApi.options.mockResolvedValue(ok(countryOptions({ prompts: [] })))
    countriesApi.matrix.mockResolvedValue(ok(emptyMatrix()))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-body').text()).toBe('Country checks run your tracked prompts. Add prompts in Prompts.')
    const link = wrapper.find('.viz-state a')
    expect(link.text()).toBe('Add prompts')
    expect(link.attributes('href')).toBe('/projects/w1/analytics?add=1&widget=prompts')
  })

  it('invites the first check when nothing was checked yet', async () => {
    countriesApi.matrix.mockResolvedValue(ok(emptyMatrix()))
    const { wrapper } = await mountPage()
    expect(stateTitle(wrapper)).toBe('No country checks yet.')
    expect(wrapper.find('.viz-state-body').text()).toBe(
      'Check how Google and the AI engines rank you in up to 5 countries at a time. You see the cost before anything runs.',
    )
    await wrapper.find('.viz-state button').trigger('click')
    await flushPromises()
    expect(body().find('[role="dialog"]').text()).toContain('Check rankings in other countries')
  })

  it('shows a matrix error with Try again', async () => {
    countriesApi.matrix.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(stateTitle(wrapper)).toBe("We couldn't load country results.")
    countriesApi.matrix.mockResolvedValue(ok(countryMatrix()))
    await wrapper.find('.viz-state button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.ct-row')).toHaveLength(2)
  })

  it('filters by prompt from the URL and opens the dialog once for ?check=1', async () => {
    const { wrapper, router } = await mountPage('/projects/w1/countries?prompt=p2&check=1')
    expect(countriesApi.matrix).toHaveBeenCalledWith('w1', { prompt_id: 'p2' })
    expect(router.currentRoute.value.query).toEqual({ prompt: 'p2' })
    const dialog = body().find('[role="dialog"]')
    expect(dialog.text()).toContain('Check rankings in other countries')
    const prompts = dialog.findAll('.crd-checks')[0].findAll('input')
    expect(prompts.map((i) => i.element.checked)).toEqual([false, true])
    expect(wrapper.find('select').element.value).toBe('p2')
  })

  it('sends the engine filter and offers Google in it', async () => {
    const { wrapper, router } = await mountPage()
    const engine = wrapper.findAll('select')[1]
    expect(engine.findAll('option').map((o) => o.text())).toEqual(['All engines', 'Google', 'ChatGPT', 'Claude'])
    await engine.setValue('google')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ engine: 'google' })
    expect(countriesApi.matrix).toHaveBeenLastCalledWith('w1', { engine: 'google' })
    expect(chart(wrapper, 'countries.map').props('spec').datasets.map((d) => d.key)).toEqual(['google'])
  })

  it('follows a running check, then reloads the results when it ends', async () => {
    const running = countryRun()
    countriesApi.options.mockResolvedValue(ok(countryOptions({ active_run: running })))
    countriesApi.getRun.mockResolvedValueOnce(ok(countryRun({ progress: { ...running.progress, done: 6 } })))
    countriesApi.getRun.mockResolvedValueOnce(ok(finishedRun()))
    const { wrapper } = await mountPage()

    const panel = () => wrapper.find('.crp')
    expect(panel().find('.crp-title').text()).toBe('Checking 2 countries')
    expect(panel().find('[role="progressbar"]').attributes('aria-valuenow')).toBe('4')
    expect(panel().text()).toContain('4 of 12 checks')
    expect(panel().findAll('.crp-chip').map((c) => c.text())).toEqual([
      'United Kingdom · Checking',
      'Germany · Waiting',
    ])
    // A run is going: the header button is blocked.
    expect(wrapper.find('header button').attributes('aria-disabled')).toBe('true')

    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(countriesApi.getRun).toHaveBeenCalledWith('w1', 'run-1')
    expect(panel().text()).toContain('7 of 12 checks')

    const before = countriesApi.matrix.mock.calls.length
    countriesApi.options.mockResolvedValue(ok(countryOptions()))
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(panel().find('.crp-title').text()).toBe('Checked 2 countries in 1 min 12 s')
    expect(panel().text()).toContain('12 done')
    expect(panel().text()).toContain('Used 4 Google pages (about 100 ScraperAPI credits) and $0.09 of AI allowance.')
    expect(countriesApi.matrix.mock.calls.length).toBeGreaterThan(before)
    expect(countriesApi.listRuns).toHaveBeenCalledTimes(2)

    // No more polling once it ended.
    await vi.advanceTimersByTimeAsync(9000)
    expect(countriesApi.getRun).toHaveBeenCalledTimes(2)

    await panel().find('button').trigger('click')
    expect(wrapper.find('.crp').exists()).toBe(false)
  })

  it('keeps the running check in Recent checks as fresh as the progress panel', async () => {
    const running = countryRun()
    countriesApi.options.mockResolvedValue(ok(countryOptions({ active_run: running })))
    countriesApi.listRuns.mockResolvedValue(ok([countryRun(), finishedRun({ id: 'run-0' })]))
    countriesApi.getRun.mockResolvedValue(ok(countryRun({ progress: { ...running.progress, done: 9 } })))
    const { wrapper } = await mountPage()
    const lines = () => wrapper.findAll('.rr-line').map((l) => l.text())
    // Both count every finished check (3 done, 1 failed).
    expect(wrapper.find('.crp').text()).toContain('4 of 12 checks')
    expect(lines()[0]).toContain('4 of 12 checks')

    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(wrapper.find('.crp').text()).toContain('10 of 12 checks')
    expect(lines()[0]).toContain('10 of 12 checks')
    // Other checks keep what the list said.
    expect(lines()[1]).toContain('12 of 12 checks')
    expect(countriesApi.listRuns).toHaveBeenCalledTimes(1)
  })

  it('pauses polling while the tab is hidden', async () => {
    countriesApi.options.mockResolvedValue(ok(countryOptions({ active_run: countryRun() })))
    countriesApi.getRun.mockResolvedValue(ok(countryRun()))
    await mountPage()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(9000)
    expect(countriesApi.getRun).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(countriesApi.getRun).toHaveBeenCalledTimes(1)
    delete document.hidden
  })

  it('stops a check only after confirming', async () => {
    countriesApi.options.mockResolvedValue(ok(countryOptions({ active_run: countryRun() })))
    countriesApi.getRun.mockResolvedValue(ok(countryRun()))
    countriesApi.cancelRun.mockResolvedValue(ok(countryRun({ cancel_requested: true })))
    const { wrapper } = await mountPage()
    await wrapper.find('.crp button').trigger('click')
    await flushPromises()
    const confirm = body().find('[role="alertdialog"]')
    expect(confirm.text()).toContain('Stop this check?')
    expect(confirm.text()).toContain('Checks that already finished are kept. The rest are not run and not billed.')
    const [keep, stop] = confirm.findAll('button')
    expect(keep.text()).toBe('Keep running')
    await stop.trigger('click')
    await flushPromises()
    expect(countriesApi.cancelRun).toHaveBeenCalledWith('w1', 'run-1')
    expect(wrapper.find('.crp').text()).toContain('Stopping...')
  })

  it('starts a check from the dialog and follows it', async () => {
    countriesApi.estimate.mockResolvedValue(ok(countryEstimate()))
    countriesApi.startRun.mockResolvedValue(ok(countryRun({ status: 'queued' })))
    const { wrapper } = await mountPage()
    await wrapper.find('header button').trigger('click')
    await flushPromises()
    const suggestion = body().findAll('.crd-suggest-btn').find((b) => b.text() === 'United Kingdom')
    await suggestion.trigger('click')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    await body().findAll('.crd-foot button').at(-1).trigger('click')
    await flushPromises()
    expect(countriesApi.startRun).toHaveBeenCalled()
    expect(wrapper.find('.crp-title').text()).toBe('Checking 2 countries')
    expect(countriesApi.listRuns).toHaveBeenCalledTimes(2)
  })

  it('says when no traffic source can show visitors by country', async () => {
    trafficApi.countries.mockResolvedValue(ok(emptyTraffic('no_source', { source: null, source_label: null })))
    const { wrapper } = await mountPage()
    expect(chart(wrapper, 'countries.visitors').props('empty')).toMatchObject({
      title: 'No traffic source is connected.',
      action: { label: 'Connect a source' },
    })
  })
})
