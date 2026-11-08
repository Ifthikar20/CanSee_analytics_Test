import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterLinkStub, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  PROMPT,
  SERP_TAB,
  SWARM_ID,
  categories,
  overflowTable,
  swarmTable,
  tablePart,
} from './__fixtures__/swarmParts.js'

const fakeAgent = reactive({})
const fakePane = reactive({})
const fakeFindings = reactive({})
const fakeUi = { announce: vi.fn() }
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => fakePane }))
vi.mock('@/stores/agentFindings', () => ({ useAgentFindingsStore: () => fakeFindings }))
vi.mock('@/stores/agentUi', () => ({ useAgentUiStore: () => fakeUi }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('@/lib/agent/download', async (importOriginal) => ({ ...(await importOriginal()), downloadText: vi.fn() }))

const { default: SwarmTable } = await import('../SwarmTable.vue')
const { useAuthStore } = await import('@/stores/auth')
const { loadHintState } = await import('@/lib/help/hints')
const { downloadText } = await import('@/lib/agent/download')

enableAutoUnmount(afterEach)

const MESSAGE = { id: 'm2', chat_id: 'c1', role: 'assistant', status: 'complete', parts: [], saved_report_id: null }

function reset(target, fields) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, fields)
}

beforeEach(() => {
  // The first-visit hint store (real; signed out unless a test signs in).
  localStorage.clear()
  setActivePinia(createPinia())
  reset(fakeAgent, {
    websiteId: 'w1',
    status: { swarm: { enabled: true } },
    swarms: {},
    messages: {},
    latest: 2,
    chatBusy: false,
    latestSwarmVersion: () => fakeAgent.latest,
    isChatBusy: () => fakeAgent.chatBusy,
    saveReport: vi.fn(async () => ({ id: 'r1', kind: 'report' })),
    rerunSwarm: vi.fn(async () => ({ id: 'run-3' })),
    loadSwarm: vi.fn(async () => null),
    swarmCategories: () => categories().map(({ key, label }) => ({ key, label })),
  })
  reset(fakePane, {
    openTable: vi.fn(() => `table:${SWARM_ID}`),
    openCapture: vi.fn(),
    openUrl: vi.fn(),
    openArtifact: vi.fn(),
    setReturnFocus: vi.fn(),
  })
  reset(fakeFindings, {
    canEdit: true,
    added: {},
    isAdded: (sid, sheet, key) => Boolean(fakeFindings.added[`${sid}:${sheet}:${key}`]),
    init: vi.fn(),
    addFromTable: vi.fn(async ({ swarmId, sheet, rowKeys }) => {
      for (const key of rowKeys) fakeFindings.added[`${swarmId}:${sheet}:${key}`] = `f-${key}`
      return { created: rowKeys.map((key) => ({ id: `f-${key}` })), duplicates: [] }
    }),
  })
  fakeUi.announce.mockClear()
  toast.success.mockClear()
  toast.error.mockClear()
  downloadText.mockClear()
})

function render(props = {}) {
  return mount(SwarmTable, {
    props: { part: tablePart(), message: MESSAGE, mode: 'inline', busy: false, ...props },
    global: { stubs: { RouterLink: RouterLinkStub } },
    attachTo: document.body,
  })
}

// The first column's own text, without its note and capture links.
const ownText = (el) => [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()).textContent.trim()
const bodyKeys = (w) => w.findAll('tbody tr').map((tr) => ownText(tr.find('th[scope="row"] .ag-st-cell').element))
const header = (w, label) => w.findAll('thead th').find((th) => th.text().startsWith(label))
const footerButton = (w, text) => w.findAll('.ag-sta button').find((b) => b.text().startsWith(text))

describe('SwarmTable toolbar', () => {
  it('shows the title, version and the sheets that have rows', () => {
    const w = render()
    expect(w.find('.ag-st-title').text()).toBe('Results')
    expect(w.find('.ag-st-chip').text()).toBe('v2')
    expect(w.findAll('[role="tab"]').map((t) => t.text().replace(/\s+/g, ' '))).toEqual(['Prompts 3', 'Content gaps 1'])
    expect(w.find('[role="tab"][aria-selected="true"]').text()).toContain('Prompts')
    expect(w.find('.ag-st-scroll').attributes('aria-label')).toBe('Results table, scrolls sideways')
    expect(w.find('.ag-st-scroll').attributes('tabindex')).toBe('0')
    expect(w.find('.ag-st-chip.is-newer').exists()).toBe(false)
    expect(w.find('section.ag-st').attributes('id')).toBe('ag-swarm-table-m2-p5')
  })

  it('switches sheets by click and arrow keys', async () => {
    const w = render()
    await w.findAll('[role="tab"]')[1].trigger('click')
    expect(w.findAll('thead th').map((th) => th.text())).toContain('Issue')
    await w.find('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' })
    expect(w.find('[role="tab"][aria-selected="true"]').text()).toContain('Prompts')
  })

  it('opens the table in the pane, pinned to its version only when a newer one exists', async () => {
    const w = render()
    await w.find('button[aria-label="Open in browser pane"]').trigger('click')
    expect(fakePane.openTable).toHaveBeenCalledWith(SWARM_ID, { version: null, activate: true, title: 'Research Notion' })

    fakeAgent.latest = 3
    await nextTick()
    const newer = w.find('.ag-st-chip.is-newer')
    expect(newer.text()).toBe('Newer: v3')
    await w.find('button[aria-label="Open in browser pane"]').trigger('click')
    expect(fakePane.openTable).toHaveBeenLastCalledWith(SWARM_ID, { version: 2, activate: true, title: 'Research Notion' })
    await newer.trigger('click')
    expect(fakePane.openTable).toHaveBeenLastCalledWith(SWARM_ID, { version: null, activate: true, title: 'Research Notion' })
  })

  it('downloads the sheet on screen as CSV', async () => {
    const w = render()
    await w.find('button[aria-label="Download CSV"]').trigger('click')
    const [text, name, type] = downloadText.mock.calls[0]
    expect(name).toBe('Research Notion v2 Prompts.csv')
    expect(type).toBe('text/csv;charset=utf-8')
    expect(text.startsWith('\uFEFFPrompt,Google,ChatGPT,Gemini,Ahead of you,Finding\r\n')).toBe(true)
    expect(text).toContain(`'=HYPERLINK(`)
  })
})

describe('SwarmTable sorting and cells', () => {
  it('cycles a sortable column through ascending, descending and none', async () => {
    const w = render()
    expect(bodyKeys(w)).toEqual(['best note taking app for teams', 'notes app with offline mode', 'Alternatives to Evernote'])
    const google = () => header(w, 'Google')
    expect(google().attributes('aria-sort')).toBe('none')

    await google().find('button').trigger('click')
    expect(google().attributes('aria-sort')).toBe('ascending')
    expect(bodyKeys(w)).toEqual(['Alternatives to Evernote', 'best note taking app for teams', 'notes app with offline mode'])

    await google().find('button').trigger('click')
    expect(google().attributes('aria-sort')).toBe('descending')
    // The failed cell has no sort key, so it stays last.
    expect(bodyKeys(w)).toEqual(['best note taking app for teams', 'Alternatives to Evernote', 'notes app with offline mode'])

    await google().find('button').trigger('click')
    expect(google().attributes('aria-sort')).toBe('none')
    expect(bodyKeys(w)[0]).toBe('best note taking app for teams')

    const ahead = header(w, 'Ahead of you')
    expect(ahead.attributes('aria-sort')).toBeUndefined()
    expect(ahead.find('button').exists()).toBe(false)
  })

  it('styles each cell by its state and keeps states as words', () => {
    const w = render()
    const [p1, p2] = w.findAll('tbody tr')
    const cell = (tr, i) => tr.findAll('.ag-st-cell')[i]
    expect(cell(p1, 2).classes()).toEqual(expect.arrayContaining(['is-not-found', 'is-tone-warn']))
    expect(cell(p1, 2).text()).toContain('Not named')
    expect(cell(p1, 3).classes()).toContain('is-not-configured')
    expect(cell(p1, 3).text()).toContain('Not configured')
    expect(cell(p1, 3).attributes('title')).toBe('GEMINI_API_KEY is not set.')
    expect(cell(p1, 3).find('.ag-st-sr').text()).toBe('. GEMINI_API_KEY is not set.')
    expect(cell(p2, 1).classes()).toContain('is-failed')
    expect(cell(p2, 2).classes()).toEqual(expect.arrayContaining(['is-ok', 'is-tone-good']))
    // The first column is the row header.
    expect(p1.find('th[scope="row"]').classes()).toContain('is-first')
  })

  it('marks changed values and values carried from an earlier version', () => {
    const p1 = render().findAll('tbody tr')[0]
    expect(p1.find('.ag-st-prev').text()).toBe('was #6')
    const sup = p1.find('sup.ag-st-ver')
    expect(sup.text()).toBe('v1')
    expect(sup.attributes('aria-label')).toBe('measured in version 1')
    expect(p1.findAll('sup.ag-st-ver')).toHaveLength(1)
  })

  it('opens row captures and links in the pane', async () => {
    const w = render()
    await w.find('tbody tr .ag-st-ev').trigger('click')
    expect(fakePane.openCapture).toHaveBeenCalledWith(SERP_TAB, { activate: true })

    await w.findAll('[role="tab"]')[1].trigger('click')
    const link = w.find('a.ag-st-link')
    expect(link.attributes('href')).toBe('https://www.notion.so/product')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    await link.trigger('click', { button: 0, ctrlKey: true })
    expect(fakePane.openUrl).not.toHaveBeenCalled()
    await link.trigger('click', { button: 0 })
    expect(fakePane.openUrl).toHaveBeenCalledWith('https://www.notion.so/product', { activate: true })
  })
})

describe('SwarmTable findings', () => {
  it('explains the checkbox column with a visible help icon', () => {
    const w = render()
    const head = w.find('thead th.ag-st-sel')
    expect(head.find('.ag-st-sr').text()).toBe('Add to findings')
    const help = head.find('button.cs-helptip')
    expect(help.attributes('aria-label')).toBe('What adding to findings does')
    expect(document.getElementById(help.attributes('aria-describedby')).textContent).toBe(
      "Tick rows to add them to Findings, the project's list of issues to fix.",
    )
  })

  it('points the column out once, while a row can still be ticked', async () => {
    const auth = useAuthStore()
    auth.user = { id: 5 }
    auth.session = { user: { id: 5 }, org: null, onboarding: { needs_onboarding: false } }
    const w = render()
    await flushPromises()
    const hint = document.body.querySelector('.cs-hint[data-hint="agent.findings-select"]')
    expect(hint).not.toBeNull()
    ;[...hint.querySelectorAll('button')].find((b) => b.textContent === 'Got it').click()
    await flushPromises()
    expect(document.body.querySelector('.cs-hint')).toBeNull()
    expect(loadHintState('5').seen).toEqual(['agent.findings-select'])
    w.unmount()

    // Every row already added: nothing to tick, no hint.
    localStorage.clear()
    setActivePinia(createPinia())
    const again = useAuthStore()
    again.user = { id: 5 }
    again.session = { user: { id: 5 }, org: null, onboarding: { needs_onboarding: false } }
    fakeFindings.added[`${SWARM_ID}:prompts:p1`] = 'f1'
    fakeFindings.added[`${SWARM_ID}:prompts:p3`] = 'f3'
    render()
    await flushPromises()
    expect(document.body.querySelector('.cs-hint')).toBeNull()
  })

  it('offers a checkbox only on rows with a finding draft, and marks rows already added', async () => {
    fakeFindings.added[`${SWARM_ID}:prompts:p3`] = 'f9'
    const w = render()
    const rows = w.findAll('tbody tr')
    expect(rows[0].find('input[type="checkbox"]').exists()).toBe(true)
    expect(rows[0].find('input').attributes('aria-label')).toBe('Add “best note taking app for teams” to findings')
    expect(rows[1].find('input[type="checkbox"]').exists()).toBe(false)
    expect(rows[2].find('input[type="checkbox"]').exists()).toBe(false)
    expect(rows[2].find('.ag-st-added').text()).toBe('In findings')
    expect(footerButton(w, 'Add all to findings').text()).toBe('Add all to findings (1)')
  })

  it('adds the selected rows, or all of them, and confirms with a toast', async () => {
    const w = render()
    expect(footerButton(w, 'Add all to findings').text()).toBe('Add all to findings (2)')
    await w.findAll('tbody input[type="checkbox"]')[1].setValue(true)
    expect(footerButton(w, 'Add 1 to findings')).toBeDefined()
    await footerButton(w, 'Add 1 to findings').trigger('click')
    await flushPromises()
    expect(fakeFindings.init).toHaveBeenCalledWith('w1')
    expect(fakeFindings.addFromTable).toHaveBeenCalledWith({ swarmId: SWARM_ID, version: 2, sheet: 'prompts', rowKeys: ['p3'] })
    expect(toast.success).toHaveBeenCalledWith('Added 1 finding.')
    expect(w.findAll('tbody tr')[2].find('.ag-st-added').exists()).toBe(true)
    expect(footerButton(w, 'Add all to findings').text()).toBe('Add all to findings (1)')
    const view = w.findComponent(RouterLinkStub)
    expect(view.text()).toBe('View findings')
    expect(view.props('to')).toEqual({ name: 'agent-findings', params: { websiteId: 'w1' } })
  })

  it('says which rows were already in Findings', async () => {
    fakeFindings.addFromTable = vi.fn(async () => ({ created: [{ id: 'f1' }], duplicates: [{ id: 'f0' }] }))
    const w = render()
    await footerButton(w, 'Add all to findings').trigger('click')
    await flushPromises()
    expect(fakeFindings.addFromTable).toHaveBeenCalledWith({ swarmId: SWARM_ID, version: 2, sheet: 'prompts', rowKeys: ['p1', 'p3'] })
    expect(toast.success).toHaveBeenCalledWith('Added 1 finding. 1 was already in Findings.')
  })

  it('shows a failed add as an error toast', async () => {
    fakeFindings.addFromTable = vi.fn(async () => {
      throw Object.assign(new Error('Some of these rows have no finding to add.'), { code: 'no_finding' })
    })
    const w = render()
    await footerButton(w, 'Add all to findings').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Some of these rows have no finding to add.')
  })

  it('hides every findings control from viewers', () => {
    fakeFindings.canEdit = false
    const w = render()
    expect(w.find('input[type="checkbox"]').exists()).toBe(false)
    expect(footerButton(w, 'Add all to findings')).toBeUndefined()
  })
})

describe('SwarmTable reports and re-run', () => {
  it('adds the reply to Reports, then opens the saved report', async () => {
    const w = render()
    await footerButton(w, 'Add to report').trigger('click')
    await flushPromises()
    expect(fakeAgent.saveReport).toHaveBeenCalledWith('m2')
    expect(toast.success).toHaveBeenCalledWith('Saved to Reports.')
    const saved = footerButton(w, 'Saved to Reports')
    await saved.trigger('click')
    expect(fakePane.openArtifact).toHaveBeenCalledWith('r1', { activate: true })
  })

  it('says when the reply was already in Reports', async () => {
    fakeAgent.saveReport = vi.fn(async () => ({ id: 'r0', already_saved: true }))
    const w = render()
    await footerButton(w, 'Add to report').trigger('click')
    await flushPromises()
    expect(toast.success).toHaveBeenCalledWith('Already in Reports.')
  })

  it('waits for the reply to finish before it can be added, and hides it without a message', () => {
    const streaming = render({ message: { ...MESSAGE, status: 'streaming' } })
    expect(footerButton(streaming, 'Add to report').attributes('disabled')).toBeDefined()
    const saved = render({ message: { ...MESSAGE, saved_report_id: 'r7' } })
    expect(footerButton(saved, 'Saved to Reports')).toBeDefined()
    const byApi = render({ message: null, chatId: 'c1', mode: 'pane', table: swarmTable(), part: null })
    expect(footerButton(byApi, 'Add to report')).toBeUndefined()
  })

  it('re-runs from the footer menu, and waits while the chat is busy', async () => {
    const w = render()
    await footerButton(w, 'Re-run').trigger('click')
    await flushPromises()
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Re-run all agents'))
    item.click()
    await flushPromises()
    expect(fakeAgent.rerunSwarm).toHaveBeenCalledWith({ chatId: 'c1', swarmId: SWARM_ID, scope: 'all', category: null })

    const busy = render({ busy: true })
    expect(footerButton(busy, 'Re-run').attributes('aria-disabled')).toBe('true')
  })

  it('in the pane, keeps each version’s report state with its own reply', async () => {
    // One pane footer serves every version: switching versions swaps the message.
    const v2Message = { ...MESSAGE, id: 'm2', saved_report_id: 'r2' }
    const v1Message = { ...MESSAGE, id: 'm1', saved_report_id: null }
    const w = render({ mode: 'pane', table: swarmTable(), part: null, message: v2Message })
    expect(footerButton(w, 'Saved to Reports')).toBeDefined()

    await w.setProps({ table: { ...swarmTable(), version: 1 }, message: v1Message })
    expect(footerButton(w, 'Saved to Reports')).toBeUndefined()
    const add = footerButton(w, 'Add to report')
    expect(add.attributes('disabled')).toBeUndefined()

    fakeAgent.saveReport = vi.fn(async () => ({ id: 'r1', kind: 'report' }))
    await add.trigger('click')
    await flushPromises()
    expect(fakeAgent.saveReport).toHaveBeenCalledWith('m1')
    await footerButton(w, 'Saved to Reports').trigger('click')
    expect(fakePane.openArtifact).toHaveBeenLastCalledWith('r1', { activate: true })

    // Back on version 2, then a third reply nobody saved yet.
    await w.setProps({ table: swarmTable(), message: v2Message })
    await footerButton(w, 'Saved to Reports').trigger('click')
    expect(fakePane.openArtifact).toHaveBeenLastCalledWith('r2', { activate: true })
    await w.setProps({ table: { ...swarmTable(), version: 3 }, message: { ...MESSAGE, id: 'm3' } })
    expect(footerButton(w, 'Add to report')).toBeDefined()
  })

  it('in the pane, asks for the latest version instead of opening another tab', async () => {
    fakeAgent.latest = 3
    const w = render({ mode: 'pane', table: swarmTable(), part: null, message: null, chatId: 'c1' })
    expect(w.find('button[aria-label="Open in browser pane"]').exists()).toBe(false)
    await w.find('.ag-st-chip.is-newer').trigger('click')
    expect(w.emitted('version')).toEqual([[null]])
    expect(fakePane.openTable).not.toHaveBeenCalled()
  })

  it('is read-only in a report', () => {
    const w = render({ mode: 'report' })
    expect(w.find('input[type="checkbox"]').exists()).toBe(false)
    expect(footerButton(w, 'Add to report')).toBeUndefined()
    expect(footerButton(w, 'Re-run')).toBeUndefined()
    expect(footerButton(w, 'Download CSV')).toBeDefined()
  })
})

describe('SwarmTable changes since the previous version', () => {
  const toggle = (w) => w.find('button.ag-st-toggle')

  it('marks the changed rows with a badge that names the changed columns', () => {
    const w = render()
    const [p1, p2, p3] = w.findAll('tbody tr')
    expect(p1.classes()).toContain('is-changed')
    expect(p2.classes()).not.toContain('is-changed')
    expect(p3.classes()).not.toContain('is-changed')
    expect(p1.find('.ag-st-badge').text()).toBe('Changed since version 1: Google')
    expect(p1.find('.ag-st-badge .ag-st-sr').exists()).toBe(true)
    // The badge sits outside the cell text, so the row label is unchanged.
    expect(bodyKeys(w)[0]).toBe(PROMPT)
  })

  it('filters to the listed changes and says when a sheet has none', async () => {
    const w = render()
    expect(toggle(w).attributes('aria-pressed')).toBe('false')
    await toggle(w).trigger('click')
    expect(toggle(w).attributes('aria-pressed')).toBe('true')
    expect(bodyKeys(w)).toEqual([PROMPT])
    expect(w.find('.ag-st-chip').text()).toBe('v2')
    await w.findAll('[role="tab"]')[1].trigger('click')
    expect(w.find('.ag-st-empty').text()).toBe('No changes since version 1 in this sheet.')
    await toggle(w).trigger('click')
    expect(w.find('.ag-st-empty').exists()).toBe(false)
  })

  it('offers the changed cells past the list cap', async () => {
    const w = render({ part: tablePart({ table: overflowTable() }) })
    expect(w.findAll('tbody tr.is-changed')).toHaveLength(3)
    expect(w.find('.ag-st-more').exists()).toBe(false)
    await toggle(w).trigger('click')
    expect(bodyKeys(w)).toEqual([PROMPT])
    const more = w.find('.ag-st-more button')
    expect(more.text()).toBe('Show 2 more changed rows')
    await more.trigger('click')
    expect(bodyKeys(w)).toEqual([PROMPT, 'notes app with offline mode', 'Alternatives to Evernote'])
    expect(w.find('.ag-st-more').exists()).toBe(false)
  })

  it('offers no filter on a first version', () => {
    const table = swarmTable({ previous_version: null, changes: [] })
    table.sheets[0].rows[0].cells.google.previous = null
    const w = render({ part: tablePart({ table }) })
    expect(toggle(w).exists()).toBe(false)
    expect(w.findAll('tbody tr.is-changed')).toHaveLength(0)
    expect(w.find('.ag-st-badge').exists()).toBe(false)
  })

  it('adds only the rows shown while filtered; a hidden checked row waits for the filter to go', async () => {
    const w = render()
    const check = (label) =>
      w.findAll('input.ag-st-check').find((el) => el.attributes('aria-label').includes(label))
    await check('Alternatives to Evernote').setValue(true)
    expect(footerButton(w, 'Add 1 to findings')).toBeDefined()
    await toggle(w).trigger('click')
    // The checked row is hidden: the footer offers the shown rows only.
    expect(footerButton(w, 'Add 1 to findings')).toBeUndefined()
    expect(footerButton(w, 'Add all shown to findings').text()).toBe('Add all shown to findings (1)')
    await footerButton(w, 'Add all shown to findings').trigger('click')
    await flushPromises()
    expect(fakeFindings.addFromTable).toHaveBeenCalledWith({ swarmId: SWARM_ID, version: 2, sheet: 'prompts', rowKeys: ['p1'] })
    await toggle(w).trigger('click')
    expect(check('Alternatives to Evernote').element.checked).toBe(true)
    expect(footerButton(w, 'Add 1 to findings')).toBeDefined()
  })

  it('keeps rows checked on another sheet out of a filtered add', async () => {
    const table = swarmTable()
    const w = render({ part: tablePart({ table }) })
    await w.findAll('input.ag-st-check')[1].setValue(true)
    await w.findAll('[role="tab"]')[1].trigger('click')
    await toggle(w).trigger('click')
    await w.findAll('[role="tab"]')[0].trigger('click')
    expect(footerButton(w, 'Add 1 to findings')).toBeUndefined()
    expect(footerButton(w, 'Add all shown to findings').text()).toBe('Add all shown to findings (1)')
  })

  it('says when the most significant changes are all on other sheets', async () => {
    const table = overflowTable()
    const gaps = table.sheets.find((s) => s.key === 'gaps')
    const [column] = Object.keys(gaps.rows[0].cells)
    gaps.rows[0].cells[column].previous = { text: 'old text', version: 1 }
    const w = render({ part: tablePart({ table }) })
    await toggle(w).trigger('click')
    await w.findAll('[role="tab"]')[1].trigger('click')
    expect(w.find('.ag-st-empty').text()).toBe('None of the most significant changes are in this sheet.')
    expect(w.find('.ag-st-more button').text()).toBe('Show 1 more changed row')
    await w.find('.ag-st-more button').trigger('click')
    await flushPromises()
    expect(w.find('.ag-st-empty').exists()).toBe(false)
    expect(w.findAll('tbody tr')).toHaveLength(1)
    // The button is gone; focus stays in the table instead of falling to the page.
    expect(document.activeElement.getAttribute('role')).toBe('tabpanel')
  })

  it('shows a row new since the previous version under the filter, badged New', async () => {
    const table = swarmTable()
    const gaps = table.sheets.find((s) => s.key === 'gaps')
    gaps.rows[0].added = true
    const w = render({ part: tablePart({ table }) })
    await w.findAll('[role="tab"]')[1].trigger('click')
    const row = w.find('tbody tr')
    expect(row.classes()).toContain('is-changed')
    expect(row.find('.ag-st-badge').text()).toBe('New since version 1')
    expect(row.find('.ag-st-badge').classes()).toContain('is-new')
    await toggle(w).trigger('click')
    expect(w.findAll('tbody tr')).toHaveLength(1)
    expect(w.find('.ag-st-more').exists()).toBe(false)
  })

  it('keeps the filter for a new version and folds the extra changes again', async () => {
    const w = render({ part: tablePart({ table: overflowTable() }) })
    await toggle(w).trigger('click')
    await w.find('.ag-st-more button').trigger('click')
    await w.setProps({ part: tablePart({ version: 3, table: overflowTable({ version: 3, previous_version: 2 }) }) })
    expect(toggle(w).attributes('aria-pressed')).toBe('true')
    expect(w.find('.ag-st-more button').text()).toBe('Show 2 more changed rows')
  })

  it('takes "Changed only" from its caller and reports changes to it', async () => {
    const w = render({ changedOnly: true })
    expect(toggle(w).attributes('aria-pressed')).toBe('true')
    expect(bodyKeys(w)).toEqual([PROMPT])
    await toggle(w).trigger('click')
    expect(w.emitted('update:changedOnly')).toEqual([[false]])
    // The caller keeps the value: until it changes the prop, the filter stays.
    await w.setProps({ changedOnly: false })
    expect(toggle(w).attributes('aria-pressed')).toBe('false')
    expect(bodyKeys(w)).toHaveLength(3)
  })

  it('still exports the whole sheet while filtered', async () => {
    const w = render()
    await toggle(w).trigger('click')
    await w.find('button[aria-label="Download CSV"]').trigger('click')
    const [text] = downloadText.mock.calls.at(-1)
    expect(text).toContain('Alternatives to Evernote')
    expect(text).toContain('notes app with offline mode')
  })
})
