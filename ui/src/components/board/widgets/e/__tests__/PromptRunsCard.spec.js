// What the Prompt runs card shows in each state, and what it tells its
// frame. The figures are the runs block of the agent status (else the
// session's); a Free account never sees a dollar amount.
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { MAX_SEGMENTS } from '@/lib/board/e/runs'
import { mountOnBoard } from './__fixtures__/board'
import { agentStatus, freeRuns, paidRuns } from './__fixtures__/payloads'
import PromptRunsCard from '../PromptRunsCard.vue'

const mounted = []

async function render({ props = {}, status = agentStatus(), stores = null } = {}) {
    const out = await mountOnBoard(PromptRunsCard, {
        props,
        stores: (s) => {
            s.agent.status = status
            if (stores) stores(s)
        },
    })
    mounted.push(out.wrapper)
    return out
}

const segs = (wrapper, cls) => wrapper.findAll(`.pr-seg${cls}`).length
const bars = (wrapper, sel = '') =>
    wrapper.findAll(`${sel} .bd-bars-row`).map((r) => `${r.find('.bd-bars-label').text()} ${r.find('.bd-bars-value').text()}`)
const labels = (wrapper, sel) => wrapper.findAll(`${sel} .cs-label`).map((el) => el.text())

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe('PromptRunsCard on the Free plan', () => {
    it('shows the runs left over the allowance, as marks, with the renewal date', async () => {
        const { wrapper, last, agent } = await render()
        expect(wrapper.find('.pr').classes()).toContain('is-free')
        expect(wrapper.find('.pr-numeral').text()).toBe('13')
        expect(wrapper.find('.pr-unit').text()).toBe('/ 20')
        expect(labels(wrapper, '.pr-head')).toEqual(['Free runs left'])
        expect(wrapper.findAll('.pr-seg')).toHaveLength(20)
        expect(segs(wrapper, '.is-used')).toBe(7)
        expect(segs(wrapper, '.is-left')).toBe(13)
        // The accent once: the next run to be spent, right after the spent ones.
        expect(segs(wrapper, '.is-next')).toBe(1)
        expect(wrapper.findAll('.pr-seg')[7].classes()).toContain('is-next')
        expect(labels(wrapper, '.pr-axis')).toEqual(['7 used', 'Renews December 1'])
        expect(last()).toBe('live')
        // The status was already there: the card asks for nothing.
        expect(agent.loadStatus).not.toHaveBeenCalled()
    })

    it('carries the same facts in a sentence for screen readers and hides the drawing from them', async () => {
        const { wrapper } = await render()
        expect(wrapper.find('.pr-sr').text()).toBe(
            '13 free prompt runs left. 7 of 20 free prompt runs used. By engine: ChatGPT 4, Claude 3. They renew on December 1.',
        )
        expect(wrapper.find('.pr-lead').attributes('aria-hidden')).toBe('true')
        expect(wrapper.find('.pr-lead').find('a, button').exists()).toBe(false)
    })

    it('never shows dollars, even when the status carries an allowance in dollars', async () => {
        const status = agentStatus({ allowance: { show_usd: false, cap_usd: 3, spent_usd: 1.25, left_usd: '1.75' } })
        for (const size of ['third', 'half', 'full']) {
            const { wrapper } = await render({ props: { size }, status })
            expect(wrapper.text(), size).not.toMatch(/\$|usd|1\.25|1\.75/i)
        }
    })

    it('says when few are left and when none is', async () => {
        const low = await render({ status: agentStatus({ prompt_runs: freeRuns({ used: 16, remaining: 4 }) }) })
        expect(low.wrapper.find('.pr-hint').text()).toBe('Few runs are left this month.')
        expect(low.wrapper.find('.pr').classes()).not.toContain('is-spent')

        const out = await render({ status: agentStatus({ prompt_runs: freeRuns({ used: 20, remaining: 0 }) }) })
        expect(out.wrapper.find('.pr-numeral').text()).toBe('0')
        expect(out.wrapper.find('.pr').classes()).toContain('is-spent')
        expect(out.wrapper.find('.pr-hint').text()).toBe('The AI engines are asked again once the runs renew.')
        expect(segs(out.wrapper, '.is-used')).toBe(20)
        expect(segs(out.wrapper, '.is-next')).toBe(0)
        expect(out.last()).toBe('live')

        const plenty = await render()
        expect(plenty.wrapper.find('.pr-hint').exists()).toBe(false)
    })

    it('shows the runs out right now beside the label and as outlined marks', async () => {
        const { wrapper } = await render({ status: agentStatus({ prompt_runs: freeRuns({ used: 5, reserved: 2, remaining: 13 }) }) })
        expect(wrapper.find('.pr-head .pr-out').text()).toBe('2 running now')
        expect(segs(wrapper, '.is-out')).toBe(2)
        expect(labels(wrapper, '.pr-axis')).toEqual(['5 used', 'Renews December 1'])
    })

    it('draws no marks without a limit and no date it was not given', async () => {
        const { wrapper } = await render({ status: agentStatus({ prompt_runs: { unlimited: false, remaining: 4 } }) })
        expect(wrapper.find('.pr-numeral').text()).toBe('4')
        expect(wrapper.find('.pr-unit').exists()).toBe(false)
        expect(wrapper.find('[data-meter]').exists()).toBe(false)
        expect(labels(wrapper, '.pr-axis')).toEqual(['0 used'])
    })

    it('adds the engines, what a run is and the way to the plans at full size', async () => {
        const { wrapper } = await render({ props: { size: 'full' } })
        expect(wrapper.find('.pr').classes()).toContain('is-full')
        expect(wrapper.find('.pr-more .cs-label').text()).toBe('Used by engine')
        expect(bars(wrapper)).toEqual(['ChatGPT 4', 'Claude 3'])
        expect(wrapper.findAll('.pr-note').map((p) => p.text())).toEqual([
            'One prompt run is one prompt answered by one AI engine, shared by all your projects.',
        ])
        const link = wrapper.find('.pr-actions a')
        expect(link.text()).toBe('See plans')
        expect(link.attributes('href')).toBe('/billing')
        // A compact card keeps to the figure.
        const compact = await render()
        expect(compact.wrapper.find('.pr-more').exists()).toBe(false)
        expect(compact.wrapper.find('.bd-bars').exists()).toBe(false)
    })

    it('says what one mark stands for when the allowance is scaled, and when nothing ran yet', async () => {
        const status = agentStatus({ prompt_runs: freeRuns({ limit: 120, used: 0, remaining: 120, by_engine: {} }) })
        const { wrapper } = await render({ props: { size: 'full' }, status })
        expect(wrapper.findAll('.pr-seg')).toHaveLength(MAX_SEGMENTS)
        expect(wrapper.findAll('.pr-note').map((p) => p.text())).toEqual([
            'No engine has answered a run yet this month.',
            'One prompt run is one prompt answered by one AI engine, shared by all your projects.',
            'Each mark of the bar stands for about 5 runs.',
        ])
    })
})

describe('PromptRunsCard on a plan without a limit', () => {
    it('shows the runs used this month and the engines that answered most', async () => {
        const { wrapper, last } = await render({ status: agentStatus({ prompt_runs: paidRuns({ reserved: 3 }), allowance: { show_usd: true } }) })
        expect(wrapper.find('.pr').classes()).toContain('is-unlimited')
        expect(wrapper.find('.pr-numeral').text()).toBe('1,248')
        expect(wrapper.find('.pr-figure').classes()).toContain('is-sm')
        expect(wrapper.find('.pr-unit').text()).toBe('runs')
        expect(labels(wrapper, '.pr-head')).toEqual(['Used this month', 'No limit'])
        expect(wrapper.find('[data-meter]').exists()).toBe(false)
        expect(bars(wrapper, '.pr-lead')).toEqual(['ChatGPT 412', 'Claude 388', 'Gemini 301'])
        // Every bar is the account's own: ink, and no accent mark on any.
        expect(wrapper.findAll('.bd-bars-fill.is-you')).toHaveLength(3)
        expect(wrapper.find('.bd-bars-mark').exists()).toBe(false)
        expect(labels(wrapper, '.pr-axis')).toEqual(['Resets December 1', '3 running now'])
        expect(wrapper.find('.pr-hint').exists()).toBe(false)
        expect(wrapper.text()).not.toMatch(/\$/)
        expect(last()).toBe('live')
    })

    it('lists every engine and links to Usage at full size', async () => {
        const { wrapper } = await render({ props: { size: 'full' }, status: agentStatus({ prompt_runs: paidRuns() }) })
        expect(wrapper.find('.pr-more .cs-label').text()).toBe('By engine')
        expect(wrapper.findAll('.pr-more .bd-bars-row')).toHaveLength(4)
        expect(wrapper.find('.pr-lead .bd-bars').exists()).toBe(false)
        const link = wrapper.find('.pr-actions a')
        expect(link.text()).toBe('Usage')
        expect(link.attributes('href')).toBe('/settings?section=usage')
    })

    it('sets a very long figure smaller still', async () => {
        const { wrapper } = await render({ status: agentStatus({ prompt_runs: paidRuns({ used: 1234567 }) }) })
        expect(wrapper.find('.pr-numeral').text()).toBe('1,234,567')
        expect(wrapper.find('.pr-figure').classes()).toContain('is-xs')
    })
})

describe('PromptRunsCard without numbers', () => {
    it('is a skeleton while the status is on its way', async () => {
        const { wrapper, last } = await render({ status: null, stores: ({ agent }) => { agent.statusLoading = true } })
        expect(wrapper.find('.bd-skel').exists()).toBe(true)
        expect(wrapper.find('.pr').exists()).toBe(false)
        expect(last()).toBe('loading')
    })

    it('asks for the status once when nobody did, and shows what comes back', async () => {
        const { wrapper, agent, last } = await render({
            status: null,
            stores: ({ agent: a }) => {
                a.loadStatus.mockImplementation(async () => {
                    a.status = agentStatus()
                    return a.status
                })
            },
        })
        expect(agent.loadStatus).toHaveBeenCalledTimes(1)
        await flushPromises()
        expect(wrapper.find('.pr-numeral').text()).toBe('13')
        expect(last()).toBe('live')
    })

    it("uses the session's runs while the status has none, and calls them stale after a failed check", async () => {
        const session = { limits: { prompt_runs: freeRuns({ used: 15, remaining: 5 }) } }
        const loading = await render({ status: null, stores: ({ agent, auth }) => { agent.statusLoading = true; auth.session = session } })
        expect(loading.wrapper.find('.pr-numeral').text()).toBe('5')
        expect(loading.last()).toBe('live')

        const failed = await render({ status: null, stores: ({ agent, auth }) => { agent.statusError = { status: 500 }; auth.session = session } })
        expect(failed.wrapper.find('.pr-numeral').text()).toBe('5')
        expect(failed.last()).toBe('stale')

        // The status' own block wins over the session's.
        const both = await render({ stores: ({ auth }) => { auth.session = session } })
        expect(both.wrapper.find('.pr-numeral').text()).toBe('13')
    })

    it('keeps the last numbers and says stale when a later check fails', async () => {
        const { wrapper, last } = await render({ stores: ({ agent }) => { agent.statusError = { status: 502 } } })
        expect(wrapper.find('.pr-numeral').text()).toBe('13')
        expect(last()).toBe('stale')
    })

    it('says it could not load, with a way to try again', async () => {
        const { wrapper, agent, last } = await render({ status: null, stores: ({ agent: a }) => { a.statusError = { status: 500 } } })
        expect(wrapper.find('[role="alert"]').text()).toContain("Prompt runs couldn't load.")
        expect(wrapper.text()).not.toMatch(/\d/)
        expect(last()).toBe('error')
        expect(agent.loadStatus).not.toHaveBeenCalled()
        await wrapper.find('button').trigger('click')
        expect(agent.loadStatus).toHaveBeenCalledTimes(1)
    })

    it('does not ask twice while a check is running', async () => {
        const { wrapper, agent } = await render({ status: null, stores: ({ agent: a }) => { a.statusError = { status: 500 } } })
        agent.statusLoading = true
        agent.statusError = null
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.bd-skel').exists()).toBe(true)
        expect(agent.loadStatus).not.toHaveBeenCalled()
    })

    it('says so when the account reports no runs, without a figure', async () => {
        const { wrapper, last } = await render({ status: agentStatus({ prompt_runs: undefined }) })
        expect(wrapper.text()).toContain("This account doesn't report prompt runs yet.")
        expect(wrapper.find('.pr').exists()).toBe(false)
        expect(wrapper.text()).not.toMatch(/\d/)
        expect(wrapper.find('a').attributes('href')).toBe('/billing')
        expect(last()).toBe('empty')
        // A block that cannot be read is no block.
        const bad = await render({ status: agentStatus({ prompt_runs: { limit: 20, remaining: 3 } }) })
        expect(bad.last()).toBe('empty')
    })
})
