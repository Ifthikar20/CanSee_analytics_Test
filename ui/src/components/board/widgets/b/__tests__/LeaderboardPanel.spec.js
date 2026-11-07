import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { VizChartStub } from '@/pages/__tests__/__fixtures__/vizStub'
import { fakeSource, mountInBoard } from './__fixtures__/harness'
import { failure, overviewPayload } from './__fixtures__/boardPayloads'

const sources = vi.hoisted(() => ({}))
vi.mock('@/composables/board/useBoardSource', () => ({ useBoardSource: (key) => sources[key] }))

const { default: LeaderboardPanel } = await import('../LeaderboardPanel.vue')

const mounted = []

async function mountPanel(source) {
    sources.overview = source
    const wrapper = await mountInBoard(LeaderboardPanel, { panel: true, path: '/projects/w1/analytics?widget=who-recommends' })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
}

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe('LeaderboardPanel', () => {
    it('draws the leaderboard as a list, bars or a table, with you selected', async () => {
        const wrapper = await mountPanel(fakeSource({ data: overviewPayload() }))
        const chart = wrapper.findComponent(VizChartStub)
        const spec = chart.props('spec')
        expect(spec).toMatchObject({ id: 'overview.leaderboard', type: 'custom', custom_label: 'List' })
        expect(spec.representations).toEqual(['custom', 'hbar', 'table'])
        // The panel's title names it already.
        expect(spec.title).toBe('')
        expect(spec.subtitle).toBe('Share of the latest answers that name each brand.')
        expect(chart.props('selected')).toBe('Notion')
        expect(chart.props('empty')).toBeNull()
    })

    it('lists the brands calmly: no coloured initials, your bar the only accent', async () => {
        const wrapper = await mountPanel(fakeSource({ data: overviewPayload() }))
        const rows = wrapper.findAll('.lb-row')
        expect(rows.map((r) => r.find('.lb-name').text())).toEqual(['Evernote', 'Obsidian', 'Coda', 'Notion You', 'Bear', 'Roam'])
        expect(wrapper.find('.lb-avatar').exists()).toBe(false)
        expect(rows.filter((r) => r.classes('is-you'))).toHaveLength(1)
        expect(rows[3].classes('is-you')).toBe(true)
    })

    it('opens Competitors in the panel from its link, which still has a real address', async () => {
        const wrapper = await mountPanel(fakeSource({ data: overviewPayload() }))
        const link = wrapper.find('a.lbp-link')
        expect(link.text()).toBe('Compare with your competitors')
        expect(link.attributes('href')).toBe('/projects/w1/analytics?widget=competitors')
        await link.trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('competitors')
        expect(wrapper.router.currentRoute.value.query).toEqual({ widget: 'who-recommends' })
    })

    it('says when no brand has been named yet', async () => {
        const wrapper = await mountPanel(fakeSource({ data: overviewPayload({ leaderboard: [] }) }))
        expect(wrapper.findComponent(VizChartStub).props('empty')).toEqual({
            title: 'Brands appear here once the engines have answered your prompts.',
        })
    })

    it('loads, then says it could not load with Try again', async () => {
        const loading = await mountPanel(fakeSource())
        expect(loading.findComponent(VizChartStub).props('loading')).toBe(true)

        const source = fakeSource({ failure: failure(500) })
        const wrapper = await mountPanel(source)
        const chart = wrapper.findComponent(VizChartStub)
        expect(chart.props('loading')).toBe(false)
        expect(chart.props('error')).toBe("We couldn't load Who AI recommends.")
        await wrapper.find('.viz-stub-retry').trigger('click')
        expect(source.reload).toHaveBeenCalledTimes(1)
    })
})
