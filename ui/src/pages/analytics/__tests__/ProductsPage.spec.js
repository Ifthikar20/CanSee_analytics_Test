import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { VizChartStub, chartsById } from '@/pages/__tests__/__fixtures__/vizStub'
import { apiError, ok, productDetail, productsPayload } from './__fixtures__/measurementPayloads'

const insights = vi.hoisted(() => ({
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  products: vi.fn(),
  product: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  archiveProduct: vi.fn(),
}))
const ask = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))

vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/lib/agent/askAgent', () => ask)

const { default: ProductsPage } = await import('../ProductsPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

const OPTIONS = {
  kind: 'shopping_check',
  enabled: true,
  configured: { ai: true, google: true, google_provider: 'scraperapi', google_provider_label: 'ScraperAPI', shopping: true },
  limits: { max_units: 5 },
  choices: {},
  active_run: null,
  last_run: null,
}

async function mountPage(path = '/projects/w1/products') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Acme', url: 'https://www.acme.com' }])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: Blank },
      {
        path: '/projects/:websiteId/products',
        name: 'products',
        component: ProductsPage,
        props: true,
        meta: { analytics: 'products' },
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, {
    global: { plugins: [pinia, router], stubs: { VizChart: VizChartStub } },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const body = () => new DOMWrapper(document.body)
const rows = (wrapper) => wrapper.findAll('.an-table tbody tr')
const button = (scope, text) => scope.findAll('button').find((b) => b.text() === text)

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(insights)) fn.mockReset()
  ask.askAgent.mockClear()
  insights.runOptions.mockResolvedValue(ok(OPTIONS))
  insights.products.mockResolvedValue(ok(productsPayload()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('ProductsPage', () => {
  it('renders the note, the tiles, the chart and the products table', async () => {
    const { wrapper } = await mountPage()
    expect(insights.products).toHaveBeenCalledWith('w1')
    expect(wrapper.find('h1').text()).toBe('Products')
    expect(wrapper.text()).toContain(
      'Where your products show up in Google Shopping and whether the AI engines name them for shopping questions.',
    )
    expect(wrapper.text()).toContain("Engine answers come from the engines' APIs, not from the shopping cards in their apps.")
    expect(wrapper.findAll('.viz-stat').map((t) => t.text())).toEqual([
      'Products2',
      'Found in Google Shopping1 of 1',
      'Named by engines1 of 2',
      'Sold by you1 of 1',
    ])
    expect(chartsById(wrapper)['products.engines'].props('spec').title).toBe('Named by engine')

    const [shoe, sock] = rows(wrapper)
    expect(shoe.text()).toContain('Acme X200 running shoe')
    expect(shoe.text()).toContain('x200')
    expect(shoe.text()).toContain('#3')
    expect(shoe.text()).toContain('4 sellers')
    expect(shoe.text()).toContain('Sold by you')
    expect(shoe.text()).toContain('1 of 2 answers')
    expect(sock.text()).toContain('Not checked yet')
    expect(button(sock, 'Run shopping check')).toBeTruthy()
  })

  it('shows the no-products state with Add product', async () => {
    insights.products.mockResolvedValue(ok(productsPayload({ products: [] })))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe('No products tracked yet.')
    expect(wrapper.find('.viz-state-body').text()).toBe(
      'Add a product with the shopping questions buyers ask. Cansee checks Google Shopping and asks the AI engines; you see the cost first.',
    )
    expect(button(wrapper.find('.an-head'), 'Run shopping check').attributes('disabled')).toBeDefined()
    await button(wrapper.find('.viz-state'), 'Add product').trigger('click')
    await flushPromises()
    expect(body().text()).toContain('Product name')
  })

  it('warns when Google Shopping is not configured', async () => {
    insights.products.mockResolvedValue(
      ok(productsPayload({ shopping: { configured: false, provider_label: '', credits_per_page: null } })),
    )
    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain('Google Shopping results need ScraperAPI on this server. Engine answers still work.')
  })

  it('opens the shopping check with the products, the configured engines and Google Shopping', async () => {
    const { wrapper } = await mountPage()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    insights.estimate.mockResolvedValue(
      ok({ kind: 'shopping_check', google: { pages_max: 2, credits_max: 50 }, ai: { usd_max: '0.3200' }, confirm: {}, can_run: true }),
    )
    await button(wrapper.find('.an-head'), 'Run shopping check').trigger('click')
    await vi.advanceTimersByTimeAsync(300)
    expect(insights.estimate).toHaveBeenCalledWith('w1', {
      kind: 'shopping_check',
      params: { product_ids: ['pr1', 'pr2'], engines: ['chatgpt', 'claude'], google_shopping: true },
    })
    expect(body().text()).toContain('Run a shopping check')
    expect(body().text()).toContain('Acme trail sock')
  })

  it('checks one product from its row', async () => {
    const { wrapper } = await mountPage()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    insights.estimate.mockResolvedValue(ok({ kind: 'shopping_check', confirm: {}, can_run: true }))
    await button(rows(wrapper)[1], 'Run shopping check').trigger('click')
    await vi.advanceTimersByTimeAsync(300)
    expect(insights.estimate.mock.calls[0][1].params.product_ids).toEqual(['pr2'])
  })

  it('asks the agent about a product, with the page optimizer for a page on the site', async () => {
    const { wrapper } = await mountPage()
    await rows(wrapper)[0].find('.ask-btn').trigger('click')
    await flushPromises()
    const [, options] = ask.askAgent.mock.calls[0]
    expect(options).toMatchObject({ websiteId: 'w1', agent: 'page_optimizer', from: 'products' })
    expect(options.text).toBe(
      'Improve how shopping answers show Acme X200 running shoe.\n' +
        'Google Shopping: #3.\n' +
        'Engines named it in 1 of 2 answers.\n' +
        'Product page: https://acme.com/x200.\n' +
        'Suggest fixes to the page and its product data, and draft them.',
    )
    await rows(wrapper)[1].find('.ask-btn').trigger('click')
    await flushPromises()
    const [, sock] = ask.askAgent.mock.calls[1]
    expect(sock.agent).toBe('aeo_article')
    expect(sock.text).toBe(
      'Improve how shopping answers show Acme trail sock.\nSuggest fixes to the page and its product data, and draft them.',
    )
  })

  it('shows a product in the detail sheet', async () => {
    insights.product.mockResolvedValue(ok(productDetail()))
    const { wrapper } = await mountPage()
    await button(rows(wrapper)[0], 'Details').trigger('click')
    await flushPromises()
    expect(insights.product).toHaveBeenCalledWith('w1', 'pr1')
    const sheet = body().find('.pds')
    expect(sheet.text()).toContain('best running shoes for flat feet')
    expect(sheet.text()).toContain('Lowest listed: $39.00 from Walmart')
    expect(sheet.text()).toContain('Yours')
    expect(sheet.text()).toContain('The engine returned an error.')
    expect(sheet.text()).toContain('History')
    await button(sheet, 'Show answer').trigger('click')
    expect(sheet.find('.pds-answer').text()).toContain('1. Brooks Adrenaline')
  })

  it('says when the detail fails to load, with Try again', async () => {
    insights.product.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    await button(rows(wrapper)[0], 'Details').trigger('click')
    await flushPromises()
    expect(body().find('.pds').text()).toContain("We couldn't load this product.")
    insights.product.mockResolvedValue(ok(productDetail()))
    await button(body().find('.pds'), 'Try again').trigger('click')
    await flushPromises()
    expect(body().find('.pds').text()).toContain('Matches')
  })

  it('archives a product after the confirm', async () => {
    insights.archiveProduct.mockResolvedValue({ data: null })
    const { wrapper } = await mountPage()
    await button(rows(wrapper)[1], 'Archive').trigger('click')
    await flushPromises()
    expect(body().text()).toContain('Archive Acme trail sock? Its results are kept.')
    await button(body().find('.pr-confirm'), 'Archive').trigger('click')
    await flushPromises()
    expect(insights.archiveProduct).toHaveBeenCalledWith('w1', 'pr2')
    expect(insights.products).toHaveBeenCalledTimes(2)
  })

  it('shows a load error with Try again', async () => {
    insights.products.mockRejectedValue(apiError(500))
    const { wrapper } = await mountPage()
    expect(wrapper.find('.viz-state-title').text()).toBe("We couldn't load your products.")
  })
})
