// What the Next steps card shows in each state: the server's setup issues
// and the two things the ranking payload can ask for, as numbered rows,
// "All set" only when everything was read, and what it tells its frame.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { GOOGLE_ISSUE, agentStatus, rankingPayload, setupIssue } = await import('./__fixtures__/payloads')
const { default: NextStepsCard } = await import('../NextStepsCard.vue')

const mounted = []

async function render({ props = {}, status = agentStatus(), ranking = rankingPayload(), stores = null } = {}) {
    if (ranking) setSource('ranking', ranking.failure ? ranking : { data: ranking })
    const out = await mountOnBoard(NextStepsCard, {
        props,
        stores: (s) => {
            s.agent.status = status
            if (stores) stores(s)
        },
    })
    mounted.push(out.wrapper)
    return out
}

const issues = (...list) => agentStatus({ setup: { ready: false, issues: list } })
const rows = (wrapper) => wrapper.findAll('.ns-row').map((r) => [r.find('.ns-index').text(), r.find('.ns-title').text()])
const button = (wrapper, label) => wrapper.findAll('button').find((b) => b.text() === label)
const CHATGPT = setupIssue({ engine: 'chatgpt', title: "ChatGPT isn't set up on this workspace.", action: 'ChatGPT is skipped.' })

beforeEach(() => resetSources())

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe('NextStepsCard with steps', () => {
    it('numbers what is not set up, then what to do, the first one in the accent', async () => {
        const { wrapper, last } = await render({ status: issues(setupIssue(), GOOGLE_ISSUE), ranking: rankingPayload(0, false) })
        expect(rows(wrapper)).toEqual([
            ['01', "Grok isn't set up on this workspace."],
            ['02', "Google results aren't set up on this workspace."],
            ['03', 'Track your first prompts'],
            ['04', 'Turn on Autopilot'],
        ])
        expect(wrapper.findAll('.ns-row.is-next')).toHaveLength(1)
        expect(wrapper.findAll('.ns-row')[0].classes()).toContain('is-next')
        expect(wrapper.find('.bd-foot-text').text()).toBe('2 not set up, 2 to do')
        expect(wrapper.find('.ns-sr').text()).toBe(
            "4 steps for this project: Grok isn't set up on this workspace; Google results aren't set up on this workspace; Track your first prompts; Turn on Autopilot.",
        )
        expect(last()).toBe('live')
    })

    it('links what the user can do and leaves what the workspace must fix as words', async () => {
        const { wrapper, board } = await render({ status: issues(setupIssue()), ranking: rankingPayload(0, false) })
        const [issue, prompts, autopilot] = wrapper.findAll('.ns-row')
        expect(issue.find('a, button').exists()).toBe(false)
        expect(issue.find('.ns-arrow').exists()).toBe(false)

        expect(autopilot.find('a.ns-link').attributes('href')).toBe('/settings/autopilot')
        expect(autopilot.find('.ns-arrow').attributes('aria-hidden')).toBe('true')

        const add = prompts.find('button.ns-link')
        expect(add.text()).toBe('Track your first prompts')
        await add.trigger('click')
        expect(board.open).toHaveBeenCalledWith('prompts', { add: '1' })
    })

    it('checks again on request: the status and the ranking', async () => {
        const { wrapper, agent } = await render({ status: issues(setupIssue()) })
        expect(agent.loadStatus).not.toHaveBeenCalled()
        await button(wrapper, 'Check again').trigger('click')
        expect(agent.loadStatus).toHaveBeenCalledTimes(1)
        expect(reloadOf('ranking')).toHaveBeenCalledTimes(1)
        // While a check runs the button is busy and a second click asks nothing.
        agent.statusLoading = true
        await wrapper.vm.$nextTick()
        const busy = wrapper.find('.bd-foot-link button')
        expect(busy.attributes('aria-busy')).toBe('true')
        expect(busy.attributes('disabled')).toBeDefined()
        expect(wrapper.find('.ns-list').exists()).toBe(true)
    })

    it('offers no Check again when nothing is the workspace’s to fix', async () => {
        const { wrapper } = await render({ ranking: rankingPayload(4, false) })
        expect(rows(wrapper)).toEqual([['01', 'Turn on Autopilot']])
        expect(wrapper.find('.bd-foot-text').text()).toBe('1 to do')
        expect(wrapper.find('.bd-foot-link').exists()).toBe(false)
    })

    it('gives each row its second line when there is room for it', async () => {
        const few = await render({ ranking: rankingPayload(0, false) })
        expect(few.wrapper.find('.ns').classes()).toContain('is-roomy')
        expect(few.wrapper.findAll('.ns-body').map((p) => p.text())[1]).toBe(
            'Autopilot asks your tracked prompts every day, so you see when an answer changes.',
        )
        const many = await render({ status: issues(setupIssue(), GOOGLE_ISSUE), ranking: rankingPayload(0, false) })
        expect(many.wrapper.find('.ns').classes()).not.toContain('is-roomy')
    })

    it('shows three rows and a way to the rest when there are more than four', async () => {
        const { wrapper, board } = await render({ status: issues(CHATGPT, setupIssue(), GOOGLE_ISSUE), ranking: rankingPayload(0, false) })
        expect(rows(wrapper).map((r) => r[0])).toEqual(['01', '02', '03'])
        expect(wrapper.find('.bd-foot-text').text()).toBe('3 not set up, 2 to do')
        expect(button(wrapper, 'Check again')).toBeUndefined()
        await button(wrapper, '2 more').trigger('click')
        expect(board.open).toHaveBeenCalledWith('next-steps')
        // Exactly four fit.
        const four = await render({ status: issues(setupIssue(), GOOGLE_ISSUE), ranking: rankingPayload(0, false) })
        expect(rows(four.wrapper)).toHaveLength(4)
        expect(button(four.wrapper, 'Check again')).toBeDefined()
    })

    it('shows every row, its setting when the server sent one and what is in place at full size', async () => {
        // Staff see setting names: the server sends one with each engine's issue.
        const status = issues({ ...CHATGPT, setting: 'OPENAI_API_KEY' }, setupIssue({ setting: 'XAI_API_KEY' }), GOOGLE_ISSUE)
        const { wrapper } = await render({ props: { size: 'full' }, status, ranking: rankingPayload(0, false) })
        expect(rows(wrapper)).toHaveLength(5)
        expect(wrapper.find('.ns').classes()).toEqual(expect.arrayContaining(['is-full', 'is-roomy']))
        expect(wrapper.findAll('.ns-setting').map((p) => p.text())).toEqual(['Setting: OPENAI_API_KEY', 'Setting: XAI_API_KEY'])
        expect(wrapper.findAll('.ns-row')[2].find('.ns-setting').exists()).toBe(false)
        expect(button(wrapper, 'Check again')).toBeDefined()
        expect(wrapper.find('.ns-place-title').text()).toBe('In place')
        expect(wrapper.findAll('.ns-place .ns-fact').map((f) => f.text().replace(/\s+/g, ' '))).toEqual([
            'AI engines2 of 2',
            'Google resultsOn',
            'Research agentsReady',
            'Prompts tracked0',
        ])
        // A compact card names no setting and lists nothing in place.
        const compact = await render({ status: issues(setupIssue({ setting: 'XAI_API_KEY' })) })
        expect(compact.wrapper.find('.ns-setting').exists()).toBe(false)
        expect(compact.wrapper.find('.ns-place').exists()).toBe(false)
    })

    it('says what it could not check beside the steps it knows, and calls that stale', async () => {
        const { wrapper, last } = await render({ status: issues(setupIssue()), ranking: { failure: { status: 500, code: 'error' } } })
        expect(rows(wrapper)).toEqual([['01', "Grok isn't set up on this workspace."]])
        expect(wrapper.find('.bd-foot-text').text()).toBe("1 not set up. We couldn't check your prompts and Autopilot.")
        expect(last()).toBe('stale')
    })
})

describe('NextStepsCard with nothing to do', () => {
    it('says all set and lists what is in place, each line from a payload', async () => {
        const { wrapper, last } = await render({ ranking: rankingPayload(12, true) })
        expect(wrapper.find('.ns-done-title').text()).toBe('All set')
        expect(wrapper.find('.ns-list').exists()).toBe(false)
        expect(wrapper.findAll('.ns-fact').map((f) => [f.find('dt').text(), f.find('dd').text()])).toEqual([
            ['AI engines', '2 of 2'],
            ['Google results', 'On'],
            ['Research agents', 'Ready'],
            ['Prompts tracked', '12'],
            ['Autopilot', 'On'],
        ])
        expect(wrapper.find('button').exists()).toBe(false)
        expect(last()).toBe('live')
    })

    it('does not say all set when the ranking could not be read', async () => {
        const { wrapper, agent, last } = await render({ ranking: { failure: { status: 500, code: 'error' } } })
        expect(wrapper.text()).not.toContain('All set')
        expect(wrapper.find('.ns-done-title').text()).toBe('Nothing to fix in setup')
        expect(wrapper.find('.ns-done-body').text()).toBe("We couldn't check your prompts and Autopilot.")
        expect(wrapper.findAll('.ns-fact dt').map((d) => d.text())).toEqual(['AI engines', 'Google results', 'Research agents'])
        expect(last()).toBe('stale')
        await button(wrapper, 'Try again').trigger('click')
        expect(reloadOf('ranking')).toHaveBeenCalledTimes(1)
        expect(agent.loadStatus).toHaveBeenCalledTimes(1)
    })

    it('calls a status kept from before a failed check stale', async () => {
        const { last } = await render({ stores: ({ agent }) => { agent.statusError = { status: 502 } } })
        expect(last()).toBe('stale')
        setSource('ranking', { data: rankingPayload(), stale: true })
        const kept = await render({ ranking: null })
        expect(kept.wrapper.find('.ns-done-title').text()).toBe('All set')
        expect(kept.last()).toBe('stale')
    })
})

describe('NextStepsCard without an answer', () => {
    it('is a skeleton until the status and the ranking have both answered', async () => {
        const noStatus = await render({ status: null, stores: ({ agent }) => { agent.statusLoading = true } })
        expect(noStatus.wrapper.find('.bd-skel').exists()).toBe(true)
        expect(noStatus.last()).toBe('loading')

        resetSources()
        const noRanking = await render({ ranking: null })
        expect(noRanking.wrapper.find('.bd-skel').exists()).toBe(true)
        expect(noRanking.wrapper.text()).not.toContain('All set')
        expect(noRanking.last()).toBe('loading')
        setSource('ranking', { data: rankingPayload() })
        await noRanking.wrapper.vm.$nextTick()
        expect(noRanking.wrapper.find('.ns-done-title').text()).toBe('All set')
        expect(noRanking.last()).toBe('live')
    })

    it('asks for the status once when nobody did', async () => {
        const { agent } = await render({ status: null })
        expect(agent.loadStatus).toHaveBeenCalledTimes(1)
        const known = await render()
        expect(known.agent.loadStatus).not.toHaveBeenCalled()
        const loading = await render({ status: null, stores: ({ agent: a }) => { a.statusLoading = true } })
        expect(loading.agent.loadStatus).not.toHaveBeenCalled()
    })

    it('says it could not check, with a way to try again', async () => {
        const { wrapper, agent, last } = await render({ status: null, stores: ({ agent: a }) => { a.statusError = { status: 500 } } })
        expect(wrapper.find('[role="alert"]').text()).toContain("We couldn't check your setup.")
        expect(wrapper.find('.ns').exists()).toBe(false)
        expect(last()).toBe('error')
        await button(wrapper, 'Try again').trigger('click')
        expect(agent.loadStatus).toHaveBeenCalledTimes(1)
        expect(reloadOf('ranking')).toHaveBeenCalledTimes(1)
    })
})
