import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAgentUiStore } from '@/stores/agentUi'

const fakeAgent = reactive({ runs: {}, messages: {} })
const mounted = []
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

const { default: AgentAnnouncer } = await import('../AgentAnnouncer.vue')

const Blank = defineComponent({ render: () => h('div') })

async function setup(path = '/projects/w1/agent/c/c1') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AgentAnnouncer, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, ui: useAgentUiStore() }
}

function run(id, phase, extra = {}) {
  fakeAgent.runs = { ...fakeAgent.runs, [id]: { id, chatId: 'c1', messageId: `m-${id}`, phase, error: null, ...extra } }
}

beforeEach(() => {
  vi.useFakeTimers()
  fakeAgent.runs = {}
  fakeAgent.messages = {}
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('AgentAnnouncer', () => {
  it('renders polite and assertive live regions with the store messages', async () => {
    const { wrapper, ui } = await setup()
    const polite = wrapper.find('[aria-live="polite"]')
    const assertive = wrapper.find('[aria-live="assertive"]')
    expect(polite.attributes('role')).toBe('status')
    expect(assertive.attributes('role')).toBe('alert')
    ui.announce('Chat renamed')
    await nextTick()
    expect(polite.text()).toBe('Chat renamed')
  })

  it('speaks run milestones for the open chat with the start of the reply', async () => {
    const { wrapper } = await setup()
    run('r1', 'running')
    await nextTick()
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('Agent is working')

    fakeAgent.messages = {
      'm-r1': {
        id: 'm-r1',
        status: 'complete',
        parts: [
          { id: 'p1', type: 'thinking', text: 'internal' },
          { id: 'p2', type: 'text', text: '## Summary\n\nYou rank **#14** on Google.' },
        ],
      },
    }
    vi.advanceTimersByTime(2000)
    run('r1', 'done')
    await nextTick()
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('Agent replied: Summary You rank #14 on Google.')
  })

  it('announces sub-agent runs once and failures assertively', async () => {
    const { wrapper } = await setup()
    fakeAgent.messages = {
      'm-r2': { id: 'm-r2', parts: [{ id: 'a1', type: 'agent_call', agent_name: 'Landing Page Agent', status: 'drafting' }] },
    }
    run('r2', 'running')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('Running Landing Page Agent')

    run('r2', 'failed', { error: { code: 'x', message: 'The model refused.' } })
    await nextTick()
    expect(wrapper.find('[aria-live="assertive"]').text()).toBe('The agent stopped with an error. The model refused.')
  })

  it('names a sub-agent once the backend has named it, and reads string errors', async () => {
    const { wrapper } = await setup()
    run('r3', 'running')
    await nextTick()
    // The part is added before the backend fills in the agent.
    fakeAgent.messages = { 'm-r3': { id: 'm-r3', parts: [{ id: 'a3', type: 'agent_call', agent_name: null, status: 'preparing' }] } }
    await nextTick()
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('Agent is working')

    fakeAgent.messages = {
      'm-r3': { id: 'm-r3', parts: [{ id: 'a3', type: 'agent_call', agent_name: 'Ad Campaign Agent', status: 'preparing' }] },
    }
    await nextTick()
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('Running Ad Campaign Agent')

    fakeAgent.messages = {
      'm-r3': {
        id: 'm-r3',
        parts: [{ id: 'a3', type: 'agent_call', agent_name: 'Ad Campaign Agent', status: 'error', error: 'The draft failed validation.' }],
      },
    }
    await nextTick()
    expect(wrapper.find('[aria-live="assertive"]').text()).toBe('Ad Campaign Agent failed: The draft failed validation.')
  })

  it('stays quiet for runs loaded already finished and for other chats', async () => {
    const { wrapper } = await setup()
    run('old', 'done')
    await nextTick()
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('')

    fakeAgent.runs = { ...fakeAgent.runs, other: { id: 'other', chatId: 'c2', messageId: 'mo', phase: 'running' } }
    await nextTick()
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('')
  })
})
