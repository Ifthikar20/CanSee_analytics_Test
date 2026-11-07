import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'

const client = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client }))

const { default: ChatDetailModal } = await import('../ChatDetailModal.vue')

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('ChatDetailModal', () => {
  it('renders on the body, outside any size container that would clip it', async () => {
    client.get.mockResolvedValue({
      data: {
        model: 'gpt4',
        prompt: 'best crm',
        response_text: 'Notion is a good pick.',
        brand: 'Notion',
        brands: [],
        sources: [],
        fanout_queries: [],
        alignment: null,
      },
    })
    const host = document.createElement('div')
    host.className = 'bd-panel-body'
    document.body.appendChild(host)
    const wrapper = mount(ChatDetailModal, {
      props: { websiteId: 'w1', resultId: 'r1', open: true },
      attachTo: host,
    })
    mounted.push(wrapper)
    await flushPromises()
    const overlay = new DOMWrapper(document.body).find('.fixed.inset-0')
    expect(overlay.exists()).toBe(true)
    expect(host.contains(overlay.element)).toBe(false)
    expect(overlay.element.parentElement).toBe(document.body)
  })

  it('renders nothing while closed', () => {
    const wrapper = mount(ChatDetailModal, { props: { websiteId: 'w1', open: false }, attachTo: document.body })
    mounted.push(wrapper)
    expect(document.body.querySelector('.fixed.inset-0')).toBeNull()
  })
})
