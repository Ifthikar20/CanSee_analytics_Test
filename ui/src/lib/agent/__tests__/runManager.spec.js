import { describe, expect, it, vi } from 'vitest'

// The transports are injected below; the real client (and the router it
// imports) is never needed.
vi.mock('@/api/client', () => ({ authHeaders: () => ({}), refreshAccessToken: async () => '' }))

import { createRunManager, SSE_FAILURES_BEFORE_POLL } from '../runManager'
import { AuthError, MaintenanceError, TransportError, UnsupportedTransport } from '../streamClient'

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
})
