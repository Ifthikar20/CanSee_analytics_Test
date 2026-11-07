import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ token: 'tok', refreshImpl: null }))

vi.mock('@/api/client', () => ({
    authHeaders: vi.fn(() => ({
        Authorization: `Bearer ${h.token}`,
        'X-Request-ID': 'req-1',
        'X-Client-Id': 'web-test',
    })),
    refreshAccessToken: vi.fn(async () => {
        if (h.refreshImpl) return h.refreshImpl()
        h.token = 'fresh'
        return 'fresh'
    }),
}))

import { refreshAccessToken } from '@/api/client'
import {
    AuthError,
    MaintenanceError,
    OfflineError,
    TransportError,
    UnsupportedTransport,
    jwtExpiresInMs,
    openRunStream,
} from '../streamClient'
import { pollRunEvents } from '../poller'

const encoder = new TextEncoder()

function frame(event, { id = event.seq, type = event.type } = {}) {
    return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`
}

function ev(seq, type, extra = {}) {
    return { v: 1, seq, type, run_id: 'r1', message_id: 'm1', ts: '2026-11-02T10:00:00Z', ...extra }
}

/** A streaming Response. `keepOpen` leaves the body open after the chunks. */
function sseResponse(chunks, { status = 200, contentType = 'text/event-stream; charset=utf-8', keepOpen = false, onCancel } = {}) {
    const stream = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c)
            if (!keepOpen) controller.close()
        },
        cancel(reason) {
            onCancel?.(reason)
        },
    })
    return new Response(stream, { status, headers: { 'Content-Type': contentType } })
}

function jsonResponse(status, body, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function jwt(payload) {
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`
}

let fetchMock

beforeEach(() => {
    h.token = 'tok'
    h.refreshImpl = null
    refreshAccessToken.mockClear()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('openRunStream', () => {
    it('streams contract events with auth and resume headers', async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse(['retry: 3000\n: connected\n\n', frame(ev(6, 'part.added', { part: { id: 'p1', type: 'text', text: '' } }))])
        )
        const events = []
        const retries = []
        const comments = []
        const onBytes = vi.fn()
        const onOpen = vi.fn()
        const result = await openRunStream({
            runId: 'r1',
            lastSeq: 5,
            onEvent: (e) => events.push(e),
            onRetry: (ms) => retries.push(ms),
            onComment: (c) => comments.push(c),
            onBytes,
            onOpen,
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('/api/v1/agent/live/runs/r1/stream/')
        expect(init.headers).toMatchObject({
            Accept: 'text/event-stream',
            'Last-Event-ID': '5',
            Authorization: 'Bearer tok',
            'X-Client-Id': 'web-test',
        })
        expect(init.cache).toBe('no-store')
        expect(events).toEqual([ev(6, 'part.added', { part: { id: 'p1', type: 'text', text: '' } })])
        expect(retries).toEqual([3000])
        expect(comments).toEqual(['connected'])
        expect(onOpen).toHaveBeenCalledTimes(1)
        expect(onBytes).toHaveBeenCalled()
        expect(result.reason).toBe('eof')
        expect(result.lastEventId).toBe('6')
    })

    it('sends no Last-Event-ID before the first event', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([': ok\n\n']))
        await openRunStream({ runId: 'r1', lastSeq: 0, onEvent: () => {} })
        expect(fetchMock.mock.calls[0][1].headers['Last-Event-ID']).toBeUndefined()
    })

    it('stops reading at a terminal event and cancels the body', async () => {
        const onCancel = vi.fn()
        fetchMock.mockResolvedValueOnce(
            sseResponse(
                [frame(ev(1, 'run.started', { model: 'claude-opus-5-5' })) + frame(ev(2, 'run.completed', { status: 'complete' })) + frame(ev(3, 'part.added'))],
                { keepOpen: true, onCancel }
            )
        )
        const events = []
        const result = await openRunStream({ runId: 'r1', onEvent: (e) => events.push(e) })
        expect(result.reason).toBe('terminal')
        expect(events.map((e) => e.type)).toEqual(['run.started', 'run.completed'])
        expect(onCancel).toHaveBeenCalled()
    })

    it('returns reconnect when the server ends the stream with event: reconnect', async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse([frame(ev(4, 'part.delta', { part_id: 'p1', field: 'text', append: 'Hi' })), 'event: reconnect\ndata: {}\n\n'], {
                keepOpen: true,
            })
        )
        const events = []
        const result = await openRunStream({ runId: 'r1', onEvent: (e) => events.push(e) })
        expect(result.reason).toBe('reconnect')
        expect(events).toHaveLength(1)
    })

    it('stops when onEvent returns false', async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse([frame(ev(1, 'resync', { reason: 'buffer' })) + frame(ev(2, 'part.added'))], { keepOpen: true })
        )
        const seen = []
        const result = await openRunStream({
            runId: 'r1',
            onEvent: (e) => {
                seen.push(e.type)
                return e.type !== 'resync'
            },
        })
        expect(result.reason).toBe('stopped')
        expect(seen).toEqual(['resync'])
    })

    it('fills seq from the SSE id and the type from the event field', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['id: 12\nevent: run.usage\ndata: {"cost_usd":0.5}\n\n']))
        const events = []
        await openRunStream({ runId: 'r1', onEvent: (e) => events.push(e) })
        expect(events).toEqual([{ cost_usd: 0.5, seq: 12, type: 'run.usage' }])
    })

    it('skips frames whose data is not JSON', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['data: not json\n\n', frame(ev(2, 'run.usage'))]))
        const events = []
        await openRunStream({ runId: 'r1', onEvent: (e) => events.push(e) })
        expect(events.map((e) => e.seq)).toEqual([2])
    })

    it('reassembles CRLF line ends and multi-byte characters split across network chunks', async () => {
        const text = frame(ev(3, 'part.delta', { part_id: 'p1', field: 'text', append: 'café' })).replace(/\n/g, '\r\n')
        const bytes = encoder.encode(text)
        const cut = bytes.indexOf(0xc3) + 1 // inside the two-byte "é"
        const crlf = bytes.indexOf(13) + 1 // between a CR and its LF
        const pieces = [bytes.slice(0, crlf), bytes.slice(crlf, cut), bytes.slice(cut)]
        fetchMock.mockResolvedValueOnce(sseResponse(pieces))
        const events = []
        await openRunStream({ runId: 'r1', onEvent: (e) => events.push(e) })
        expect(events).toHaveLength(1)
        expect(events[0].append).toBe('café')
    })

    it('refreshes once after a 401 and retries with the new token', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(401, { success: false, error: { code: 'not_authenticated' } }))
            .mockResolvedValueOnce(sseResponse([frame(ev(1, 'run.started'))]))
        const events = []
        await openRunStream({ runId: 'r1', onEvent: (e) => events.push(e) })
        expect(refreshAccessToken).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh')
        expect(events).toHaveLength(1)
    })

    it('throws AuthError when the retry is still unauthorized', async () => {
        fetchMock.mockResolvedValue(jsonResponse(401, {}))
        await expect(openRunStream({ runId: 'r1', onEvent: () => {} })).rejects.toBeInstanceOf(AuthError)
        expect(refreshAccessToken).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('throws AuthError when the refresh is refused', async () => {
        h.refreshImpl = () => {
            // The client signs the user out on a refused refresh.
            h.token = ''
            return Promise.reject(Object.assign(new Error('refresh refused'), { response: { status: 401 } }))
        }
        fetchMock.mockResolvedValueOnce(jsonResponse(401, {}))
        const err = await openRunStream({ runId: 'r1', onEvent: () => {} }).catch((e) => e)
        expect(err).toBeInstanceOf(AuthError)
        expect(err.fatal).toBe(true)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('throws AuthError when the session was already over', async () => {
        h.refreshImpl = () => {
            h.token = ''
            return Promise.reject(new Error('Session expired'))
        }
        fetchMock.mockResolvedValueOnce(jsonResponse(401, {}))
        await expect(openRunStream({ runId: 'r1', onEvent: () => {} })).rejects.toBeInstanceOf(AuthError)
    })

    it('treats a refresh that fails with a 5xx as retryable, not as a sign-out', async () => {
        h.refreshImpl = () => Promise.reject(Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }))
        fetchMock.mockResolvedValueOnce(jsonResponse(401, {}))
        const err = await openRunStream({ runId: 'r1', onEvent: () => {} }).catch((e) => e)
        expect(err).toBeInstanceOf(TransportError)
        expect(err).not.toBeInstanceOf(AuthError)
        expect(err).toMatchObject({ status: 502, retryable: true, fatal: false })
    })

    it('treats a refresh lost to the network as offline', async () => {
        h.refreshImpl = () => Promise.reject(new Error('Network Error'))
        fetchMock.mockResolvedValueOnce(jsonResponse(401, {}))
        const err = await openRunStream({ runId: 'r1', onEvent: () => {} }).catch((e) => e)
        expect(err).toBeInstanceOf(OfflineError)
        expect(err).toMatchObject({ code: 'network', retryable: true, fatal: false })
    })

    it.each([404, 405, 406])('reports %i as an unsupported transport', async (status) => {
        fetchMock.mockResolvedValueOnce(jsonResponse(status, {}))
        await expect(openRunStream({ runId: 'r1', onEvent: () => {} })).rejects.toBeInstanceOf(UnsupportedTransport)
    })

    it('reports a non-SSE content type as an unsupported transport', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: {} }))
        await expect(openRunStream({ runId: 'r1', onEvent: () => {} })).rejects.toBeInstanceOf(UnsupportedTransport)
    })

    it('maps 503 agent_unavailable (and a bare 503) to OfflineError', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(503, { success: false, error: { code: 'agent_unavailable', message: 'The agent is temporarily unavailable.' } }, { 'Retry-After': '15' })
        )
        const err = await openRunStream({ runId: 'r1', onEvent: () => {} }).catch((e) => e)
        expect(err).toBeInstanceOf(OfflineError)
        expect(err.code).toBe('agent_unavailable')
        expect(err.retryAfterMs).toBe(15000)
        expect(err.retryable).toBe(true)

        fetchMock.mockResolvedValueOnce(new Response('maintenance', { status: 503 }))
        await expect(openRunStream({ runId: 'r1', onEvent: () => {} })).rejects.toBeInstanceOf(OfflineError)
    })

    it("maps nginx's 503 maintenance to MaintenanceError, which waits for Retry-After", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                503,
                { success: false, error: { code: 'maintenance', message: 'Cansee is down for maintenance. Try again in a few minutes.' } },
                { 'Retry-After': '120' }
            )
        )
        const err = await openRunStream({ runId: 'r1', onEvent: () => {} }).catch((e) => e)
        expect(err).toBeInstanceOf(MaintenanceError)
        expect(err).not.toBeInstanceOf(OfflineError)
        expect(err).toMatchObject({ status: 503, code: 'maintenance', retryable: true, fatal: false, retryAfterMs: 120000 })
        expect(err.serverMessage).toBe('Cansee is down for maintenance. Try again in a few minutes.')
    })

    it('treats agent_disabled as fatal and 5xx as retryable', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false, error: { code: 'agent_disabled', message: 'off' } }))
        const disabled = await openRunStream({ runId: 'r1', onEvent: () => {} }).catch((e) => e)
        expect(disabled).toBeInstanceOf(TransportError)
        expect(disabled.fatal).toBe(true)
        expect(disabled.code).toBe('agent_disabled')
        expect(disabled.serverMessage).toBe('off')

        fetchMock.mockResolvedValueOnce(jsonResponse(500, {}))
        const server = await openRunStream({ runId: 'r1', onEvent: () => {} }).catch((e) => e)
        expect(server.retryable).toBe(true)
        expect(server.fatal).toBe(false)
    })

    it('maps a network failure to OfflineError with code network', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
        const err = await openRunStream({ runId: 'r1', onEvent: () => {} }).catch((e) => e)
        expect(err).toBeInstanceOf(OfflineError)
        expect(err.code).toBe('network')
    })

    it('rejects with an AbortError when aborted mid-stream', async () => {
        const ctrl = new AbortController()
        fetchMock.mockImplementationOnce((url, init) => {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(frame(ev(1, 'run.started'))))
                    init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
                },
            })
            return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
        })
        const events = []
        const pending = openRunStream({
            runId: 'r1',
            signal: ctrl.signal,
            onEvent: (e) => {
                events.push(e)
                ctrl.abort()
            },
        })
        const err = await pending.catch((e) => e)
        expect(err.name).toBe('AbortError')
        expect(events).toHaveLength(1)
    })

    it('refreshes first when the access token expires within a minute', async () => {
        h.token = jwt({ user_id: 1, exp: Math.floor(Date.now() / 1000) + 30 })
        fetchMock.mockResolvedValueOnce(sseResponse([': ok\n\n']))
        await openRunStream({ runId: 'r1', onEvent: () => {} })
        expect(refreshAccessToken).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer fresh')
    })

    it('does not refresh a token with time left', async () => {
        h.token = jwt({ user_id: 1, exp: Math.floor(Date.now() / 1000) + 3600 })
        fetchMock.mockResolvedValueOnce(sseResponse([': ok\n\n']))
        await openRunStream({ runId: 'r1', onEvent: () => {} })
        expect(refreshAccessToken).not.toHaveBeenCalled()
    })
})

describe('jwtExpiresInMs', () => {
    it('reads exp from the payload', () => {
        const now = 1_800_000_000_000
        expect(jwtExpiresInMs(jwt({ exp: 1_800_000_060 }), now)).toBe(60000)
    })

    it('returns null for tokens it cannot read', () => {
        expect(jwtExpiresInMs('opaque')).toBeNull()
        expect(jwtExpiresInMs(jwt({ sub: 1 }))).toBeNull()
        expect(jwtExpiresInMs(null)).toBeNull()
    })
})

describe('pollRunEvents', () => {
    it('requests after/wait and reads the unenveloped body', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(200, { events: [ev(8, 'part.added')], next_after: 8, terminal: false, run_status: 'running' })
        )
        const out = await pollRunEvents({ runId: 'r1', after: 7, wait: 25 })
        expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/agent/live/runs/r1/events/?after=7&wait=25')
        expect(out).toEqual({ events: [ev(8, 'part.added')], nextAfter: 8, terminal: false, runStatus: 'running' })
    })

    it('throws the classified error for a failed poll', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false, error: { code: 'not_found' } }))
        const err = await pollRunEvents({ runId: 'r1', after: 0 }).catch((e) => e)
        expect(err).toBeInstanceOf(TransportError)
        expect(err.status).toBe(404)
        expect(err.fatal).toBe(true)
    })
})
