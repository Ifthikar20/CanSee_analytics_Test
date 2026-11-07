import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useFirstResearch } from '@/composables/agent/useFirstResearch'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

const fakePane = reactive({})
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => fakePane }))

const fakeUi = { announce: vi.fn(), focusComposer: vi.fn() }
vi.mock('@/stores/agentUi', () => ({ useAgentUiStore: () => fakeUi }))

const fakeAuth = reactive({ user: { id: 7 } })
vi.mock('@/stores/auth', () => ({ useAuthStore: () => fakeAuth }))

const fakeApp = reactive({ activeWebsite: { id: 'w1', name: 'Notion' }, websites: [{ id: 'w1', name: 'Notion' }] })
vi.mock('@/stores/app', () => ({ useAppStore: () => fakeApp }))

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

// The chat column, the pane and the split belong to other builders; the
// page only wires them. The chat stub records each mount and its props.
const chatMounts = []
vi.mock('@/components/agent/chat/ChatPane.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'ChatPane',
      props: ['websiteId', 'chatId', 'projectName', 'initialAgent', 'paneDomId'],
      emits: ['created'],
      setup(props) {
        chatMounts.push({ chatId: props.chatId, initialAgent: props.initialAgent })
        return () => vue.h('div', { class: 'chat-stub', 'data-agent': props.initialAgent || '' })
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
      setup: (_, { slots }) => () =>
        vue.h('div', { class: 'split-stub' }, [slots.chat?.({ layout: 'split' }), slots.pane?.({ layout: 'split' })]),
    }),
  }
})

const { default: AgentChatPage } = await import('../AgentChatPage.vue')

const mounted = []

const TEXT = [
  'Research Notion (notion.so) on Google and the AI engines for these prompts:',
  '1. best note taking app for teams',
  '2. notion alternatives for startups',
  'Search from United States (us).',
  'Competitors to compare: Evernote (evernote.com).',
].join('\n')

function resetStores(overrides = {}) {
  for (const key of Object.keys(fakeAgent)) delete fakeAgent[key]
  Object.assign(fakeAgent, {
    websiteId: 'w1',
    chats: { byId: {} },
    chatState: {},
    init: vi.fn((wid) => {
      fakeAgent.websiteId = wid
    }),
    openChat: vi.fn(async () => {}),
    loadSuggestions: vi.fn(async () => {}),
    send: vi.fn(async () => 'c9'),
    setViewingChat: vi.fn(),
    ...overrides,
  })
  for (const key of Object.keys(fakePane)) delete fakePane[key]
  Object.assign(fakePane, {
    bindChat: vi.fn(),
    openArtifact: vi.fn(),
    openCapture: vi.fn((id) => id),
  })
}

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
  // Rendered by a router view, as in the app: one page instance serves
  // both the new-chat and the chat route.
  const App = defineComponent({ render: () => h(RouterView) })
  const wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const draftKey = (cid = 'new') => `cs-agent-draft-v1:7:w1:${cid}`
const buttonByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text)

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  chatMounts.length = 0
  resetStores()
  fakeUi.announce.mockReset()
  fakeUi.focusComposer.mockReset()
  Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AgentChatPage first research', () => {
  it('sends the stashed research once with the research agent and moves to its chat', async () => {
    useFirstResearch().stash({ websiteId: 'w1', text: TEXT })
    const { router } = await setup('/projects/w1/agent?start=first-research')

    expect(fakeAgent.send).toHaveBeenCalledTimes(1)
    expect(fakeAgent.send).toHaveBeenCalledWith({ chatId: null, text: TEXT, agent: 'gap_analyst' })
    expect(router.currentRoute.value.name).toBe('agent-chat')
    expect(router.currentRoute.value.params.chatId).toBe('c9')
    expect(router.currentRoute.value.query).toEqual({})
    expect(useFirstResearch().peek('w1')).toBeNull()

    // Nothing sends it again: not another project round trip, not a reload of the store.
    fakeAgent.websiteId = 'w2'
    await nextTick()
    fakeAgent.websiteId = 'w1'
    await flushPromises()
    expect(fakeAgent.send).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('waits until the agent store is on the project', async () => {
    resetStores({ websiteId: null, init: vi.fn() })
    useFirstResearch().stash({ websiteId: 'w1', text: TEXT })
    await setup('/projects/w1/agent?start=first-research')
    expect(fakeAgent.send).not.toHaveBeenCalled()

    fakeAgent.websiteId = 'w1'
    await flushPromises()
    expect(fakeAgent.send).toHaveBeenCalledTimes(1)
  })

  it('keeps the message in the new chat composer when the send fails', async () => {
    resetStores({
      send: vi.fn(async () => {
        throw Object.assign(new Error('x'), {
          name: 'AgentError',
          status: 503,
          code: 'agent_disabled',
          message: 'The agent is turned off for this workspace.',
        })
      }),
    })
    useFirstResearch().stash({ websiteId: 'w1', text: TEXT })
    const { router, wrapper } = await setup('/projects/w1/agent?start=first-research')

    expect(toast.error).toHaveBeenCalledWith('The agent is turned off for this workspace.')
    expect(fakeUi.announce).toHaveBeenCalledWith('The agent is turned off for this workspace.', 'assertive')
    expect(localStorage.getItem(draftKey())).toBe(TEXT)
    // Still the new chat, now with the research agent picked.
    expect(router.currentRoute.value.name).toBe('agent-home')
    expect(router.currentRoute.value.query).toEqual({ agent: 'gap_analyst' })
    // The chat column mounted again, so its composer reads the draft.
    expect(chatMounts.length).toBe(2)
    expect(wrapper.find('.chat-stub').attributes('data-agent')).toBe('gap_analyst')
    expect(useFirstResearch().peek('w1')).toBeNull()
    expect(fakeAgent.send).toHaveBeenCalledTimes(1)
  })

  it('offers the research in a dialog when the page opens without the start query', async () => {
    useFirstResearch().stash({ websiteId: 'w1', text: TEXT })
    const { router } = await setup('/projects/w1/agent')
    expect(fakeAgent.send).not.toHaveBeenCalled()

    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Run your first research?')
    expect(dialog.textContent).toContain('Research Notion (notion.so) on Google and the AI engines for these prompts:')
    expect([...dialog.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual([
      'best note taking app for teams',
      'notion alternatives for startups',
    ])

    buttonByText(dialog, 'Start research').click()
    await flushPromises()
    expect(fakeAgent.send).toHaveBeenCalledWith({ chatId: null, text: TEXT, agent: 'gap_analyst' })
    expect(router.currentRoute.value.name).toBe('agent-chat')
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(useFirstResearch().peek('w1')).toBeNull()
  })

  it('discards the research with Not now', async () => {
    useFirstResearch().stash({ websiteId: 'w1', text: TEXT })
    await setup('/projects/w1/agent')
    const dialog = document.body.querySelector('[role="alertdialog"]')
    buttonByText(dialog, 'Not now').click()
    await flushPromises()
    expect(fakeAgent.send).not.toHaveBeenCalled()
    expect(useFirstResearch().peek('w1')).toBeNull()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it("leaves another project's research alone and drops the start query", async () => {
    useFirstResearch().stash({ websiteId: 'w2', text: TEXT })
    const { router } = await setup('/projects/w1/agent?start=first-research')
    expect(fakeAgent.send).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query).toEqual({})
    expect(useFirstResearch().peek('w2')).not.toBeNull()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('does nothing on an existing chat', async () => {
    useFirstResearch().stash({ websiteId: 'w1', text: TEXT })
    await setup('/projects/w1/agent/c/c1')
    expect(fakeAgent.send).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(useFirstResearch().peek('w1')).not.toBeNull()
  })
})

describe('AgentChatPage ?tab=', () => {
  it('opens the capture once the chat has loaded, then drops the query', async () => {
    resetStores({ chatState: { c1: { loaded: false, loading: true, error: null } } })
    const { router } = await setup('/projects/w1/agent/c/c1?tab=serp:3f2a9c1d0e7b')
    expect(fakePane.openCapture).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query.tab).toBe('serp:3f2a9c1d0e7b')

    fakeAgent.chatState.c1 = { loaded: true, loading: false, error: null }
    await flushPromises()
    expect(fakePane.openCapture).toHaveBeenCalledTimes(1)
    expect(fakePane.openCapture).toHaveBeenCalledWith('serp:3f2a9c1d0e7b', { activate: true })
    expect(router.currentRoute.value.query).toEqual({})
    expect(fakePane.bindChat).toHaveBeenCalledWith('c1')
  })

  it('opens it right away for a chat that is already loaded', async () => {
    resetStores({ chatState: { c1: { loaded: true, loading: false, error: null } } })
    await setup('/projects/w1/agent/c/c1?tab=page:0a1b2c3d4e5f')
    expect(fakePane.openCapture).toHaveBeenCalledWith('page:0a1b2c3d4e5f', { activate: true })
  })

  it('drops the query without opening anything for a chat that failed or a bad id', async () => {
    resetStores({ chatState: { c1: { loaded: false, loading: false, error: { status: 404 } } } })
    let ctx = await setup('/projects/w1/agent/c/c1?tab=serp:3f2a9c1d0e7b')
    expect(fakePane.openCapture).not.toHaveBeenCalled()
    expect(ctx.router.currentRoute.value.query).toEqual({})

    resetStores({ chatState: { c1: { loaded: true, loading: false, error: null } } })
    ctx = await setup('/projects/w1/agent/c/c1?tab=artifact:a1')
    expect(fakePane.openCapture).not.toHaveBeenCalled()
    expect(ctx.router.currentRoute.value.query).toEqual({})
  })

  it('keeps opening ?artifact= as before', async () => {
    const { router } = await setup('/projects/w1/agent/c/c1?artifact=a7')
    expect(fakePane.openArtifact).toHaveBeenCalledWith('a7', { activate: true })
    expect(router.currentRoute.value.query).toEqual({})
  })
})

describe('AgentChatPage ?from= (Ask the agent)', () => {
  const STATUS = {
    limits: { run_cost_usd: '3.00' },
    allowance: { cap_usd: '5.00', spent_usd: '0.92' },
    writers: { page_optimizer: { available: true, needs_usd: '0.45' } },
  }
  const notice = () => document.body.querySelector('.ag-drafted[role="status"]')

  it('shows where the draft came from, focuses the composer and drops the query, sending nothing', async () => {
    resetStores({ status: STATUS })
    const { router } = await setup('/projects/w1/agent?agent=page_optimizer&from=pages')
    expect(notice()).not.toBeNull()
    expect(notice().querySelector('.ag-drafted-line').textContent).toBe('Drafted from Pages. Review it, then send.')
    expect(notice().querySelector('.ag-drafted-limits').textContent).toBe(
      'A reply stops once it has used $3.00 of AI allowance; the request already running finishes. $4.08 left this month.'
    )
    expect(fakeUi.focusComposer).toHaveBeenCalled()
    expect(router.currentRoute.value.query).toEqual({ agent: 'page_optimizer' })
    // The composer mounts with the draft and the agent named by ?agent=.
    expect(chatMounts.at(-1)).toEqual({ chatId: null, initialAgent: 'page_optimizer' })
    expect(fakeAgent.send).not.toHaveBeenCalled()
  })

  it('mounts the chat column again when a draft arrives on the new chat already open', async () => {
    resetStores({ status: STATUS })
    const { router, wrapper } = await setup('/projects/w1/agent')
    expect(chatMounts).toHaveLength(1)
    expect(notice()).toBeNull()

    await router.push('/projects/w1/agent?agent=gap_analyst&from=sentiment')
    await flushPromises()
    expect(chatMounts).toHaveLength(2)
    expect(wrapper.find('.chat-stub').attributes('data-agent')).toBe('gap_analyst')
    expect(notice().querySelector('.ag-drafted-line').textContent).toBe('Drafted from Sentiment. Review it, then send.')
    expect(router.currentRoute.value.query).toEqual({ agent: 'gap_analyst' })
    expect(fakeAgent.send).not.toHaveBeenCalled()
  })

  it('names the Agents page and keeps only the first sentence with an unlimited allowance', async () => {
    resetStores({ status: { ...STATUS, allowance: { cap_usd: '0.00', spent_usd: '1.20' } } })
    await setup('/projects/w1/agent?from=agents')
    expect(notice().querySelector('.ag-drafted-line').textContent).toBe('Drafted from Agents. Review it, then send.')
    expect(notice().querySelector('.ag-drafted-limits').textContent).toBe(
      'A reply stops once it has used $3.00 of AI allowance; the request already running finishes.'
    )
  })

  it('says when the preselected writer cannot start', async () => {
    resetStores({
      status: { ...STATUS, writers: { page_optimizer: { available: false, needs_usd: '0.45' } } },
    })
    await setup('/projects/w1/agent?agent=page_optimizer&from=crawler-access')
    expect(notice().querySelector('.ag-drafted-line').textContent).toBe('Drafted from Crawler access. Review it, then send.')
    expect(notice().querySelector('.ag-drafted-limits').textContent).toBe(
      'A reply stops once it has used $3.00 of AI allowance; the request already running finishes. $4.08 left this month. ' +
        'Needs at least $0.45 of AI allowance; $4.08 left this month.'
    )
  })

  it('shows the first line alone until the agent status has loaded', async () => {
    resetStores({ status: null })
    await setup('/projects/w1/agent?from=fact-check')
    expect(notice().querySelector('.ag-drafted-line').textContent).toBe('Drafted from Fact check. Review it, then send.')
    expect(notice().querySelector('.ag-drafted-limits')).toBeNull()
    fakeAgent.status = STATUS
    await flushPromises()
    expect(notice().querySelector('.ag-drafted-limits').textContent).toContain('$3.00')
  })

  it('clears the notice once the message is sent and the chat has its id', async () => {
    resetStores({ status: STATUS, messages: {}, visiblePath: () => [] })
    await setup('/projects/w1/agent?from=pages')
    expect(notice()).not.toBeNull()
    // The first message shows in the new chat's thread.
    fakeAgent.messages = { m1: { id: 'm1', role: 'user' } }
    fakeAgent.visiblePath = (key) => (key === 'new' ? ['m1'] : [])
    await flushPromises()
    expect(notice()).toBeNull()

    resetStores({ status: STATUS })
    const next = await setup('/projects/w1/agent?from=products')
    expect(notice()).not.toBeNull()
    await next.router.replace({ name: 'agent-chat', params: { websiteId: 'w1', chatId: 'c9' } })
    await flushPromises()
    expect(notice()).toBeNull()
  })

  it('ignores ?from= on an existing chat and an unknown tab, and drops it', async () => {
    let ctx = await setup('/projects/w1/agent/c/c1?from=pages')
    expect(notice()).toBeNull()
    expect(ctx.router.currentRoute.value.query).toEqual({})
    expect(fakeUi.focusComposer).not.toHaveBeenCalled()

    ctx = await setup('/projects/w1/agent?from=elsewhere')
    expect(notice()).toBeNull()
    expect(ctx.router.currentRoute.value.query).toEqual({})
  })
})
