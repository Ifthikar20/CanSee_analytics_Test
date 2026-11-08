import { describe, expect, it } from 'vitest'
import { agentFix, settingFor, settingsVisible } from '../setup'

// GET agent/status/ as the server sends it to a customer, and to staff (or
// on a DEBUG server): only the latter carries setting names.
const customer = {
    configured: false,
    engines: [{ key: 'chatgpt', label: 'ChatGPT', configured: false, key_setting: '' }],
    google: { configured: false, key_settings: [] },
    setup: {
        ready: false,
        issues: [{ code: 'agent_not_configured', severity: 'blocking', setting: null, title: '', action: '' }],
    },
}
const staff = {
    configured: false,
    engines: [{ key: 'chatgpt', label: 'ChatGPT', configured: false, key_setting: 'OPENAI_API_KEY' }],
    google: { configured: false, key_settings: ['SERPAPI_KEY', 'SCRAPERAPI_KEY'] },
    setup: {
        ready: false,
        issues: [{ code: 'agent_not_configured', severity: 'blocking', setting: 'ANTHROPIC_API_KEY', title: '', action: '' }],
    },
}
const prod = { dev: false }

describe('agent setup hints', () => {
    it('shows setting names only when the server reveals them, or on a local dev build', () => {
        expect(settingsVisible(customer, prod)).toBe(false)
        expect(settingsVisible(null, prod)).toBe(false)
        expect(settingsVisible(staff, prod)).toBe(true)
        expect(settingsVisible({ engines: [{ key_setting: 'XAI_API_KEY' }] }, prod)).toBe(true)
        expect(settingsVisible(customer, { dev: true })).toBe(true)
    })

    it('names ANTHROPIC_API_KEY for a missing agent key to staff, never to customers', () => {
        expect(settingFor('agent_not_configured', staff, prod)).toBe('ANTHROPIC_API_KEY')
        expect(settingFor('agent_not_configured', customer, prod)).toBe('')
        const fixCustomer = agentFix('agent_not_configured', customer, prod)
        expect(fixCustomer.customer).toBe('Ask your workspace admin to add the Anthropic API key.')
        expect(fixCustomer.staff).toBe('')
        expect(agentFix('agent_not_configured', staff, prod).staff).toContain('Set ANTHROPIC_API_KEY on the server')
        // An older server without the setup block: the dev build still names it.
        expect(agentFix('agent_not_configured', {}, { dev: true }).staff).toContain('ANTHROPIC_API_KEY')
    })

    it('says what to do while the agent is down', () => {
        expect(agentFix('agent_unavailable', customer, prod)).toEqual({
            customer: 'Try again in a minute. If it stays down, contact support.',
            staff: '',
        })
        expect(agentFix('agent_unavailable', staff, prod).staff).toBe(
            'Check that the agent process is running. It also needs ANTHROPIC_API_KEY to answer.'
        )
        expect(agentFix('upstream_error', staff, prod)).toEqual({ customer: '', staff: '' })
    })
})
