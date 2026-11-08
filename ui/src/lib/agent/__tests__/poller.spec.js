import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchWithAuth = vi.fn()
vi.mock('../streamClient', () => ({
    AGENT_LIVE_BASE: '/api/v1/agent/live',
    errorFromResponse: async (res) => new Error(`HTTP ${res.status}`),
    fetchWithAuth: (...args) => fetchWithAuth(...args),
}))

const { pollRunEvents } = await import('../poller')

function answer(body) {
    return { ok: true, status: 200, json: async () => body }
}

beforeEach(() => fetchWithAuth.mockReset())

describe('pollRunEvents', () => {
    it("reads the run's place in line while it waits", async () => {
        fetchWithAuth.mockResolvedValueOnce(
            answer({ events: [], next_after: 0, terminal: false, run_status: 'queued', queue: { position: 2, ahead: 1, slots: 6 } })
        )
        const out = await pollRunEvents({ runId: 'r1', after: 0, wait: 25 })
        expect(out.queue).toEqual({ position: 2, ahead: 1, slots: 6 })
        expect(out.runStatus).toBe('queued')
    })

    it('says null when the server reports the run is not waiting, and undefined when it says nothing', async () => {
        fetchWithAuth.mockResolvedValueOnce(answer({ events: [], next_after: 3, terminal: false, run_status: 'running', queue: null }))
        expect((await pollRunEvents({ runId: 'r1', after: 3 })).queue).toBeNull()
        fetchWithAuth.mockResolvedValueOnce(answer({ events: [], next_after: 3, terminal: false, run_status: 'running' }))
        expect((await pollRunEvents({ runId: 'r1', after: 3 })).queue).toBeUndefined()
    })
})
