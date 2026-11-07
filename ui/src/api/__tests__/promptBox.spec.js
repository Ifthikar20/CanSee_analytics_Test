import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../client', () => ({ default: client }))

const { default: promptBox } = await import('../promptBox')

beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset())
})

describe('api/promptBox', () => {
    it('estimates quietly, with no side effects', () => {
        promptBox.estimate('w1', { text: 'best crm', samples: 3, engines: ['chatgpt'] })
        expect(client.post).toHaveBeenCalledWith(
            '/prompt-box/websites/w1/estimate/',
            { text: 'best crm', samples: 3, engines: ['chatgpt'] },
            { _silentError: true },
        )
    })

    it('never retries asking, stopping or tracking on 429', () => {
        const confirm = { answers: 6, ai_usd_max: '0.4800' }
        promptBox.create('w1', { text: 'best crm', samples: 3, confirm })
        promptBox.cancel('w1', 'r1')
        promptBox.track('w1', 'best crm')
        expect(client.post.mock.calls).toEqual([
            ['/prompt-box/websites/w1/runs/', { text: 'best crm', samples: 3, confirm }, { _silentError: true, _noRetry429: true }],
            ['/prompt-box/websites/w1/runs/r1/cancel/', {}, { _silentError: true, _noRetry429: true }],
            // Track this prompt: tracked without a second scan.
            ['/prompt-library/websites/w1/prompts/', { text: 'best crm', scan: false }, { _silentError: true, _noRetry429: true }],
        ])
    })

    it('reads the runs, one run, and one run in full', () => {
        promptBox.list('w1')
        promptBox.get('w1', 'r1')
        promptBox.get('w1', 'r1', { full: true })
        expect(client.get.mock.calls).toEqual([
            ['/prompt-box/websites/w1/runs/', { _silentError: true }],
            ['/prompt-box/websites/w1/runs/r1/', { _silentError: true }],
            ['/prompt-box/websites/w1/runs/r1/', { params: { full: 1 }, _silentError: true }],
        ])
    })
})
