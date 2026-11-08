import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => ({ openNewTab: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 1 } }) }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: ComposerDock } = await import('@/components/agent/composer/ComposerDock.vue')
const { default: Composer } = await import('@/components/agent/composer/Composer.vue')
const { fallbackTemplates } = await import('@/lib/agent/reportTemplates')

enableAutoUnmount(afterEach)

function mountDock(props = {}) {
  setActivePinia(createPinia())
  return mount(ComposerDock, {
    props: { websiteId: 'w1', ...props },
    global: { stubs: { Composer: true, JumpToLatest: true, RouterLink: true } },
  })
}

beforeEach(() => {
  localStorage.clear()
  for (const key of Object.keys(fakeAgent)) delete fakeAgent[key]
  Object.assign(fakeAgent, {
    status: null,
    statusError: null,
    statusLoading: false,
    catalog: null,
    chatState: {},
    messages: {},
    reportTemplates: { items: fallbackTemplates(), source: 'catalog', loading: false, error: null },
    loadStatus: vi.fn(async () => null),
    loadReportTemplates: vi.fn(async () => []),
    send: vi.fn(async () => 'c1'),
  })
  Object.values(toast).forEach((fn) => fn.mockReset())
})

describe('ComposerDock: report templates', () => {
  it('loads the templates once mounted and hands them and the picked one to the composer', async () => {
    const wrapper = mountDock({ template: 'change_log' })
    await flushPromises()
    expect(fakeAgent.loadReportTemplates).toHaveBeenCalledTimes(1)
    const composer = wrapper.findComponent(Composer)
    expect(composer.props('template')).toBe('change_log')
    expect(composer.props('templates').map((t) => t.id)).toHaveLength(7)
  })

  it('sends the template with the message and clears it for the next reply', async () => {
    const wrapper = mountDock({ chatId: 'c1', template: 'executive_summary', agent: 'gap_analyst' })
    const composer = wrapper.findComponent(Composer)
    composer.vm.$emit('submit', 'Write the report')
    await flushPromises()
    expect(fakeAgent.send).toHaveBeenCalledWith({
      chatId: 'c1',
      text: 'Write the report',
      agent: 'gap_analyst',
      template: 'executive_summary',
    })
    expect(wrapper.emitted('update:template')).toEqual([[null]])
    expect(wrapper.emitted('sent')).toEqual([[{ chatId: 'c1', created: false }]])
  })

  it('sends no template when none is picked, and emits no template change', async () => {
    const wrapper = mountDock({ chatId: null })
    wrapper.findComponent(Composer).vm.$emit('submit', 'Hello')
    await flushPromises()
    expect(fakeAgent.send).toHaveBeenCalledWith({ chatId: null, text: 'Hello', agent: null, template: null })
    expect(wrapper.emitted('update:template')).toBeUndefined()
    expect(wrapper.emitted('sent')).toEqual([[{ chatId: 'c1', created: true }]])
  })

  it('puts the template back when the chat could not be created', async () => {
    fakeAgent.send = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'invalid', message: 'Unknown report template.' })
    })
    const wrapper = mountDock({ template: 'google_ai_gap' })
    wrapper.findComponent(Composer).vm.$emit('submit', 'Hello')
    await flushPromises()
    expect(wrapper.emitted('update:template')).toEqual([[null], ['google_ai_gap']])
    expect(toast.error).toHaveBeenCalledWith('Unknown report template.')
  })

  it('passes a template picked in the composer up to the chat', async () => {
    const wrapper = mountDock()
    wrapper.findComponent(Composer).vm.$emit('update:template', 'brand_accuracy')
    expect(wrapper.emitted('update:template')).toEqual([['brand_accuracy']])
  })

  it('works with a store that has no templates yet', async () => {
    delete fakeAgent.reportTemplates
    delete fakeAgent.loadReportTemplates
    const wrapper = mountDock()
    await flushPromises()
    expect(wrapper.findComponent(Composer).props('templates')).toEqual([])
  })

  it('does not send while the agent is busy', async () => {
    const wrapper = mountDock({ template: 'executive_summary', busy: true })
    wrapper.findComponent(Composer).vm.$emit('submit', 'Hello')
    await flushPromises()
    expect(fakeAgent.send).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:template')).toBeUndefined()
  })
})
