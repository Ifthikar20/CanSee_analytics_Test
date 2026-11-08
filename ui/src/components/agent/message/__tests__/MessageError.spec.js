import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MessageError from '@/components/agent/message/MessageError.vue'
import { errorCopy } from '@/components/agent/message/parts'

enableAutoUnmount(afterEach)

// Every code a run can fail with, and its run.failed `retryable`
// (backend llm/errors.py, llm/gate.py and runtime/runner.py).
const RUN_FAILURES = {
  upstream_overloaded: true,
  upstream_error: true,
  upstream_unreachable: true,
  upstream_unavailable: true,
  rate_limited: true,
  context_too_long: false,
  bad_request: false,
  upstream_auth: false,
  model_not_found: false,
  agent_not_configured: false,
  agent_disabled: false,
  allowance_exceeded: false,
  internal_error: true,
  run_timeout: true,
  run_cost_limit: false,
  request_limit: false,
  invalid_tool_input: true,
  max_tokens: true,
  pause_limit: true,
}

const GENERIC = errorCopy('not_a_code', '', 'failed').title

const Blank = defineComponent({ render: () => h('div') })

function mountError(props) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/billing', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
    ],
  })
  return mount(MessageError, { props, global: { plugins: [router] } })
}

describe('errorCopy', () => {
  it.each(Object.entries(RUN_FAILURES))('has its own copy for %s, retry %s as the backend says', (code, retryable) => {
    const copy = errorCopy(code, 'Server text.', 'failed')
    expect(copy.title).not.toBe(GENERIC)
    expect(copy.retry).toBe(retryable)
  })

  it('says why free prompt runs refused a reply, in the server words, with no retry', () => {
    const exhausted = errorCopy(
      'prompt_runs_exhausted',
      "  You have used this month's 20 free prompt runs. They renew on November 30. ",
      'failed',
    )
    expect(exhausted).toMatchObject({
      code: 'prompt_runs_exhausted',
      title: "This month's free prompt runs are used up.",
      body: "You have used this month's 20 free prompt runs. They renew on November 30.",
      retry: false,
      billing: true,
    })
    expect(exhausted).not.toHaveProperty('useMessage')
    const short = errorCopy('insufficient_prompt_runs', 'This needs 6 free prompt runs and 4 of your 20 are left this month.', 'failed')
    expect(short).toMatchObject({ title: 'Not enough free prompt runs are left.', retry: false })
    expect(short.body).toBe('This needs 6 free prompt runs and 4 of your 20 are left this month.')
    // No server text: the title alone, never a dollar amount.
    expect(errorCopy('insufficient_prompt_runs', '', 'failed').body).toBe('')
  })

  it('keeps its own body for other known codes, whatever the server says', () => {
    expect(errorCopy('allowance_exceeded', 'Server text.', 'failed').body).toBe('Upgrade your plan or wait for the allowance to reset.')
    // A known code without a body of its own stays without one.
    expect(errorCopy('agent_disabled', 'Server text.', 'failed').body).toBe('')
  })

  it('offers a new chat when the chat is too long', () => {
    expect(errorCopy('context_too_long', '', 'failed')).toMatchObject({ retry: false, newChat: true })
  })

  it('reads a send refused for maintenance as maintenance, not the agent being down', () => {
    const copy = errorCopy('maintenance', 'Cansee is down for maintenance. Try again in a few minutes.', 'send_failed')
    expect(copy).toMatchObject({ title: 'CanSee is down for maintenance.', body: 'Try again in a few minutes.', retry: true })
    expect(copy.title).not.toBe(errorCopy('agent_unavailable', '', 'send_failed').title)
  })

  it('does not read codes off the object prototype', () => {
    expect(errorCopy('constructor', 'The model returned nothing.', 'failed')).toMatchObject({
      title: GENERIC,
      body: 'The model returned nothing.',
    })
  })
})

describe('MessageError', () => {
  it('offers Reload chat, not Retry, for a reply this tab stopped following', async () => {
    const w = mountError({ code: 'resync_failed', message: 'resync did not converge', status: 'interrupted', canReload: true })
    expect(w.text()).toContain('This reply stopped updating.')
    expect(w.text()).toContain('It may still be running. Reload the chat to see where it is.')
    expect(w.text()).not.toContain('resync did not converge')
    const buttons = w.findAll('button')
    expect(buttons.map((b) => b.text())).toEqual(['Reload chat'])
    await buttons[0].trigger('click')
    expect(w.emitted('reload')).toHaveLength(1)
    expect(w.emitted('retry')).toBeUndefined()
  })

  it('has user copy for a lost connection with no code, and Reload only where the parent can reload', () => {
    const copy = errorCopy('transport', 'HTTP 400', 'interrupted')
    expect(copy).toMatchObject({ title: 'The connection to this reply was lost.', reload: true })
    const w = mountError({ code: 'transport', message: 'HTTP 400', status: 'interrupted' })
    expect(w.text()).not.toContain('HTTP 400')
    expect(w.findAll('button').map((b) => b.text())).toEqual(['Retry'])
  })

  it('shows the staff hint below the copy', () => {
    const w = mountError({
      code: 'agent_not_configured',
      status: 'failed',
      hint: 'Set ANTHROPIC_API_KEY on the server, then restart the backend and the agent process.',
    })
    expect(w.text()).toContain("The AI agent isn't set up on this workspace.")
    expect(w.text()).toContain('Set ANTHROPIC_API_KEY on the server')
  })

  it('offers no Retry when the reply hit its cost limit', () => {
    const w = mountError({ code: 'run_cost_limit', message: 'This reply reached the $3.00 cost limit for one reply.' })
    expect(w.text()).toContain('This reply reached its cost limit and was stopped.')
    expect(w.find('button').exists()).toBe(false)
  })

  it('offers Retry when the AI service was overloaded', async () => {
    const w = mountError({ code: 'upstream_overloaded' })
    expect(w.text()).toContain('The AI service is overloaded right now.')
    await w.find('button').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('links a chat that is too long to a new chat instead of Retry', () => {
    const w = mountError({ code: 'context_too_long', websiteId: 7 })
    expect(w.find('button').exists()).toBe(false)
    const link = w.findAll('a').find((a) => a.text() === 'Start a new chat')
    expect(link.attributes('href')).toBe('/projects/7/agent')
  })

  it('follows run.failed retryable over the copy for a code it does not know', () => {
    const refused = mountError({ code: 'new_backend_code', message: 'Not this time.', retryable: false })
    expect(refused.text()).toContain('Not this time.')
    expect(refused.find('button').exists()).toBe(false)
    const unknownFlag = mountError({ code: 'new_backend_code', message: 'Not this time.' })
    expect(unknownFlag.find('button').exists()).toBe(true)
  })
})
