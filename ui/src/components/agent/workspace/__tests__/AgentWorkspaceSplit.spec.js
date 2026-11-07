import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('@/stores/agent', async () => {
  const m = await import('@/components/agent/browser/__tests__/__fixtures__/stores.js')
  return { useAgentStore: m.useAgentStore }
})
vi.mock('@/stores/auth', async () => {
  const m = await import('@/components/agent/browser/__tests__/__fixtures__/stores.js')
  return { useAuthStore: m.useAuthStore }
})

import AgentWorkspaceSplit from '../AgentWorkspaceSplit.vue'
import { useAgentPaneStore } from '@/stores/agentPane'

let width = 1201
const originalRect = HTMLElement.prototype.getBoundingClientRect

function mountSplit() {
  return mount(AgentWorkspaceSplit, {
    attachTo: document.body,
    slots: {
      chat: '<div class="chat-slot">chat</div>',
      pane: '<div class="pane-slot"><button type="button" class="inside">tab</button></div>',
    },
  })
}

describe('AgentWorkspaceSplit', () => {
  let pane

  beforeEach(() => {
    localStorage.clear()
    width = 1201
    HTMLElement.prototype.getBoundingClientRect = function rect() {
      return { left: 0, top: 0, right: width, bottom: 800, width, height: 800, x: 0, y: 0, toJSON() {} }
    }
    setActivePinia(createPinia())
    pane = useAgentPaneStore()
  })

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    document.body.innerHTML = ''
  })

  it('shows only the chat while the pane is closed', async () => {
    const wrapper = mountSplit()
    await nextTick()
    expect(wrapper.find('section[aria-label="Chat"]').exists()).toBe(true)
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    expect(wrapper.find('aside').isVisible()).toBe(false)
    wrapper.unmount()
  })

  it('splits with a separator that reports and changes the ratio by keyboard', async () => {
    pane.setOpen(true)
    const wrapper = mountSplit()
    await nextTick()
    const handle = wrapper.find('[role="separator"]')
    expect(handle.exists()).toBe(true)
    expect(handle.attributes('aria-valuenow')).toBe('50')
    expect(handle.attributes('aria-controls')).toBe('ag-ws-chat')
    expect(wrapper.find('.ag-ws').attributes('style')).toContain('minmax(0, 0.5fr) 1px minmax(0, 0.5fr)')

    await handle.trigger('focus')
    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(pane.ratio).toBeCloseTo(0.52)
    await handle.trigger('keydown', { key: 'Home' })
    expect(pane.ratio).toBeCloseTo(380 / 1200)
    await handle.trigger('keydown', { key: 'Escape' })
    expect(pane.ratio).toBeCloseTo(0.5)
    await handle.trigger('keydown', { key: 'End' })
    await handle.trigger('dblclick')
    expect(pane.ratio).toBe(0.5)
    wrapper.unmount()
  })

  it('resizes by dragging with pointer capture', async () => {
    pane.setOpen(true)
    const wrapper = mountSplit()
    await nextTick()
    const handle = wrapper.find('[role="separator"]')
    handle.element.setPointerCapture = vi.fn()
    handle.element.releasePointerCapture = vi.fn()
    // jsdom has no PointerEvent; a MouseEvent with a pointerId stands in.
    const pointer = async (type, clientX) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      handle.element.dispatchEvent(event)
      await nextTick()
    }
    await pointer('pointerdown', 600)
    expect(handle.element.setPointerCapture).toHaveBeenCalledWith(1)
    expect(wrapper.find('.ag-ws').classes()).toContain('is-dragging')
    await pointer('pointermove', 720.5)
    await pointer('pointerup', 720.5)
    expect(handle.element.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(pane.ratio).toBeCloseTo(0.6)
    expect(wrapper.find('.ag-ws').classes()).not.toContain('is-dragging')
    wrapper.unmount()
  })

  it('switches to an overlay below 801px of width and closes it with Escape', async () => {
    width = 760
    pane.setOpen(true)
    const wrapper = mountSplit()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.ag-ws').classes()).toContain('is-overlay')
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    expect(wrapper.find('.ag-ws-scrim').exists()).toBe(true)
    expect(wrapper.find('section[aria-label="Chat"]').attributes('inert')).toBeDefined()
    await wrapper.find('aside').trigger('keydown', { key: 'Escape' })
    expect(pane.open).toBe(false)
    wrapper.unmount()
  })

  it('keeps the chat usable in an overlay layout while the agent opens tabs', async () => {
    width = 767
    const wrapper = mountSplit()
    await nextTick()
    await nextTick()
    expect(pane.layout).toBe('overlay')
    const composer = document.createElement('textarea')
    wrapper.find('.chat-slot').element.append(composer)
    composer.focus()

    pane.openSerp(
      { id: 'serp:c1', kind: 'serp', title: 'Google · q · p1', status: 'loading', data: { capture_id: 'c1', query: 'q', page: 1 } },
      { activate: true }
    )
    await nextTick()
    await nextTick()
    expect(pane.open).toBe(false)
    expect(pane.attention).toBe(true)
    expect(wrapper.find('section[aria-label="Chat"]').attributes('inert')).toBeUndefined()
    expect(document.activeElement).toBe(composer)
    wrapper.unmount()
    expect(pane.layout).toBe(null)
  })

  it('reports a split layout, where the agent opens the pane beside the chat', async () => {
    const wrapper = mountSplit()
    await nextTick()
    expect(pane.layout).toBe('split')
    pane.openSerp({ id: 'serp:c1', kind: 'serp', status: 'loading', data: { capture_id: 'c1', query: 'q', page: 1 } }, { activate: true })
    await nextTick()
    expect(pane.open).toBe(true)
    expect(wrapper.find('[role="separator"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('gives the whole width to the pane when expanded', async () => {
    pane.setOpen(true)
    pane.setExpanded(true)
    const wrapper = mountSplit()
    await nextTick()
    expect(wrapper.find('.ag-ws').classes()).toContain('is-expanded')
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
