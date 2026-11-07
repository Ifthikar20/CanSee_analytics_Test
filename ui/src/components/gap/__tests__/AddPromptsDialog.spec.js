import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
const ask = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))

vi.mock('@/api/client', () => ({ default: client }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('@/lib/agent/askAgent', () => ask)

const { default: AddPromptsDialog } = await import('../AddPromptsDialog.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []
const body = () => new DOMWrapper(document.body)
const button = (label) => body().findAll('button').find((b) => b.text() === label)

async function render(props = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/billing', name: 'billing', component: Blank },
    ],
  })
  await router.push('/')
  const wrapper = mount(AddPromptsDialog, {
    props: { websiteId: 'w1', open: true, ...props },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

async function type(text) {
  await body().find('textarea').setValue(text)
}

beforeEach(() => {
  client.post.mockReset()
  client.post.mockResolvedValue({ data: { created_count: 1, scan_audit_id: 'a1' } })
  ask.askAgent.mockClear()
  Object.values(toast).forEach((fn) => fn.mockClear())
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AddPromptsDialog', () => {
  it('explains what a prompt is', async () => {
    await render()
    expect(body().find('.bm-title').text()).toBe('Add prompts')
    expect(body().find('.bm-subtitle').text()).toBe(
      'Prompts are the questions your buyers ask Google or an AI assistant, one per line. Cansee checks where Google ranks you for each one and asks each AI engine the same question, then tracks the answers. Leave your brand name out: a prompt measures whether AI brings you up on its own.',
    )
    expect(body().find('textarea').attributes('placeholder')).toBe(
      'One question per line, for example: best note taking app for small teams',
    )
  })

  it('says what adding costs now, for the engines configured', async () => {
    await render({ engineCount: 2 })
    expect(body().find('.apd-cost').exists()).toBe(false)
    await type('best crm for a small team')
    expect(body().find('.apd-cost').text()).toBe(
      'Adding 1 prompt asks 2 AI answers now (2 engines), charged to your AI allowance. Google is checked when you choose Check Google, and nothing runs again unless you set a schedule.',
    )
    await type('best crm\ncrm for startups\ncrm with gmail')
    expect(body().find('.apd-cost').text()).toContain('Adding 3 prompts asks 6 AI answers now (2 engines)')
  })

  it('reads one engine in the singular, and says so when none is configured or the count is unknown', async () => {
    const one = await render({ engineCount: 1 })
    await type('best crm')
    expect(body().find('.apd-cost').text()).toContain('Adding 1 prompt asks 1 AI answer now (1 engine)')
    one.wrapper.unmount()
    mounted.pop()

    await render({ engineCount: 0 })
    expect(body().find('.apd-cost').text()).toBe("AI engines aren't available yet.")
    mounted.pop().unmount()

    await render()
    expect(body().find('.apd-cost').text()).toBe(
      'Adding prompts asks each connected AI engine now, charged to your AI allowance.',
    )
  })

  it('adds buyer questions straight away', async () => {
    const { wrapper } = await render({ engineCount: 2 })
    await type('best crm for a small team\nbest crm for a small team')
    await button('Add 1 prompt').trigger('click')
    await flushPromises()
    expect(client.post).toHaveBeenCalledWith(
      '/prompt-library/websites/w1/prompts/',
      { text: 'best crm for a small team', location: 'us' },
      { _silentError: true },
    )
    expect(toast.success).toHaveBeenCalledWith('Added 1 prompt. The AI engines are being asked now.')
    expect(wrapper.emitted('added')).toHaveLength(1)
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('points a request about your own data to the agent, and saves nothing', async () => {
    const { wrapper, router } = await render({ engineCount: 2 })
    await type('show me how the app is doing')
    await button('Add 1 prompt').trigger('click')
    await flushPromises()
    expect(client.post).not.toHaveBeenCalled()
    const notice = body().find('.apd-notice')
    expect(notice.find('.apd-notice-title').text()).toBe('This looks like a request for the agent.')
    expect(notice.find('.apd-notice-body').text()).toBe(
      'Prompts are questions buyers ask, such as "best CRM for a small team". Cansee asks them to every AI engine and tracks the answers. To ask about your own data, ask the agent.',
    )
    // The notice's buttons decide; the footer's Add steps aside.
    expect(button('Add 1 prompt')).toBeUndefined()

    await button('Ask the agent').trigger('click')
    await flushPromises()
    expect(ask.askAgent).toHaveBeenCalledWith(router, { websiteId: 'w1', from: 'prompts', text: 'show me how the app is doing' })
    expect(client.post).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('tracks a request anyway when asked', async () => {
    await render({ engineCount: 2 })
    await type('how is my traffic\nshow me our visibility')
    await button('Add 2 prompts').trigger('click')
    await button('Track as prompts anyway').trigger('click')
    await flushPromises()
    expect(client.post.mock.calls[0][1].text).toBe('how is my traffic\nshow me our visibility')
  })

  it('holds back the requests among questions, unless Add all', async () => {
    await render({ engineCount: 2 })
    const lines = ['best crm', 'how is my site doing', 'crm for startups', 'show me our traffic', 'check my ranking', 'what is my visibility']
    await type(lines.join('\n'))
    await button('Add 6 prompts').trigger('click')
    const notice = body().find('.apd-notice')
    expect(notice.find('.apd-notice-title').text()).toBe('4 of these look like requests, not buyer questions.')
    expect(notice.findAll('.apd-notice-lines li').map((li) => li.text())).toEqual([
      'how is my site doing',
      'show me our traffic',
      'check my ranking',
    ])
    expect(notice.find('.apd-notice-more').text()).toBe('and 1 more')
    expect(notice.find('.apd-notice-body').text()).toBe("They won't be tracked unless you choose Add all.")
    expect(button('Add all 6')).toBeTruthy()

    await button('Add 2 questions').trigger('click')
    await flushPromises()
    expect(client.post.mock.calls[0][1].text).toBe('best crm\ncrm for startups')
  })

  it('names a single request in the singular and adds everything with Add all', async () => {
    await render({ engineCount: 2 })
    await type('best crm\nhow is my site doing')
    await button('Add 2 prompts').trigger('click')
    expect(body().find('.apd-notice-title').text()).toBe('1 of these looks like a request, not a buyer question.')
    expect(button('Add 1 question')).toBeTruthy()
    await button('Add all 2').trigger('click')
    await flushPromises()
    expect(client.post.mock.calls[0][1].text).toBe('best crm\nhow is my site doing')
  })

  it('gives focus back to what opened it once it closes', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Blank }] })
    await router.push('/')
    const Host = defineComponent({
      setup() {
        const open = ref(false)
        return () => [
          h('button', { type: 'button', class: 'host-open', onClick: () => (open.value = true) }, 'Add prompts'),
          h(AddPromptsDialog, { websiteId: 'w1', engineCount: 2, open: open.value, 'onUpdate:open': (v) => (open.value = v) }),
        ]
      },
    })
    const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
    mounted.push(wrapper)
    const opener = wrapper.find('button.host-open')

    opener.element.focus()
    await opener.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(body().find('textarea').element)
    await button('Cancel').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(opener.element)

    // After an Add too.
    opener.element.focus()
    await opener.trigger('click')
    await flushPromises()
    await type('best crm for a small team')
    await button('Add 1 prompt').trigger('click')
    await flushPromises()
    expect(body().find('textarea').exists()).toBe(false)
    expect(document.activeElement).toBe(opener.element)
  })

  it('says the plan is full when the server refuses past the cap, and adds nothing', async () => {
    const { wrapper, router } = await render({ engineCount: 2 })
    const message = 'Your plan tracks up to 5 prompts and 5 are tracked. Archive some or choose the 100 or 200 prompt plan.'
    client.post.mockRejectedValue({
      response: { status: 403, data: { error: { code: 'tracked_prompt_limit', message, details: { limit: 5, used: 5, adding: 2 } } } },
      displayMessage: message,
    })
    await type('best crm\ncrm for startups')
    await button('Add 2 prompts').trigger('click')
    await flushPromises()

    const notice = body().find('.apd-notice')
    expect(notice.attributes('role')).toBe('alert')
    expect(notice.find('.apd-notice-title').text()).toBe('Your plan is full.')
    expect(notice.find('.apd-notice-body').text()).toBe(message)
    const link = notice.find('a')
    expect(link.text()).toBe('See plans')
    expect(link.attributes('href')).toBe('/billing')
    // Nothing was added: the text stays, the dialog stays open, no toast.
    expect(body().find('textarea').element.value).toBe('best crm\ncrm for startups')
    expect(wrapper.emitted('added')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    expect(toast.success).not.toHaveBeenCalled()
    expect(body().find('.apd-error').exists()).toBe(false)

    await link.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('billing')
  })

  it('drops the plan notice once the text changes', async () => {
    await render({ engineCount: 2 })
    client.post.mockRejectedValue({
      response: { status: 403, data: { error: { code: 'tracked_prompt_limit', message: 'Your plan tracks up to 5 prompts and 5 are tracked.' } } },
    })
    await type('best crm')
    await button('Add 1 prompt').trigger('click')
    await flushPromises()
    expect(body().find('.apd-notice-title').text()).toBe('Your plan is full.')
    await type('best crm for startups')
    expect(body().find('.apd-notice').exists()).toBe(false)
  })

  it('drops the notice once the text changes', async () => {
    await render({ engineCount: 2 })
    await type('how is my site doing')
    await button('Add 1 prompt').trigger('click')
    expect(body().find('.apd-notice').exists()).toBe(true)
    await type('best crm')
    expect(body().find('.apd-notice').exists()).toBe(false)
    expect(button('Add 1 prompt')).toBeTruthy()
  })
})
