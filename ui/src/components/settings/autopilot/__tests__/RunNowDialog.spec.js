import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { runEstimate, runSummary } from './__fixtures__/autopilot'

const autopilot = vi.hoisted(() => ({ estimate: vi.fn(), runNow: vi.fn() }))
vi.mock('@/api/autopilot', () => ({ default: autopilot }))

const { default: RunNowDialog } = await import('../RunNowDialog.vue')

const mounted = []
const dialog = () => document.body.querySelector('.ag-portal.ag-dialog')
const rows = () =>
    [...dialog().querySelectorAll('.rnd-row')].map((row) => [
        row.querySelector('dt').textContent.trim(),
        row.querySelector('dd').textContent.replace(/\s+/g, ' ').trim(),
    ])
const buttonNamed = (label) => [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === label)

async function render({ estimate = runEstimate(), analysis = true } = {}) {
    autopilot.estimate.mockResolvedValue({ data: estimate })
    const wrapper = mount(RunNowDialog, {
        props: { websiteId: 'w1', analysis, open: true, 'onUpdate:open': (v) => wrapper.setProps({ open: v }) },
        attachTo: document.body,
    })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
}

beforeEach(() => {
    autopilot.estimate.mockReset()
    autopilot.runNow.mockReset()
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe('RunNowDialog', () => {
    it('shows the estimate before anything runs', async () => {
        await render()
        expect(autopilot.estimate).toHaveBeenCalledWith('w1')
        expect(dialog().querySelector('.ag-dialog-title').textContent).toBe('Run Autopilot now?')
        expect(dialog().querySelector('.ag-dialog-desc').textContent).toBe(
            "Checks 9 prompts with ChatGPT and Claude, then Google page one, then analyzes new answers. This counts as today's run.",
        )
        expect(rows()).toEqual([
            ['AI answers', 'up to 18'],
            ['AI cost', 'up to $1.44, about $0.36'],
            ['Google pages', 'up to 9 (225 ScraperAPI credits)'],
            ['Allowance left', '$2.24'],
        ])
        expect(dialog().querySelector('.rnd-note')).toBeNull()
        expect(buttonNamed('Run now').disabled).toBe(false)
        expect(buttonNamed('Cancel')).toBeTruthy()
    })

    it('says only what was measured', async () => {
        await render({
            estimate: runEstimate({
                usd_expected: null,
                credits_max: null,
                allowance: { unlimited: true, cap_usd: null, left_usd: null, reserve_pct: 10, usable_usd: null },
            }),
        })
        expect(rows()).toEqual([
            ['AI answers', 'up to 18'],
            ['AI cost', 'up to $1.44'],
            ['Google pages', 'up to 9'],
            ['Allowance left', 'Unlimited'],
        ])
    })

    it('leaves Google and the analysis out when the run does not do them', async () => {
        await render({ estimate: runEstimate({ pages_max: 0, credits_max: 0 }), analysis: false })
        expect(dialog().querySelector('.ag-dialog-desc').textContent).toBe(
            "Checks 9 prompts with ChatGPT and Claude. This counts as today's run.",
        )
        expect(rows().map(([label]) => label)).toEqual(['AI answers', 'AI cost', 'Allowance left'])
    })

    it('says when the allowance fits fewer prompts', async () => {
        await render({ estimate: runEstimate({ prompts: 6, over_limit: 0, limited_by: 'allowance', answers_max: 12 }) })
        expect(dialog().querySelector('.rnd-note').textContent).toBe(
            'Only 6 prompts fit in your allowance today; the rest wait for the next run.',
        )
    })

    it('replaces the button with the blockers', async () => {
        const blockers = [
            { code: 'reserve_reached', message: 'Autopilot keeps the last 10% of your AI allowance for your own questions. Runs resume Dec 1.' },
        ]
        await render({ estimate: runEstimate({ blockers, can_run: false }) })
        expect([...dialog().querySelectorAll('.rnd-blockers .rnd-error')].map((p) => p.textContent)).toEqual([blockers[0].message])
        expect(buttonNamed('Run now')).toBeUndefined()
        expect(buttonNamed('Cancel')).toBeTruthy()
    })

    it("runs with the estimate's confirm and closes", async () => {
        const wrapper = await render()
        const created = runSummary({ status: 'queued', trigger: 'manual' })
        autopilot.runNow.mockResolvedValue({ data: created })
        buttonNamed('Run now').click()
        await flushPromises()
        expect(autopilot.runNow).toHaveBeenCalledWith('w1', { answers: 18, ai_usd_max: '1.4400', google_pages: 9 })
        expect(wrapper.emitted('started')).toEqual([[created]])
        expect(wrapper.props('open')).toBe(false)
    })

    it('shows the new estimate when the cost changed, and confirms that one', async () => {
        const wrapper = await render()
        const newer = runEstimate({ answers_max: 20, usd_max: '1.6000', prompts: 10, confirm: { answers: 20, ai_usd_max: '1.6000', google_pages: 10 } })
        autopilot.runNow.mockRejectedValueOnce({
            response: {
                status: 409,
                data: { error: { code: 'estimate_changed', message: 'The cost changed. Check the new estimate and confirm again.', details: { estimate: newer } } },
            },
        })
        buttonNamed('Run now').click()
        await flushPromises()
        expect(dialog().querySelector('.rnd-note').textContent).toBe('The cost changed. Check the new estimate and confirm again.')
        expect(rows()[0]).toEqual(['AI answers', 'up to 20'])
        expect(wrapper.props('open')).toBe(true)

        autopilot.runNow.mockResolvedValue({ data: runSummary() })
        buttonNamed('Run now').click()
        await flushPromises()
        expect(autopilot.runNow).toHaveBeenLastCalledWith('w1', newer.confirm)
    })

    it("says today's run already happened and offers nothing to run", async () => {
        await render()
        autopilot.runNow.mockRejectedValue({
            response: {
                status: 409,
                data: { error: { code: 'run_today_exists', message: "Today's run already happened. The next one is tomorrow at 07:00." } },
            },
        })
        buttonNamed('Run now').click()
        await flushPromises()
        expect(dialog().querySelector('[role="alert"]').textContent).toBe("Today's run already happened. The next one is tomorrow at 07:00.")
        expect(buttonNamed('Run now')).toBeUndefined()
    })

    it('says so when the estimate cannot be read', async () => {
        autopilot.estimate.mockRejectedValue({ response: { status: 500, data: { error: { message: 'Something went wrong on our end.' } } } })
        const wrapper = mount(RunNowDialog, { props: { websiteId: 'w1', open: true }, attachTo: document.body })
        mounted.push(wrapper)
        await flushPromises()
        expect(dialog().querySelector('.rnd-error').textContent).toBe('Something went wrong on our end.')
        expect(buttonNamed('Run now')).toBeUndefined()
    })
})
