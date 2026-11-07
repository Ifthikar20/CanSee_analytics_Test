import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('@/stores/agent', async () => {
  const m = await import('@/components/agent/browser/__tests__/__fixtures__/stores.js')
  return { useAgentStore: m.useAgentStore }
})
vi.mock('@/stores/auth', async () => {
  const m = await import('@/components/agent/browser/__tests__/__fixtures__/stores.js')
  return { useAuthStore: m.useAuthStore }
})

import ChatHeader from '../ChatHeader.vue'
import { useAgentPaneStore } from '@/stores/agentPane'

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

function mountHeader() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Blank }] })
  return mount(ChatHeader, {
    props: { chatId: 'c1', websiteId: 'w1', title: 'Battery research' },
    global: { plugins: [router] },
  })
}

const SERP = { id: 'serp:c1', kind: 'serp', title: 'Google · q · p1', status: 'loading', data: { capture_id: 'c1', query: 'q', page: 1 } }

describe('ChatHeader browser button', () => {
  let pane

  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    pane = useAgentPaneStore()
  })

  it('says there are new tabs when the agent opened them while the pane had to stay closed', async () => {
    // A narrow workspace: the pane would cover the chat, so it stays closed.
    pane.setLayout('overlay')
    pane.openSerp(SERP, { activate: true })
    expect(pane.open).toBe(false)
    expect(pane.attention).toBe(true)

    const wrapper = mountHeader()
    await nextTick()
    const button = wrapper.find('button[aria-label="Show browser (new tabs)"]')
    expect(button.exists()).toBe(true)
    expect(wrapper.find('.ag-chat-head-dot').exists()).toBe(true)

    await button.trigger('click')
    expect(pane.open).toBe(true)
    expect(pane.attention).toBe(false)
  })

  it('shows the plain button, without the dot, for tabs the user has already seen', async () => {
    pane.setLayout('split')
    pane.openSerp(SERP, { activate: true })
    pane.setOpen(false)
    const wrapper = mountHeader()
    await nextTick()
    expect(wrapper.find('button[aria-label="Show browser"]').exists()).toBe(true)
    expect(wrapper.find('.ag-chat-head-dot').exists()).toBe(false)
  })
})
