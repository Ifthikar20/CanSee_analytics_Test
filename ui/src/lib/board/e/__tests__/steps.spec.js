// The Next steps block's model: the server's setup issues and the two
// things the ranking payload can ask for, in order, and "All set" only when
// every payload was read.
import { describe, expect, it } from 'vitest'
import { COPY, RESEARCH_DOWN, setupFacts, stepsModel, unknownText, visibleSteps } from '../steps'

const issue = (over = {}) => ({
    code: 'engine_not_configured', severity: 'limited', subject: 'engine', engine: 'grok', setting: null,
    title: "Grok isn't set up on this workspace.", action: 'Grok is skipped; the other engines still answer.', ...over,
})
const GOOGLE = issue({ code: 'google_not_configured', subject: 'google', engine: null, title: "Google results aren't set up on this workspace.", action: 'Google positions stay empty until they are.' })
const AGENT = issue({ code: 'agent_not_configured', severity: 'blocking', subject: 'agent', engine: null, title: "The research agents aren't set up on this workspace.", action: 'Ask your workspace admin.' })

const status = (over = {}) => ({
    engines: [{ key: 'chatgpt', label: 'ChatGPT', configured: true }, { key: 'claude', label: 'Claude', configured: true }],
    google: { configured: true },
    research: { available: true, message: '' },
    setup: { ready: true, issues: [] },
    ...over,
})
const ranking = (count = 9, enabled = true) => ({ tracked: { count, limit: 100 }, autopilot: { enabled }, prompts: [] })
const keys = (m) => m.rows.map((r) => r.key.split(':')[0])

describe('stepsModel', () => {
    it('is all set when the status and the ranking were read and ask for nothing', () => {
        const m = stepsModel({ status: status(), ranking: ranking() })
        expect(m).toMatchObject({ known: true, rows: [], issues: 0, actions: 0, unknown: [], allSet: true, summary: '' })
        expect(m.sentence).toBe('Everything is set up for this project.')
    })

    it("lists what is not set up in the server's words, blocking first, without a link", () => {
        const m = stepsModel({ status: status({ setup: { issues: [issue(), GOOGLE, AGENT] } }), ranking: ranking() })
        expect(m.rows.map((r) => [r.index, r.kind, r.severity, r.title])).toEqual([
            ['01', 'issue', 'blocking', AGENT.title],
            ['02', 'issue', 'limited', issue().title],
            ['03', 'issue', 'limited', GOOGLE.title],
        ])
        expect(m.rows[1].body).toBe('Grok is skipped; the other engines still answer.')
        for (const row of m.rows) {
            expect(row.to).toBeUndefined()
            expect(row.action).toBeUndefined()
        }
        expect(m).toMatchObject({ issues: 3, actions: 0, allSet: false, summary: '3 not set up' })
    })

    it('shows a setting name only when the server sent one', () => {
        const plain = stepsModel({ status: status({ setup: { issues: [issue()] } }), ranking: ranking() })
        expect(plain.rows[0].setting).toBe('')
        const staff = stepsModel({ status: status({ setup: { issues: [issue({ setting: 'XAI_API_KEY' })] } }), ranking: ranking() })
        expect(staff.rows[0].setting).toBe('XAI_API_KEY')
    })

    it('leaves out notes that ask for nothing and issues about the plan', () => {
        const m = stepsModel({
            status: status({
                setup: {
                    issues: [
                        issue({ severity: 'info', title: 'Perplexity answers with live web results.' }),
                        issue({ code: 'prompt_runs_low', subject: 'prompt_runs', title: '3 of your 20 free prompt runs are left this month.' }),
                        issue({ title: '   ' }),
                    ],
                },
            }),
            ranking: ranking(),
        })
        expect(m.rows).toEqual([])
        expect(m.allSet).toBe(true)
    })

    it('says the research agents are down when no blocking issue already does', () => {
        const down = { available: false, message: 'All research agents are busy. Try again in a few minutes.' }
        const m = stepsModel({ status: status({ research: down }), ranking: ranking() })
        expect(m.rows).toHaveLength(1)
        expect(m.rows[0]).toMatchObject({ key: 'research', kind: 'issue', title: RESEARCH_DOWN, body: down.message })
        // Without a reason from the server there is no second line, and none is made up.
        expect(stepsModel({ status: status({ research: { available: false } }), ranking: ranking() }).rows[0].body).toBe('')
        // A blocking issue is the reason: it is not said twice.
        const blocked = stepsModel({ status: status({ research: down, setup: { issues: [AGENT] } }), ranking: ranking() })
        expect(keys(blocked)).toEqual(['agent_not_configured'])
    })

    it('asks for prompts when none is tracked and for Autopilot when it is off, each with a way forward', () => {
        const m = stepsModel({ status: status(), ranking: ranking(0, false) })
        expect(m.rows).toEqual([
            { key: 'prompts', index: '01', kind: 'action', severity: 'todo', ...COPY.prompts, setting: '', action: 'add-prompts' },
            { key: 'autopilot', index: '02', kind: 'action', severity: 'todo', ...COPY.autopilot, setting: '', to: { name: 'settings-autopilot' } },
        ])
        expect(m).toMatchObject({ issues: 0, actions: 2, summary: '2 to do', allSet: false })
        expect(m.sentence).toBe('2 steps for this project: Track your first prompts; Turn on Autopilot.')
        expect(keys(stepsModel({ status: status(), ranking: ranking(3, false) }))).toEqual(['autopilot'])
        expect(keys(stepsModel({ status: status(), ranking: ranking(0, true) }))).toEqual(['prompts'])
        expect(stepsModel({ status: status(), ranking: ranking(0, true) }).sentence).toBe('1 step for this project: Track your first prompts.')
    })

    it('puts what is not set up before what to do, numbered through', () => {
        const m = stepsModel({ status: status({ setup: { issues: [GOOGLE] } }), ranking: ranking(0, false) })
        expect(m.rows.map((r) => [r.index, r.kind])).toEqual([['01', 'issue'], ['02', 'action'], ['03', 'action']])
        expect(m.summary).toBe('1 not set up, 2 to do')
        expect(m.sentence).toBe(
            "3 steps for this project: Google results aren't set up on this workspace; Track your first prompts; Turn on Autopilot.",
        )
    })

    it('never says all set for what it could not read', () => {
        const noRanking = stepsModel({ status: status(), ranking: null })
        expect(noRanking).toMatchObject({ known: true, rows: [], unknown: ['prompts', 'autopilot'], allSet: false, sentence: '' })
        // A ranking payload without the fields is as unknown as none.
        expect(stepsModel({ status: status(), ranking: {} }).unknown).toEqual(['prompts', 'autopilot'])
        expect(stepsModel({ status: status(), ranking: { tracked: { count: 'x' }, autopilot: { enabled: 'yes' } } }).unknown).toEqual(['prompts', 'autopilot'])
        expect(stepsModel({ status: status(), ranking: { tracked: { count: 4 } } }).unknown).toEqual(['autopilot'])
        expect(stepsModel({ status: status(), ranking: { tracked: { count: -1 }, autopilot: { enabled: true } } }).unknown).toEqual(['prompts'])
        const noStatus = stepsModel({ status: null, ranking: ranking() })
        expect(noStatus).toMatchObject({ known: false, rows: [], allSet: false })
        expect(stepsModel()).toMatchObject({ known: false, rows: [], allSet: false, unknown: ['prompts', 'autopilot'] })
        // The ranking still speaks when the status is missing.
        expect(keys(stepsModel({ status: null, ranking: ranking(0, false) }))).toEqual(['prompts', 'autopilot'])
    })

    it('reads a status without a setup block as nothing to fix', () => {
        expect(stepsModel({ status: {}, ranking: ranking() })).toMatchObject({ known: true, rows: [], allSet: true })
        expect(stepsModel({ status: { setup: { issues: 'none' } }, ranking: ranking() }).rows).toEqual([])
    })
})

describe('setupFacts', () => {
    it('states what the payloads state, and nothing else', () => {
        expect(setupFacts(status(), ranking(12, true))).toEqual([
            { key: 'engines', label: 'AI engines', value: '2 of 2' },
            { key: 'google', label: 'Google results', value: 'On' },
            { key: 'research', label: 'Research agents', value: 'Ready' },
            { key: 'prompts', label: 'Prompts tracked', value: '12' },
            { key: 'autopilot', label: 'Autopilot', value: 'On' },
        ])
    })

    it('counts the engines that are set up and leaves out what is off or unknown', () => {
        const s = status({
            engines: [{ key: 'chatgpt', configured: true }, { key: 'grok', configured: false }, { key: '', configured: true }, null],
            google: { configured: false },
            research: { available: false },
        })
        expect(setupFacts(s, ranking(1234, false))).toEqual([
            { key: 'engines', label: 'AI engines', value: '1 of 2' },
            { key: 'prompts', label: 'Prompts tracked', value: '1,234' },
        ])
        expect(setupFacts(null, null)).toEqual([])
        expect(setupFacts({ engines: [] }, {})).toEqual([])
    })
})

describe('unknownText and visibleSteps', () => {
    it('names what could not be checked', () => {
        expect(unknownText(['prompts', 'autopilot'])).toBe("We couldn't check your prompts and Autopilot.")
        expect(unknownText(['autopilot'])).toBe("We couldn't check Autopilot.")
        expect(unknownText([])).toBe('')
        expect(unknownText(null)).toBe('')
        expect(unknownText(['else'])).toBe('')
    })

    it('shows the first rows and counts the rest', () => {
        const rows = ['a', 'b', 'c', 'd', 'e']
        expect(visibleSteps(rows, 3)).toEqual({ shown: ['a', 'b', 'c'], more: 2 })
        expect(visibleSteps(rows, 5)).toEqual({ shown: rows, more: 0 })
        expect(visibleSteps(rows, 9)).toEqual({ shown: rows, more: 0 })
        expect(visibleSteps(rows)).toEqual({ shown: rows, more: 0 })
        expect(visibleSteps(rows, 0)).toEqual({ shown: rows, more: 0 })
        expect(visibleSteps(null, 3)).toEqual({ shown: [], more: 0 })
    })
})
