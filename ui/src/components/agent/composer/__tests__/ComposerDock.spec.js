import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => ({ openNewTab: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 1 } }) }))

const { default: ComposerDock } = await import('@/components/agent/composer/ComposerDock.vue')
const { default: Composer } = await import('@/components/agent/composer/Composer.vue')

enableAutoUnmount(afterEach)

function mountDock() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(ComposerDock, {
    props: { websiteId: 'w1' },
    global: { plugins: [pinia], stubs: { Composer: true, JumpToLatest: true, RouterLink: true } },
  })
}

beforeEach(() => {
  localStorage.clear()
  Object.assign(fakeAgent, {
    status: null,
    statusError: null,
    statusLoading: false,
    catalog: null,
    chatState: {},
    messages: {},
    loadStatus: vi.fn(async () => null),
    send: vi.fn(async () => 'c1'),
  })
})

describe('ComposerDock status banner', () => {
  it('says the status check failed, without blocking a send', async () => {
    fakeAgent.statusError = { status: 0, code: 'network', message: "Couldn't reach CanSee. Check your connection and try again." }
    const w = mountDock()
    expect(w.text()).toContain("We couldn't check the agent's status.")
    expect(w.text()).toContain("Couldn't reach CanSee.")
    expect(w.findComponent(Composer).props('blocked')).toBe(false)
    await w.find('.ag-banner button').trigger('click')
    expect(fakeAgent.loadStatus).toHaveBeenCalledTimes(1)
  })

  it('shows the server state once the status loads', async () => {
    fakeAgent.statusError = { status: 500, code: 'internal_error', message: 'Something went wrong on our end.' }
    const w = mountDock()
    expect(w.find('.ag-banner').exists()).toBe(true)
    Object.assign(fakeAgent, { statusError: null, status: { enabled: false, configured: true, allowance: null } })
    await w.vm.$nextTick()
    expect(w.text()).toContain('The agent is switched off.')
    expect(w.text()).not.toContain("We couldn't check")
    expect(w.findComponent(Composer).props('blocked')).toBe(true)
  })

  it('shows no banner while the first status check is still running', () => {
    fakeAgent.statusLoading = true
    const w = mountDock()
    expect(w.find('.ag-banner').exists()).toBe(false)
  })

  it('says the free prompt runs are used up without blocking a send', () => {
    fakeAgent.status = {
      enabled: true,
      configured: true,
      live_available: true,
      allowance: { cap_usd: 3, spent_usd: 1, exceeded: false, warning: true, show_usd: false },
      prompt_runs: { unlimited: false, limit: 20, used: 20, reserved: 0, remaining: 0, resets_at: '2026-11-30T23:59:59+00:00' },
    }
    const w = mountDock()
    // Used-up runs come before the allowance warning.
    expect(w.find('.ag-banner-title').text()).toBe("You have used this month's 20 free prompt runs.")
    expect(w.findComponent(Composer).props('blocked')).toBe(false)
  })

  it('shows no runs banner while some are left, or for a paid account', async () => {
    fakeAgent.status = {
      enabled: true,
      configured: true,
      live_available: true,
      allowance: { exceeded: false, warning: false },
      prompt_runs: { unlimited: false, limit: 20, used: 19, reserved: 0, remaining: 1 },
    }
    const w = mountDock()
    expect(w.find('.ag-banner').exists()).toBe(false)
    fakeAgent.status = { ...fakeAgent.status, prompt_runs: { unlimited: true, limit: null, remaining: null } }
    await w.vm.$nextTick()
    expect(w.find('.ag-banner').exists()).toBe(false)
  })
})

describe('ComposerDock: the agent process is down', () => {
  const running = { enabled: true, configured: true, live_available: true, allowance: { exceeded: false, warning: false } }

  it('says the agent is not running and what to do, with Check again, without blocking a send', async () => {
    vi.stubEnv('DEV', false)
    try {
      fakeAgent.status = { ...running, live_available: false }
      const w = mountDock()
      expect(w.find('.ag-banner-title').text()).toBe("The AI agent isn't running right now.")
      expect(w.text()).toContain('Try again in a minute. If it stays down, contact support.')
      // Customers never see setting names.
      expect(w.text()).not.toContain('ANTHROPIC_API_KEY')
      expect(w.findComponent(Composer).props('blocked')).toBe(false)
      await w.find('.ag-banner button').trigger('click')
      expect(fakeAgent.loadStatus).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('shows the refusal of a send while status still says running, and refreshes the status', async () => {
    fakeAgent.status = { ...running }
    fakeAgent.send = vi.fn(async () => {
      throw Object.assign(new Error("The AI agent isn't running right now."), { status: 503, code: 'agent_unavailable' })
    })
    const w = mountDock()
    expect(w.find('.ag-banner').exists()).toBe(false)
    w.findComponent(Composer).vm.$emit('submit', 'Hello')
    await flushPromises()
    expect(w.find('.ag-banner-title').text()).toBe("The AI agent isn't running right now.")
    expect(fakeAgent.loadStatus).toHaveBeenCalledTimes(1)
    expect(w.findComponent(Composer).props('blocked')).toBe(false)
    // The text comes back for another try.
    expect(w.findComponent(Composer).props('modelValue')).toBe('Hello')
    // The refreshed status says the agent is back: the banner goes.
    fakeAgent.status = { ...running }
    await w.vm.$nextTick()
    expect(w.find('.ag-banner').exists()).toBe(false)
  })

  it('shows the banner for an optimistic message the agent refused', async () => {
    fakeAgent.status = { ...running }
    const w = mountDock()
    fakeAgent.chatState = { new: { leafId: 'tmp-1' } }
    fakeAgent.messages = { 'tmp-1': { id: 'tmp-1', status: 'send_failed', error_code: 'agent_unavailable' } }
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(w.find('.ag-banner-title').text()).toBe("The AI agent isn't running right now.")
  })
})
