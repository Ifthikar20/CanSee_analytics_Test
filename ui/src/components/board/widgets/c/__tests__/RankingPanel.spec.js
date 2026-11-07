import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { rankedRows, rankingPayload, rankingRow } = await import('./__fixtures__/payloads')
const { default: RankingPanel } = await import('../RankingPanel.vue')

const mounted = []

async function render(path = '/projects/w1/analytics?widget=ranking') {
    const out = await mountOnBoard(RankingPanel, { panel: true, path })
    mounted.push(out.wrapper)
    return out
}

const cells = (row) => [row.find('td.rkp-rank'), row.find('th'), ...row.findAll('td').slice(1)].map((c) => c.text())
const bodyRows = (wrapper) => wrapper.findAll('tbody tr')
const firstColumn = (wrapper) => bodyRows(wrapper).map((r) => r.find('th').text())

function payload() {
    const prompts = rankedRows(3)
    prompts[1].change_pts = null
    prompts[2].engines = { chatgpt: { answers: 7, named: 3 }, claude: { answers: 0, named: 0 } }
    prompts.push(
        rankingRow('p-w', {
            text: 'prompt waiting',
            ranked: false,
            rank: null,
            answers: 0,
            named: 0,
            share_pct: null,
            share_low_pct: null,
            share_high_pct: null,
            change_pts: null,
            engines: { chatgpt: { answers: 0, named: 0 }, claude: { answers: 0, named: 0 } },
            google: { status: 'not_checked', position: null, page_one: null, depth: 10, checked_at: null },
        }),
    )
    return rankingPayload({ prompts })
}

beforeEach(() => {
    resetSources()
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe('RankingPanel', () => {
    it('reads the last 7 days against the 7 before, and leaves the change out when it was not measured', async () => {
        setSource('ranking', { data: payload() })
        const { wrapper } = await render()
        expect(wrapper.find('.rkp-headline').text()).toBe(
            'Named in 49 of 126 answers in the last 7 days (39%), up 6 pts on the 7 days before.',
        )
        setSource('ranking', {
            data: rankingPayload({ headline: { answers: 126, named: 49, share_pct: 38.9, prev_share_pct: null, change_pts: null } }),
        })
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.rkp-headline').text()).toBe('Named in 49 of 126 answers in the last 7 days (39%).')
    })

    it('lists every prompt with its range, answers, change, engines and Google cell; unranked ones last', async () => {
        setSource('ranking', { data: payload() })
        const { wrapper } = await render()
        expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual([
            'Rank',
            'Prompt',
            'Named',
            'Answers',
            'Change',
            'ChatGPT',
            'Claude',
            'Google',
        ])
        expect(bodyRows(wrapper).map(cells)).toEqual([
            ['1', 'prompt 1', '90%, likely 60-96%', '14', '+14 pts', '7/7', '5/7', 'Google #4'],
            ['2', 'prompt 2', '80%, likely 60-96%', '14', 'Not measured', '7/7', '5/7', 'Google #4'],
            ['3', 'prompt 3', '70%, likely 60-96%', '14', '+14 pts', '3/7', 'No answers', 'Google #4'],
            ['Needs more answers', 'prompt waiting', 'No answers', '0', 'Not measured', 'No answers', 'No answers', 'Google not checked'],
        ])
        expect(wrapper.find('.rkp-foot span').text()).toBe('Share of answers that name you, last 7 days.')
        expect(wrapper.find('.rkp-foot a').text()).toBe('See Autopilot runs')
        expect(wrapper.find('.rkp-foot a').attributes('href')).toBe('/settings/autopilot')
    })

    it('orders best or weakest first through the panel key, and keeps it in the address', async () => {
        setSource('ranking', { data: payload() })
        const { wrapper, router } = await render()
        const group = wrapper.find('[role="radiogroup"]')
        expect(wrapper.find(`#${group.attributes('aria-labelledby')}`).text()).toBe('Order')
        const radios = group.findAll('input[type="radio"]')
        expect(group.findAll('label').map((l) => l.text())).toEqual(['Best first', 'Weakest first'])
        expect(radios[0].element.checked).toBe(true)
        expect(firstColumn(wrapper)).toEqual(['prompt 1', 'prompt 2', 'prompt 3', 'prompt waiting'])

        await radios[1].setValue(true)
        await flushPromises()
        expect(router.currentRoute.value.query).toEqual({ widget: 'ranking', order: 'weakest' })
        expect(firstColumn(wrapper)).toEqual(['prompt 3', 'prompt 2', 'prompt 1', 'prompt waiting'])
        expect(radios[1].element.checked).toBe(true)

        await radios[0].setValue(true)
        await flushPromises()
        expect(router.currentRoute.value.query).toEqual({ widget: 'ranking' })
    })

    it('starts weakest first from a link', async () => {
        setSource('ranking', { data: payload() })
        const { wrapper } = await render('/projects/w1/analytics?widget=ranking&order=weakest')
        expect(firstColumn(wrapper)).toEqual(['prompt 3', 'prompt 2', 'prompt 1', 'prompt waiting'])
    })

    it('opens a prompt from its row', async () => {
        setSource('ranking', { data: payload() })
        const { wrapper, board } = await render()
        await bodyRows(wrapper)[1].find('button').trigger('click')
        expect(board.open).toHaveBeenCalledWith('prompts', { prompt: 'p-2' })
    })

    it('asks for a prompt first, and shows the load failure with Try again', async () => {
        setSource('ranking', { data: rankingPayload({ prompts: [] }) })
        const { wrapper, board } = await render()
        expect(wrapper.find('.rkp-state-title').text()).toBe('Track a prompt first.')
        expect(wrapper.find('table').exists()).toBe(false)
        await wrapper.findAll('button').find((b) => b.text() === 'Add prompts').trigger('click')
        expect(board.open).toHaveBeenCalledWith('prompts', { add: '1' })

        setSource('ranking', { failure: { status: 500, code: 'error', message: 'x' } })
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.rkp-state-title').text()).toBe("We couldn't load Prompt ranking.")
        await wrapper.findAll('button').find((b) => b.text() === 'Try again').trigger('click')
        expect(reloadOf('ranking')).toHaveBeenCalledTimes(1)
    })

    it('says when the account tracks more than the plan covers', async () => {
        setSource('ranking', { data: rankingPayload({ tracked: { count: 120, limit: 100, over_limit: 20 } }) })
        const { wrapper } = await render()
        expect(wrapper.find('.rkp-notice-text').text()).toBe(
            'You track 120 prompts and your plan covers 100. Autopilot checks the 100 oldest.',
        )
    })
})
