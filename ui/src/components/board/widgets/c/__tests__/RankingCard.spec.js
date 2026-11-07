import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { rankedRows, rankingPayload, rankingRow, runSummary } = await import('./__fixtures__/payloads')
const { default: RankingCard } = await import('../RankingCard.vue')

const mounted = []

async function render(props = {}) {
    const out = await mountOnBoard(RankingCard, { props: { size: 'full', ...props } })
    mounted.push(out.wrapper)
    return out
}

const lists = (wrapper) =>
    wrapper.findAll('.rk-list').map((section) => ({
        title: section.find('h3').text(),
        rows: section.findAll('.bd-bars-row').map((row) => [
            row.find('.bd-bars-label').text(),
            row.find('.bd-bars-value').text(),
            row.find('.bd-bars-hint').text(),
        ]),
    }))
const button = (wrapper, label) => wrapper.findAll('button').find((b) => b.text() === label)

// Local noon on 2026-11-04, so "today" holds in any time zone.
const NOW = new Date(2026, 10, 4, 12, 0)
const at = (day, h, m) => new Date(2026, 10, day, h, m).toISOString()

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    resetSources()
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('RankingCard', () => {
    it('shows a skeleton while the ranking loads, and the common error with Try again', async () => {
        const { wrapper } = await render()
        expect(wrapper.find('.bd-skel').exists()).toBe(true)
        setSource('ranking', { failure: { status: 500, code: 'error', message: 'Something went wrong.' } })
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.rk-state-title').text()).toBe("We couldn't load Prompt ranking.")
        await button(wrapper, 'Try again').trigger('click')
        expect(reloadOf('ranking')).toHaveBeenCalled()
    })

    it('lists the prompts that keep you visible and the weakest, both at once, with their Google cells', async () => {
        const prompts = [
            ...rankedRows(8),
            rankingRow('p-w', { ranked: false, rank: null, answers: 2, named: 1, share_pct: 50, change_pts: null }),
        ]
        prompts[1].change_pts = -3.2
        prompts[2].change_pts = null
        prompts[2].google = { status: 'ok', position: null, page_one: false, depth: 10, checked_at: null }
        prompts[3].google = { status: 'not_checked', position: null, page_one: null, depth: 10, checked_at: null }
        setSource('ranking', { data: rankingPayload({ autopilot: { enabled: true, last_run: runSummary({ finished_at: at(4, 7, 4) }) }, prompts }) })
        const { wrapper } = await render()

        expect(wrapper.find('.rk-lead').text()).toBe('Autopilot ran today at 7:04 AM: named in 15 of 18 answers (83%).')
        expect(lists(wrapper)).toEqual([
            {
                title: 'Keep you visible',
                rows: [
                    ['prompt 1', '12/14 (+14)', 'Google #4'],
                    ['prompt 2', '11/14 (-3)', 'Google #4'],
                    ['prompt 3', '10/14', "Not in Google's top 10"],
                    ['prompt 4', '9/14 (+14)', 'Google not checked'],
                    ['prompt 5', '8/14 (+14)', 'Google #4'],
                ],
            },
            {
                title: 'Weakest',
                rows: [
                    ['prompt 8', '5/14 (+14)', 'Google #4'],
                    ['prompt 7', '6/14 (+14)', 'Google #4'],
                    ['prompt 6', '7/14 (+14)', 'Google #4'],
                ],
            },
        ])
        // All bars are you: the accent, against 100%.
        const fills = wrapper.findAll('.bd-bars-fill')
        expect(fills).toHaveLength(8)
        expect(fills.every((f) => f.classes().includes('is-you'))).toBe(true)
        expect(fills[0].attributes('style')).toContain('width: 90%')
        // No representation switcher, badge or dot on the card.
        expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
        expect(wrapper.find('.bd-foot-text').text()).toBe(
            'Share of answers that name you, last 7 days. 1 prompt needs more answers to rank.',
        )
    })

    it('opens a prompt from its row, and every prompt from the foot', async () => {
        setSource('ranking', { data: rankingPayload({ prompts: rankedRows(3) }) })
        const { wrapper, board } = await render()
        await wrapper.findAll('.bd-bars-row')[1].trigger('click')
        expect(board.open).toHaveBeenCalledWith('prompts', { prompt: 'p-2' })
        await button(wrapper, 'All prompts').trigger('click')
        expect(board.open).toHaveBeenLastCalledWith('ranking')
    })

    it('has no Weakest with one ranked prompt', async () => {
        setSource('ranking', { data: rankingPayload({ prompts: rankedRows(1) }) })
        const { wrapper } = await render()
        expect(lists(wrapper).map((l) => l.title)).toEqual(['Keep you visible'])
        expect(lists(wrapper)[0].rows).toHaveLength(1)
    })

    it('asks for a prompt first, and says when none has enough answers to rank', async () => {
        setSource('ranking', { data: rankingPayload({ prompts: [] }) })
        const { wrapper, board } = await render()
        expect(wrapper.find('.rk-state-title').text()).toBe('Track a prompt first.')
        await button(wrapper, 'Add prompts').trigger('click')
        expect(board.open).toHaveBeenCalledWith('prompts', { add: '1' })
        expect(button(wrapper, 'All prompts')).toBeUndefined()

        setSource('ranking', { data: rankingPayload({ prompts: [rankingRow('p-1', { ranked: false, rank: null, answers: 3 })] }) })
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.rk-state-title').text()).toBe('Prompts are ranked once they have 4 answers in 7 days.')
        expect(wrapper.find('.rk-list').exists()).toBe(false)
        expect(button(wrapper, 'All prompts')).toBeTruthy()
    })

    it('says what Autopilot does: off with Turn it on, or when it runs first', async () => {
        setSource('ranking', { data: rankingPayload({ autopilot: { enabled: false, last_run: null, next_run_at: null } }) })
        const { wrapper } = await render()
        const lead = wrapper.find('.rk-lead')
        expect(lead.text()).toBe('Autopilot is off for this project. Turn it on')
        expect(lead.find('a').text()).toBe('Turn it on')
        expect(lead.find('a').attributes('href')).toBe('/settings/autopilot')

        setSource('ranking', { data: rankingPayload({ autopilot: { enabled: true, last_run: null, next_run_at: at(5, 7, 0) } }) })
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.rk-lead').text()).toBe('Autopilot runs first tomorrow at 7:00 AM.')

        setSource('ranking', { data: rankingPayload({ autopilot: { enabled: true, last_run: runSummary({ finished_at: at(3, 7, 4) }) } }) })
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.rk-lead').text()).toBe('Autopilot ran yesterday at 7:04 AM: named in 15 of 18 answers (83%).')
    })

    it('says when the account tracks more than the plan covers, with See plans', async () => {
        setSource('ranking', { data: rankingPayload({ tracked: { count: 120, limit: 100, over_limit: 20 } }) })
        const { wrapper } = await render()
        expect(wrapper.find('.rk-notice-text').text()).toBe(
            'You track 120 prompts and your plan covers 100. Autopilot checks the 100 oldest.',
        )
        expect(wrapper.find('.rk-notice a').attributes('href')).toBe('/billing')
        expect(wrapper.find('.rk-notice a').text()).toBe('See plans')
    })

    it("keeps the last numbers when a refresh fails, and says it couldn't refresh", async () => {
        setSource('ranking', { data: rankingPayload(), stale: true, failure: { status: 500, code: 'error', message: 'x' } })
        const { wrapper } = await render()
        expect(wrapper.find('.bd-foot-text').text()).toBe("Share of answers that name you, last 7 days. Couldn't refresh.")
        expect(wrapper.findAll('.bd-bars-row')).toHaveLength(1)
    })
})
