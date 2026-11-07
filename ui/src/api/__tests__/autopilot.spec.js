import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))
vi.mock('../client', () => ({ default: client }))

const { default: autopilot } = await import('../autopilot')
const { default: billing } = await import('../billing')

beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset())
})

describe('api/autopilot', () => {
    it('reads quietly', () => {
        autopilot.get('w1')
        autopilot.runs('w1')
        autopilot.run('w1', 'r1')
        expect(client.get.mock.calls).toEqual([
            ['/autopilot/websites/w1/', { _silentError: true }],
            ['/autopilot/websites/w1/runs/', { _silentError: true }],
            ['/autopilot/websites/w1/runs/r1/', { _silentError: true }],
        ])
    })

    it('never retries a save, a run or a test text on 429', () => {
        autopilot.save('w1', { enabled: true })
        autopilot.runNow('w1', { answers: 18, ai_usd_max: '1.4400', google_pages: 9 })
        autopilot.testText('w1')
        expect(client.put.mock.calls).toEqual([['/autopilot/websites/w1/', { enabled: true }, { _silentError: true, _noRetry429: true }]])
        expect(client.post.mock.calls).toEqual([
            [
                '/autopilot/websites/w1/run/',
                { confirm: { answers: 18, ai_usd_max: '1.4400', google_pages: 9 } },
                { _silentError: true, _noRetry429: true },
            ],
            ['/autopilot/websites/w1/text/test/', {}, { _silentError: true, _noRetry429: true }],
        ])
    })

    it('estimates and stops quietly', () => {
        autopilot.estimate('w1')
        autopilot.cancel('w1', 'r1')
        expect(client.post.mock.calls).toEqual([
            ['/autopilot/websites/w1/run/estimate/', {}, { _silentError: true }],
            ['/autopilot/websites/w1/runs/r1/cancel/', {}, { _silentError: true }],
        ])
    })
})

describe('api/billing', () => {
    it('opens a checkout quietly and keeps the change-plan path', () => {
        billing.checkout({ plan: 'prompts_100' })
        billing.changePlan({ plan: 'prompts_200' }, { _silentError: true })
        billing.changePlan({ annual: true })
        expect(client.post.mock.calls).toEqual([
            ['/billing/checkout/', { plan: 'prompts_100' }, { _silentError: true }],
            ['/billing/change-plan/', { plan: 'prompts_200' }, { _silentError: true }],
            ['/billing/change-plan/', { annual: true }, undefined],
        ])
    })
})
