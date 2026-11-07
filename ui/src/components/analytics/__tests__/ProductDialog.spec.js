import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { apiError, productsPayload } from '@/pages/analytics/__tests__/__fixtures__/measurementPayloads'

const insights = vi.hoisted(() => ({ createProduct: vi.fn(), updateProduct: vi.fn() }))

vi.mock('@/api/insights', () => ({ default: insights }))

const { default: ProductDialog } = await import('../ProductDialog.vue')

const mounted = []
const body = () => new DOMWrapper(document.body)
const button = (text) => body().findAll('button').find((b) => b.text() === text)
const input = (id) => body().find(`#${id}`)

function mountDialog(props = {}) {
  const wrapper = mount(ProductDialog, {
    props: {
      websiteId: 'w1',
      projectName: 'Acme',
      limits: productsPayload().limits,
      open: true,
      'onUpdate:open': (v) => wrapper.setProps({ open: v }),
      ...props,
    },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {
  insights.createProduct.mockReset()
  insights.updateProduct.mockReset()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('ProductDialog', () => {
  it('asks for the product, its match words, page, questions and store names', async () => {
    mountDialog()
    await flushPromises()
    expect(body().text()).toContain('Add product')
    expect(body().text()).toContain('Product name')
    expect(body().text()).toContain('A result counts as your product when it contains every match word.')
    expect(body().text()).toContain('Product page URL (optional)')
    expect(body().text()).toContain('Write them as a buyer would ask an AI assistant.')
    expect(body().text()).toContain('Listings sold under these names count as sold by you.')
    // Your store name defaults to the project's.
    expect(input('pd-sellers').element.value).toBe('Acme')
    expect(button('Add product').attributes('disabled')).toBeDefined()
  })

  it('creates a product; empty match words mean its name', async () => {
    insights.createProduct.mockResolvedValue({ data: { id: 'pr9' } })
    const wrapper = mountDialog()
    await flushPromises()
    await input('pd-name').setValue('Acme X300')
    await body().find('[aria-label="Shopping question 1"]').setValue('best trail shoes')
    await button('Add a question').trigger('click')
    await body().find('[aria-label="Shopping question 2"]').setValue('  waterproof running shoes  ')
    await button('Add product').trigger('click')
    await flushPromises()
    expect(insights.createProduct).toHaveBeenCalledWith('w1', {
      name: 'Acme X300',
      match_terms: ['Acme X300'],
      url: '',
      queries: ['best trail shoes', 'waterproof running shoes'],
      own_sellers: ['Acme'],
    })
    expect(wrapper.emitted('saved')[0][0]).toEqual({ id: 'pr9' })
    expect(wrapper.props('open')).toBe(false)
  })

  it('offers at most three questions', async () => {
    mountDialog()
    await flushPromises()
    await button('Add a question').trigger('click')
    await button('Add a question').trigger('click')
    expect(body().findAll('[aria-label^="Shopping question"]')).toHaveLength(3)
    expect(button('Add a question')).toBeUndefined()
  })

  it('edits a product with its saved values', async () => {
    insights.updateProduct.mockResolvedValue({ data: { id: 'pr1' } })
    const product = productsPayload().products[0]
    mountDialog({ product })
    await flushPromises()
    expect(body().text()).toContain('Edit product')
    expect(input('pd-terms').element.value).toBe('x200')
    await input('pd-terms').setValue('x200, acme')
    await button('Save').trigger('click')
    await flushPromises()
    expect(insights.updateProduct).toHaveBeenCalledWith('w1', 'pr1', {
      name: 'Acme X200 running shoe',
      match_terms: ['x200', 'acme'],
      url: 'https://acme.com/x200',
      queries: ['best running shoes for flat feet'],
      own_sellers: ['Acme'],
    })
  })

  it('shows a server error on its field', async () => {
    insights.createProduct.mockRejectedValue(
      apiError(400, 'invalid', 'Use an http or https URL.', { field: 'url', message: 'Use an http or https URL.' }),
    )
    mountDialog()
    await flushPromises()
    await input('pd-name').setValue('Acme X300')
    await input('pd-url').setValue('ftp://acme.com')
    await body().find('[aria-label="Shopping question 1"]').setValue('best trail shoes')
    await button('Add product').trigger('click')
    await flushPromises()
    expect(input('pd-url').attributes('aria-invalid')).toBe('true')
    expect(body().text()).toContain('Use an http or https URL.')
  })

  it('shows the product limit as a form error', async () => {
    insights.createProduct.mockRejectedValue(
      apiError(400, 'invalid', 'You can track up to 10 products.', { field: 'products', message: 'You can track up to 10 products.' }),
    )
    mountDialog()
    await flushPromises()
    await input('pd-name').setValue('Acme X300')
    await body().find('[aria-label="Shopping question 1"]').setValue('best trail shoes')
    await button('Add product').trigger('click')
    await flushPromises()
    expect(body().find('[role="alert"]').text()).toBe('You can track up to 10 products.')
  })
})
