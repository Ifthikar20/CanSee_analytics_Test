import { afterEach, describe, expect, it } from 'vitest'
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

  it('shows nothing without a code', () => {
    expect(mountBanner({ code: '' }).find('.ag-banner').exists()).toBe(false)
  })
})
