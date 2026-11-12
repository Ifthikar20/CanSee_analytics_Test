// What the Latest report card shows in each state: the newest saved
// report as a cover (the list's title, date and version; the header's
// template and engines once the detail loads), the reports before it at
// full size, and what it tells its frame.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({ getArtifact: vi.fn() }))

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))
vi.mock('@/api/agent', () => ({ default: api }))

const { mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { reportDetail, reportRow } = await import('./__fixtures__/payloads')
const { resetReportDetails } = await import('../useReportDetail')
const { default: LatestReportCard } = await import('../LatestReportCard.vue')

const mounted = []

async function render({ props = {}, reports, detail = null } = {}) {
    if (detail) api.getArtifact.mockResolvedValue({ data: detail })
    if (reports !== undefined) setSource('reports', reports && reports.failure ? reports : { data: reports })
    const out = await mountOnBoard(LatestReportCard, { props })
    mounted.push(out.wrapper)
    await flushPromises()
    return out
}

const meta = (wrapper) => wrapper.findAll('.lr-meta-item').map((el) => [el.find('dt').text(), el.find('dd').text()])
const OLDER = [
    reportRow({ id: 'r0', title: 'What changed since October', updated_at: '2026-10-27T12:00:00Z', latest_version: 1 }),
    reportRow({ id: 'r-1', title: 'First look', updated_at: '2026-10-14T12:00:00Z', latest_version: 1 }),
]

beforeEach(() => {
    resetSources()
    resetReportDetails()
    api.getArtifact.mockReset()
    api.getArtifact.mockRejectedValue(new Error('none'))
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe('LatestReportCard with a report', () => {
    it('covers the newest report with what the list gave: title, date, version and the way in', async () => {
        const { wrapper, last } = await render({ reports: [reportRow()] })
        expect(wrapper.find('.lr-kind').text()).toBe('Report')
        expect(wrapper.find('.lr-kind .cs-mark').attributes('aria-hidden')).toBe('true')
        expect(wrapper.find('.lr-title').text()).toBe('Where Wrenfield stands in AI answers')
        expect(wrapper.find('.lr-top').text()).toContain('v3')
        expect(meta(wrapper)).toEqual([['Saved', 'Nov 8, 2026']])
        const open = wrapper.find('a.lr-open')
        expect(open.text()).toBe('Open report')
        expect(open.attributes('href')).toBe('/projects/w1/agent/artifacts/r1')
        expect(open.attributes('aria-label')).toBe('Open report: Where Wrenfield stands in AI answers')
        expect(wrapper.find('a.lr-title-link').attributes('href')).toBe('/projects/w1/agent/artifacts/r1')
        expect(last()).toBe('live')
    })

    it("adds the template and the engines asked once the report's own header loads", async () => {
        const { wrapper } = await render({ reports: [reportRow()], detail: reportDetail() })
        expect(api.getArtifact).toHaveBeenCalledTimes(1)
        expect(api.getArtifact).toHaveBeenCalledWith('w1', 'r1', { _silentError: true })
        expect(wrapper.find('.lr-kind').text()).toBe('Google vs AI gap')
        expect(meta(wrapper)).toEqual([['Saved', 'Nov 8, 2026'], ['Engines', 'ChatGPT, Claude']])
    })

    it('names no template and no engine for a report without a header, or when the detail fails', async () => {
        const old = await render({ reports: [reportRow()], detail: reportDetail({ data: null }) })
        expect(old.wrapper.find('.lr-kind').text()).toBe('Report')
        expect(meta(old.wrapper)).toEqual([['Saved', 'Nov 8, 2026']])
        expect(old.last()).toBe('live')
    })

    it('picks the newest report whatever the order of the payload', async () => {
        const { wrapper } = await render({ reports: [...OLDER, reportRow()] })
        expect(wrapper.find('.lr-title').text()).toBe('Where Wrenfield stands in AI answers')
        expect(api.getArtifact).toHaveBeenCalledWith('w1', 'r1', { _silentError: true })
    })

    it('sets a long title smaller and shows it whole to screen readers', async () => {
        const long = 'How Wrenfield, Obsidian, Notion, Bear and Craft are named across ChatGPT, Claude, Gemini and Perplexity for buyers in Europe'
        const { wrapper } = await render({ reports: [reportRow({ title: long })] })
        expect(wrapper.find('.lr-cover').classes()).toContain('is-sm')
        expect(wrapper.find('.lr-title').text()).toBe(long)
        const short = await render({ reports: [reportRow({ title: 'First look' })] })
        expect(short.wrapper.find('.lr-cover').classes()).toContain('is-lg')
    })

    it('leaves out a date and a version it was not given, and names an untitled report', async () => {
        const { wrapper } = await render({ reports: [reportRow({ title: '', latest_version: null, updated_at: null, created_at: null })] })
        expect(wrapper.find('.lr-title').text()).toBe('Untitled report')
        expect(wrapper.find('.lr-meta-item').exists()).toBe(false)
        expect(wrapper.find('.lr-top').text()).toBe('Report')
    })

    it('keeps the last report and says stale when a refresh failed', async () => {
        setSource('reports', { data: [reportRow()], stale: true })
        const { wrapper, last } = await render()
        expect(wrapper.find('.lr-title').exists()).toBe(true)
        expect(last()).toBe('stale')
    })

    it('adds who saved it and the reports before it at full size', async () => {
        const { wrapper } = await render({ props: { size: 'full' }, reports: [reportRow(), ...OLDER], detail: reportDetail() })
        expect(wrapper.find('.lr').classes()).toContain('is-full')
        expect(meta(wrapper)).toEqual([['Saved', 'Nov 8, 2026'], ['Engines', 'ChatGPT, Claude'], ['By', 'Mara Lindqvist']])
        const section = wrapper.find('.lr-earlier')
        expect(section.attributes('aria-labelledby')).toBe(section.find('h3').attributes('id'))
        expect(section.find('h3').text()).toBe('Earlier reports')
        expect(wrapper.findAll('.lr-row').map((r) => [r.find('.lr-row-index').text(), r.find('a').text(), r.find('a').attributes('href'), r.find('.lr-row-date').text()])).toEqual([
            ['02', 'What changed since October', '/projects/w1/agent/artifacts/r0', 'Oct 27, 2026'],
            ['03', 'First look', '/projects/w1/agent/artifacts/r-1', 'Oct 14, 2026'],
        ])
        expect(wrapper.find('.lr-actions a').attributes('href')).toBe('/projects/w1/agent/reports')
        // Only the newest report's detail is asked for.
        expect(api.getArtifact).toHaveBeenCalledTimes(1)
    })

    it('says so when the newest report is the only one, and keeps the list out of a compact card', async () => {
        const full = await render({ props: { size: 'full' }, reports: [reportRow()] })
        expect(full.wrapper.find('.lr-none').text()).toBe('This is the only saved report of this project.')
        expect(full.wrapper.find('.lr-list').exists()).toBe(false)
        const compact = await render({ reports: [reportRow(), ...OLDER] })
        expect(compact.wrapper.find('.lr-earlier').exists()).toBe(false)
        expect(meta(compact.wrapper).map((m) => m[0])).not.toContain('By')
    })
})

describe('LatestReportCard without a report', () => {
    it('is a skeleton while the reports are on their way', async () => {
        const { wrapper, last } = await render()
        expect(wrapper.find('.bd-skel').exists()).toBe(true)
        expect(last()).toBe('loading')
        expect(api.getArtifact).not.toHaveBeenCalled()
    })

    it('says no report is saved yet and links to the report templates', async () => {
        const { wrapper, last } = await render({ reports: [] })
        expect(wrapper.text()).toContain('No saved report yet.')
        expect(wrapper.find('.lr').exists()).toBe(false)
        const link = wrapper.find('a')
        expect(link.text()).toBe('Report templates')
        expect(link.attributes('href')).toBe('/projects/w1/agent/reports')
        expect(last()).toBe('empty')
        expect(api.getArtifact).not.toHaveBeenCalled()
        // Other artifacts are not reports.
        const docs = await render({ reports: [reportRow({ id: 'd1', kind: 'document' })] })
        expect(docs.last()).toBe('empty')
    })

    it('says it could not load, with a way to try again', async () => {
        const { wrapper, last } = await render({ reports: { failure: { status: 500, code: 'error', message: 'Something went wrong.' } } })
        expect(wrapper.find('[role="alert"]').text()).toContain("The latest report couldn't load.")
        expect(last()).toBe('error')
        await wrapper.find('button').trigger('click')
        expect(reloadOf('reports')).toHaveBeenCalledTimes(1)
    })

    it('follows the reports as they change', async () => {
        const { wrapper, last } = await render({ reports: [] })
        setSource('reports', { data: [reportRow({ id: 'r9', title: 'Brand new' })] })
        await flushPromises()
        expect(wrapper.find('.lr-title').text()).toBe('Brand new')
        expect(last()).toBe('live')
        expect(api.getArtifact).toHaveBeenCalledWith('w1', 'r9', { _silentError: true })
    })
})
