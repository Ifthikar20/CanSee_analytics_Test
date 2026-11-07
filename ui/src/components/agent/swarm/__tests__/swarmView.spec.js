import { describe, expect, it } from 'vitest'
import {
  capturedText,
  categorySummary,
  clockTime,
  detailStatusText,
  displayStatus,
  groupTasks,
  headerText,
  isSwarmLive,
  lengthText,
  namedText,
  overviewText,
  positionsText,
  progressRatio,
  summaryText,
  swarmCounts,
  taskLine,
  taskName,
  taskTime,
  waitingText,
} from '../swarmView'
import {
  citationsDetail,
  engineDetail,
  finishedPart,
  finishedTasks,
  gapDetail,
  planningPart,
  runningPart,
  runningTasks,
  serpDetail,
  task,
} from './__fixtures__/swarmParts.js'

const byId = (tasks) => new Map(tasks.map((t) => [t.id, t]))

describe('swarmCounts and progress', () => {
  it('counts every status and the settled total', () => {
    expect(swarmCounts(runningTasks())).toEqual({
      total: 7,
      queued: 4,
      running: 1,
      done: 2,
      failed: 0,
      skipped: 0,
      stopped: 0,
      settled: 2,
    })
    expect(swarmCounts(finishedTasks())).toMatchObject({ total: 7, done: 6, failed: 1, settled: 7 })
    expect(swarmCounts(null)).toMatchObject({ total: 0, settled: 0 })
  })

  it('reports settled over total, and nothing for an empty plan', () => {
    expect(progressRatio(swarmCounts(runningTasks()))).toBeCloseTo(2 / 7)
    expect(progressRatio(swarmCounts([]))).toBe(0)
    expect(progressRatio(null)).toBe(0)
  })
})

describe('live state and status shown', () => {
  it('is live only while the reply is live and the part is planning or running', () => {
    expect(isSwarmLive(runningPart(), true)).toBe(true)
    expect(isSwarmLive(planningPart(), true)).toBe(true)
    expect(isSwarmLive(runningPart(), false)).toBe(false)
    expect(isSwarmLive(finishedPart(), true)).toBe(false)
  })

  it('shows open agents of a stopped swarm as stopped', () => {
    expect(displayStatus(task({ status: 'running' }), true)).toBe('running')
    expect(displayStatus(task({ status: 'running' }), false)).toBe('stopped')
    expect(displayStatus(task({ status: 'queued' }), false)).toBe('stopped')
    expect(displayStatus(task({ status: 'failed' }), false)).toBe('failed')
  })
})

describe('headerText', () => {
  const live = { live: true }

  it('names every swarm status', () => {
    const running = runningPart()
    expect(headerText(planningPart(), swarmCounts([]), live)).toBe('Planning research agents')
    expect(headerText(running, swarmCounts(running.tasks), live)).toBe('Running 7 agents')

    const rerun = runningPart({ version: 2, scope: 'category', scope_label: 'Google (SEO)', tasks: running.tasks.slice(0, 1) })
    expect(headerText(rerun, swarmCounts(rerun.tasks), live)).toBe('Re-running 1 agent · Google (SEO)')

    const done = finishedPart({ status: 'done' })
    expect(headerText(done, swarmCounts(done.tasks), live)).toBe('Ran 7 agents in 2m 14s')
    expect(headerText(finishedPart(), swarmCounts(finishedTasks()), { live: false })).toBe('Ran 7 agents in 2m 14s')

    const stopped = runningPart({ status: 'cancelled', ended_at: '2026-11-04T10:16:00Z', duration_ms: 56000 })
    expect(headerText(stopped, swarmCounts(stopped.tasks), live)).toBe('Stopped after 2 of 7 agents')

    const interrupted = runningPart({ status: 'interrupted' })
    expect(headerText(interrupted, swarmCounts(interrupted.tasks), live)).toBe('Interrupted after 2 of 7 agents')

    const refused = planningPart({ status: 'error', error: { code: 'too_many_agents', message: 'This plan has 36 agents.' } })
    expect(headerText(refused, swarmCounts([]), live)).toBe('Could not start the research agents')

    // The runner closes a part as failed when its run fails mid-research.
    const failed = runningPart({ status: 'error', error: 'Not finished' })
    expect(headerText(failed, swarmCounts(failed.tasks), { live: false })).toBe('Interrupted after 2 of 7 agents')
  })

  it('treats a part still marked running in a reply that ended as interrupted', () => {
    const part = runningPart()
    expect(headerText(part, swarmCounts(part.tasks), { live: false })).toBe('Interrupted after 2 of 7 agents')
    expect(headerText(planningPart(), swarmCounts([]), { live: false })).toBe('Interrupted before the agents started')
  })

  it('works out the duration from the times when duration_ms is missing', () => {
    const part = finishedPart({ duration_ms: null, started_at: '2026-11-04T10:15:00Z', ended_at: '2026-11-04T10:15:09Z' })
    expect(headerText(part, swarmCounts(part.tasks), live)).toBe('Ran 7 agents in 9s')
  })
})

describe('summaryText', () => {
  it('leaves out zero counts except done', () => {
    expect(summaryText({ done: 18, failed: 1, skipped: 2, stopped: 0 })).toBe('18 done · 1 failed · 2 skipped')
    expect(summaryText({ done: 0, failed: 0, skipped: 0, stopped: 3 })).toBe('0 done · 3 stopped')
    expect(summaryText({ done: 21 })).toBe('21 done')
  })
})

describe('taskLine', () => {
  const tasks = runningTasks()
  const map = byId(tasks)

  it('says what a queued agent waits for, from its open dependencies', () => {
    const competitor = map.get('competitors.p1.c1')
    // Google page 1 is done, so the competitor page is only queued.
    expect(taskLine(competitor, { tasksById: map })).toEqual({ text: 'Queued', tone: 'muted', shimmer: false })
    expect(taskLine(map.get('site.p1.gaps'), { tasksById: map }).text).toBe('Waiting for the pages')
    expect(taskLine(map.get('sources.p1.cited'), { tasksById: map }).text).toBe('Waiting for the AI engines')

    const waitingOnGoogle = new Map(map)
    waitingOnGoogle.set('google.p1.page1', task({ status: 'running' }))
    expect(waitingText(competitor, waitingOnGoogle)).toBe('Waiting for Google results')
    // A dependency outside this execution runs on its carried result.
    expect(waitingText(task({ depends_on: ['google.p9.page1'] }), map)).toBe('')
    expect(taskLine(competitor, { waiting: 'Waiting for Google results' }).text).toBe('Waiting for Google results')
  })

  it('shows the live step with a shimmer while running', () => {
    expect(taskLine(map.get('engines.p1.claude'))).toEqual({ text: 'Asking Claude', tone: null, shimmer: true })
    expect(taskLine(task({ status: 'running', step: '' })).text).toBe('Working')
  })

  it('shows the result and its tone once done', () => {
    expect(taskLine(map.get('google.p1.page1'))).toEqual({ text: "You're #4 · AI Overview shown", tone: 'good', shimmer: false })
    expect(taskLine(map.get('engines.p1.chatgpt')).tone).toBe('warn')
    expect(taskLine(task({ status: 'done', result: 'x', tone: 'loud' })).tone).toBeNull()
  })

  it('names the reason of a failed, skipped or stopped agent', () => {
    const error = (code, message) => ({ code, message })
    expect(taskLine(task({ status: 'failed', error: error('rate_limited', 'The engine was busy or rate limited.') }))).toEqual({
      text: 'Failed: The engine was busy or rate limited.',
      tone: 'bad',
      shimmer: false,
    })
    expect(taskLine(task({ status: 'failed' })).text).toBe('Failed')
    expect(taskLine(task({ status: 'skipped', error: error('daily_limit', 'This project used its daily Google search allowance.') }))).toEqual({
      text: 'Skipped: This project used its daily Google search allowance.',
      tone: 'muted',
      shimmer: false,
    })
    expect(taskLine(task({ status: 'stopped', error: error('stopped', 'Stopped before it started') })).text).toBe(
      'Stopped before it started'
    )
    expect(taskLine(task({ status: 'stopped' })).text).toBe('Stopped')
    // The runner closes a part with a plain string error.
    expect(taskLine(task({ status: 'skipped', error: 'Not configured' })).text).toBe('Skipped: Not configured')
  })

  it('says Not finished for an open agent of a swarm that stopped', () => {
    expect(taskLine(map.get('engines.p1.claude'), { swarmLive: false })).toEqual({ text: 'Not finished', tone: 'muted', shimmer: false })
    expect(taskLine(map.get('site.p1.gaps'), { swarmLive: false, tasksById: map }).text).toBe('Not finished')
  })

  it('names a row by its label, status word and line', () => {
    const t = map.get('engines.p1.claude')
    expect(taskName(t, taskLine(t), 'running')).toBe('Claude, Running, Asking Claude')
  })
})

describe('taskTime', () => {
  it('counts a running agent from its start and shows a finished one by its duration', () => {
    const running = task({ status: 'running', started_at: '2026-11-04T10:15:10.000Z' })
    expect(taskTime(running, Date.parse('2026-11-04T10:15:18.400Z'))).toBe('8s')
    expect(taskTime(running, Date.parse('2026-11-04T10:15:18.400Z'), { swarmLive: false })).toBe('')
    expect(taskTime(runningTasks()[0], 0)).toBe('15s')
    expect(taskTime(finishedTasks()[2], 0)).toBe('1m 2s')
  })

  it('shows no time for an agent that never started', () => {
    expect(taskTime(task({ status: 'skipped', duration_ms: 0 }), Date.now())).toBe('')
    expect(taskTime(task(), Date.now())).toBe('')
  })
})

describe('categorySummary', () => {
  const done = (fields) => task({ status: 'done', ...fields })

  it('sums up each category from its finished agents', () => {
    expect(categorySummary('google', [done({ detail: serpDetail() }), done({ detail: serpDetail({ brand_positions: [12] }) })])).toBe('best #4')
    expect(categorySummary('google', [done({ detail: serpDetail({ brand_positions: [] }) })])).toBe('not in the pages searched')
    expect(
      categorySummary('engines', [
        done({ detail: engineDetail({ mentioned: true, rank: 3 }) }),
        done({ detail: engineDetail() }),
        task({ status: 'failed' }),
      ])
    ).toBe('named by 1 of 2 · 1 failed')
    expect(categorySummary('competitors', [done({ detail: {} }), done({ detail: {} })])).toBe('2 pages read')
    expect(categorySummary('competitors', [done({ detail: {} })])).toBe('1 page read')
    expect(
      categorySummary('site', [done({ worker: 'page_inspect', detail: {} }), done({ worker: 'content_gap', detail: gapDetail() })])
    ).toBe('2 gaps found')
    expect(categorySummary('sources', [done({ detail: citationsDetail() })])).toBe("you're not cited")
    const cited = citationsDetail({
      you_cited: true,
      sources: [{ domain: 'notion.so', citations: 2, engines: ['chatgpt', 'claude'], is_yours: true }],
    })
    expect(categorySummary('sources', [done({ detail: cited })])).toBe('cited by 2 engines')
  })

  it('says why when nothing was measured', () => {
    expect(categorySummary('google', [task({ status: 'skipped' }), task({ status: 'skipped' })])).toBe('2 skipped')
    expect(categorySummary('engines', [task({ status: 'failed' })])).toBe('1 failed')
    expect(categorySummary('engines', [])).toBe('')
  })
})

describe('groupTasks', () => {
  it('groups agents by category and prompt in the part order', () => {
    const groups = groupTasks(runningPart())
    expect(groups.map((g) => g.key)).toEqual(['google', 'engines', 'competitors', 'site', 'sources'])
    expect(groups[1].notes[0].code).toBe('engines_not_configured')
    expect(groups[1].subcategories).toEqual([
      { key: 'p1', label: 'best note taking app for teams', tasks: [runningTasks()[1], runningTasks()[2]] },
    ])
  })

  it('keeps a category that has only notes, and never drops an unlisted agent', () => {
    const part = runningPart({
      categories: [
        { key: 'engines', label: 'AI engines (GEO)', notes: [{ level: 'info', code: 'engines_not_configured', text: 'No engine is configured.' }], subcategories: [] },
      ],
      tasks: [task()],
    })
    const groups = groupTasks(part)
    expect(groups.map((g) => [g.key, g.tasks.length])).toEqual([
      ['engines', 0],
      ['google', 1],
    ])
    expect(groups[1].label).toBe('Google (SEO)')
    expect(groups[1].subcategories[0]).toMatchObject({ key: 'p1', label: '' })
  })
})

describe('detail texts', () => {
  it('states how an agent ended', () => {
    const [google, , claude] = finishedTasks()
    expect(detailStatusText(google)).toBe('Done in 15s')
    expect(detailStatusText(claude)).toBe('Failed after 1m 2s · attempt 2')
    expect(detailStatusText(task({ status: 'skipped', error: { code: 'not_configured', message: 'OPENAI_API_KEY is not set.' } }))).toBe(
      'Skipped: OPENAI_API_KEY is not set.'
    )
    expect(detailStatusText(task({ status: 'running' }), { swarmLive: false })).toBe('Not finished')
    expect(detailStatusText(task(), { waiting: 'Waiting for Google results' })).toBe('Waiting for Google results')
  })

  it('formats the Google, engine and page facts', () => {
    expect(positionsText([4, 12])).toBe('#4, #12')
    expect(positionsText([])).toBe('Not on this page')
    expect(overviewText(null)).toBe('Not shown')
    expect(overviewText({ shown: true, content_captured: false })).toBe('Shown, content not read')
    expect(overviewText({ shown: true, content_captured: true, mentions_you: true })).toBe('Names you')
    expect(overviewText({ shown: true, content_captured: true, mentions_you: false, cites_you: false })).toBe('Shown, not named')
    expect(namedText(engineDetail({ mentioned: true, rank: 3 }))).toBe('Yes, #3')
    expect(namedText(engineDetail({ mentioned: true, rank: null }))).toBe('Yes')
    expect(namedText(engineDetail())).toBe('No')
    expect(lengthText('Evernote', 34)).toBe('Evernote (34 characters)')
    expect(lengthText('', 0)).toBe('Missing')
    expect(capturedText(serpDetail())).toMatch(/^\d{2}:\d{2} via ScraperAPI$/)
    const reused = capturedText(serpDetail({ reused: true, captured_at: '2026-11-04T10:00:00Z', provider: 'serpapi' }), '2026-11-04T10:12:30Z')
    expect(reused).toMatch(/^\d{2}:\d{2} via SerpAPI · reused from 12m ago$/)
    expect(clockTime('2026-11-04T10:15:04.401Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(clockTime(null)).toBe('')
  })
})
