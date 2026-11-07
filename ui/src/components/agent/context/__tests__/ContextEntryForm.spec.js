import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { entry, pageRef } from '@/pages/agent/__tests__/__fixtures__/context'

const agentApi = vi.hoisted(() => ({ brandFacts: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: agentApi }))

const { default: ContextEntryForm } = await import('../ContextEntryForm.vue')

enableAutoUnmount(afterEach)

beforeEach(() => {
  agentApi.brandFacts.mockReset()
})

describe('ContextEntryForm', () => {
  function mountForm(props = {}) {
    const save = vi.fn(async () => ({}))
    const wrapper = mount(ContextEntryForm, {
      props: { entry: null, section: 'offerings', websiteId: 'w1', domain: 'notion.so', save, ...props },
      attachTo: document.body,
    })
    return { wrapper, save }
  }

  it('saves the changed fields with the sources added and removed', async () => {
    const original = entry({ id: 'e1', section: 'company', references: [pageRef(), pageRef({ id: 'r2', label: '/pricing' })] })
    const { wrapper, save } = mountForm({ entry: original })
    expect(wrapper.find('select').element.value).toBe('company')
    expect(wrapper.find('input[type="text"]').element.value).toBe('Founded in 2013')
    expect(wrapper.text()).toContain('44 of 4,000')
    await wrapper.find('textarea').setValue('Founded in 2013 in San Francisco by Ivan Zhao.')
    expect(wrapper.text()).toContain('46 of 4,000')
    await wrapper.findAll('.ag-ref-remove')[1].trigger('click')
    expect(wrapper.emitted('dirty').at(-1)).toEqual([true])
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', revision: 2 }),
      { section: 'company', title: 'Founded in 2013', body: 'Founded in 2013 in San Francisco by Ivan Zhao.' },
      { add: [], remove: [expect.objectContaining({ id: 'r2' })] }
    )
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  it('saves with mod+S and shows a save error inline', async () => {
    const { wrapper, save } = mountForm()
    save.mockRejectedValueOnce(Object.assign(new Error('This section has 40 entries, the limit.'), { code: 'too_many', status: 400 }))
    await wrapper.find('input[type="text"]').setValue('Plus plan')
    await wrapper.find('form').trigger('keydown', { key: 's', ctrlKey: true })
    await flushPromises()
    expect(save).toHaveBeenCalledWith(null, { section: 'offerings', title: 'Plus plan', body: '' }, { add: [], remove: [] })
    expect(wrapper.find('.ag-cef-error').text()).toBe('This section has 40 entries, the limit.')
    expect(wrapper.emitted('done')).toBeUndefined()
  })

  it('stops at a conflict and offers the reload', async () => {
    const { wrapper, save } = mountForm({ entry: entry(), conflict: true })
    expect(wrapper.find('.ag-cef-banner').text()).toContain('Someone else changed this entry. Reload to see their version.')
    expect(wrapper.findAll('button').find((b) => b.text() === 'Save').attributes('disabled')).toBeDefined()
    await wrapper.findAll('button').find((b) => b.text() === 'Reload').trigger('click')
    expect(wrapper.emitted('reload')).toHaveLength(1)
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps an entry to ten sources', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => pageRef({ id: `r${i}`, label: `/p${i}` }))
    const { wrapper } = mountForm({ entry: entry({ references: refs }) })
    const off = wrapper.find('.ag-cef-add-off')
    expect(off.attributes('aria-disabled')).toBe('true')
    expect(off.text()).toBe('Add source')
  })
})
