import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
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

  describe('as a dialog', () => {
    const DETAIL = {
      model: 'gpt4',
      prompt: 'best crm',
      response_text: 'Notion is a good pick.',
      brand: 'Notion',
      brands: [],
      sources: [],
      fanout_queries: [],
      alignment: null,
    }

    async function openFrom(opener) {
      client.get.mockResolvedValue({ data: DETAIL })
      opener.focus()
      const wrapper = mount(ChatDetailModal, { props: { websiteId: 'w1', resultId: 'r1', open: false }, attachTo: document.body })
      mounted.push(wrapper)
      await wrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()
      return wrapper
    }

    function addOpener() {
      const opener = document.createElement('button')
      opener.textContent = 'Row'
      document.body.appendChild(opener)
      return opener
    }

    it('is a labelled modal dialog with a named close button', async () => {
      await openFrom(addOpener())
      const el = document.body.querySelector('[role="dialog"]')
      expect(el.getAttribute('aria-modal')).toBe('true')
      expect(document.getElementById(el.getAttribute('aria-labelledby')).textContent).toMatch(/answer$/)
      expect(el.querySelector('button[aria-label="Close"]')).not.toBeNull()
    })

    it('takes focus when it opens and gives it back to the row on close', async () => {
      const opener = addOpener()
      const wrapper = await openFrom(opener)
      const el = document.body.querySelector('[role="dialog"]')
      expect(el.contains(document.activeElement)).toBe(true)
      await wrapper.setProps({ open: false })
      await flushPromises()
      expect(document.activeElement).toBe(opener)
    })

    it('closes itself on Escape and keeps the board panel underneath open', async () => {
      const wrapper = await openFrom(addOpener())
      let panelClosed = false
      const panel = (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]')) panelClosed = true
      }
      window.addEventListener('keydown', panel)
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      window.removeEventListener('keydown', panel)
      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(panelClosed).toBe(false)
    })
  })
})
