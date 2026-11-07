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
