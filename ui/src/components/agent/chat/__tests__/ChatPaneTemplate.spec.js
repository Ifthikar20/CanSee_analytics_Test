import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
vi.mock('@/stores/agentUi', () => ({ useAgentUiStore: () => ({ announce: vi.fn(), focusComposer: vi.fn() }) }))
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))

// The pane only wires its children; the dock stub records the template it gets.
vi.mock('@/components/agent/composer/ComposerDock.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'ComposerDock',
      props: ['chatId', 'websiteId', 'agent', 'template', 'busy', 'stopping', 'canEditLast', 'showJump'],
      emits: ['update:agent', 'update:template', 'sent', 'edit-last', 'jump'],
      setup(props, { expose }) {
        expose({ focus: () => true, fill: () => {} })
        return () => vue.h('div', { class: 'dock-stub', 'data-template': props.template || '' })
      },
    }),
  }
})
vi.mock('../ChatHeader.vue', () => ({ default: { name: 'ChatHeader', render: () => null } }))
vi.mock('../ChatThread.vue', () => ({ default: { name: 'ChatThread', render: () => null } }))

const { default: ChatPane } = await import('../ChatPane.vue')

enableAutoUnmount(afterEach)

const dockTemplate = (wrapper) => wrapper.find('.dock-stub').attributes('data-template')

beforeEach(() => {
  for (const key of Object.keys(fakeAgent)) delete fakeAgent[key]
  Object.assign(fakeAgent, { chats: { byId: {} }, chatState: {}, messages: {}, childrenOf: {}, runs: {}, catalog: [], status: null, suggestions: [] })
})

describe('ChatPane: report template', () => {
  it('starts with the template the new chat was opened with', () => {
    const wrapper = mount(ChatPane, { props: { websiteId: 'w1', initialTemplate: 'executive_summary' } })
    expect(dockTemplate(wrapper)).toBe('executive_summary')
  })

  it('starts without one otherwise', () => {
    const wrapper = mount(ChatPane, { props: { websiteId: 'w1' } })
    expect(dockTemplate(wrapper)).toBe('')
  })

  it('follows the composer and a later hand-off', async () => {
    const wrapper = mount(ChatPane, { props: { websiteId: 'w1' } })
    wrapper.findComponent({ name: 'ComposerDock' }).vm.$emit('update:template', 'change_log')
    await flushPromises()
    expect(dockTemplate(wrapper)).toBe('change_log')
    wrapper.findComponent({ name: 'ComposerDock' }).vm.$emit('update:template', null)
    await flushPromises()
    expect(dockTemplate(wrapper)).toBe('')
    await wrapper.setProps({ initialTemplate: 'google_ai_gap' })
    expect(dockTemplate(wrapper)).toBe('google_ai_gap')
  })

  it('drops a picked template when another chat opens', async () => {
    const wrapper = mount(ChatPane, { props: { websiteId: 'w1', chatId: 'c1' } })
    wrapper.findComponent({ name: 'ComposerDock' }).vm.$emit('update:template', 'brand_accuracy')
    await flushPromises()
    await wrapper.setProps({ chatId: 'c2' })
    expect(dockTemplate(wrapper)).toBe('')
    wrapper.findComponent({ name: 'ComposerDock' }).vm.$emit('update:template', 'brand_accuracy')
    await flushPromises()
    await wrapper.setProps({ chatId: null })
    expect(dockTemplate(wrapper)).toBe('')
  })
})
