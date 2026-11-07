import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'

const promptBox = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/promptBox', () => ({ default: promptBox }))

const { POLL_MS } = await import('../specs')
const { noteRunAsked, rememberTracked, resetPromptBoxNotes, runsVersion, trackedOf, usePromptBoxRun } = await import(
    '../usePromptBoxRun'
)
const { doneRun, httpError, ok, runPayload } = await import('./__fixtures__/payloads')

const scopes = []

function follow(websiteId = 'w1') {
    const scope = effectScope()
    scopes.push(scope)
    const runner = scope.run(() => usePromptBoxRun(websiteId))
    return { runner, scope }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    promptBox.get.mockReset()
    resetPromptBoxNotes()
})

afterEach(() => {
    while (scopes.length) scopes.pop().stop()
    vi.useRealTimers()
})

describe('usePromptBoxRun', () => {
    it('polls every 1.5 s while the run asks, and stops at a terminal status', async () => {
        promptBox.get
            .mockResolvedValueOnce(ok(runPayload()))
            .mockResolvedValueOnce(ok(runPayload({ progress: { total: 6, done: 4, failed: 0, running: 2 } })))
            .mockResolvedValueOnce(ok(doneRun()))
        const { runner } = follow()
        runner.follow('r-1')
        await flushPromises()
        expect(promptBox.get).toHaveBeenCalledWith('w1', 'r-1')
        expect(runner.active.value).toBe(true)

        await vi.advanceTimersByTimeAsync(POLL_MS - 1)
        expect(promptBox.get).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await flushPromises()
        expect(promptBox.get).toHaveBeenCalledTimes(2)
        expect(runner.run.value.progress.done).toBe(4)

        await vi.advanceTimersByTimeAsync(POLL_MS)
        await flushPromises()
        expect(promptBox.get).toHaveBeenCalledTimes(3)
        expect(runner.run.value.status).toBe('done')
        expect(runner.active.value).toBe(false)

        await vi.advanceTimersByTimeAsync(POLL_MS * 10)
        expect(promptBox.get).toHaveBeenCalledTimes(3)
    })

    it('stops when its component goes away', async () => {
        promptBox.get.mockResolvedValue(ok(runPayload()))
        const { runner, scope } = follow()
        runner.follow('r-1')
        await flushPromises()
        scope.stop()
        await vi.advanceTimersByTimeAsync(POLL_MS * 4)
        expect(promptBox.get).toHaveBeenCalledTimes(1)
    })

    it('stops on a project change and drops a late answer for the old project', async () => {
        let answer
        promptBox.get.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
        const wid = ref('w1')
        const { runner } = follow(wid)
        runner.follow('r-1')
        wid.value = 'w2'
        await nextTick()
        answer(ok(runPayload()))
        await flushPromises()
        expect(runner.run.value).toBeNull()
        await vi.advanceTimersByTimeAsync(POLL_MS * 4)
        expect(promptBox.get).toHaveBeenCalledTimes(1)
    })

    it('shows a run in hand and polls it while it asks', async () => {
        promptBox.get.mockResolvedValue(ok(doneRun()))
        const { runner } = follow()
        runner.show(runPayload())
        expect(runner.run.value.id).toBe('r-1')
        expect(promptBox.get).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(POLL_MS)
        await flushPromises()
        expect(promptBox.get).toHaveBeenCalledTimes(1)
        expect(runner.run.value.status).toBe('done')
        // A finished run in hand is not polled.
        runner.show(doneRun({ id: 'r-2' }))
        await vi.advanceTimersByTimeAsync(POLL_MS * 4)
        expect(promptBox.get).toHaveBeenCalledTimes(1)
    })

    it('keeps the last answer when a poll fails and tries again more slowly; a run that is gone stops', async () => {
        promptBox.get
            .mockResolvedValueOnce(ok(runPayload()))
            .mockRejectedValueOnce(httpError(503, 'error', 'Unavailable.'))
            .mockResolvedValueOnce(ok(runPayload()))
            .mockRejectedValueOnce(httpError(404, 'not_found', 'Run not found.'))
        const { runner } = follow()
        runner.follow('r-1')
        await flushPromises()
        await vi.advanceTimersByTimeAsync(POLL_MS)
        await flushPromises()
        expect(runner.stale.value).toBe(true)
        expect(runner.run.value.id).toBe('r-1')
        // Twice the interval after one miss.
        await vi.advanceTimersByTimeAsync(POLL_MS * 2 - 1)
        expect(promptBox.get).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(1)
        await flushPromises()
        expect(promptBox.get).toHaveBeenCalledTimes(3)
        expect(runner.stale.value).toBe(false)
        await vi.advanceTimersByTimeAsync(POLL_MS)
        await flushPromises()
        expect(runner.failure.value.status).toBe(404)
        await vi.advanceTimersByTimeAsync(POLL_MS * 20)
        expect(promptBox.get).toHaveBeenCalledTimes(4)
    })

    it('shows a summary in hand at once while the full run loads', async () => {
        let answer
        promptBox.get.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
        const { runner } = follow()
        const summary = { ...doneRun(), engines: [] }
        runner.follow('r-1', { initial: summary })
        expect(runner.run.value).toBe(summary)
        answer(ok(doneRun()))
        await flushPromises()
        expect(runner.run.value.engines).toHaveLength(2)
    })
})

describe('the notes the card and the panel share', () => {
    it('count the runs asked per project and remember tracked questions by their words', () => {
        expect(runsVersion('w1')).toBe(0)
        noteRunAsked('w1')
        noteRunAsked('w1')
        expect(runsVersion('w1')).toBe(2)
        expect(runsVersion('w2')).toBe(0)
        rememberTracked('w1', ' best  crm ', { prompt_id: 'p-1', brand_prompt_id: 'bp-1' })
        expect(trackedOf('w1', 'best crm')).toEqual({ prompt_id: 'p-1', brand_prompt_id: 'bp-1' })
        expect(trackedOf('w2', 'best crm')).toBeNull()
    })
})
