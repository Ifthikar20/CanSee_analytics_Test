import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const agentApi = vi.hoisted(() => ({ brandFacts: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: agentApi }))

const { default: ReferencePicker } = await import('../ReferencePicker.vue')

enableAutoUnmount(afterEach)

const ok = (data) => ({ success: true, data })
const dialog = () => document.body.querySelector('[role="dialog"]')
const dialogButton = (text) => [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === text)

async function input(el, value) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

beforeEach(() => {
  agentApi.brandFacts.mockReset()
})

describe('ReferencePicker', () => {
  function mountPicker(props = {}) {
    return mount(ReferencePicker, {
      props: {
        open: true,
        websiteId: 'w1',
        domain: 'notion.so',
        documents: [{ id: 'd1', title: 'Positioning notes' }],
        competitors: [{ name: 'Evernote', domain: 'evernote.com' }],
        ...props,
      },
      attachTo: document.body,
    })
  }

  it('takes pages of the project site only, with the words from them', async () => {
    const wrapper = mountPicker()
    await flushPromises()
    expect(dialog().textContent).toContain('Add a source')
    await input(dialog().querySelector('#ag-rp-url'), 'https://evernote.com/pricing')
    dialogButton('Add').click()
    await flushPromises()
    expect(dialog().querySelector('#ag-rp-err').textContent).toBe('Use pages of notion.so only.')
    expect(wrapper.emitted('add')).toBeUndefined()

    await input(dialog().querySelector('#ag-rp-url'), 'notion.so/pricing')
    await input(dialog().querySelector('#ag-rp-quote'), 'Plus $10 per seat')
    dialogButton('Add').click()
    await flushPromises()
    expect(wrapper.emitted('add')[0][0]).toEqual({
      input: { kind: 'page', url: 'https://notion.so/pricing', quote: 'Plus $10 per seat' },
      reference: { kind: 'page', label: '/pricing', url: 'https://notion.so/pricing', quote: 'Plus $10 per seat', state: 'unchecked' },
    })
  })

  it('searches current brand facts, approved ones first', async () => {
    agentApi.brandFacts.mockImplementation(async (wid, { status }) =>
      ok(
        status === 'approved'
          ? [{ id: 'f1', subject: 'Notion', predicate: 'was founded in', object: '2013' }]
          : [{ id: 'f2', subject: 'Notion', predicate: 'has', object: 'an AI add-on' }]
      )
    )
    const wrapper = mountPicker()
    await flushPromises()
    const factRadio = [...dialog().querySelectorAll('input[type="radio"]')].find((r) => r.value === 'fact')
    factRadio.click()
    await flushPromises()
    expect(agentApi.brandFacts).toHaveBeenCalledWith('w1', { status: 'approved', q: '' })
    expect(agentApi.brandFacts).toHaveBeenCalledWith('w1', { status: 'auto', q: '' })
    const combo = dialog().querySelector('#ag-rp-fact')
    expect(combo.getAttribute('role')).toBe('combobox')
    combo.dispatchEvent(new Event('focus'))
    await flushPromises()
    const options = [...dialog().querySelectorAll('[role="option"]')].map((o) => o.textContent.trim())
    expect(options).toEqual(['Notion was founded in 2013', 'Notion has an AI add-on'])

    vi.useFakeTimers()
    await input(combo, 'AI')
    vi.advanceTimersByTime(300)
    vi.useRealTimers()
    await flushPromises()
    expect(agentApi.brandFacts).toHaveBeenLastCalledWith('w1', { status: 'auto', q: 'AI' })

    combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    dialogButton('Add').click()
    await flushPromises()
    expect(wrapper.emitted('add')[0][0].input).toEqual({ kind: 'fact', fact_id: 'f2' })
  })

  it('adds a document or a tracked competitor', async () => {
    const wrapper = mountPicker()
    await flushPromises()
    ;[...dialog().querySelectorAll('input[type="radio"]')].find((r) => r.value === 'document').click()
    await flushPromises()
    dialogButton('Add').click()
    await flushPromises()
    expect(wrapper.emitted('add')[0][0].input).toEqual({ kind: 'document', document_id: 'd1' })
    ;[...dialog().querySelectorAll('input[type="radio"]')].find((r) => r.value === 'competitor').click()
    await flushPromises()
    dialogButton('Add').click()
    await flushPromises()
    expect(wrapper.emitted('add')[1][0].input).toEqual({ kind: 'competitor', competitor_domain: 'evernote.com' })
  })
})
