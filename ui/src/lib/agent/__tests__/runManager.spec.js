import { describe, expect, it, vi } from 'vitest'

// The transports are injected below; the real client (and the router it
// imports) is never needed.
vi.mock('@/api/client', () => ({ authHeaders: () => ({}), refreshAccessToken: async () => '' }))

import { createRunManager, OFFLINE_CHECK_MS, SSE_FAILURES_BEFORE_POLL } from '../runManager'
import { AuthError, MaintenanceError, OfflineError, TransportError, UnsupportedTransport } from '../streamClient'

const ev = (seq, type = 'part.delta', extra = {}) => ({ v: 1, seq, type, run_id: 'r1', message_id: 'm1', ...extra })
const microtask = (fn) => {
    let live = true
    queueMicrotask(() => live && fn())
    return () => {
        live = false
    }
}

/** openStream fake: delivers `events` through onEvent, then resolves with `reason`. */
function streamOf(events, reason = 'eof') {
    return async ({ onOpen, onEvent, onBytes }) => {
        onOpen?.()
        for (const e of events) {
            onBytes?.()
            const keep = onEvent(e)
            if (e.type.startsWith('run.') && ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(e.type)) {
                return { reason: 'terminal' }
            }
            if (keep === false) return { reason: 'stopped' }
        }
        return { reason }
    }
}

function hanging() {
    return ({ signal }) =>
        new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
}

function setup(overrides = {}) {
    const batches = []
    const states = []
    const hooks = {
        applyEvents: vi.fn((runId, events) => batches.push(events.map((e) => e.seq))),
        onTransport: vi.fn((runId, t) => states.push(`${t.mode}:${t.state}`)),
        onResync: vi.fn(async () => ({ active: true, lastSeq: 0 })),
        onClose: vi.fn(),
        openStream: vi.fn(),
        poll: vi.fn(),
        schedule: microtask,
        backoff: vi.fn(() => 0),
        sleep: vi.fn(() => Promise.resolve()),
        ...overrides,
    }
    const manager = createRunManager(hooks)
    return { manager, hooks, batches, states }
}

describe('runManager', () => {
    it('streams to the terminal event and hands events over in one batch per frame', async () => {
        const { manager, hooks, batches, states } = setup()
        hooks.openStream.mockImplementationOnce(streamOf([ev(1, 'run.started'), ev(2), ev(3, 'run.completed')]))
        const session = manager.attach({ id: 'r1', lastSeq: 0 })
        await session.done
        expect(batches).toEqual([[1, 2, 3]])
        expect(hooks.openStream).toHaveBeenCalledTimes(1)
        expect(hooks.openStream.mock.calls[0][0]).toMatchObject({ runId: 'r1', lastSeq: 0 })
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
        expect(states).toEqual(['sse:connecting', 'sse:open', 'sse:closed'])
        expect(manager.isAttached('r1')).toBe(false)
    })

    it('resumes after a server reconnect from the last seq and drops duplicates', async () => {
        const { manager, hooks, batches } = setup()
        hooks.openStream
            .mockImplementationOnce(streamOf([ev(4), ev(5)], 'reconnect'))
            .mockImplementationOnce(streamOf([ev(5), ev(6), ev(7, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 3 }).done
        expect(hooks.openStream.mock.calls.map((c) => c[0].lastSeq)).toEqual([3, 5])
        expect(batches.flat()).toEqual([4, 5, 6, 7])
        expect(hooks.backoff).not.toHaveBeenCalled()
    })

    it('backs off on failures and falls back to long-polling after repeated SSE failures', async () => {
        const { manager, hooks, batches, states } = setup()
        hooks.openStream.mockRejectedValue(new TransportError('HTTP 502', { status: 502 }))
        hooks.poll.mockResolvedValueOnce({ events: [ev(1), ev(2, 'run.completed')], terminal: true })
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.openStream).toHaveBeenCalledTimes(SSE_FAILURES_BEFORE_POLL)
        expect(hooks.backoff.mock.calls.slice(0, 5).map((c) => c[0])).toEqual([0, 1, 2, 3, 4])
        expect(hooks.poll).toHaveBeenCalledTimes(1)
        expect(hooks.poll.mock.calls[0][0]).toMatchObject({ runId: 'r1', after: 0, wait: 25 })
        expect(batches.flat()).toEqual([1, 2])
        expect(states).toContain('sse:reconnecting')
        expect(states).toContain('poll:open')
    })

    it('uses the server retry interval as the backoff base', async () => {
        const { manager, hooks } = setup()
        hooks.openStream
            .mockImplementationOnce(async ({ onRetry }) => {
                onRetry(3000)
                throw new TransportError('HTTP 500', { status: 500 })
            })
            .mockImplementationOnce(streamOf([ev(1, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.backoff).toHaveBeenCalledWith(0, { base: 3000 })
    })

    it('reports maintenance and waits for its Retry-After before trying again', async () => {
        const { manager, hooks, batches, states } = setup()
        hooks.openStream
            .mockRejectedValueOnce(new MaintenanceError('maintenance', { retryAfterMs: 120000 }))
            .mockImplementationOnce(streamOf([ev(1, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(states.slice(0, 2)).toEqual(['sse:connecting', 'sse:maintenance'])
        expect(states).not.toContain('sse:offline')
        expect(hooks.sleep.mock.calls[0][0]).toBe(120000)
        expect(batches.flat()).toEqual([1])
    })

    it('switches to long-polling at once when SSE is unsupported', async () => {
        const { manager, hooks } = setup()
        hooks.openStream.mockRejectedValueOnce(new UnsupportedTransport('406', { status: 406 }))
        hooks.poll
            .mockResolvedValueOnce({ events: [ev(1)], terminal: false })
            .mockResolvedValueOnce({ events: [ev(2, 'run.cancelled')], terminal: true })
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.openStream).toHaveBeenCalledTimes(1)
        expect(hooks.poll.mock.calls.map((c) => c[0].after)).toEqual([0, 1])
        expect(hooks.backoff).not.toHaveBeenCalled()
    })

    it('counts a stream that closes without events as a failure', async () => {
        const { manager, hooks } = setup()
        hooks.openStream.mockImplementationOnce(streamOf([], 'eof')).mockImplementationOnce(streamOf([ev(1, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.backoff).toHaveBeenCalledTimes(1)
    })

    it('aborts a stream that goes silent and reconnects', async () => {
        const { manager, hooks } = setup({ watchdogMs: 20 })
        hooks.openStream.mockImplementationOnce(hanging()).mockImplementationOnce(streamOf([ev(1, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.openStream).toHaveBeenCalledTimes(2)
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })

    it('pauses for resync and resumes from the snapshot seq', async () => {
        const { manager, hooks, batches } = setup()
        hooks.onResync.mockResolvedValueOnce({ active: true, lastSeq: 7 })
        hooks.openStream
            .mockImplementationOnce(streamOf([ev(1), ev(2, 'resync', { reason: 'buffer_expired' }), ev(3)]))
            .mockImplementationOnce(streamOf([ev(8), ev(9, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.onResync).toHaveBeenCalledWith('r1', 'buffer_expired')
        expect(hooks.openStream.mock.calls[1][0].lastSeq).toBe(7)
        expect(batches.flat()).toEqual([1, 8, 9])
    })

    it('ends as terminal when resync finds the run finished', async () => {
        const { manager, hooks } = setup()
        hooks.onResync.mockResolvedValueOnce({ active: false, lastSeq: 12 })
        hooks.openStream.mockImplementationOnce(streamOf([ev(1, 'resync', { reason: 'restart' })]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.openStream).toHaveBeenCalledTimes(1)
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })

    it('gives up after repeated resyncs without progress', async () => {
        const { manager, hooks } = setup()
        hooks.onResync.mockResolvedValue({ active: true, lastSeq: 0 })
        hooks.openStream.mockImplementation(streamOf([ev(1, 'resync', { reason: 'loop' })]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        const [, info] = hooks.onClose.mock.calls[0]
        expect(info.terminal).toBe(false)
        expect(info.error.code).toBe('resync_failed')
        expect(hooks.onResync).toHaveBeenCalledTimes(3)
    })

    it('reloads the snapshot when a poll reports the run over without its terminal event', async () => {
        const { manager, hooks } = setup()
        hooks.openStream.mockRejectedValueOnce(new UnsupportedTransport('404', { status: 404 }))
        hooks.poll.mockResolvedValueOnce({ events: [ev(1)], terminal: true })
        hooks.onResync.mockResolvedValueOnce({ active: false, lastSeq: 1 })
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.onResync).toHaveBeenCalledWith('r1', 'terminal_without_event')
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })

    it('ends with the error on a fatal failure', async () => {
        const { manager, hooks } = setup()
        const err = new AuthError()
        hooks.openStream.mockRejectedValueOnce(err)
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: false, error: err })
        expect(hooks.backoff).not.toHaveBeenCalled()
    })

    it('detaches without calling onClose and flushes what it already received', async () => {
        const { manager, hooks, batches, states } = setup()
        hooks.openStream.mockImplementationOnce(({ onEvent, signal }) => {
            onEvent(ev(1))
            return hanging()({ signal })
        })
        const session = manager.attach({ id: 'r1', lastSeq: 0 })
        await Promise.resolve()
        manager.detach('r1')
        await session.done
        expect(batches.flat()).toEqual([1])
        expect(hooks.onClose).not.toHaveBeenCalled()
        expect(states.at(-1)).toBe('sse:closed')
        expect(manager.isAttached('r1')).toBe(false)
    })

    it('keeps one session per run', async () => {
        const { manager, hooks } = setup()
        hooks.openStream.mockImplementation(hanging())
        const a = manager.attach({ id: 'r1', lastSeq: 0 })
        const b = manager.attach({ id: 'r1', lastSeq: 9 })
        expect(b).toBe(a)
        manager.detachAll()
        await a.done
        expect(hooks.openStream).toHaveBeenCalledTimes(1)
    })

    it('retries a snapshot that could not be loaded without counting it as a resync that did not converge', async () => {
        const { manager, hooks, states } = setup()
        // The buffer was trimmed: every read asks for a resync.
        hooks.openStream.mockImplementation(streamOf([ev(1, 'resync', { reason: 'buffer_expired' })]))
        // The web API fails four times (a short gunicorn outage), then answers.
        hooks.onResync
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error('HTTP 502'))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ active: false, lastSeq: 40 })
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.onResync).toHaveBeenCalledTimes(5)
        expect(hooks.onResync.mock.calls.every((c) => c[1] === 'buffer_expired')).toBe(true)
        // The snapshot is asked again with a backoff, not the stream.
        expect(hooks.openStream).toHaveBeenCalledTimes(1)
        expect(hooks.backoff.mock.calls.map((c) => c[0])).toEqual([0, 1, 2, 3])
        expect(states).toContain('sse:reconnecting')
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })

    it('still gives up when loaded snapshots never converge, failures in between not counted', async () => {
        const { manager, hooks } = setup()
        hooks.openStream.mockImplementation(streamOf([ev(1, 'resync', { reason: 'loop' })]))
        hooks.onResync
            .mockResolvedValueOnce({ active: true, lastSeq: 0 })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ active: true, lastSeq: 0 })
            .mockResolvedValueOnce({ active: true, lastSeq: 0 })
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.onResync).toHaveBeenCalledTimes(4)
        expect(hooks.onClose.mock.calls[0][1].error.code).toBe('resync_failed')
    })

    /** A clock the fake sleep moves forward, so offline time passes without waiting. */
    function offlineSetup(overrides = {}) {
        let t = 0
        const ctx = setup({
            now: () => t,
            sleep: vi.fn(async (ms) => {
                t += Math.max(ms, 5000)
            }),
            ...overrides,
        })
        // Give up the test (instead of hanging) if the session never asks the server.
        let calls = 0
        ctx.hooks.openStream.mockImplementation(async (args) => {
            calls += 1
            if (calls > 60) return streamOf([ev(99, 'run.completed')])(args)
            throw new OfflineError('agent unavailable')
        })
        ctx.hooks.poll.mockImplementation(async () => {
            calls += 1
            if (calls > 60) return { events: [ev(99, 'run.completed')], terminal: true }
            throw new OfflineError('agent unavailable')
        })
        return ctx
    }

    it('asks the web API while the agent cannot be reached and ends when the server has ended the run', async () => {
        const { manager, hooks, batches, states } = offlineSetup()
        // Before AGENT_STALE_SECONDS the server still lists the run; then its sweeper ends it.
        hooks.onResync.mockResolvedValueOnce({ active: true, lastSeq: 4 }).mockResolvedValueOnce({ active: false, lastSeq: 4 })
        await manager.attach({ id: 'r1', lastSeq: 2 }).done
        expect(states).toContain('sse:offline')
        expect(hooks.onResync).toHaveBeenCalledTimes(2)
        expect(hooks.onResync.mock.calls[0]).toEqual(['r1', 'agent_unavailable'])
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
        expect(batches.flat()).not.toContain(99)
    })

    it('waits OFFLINE_CHECK_MS of being unreachable before it asks, and asks again on that cadence', async () => {
        const asked = []
        let t = 0
        const { manager, hooks } = offlineSetup({
            now: () => t,
            sleep: vi.fn(async () => {
                t += 5000
            }),
        })
        hooks.onResync.mockImplementation(async () => {
            asked.push(t)
            return asked.length < 3 ? { active: true, lastSeq: 0 } : { active: false, lastSeq: 0 }
        })
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(asked.length).toBe(3)
        expect(asked[0]).toBeGreaterThanOrEqual(OFFLINE_CHECK_MS)
        expect(asked[1] - asked[0]).toBeGreaterThanOrEqual(OFFLINE_CHECK_MS)
        expect(asked[2] - asked[1]).toBeGreaterThanOrEqual(OFFLINE_CHECK_MS)
        // Exactly on the cadence: unreachable since t=0, sleeps of 5 s, so the
        // server is asked at 30 s, 60 s and 90 s, never later.
        expect(asked).toEqual([OFFLINE_CHECK_MS, 2 * OFFLINE_CHECK_MS, 3 * OFFLINE_CHECK_MS])
    })

    it('keeps trying when the web API cannot be asked either', async () => {
        const { manager, hooks } = offlineSetup()
        hooks.onResync
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error('network'))
            .mockResolvedValueOnce({ active: false, lastSeq: 0 })
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.onResync).toHaveBeenCalledTimes(3)
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })

    it('starts the offline clock again once the agent answers', async () => {
        let t = 0
        const { manager, hooks } = setup({
            now: () => t,
            sleep: vi.fn(async () => {
                t += 20000
            }),
        })
        // Offline 20 s, back, offline 20 s: never 30 s in a row, so the server is not asked.
        hooks.openStream
            .mockRejectedValueOnce(new OfflineError())
            .mockImplementationOnce(streamOf([ev(1)], 'reconnect'))
            .mockRejectedValueOnce(new OfflineError())
            .mockImplementationOnce(streamOf([ev(2, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.onResync).not.toHaveBeenCalled()
    })

    it('nudge cuts the backoff short, and an unreachable session asks the server at once', async () => {
        // Sleeps last until they are cut short.
        const sleep = vi.fn((ms, signal) => new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true })))
        const { manager, hooks } = setup({ sleep, now: () => 0 })
        hooks.openStream.mockRejectedValue(new OfflineError())
        hooks.onResync.mockResolvedValueOnce({ active: false, lastSeq: 0 })
        const session = manager.attach({ id: 'r1', lastSeq: 0 })
        await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1))
        expect(hooks.onResync).not.toHaveBeenCalled()
        manager.nudge()
        await session.done
        expect(hooks.openStream).toHaveBeenCalledTimes(2)
        expect(hooks.onResync).toHaveBeenCalledWith('r1', 'agent_unavailable')
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })

    it('nudge only retries sooner while the agent is reachable', async () => {
        const sleep = vi.fn((ms, signal) => new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true })))
        const { manager, hooks } = setup({ sleep, now: () => 0 })
        hooks.openStream
            .mockRejectedValueOnce(new TransportError('HTTP 502', { status: 502 }))
            .mockImplementationOnce(streamOf([ev(1, 'run.completed')]))
        const session = manager.attach({ id: 'r1', lastSeq: 0 })
        await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1))
        manager.nudge()
        await session.done
        expect(hooks.onResync).not.toHaveBeenCalled()
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })

    it('hands the place in line from a poll answer to onQueue', async () => {
        const onQueue = vi.fn()
        const { manager, hooks } = setup({ onQueue })
        hooks.openStream.mockRejectedValueOnce(new UnsupportedTransport('404', { status: 404 }))
        hooks.poll
            .mockResolvedValueOnce({ events: [], terminal: false, queue: { position: 2, ahead: 1, slots: 6 } })
            .mockResolvedValueOnce({ events: [ev(1, 'run.started')], terminal: false, queue: null })
            .mockResolvedValueOnce({ events: [ev(2, 'run.completed')], terminal: true })
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(onQueue.mock.calls).toEqual([
            ['r1', { position: 2, ahead: 1, slots: 6 }],
            ['r1', null],
        ])
    })
})

describe('runManager: when the offline clock starts again', () => {
    function clocked() {
        let t = 0
        const ctx = setup({
            now: () => t,
            sleep: vi.fn(async () => {
                t += 20000
            }),
        })
        return ctx
    }

    it('a stream that opened restarts the clock even when it then drops offline', async () => {
        const { manager, hooks, batches } = clocked()
        // Offline at 0 s; at 20 s the stream opens, delivers, and drops as
        // offline; at 40 s offline again (20 s since it last answered); then done.
        hooks.openStream
            .mockRejectedValueOnce(new OfflineError())
            .mockImplementationOnce(async ({ onOpen, onEvent, onBytes }) => {
                onOpen?.()
                onBytes?.()
                onEvent(ev(1))
                throw new OfflineError()
            })
            .mockRejectedValueOnce(new OfflineError())
            .mockImplementationOnce(streamOf([ev(2, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(batches.flat()).toEqual([1, 2])
        expect(hooks.onResync).not.toHaveBeenCalled()
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })

    it('a server error between two offline spells restarts the clock', async () => {
        const { manager, hooks } = clocked()
        hooks.openStream
            .mockRejectedValueOnce(new OfflineError())
            .mockRejectedValueOnce(new TransportError('HTTP 502', { status: 502 }))
            .mockRejectedValueOnce(new OfflineError())
            .mockImplementationOnce(streamOf([ev(1, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        expect(hooks.onResync).not.toHaveBeenCalled()
    })

    it('maintenance between two offline spells does not restart the clock', async () => {
        const { manager, hooks } = clocked()
        hooks.onResync.mockResolvedValueOnce({ active: false, lastSeq: 0 })
        hooks.openStream
            .mockRejectedValueOnce(new OfflineError())
            .mockRejectedValueOnce(new MaintenanceError('maintenance', { retryAfterMs: 1000 }))
            .mockRejectedValueOnce(new OfflineError())
            .mockImplementationOnce(streamOf([ev(1, 'run.completed')]))
        await manager.attach({ id: 'r1', lastSeq: 0 }).done
        // Unreachable since 0 s: at 40 s the server is asked and has ended the run.
        expect(hooks.onResync).toHaveBeenCalledTimes(1)
        expect(hooks.onResync).toHaveBeenCalledWith('r1', 'agent_unavailable')
        expect(hooks.openStream).toHaveBeenCalledTimes(3)
        expect(hooks.onClose).toHaveBeenCalledWith('r1', { terminal: true, error: null })
    })
})
