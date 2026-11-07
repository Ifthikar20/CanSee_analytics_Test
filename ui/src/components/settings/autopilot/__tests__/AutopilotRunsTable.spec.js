import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AutopilotRunsTable from '../AutopilotRunsTable.vue'
import { runSummary } from './__fixtures__/autopilot'

function render(props = {}) {
    return mount(AutopilotRunsTable, { props: { runs: [], timezone: 'UTC', ...props } })
}

const cells = (row) => row.findAll('td').map((td) => td.text())

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-05T15:00:00Z'))
})

afterEach(() => {
    vi.useRealTimers()
})

describe('AutopilotRunsTable', () => {
    it('offers Run now and shows no table before the first run', async () => {
        const wrapper = render()
        const button = wrapper.find('.art-head button')
        expect(button.text()).toBe('Run now')
        expect(wrapper.find('table').exists()).toBe(false)
        await button.trigger('click')
        expect(wrapper.emitted('run-now')).toHaveLength(1)
    })

    it('reads a finished run', () => {
        const wrapper = render({ runs: [runSummary()] })
        expect(wrapper.findAll('th').map((th) => th.text())).toEqual([
            'Date',
            'Status',
            'Prompts',
            'Named',
            'AI cost',
            'Google pages',
            'Text',
        ])
        expect(cells(wrapper.find('tbody tr'))).toEqual(['Nov 4', 'Done', '100 of 100', '41 of 198', '$1.27', '96', 'Sent at Nov 4, 08:00'])
        // The table scrolls on a phone and takes the keyboard.
        const region = wrapper.find('.art-scroll')
        expect(region.attributes('role')).toBe('region')
        expect(region.attributes('aria-label')).toBe('Autopilot runs')
        expect(region.attributes('tabindex')).toBe('0')
    })

    it('words every status', () => {
        const statuses = ['queued', 'running', 'done', 'partial', 'failed', 'skipped', 'cancelled', 'interrupted']
        const runs = statuses.map((status, i) => runSummary({ id: `run-${i}`, status }))
        const wrapper = render({ runs })
        expect(wrapper.findAll('tbody tr').map((row) => row.find('.art-status span').text())).toEqual([
            'Waiting to start',
            'Running',
            'Done',
            'Partly done',
            'Failed',
            'Skipped',
            'Stopped',
            'Stopped before it finished',
        ])
    })

    it('measures nothing before a run starts', () => {
        const wrapper = render({
            runs: [
                runSummary({
                    status: 'queued',
                    trigger: 'manual',
                    prompts: { planned: 0, done: 0 },
                    answers: { answered: 0, named: 0 },
                    cost: { ai_usd: null },
                    google: { pages: 0 },
                    text: { status: 'not_requested' },
                }),
            ],
        })
        expect(cells(wrapper.find('tbody tr'))).toEqual(['Nov 4', 'Waiting to start', '—', '—', '—', '—', '—'])
    })

    it('says No answers when nothing was answered, and 0 when zero was measured', () => {
        const wrapper = render({
            runs: [
                runSummary({
                    status: 'failed',
                    prompts: { planned: 9, done: 0 },
                    answers: { asked: 18, answered: 0, named: 0 },
                    cost: { ai_usd: '0.0000' },
                    google: { status: 'off', pages: 0 },
                    text: { status: 'skipped', reason: 'opted_out' },
                    error: { code: 'no_answers', message: 'No engine answered (18 errors).' },
                }),
            ],
        })
        expect(cells(wrapper.find('tbody tr'))).toEqual([
            'Nov 4',
            'FailedNo engine answered (18 errors).',
            '0 of 9',
            'No answers',
            '$0.00',
            '0',
            'Not sent: this number texted STOP.',
        ])
        expect(wrapper.find('.art-error').text()).toBe('No engine answered (18 errors).')
    })

    it('shows why a run was skipped, and no error under a run that finished', () => {
        const wrapper = render({
            runs: [
                runSummary({
                    id: 'a',
                    status: 'skipped',
                    error: { code: 'reserve_reached', message: 'Autopilot keeps the last 10% of your AI allowance for your own questions. Runs resume Dec 1.' },
                }),
                runSummary({ id: 'b', status: 'done', error: { code: 'x', message: 'ignored' } }),
            ],
        })
        expect(wrapper.findAll('.art-error').map((p) => p.text())).toEqual([
            'Autopilot keeps the last 10% of your AI allowance for your own questions. Runs resume Dec 1.',
        ])
    })

    it('stops a running run', async () => {
        const run = runSummary({ status: 'running', text: { status: 'not_requested' } })
        const wrapper = render({ runs: [run] })
        const stop = wrapper.find('.art-stop')
        expect(stop.text()).toBe('Stop')
        await stop.trigger('click')
        expect(wrapper.emitted('stop')).toEqual([[run]])
        await wrapper.setProps({ stopping: run.id })
        expect(wrapper.find('.art-stop').attributes('disabled')).toBeDefined()
        expect(render({ runs: [runSummary()] }).find('.art-stop').exists()).toBe(false)
    })
})
