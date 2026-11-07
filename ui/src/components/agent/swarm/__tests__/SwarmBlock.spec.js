import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import {
  SERP_TAB,
  SWARM_ID,
  categories,
  finishedPart,
  planningPart,
  runningPart,
  tablePart,
} from './__fixtures__/swarmParts.js'

const fakeAgent = reactive({})
const fakePane = reactive({})
const fakeUi = { announce: vi.fn() }
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
vi.mock('@/stores/agentPane', () => ({ useAgentPaneStore: () => fakePane }))
vi.mock('@/stores/agentUi', () => ({ useAgentUiStore: () => fakeUi }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: SwarmBlock } = await import('../SwarmBlock.vue')
const { tableDomId } = await import('../tableModel')

enableAutoUnmount(afterEach)

const MESSAGE = { id: 'm1', chat_id: 'c1', role: 'assistant', status: 'streaming', parts: [] }
const originalMatchMedia = window.matchMedia

function reset(target, fields) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, fields)
}

beforeEach(() => {
  reset(fakeAgent, {
    status: { swarm: { enabled: true, max_agents: 30, worker_model: 'claude-haiku-5-5' } },
    swarms: {},
    messages: {},
    chatBusy: false,
    isChatBusy: () => fakeAgent.chatBusy,
    rerunSwarm: vi.fn(async () => ({ id: 'run-2' })),
    loadSwarm: vi.fn(async () => null),
    swarmCategories: () => categories().map(({ key, label }) => ({ key, label })),
    visiblePath: () => [],
  })
  reset(fakePane, { openCapture: vi.fn(), openUrl: vi.fn(), setReturnFocus: vi.fn() })
  fakeUi.announce.mockClear()
  toast.success.mockClear()
  toast.error.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  window.matchMedia = originalMatchMedia
})

function mountBlock(props = {}) {
  return mount(SwarmBlock, {
    props: { part: runningPart(), message: MESSAGE, live: true, websiteId: 'w1', busy: false, ...props },
    attachTo: document.body,
  })
}

const rowByLabel = (w, label) => w.findAll('.ag-swarm-row').find((r) => r.find('.ag-swarm-row-label').text() === label)
const catRows = (w) => w.findAll('.ag-swarm-cat-row')

function menuItem(text) {
  return [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes(text)) || null
}

async function openRerunMenu(w) {
  await w.find('.ag-swarm-head-rerun button').trigger('click')
  await flushPromises()
  await nextTick()
}

describe('SwarmBlock tree', () => {
  it('renders the header, categories, notes, prompts and agents from the part', () => {
    const w = mountBlock()
    expect(w.find('section.ag-swarm').attributes('aria-label')).toBe('Research agents')
    expect(w.find('.ag-swarm-title').text()).toBe('Running 7 agents')
    expect(w.find('.ag-swarm-subtitle').text()).toBe('Research Notion')
    expect(w.find('.ag-swarm-count').text()).toBe('2/7')

    const toggle = w.find('.ag-swarm-toggle')
    expect(toggle.attributes('aria-label')).toBe('Running 7 agents, 2 of 7 finished')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.attributes('aria-controls')).toBe('ag-swarm-m1-p4-body')

    expect(w.findAll('.ag-swarm-cat-label').map((c) => c.text())).toEqual([
      'Google (SEO)',
      'AI engines (GEO)',
      'Competitor pages',
      'Your site and content gaps',
      'Sources and citations',
    ])
    expect(w.findAll('.ag-swarm-cat-count').map((c) => c.text())).toEqual(['1/1', '1/2', '0/1', '0/2', '0/1'])
    expect(w.find('.ag-swarm-note').text()).toBe('Gemini, Grok and Perplexity are not configured, so they were not asked.')
    expect(w.find('.ag-swarm-sub-label').text()).toBe('“best note taking app for teams”')

    const google = rowByLabel(w, 'Google page 1')
    expect(google.find('.ag-swarm-row-text').text()).toBe("You're #4 · AI Overview shown")
    expect(google.find('.ag-swarm-row-text').classes()).toContain('is-good')
    expect(google.find('.ag-swarm-row-time').text()).toBe('15s')
    const claude = rowByLabel(w, 'Claude')
    expect(claude.attributes('aria-label')).toBe('Claude, Running, Asking Claude')
    expect(claude.find('.ag-swarm-row-text').classes()).toContain('is-shimmer')
    expect(rowByLabel(w, 'Content gaps').find('.ag-swarm-row-text').text()).toBe('Waiting for the pages')
    expect(rowByLabel(w, 'Cited sources').find('.ag-swarm-row-text').text()).toBe('Waiting for the AI engines')
    // Running categories show a spinner; the rest no mark.
    expect(catRows(w)[1].find('.ag-swarm-cat-spin').exists()).toBe(true)
    expect(catRows(w)[0].find('.ag-swarm-cat-spin').exists()).toBe(false)
  })

  it('shows the planning state without a body or a re-run', () => {
    const w = mountBlock({ part: planningPart() })
    expect(w.find('.ag-swarm-title').text()).toBe('Planning research agents')
    expect(w.find('.ag-swarm-title').classes()).toContain('is-shimmer')
    expect(w.find('.ag-swarm-body').exists()).toBe(false)
    expect(w.find('.ag-swarm-head-rerun').exists()).toBe(false)
    expect(w.find('.ag-swarm-progress-fill').attributes('style')).toContain('width: 0%')
  })

  it('reports progress as settled of total', () => {
    const w = mountBlock()
    const bar = w.find('[role="progressbar"]')
    expect(bar.attributes('aria-label')).toBe('Agents finished')
    expect(bar.attributes('aria-valuemin')).toBe('0')
    expect(bar.attributes('aria-valuemax')).toBe('7')
    expect(bar.attributes('aria-valuenow')).toBe('2')
    expect(w.find('.ag-swarm-progress-fill').attributes('style')).toMatch(/width: 28\.57/)
  })

  it('collapses the categories 600ms after the agents finish', async () => {
    vi.useFakeTimers()
    const w = mountBlock()
    expect(catRows(w).every((c) => c.attributes('aria-expanded') === 'true')).toBe(true)
    await w.setProps({ part: finishedPart() })
    expect(w.find('.ag-swarm-title').text()).toBe('Ran 7 agents in 2m 14s')
    expect(w.find('.ag-swarm-summary').text()).toBe('6 done · 1 failed')
    vi.advanceTimersByTime(599)
    await nextTick()
    expect(catRows(w)[0].attributes('aria-expanded')).toBe('true')
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(catRows(w).every((c) => c.attributes('aria-expanded') === 'false')).toBe(true)
    expect(catRows(w).map((c) => c.find('.ag-swarm-cat-sum').text())).toEqual([
      'best #4',
      'named by 0 of 1 · 1 failed',
      '1 page read',
      '2 gaps found',
      "you're not cited",
    ])
    expect(catRows(w)[1].find('.ag-swarm-cat-x').exists()).toBe(true)
  })

  it('keeps what the user opened when the agents finish', async () => {
    vi.useFakeTimers()
    const w = mountBlock()
    await catRows(w)[0].trigger('click')
    expect(catRows(w)[0].attributes('aria-expanded')).toBe('false')
    await w.setProps({ part: finishedPart() })
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(catRows(w)[0].attributes('aria-expanded')).toBe('false')
    expect(catRows(w)[1].attributes('aria-expanded')).toBe('true')
  })

  it('renders a reloaded finished research collapsed, and the header toggles the body', async () => {
    const w = mountBlock({ part: finishedPart(), live: false, message: { ...MESSAGE, status: 'complete' } })
    expect(catRows(w).every((c) => c.attributes('aria-expanded') === 'false')).toBe(true)
    await w.find('.ag-swarm-toggle').trigger('click')
    expect(w.find('.ag-swarm-toggle').attributes('aria-expanded')).toBe('false')
    expect(w.find('#ag-swarm-m1-p4-body').isVisible()).toBe(false)
  })

  it('marks reduced motion on the block', () => {
    window.matchMedia = (query) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })
    expect(mountBlock().find('.ag-swarm').classes()).toContain('is-reduced')
    window.matchMedia = originalMatchMedia
    expect(mountBlock().find('.ag-swarm').classes()).not.toContain('is-reduced')
  })
})

describe('SwarmBlock announcements', () => {
  it('announces the start and the end of the research', async () => {
    const w = mountBlock({ part: planningPart() })
    expect(fakeUi.announce).not.toHaveBeenCalled()
    await w.setProps({ part: runningPart() })
    expect(fakeUi.announce).toHaveBeenLastCalledWith('Research started: 7 agents')
    await w.setProps({ part: finishedPart() })
    expect(fakeUi.announce).toHaveBeenLastCalledWith('Research finished: 6 done · 1 failed')
  })

  it('announces a stop politely and a refusal assertively', async () => {
    const stopped = mountBlock()
    await stopped.setProps({ part: runningPart({ status: 'cancelled' }) })
    expect(fakeUi.announce).toHaveBeenLastCalledWith('Research stopped')

    const refused = mountBlock({ part: planningPart() })
    await refused.setProps({
      part: planningPart({ status: 'error', error: { code: 'swarm_disabled', message: 'The research agents are turned off on this server.' } }),
    })
    expect(fakeUi.announce).toHaveBeenLastCalledWith(
      'Could not start the research agents: The research agents are turned off on this server.',
      'assertive'
    )
  })

  it('does not announce a research that was already finished', () => {
    mountBlock({ part: finishedPart(), live: false })
    expect(fakeUi.announce).not.toHaveBeenCalled()
  })

  it('announces a re-run that arrives running, but not a research seen again mid-run', async () => {
    // A re-run turn adds its part running, every agent still queued.
    const fresh = runningPart()
    fresh.tasks = fresh.tasks.map((t) => ({ ...t, status: 'queued', result: '', tone: null, started_at: null }))
    mountBlock({ part: fresh })
    expect(fakeUi.announce).toHaveBeenLastCalledWith('Research started: 7 agents')

    // The same chat opened again while 2 of 7 agents are done: no new start.
    fakeUi.announce.mockClear()
    const again = mountBlock({ part: runningPart() })
    expect(fakeUi.announce).not.toHaveBeenCalled()
    await again.setProps({ part: finishedPart() })
    expect(fakeUi.announce).toHaveBeenLastCalledWith('Research finished: 6 done · 1 failed')
  })
})

describe('SwarmBlock rows', () => {
  it('opens a row with a capture in the pane and shows its detail', async () => {
    const w = mountBlock()
    const google = rowByLabel(w, 'Google page 1')
    await google.trigger('click')
    expect(fakePane.openCapture).toHaveBeenCalledWith(SERP_TAB, { activate: true })
    expect(fakePane.setReturnFocus).toHaveBeenCalledWith(google.element)
    expect(google.attributes('aria-expanded')).toBe('true')
    const detail = w.find(`#${google.attributes('aria-controls')}`)
    expect(detail.exists()).toBe(true)
    expect(google.attributes('aria-controls')).toBe('ag-swarm-m1-p4-t0')

    await rowByLabel(w, 'Claude').trigger('click')
    expect(fakePane.openCapture).toHaveBeenCalledTimes(1)
  })

  it('closes a detail with Escape and returns focus to its row', async () => {
    const w = mountBlock()
    const google = rowByLabel(w, 'Google page 1')
    await google.trigger('click')
    await w.find('.ag-swarm-detail').trigger('keydown', { key: 'Escape' })
    expect(w.find('.ag-swarm-detail').exists()).toBe(false)
    expect(document.activeElement).toBe(google.element)
  })

  it('ticks the time of a running agent on the shared clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T10:15:18.000Z'))
    const w = mountBlock()
    const time = () => rowByLabel(w, 'Claude').find('.ag-swarm-row-time').text()
    expect(time()).toBe('8s')
    vi.advanceTimersByTime(2000)
    await nextTick()
    expect(time()).toBe('10s')
  })

  it('shows an interrupted research with open agents as not finished, and offers to run it again', async () => {
    const w = mountBlock({ live: false, message: { ...MESSAGE, status: 'interrupted' } })
    expect(w.find('.ag-swarm-title').text()).toBe('Interrupted after 2 of 7 agents')
    expect(w.find('.ag-swarm').classes()).toContain('is-interrupted')
    expect(w.find('.ag-swarm-summary').text()).toContain('2 done · 5 stopped')
    await w.find('.ag-swarm-toggle').trigger('click')
    await w.find('.ag-swarm-toggle').trigger('click')
    await catRows(w)[1].trigger('click')
    expect(rowByLabel(w, 'Claude').find('.ag-swarm-row-text').text()).toBe('Not finished')
    const again = w.find('.ag-swarm-rerun-all')
    expect(again.text()).toBe('Re-run all agents')
    await again.trigger('click')
    expect(fakeAgent.rerunSwarm).toHaveBeenCalledWith({ chatId: 'c1', swarmId: SWARM_ID, scope: 'all' })
  })

  it('keeps the agents of a run that failed mid-research and offers to run them again', async () => {
    const w = mountBlock({ part: runningPart({ status: 'error', error: null }), live: false })
    expect(w.find('.ag-swarm-title').text()).toBe('Interrupted after 2 of 7 agents')
    expect(w.find('.ag-swarm').classes()).toContain('is-error')
    expect(w.find('.ag-swarm-error').exists()).toBe(false)
    expect(w.findAll('.ag-swarm-cat')).toHaveLength(5)
    expect(w.find('.ag-swarm-summary').text()).toContain('2 done · 5 stopped')
    await w.find('.ag-swarm-rerun-all').trigger('click')
    expect(fakeAgent.rerunSwarm).toHaveBeenCalledWith({ chatId: 'c1', swarmId: SWARM_ID, scope: 'all' })
  })

  it('links to newer results further down the thread', async () => {
    const target = document.createElement('section')
    target.id = tableDomId('m2', 'p9')
    target.scrollIntoView = vi.fn()
    document.body.appendChild(target)
    fakeAgent.visiblePath = () => [
      { id: 'm1', parts: [finishedPart(), tablePart({ id: 'p5', version: 1 })] },
      { id: 'm2', parts: [tablePart({ id: 'p9', version: 2 })] },
    ]
    const w = mountBlock({ part: finishedPart(), live: false })
    const link = w.find('.ag-swarm-newer')
    expect(link.text()).toBe('Newer results below')
    await link.trigger('click')
    expect(target.scrollIntoView).toHaveBeenCalled()
    target.remove()

    fakeAgent.visiblePath = () => [{ id: 'm1', parts: [finishedPart(), tablePart({ id: 'p5', version: 1 })] }]
    expect(mountBlock({ part: finishedPart(), live: false }).find('.ag-swarm-newer').exists()).toBe(false)
  })
})

describe('SwarmBlock re-run', () => {
  it('re-runs all agents or one category from the header menu', async () => {
    const w = mountBlock({ part: finishedPart(), live: false })
    await openRerunMenu(w)
    const all = menuItem('Re-run all agents')
    expect(all.textContent).toContain('7 agents')
    expect(menuItem('Google (SEO)').textContent).toContain('1 agent')
    expect(menuItem('AI engines (GEO)').textContent).toContain('2 agents')
    all.click()
    await flushPromises()
    expect(fakeAgent.rerunSwarm).toHaveBeenCalledWith({ chatId: 'c1', swarmId: SWARM_ID, scope: 'all', category: null })

    await openRerunMenu(w)
    menuItem('Google (SEO)').click()
    await flushPromises()
    expect(fakeAgent.rerunSwarm).toHaveBeenLastCalledWith({ chatId: 'c1', swarmId: SWARM_ID, scope: 'category', category: 'google' })
  })

  it('re-runs one agent from its detail', async () => {
    const w = mountBlock({ part: finishedPart(), live: false })
    await catRows(w)[0].trigger('click')
    await rowByLabel(w, 'Google page 1').trigger('click')
    const button = w.findAll('.ag-swarm-detail-actions button').find((b) => b.text() === 'Re-run this agent')
    await button.trigger('click')
    await flushPromises()
    expect(fakeAgent.rerunSwarm).toHaveBeenCalledWith({ chatId: 'c1', swarmId: SWARM_ID, scope: 'task', taskId: 'google.p1.page1' })
  })

  it('shows a failed re-run as a toast and an assertive announcement', async () => {
    fakeAgent.rerunSwarm = vi.fn(async () => {
      throw Object.assign(new Error('This research has reached its version limit. Start a new research.'), { code: 'version_limit' })
    })
    const w = mountBlock({ part: finishedPart(), live: false })
    await openRerunMenu(w)
    menuItem('Re-run all agents').click()
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('This research has reached its version limit. Start a new research.')
    expect(fakeUi.announce).toHaveBeenCalledWith('This research has reached its version limit. Start a new research.', 'assertive')
  })

  it('is disabled while the chat is busy', async () => {
    const w = mountBlock({ busy: true })
    const trigger = w.find('.ag-swarm-head-rerun button')
    expect(trigger.attributes('aria-disabled')).toBe('true')
    await openRerunMenu(w)
    expect(menuItem('Re-run all agents')).toBeNull()

    await rowByLabel(w, 'Google page 1').trigger('click')
    const button = w.findAll('.ag-swarm-detail-actions button').find((b) => b.text() === 'Re-run this agent')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toBe('Wait for the current reply to finish.')
    await button.trigger('click')
    expect(fakeAgent.rerunSwarm).not.toHaveBeenCalled()

    fakeAgent.chatBusy = true
    const other = mountBlock({ part: finishedPart(), live: false })
    expect(other.find('.ag-swarm-head-rerun button').attributes('aria-disabled')).toBe('true')
  })

  it('is hidden when the research agents are off or the plan was refused', () => {
    fakeAgent.status = { swarm: { enabled: false } }
    expect(mountBlock({ part: finishedPart(), live: false }).find('.ag-swarm-head-rerun').exists()).toBe(false)

    fakeAgent.status = { swarm: { enabled: true } }
    const refused = mountBlock({
      part: planningPart({ status: 'error', error: { code: 'too_many_agents', message: 'This plan has 36 agents; the limit is 30.' } }),
      live: false,
    })
    expect(refused.find('.ag-swarm-head-rerun').exists()).toBe(false)
    expect(refused.find('.ag-swarm-title').text()).toBe('Could not start the research agents')
    expect(refused.find('.ag-swarm-error').text()).toBe('This plan has 36 agents; the limit is 30.')
    expect(refused.find('.ag-swarm-body').exists()).toBe(false)
  })
})
