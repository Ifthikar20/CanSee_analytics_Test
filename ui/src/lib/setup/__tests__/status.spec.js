import { describe, expect, it } from 'vitest'
import {
  MAX_ASKING,
  STAGES,
  configIncomplete,
  nextSteps,
  panelState,
  promptRunsLine,
  researchBlocker,
  researchMessage,
  researchProgress,
  setupIssues,
} from '../status'

const issue = (over = {}) => ({
  code: 'engine_not_configured',
  severity: 'limited',
  subject: 'engine',
  engine: 'chatgpt',
  setting: null,
  title: "ChatGPT isn't set up on this workspace.",
  action: 'ChatGPT is skipped; the other engines still answer.',
  ...over,
})

const task = (over = {}) => ({
  id: 'engines.p1.chatgpt',
  category: 'engines',
  label: 'ChatGPT',
  target: 'best crm for agencies',
  status: 'queued',
  ...over,
})

const swarmMessage = (status, tasks, over = {}) => ({
  id: 'm2',
  role: 'assistant',
  status: 'streaming',
  parts: [{ id: 'p1', type: 'swarm', status, tasks }],
  ...over,
})

const loadedChat = { loaded: true, loading: false, error: null }

describe('setupIssues', () => {
  it('gives [] for no status, no setup block or no issues', () => {
    expect(setupIssues(null)).toEqual([])
    expect(setupIssues({})).toEqual([])
    expect(setupIssues({ setup: { ready: true, issues: [] } })).toEqual([])
    expect(setupIssues({ setup: { issues: 'nope' } })).toEqual([])
  })

  it("keeps the server's own words, blocking first, and only configuration issues", () => {
    const status = {
      setup: {
        issues: [
          issue(),
          issue({ code: 'google_page_one_only', severity: 'info', subject: 'google', engine: null, title: 'Google results cover page one only.', action: 'Rankings below the first ten results show as not found.' }),
          issue({ code: 'agent_unavailable', severity: 'blocking', subject: 'agent', engine: null, title: "The AI agent isn't running right now.", action: 'Try again in a minute.' }),
          issue({ code: 'prompt_runs_low', severity: 'info', subject: 'prompt_runs', engine: null, title: '3 of your 20 free prompt runs are left this month.' }),
          issue({ code: 'allowance_exceeded', severity: 'blocking', subject: 'allowance', engine: null, title: 'Used up.' }),
          null,
          { code: 'x', subject: 'engine', severity: 'limited', title: '' },
        ],
      },
    }
    const out = setupIssues(status)
    expect(out.map((i) => i.code)).toEqual(['agent_unavailable', 'engine_not_configured', 'google_page_one_only'])
    expect(out[1]).toMatchObject({
      severity: 'limited',
      engine: 'chatgpt',
      title: "ChatGPT isn't set up on this workspace.",
      action: 'ChatGPT is skipped; the other engines still answer.',
      setting: '',
    })
    // Keys stay unique for v-for, even for two issues with one code.
    expect(new Set(out.map((i) => i.key)).size).toBe(out.length)
  })

  it('shows a setting name only when the server sent one (staff and DEBUG)', () => {
    const customer = {
      engines: [{ key: 'chatgpt', key_setting: '' }],
      google: { key_settings: [] },
      setup: { issues: [issue(), issue({ code: 'google_not_configured', subject: 'google', engine: null, title: 'Google' })] },
    }
    expect(setupIssues(customer).map((i) => i.setting)).toEqual(['', ''])

    const staff = {
      engines: [{ key: 'chatgpt', key_setting: 'OPENAI_API_KEY' }],
      google: { key_settings: ['SERPAPI_KEY', 'SCRAPERAPI_KEY'] },
      setup: {
        issues: [
          issue({ setting: null }),
          issue({ code: 'google_not_configured', subject: 'google', engine: null, title: 'Google', setting: null }),
          issue({ code: 'agent_disabled', severity: 'blocking', subject: 'agent', engine: null, title: 'Off', setting: 'AGENT_ENABLED' }),
        ],
      },
    }
    expect(setupIssues(staff).map((i) => [i.code, i.setting])).toEqual([
      ['agent_disabled', 'AGENT_ENABLED'],
      ['engine_not_configured', 'OPENAI_API_KEY'],
      ['google_not_configured', 'SERPAPI_KEY or SCRAPERAPI_KEY'],
    ])
  })

  it("keeps each issue's own setting when several issues share a code", () => {
    const staff = {
      engines: [
        { key: 'chatgpt', key_setting: '' },
        { key: 'grok', key_setting: '' },
      ],
      setup: {
        issues: [
          issue({ setting: 'OPENAI_API_KEY' }),
          issue({ engine: 'grok', title: "Grok isn't set up on this workspace.", setting: 'XAI_API_KEY' }),
        ],
      },
    }
    expect(setupIssues(staff).map((i) => i.setting)).toEqual(['OPENAI_API_KEY', 'XAI_API_KEY'])
  })

  it('reads an unknown severity as info', () => {
    expect(setupIssues({ setup: { issues: [issue({ severity: 'weird' })] } })[0].severity).toBe('info')
  })
})

describe('configIncomplete and researchBlocker', () => {
  it('is incomplete for a blocking or limited issue, not for info only', () => {
    expect(configIncomplete([])).toBe(false)
    expect(configIncomplete([{ severity: 'info' }])).toBe(false)
    expect(configIncomplete([{ severity: 'limited' }])).toBe(true)
    expect(configIncomplete([{ severity: 'blocking' }])).toBe(true)
    expect(configIncomplete(null)).toBe(false)
  })

  it("says why the research agents can't run: a blocking issue, else the server's research message", () => {
    expect(researchBlocker(null, [])).toBe('')
    expect(researchBlocker({ research: { available: true } }, [{ severity: 'limited', title: 'x' }])).toBe('')
    expect(researchBlocker({}, [{ severity: 'blocking', title: "The AI agent isn't running right now." }])).toBe(
      "The AI agent isn't running right now.",
    )
    expect(
      researchBlocker({ research: { available: false, reason: 'nothing_to_measure', message: 'Neither Google results nor any AI engine is set up on this workspace.' } }, []),
    ).toBe('Neither Google results nor any AI engine is set up on this workspace.')
  })
})

describe('promptRunsLine', () => {
  const free = (over = {}) => ({ prompt_runs: { unlimited: false, limit: 20, used: 7, remaining: 13, resets_at: '2026-12-01T00:00:00Z', ...over } })

  it('is null for paid plans, an unknown plan and a server without the block', () => {
    expect(promptRunsLine(null)).toBeNull()
    expect(promptRunsLine({})).toBeNull()
    expect(promptRunsLine({ prompt_runs: { unlimited: true, limit: null, remaining: null } })).toBeNull()
    expect(promptRunsLine({ prompt_runs: { limit: 20, remaining: 3 } })).toBeNull()
    expect(promptRunsLine(free({ remaining: null }))).toBeNull()
  })

  it('counts free prompt runs, never dollars', () => {
    expect(promptRunsLine(free())).toEqual({ text: '13 free prompt runs left', renews: 'They renew on December 1.', exhausted: false })
    expect(promptRunsLine(free({ remaining: 1 })).text).toBe('1 free prompt run left')
    expect(promptRunsLine(free({ resets_at: 'not a date' })).renews).toBe('')
    for (const remaining of [0, 13, 1]) expect(JSON.stringify(promptRunsLine(free({ remaining })))).not.toMatch(/\$/)
  })

  it('says when none are left (and never a negative count)', () => {
    expect(promptRunsLine(free({ remaining: 0 }))).toEqual({
      text: 'No free prompt runs left this month.',
      renews: 'They renew on December 1.',
      exhausted: true,
    })
    expect(promptRunsLine(free({ remaining: -2 })).exhausted).toBe(true)
  })
})

describe('researchMessage', () => {
  const user = { id: 'm1', role: 'user', parts: [] }
  const report = { id: 'm3', role: 'assistant', parts: [{ type: 'text' }] }
  const research = swarmMessage('done', [])

  it("takes the active run's reply first", () => {
    expect(researchMessage({ run: { messageId: 'm3' }, messages: { m3: report }, path: [user, research] })).toBe(report)
  })

  it('else the newest reply with research agents on the path, else the newest reply', () => {
    expect(researchMessage({ path: [user, research, { id: 'm4', role: 'user' }, report] })).toBe(research)
    expect(researchMessage({ path: [user, report] })).toBe(report)
    expect(researchMessage({ path: [user] })).toBeNull()
    expect(researchMessage()).toBeNull()
    // A run whose reply is not loaded falls back to the path.
    expect(researchMessage({ run: { messageId: 'gone' }, messages: {}, path: [user, research] })).toBe(research)
  })
})

describe('researchProgress', () => {
  it('is none without a first research chat', () => {
    expect(researchProgress().state).toBe('none')
    expect(researchProgress({ chatId: null, run: { phase: 'running' } }).state).toBe('none')
  })

  it('is loading until the chat is known', () => {
    expect(researchProgress({ chatId: 'c1' })).toMatchObject({ state: 'loading', live: false })
    expect(researchProgress({ chatId: 'c1', chat: { loaded: false, loading: true, error: null } }).state).toBe('loading')
  })

  it('says a deleted chat is gone and another failure is unknown', () => {
    expect(researchProgress({ chatId: 'c1', chat: { loaded: false, error: { status: 404 } } })).toMatchObject({
      state: 'missing',
      title: 'The first research chat was deleted.',
    })
    expect(researchProgress({ chatId: 'c1', chat: { loaded: false, error: { status: 500 } } }).state).toBe('unknown')
    // A chat that loaded once keeps its research through a later failed refresh.
    const later = researchProgress({ chatId: 'c1', chat: { loaded: true, error: { status: 500 } }, run: { phase: 'running' } })
    expect(later.state).toBe('running')
  })

  it('waits for a free slot while queued, with how many are ahead', () => {
    const queued = (queue) => researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'queued', queue } })
    expect(queued({ position: 3, ahead: 2, slots: 6 })).toMatchObject({
      state: 'queued',
      stage: 'start',
      title: 'Waiting for a free slot (2 ahead)',
      line: 'Your research starts as soon as one is free.',
      queue: { position: 3, ahead: 2, slots: 6 },
      live: true,
    })
    expect(queued({ position: 1, ahead: 0, slots: 6 })).toMatchObject({ title: 'Waiting for a free slot', line: 'Your research is next.' })
    expect(queued(null)).toMatchObject({ title: 'Waiting for a free slot', queue: null })
  })

  it('plans before the research agents start', () => {
    const running = { phase: 'running', messageId: 'm2' }
    expect(researchProgress({ chatId: 'c1', chat: loadedChat, run: running, message: null })).toMatchObject({
      state: 'running',
      stage: 'plan',
      title: 'Planning the research',
      progress: null,
    })
    expect(researchProgress({ chatId: 'c1', chat: loadedChat, run: running, message: swarmMessage('planning', []) }).stage).toBe('plan')
  })

  it('counts the agents and names what is being asked while they work', () => {
    const tasks = [
      task({ status: 'done' }),
      task({ id: 'engines.p1.claude', label: 'Claude', status: 'running' }),
      task({ id: 'google.p1.page1', category: 'google', label: 'Google page 1', status: 'running' }),
      task({ id: 'site.p1.page', category: 'site', label: 'Your page', status: 'running' }),
      task({ id: 'engines.p1.gemini', label: 'Gemini', status: 'failed' }),
      task({ id: 'engines.p2.grok', label: 'Grok', status: 'queued' }),
    ]
    const out = researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'running' }, message: swarmMessage('running', tasks) })
    expect(out).toMatchObject({
      state: 'running',
      stage: 'research',
      title: 'Asking Google and the AI engines',
      line: '2 of 6 agents finished',
      live: true,
    })
    expect(out.progress).toBeCloseTo(2 / 6)
    // Only Google and the engines, not the page agents.
    expect(out.asking.map((a) => [a.who, a.prompt])).toEqual([
      ['Claude', 'best crm for agencies'],
      ['Google page 1', 'best crm for agencies'],
    ])
  })

  it('names at most MAX_ASKING asks, and skips one without a label', () => {
    const tasks = ['A', 'B', '', 'C', 'D', 'E'].map((label, i) => task({ id: `engines.p${i}.x`, label, status: 'running' }))
    const out = researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'running' }, message: swarmMessage('running', tasks) })
    expect(out.asking.map((a) => a.who)).toEqual(['A', 'B', 'C'].slice(0, MAX_ASKING))
  })

  it('is indeterminate with no tasks yet, and writes up once the agents settle', () => {
    const empty = researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'running' }, message: swarmMessage('running', []) })
    expect(empty).toMatchObject({ stage: 'research', progress: null, counts: null, line: '' })
    const writing = researchProgress({
      chatId: 'c1',
      chat: loadedChat,
      run: { phase: 'running' },
      message: swarmMessage('done', [task({ status: 'done' })]),
    })
    expect(writing).toMatchObject({ state: 'running', stage: 'write', title: 'Writing up the findings', line: '1 of 1 agent finished', progress: 1 })
  })

  it('says it is stopping while cancelling', () => {
    expect(researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'cancelling' } })).toMatchObject({
      state: 'running',
      title: 'Stopping the research',
      live: true,
    })
  })

  it("reads the run's end: ready, stopped or failed with the server's reason", () => {
    const message = swarmMessage('done', [task({ status: 'done' }), task({ id: 'b', status: 'failed' })], { status: 'complete' })
    expect(researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'done' }, message })).toMatchObject({
      state: 'done',
      title: 'Your first research is ready.',
      line: '2 of 2 agents finished',
      live: false,
    })
    expect(researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'cancelled' }, message }).state).toBe('stopped')
    expect(
      researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'failed', error: { code: 'run_timeout', message: 'This reply took too long and was stopped.' } }, message }),
    ).toMatchObject({ state: 'failed', title: "The research didn't finish.", line: 'This reply took too long and was stopped.' })
    expect(researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase: 'failed' }, message }).line).toBe('Open it in the Agent to try again.')
  })

  it("reads a reply this tab never saw running from the reply's status", () => {
    const of = (status, over = {}) =>
      researchProgress({ chatId: 'c1', chat: loadedChat, run: null, message: { id: 'm2', role: 'assistant', status, parts: [], ...over } })
    expect(of('complete').state).toBe('done')
    expect(of('truncated').state).toBe('done')
    expect(of('cancelled').state).toBe('stopped')
    expect(of('interrupted', { error_message: 'This reply was not saved completely.' })).toMatchObject({
      state: 'failed',
      line: 'This reply was not saved completely.',
    })
    expect(of('streaming').state).toBe('loading')
  })

  it("says the research didn't start when the chat has no reply", () => {
    expect(researchProgress({ chatId: 'c1', chat: loadedChat, run: null, message: null })).toMatchObject({
      state: 'failed',
      title: "The research didn't start.",
    })
  })

  it('only uses stages the panel draws', () => {
    const keys = STAGES.map((s) => s.key)
    for (const phase of ['queued', 'running']) {
      const out = researchProgress({ chatId: 'c1', chat: loadedChat, run: { phase }, message: swarmMessage('running', [task()]) })
      expect(keys).toContain(out.stage)
    }
  })
})

describe('panelState', () => {
  const now = 10_000_000
  const first = { mode: 'research', chatId: 'c1', createdAt: now - 1000, dismissed: false, collapsed: false }
  const none = { state: 'none', live: false }
  const running = { state: 'running', live: true }
  const done = { state: 'done', live: false }
  const limited = [{ severity: 'limited' }]

  it('hides when there is no first landing and nothing missing', () => {
    expect(panelState({ record: null, statusKnown: true, issues: [], research: none, now })).toMatchObject({ visible: false, pointer: '' })
    expect(panelState({ record: { ...first, dismissed: true }, statusKnown: true, issues: [], research: done, now }).visible).toBe(false)
    expect(panelState({ record: first, statusKnown: true, issues: [{ severity: 'info' }], research: done, now: now + 30 * 86_400_000 }).visible).toBe(false)
  })

  it('shows on a first landing, and whenever setup is missing, dismissed or not', () => {
    expect(panelState({ record: first, statusKnown: false, issues: [], research: none, now }).visible).toBe(true)
    expect(panelState({ record: null, statusKnown: true, issues: limited, research: none, now }).visible).toBe(true)
    expect(panelState({ record: { ...first, dismissed: true }, statusKnown: true, issues: limited, research: none, now }).visible).toBe(true)
  })

  it('can be dismissed only once everything is set up and the research is over', () => {
    expect(panelState({ record: first, statusKnown: true, issues: [], research: done, now }).dismissible).toBe(true)
    expect(panelState({ record: first, statusKnown: true, issues: [{ severity: 'info' }], research: none, now }).dismissible).toBe(true)
    expect(panelState({ record: first, statusKnown: true, issues: [], research: running, now }).dismissible).toBe(false)
    expect(panelState({ record: first, statusKnown: true, issues: [], research: { state: 'queued' }, now }).dismissible).toBe(false)
    expect(panelState({ record: first, statusKnown: true, issues: [], research: { state: 'loading' }, now }).dismissible).toBe(false)
    expect(panelState({ record: first, statusKnown: true, issues: limited, research: done, now }).dismissible).toBe(false)
    // Not before the status says what is set up.
    expect(panelState({ record: first, statusKnown: false, issues: [], research: done, now }).dismissible).toBe(false)
  })

  it('gives empty cards a pointer that says why they may be empty', () => {
    expect(panelState({ record: first, statusKnown: true, issues: limited, research: running, now }).pointer).toBe(
      'Your first research is still running. Its progress is in Setup at the top of this page.',
    )
    expect(panelState({ record: first, statusKnown: true, issues: limited, research: done, now }).pointer).toBe(
      'Some of your setup is missing, so this may stay empty. See Setup at the top of this page.',
    )
    expect(panelState({ record: first, statusKnown: true, issues: [], research: done, now }).pointer).toBe(
      'See Setup at the top of this page for what to do next.',
    )
    expect(panelState({ record: first, statusKnown: true, issues: [], research: { state: 'loading' }, now }).pointer).toBe(
      'See Setup at the top of this page for what to do next.',
    )
  })
})

describe('nextSteps', () => {
  const keys = (steps) => steps.map((s) => s.key)

  it('offers nothing while the research is in flight, or without a project', () => {
    for (const state of ['loading', 'queued', 'running']) {
      expect(nextSteps({ websiteId: 'w1', chatId: 'c1', research: { state } })).toEqual([])
    }
    expect(nextSteps({ websiteId: '', research: { state: 'done' } })).toEqual([])
    expect(nextSteps({ websiteId: 'w1' })).toEqual([])
  })

  it('opens the finished research, then Autopilot, then Add prompts', () => {
    const steps = nextSteps({ websiteId: 'w1', chatId: 'c1', research: { state: 'done' }, autopilotOn: false })
    expect(keys(steps)).toEqual(['results', 'autopilot', 'prompts'])
    expect(steps[0]).toMatchObject({ label: 'View the research', to: { name: 'agent-chat', params: { websiteId: 'w1', chatId: 'c1' } } })
    expect(steps[1].to).toEqual({ name: 'settings-autopilot' })
    expect(steps[2]).toMatchObject({ label: 'Add prompts', action: 'add-prompts' })
    expect(nextSteps({ websiteId: 'w1', chatId: 'c1', research: { state: 'failed' } })[0].label).toBe('Open the research')
  })

  it('leaves out Autopilot only when it is known to be on', () => {
    expect(keys(nextSteps({ websiteId: 'w1', chatId: 'c1', research: { state: 'done' }, autopilotOn: true }))).toEqual(['results', 'prompts'])
    expect(keys(nextSteps({ websiteId: 'w1', chatId: 'c1', research: { state: 'done' }, autopilotOn: null }))).toContain('autopilot')
  })

  it('offers a research when there is none, off with the reason when it cannot run', () => {
    const open = nextSteps({ websiteId: 'w1', research: { state: 'none' } })
    expect(open[0]).toMatchObject({
      key: 'research',
      to: { name: 'agent-home', params: { websiteId: 'w1' }, query: { agent: 'gap_analyst' } },
      disabled: false,
    })
    const blocked = nextSteps({ websiteId: 'w1', research: { state: 'missing' }, chatId: 'c1', blocker: "The AI agent isn't running right now." })
    expect(blocked[0]).toMatchObject({ key: 'research', disabled: true, reason: "The AI agent isn't running right now." })
  })
})
