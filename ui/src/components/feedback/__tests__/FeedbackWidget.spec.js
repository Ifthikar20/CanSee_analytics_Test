import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useHelpStore } from '@/stores/help'

// The ticket service is stand-alone; only its HTTP calls are faked. Token
// and read-state storage are the real ones.
const api = vi.hoisted(() => ({
  summaries: vi.fn(),
  createTicket: vi.fn(),
  getTicket: vi.fn(),
  reply: vi.fn(),
}))
vi.mock('@/api/feedbackClient', async (importOriginal) => ({ ...(await importOriginal()), default: api }))

const { default: FeedbackWidget } = await import('../FeedbackWidget.vue')
const { loadTokens, rememberToken } = await import('@/api/feedbackClient')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

const summary = (id, token, extra = {}) => ({
  id,
  token,
  category: 'help',
  status: 'open',
  last_message_preview: `Ticket ${id}`,
  last_message_author: 'agent',
  message_count: 2,
  updated_at: '2026-11-01T10:00:00Z',
  ...extra,
})

async function setup(user = { id: 7, email: 'farah@wrenfield.test', full_name: 'Farah Chen' }) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.user = user
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Blank }] })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(FeedbackWidget, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, auth, help: useHelpStore() }
}

const card = () => document.body.querySelector('.fw-card')
const trigger = (wrapper) => wrapper.get('button[title="Help & feedback"]')

beforeEach(() => {
  localStorage.clear()
  Object.values(api).forEach((fn) => fn.mockReset())
  api.summaries.mockImplementation(async (tokens) => ({
    tickets: tokens.map((t, i) => summary(`k-${t}`, t, { message_count: 2 + i })),
  }))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('FeedbackWidget tickets', () => {
  it("never shows or sends another account's tickets", async () => {
    // What the old build left: one shared list for everyone on this browser.
    localStorage.setItem('cs-feedback-tokens', JSON.stringify(['old-shared']))
    rememberToken(7, 'farah-1')
    const { wrapper } = await setup({ id: 8, email: 'sam@acme.test', full_name: 'Sam Lee' })
    expect(api.summaries).not.toHaveBeenCalled()
    expect(trigger(wrapper).attributes('aria-label')).toBe('Help & feedback')

    await trigger(wrapper).trigger('click')
    await flushPromises()
    expect(card().textContent).not.toContain('Your requests')

    api.createTicket.mockResolvedValue({
      token: 'sam-1',
      ticket: { id: 's1', category: 'help', status: 'open', messages: [{ id: 'm1', author: 'user', body: 'Hi', created_at: '2026-11-01T10:00:00Z' }] },
    })
    ;[...card().querySelectorAll('button')].find((b) => b.textContent.includes('Help request')).click()
    await nextTick()
    const area = card().querySelector('textarea')
    area.value = 'Where is my report?'
    area.dispatchEvent(new Event('input'))
    await nextTick()
    ;[...card().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send message').click()
    await flushPromises()

    expect(api.createTicket).toHaveBeenCalledTimes(1)
    expect(api.createTicket.mock.calls[0][0]).toMatchObject({ tokens: [], email: 'sam@acme.test' })
    expect(loadTokens(8)).toEqual(['sam-1'])
    expect(loadTokens(7)).toEqual(['farah-1'])
  })

  it("lists the signed-in user's tickets and drops them when another account signs in", async () => {
    rememberToken(7, 'farah-1')
    rememberToken(8, 'sam-1')
    const { wrapper, auth } = await setup()
    expect(api.summaries).toHaveBeenLastCalledWith(['farah-1'])
    // One unread reply from Support.
    expect(trigger(wrapper).attributes('aria-label')).toBe('Help & feedback, 1 unread reply')

    await trigger(wrapper).trigger('click')
    await flushPromises()
    expect(card().textContent).toContain('Ticket k-farah-1')

    auth.user = { id: 8, email: 'sam@acme.test' }
    await flushPromises()
    expect(card()).toBeNull()
    expect(api.summaries).toHaveBeenLastCalledWith(['sam-1'])
    await trigger(wrapper).trigger('click')
    await flushPromises()
    expect(card().textContent).toContain('Ticket k-sam-1')
    expect(card().textContent).not.toContain('Ticket k-farah-1')
  })
})

describe('FeedbackWidget dialog', () => {
  it('is a labelled modal dialog that Escape closes, handing focus back', async () => {
    const { wrapper } = await setup()
    const button = trigger(wrapper)
    expect(button.attributes('aria-haspopup')).toBe('dialog')
    button.element.focus()
    await button.trigger('click')
    await flushPromises()

    const dialog = card()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Help & feedback')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')).textContent).toContain('Ask for help')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(dialog.querySelector('[aria-label="Close"]')).not.toBeNull()
    expect(button.attributes('aria-expanded')).toBe('true')

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(card()).toBeNull()
    expect(document.activeElement).toBe(button.element)
  })

  it('labels the back button and the message field', async () => {
    const { wrapper } = await setup()
    await trigger(wrapper).trigger('click')
    await flushPromises()
    ;[...card().querySelectorAll('button')].find((b) => b.textContent.includes('Bug report')).click()
    await flushPromises()
    const area = card().querySelector('textarea')
    const label = document.querySelector(`label[for="${area.id}"]`)
    expect(label.textContent.trim()).toBe('What went wrong?')
    expect(document.getElementById(card().getAttribute('aria-labelledby')).textContent).toBe('Bug report')
    const back = card().querySelector('[aria-label="Back to Help & feedback"]')
    back.click()
    await flushPromises()
    expect(document.getElementById(card().getAttribute('aria-labelledby')).textContent).toBe('Help & feedback')
  })

  it('lets the help drawer open it, and unregisters on unmount', async () => {
    const { wrapper, help } = await setup()
    expect(typeof help.feedbackOpener).toBe('function')
    help.feedbackOpener()
    await flushPromises()
    expect(card()).not.toBeNull()
    mounted.pop()
    wrapper.unmount()
    expect(help.feedbackOpener).toBeNull()
  })
})
