import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import StatusBanner from '@/components/agent/composer/StatusBanner.vue'

enableAutoUnmount(afterEach)

function mountBanner(props) {
  return mount(StatusBanner, { props, global: { stubs: { RouterLink: true } } })
}

describe('StatusBanner', () => {
  it('does not promise saved work is reachable while the agent is off', () => {
    const w = mountBanner({ code: 'agent_disabled' })
    expect(w.text()).toContain('The agent is switched off.')
    expect(w.text()).not.toContain('still here')
    expect(w.text()).toContain('Your chats and reports are kept and open again once it is back on.')
  })

  it('says when the status could not be checked, with the reason and Check again', async () => {
    const w = mountBanner({
      code: 'status_unknown',
      detail: "Couldn't reach CanSee. Check your connection and try again.",
    })
    expect(w.find('[role="status"]').exists()).toBe(true)
    expect(w.text()).toContain("We couldn't check the agent's status.")
    expect(w.text()).toContain("Couldn't reach CanSee.")
    await w.find('button').trigger('click')
    expect(w.emitted('recheck')).toHaveLength(1)
  })

  it('shows Checking while the status loads again', () => {
    const w = mountBanner({ code: 'status_unknown', checking: true })
    expect(w.find('button').text()).toBe('Checking')
    expect(w.find('button').attributes('disabled')).toBeDefined()
  })

  it('says the site is down for maintenance, not that the agent is unreachable', async () => {
    const w = mountBanner({ code: 'maintenance' })
    expect(w.text()).toContain('CanSee is down for maintenance.')
    expect(w.text()).toContain('Try again in a few minutes.')
    expect(w.text()).not.toContain("isn't reachable")
    await w.find('button').trigger('click')
    expect(w.emitted('recheck')).toHaveLength(1)
  })

  describe('when the agent cannot answer', () => {
    afterEach(() => vi.unstubAllEnvs())

    // The status a customer gets, and the one staff (or a DEBUG server) gets.
    const customer = { configured: false, setup: { issues: [{ code: 'agent_not_configured', setting: null }] } }
    const staff = { configured: false, setup: { issues: [{ code: 'agent_not_configured', setting: 'ANTHROPIC_API_KEY' }] } }

    it('tells a customer what to do about a missing key, in plain words', () => {
      vi.stubEnv('DEV', false)
      const w = mountBanner({ code: 'agent_not_configured', status: customer })
      expect(w.text()).toContain("The AI agent isn't set up on this workspace.")
      expect(w.text()).toContain('Ask your workspace admin to add the Anthropic API key.')
      expect(w.text()).not.toContain('ANTHROPIC_API_KEY')
    })

    it('names the setting for staff and on DEBUG servers', () => {
      vi.stubEnv('DEV', false)
      const w = mountBanner({ code: 'agent_not_configured', status: staff })
      expect(w.text()).toContain('Set ANTHROPIC_API_KEY on the server, then restart the backend and the agent process.')
    })

    it('says the agent is not running, what happens to a reply in progress and what to do', async () => {
      vi.stubEnv('DEV', false)
      const w = mountBanner({ code: 'agent_unavailable', status: { live_available: false } })
      expect(w.text()).toContain("The AI agent isn't running right now.")
      expect(w.text()).toContain('A reply in progress continues when the agent is back, or shows as interrupted.')
      expect(w.text()).toContain('Try again in a minute. If it stays down, contact support.')
      expect(w.text()).not.toContain('ANTHROPIC_API_KEY')
      await w.find('button').trigger('click')
      expect(w.emitted('recheck')).toHaveLength(1)
    })

    it('tells staff to check the agent process and its key while it is down', () => {
      vi.stubEnv('DEV', false)
      const w = mountBanner({
        code: 'agent_unavailable',
        status: { live_available: false, engines: [{ key: 'chatgpt', key_setting: 'OPENAI_API_KEY' }] },
      })
      expect(w.text()).toContain('Check that the agent process is running. It also needs ANTHROPIC_API_KEY to answer.')
    })
  })

  it('shows nothing without a code', () => {
    expect(mountBanner({ code: '' }).find('.ag-banner').exists()).toBe(false)
  })
})
