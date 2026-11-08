import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const rm = vi.hoisted(() => ({ hooks: null }))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  authHeaders: () => ({}),
  refreshAccessToken: async () => '',
}))

vi.mock('@/api/agent', () => ({
  default: { status: vi.fn(), agents: vi.fn(), listChats: vi.fn(), getChat: vi.fn() },
}))

vi.mock('@/lib/agent/runManager', () => ({
  createRunManager(hooks) {
    rm.hooks = hooks
    const sessions = new Set()
    return {
      attach: (run) => sessions.add(String(run.id)) && run,
      detach: (id) => sessions.delete(String(id)),
      detachAll: () => sessions.clear(),
      isAttached: (id) => sessions.has(String(id)),
      nudge() {},
    }
  },
}))

import agentApi from '@/api/agent'
import { useAgentStore } from '@/stores/agent'
import { useAuthStore } from '@/stores/auth'
import { noteFirstResearchChat, noteSetupFinished, readSetup } from '@/lib/setup/storage'
import { useSetupStatus } from '@/composables/setup/useSetupStatus'
import SetupStatusPanel from '../SetupStatusPanel.vue'

const ok = (data) => ({ data })

const STATUS = {
  enabled: true,
  configured: true,
  live_available: true,
  engines: [{ key: 'chatgpt', label: 'ChatGPT', configured: true, key_setting: '' }],
  google: { configured: true, key_settings: [] },
  research: { available: true, reason: null, message: '' },
  prompt_runs: { unlimited: false, limit: 20, used: 7, remaining: 13, resets_at: '2026-12-01T00:00:00Z' },
  allowance: { show_usd: false, cap_usd: 3, spent_usd: 1.25 },
  setup: { ready: true, issues: [] },
}

const ENGINE_ISSUE = {
  code: 'engine_not_configured',
  severity: 'limited',
  subject: 'engine',
  engine: 'grok',
  setting: null,
  title: "Grok isn't set up on this workspace.",
  action: 'Grok is skipped; the other engines still answer.',
}

const AGENT_DOWN = {
  code: 'agent_unavailable',
  severity: 'blocking',
  subject: 'agent',
  engine: null,
  setting: null,
  title: "The AI agent isn't running right now.",
  action: 'Try again in a minute. If it stays down, contact support.',
}

const task = (id, status, over = {}) => ({
  id,
  category: 'engines',
  label: 'ChatGPT',
  target: 'best crm for agencies',
  status,
  rev: 1,
  ...over,
})

function chatDetail({ run = null, reply = {} } = {}) {
  return {
    id: 'c1',
    title: 'First research',
    current_leaf_id: 'a1',
    messages: [
      { id: 'u1', chat_id: 'c1', parent_id: null, role: 'user', status: 'complete', parts: [], sibling_ids: ['u1'] },
      { id: 'a1', chat_id: 'c1', parent_id: 'u1', role: 'assistant', status: 'streaming', parts: [], sibling_ids: ['a1'], ...reply },
    ],
    active_run: run,
  }
}

const RUN = (status, over = {}) => ({ id: 'r1', chat_id: 'c1', message_id: 'a1', status, last_seq: 0, ...over })

const mounted = []

async function mountPanel({ wid = 'w1', autopilotOn = null, attach = true } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: { render: () => null } },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: { render: () => null } },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: { render: () => null } },
      { path: '/settings/autopilot', name: 'settings-autopilot', component: { render: () => null } },
    ],
  })
  await router.push(`/projects/${wid}/analytics`)
  const agent = useAgentStore()
  await agent.init(wid)
  await flushPromises()
  const onAdd = vi.fn()
  const Host = defineComponent({
    setup() {
      const setup = reactive(useSetupStatus(wid, { autopilotOn: ref(autopilotOn) }))
      const panel = ref(null)
      return () => h(SetupStatusPanel, { ref: panel, setup, onAddPrompts: onAdd })
    },
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: attach ? document.body : undefined })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, agent, onAdd, router }
}

const panelOf = (wrapper) => wrapper.find('[data-setup-panel]')
const textOf = (wrapper) => panelOf(wrapper).text().replace(/\s+/g, ' ')
let seq = 0
const event = (type, payload = {}) => ({ v: 1, seq: ++seq, type, run_id: 'r1', message_id: 'a1', ts: '2026-11-08T10:00:00Z', ...payload })

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  useAuthStore().user = { id: 7 }
  vi.clearAllMocks()
  seq = 0
  agentApi.status.mockResolvedValue(ok(STATUS))
  agentApi.agents.mockResolvedValue(ok([]))
  agentApi.listChats.mockResolvedValue(ok({ results: [], next_cursor: null }))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
})

describe('SetupStatusPanel', () => {
  it('stays out of the way when setup is complete and this is not a first landing', async () => {
    const { wrapper } = await mountPanel()
    expect(panelOf(wrapper).exists()).toBe(false)
  })

  it('shows the queued first research: waiting for a slot, the steps, a moving bar and a link to the Agent', async () => {
    noteSetupFinished(7, 'w1', 'research', Date.now())
    noteFirstResearchChat(7, 'w1', 'c1')
    agentApi.getChat.mockResolvedValue(ok(chatDetail({ run: RUN('queued', { queue: { position: 3, ahead: 2, slots: 6 } }) })))
    const { wrapper } = await mountPanel()
    const text = textOf(wrapper)
    expect(panelOf(wrapper).attributes('aria-labelledby')).toBe(wrapper.find('h2').attributes('id'))
    expect(wrapper.find('h2').text()).toBe('Setup')
    expect(wrapper.find('.ss-summary').text()).toBe('Waiting for a free slot (2 ahead)')
    expect(text).toContain('Your research starts as soon as one is free.')
    // Read out once, politely.
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('Waiting for a free slot (2 ahead)')

    const stages = wrapper.findAll('.ss-stage')
    expect(stages.map((s) => s.find('.ss-stage-label').text())).toEqual(['Start', 'Plan', 'Ask Google and the AI engines', 'Write up'])
    expect(stages[0].classes()).toContain('is-current')
    expect(stages[0].text()).toContain('(in progress)')
    expect(stages[1].text()).toContain('(not started)')

    const bar = wrapper.find('[role="progressbar"]')
    expect(bar.classes()).toContain('is-indeterminate')
    expect(bar.attributes('aria-valuenow')).toBeUndefined()
    expect(bar.attributes('aria-valuetext')).toBe('Working')

    const link = wrapper.find('a.ss-link')
    expect(link.text()).toBe('Open in the Agent')
    expect(link.attributes('href')).toBe('/projects/w1/agent/c/c1')
    // Not while it runs.
    expect(wrapper.find('[data-ss-dismiss]').exists()).toBe(false)
    expect(wrapper.find('.ss-next').exists()).toBe(false)
  })

  it('moves with the research: counts, what is being asked, then ready with next steps', async () => {
    noteFirstResearchChat(7, 'w1', 'c1')
    agentApi.getChat.mockResolvedValue(
      ok(
        chatDetail({
          run: RUN('running'),
          reply: {
            parts: [
              {
                id: 'p-swarm',
                type: 'swarm',
                status: 'running',
                tasks: [
                  task('engines.p1.chatgpt', 'done'),
                  task('engines.p1.claude', 'running', { label: 'Claude' }),
                  task('google.p1.page1', 'queued', { category: 'google', label: 'Google page 1' }),
                  task('engines.p1.gemini', 'queued', { label: 'Gemini' }),
                ],
              },
            ],
          },
        }),
      ),
    )
    const { wrapper } = await mountPanel({ autopilotOn: false })
    expect(wrapper.find('.ss-summary').text()).toBe('Asking Google and the AI engines')
    expect(textOf(wrapper)).toContain('1 of 4 agents finished')
    const bar = wrapper.find('[role="progressbar"]')
    expect(bar.classes()).not.toContain('is-indeterminate')
    expect(bar.attributes('aria-valuenow')).toBe('25')
    expect(bar.find('.ss-bar-fill').attributes('style')).toContain('width: 25%')
    const asks = wrapper.findAll('.ss-asking li')
    expect(asks.map((li) => li.element.textContent)).toEqual(['Claude: best crm for agencies'])
    expect(wrapper.find('.ss-asking').attributes('aria-label')).toBe('Being asked now')
    const stages = wrapper.findAll('.ss-stage')
    expect(stages.map((s) => s.classes().find((c) => c.startsWith('is-')))).toEqual(['is-done', 'is-done', 'is-current', 'is-pending'])

    rm.hooks.applyEvents('r1', [event('task.started', { part_id: 'p-swarm', task_id: 'google.p1.page1', rev: 2, patch: { status: 'running' } })])
    await nextTick()
    expect(wrapper.findAll('.ss-asking li').map((li) => li.find('.ss-ask-who').text())).toEqual(['Claude:', 'Google page 1:'])

    rm.hooks.applyEvents('r1', [event('run.completed', { status: 'complete' })])
    await flushPromises()
    expect(wrapper.find('.ss-summary').text()).toBe('Your first research is ready.')
    expect(wrapper.find('a.ss-link').exists()).toBe(false)
    const steps = wrapper.findAll('.ss-step')
    expect(steps.map((s) => s.attributes('data-step'))).toEqual(['results', 'autopilot', 'prompts'])
    expect(steps[0].find('a').text()).toBe('View the research')
    expect(steps[0].find('a').attributes('href')).toBe('/projects/w1/agent/c/c1')
    expect(steps[1].find('a').attributes('href')).toBe('/settings/autopilot')
    expect(wrapper.find('[data-ss-dismiss]').exists()).toBe(true)
  })

  it("explains what is not set up in the customer's words, with no setting names", async () => {
    agentApi.status.mockResolvedValue(ok({ ...STATUS, setup: { ready: true, issues: [ENGINE_ISSUE] } }))
    const { wrapper } = await mountPanel()
    expect(panelOf(wrapper).exists()).toBe(true)
    expect(wrapper.find('.ss-summary').text()).toBe('1 thing not set up on this workspace.')
    expect(wrapper.find('.ss-config .ss-block-title').text()).toBe('Not set up yet')
    const item = wrapper.find('.ss-issue')
    expect(item.classes()).toContain('is-limited')
    expect(item.text()).toContain("Grok isn't set up on this workspace.")
    expect(item.text()).toContain('Grok is skipped; the other engines still answer.')
    expect(item.find('.ss-issue-setting').exists()).toBe(false)
    expect(panelOf(wrapper).text()).not.toMatch(/_KEY|_ENABLED/)
    // Setup is missing: no way to close it, only to fold it.
    expect(wrapper.find('[data-ss-dismiss]').exists()).toBe(false)
  })

  it('names the setting for staff and DEBUG servers (the server sends it only to them)', async () => {
    agentApi.status.mockResolvedValue(
      ok({
        ...STATUS,
        engines: [{ key: 'grok', label: 'Grok', configured: false, key_setting: 'XAI_API_KEY' }],
        setup: { ready: true, issues: [{ ...ENGINE_ISSUE, setting: 'XAI_API_KEY' }] },
      }),
    )
    const { wrapper } = await mountPanel()
    expect(wrapper.find('.ss-issue-setting').text()).toBe('Setting: XAI_API_KEY')
  })

  it('says why a research cannot start, on a control that keeps focus', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    agentApi.status.mockResolvedValue(ok({ ...STATUS, setup: { ready: false, issues: [AGENT_DOWN] } }))
    const { wrapper } = await mountPanel()
    const item = wrapper.find('.ss-issue')
    expect(item.classes()).toContain('is-blocking')
    const step = wrapper.find('[data-step="research"]')
    const button = step.find('button')
    expect(button.text()).toBe('Run a research')
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(button.attributes('disabled')).toBeUndefined()
    const why = step.find('.ss-step-why')
    expect(why.text()).toBe("Not available: The AI agent isn't running right now.")
    expect(button.attributes('aria-describedby')).toBe(why.attributes('id'))
  })

  it('counts free prompt runs and never shows dollars; a paid plan shows no count', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    const { wrapper } = await mountPanel()
    expect(wrapper.find('.ss-runs').text()).toContain('13 free prompt runs left')
    expect(wrapper.find('.ss-runs').text()).toContain('They renew on December 1.')
    expect(panelOf(wrapper).text()).not.toContain('$')
    wrapper.unmount()
    mounted.length = 0

    setActivePinia(createPinia())
    useAuthStore().user = { id: 7 }
    agentApi.status.mockResolvedValue(ok({ ...STATUS, prompt_runs: { unlimited: true, limit: null, remaining: null } }))
    const paid = await mountPanel()
    expect(paid.wrapper.find('.ss-runs').exists()).toBe(false)
  })

  it('warns when no free prompt runs are left', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    agentApi.status.mockResolvedValue(ok({ ...STATUS, prompt_runs: { ...STATUS.prompt_runs, remaining: 0 } }))
    const { wrapper } = await mountPanel()
    const runs = wrapper.find('.ss-runs')
    expect(runs.classes()).toContain('is-exhausted')
    expect(runs.text()).toContain('No free prompt runs left this month.')
  })

  it('says when the setup could not be checked, and Check again asks again', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    agentApi.status.mockRejectedValueOnce(new Error('down'))
    const { wrapper } = await mountPanel()
    expect(wrapper.find('[role="alert"]').text()).toBe("We couldn't check your setup. Try again in a moment.")
    expect(wrapper.find('.ss-summary').text()).toBe("We couldn't check your setup.")
    expect(wrapper.find('[data-ss-dismiss]').exists()).toBe(false)
    const check = wrapper.findAll('button').find((b) => b.text() === 'Check again')
    await check.trigger('click')
    await flushPromises()
    expect(agentApi.status).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('.ss-ok').text()).toBe('Google results, the AI engines and the research agents are set up.')
  })

  it('offers the next steps after a skipped research, and Add prompts asks the board', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    const { wrapper, onAdd } = await mountPanel({ autopilotOn: true })
    expect(wrapper.find('.ss-research').exists()).toBe(false)
    const steps = wrapper.findAll('.ss-step')
    expect(steps.map((s) => s.attributes('data-step'))).toEqual(['research', 'prompts'])
    expect(steps[0].find('a').attributes('href')).toBe('/projects/w1/agent?agent=gap_analyst')
    await steps[1].find('button').trigger('click')
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('folds to its summary and back, remembered for the project', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    const { wrapper } = await mountPanel()
    const toggle = wrapper.findAll('button').find((b) => b.text() === 'Hide details')
    const body = wrapper.find('.ss-body')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.attributes('aria-controls')).toBe(body.attributes('id'))
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.text()).toBe('Show details')
    expect(body.isVisible()).toBe(false)
    expect(wrapper.find('.ss-summary').isVisible()).toBe(true)
    expect(readSetup(7, 'w1').collapsed).toBe(true)

    wrapper.unmount()
    mounted.length = 0
    const again = await mountPanel()
    expect(again.wrapper.find('.ss-body').isVisible()).toBe(false)
  })

  it('closes for good once everything is set up and the research is over', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    const { wrapper } = await mountPanel()
    const close = wrapper.find('[data-ss-dismiss]')
    expect(close.attributes('aria-label')).toBe('Close setup')
    await close.trigger('click')
    expect(panelOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
    mounted.length = 0
    const again = await mountPanel()
    expect(panelOf(again.wrapper).exists()).toBe(false)
  })

  it('comes back when setup goes missing after it was closed', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    const { wrapper, agent } = await mountPanel()
    await wrapper.find('[data-ss-dismiss]').trigger('click')
    expect(panelOf(wrapper).exists()).toBe(false)
    agentApi.status.mockResolvedValue(ok({ ...STATUS, setup: { ready: true, issues: [ENGINE_ISSUE] } }))
    await agent.loadStatus()
    await nextTick()
    expect(panelOf(wrapper).exists()).toBe(true)
  })

  it('show() unfolds the panel and gives its heading focus', async () => {
    noteSetupFinished(7, 'w1', 'skip', Date.now())
    const { wrapper } = await mountPanel()
    await wrapper.findAll('button').find((b) => b.text() === 'Hide details').trigger('click')
    const panel = wrapper.findComponent(SetupStatusPanel)
    await panel.vm.show()
    await nextTick()
    expect(wrapper.find('.ss-body').isVisible()).toBe(true)
    expect(document.activeElement).toBe(wrapper.find('h2').element)
    expect(wrapper.find('h2').attributes('tabindex')).toBe('-1')
  })

  it('reports a research that failed, in the words of the run', async () => {
    noteFirstResearchChat(7, 'w1', 'c1')
    agentApi.getChat.mockResolvedValue(
      ok(chatDetail({ reply: { status: 'failed', error_message: 'This reply took too long and was stopped.' } })),
    )
    const { wrapper } = await mountPanel()
    expect(wrapper.find('.ss-summary').text()).toBe("The research didn't finish.")
    expect(textOf(wrapper)).toContain('This reply took too long and was stopped.')
    expect(panelOf(wrapper).classes()).toContain('is-bad')
    expect(wrapper.find('[data-step="results"] a').text()).toBe('Open the research')
  })
})
