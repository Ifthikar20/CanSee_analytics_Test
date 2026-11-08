import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('../client', () => ({ default: client }))

const { default: agentApi } = await import('../agent')

beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset())
})

describe('api/agent: starting a turn', () => {
    it('posts the engines and the report template in the body, with the Idempotency-Key header, never retried on 429', () => {
        agentApi.sendMessage(
            'w1',
            'c 9',
            { text: 'Write the report', parent_id: 'm1', agent: 'gap_analyst', engines: ['claude', 'grok'], template: 'prompt_deep_dive' },
            { idempotencyKey: 'key-1' }
        )
        expect(client.post).toHaveBeenCalledTimes(1)
        const [url, body, config] = client.post.mock.calls[0]
        expect(url).toBe('/agent/live/websites/w1/chats/c%209/messages/')
        expect(body).toEqual({
            text: 'Write the report',
            parent_id: 'm1',
            agent: 'gap_analyst',
            engines: ['claude', 'grok'],
            template: 'prompt_deep_dive',
        })
        expect(config).toMatchObject({ _noRetry429: true, _silentError: true, headers: { 'Idempotency-Key': 'key-1' } })
    })

    it('leaves out empty fields and the header without a key', () => {
        agentApi.sendMessage('w1', 'c1', { text: 'Hi', parent_id: undefined, agent: null, engines: undefined, template: '' })
        const [, body, config] = client.post.mock.calls[0]
        expect(body).toEqual({ text: 'Hi' })
        expect(config.headers).toEqual({})
    })

    it('keeps headers the caller passed next to the key', () => {
        agentApi.sendMessage('w1', 'c1', { text: 'Hi' }, { idempotencyKey: 'k', headers: { 'X-Trace': 't' } })
        expect(client.post.mock.calls[0][2].headers).toEqual({ 'X-Trace': 't', 'Idempotency-Key': 'k' })
    })

    it('never retries a regenerate, an edit, a continue or a new chat on 429', () => {
        agentApi.regenerate('w1', 'm1')
        agentApi.editMessage('w1', 'm1', { text: 'New' })
        agentApi.continueMessage('w1', 'm1')
        agentApi.createChat('w1', { entry_agent: 'gap_analyst' })
        for (const call of client.post.mock.calls) expect(call[2]).toMatchObject({ _noRetry429: true })
        expect(client.post.mock.calls[3][1]).toEqual({ entry_agent: 'gap_analyst' })
    })
})
