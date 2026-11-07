import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { apiError, run, runEstimate, runOptions } from './__fixtures__/insightRuns'

const api = vi.hoisted(() => ({
  runOptions: vi.fn(),
  estimate: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}))
vi.mock('@/api/insights', () => ({ default: api }))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { INSIGHT_RUN_POLL_MS, injectInsightRun, useInsightRun } = await import('../useInsightRun')

const mounted = []

function setup(kind = 'answer_analysis', { websiteId = ref('w1'), onFinished = vi.fn() } = {}) {
  let runner
  let injected
  const Child = defineComponent({
    setup() {
      injected = injectInsightRun(kind)
      return () => h('div')
    },
  })
  const Host = defineComponent({
    setup() {
      runner = useInsightRun(kind, { websiteId, onFinished })
      return () => h(Child)
    },
  })
  const wrapper = mount(Host)
  mounted.push(wrapper)
  return { runner, injected: () => injected, wrapper, websiteId, onFinished }
}

function setHidden(hidden) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.values(api).forEach((fn) => fn.mockReset())
  Object.values(toast).forEach((fn) => fn.mockReset())
  api.runOptions.mockResolvedValue({ data: runOptions() })
  api.estimate.mockResolvedValue({ data: runEstimate() })
  setHidden(false)
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
})

describe('useInsightRun', () => {
  it('loads the options for the kind and gives itself to the dialog of that kind', async () => {
    const { runner, injected } = setup('site_audit')
    await flushPromises()
    expect(api.runOptions).toHaveBeenCalledWith('w1', 'site_audit')
    expect(runner.options.value.enabled).toBe(true)
    expect(injected()).toBe(runner)
    expect(runner.run.value).toBeNull()
  })

  it('adopts the active run and polls it every 3 s until it ends, then calls onFinished once', async () => {
    api.runOptions.mockResolvedValue({ data: runOptions('answer_analysis', { active_run: run() }) })
    api.getRun.mockResolvedValueOnce({ data: run({ progress: { total: 40, queued: 10, running: 2, done: 27, failed: 1, skipped: 0, cancelled: 0 } }) })
    api.getRun.mockResolvedValueOnce({ data: run({ status: 'done', duration_ms: 42000 }) })
    const { runner, onFinished } = setup()
    await flushPromises()
    expect(runner.run.value.status).toBe('running')
    expect(runner.active.value).toBe(true)
    expect(api.getRun).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(INSIGHT_RUN_POLL_MS)
    expect(api.getRun).toHaveBeenCalledTimes(1)
    expect(api.getRun).toHaveBeenCalledWith('w1', run().id)
    expect(runner.run.value.progress.done).toBe(27)
    expect(onFinished).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(INSIGHT_RUN_POLL_MS)
    expect(runner.run.value.status).toBe('done')
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }))
    // The options are read again; polling stopped.
    expect(api.runOptions).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(INSIGHT_RUN_POLL_MS * 3)
    expect(api.getRun).toHaveBeenCalledTimes(2)
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  it('pauses polling while the tab is hidden and reads at once when it is shown', async () => {
    api.runOptions.mockResolvedValue({ data: runOptions('answer_analysis', { active_run: run() }) })
    api.getRun.mockResolvedValue({ data: run() })
    setup()
    await flushPromises()
    setHidden(true)
    await vi.advanceTimersByTimeAsync(INSIGHT_RUN_POLL_MS * 4)
    expect(api.getRun).not.toHaveBeenCalled()
    setHidden(false)
    await flushPromises()
    expect(api.getRun).toHaveBeenCalledTimes(1)
  })

  it('stops polling on unmount', async () => {
    api.runOptions.mockResolvedValue({ data: runOptions('answer_analysis', { active_run: run() }) })
    api.getRun.mockResolvedValue({ data: run() })
    const { wrapper } = setup()
    await flushPromises()
    mounted.splice(mounted.indexOf(wrapper), 1)
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(INSIGHT_RUN_POLL_MS * 3)
    expect(api.getRun).not.toHaveBeenCalled()
  })

  it('posts the estimate 300 ms after the last change, keeping the previous one meanwhile', async () => {
    const { runner } = setup()
    await flushPromises()
    runner.open({ period: '30d', engines: null, prompt_ids: null, reanalyze: false })
    expect(runner.isOpen.value).toBe(true)
    expect(runner.estimating.value).toBe(true)
    await vi.advanceTimersByTimeAsync(299)
    expect(api.estimate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.estimate).toHaveBeenCalledWith('w1', {
      kind: 'answer_analysis',
      params: { period: '30d', engines: null, prompt_ids: null, reanalyze: false },
    })
    await flushPromises()
    expect(runner.estimate.value.ai.usd_max).toBe('0.2400')
    expect(runner.canStart.value).toBe(true)

    const first = runner.estimate.value
    runner.update({ period: '90d' })
    runner.update({ reanalyze: true })
    expect(runner.estimate.value).toBe(first)
    expect(runner.canStart.value).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(api.estimate).toHaveBeenCalledTimes(2)
    expect(api.estimate).toHaveBeenLastCalledWith('w1', {
      kind: 'answer_analysis',
      params: { period: '90d', engines: null, prompt_ids: null, reanalyze: true },
    })
  })

  it('shows the error of an estimate that failed and stays unable to start', async () => {
    api.estimate.mockRejectedValue(apiError(400, 'invalid', 'Choose an engine this server has.'))
    const { runner } = setup()
    await flushPromises()
    runner.open({ period: '30d' })
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(runner.estimate.value).toBeNull()
    expect(runner.error.value).toBe('Choose an engine this server has.')
    expect(runner.canStart.value).toBe(false)
  })

  it('starts with the estimate confirm, closes, toasts and tracks the new run', async () => {
    api.startRun.mockResolvedValue({ data: run({ status: 'queued' }) })
    const { runner } = setup()
    await flushPromises()
    runner.open({ period: '30d' })
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    const created = await runner.start()
    expect(api.startRun).toHaveBeenCalledWith('w1', {
      kind: 'answer_analysis',
      params: { period: '30d' },
      confirm: { ai_calls: 80, ai_usd_max: '0.2400', google_pages: 0 },
    })
    expect(created.status).toBe('queued')
    expect(runner.isOpen.value).toBe(false)
    expect(runner.run.value.id).toBe(run().id)
    expect(toast.success).toHaveBeenCalledWith('Answer analysis started.')
  })

  it('replaces the estimate when the cost changed and waits for a new confirm', async () => {
    const changed = runEstimate('answer_analysis', { confirm: { ai_calls: 90, ai_usd_max: '0.2700', google_pages: 0 } })
    api.startRun.mockRejectedValueOnce(
      apiError(409, 'estimate_changed', 'The estimate changed.', { estimate: changed }),
    )
    const { runner } = setup()
    await flushPromises()
    runner.open({ period: '30d' })
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(await runner.start()).toBeNull()
    expect(runner.estimate.value).toEqual(changed)
    expect(runner.changedNote.value).toBe('The cost changed. Check the new estimate and confirm again.')
    expect(runner.isOpen.value).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()

    api.startRun.mockResolvedValueOnce({ data: run({ status: 'queued' }) })
    await runner.start()
    expect(api.startRun).toHaveBeenLastCalledWith('w1', expect.objectContaining({ confirm: changed.confirm }))
  })

  it('shows other start errors in words and never starts without a runnable estimate', async () => {
    api.estimate.mockResolvedValue({
      data: runEstimate('answer_analysis', {
        can_run: false,
        blockers: [{ code: 'allowance_exceeded', status: 403, message: 'You have used your monthly AI allowance.' }],
      }),
    })
    const { runner } = setup()
    await flushPromises()
    runner.open({ period: '30d' })
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(runner.canStart.value).toBe(false)
    expect(await runner.start()).toBeNull()
    expect(api.startRun).not.toHaveBeenCalled()

    api.estimate.mockResolvedValue({ data: runEstimate() })
    runner.update({ period: '7d' })
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    api.startRun.mockRejectedValueOnce(
      apiError(409, 'run_in_progress', 'Answer analysis is already running for this project.'),
    )
    await runner.start()
    expect(runner.error.value).toBe('Answer analysis is already running for this project.')
    expect(runner.isOpen.value).toBe(true)
  })

  it('stops the run on request; a stop that fails says so', async () => {
    api.runOptions.mockResolvedValue({ data: runOptions('answer_analysis', { active_run: run() }) })
    api.cancelRun.mockResolvedValueOnce({ data: run({ cancel_requested: true }) })
    const { runner } = setup()
    await flushPromises()
    await runner.stop()
    expect(api.cancelRun).toHaveBeenCalledWith('w1', run().id)
    expect(runner.stopping.value).toBe(true)

    api.cancelRun.mockRejectedValueOnce(apiError(500, 'server_error', ''))
    runner.track(run())
    await runner.stop()
    expect(runner.stopping.value).toBe(false)
    expect(runner.stopError.value).toBeTruthy()
  })

  it('starts over when the project changes', async () => {
    api.runOptions.mockResolvedValueOnce({ data: runOptions('answer_analysis', { active_run: run() }) })
    const { runner, websiteId } = setup()
    await flushPromises()
    expect(runner.run.value).not.toBeNull()
    runner.open({ period: '30d' })
    websiteId.value = 'w2'
    await nextTick()
    expect(runner.run.value).toBeNull()
    expect(runner.isOpen.value).toBe(false)
    await flushPromises()
    expect(api.runOptions).toHaveBeenLastCalledWith('w2', 'answer_analysis')
  })

  it('says when the options could not load', async () => {
    api.runOptions.mockRejectedValue(apiError(503, 'insights_disabled', 'Insights are turned off on this server.'))
    const { runner } = setup()
    await flushPromises()
    expect(runner.options.value).toBeNull()
    expect(runner.optionsError.value).toBe('Insights are turned off on this server.')
    expect(runner.optionsFailure.value).toMatchObject({ status: 503, code: 'insights_disabled' })
  })
})
