import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import UserMessage from '@/components/agent/message/UserMessage.vue'

enableAutoUnmount(afterEach)

const Passthrough = defineComponent({
  inheritAttrs: false,
  setup(_, { slots }) {
    return () => slots.default?.()
  },
})

// A send the server refused, as the store keeps it (AgentError.toJSON()).
function refused(error) {
  return {
    id: 'tmp-1',
    role: 'user',
    status: 'send_failed',
    parts: [{ id: 'tmp-1:text', type: 'text', text: 'Research our pricing page' }],
    error_code: error.code,
    error_message: error.message,
    local: true,
    send: { text: 'Research our pricing page', error },
  }
}

function mountMessage(message) {
  return mount(UserMessage, { props: { message }, global: { stubs: { AgTooltip: Passthrough } } })
}

describe('UserMessage send failures', () => {
  it('says the message is too long and offers no Retry that would fail again', () => {
    const w = mountMessage(
      refused({ status: 400, code: 'invalid', message: 'Messages can be at most 20000 characters.', retryable: false })
    )
    expect(w.find('[role="alert"]').text()).toContain('Not sent. Messages can be at most 20000 characters.')
    expect(w.find('.ag-user-retry').exists()).toBe(false)
  })

  it('says the chat is gone when it was deleted elsewhere', () => {
    const w = mountMessage(refused({ status: 404, code: 'not_found', message: 'Chat not found.', retryable: false }))
    expect(w.text()).toContain('Not sent. Chat not found.')
    expect(w.find('.ag-user-retry').exists()).toBe(false)
  })

  it('keeps the reason for a send that was too fast, and lets it be retried', async () => {
    const message = 'You are sending messages faster than the agent can take them. Wait a few seconds and try again.'
    const w = mountMessage(refused({ status: 429, code: 'agent_busy', message, retryable: true }))
    expect(w.text()).toContain(`Not sent. ${message}`)
    expect(w.text()).not.toContain('Another reply is still running.')
    await w.find('.ag-user-retry').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('offers Retry after a lost connection', () => {
    const w = mountMessage(
      refused({ status: 0, code: 'network', message: "Couldn't reach CanSee. Check your connection and try again.", retryable: true })
    )
    expect(w.text()).toContain("Not sent. Couldn't reach CanSee.")
    expect(w.find('.ag-user-retry').exists()).toBe(true)
  })

  it('offers no Retry while the agent is switched off', () => {
    const w = mountMessage(
      refused({ status: 503, code: 'agent_disabled', message: 'The agent workspace is turned off.', retryable: true })
    )
    expect(w.text()).toContain('Not sent. The agent workspace is turned off.')
    expect(w.find('.ag-user-retry').exists()).toBe(false)
  })

  it('falls back to the copy for a known code without a message', () => {
    const w = mountMessage(refused({ status: 403, code: 'allowance_exceeded', message: '', retryable: false }))
    expect(w.text()).toContain("Not sent. You've used your AI allowance for this period.")
  })
})
