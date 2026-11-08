import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
const fakePane = reactive({})
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => fakePane }))
const fakeUi = { announce: vi.fn(), focusComposer: vi.fn() }
vi.mock('@/stores/agentUi', () => ({ useAgentUiStore: () => fakeUi }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => reactive({ user: { id: 7 } }) }))
vi.mock('@/stores/app', () => ({ useAppStore: () => reactive({ activeWebsite: { id: 'w1', name: 'Notion' }, websites: [] }) }))
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))

// The chat column stub records the template each mount was given.
const chatMounts = []
vi.mock('@/components/agent/chat/ChatPane.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'ChatPane',
      props: ['websiteId', 'chatId', 'projectName', 'initialAgent', 'initialTemplate', 'paneDomId'],
      emits: ['created'],
      setup(props) {
        chatMounts.push({ chatId: props.chatId, initialAgent: props.initialAgent, initialTemplate: props.initialTemplate })
        return () => vue.h('div', { class: 'chat-stub', 'data-template': props.initialTemplate || '' })
      },
    }),
  }
})
vi.mock('@/components/agent/browser/BrowserPane.vue', async () => {
  const vue = await import('vue')
  return { default: vue.defineComponent({ name: 'BrowserPane', props: ['layout'], setup: () => () => vue.h('aside') }) }
})
vi.mock('@/components/agent/workspace/AgentWorkspaceSplit.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'AgentWorkspaceSplit',
      setup: (_, { slots }) => () => vue.h('div', [slots.chat?.({ layout: 'split' }), slots.pane?.({ layout: 'split' })]),
    }),
  }
})

const { default: AgentChatPage } = await import('../AgentChatPage.vue')

const mounted = []

async function setup(path) {
  setActivePinia(createPinia())
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: AgentChatPage, props: true },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: AgentChatPage, props: true },
    ],
  })
  await router.push(path)
  await router.isReady()
  const App = defineComponent({ render: () => h(RouterView) })
  const wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  chatMounts.length = 0
  for (const key of Object.keys(fakeAgent)) delete fakeAgent[key]
  Object.assign(fakeAgent, {
    websiteId: 'w1',
    status: { enabled: true, configured: true },
    chats: { byId: {} },
    chatState: {},
    init: vi.fn(),
    openChat: vi.fn(async () => {}),
    loadSuggestions: vi.fn(async () => {}),
    send: vi.fn(async () => 'c9'),
    setViewingChat: vi.fn(),
  })
  for (const key of Object.keys(fakePane)) delete fakePane[key]
  Object.assign(fakePane, { bindChat: vi.fn(), openArtifact: vi.fn(), openCapture: vi.fn() })
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AgentChatPage: ?template= from the Reports gallery', () => {
  it('hands the template to a new chat with the drafted-from notice, and sends nothing', async () => {
    const { router } = await setup('/projects/w1/agent?agent=gap_analyst&from=reports&template=competitor_comparison')
    expect(chatMounts.at(-1)).toEqual({ chatId: null, initialAgent: 'gap_analyst', initialTemplate: 'competitor_comparison' })
    expect(document.body.querySelector('.ag-drafted-line').textContent).toBe('Drafted from Reports. Review it, then send.')
    // ?from= is dropped; the template stays with the new chat until it is sent.
    expect(router.currentRoute.value.query).toEqual({ agent: 'gap_analyst', template: 'competitor_comparison' })
    expect(fakeAgent.send).not.toHaveBeenCalled()
  })

  it('ignores an unknown template key', async () => {
    await setup('/projects/w1/agent?template=weekly_digest')
    expect(chatMounts.at(-1).initialTemplate).toBeNull()
  })

  it('ignores a repeated key', async () => {
    await setup('/projects/w1/agent?template=change_log&template=brand_accuracy')
    expect(chatMounts.at(-1).initialTemplate).toBeNull()
  })

  it('ignores the template on an existing chat', async () => {
    await setup('/projects/w1/agent/c/c1?template=change_log')
    expect(chatMounts.at(-1).initialTemplate).toBeNull()
  })

  it('drops it once the first message moved the page to its chat', async () => {
    const { router, wrapper } = await setup('/projects/w1/agent?template=change_log')
    expect(wrapper.find('.chat-stub').attributes('data-template')).toBe('change_log')
    await router.replace({ name: 'agent-chat', params: { websiteId: 'w1', chatId: 'c9' } })
    await flushPromises()
    expect(wrapper.find('.chat-stub').attributes('data-template')).toBe('')
  })
})
