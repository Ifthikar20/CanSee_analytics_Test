import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAgentUiStore } from '@/stores/agentUi'

// The findings store (FE-platform) is mocked with its frozen API.
const fakeFindings = reactive({})
vi.mock('@/stores/agentFindings', () => ({ useAgentFindingsStore: () => fakeFindings }))

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: AgentFindingsPage } = await import('../AgentFindingsPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

const HOURS_AGO = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString()

function swarmFinding(overrides = {}) {
  return {
    id: 'f1',
    title: 'Not named by ChatGPT for “best note taking app for teams”',
    detail: 'Google ranks you #4, but ChatGPT lists Evernote, OneNote and Obsidian.',
    category: 'engines',
    category_label: 'AI engines (GEO)',
    severity: 'high',
    status: 'open',
    prompt_text: 'best note taking app for teams',
    evidence: [
      { kind: 'serp', label: "Google page 1 · you're #4", tab_id: 'serp:3f2a9c1d0e7b', url: null },
      { kind: 'link', label: 'G2 category', tab_id: null, url: 'https://www.g2.com/categories/note-taking' },
      { kind: 'answer', label: 'ChatGPT answer', tab_id: null, url: null },
    ],
    source: {
      swarm_id: 's1',
      swarm_title: 'Research Notion',
      version: 1,
      sheet: 'prompts',
      row_key: 'p1',
      task_ids: ['engines.p1.chatgpt'],
      chat_id: 'c1',
      message_id: 'm1',
    },
    created_at: HOURS_AGO(2),
    updated_at: HOURS_AGO(2),
    created_by_name: 'Site Owner',
    status_changed_at: null,
    status_changed_by_name: '',
    ...overrides,
  }
}

function manualFinding(overrides = {}) {
  return {
    id: 'f2',
    title: 'Pricing page has no FAQ',
    detail: '',
    category: 'other',
    category_label: 'Other',
    severity: 'low',
    status: 'open',
    prompt_text: '',
    evidence: [],
    source: null,
    created_at: HOURS_AGO(30),
    updated_at: HOURS_AGO(30),
    created_by_name: 'Sam',
    status_changed_at: null,
    status_changed_by_name: '',
    ...overrides,
  }
}

function resetFindings(overrides = {}) {
  for (const key of Object.keys(fakeFindings)) delete fakeFindings[key]
  Object.assign(fakeFindings, {
    websiteId: 'w1',
    items: [],
    counts: { open: 0, done: 0, dismissed: 0 },
    canEdit: true,
    filters: { status: 'open', category: '', severity: '', q: '' },
    cursor: null,
    hasMore: false,
    loading: false,
    loaded: true,
    error: null,
    added: {},
    init: vi.fn((id) => {
      fakeFindings.websiteId = id
    }),
    load: vi.fn(async () => {}),
    setFilters: vi.fn(async (patch) => {
      fakeFindings.filters = { ...fakeFindings.filters, ...patch }
    }),
    create: vi.fn(async (fields) => ({ id: 'f9', status: 'open', ...fields })),
    // Like the store: a row whose status leaves the current tab leaves the list.
    setStatus: vi.fn(async (id, status) => {
      const tab = fakeFindings.filters.status
      fakeFindings.items = fakeFindings.items
        .map((f) => (f.id === id ? { ...f, status } : f))
        .filter((f) => tab === 'all' || f.status === tab)
    }),
    update: vi.fn(async (id, patch) => ({ id, ...patch })),
    remove: vi.fn(async (id) => {
      fakeFindings.items = fakeFindings.items.filter((f) => f.id !== id)
    }),
    ...overrides,
  })
}

async function setup(props = { websiteId: 'w1' }) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: Blank },
      { path: '/projects/:websiteId/agent/findings', name: 'agent-findings', component: Blank },
    ],
  })
  await router.push(`/projects/${props.websiteId}/agent/findings`)
  await router.isReady()
  const wrapper = mount(AgentFindingsPage, { props, global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router, ui: useAgentUiStore() }
}

const rowOf = (wrapper, id) => wrapper.find(`li.ag-fr[data-finding-id="${id}"]`)
const buttonByText = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.replace(/\s+/g, ' ').trim() === text)

function setInput(el, value) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function openRowMenu(wrapper, finding) {
  await wrapper.find(`button[aria-label="More actions for ${finding.title}"]`).trigger('click')
  await flushPromises()
  await nextTick()
}

function menuItem(text) {
  return [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes(text))
}

beforeEach(() => {
  resetFindings()
  Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('AgentFindingsPage', () => {
  it('loads the project on mount and again for another project', async () => {
    const { wrapper } = await setup()
    expect(fakeFindings.init).toHaveBeenCalledWith('w1')
    expect(fakeFindings.load).toHaveBeenCalledTimes(1)
    expect(fakeFindings.init.mock.invocationCallOrder[0]).toBeLessThan(fakeFindings.load.mock.invocationCallOrder[0])
    expect(wrapper.find('h1').text()).toBe('Findings')
    expect(wrapper.find('.ag-page-intro').text()).toBe(
      'Issues and opportunities the research agents found. Add them from a research table, then mark them done when they are fixed.',
    )

    await wrapper.setProps({ websiteId: 'w2' })
    await flushPromises()
    expect(fakeFindings.init).toHaveBeenLastCalledWith('w2')
    expect(fakeFindings.load).toHaveBeenCalledTimes(2)
  })

  it('shows the status tabs with their counts and switches between them', async () => {
    resetFindings({ counts: { open: 3, done: 1, dismissed: 0 }, items: [swarmFinding()] })
    const { wrapper } = await setup()
    const tabs = wrapper.findAll('.ag-fp-seg-item')
    expect(tabs.map((t) => t.find('span').text())).toEqual(['Open', 'Done', 'Dismissed', 'All'])
    expect(tabs.map((t) => t.find('.ag-fp-seg-count').exists() ? t.find('.ag-fp-seg-count').text() : null)).toEqual([
      '3',
      '1',
      '0',
      null,
    ])
    expect(tabs[0].attributes('aria-pressed')).toBe('true')
    expect(tabs[1].attributes('aria-pressed')).toBe('false')

    await tabs[1].trigger('click')
    expect(fakeFindings.setFilters).toHaveBeenCalledWith({ status: 'done' })
    await tabs[1].trigger('click')
    expect(fakeFindings.setFilters).toHaveBeenCalledTimes(1)
    await tabs[3].trigger('click')
    expect(fakeFindings.setFilters).toHaveBeenLastCalledWith({ status: 'all' })
  })

  it('filters by category and severity and searches after a pause', async () => {
    resetFindings({ items: [swarmFinding()] })
    const { wrapper } = await setup()
    const [category, severity] = wrapper.findAll('select.ag-fp-select-input')
    expect(category.attributes('aria-label')).toBe('Category')
    expect(category.findAll('option').map((o) => o.text())).toEqual([
      'All categories',
      'Google (SEO)',
      'AI engines (GEO)',
      'Competitor pages',
      'Your site and content gaps',
      'Sources and citations',
      'Other',
    ])
    expect(severity.findAll('option').map((o) => o.text())).toEqual(['All severities', 'High', 'Medium', 'Low'])

    await category.setValue('engines')
    expect(fakeFindings.setFilters).toHaveBeenLastCalledWith({ category: 'engines' })
    await severity.setValue('high')
    expect(fakeFindings.setFilters).toHaveBeenLastCalledWith({ severity: 'high' })

    vi.useFakeTimers()
    const search = wrapper.find('input[type="search"]')
    expect(search.attributes('placeholder')).toBe('Search findings')
    await search.setValue('g2')
    vi.advanceTimersByTime(300)
    expect(fakeFindings.setFilters).toHaveBeenLastCalledWith({ q: 'g2' })
  })

  it('lists findings with their severity and where they came from', async () => {
    resetFindings({ items: [swarmFinding(), manualFinding()] })
    const { wrapper } = await setup()
    const first = rowOf(wrapper, 'f1')
    expect(first.find('.ag-fr-title').text()).toContain('Not named by ChatGPT')
    expect(first.find('.ag-fr-sev').classes()).toContain('is-high')
    expect(first.find('.ag-fr-title .ag-sr-only').text()).toBe('High severity:')
    expect(first.find('.ag-fr-meta').text()).toBe(
      'AI engines (GEO) · “best note taking app for teams” · From Research Notion v1 · 2 hours ago',
    )
    const second = rowOf(wrapper, 'f2')
    expect(second.find('.ag-fr-sev').classes()).toContain('is-low')
    expect(second.find('.ag-fr-meta').text()).toBe('Other · yesterday')
  })

  it('expands a finding with its evidence and links back to the chat', async () => {
    resetFindings({ items: [swarmFinding()] })
    const { wrapper } = await setup()
    const title = rowOf(wrapper, 'f1').find('.ag-fr-title')
    expect(title.attributes('aria-expanded')).toBe('false')
    await title.trigger('click')
    expect(title.attributes('aria-expanded')).toBe('true')
    const body = wrapper.find(`#${title.attributes('aria-controls')}`)
    expect(body.exists()).toBe(true)
    expect(body.find('.ag-fr-detail').text()).toBe('Google ranks you #4, but ChatGPT lists Evernote, OneNote and Obsidian.')

    const items = body.findAll('.ag-fr-evidence-item')
    expect(items).toHaveLength(3)
    // A capture opens in the chat that made it.
    const open = items[0].find('a.ag-fr-open')
    expect(open.text()).toBe('Open in chat')
    expect(decodeURIComponent(open.attributes('href'))).toBe('/projects/w1/agent/c/c1?tab=serp:3f2a9c1d0e7b')
    // A link opens the web address in a new tab.
    const link = items[1].find('a.ag-fr-link')
    expect(link.attributes('href')).toBe('https://www.g2.com/categories/note-taking')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    // An engine answer is named, not linked.
    expect(items[2].find('a').exists()).toBe(false)
    expect(items[2].text()).toBe('ChatGPT answer')

    const source = body.find('.ag-fr-source')
    expect(source.find('span').text()).toBe('From “Research Notion”, version 1, Prompts sheet')
    expect(source.find('a').attributes('href')).toBe('/projects/w1/agent/c/c1')
    expect(body.find('.ag-fr-history').text()).toBe('Added 2 hours ago by Site Owner')

    await title.trigger('click')
    expect(wrapper.find('.ag-fr-body').exists()).toBe(false)
  })

  it('leaves out the chat links for someone who does not own the chat', async () => {
    const finding = swarmFinding({
      evidence: [
        { kind: 'serp', label: 'Google page 1', tab_id: 'serp:3f2a9c1d0e7b', url: null },
        { kind: 'page', label: 'evernote.com', tab_id: 'page:0a1b2c3d4e5f', url: 'https://evernote.com/' },
        { kind: 'link', label: 'Bad link', tab_id: null, url: 'javascript:alert(1)' },
      ],
      source: { ...swarmFinding().source, chat_id: null, message_id: null },
    })
    resetFindings({ items: [finding] })
    const { wrapper } = await setup()
    await rowOf(wrapper, 'f1').find('.ag-fr-title').trigger('click')
    const body = wrapper.find('.ag-fr-body')
    expect(body.find('a.ag-fr-open').exists()).toBe(false)
    expect(body.find('.ag-fr-source a').exists()).toBe(false)
    const items = body.findAll('.ag-fr-evidence-item')
    expect(items[0].find('a').exists()).toBe(false)
    // Without the chat, a page is still reachable at its own address.
    expect(items[1].find('a.ag-fr-link').attributes('href')).toBe('https://evernote.com/')
    // Only http(s) addresses become links.
    expect(items[2].find('a').exists()).toBe(false)
    expect(items[2].text()).toBe('Bad link')
  })

  it('renders finding text as text, never as markup', async () => {
    resetFindings({
      items: [swarmFinding({ title: '<img src=x onerror="window.__pwned=1">', detail: '<b>bold</b>' })],
    })
    const { wrapper } = await setup()
    await rowOf(wrapper, 'f1').find('.ag-fr-title').trigger('click')
    expect(wrapper.find('.ag-fr-title img').exists()).toBe(false)
    expect(wrapper.find('.ag-fr-title').text()).toContain('<img src=x onerror="window.__pwned=1">')
    expect(wrapper.find('.ag-fr-detail b').exists()).toBe(false)
    expect(window.__pwned).toBeUndefined()
  })

  it('marks a finding done, dismisses another and reopens from the Done tab', async () => {
    const one = swarmFinding()
    const two = manualFinding()
    resetFindings({ items: [one, two] })
    const { wrapper, ui } = await setup()
    const announce = vi.spyOn(ui, 'announce')

    await wrapper.find(`button[aria-label="Mark done: ${one.title}"]`).trigger('click')
    await flushPromises()
    expect(fakeFindings.setStatus).toHaveBeenCalledWith('f1', 'done')
    expect(announce).toHaveBeenCalledWith('Marked done')
    expect(rowOf(wrapper, 'f1').exists()).toBe(false)

    await wrapper.find(`button[aria-label="Dismiss: ${two.title}"]`).trigger('click')
    await flushPromises()
    expect(fakeFindings.setStatus).toHaveBeenLastCalledWith('f2', 'dismissed')

    resetFindings({ filters: { status: 'done', category: '', severity: '', q: '' }, items: [{ ...one, status: 'done' }] })
    await nextTick()
    const reopen = wrapper.find(`button[aria-label="Reopen: ${one.title}"]`)
    expect(wrapper.find(`button[aria-label="Mark done: ${one.title}"]`).exists()).toBe(false)
    await reopen.trigger('click')
    await flushPromises()
    expect(fakeFindings.setStatus).toHaveBeenLastCalledWith('f1', 'open')
  })

  it('acts on the checked rows from the bulk bar', async () => {
    const third = manualFinding({ id: 'f3', title: 'No comparison page' })
    resetFindings({ items: [swarmFinding(), manualFinding(), third] })
    const { wrapper } = await setup()
    expect(wrapper.find('.ag-fbb').exists()).toBe(false)

    await rowOf(wrapper, 'f1').find('input[type="checkbox"]').setValue(true)
    await rowOf(wrapper, 'f3').find('input[type="checkbox"]').setValue(true)
    const bar = wrapper.find('.ag-fbb')
    expect(bar.exists()).toBe(true)
    expect(bar.find('.ag-fbb-count').text()).toBe('2 selected')
    // Every checked row is open: nothing to reopen.
    expect(buttonByText(bar.element, 'Reopen')).toBeUndefined()

    buttonByText(bar.element, 'Mark done').click()
    await flushPromises()
    expect(fakeFindings.setStatus.mock.calls).toEqual([
      ['f1', 'done'],
      ['f3', 'done'],
    ])
    expect(toast.success).toHaveBeenCalledWith('Marked 2 findings done.')
    expect(wrapper.find('.ag-fbb').exists()).toBe(false)

    await rowOf(wrapper, 'f2').find('input[type="checkbox"]').setValue(true)
    buttonByText(wrapper.find('.ag-fbb').element, 'Clear').click()
    await nextTick()
    expect(wrapper.find('.ag-fbb').exists()).toBe(false)
    expect(rowOf(wrapper, 'f2').find('input[type="checkbox"]').element.checked).toBe(false)
  })

  it('keeps rows that failed checked and reports the failure', async () => {
    resetFindings({ items: [swarmFinding(), manualFinding()] })
    fakeFindings.setStatus = vi.fn(async (id) => {
      if (id === 'f2') throw Object.assign(new Error('x'), { name: 'AgentError', status: 500, message: 'Something broke.' })
      fakeFindings.items = fakeFindings.items.filter((f) => f.id !== id)
    })
    const { wrapper } = await setup()
    await rowOf(wrapper, 'f1').find('input[type="checkbox"]').setValue(true)
    await rowOf(wrapper, 'f2').find('input[type="checkbox"]').setValue(true)
    buttonByText(wrapper.find('.ag-fbb').element, 'Dismiss').click()
    await flushPromises()
    expect(toast.success).toHaveBeenCalledWith('Dismissed 1 finding.')
    expect(toast.error).toHaveBeenCalledWith('Something broke.')
    expect(wrapper.find('.ag-fbb-count').text()).toBe('1 selected')
  })

  it('creates a finding from the dialog', async () => {
    resetFindings({ items: [swarmFinding()] })
    const { wrapper } = await setup()
    const create = wrapper.findAll('button').find((b) => b.text() === 'New finding')
    await create.trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('New finding')
    expect(dialog.querySelector('#ag-fd-category').value).toBe('other')
    expect(dialog.querySelector('#ag-fd-severity').value).toBe('medium')

    // A title is required.
    buttonByText(dialog, 'Save').click()
    await flushPromises()
    expect(fakeFindings.create).not.toHaveBeenCalled()
    expect(dialog.querySelector('#ag-fd-title-err').textContent).toBe('Give the finding a title.')

    setInput(dialog.querySelector('#ag-fd-title'), '  Add a comparison page  ')
    setInput(dialog.querySelector('#ag-fd-detail'), 'Evernote has one; we do not.')
    const category = dialog.querySelector('#ag-fd-category')
    category.value = 'site'
    category.dispatchEvent(new Event('change'))
    const severity = dialog.querySelector('#ag-fd-severity')
    severity.value = 'high'
    severity.dispatchEvent(new Event('change'))
    setInput(dialog.querySelector('#ag-fd-prompt'), 'best note taking app for teams')
    await nextTick()
    buttonByText(dialog, 'Save').click()
    await flushPromises()
    expect(fakeFindings.create).toHaveBeenCalledWith({
      title: 'Add a comparison page',
      detail: 'Evernote has one; we do not.',
      category: 'site',
      severity: 'high',
      prompt_text: 'best note taking app for teams',
    })
    expect(toast.success).toHaveBeenCalledWith('Finding added.')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('edits only what the API can change, and shows a save error in the dialog', async () => {
    const finding = swarmFinding()
    resetFindings({ items: [finding] })
    fakeFindings.update = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AgentError', status: 400, message: 'Title is too long.' }))
      .mockResolvedValueOnce({})
    const { wrapper } = await setup()
    await openRowMenu(wrapper, finding)
    menuItem('Edit').click()
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog.textContent).toContain('Edit finding')
    expect(dialog.querySelector('#ag-fd-title').value).toBe(finding.title)
    expect(dialog.querySelector('#ag-fd-category').disabled).toBe(true)
    expect(dialog.querySelector('#ag-fd-prompt').disabled).toBe(true)
    expect(dialog.querySelector('#ag-fd-severity').value).toBe('high')

    setInput(dialog.querySelector('#ag-fd-title'), 'Not named by ChatGPT')
    await nextTick()
    buttonByText(dialog, 'Save').click()
    await flushPromises()
    expect(fakeFindings.update).toHaveBeenCalledWith('f1', {
      title: 'Not named by ChatGPT',
      detail: finding.detail,
      severity: 'high',
    })
    expect(document.body.querySelector('[role="dialog"]').textContent).toContain('Title is too long.')

    buttonByText(document.body.querySelector('[role="dialog"]'), 'Save').click()
    await flushPromises()
    expect(fakeFindings.update).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('deletes a finding after confirmation', async () => {
    const finding = swarmFinding()
    resetFindings({ items: [finding, manualFinding()] })
    const { wrapper } = await setup()
    await openRowMenu(wrapper, finding)
    menuItem('Delete').click()
    await flushPromises()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog.textContent).toContain('Delete this finding?')
    expect(dialog.textContent).toContain("This removes it for everyone in the project. It can't be undone.")
    buttonByText(dialog, 'Delete').click()
    await flushPromises()
    expect(fakeFindings.remove).toHaveBeenCalledWith('f1')
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(rowOf(wrapper, 'f1').exists()).toBe(false)
  })

  it.each([
    ['open', 'No open findings.', 'Run a research, then add findings from its results table.'],
    ['done', 'Nothing marked done yet.', ''],
    ['dismissed', 'Nothing dismissed.', ''],
  ])('shows an honest empty state for %s', async (status, title, body) => {
    resetFindings({ filters: { status, category: '', severity: '', q: '' } })
    const { wrapper } = await setup()
    const empty = wrapper.find('.ag-empty')
    expect(empty.find('.ag-empty-title').text()).toBe(title)
    if (body) expect(empty.find('.ag-empty-body').text()).toBe(body)
    else expect(empty.find('.ag-empty-body').exists()).toBe(false)
    const cta = empty.find('a')
    if (status === 'open') {
      expect(cta.text()).toBe('Research with the agent')
      expect(cta.attributes('href')).toBe('/projects/w1/agent?agent=gap_analyst')
    } else {
      expect(cta.exists()).toBe(false)
    }
  })

  it('offers to clear filters when nothing matches them', async () => {
    resetFindings({ filters: { status: 'open', category: 'engines', severity: '', q: 'g2' } })
    const { wrapper } = await setup()
    expect(wrapper.find('.ag-empty-title').text()).toBe('No findings match these filters.')
    expect(wrapper.find('input[type="search"]').element.value).toBe('g2')
    await wrapper.findAll('.ag-empty button').find((b) => b.text() === 'Clear filters').trigger('click')
    expect(fakeFindings.setFilters).toHaveBeenCalledWith({ category: '', severity: '', q: '' })
    expect(wrapper.find('input[type="search"]').element.value).toBe('')
  })

  it('shows the load error with a retry', async () => {
    resetFindings({
      loaded: false,
      error: Object.assign(new Error('x'), { name: 'AgentError', status: 503, message: 'The agent is temporarily unavailable.' }),
    })
    const { wrapper } = await setup()
    const empty = wrapper.find('.ag-empty')
    expect(empty.attributes('role')).toBe('alert')
    expect(empty.find('.ag-empty-title').text()).toBe('Findings could not be loaded.')
    expect(empty.find('.ag-empty-body').text()).toBe('The agent is temporarily unavailable.')
    await empty.findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    expect(fakeFindings.load).toHaveBeenCalledTimes(2)
  })

  it('shows a skeleton until the first page arrives', async () => {
    resetFindings({ loaded: false, loading: true })
    const { wrapper } = await setup()
    expect(wrapper.findAll('.ag-fp-skel-row')).toHaveLength(3)
    expect(wrapper.find('.ag-empty').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(true)
    expect(wrapper.findAll('button').some((b) => b.text() === 'New finding')).toBe(false)
  })

  it('hides every write action from viewers', async () => {
    resetFindings({ canEdit: false, items: [swarmFinding()] })
    const { wrapper } = await setup()
    expect(wrapper.find('.ag-fp-readonly').text()).toBe('You can view findings but not change them.')
    expect(wrapper.findAll('button').some((b) => b.text() === 'New finding')).toBe(false)
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    expect(wrapper.find('.ag-fr-actions').exists()).toBe(false)
    expect(rowOf(wrapper, 'f1').classes()).toContain('is-readonly')
    // Reading still works.
    await rowOf(wrapper, 'f1').find('.ag-fr-title').trigger('click')
    expect(wrapper.find('.ag-fr-body').exists()).toBe(true)
  })

  it('turns read-only when a change is refused with 403', async () => {
    const finding = swarmFinding()
    resetFindings({ items: [finding] })
    fakeFindings.setStatus = vi.fn(async () => {
      throw Object.assign(new Error('x'), { name: 'AgentError', status: 403, code: 'forbidden', message: "You don't have permission to do that." })
    })
    const { wrapper } = await setup()
    expect(wrapper.find('.ag-fp-readonly').exists()).toBe(false)
    await wrapper.find(`button[aria-label="Mark done: ${finding.title}"]`).trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith("You don't have permission to do that.")
    expect(wrapper.find('.ag-fp-readonly').text()).toBe('You can view findings but not change them.')
    expect(wrapper.find('.ag-fr-actions').exists()).toBe(false)
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
  })

  it('loads the next page with Show more', async () => {
    resetFindings({ items: [swarmFinding()], hasMore: true })
    const { wrapper } = await setup()
    await wrapper.find('.ag-fp-more button').trigger('click')
    expect(fakeFindings.load).toHaveBeenLastCalledWith({ more: true })
  })
})
