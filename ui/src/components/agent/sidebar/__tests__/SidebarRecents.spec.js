import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAgentUiStore } from '@/stores/agentUi'

const fakeAgent = reactive({})
const mounted = []
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

const { default: SidebarRecents } = await import('../SidebarRecents.vue')

const Blank = defineComponent({ render: () => h('div') })

function resetAgent(overrides = {}) {
  Object.assign(fakeAgent, {
    websiteId: 'w1',
    chats: { loading: false, loaded: true, hasMore: false, search: '', error: null },
    recents: [],
    loadChats: vi.fn(async () => {}),
    renameChat: vi.fn(async () => {}),
    deleteChat: vi.fn(async () => {}),
    ...overrides,
  })
}

async function setup(path = '/projects/w1/agent') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(SidebarRecents, {
    props: { websiteId: 'w1' },
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  return { wrapper, router, ui: useAgentUiStore() }
}

const chat = (id, extra = {}) => ({ id, title: `Chat ${id}`, running: false, unseen: false, ...extra })

beforeEach(() => {
  localStorage.clear()
  resetAgent()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('SidebarRecents', () => {
  it('says so when there are no chats', async () => {
    const { wrapper } = await setup()
    expect(wrapper.text()).toContain('No chats yet.')
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it('shows a loading line until the first page arrives, without fake rows', async () => {
    resetAgent({ chats: { loading: true, loaded: false, hasMore: false, search: '', error: null } })
    const { wrapper } = await setup()
    expect(wrapper.text()).toContain('Loading chats')
    expect(wrapper.findAll('li')).toHaveLength(0)
  })

  it('lists chats with the open one current, running and unseen states', async () => {
    resetAgent({
      recents: [chat('c1'), chat('c2', { running: true }), chat('c3', { unseen: true }), chat('c4', { title: '' })],
    })
    const { wrapper } = await setup('/projects/w1/agent/c/c1')
    const links = wrapper.findAll('a.ag-rc-link')
    expect(links.map((a) => a.find('.ag-rc-title').text())).toEqual(['Chat c1', 'Chat c2', 'Chat c3', 'New chat'])
    expect(links[0].attributes('aria-current')).toBe('page')
    expect(links[0].attributes('href')).toBe('/projects/w1/agent/c/c1')
    expect(links[1].attributes('aria-current')).toBeUndefined()
    expect(links[1].find('.ag-spinner').exists()).toBe(true)
    expect(links[1].text()).toContain('(agent working)')
    expect(links[2].find('.ag-rc-dot').exists()).toBe(true)
    expect(links[2].text()).toContain('(new reply)')
  })

  it('pages with Show more', async () => {
    resetAgent({ recents: [chat('c1')], chats: { loading: false, loaded: true, hasMore: true, search: '', error: null } })
    const { wrapper } = await setup()
    await wrapper.find('.ag-recents-more').trigger('click')
    expect(fakeAgent.loadChats).toHaveBeenCalledWith({ more: true })
  })

  it('searches through the filter field after a pause', async () => {
    vi.useFakeTimers()
    resetAgent({ recents: [chat('c1')] })
    const { wrapper, ui } = await setup()
    await wrapper.find('button[aria-label="Search chats"]').trigger('click')
    expect(ui.filterOpen).toBe(true)
    const input = wrapper.find('input[type="search"]')
    await input.setValue('pricing')
    expect(fakeAgent.loadChats).not.toHaveBeenCalled()
    vi.advanceTimersByTime(260)
    expect(fakeAgent.loadChats).toHaveBeenCalledWith({ q: 'pricing' })
  })

  it('takes a search requested before it mounted (the drawer opened by Ctrl+K)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const ui = useAgentUiStore()
    ui.openSearch()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank }],
    })
    await router.push('/projects/w1/agent')
    await router.isReady()
    const options = { props: { websiteId: 'w1' }, global: { plugins: [pinia, router] }, attachTo: document.body }
    const wrapper = mount(SidebarRecents, options)
    mounted.push(wrapper)
    expect(document.activeElement).toBe(wrapper.find('input[type="search"]').element)

    // A later mount (the drawer opened again without Ctrl+K) leaves focus alone.
    mounted.pop().unmount()
    document.body.focus()
    const again = mount(SidebarRecents, options)
    mounted.push(again)
    expect(document.activeElement).not.toBe(again.find('input[type="search"]').element)
  })

  it('reports an empty search honestly', async () => {
    resetAgent({ chats: { loading: false, loaded: true, hasMore: false, search: 'pricing', error: null } })
    const { wrapper } = await setup()
    expect(wrapper.text()).toContain('No chats match "pricing".')
  })

  it('shows a load error with a retry and does not loop', async () => {
    resetAgent({
      recents: [],
      chats: { loading: false, loaded: false, hasMore: false, search: '', error: { name: 'AgentError', message: 'The agent is turned off for this workspace.' } },
    })
    const { wrapper } = await setup()
    expect(fakeAgent.loadChats).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('The agent is turned off for this workspace.')
    await wrapper.find('.ag-recents-link').trigger('click')
    expect(fakeAgent.loadChats).toHaveBeenCalledTimes(1)
  })

  it('loads the first page when the store is scoped but has not loaded', async () => {
    resetAgent({ chats: { loading: false, loaded: false, hasMore: false, search: '', error: null } })
    await setup()
    expect(fakeAgent.loadChats).toHaveBeenCalledTimes(1)
  })

  it('collapses the list from the header', async () => {
    resetAgent({ recents: [chat('c1')] })
    const { wrapper, ui } = await setup()
    const toggle = wrapper.find('.ag-recents-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    await toggle.trigger('click')
    expect(ui.recentsCollapsed).toBe(true)
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('#ag-recents-list').attributes('style')).toContain('display: none')
  })

  it('renames inline from the row menu', async () => {
    resetAgent({ recents: [chat('c1')] })
    const { wrapper } = await setup()
    await wrapper.find('button[aria-label="Options for Chat c1"]').trigger('click')
    await flushPromises()
    const rename = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Rename'))
    rename.click()
    await flushPromises()
    await nextTick()
    const input = wrapper.find('input.ag-rc-input')
    expect(input.exists()).toBe(true)
    await input.setValue('Pricing research')
    await input.trigger('keydown', { key: 'Enter' })
    expect(fakeAgent.renameChat).toHaveBeenCalledWith('c1', 'Pricing research')
  })

  it('deletes after confirmation and leaves the deleted chat', async () => {
    resetAgent({ recents: [chat('c1'), chat('c2')] })
    const { wrapper, router } = await setup('/projects/w1/agent/c/c1')
    await wrapper.find('button[aria-label="Options for Chat c1"]').trigger('click')
    await flushPromises()
    const del = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Delete'))
    del.click()
    await flushPromises()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('This permanently deletes "Chat c1"')
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete')
    confirm.click()
    await flushPromises()
    expect(fakeAgent.deleteChat).toHaveBeenCalledWith('c1')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('agent-home'))
  })

  it('keeps the dialog open with the error when delete fails', async () => {
    resetAgent({
      recents: [chat('c1')],
      deleteChat: vi.fn(async () => {
        throw Object.assign(new Error('Nope'), { name: 'AgentError', message: 'Our servers are busy.' })
      }),
    })
    const { wrapper } = await setup()
    await wrapper.find('button[aria-label="Options for Chat c1"]').trigger('click')
    await flushPromises()
    ;[...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Delete')).click()
    await flushPromises()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    ;[...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete').click()
    await flushPromises()
    expect(document.body.querySelector('[role="alertdialog"]').textContent).toContain('Our servers are busy.')
  })
})
