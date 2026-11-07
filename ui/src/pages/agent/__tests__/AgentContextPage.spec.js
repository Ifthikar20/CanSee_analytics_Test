import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { BUILD_OPTIONS, buildEstimate, buildRun, emptyOverview, entry, overview } from './__fixtures__/context'

const agentApi = vi.hoisted(() => ({
  getContext: vi.fn(),
  createContextEntry: vi.fn(),
  updateContextEntry: vi.fn(),
  deleteContextEntry: vi.fn(),
  reviewContextEntries: vi.fn(),
  addContextReference: vi.fn(),
  deleteContextReference: vi.fn(),
  getContextDocument: vi.fn(),
  createContextDocument: vi.fn(),
  updateContextDocument: vi.fn(),
  deleteContextDocument: vi.fn(),
  brandFacts: vi.fn(),
}))
vi.mock('@/api/agent', () => ({ default: agentApi }))

// The page's context_build runner (FE-shell's useInsightRun), as a fake
// with the same refs and actions.
const runner = vi.hoisted(() => ({ current: null, options: null }))
vi.mock('@/composables/analytics/useInsightRun', async () => {
  const { computed, ref, shallowRef } = await import('vue')
  return {
    isActiveInsightRun: (run) => Boolean(run && ['queued', 'running'].includes(run.status)),
    useInsightRun: (kind) => {
      const b = {
        kind,
        options: shallowRef(runner.options),
        run: shallowRef(null),
        stopping: ref(false),
        stopError: ref(''),
        isOpen: ref(false),
        params: shallowRef({}),
        estimate: shallowRef(null),
        estimating: ref(false),
        submitting: ref(false),
        error: ref(''),
        changedNote: ref(''),
      }
      b.canStart = computed(() => b.isOpen.value && Boolean(b.estimate.value?.can_run))
      b.open = vi.fn((params) => {
        b.params.value = { ...params }
        b.isOpen.value = true
      })
      b.close = vi.fn(() => {
        b.isOpen.value = false
      })
      b.setParams = vi.fn((params) => {
        b.params.value = { ...params }
      })
      b.start = vi.fn(async () => null)
      b.stop = vi.fn()
      b.track = vi.fn((run) => {
        b.run.value = run
      })
      b.dismiss = vi.fn(() => {
        b.run.value = null
      })
      runner.current = b
      return b
    },
  }
})

const { default: AgentContextPage } = await import('../AgentContextPage.vue')

const Blank = defineComponent({ render: () => h('div', { class: 'blank' }) })
const mounted = []
const ok = (data) => ({ success: true, data })

async function setup(payload = overview()) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().setWebsites([{ id: 'w1', name: 'Notion', url: 'https://www.notion.so' }])
  agentApi.getContext.mockImplementation(async () => ok(structuredClone(payload)))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent/context', name: 'agent-context', component: AgentContextPage, props: true },
      { path: '/projects/:websiteId/agent/reports', name: 'agent-reports', component: Blank },
      { path: '/settings/brand-facts', name: 'settings-brand-facts', component: Blank },
      { path: '/settings/project', name: 'settings-project', component: Blank },
    ],
  })
  await router.push('/projects/w1/agent/context')
  await router.isReady()
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

function button(root, text) {
  return root.findAll('button').find((b) => b.text().trim() === text)
}

function section(wrapper, key) {
  return wrapper.find(`#ctx-${key}`)
}

beforeEach(() => {
  localStorage.clear()
  runner.options = structuredClone(BUILD_OPTIONS)
  for (const fn of Object.values(agentApi)) fn.mockReset()
  agentApi.reviewContextEntries.mockResolvedValue(ok({ accepted: 1, dismissed: 0 }))
  agentApi.createContextEntry.mockImplementation(async (wid, body) => ok(entry({ id: 'e9', ...body })))
  agentApi.updateContextEntry.mockImplementation(async (wid, id, body) => ok(entry({ id, ...body })))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AgentContextPage', () => {
  it('lists the six sections with their counts and the links to brand facts and settings', async () => {
    const { wrapper } = await setup()
    expect(agentApi.getContext).toHaveBeenCalledWith('w1', { _silentError: true })
    expect(wrapper.find('.ag-page-intro').text()).toBe(
      'What the agents know about Notion, and where each piece comes from. Agents use active entries; suggestions wait for you.'
    )
    const cards = wrapper.findAll('.ag-csn-card')
    expect(cards.map((c) => c.find('.ag-csn-label').text())).toEqual([
      'Company',
      'Audience',
      'Competitors',
      'Offerings',
      'Strategy',
      'Execution',
    ])
    expect(cards[0].find('.ag-csn-count').text()).toBe('1 entry · 2 sources')
    expect(cards[0].find('.ag-csn-badge').text()).toBe('1 suggested')
    expect(cards[1].find('.ag-csn-count').text()).toBe('1 entry · 1 source')
    expect(cards[2].find('.ag-csn-count').text()).toBe('0 entries · 0 sources')
    expect(cards[3].find('.ag-csn-count').text()).toBe('3 entries · 5 sources')
    expect(cards[3].attributes('href')).toBe('#ctx-offerings')
    expect(section(wrapper, 'company').find('h2').text()).toBe('Company')
    expect(section(wrapper, 'company').text()).toContain(
      'Who you are: what you do, for whom, since when, and proof such as customers and awards.'
    )
    expect(wrapper.find('a[href="/settings/brand-facts"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/settings/project"]').exists()).toBe(true)
  })

  it('shows suggestions first with their origin and accepts them all', async () => {
    const { wrapper } = await setup()
    const cards = section(wrapper, 'company').findAll('.ag-cec')
    expect(cards[0].text()).toContain('Used by 4 million teams')
    expect(cards[0].text()).toContain('Suggested from your site 3 hours ago')
    expect(cards[1].text()).toContain('Founded in 2013')
    expect(cards[1].text()).toContain('Updated by Sam 3 hours ago')
    expect(section(wrapper, 'audience').text()).toContain('Moved from the earlier context')

    const banner = wrapper.find('.ag-ctx-banner')
    expect(banner.text()).toContain('1 suggestion waits for your review.')
    await button(banner, 'Accept all').trigger('click')
    await flushPromises()
    expect(agentApi.reviewContextEntries).toHaveBeenCalledWith('w1', { accept: ['e2'], dismiss: [] })
    // The overview is read again for the new counts.
    expect(agentApi.getContext).toHaveBeenCalledTimes(2)
  })

  it('accepts and dismisses one suggestion', async () => {
    const { wrapper } = await setup()
    const suggestion = section(wrapper, 'company').findAll('.ag-cec')[0]
    await button(suggestion, 'Dismiss').trigger('click')
    await flushPromises()
    expect(agentApi.reviewContextEntries).toHaveBeenLastCalledWith('w1', { accept: [], dismiss: ['e2'] })
    await button(section(wrapper, 'company').findAll('.ag-cec')[0], 'Accept').trigger('click')
    await flushPromises()
    expect(agentApi.reviewContextEntries).toHaveBeenLastCalledWith('w1', { accept: ['e2'], dismiss: [] })
  })

  it('shows each source with its path, link, quote and state', async () => {
    const { wrapper } = await setup()
    const card = section(wrapper, 'company').findAll('.ag-cec')[1]
    const chips = card.findAll('.ag-ref')
    expect(chips).toHaveLength(2)
    const link = chips[0].find('a')
    expect(link.text()).toContain('/about')
    expect(link.attributes('href')).toBe('https://notion.so/about')
    expect(chips[0].text()).not.toContain('Changed since it was read')
    expect(chips[1].text()).toContain('/pricing')
    expect(chips[1].text()).toContain('Changed since it was read')
  })

  it('adds an entry with its sources in one request', async () => {
    const { wrapper } = await setup()
    await button(section(wrapper, 'strategy'), 'Add entry').trigger('click')
    await flushPromises()
    const form = section(wrapper, 'strategy').find('form.ag-cef')
    expect(form.exists()).toBe(true)
    await form.find('input[type="text"]').setValue('Win "best wiki for startups"')
    await form.find('textarea').setValue('Our target question this quarter.')
    expect(form.text()).toContain('33 of 4,000')
    await form.trigger('submit')
    await flushPromises()
    expect(agentApi.createContextEntry).toHaveBeenCalledWith(
      'w1',
      { section: 'strategy', title: 'Win "best wiki for startups"', body: 'Our target question this quarter.', references: [] }
    )
    expect(section(wrapper, 'strategy').find('form.ag-cef').exists()).toBe(false)
  })

  it('asks for a title or text before saving', async () => {
    const { wrapper } = await setup()
    await button(section(wrapper, 'strategy'), 'Add entry').trigger('click')
    await flushPromises()
    await section(wrapper, 'strategy').find('form.ag-cef').trigger('submit')
    await flushPromises()
    expect(agentApi.createContextEntry).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Write a title or a text.')
  })

  it('edits an entry with its revision and offers a reload on a conflict', async () => {
    const { wrapper } = await setup()
    const card = section(wrapper, 'audience').find('.ag-cec')
    await card.find('button[aria-label="More actions for Audience"]').trigger('click')
    await flushPromises()
    const edit = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Edit'))
    edit.click()
    await flushPromises()
    const form = section(wrapper, 'audience').find('form.ag-cef')
    await form.find('textarea').setValue('Operations leads at growing companies')
    agentApi.updateContextEntry.mockRejectedValueOnce({
      response: { status: 409, data: { error: { code: 'revision_conflict', message: 'Stale.', details: { revision: 3 } } } },
    })
    await form.trigger('submit')
    await flushPromises()
    expect(agentApi.updateContextEntry).toHaveBeenCalledWith(
      'w1',
      'e3',
      { revision: 1, body: 'Operations leads at growing companies' }
    )
    const banner = section(wrapper, 'audience').find('.ag-cef-banner')
    expect(banner.text()).toContain('Someone else changed this entry. Reload to see their version.')
    // The edits stay until the person reloads.
    expect(agentApi.getContext).toHaveBeenCalledTimes(1)
    await button(banner, 'Reload').trigger('click')
    await flushPromises()
    expect(agentApi.getContext).toHaveBeenCalledTimes(2)
    expect(section(wrapper, 'audience').find('form.ag-cef').exists()).toBe(false)
  })

  it('deletes an entry after confirming', async () => {
    agentApi.deleteContextEntry.mockResolvedValue({ data: null })
    const { wrapper } = await setup()
    const card = section(wrapper, 'audience').find('.ag-cec')
    await card.find('button[aria-label="More actions for Audience"]').trigger('click')
    await flushPromises()
    ;[...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Delete')).click()
    await flushPromises()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog.textContent).toContain('Delete this entry?')
    expect(dialog.textContent).toContain('The agents stop using it.')
    ;[...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete').click()
    await flushPromises()
    expect(agentApi.deleteContextEntry).toHaveBeenCalledWith('w1', 'e3', 1)
  })

  it('lists documents with their size and citations', async () => {
    const { wrapper } = await setup()
    const docs = wrapper.find('#ctx-documents')
    expect(docs.text()).toContain('Text you add for the agents: positioning notes, product sheets, style guides. Up to 30.')
    expect(docs.text()).toContain('Positioning notes')
    expect(docs.text()).toContain('5,200 characters · Cited by 2 entries')
  })

  it('is read-only for viewers', async () => {
    const { wrapper } = await setup(overview({ can_edit: false }))
    expect(wrapper.text()).toContain('You can read this context. Editing needs member access.')
    expect(button(wrapper, 'Add entry')).toBeUndefined()
    expect(button(wrapper, 'Build from my site')).toBeUndefined()
    // The suggestions still show, without the controls.
    expect(wrapper.find('.ag-ctx-banner').text()).toBe('1 suggestion waits for your review.')
    expect(button(wrapper, 'Accept all')).toBeUndefined()
    expect(wrapper.findAll('button[aria-label^="More actions"]')).toHaveLength(0)
  })

  it('says when there is no context yet', async () => {
    const { wrapper } = await setup(emptyOverview())
    const empty = wrapper.find('.ag-empty')
    expect(empty.text()).toContain('No context yet.')
    expect(empty.text()).toContain(
      'Build it from your site: Cansee reads up to 8 pages and suggests entries with their sources. You see the cost first.'
    )
    expect(button(empty, 'Build from my site')).toBeTruthy()
    await button(empty, 'Add an entry').trigger('click')
    await flushPromises()
    expect(section(wrapper, 'company').find('form.ag-cef').exists()).toBe(true)
  })

  it('shows a load error with a retry', async () => {
    const { wrapper } = await setup()
    agentApi.getContext.mockReset()
    agentApi.getContext.mockRejectedValueOnce({ response: { status: 503, data: { error: { message: 'The agent is turned off.' } } } })
    const { wrapper: failed } = await setup()
    wrapper.unmount()
    mounted.shift()
    expect(failed.text()).toContain("Couldn't load the context.")
    expect(failed.text()).toContain('The agent is turned off.')
    agentApi.getContext.mockResolvedValueOnce(ok(overview()))
    await failed.find('.ag-empty button').trigger('click')
    await flushPromises()
    expect(failed.findAll('.ag-csn-card')).toHaveLength(6)
  })

  it('opens the build dialog with its lines, warnings and blockers', async () => {
    const { wrapper } = await setup()
    await button(wrapper, 'Build from my site').trigger('click')
    await flushPromises()
    const b = runner.current
    expect(b.open).toHaveBeenCalledWith({ synthesize: true, extra_urls: [], document_ids: null })
    b.estimate.value = buildEstimate({
      blockers: [{ code: 'daily_runs', message: 'This project ran 5 context builds today; the limit is 5.' }],
      can_run: false,
    })
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog.textContent).toContain('Build context from your site')
    expect(dialog.textContent).toContain(
      'Cansee reads up to 8 pages of notion.so and the documents you choose, then suggests entries with the sources they come from.'
    )
    expect(dialog.textContent).toContain('8 pages of notion.so, 1 documents and 14 approved brand facts.')
    expect(dialog.textContent).toContain('AI: up to 2 requests, up to $0.02 of your AI allowance ($4.08 left this month).')
    expect(dialog.textContent).toContain('Also re-checks 6 pages your entries cite. Reading pages is free.')
    expect(dialog.textContent).toContain('These are upper bounds; you are billed only for what runs.')
    expect(dialog.textContent).toContain('This project ran 5 context builds today; the limit is 5.')
    const submit = [...dialog.querySelectorAll('button')].find((el) => el.textContent.includes('Build for up to $0.02'))
    expect(submit.disabled).toBe(true)

    b.estimate.value = buildEstimate()
    await flushPromises()
    expect(submit.disabled).toBe(false)
    submit.click()
    await flushPromises()
    expect(b.start).toHaveBeenCalled()
  })

  it('offers only a re-check when the analysis model is not configured', async () => {
    const { wrapper } = await setup(overview({ build: { available: true, reason: 'ai_not_configured', active_run: null, last_run: null } }))
    await button(wrapper, 'Build from my site').trigger('click')
    await flushPromises()
    const b = runner.current
    expect(b.open).toHaveBeenCalledWith({ synthesize: false, extra_urls: [], document_ids: null })
    b.estimate.value = buildEstimate({ ai: { calls_max: 0, usd_max: '0.0000' }, confirm: { ai_calls: 0, ai_usd_max: '0.0000', google_pages: 0 } })
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')
    const checkbox = [...dialog.querySelectorAll('label')].find((l) => l.textContent.includes('Suggest entries (uses AI)')).querySelector('input')
    expect(checkbox.checked).toBe(false)
    expect(checkbox.disabled).toBe(true)
    expect(dialog.textContent).not.toContain('AI: up to')
    expect(dialog.textContent).not.toContain('approved brand facts.')
    expect(dialog.textContent).toContain('Also re-checks 6 pages your entries cite. Reading pages is free.')
    expect([...dialog.querySelectorAll('button')].some((el) => el.textContent.trim() === 'Re-check sources')).toBe(true)
  })

  it('keeps Build from my site off with the reason when the server cannot build', async () => {
    const { wrapper } = await setup(overview({ build: { available: false, reason: 'insights_disabled', active_run: null, last_run: null } }))
    const off = wrapper.find('.ag-ctx-build-off')
    expect(off.attributes('aria-disabled')).toBe('true')
    await off.trigger('click')
    expect(runner.current.open).not.toHaveBeenCalled()
  })

  it('reports a finished build and what it used', async () => {
    const { wrapper } = await setup()
    runner.current.run.value = buildRun()
    await flushPromises()
    const panel = wrapper.find('.ag-cbp')
    expect(panel.text()).toContain('Built in 12 s: 3 suggestions to review.')
    expect(panel.text()).toContain('Used $0.0061 of AI allowance.')
    await button(panel, 'Dismiss').trigger('click')
    expect(runner.current.dismiss).toHaveBeenCalled()

    runner.current.run.value = buildRun({ confirmed: { ai_calls: 0, ai_usd_max: '0.0000', google_pages: 0 }, cost: { ai_usd: '0.0000' } })
    await flushPromises()
    expect(wrapper.find('.ag-cbp').text()).toContain("Re-checked 6 sources: 4 unchanged, 1 changed, 1 couldn't load.")
    expect(wrapper.find('.ag-cbp').text()).toContain('Nothing was billed.')
  })

  it('picks up a build already running when the context says so', async () => {
    const running = buildRun({ status: 'running', progress: { total: 16, queued: 12, running: 1, done: 3, failed: 0, skipped: 0, cancelled: 0 } })
    const { wrapper } = await setup(overview({ build: { available: true, reason: null, active_run: running, last_run: null } }))
    expect(runner.current.track).toHaveBeenCalledWith(running)
    expect(wrapper.find('.ag-cbp').text()).toContain('Building context: 3 of 16')
  })

  it('shows a running build with a confirmed stop', async () => {
    const { wrapper } = await setup()
    runner.current.run.value = buildRun({
      status: 'running',
      progress: { total: 16, queued: 10, running: 1, done: 5, failed: 0, skipped: 0, cancelled: 0 },
    })
    await flushPromises()
    const panel = wrapper.find('.ag-cbp')
    expect(panel.text()).toContain('Building context: 5 of 16')
    expect(panel.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('5')
    await button(panel, 'Stop').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog.textContent).toContain('Stop this build?')
    expect(dialog.textContent).toContain('Pages already read are kept. Nothing else is billed.')
    ;[...dialog.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Stop').click()
    await flushPromises()
    expect(runner.current.stop).toHaveBeenCalled()
  })

  it('confirms before leaving with an unsaved entry', async () => {
    const { wrapper, router } = await setup()
    await button(section(wrapper, 'strategy'), 'Add entry').trigger('click')
    await flushPromises()
    await section(wrapper, 'strategy').find('form.ag-cef input[type="text"]').setValue('Unsaved')
    await router.push('/projects/w1/agent/reports')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('agent-context')
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog.textContent).toContain('Leave without saving?')
    ;[...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Leave').click()
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('agent-reports'))
  })
})
