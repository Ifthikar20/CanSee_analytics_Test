// The Latest report block's model: the newest saved report of the list,
// its cover and the reports before it.
import { describe, expect, it } from 'vitest'
import { UNTITLED, coverModel, earlierReports, reportLocation, reportsList, reportsLocation, titleScale } from '../report'

const row = (over = {}) => ({
    id: 'r1', kind: 'report', title: 'Where Wrenfield stands', agent_key: 'gap_analyst', latest_version: 2,
    created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-08T09:12:00Z', created_by_name: 'Mara Lindqvist',
    source_chat_id: null, review: null, ...over,
})
const engines = (...pairs) => pairs.map(([key, status, label]) => ({ key, status, ...(label ? { label } : {}) }))
const detail = (over = {}, header = {}) => ({
    id: 'r1', kind: 'report',
    data: {
        template: 'google_ai_gap',
        header: {
            template: { id: 'google_ai_gap', name: 'Google vs AI gap' },
            project: { name: 'Wrenfield', url: 'https://wrenfield.co' },
            captured_at: '2026-11-08T09:00:00Z',
            engines: engines(['chatgpt', 'asked'], ['claude', 'asked'], ['grok', 'not_configured']),
            ...header,
        },
    },
    ...over,
})

describe('reportsList', () => {
    it('keeps the reports of a payload, newest first', () => {
        const list = reportsList([
            row({ id: 'a', updated_at: '2026-10-01T00:00:00Z' }),
            row({ id: 'b', updated_at: '2026-11-08T00:00:00Z' }),
            row({ id: 'c', updated_at: '2026-10-20T00:00:00Z' }),
        ])
        expect(list.map((r) => r.id)).toEqual(['b', 'c', 'a'])
        expect(list[0]).toEqual({ id: 'b', title: 'Where Wrenfield stands', when: '2026-11-08T00:00:00Z', date: expect.stringMatching(/^Nov \d+, 2026$/), version: 2, author: 'Mara Lindqvist' })
    })

    it('reads a paged payload, numeric ids and the created date when nothing was updated', () => {
        const list = reportsList({ results: [row({ id: 7, updated_at: null }), row({ id: 8, updated_at: 'never', created_at: undefined })] })
        expect(list.map((r) => [r.id, r.when])).toEqual([['7', '2026-11-01T10:00:00Z'], ['8', '']])
        expect(list[1].date).toBe('')
    })

    it("keeps the server's order for equal and missing dates, dated rows first", () => {
        const same = '2026-11-08T00:00:00Z'
        const list = reportsList([
            row({ id: 'x', updated_at: null, created_at: null }),
            row({ id: 'a', updated_at: same }),
            row({ id: 'y', updated_at: null, created_at: null }),
            row({ id: 'b', updated_at: same }),
        ])
        expect(list.map((r) => r.id)).toEqual(['a', 'b', 'x', 'y'])
    })

    it('drops rows without an id and artifacts that are not reports', () => {
        const list = reportsList([null, 'x', {}, row({ id: '' }), row({ id: null }), row({ id: 'doc', kind: 'document' }), row({ id: 'r', kind: undefined })])
        expect(list.map((r) => r.id)).toEqual(['r'])
    })

    it('names an untitled report and ignores a version it cannot read', () => {
        const [r] = reportsList([row({ title: '   ', latest_version: 0, created_by_name: null })])
        expect(r).toMatchObject({ title: UNTITLED, version: null, author: '' })
        expect(reportsList([row({ latest_version: '3' })])[0].version).toBe(3)
        expect(reportsList([row({ latest_version: 1.5 })])[0].version).toBeNull()
    })

    it('is empty for anything that is not a list', () => {
        for (const bad of [null, undefined, {}, 'x', 3, { results: 'x' }]) expect(reportsList(bad)).toEqual([])
    })
})

describe('titleScale', () => {
    it('sets a short title large and a long one small', () => {
        expect(titleScale('First look')).toBe('lg')
        expect(titleScale('x'.repeat(40))).toBe('lg')
        expect(titleScale('x'.repeat(41))).toBe('md')
        expect(titleScale('x'.repeat(80))).toBe('md')
        expect(titleScale('x'.repeat(81))).toBe('sm')
        expect(titleScale('')).toBe('lg')
        expect(titleScale(null)).toBe('lg')
    })
})

describe('coverModel', () => {
    const [report] = reportsList([row()])

    it('covers a report with what the list gave when its detail is not there', () => {
        const cover = coverModel(report, null, 'w1')
        expect(cover).toEqual({
            id: 'r1', title: 'Where Wrenfield stands', scale: 'lg', template: '', date: report.date, version: 'v2',
            author: 'Mara Lindqvist', engines: [], asked: [], enginesText: '', captured: '',
            to: { name: 'agent-artifact', params: { websiteId: 'w1', artifactId: 'r1' } },
        })
    })

    it("adds the template and the engines asked from the report's header", () => {
        const cover = coverModel(report, detail(), 'w1')
        expect(cover.template).toBe('Google vs AI gap')
        expect(cover.asked).toEqual(['ChatGPT', 'Claude'])
        expect(cover.enginesText).toBe('ChatGPT, Claude')
        expect(cover.engines.map((e) => [e.key, e.status])).toEqual([['chatgpt', 'asked'], ['claude', 'asked'], ['grok', 'not_configured']])
        expect(cover.captured).toMatch(/^Nov \d+, 2026$/)
    })

    it('says so when the report asked no AI engine', () => {
        const cover = coverModel(report, detail({}, { engines: engines(['chatgpt', 'failed'], ['grok', 'not_configured']) }), 'w1')
        expect(cover.asked).toEqual([])
        expect(cover.enginesText).toBe('No AI engine asked')
    })

    it("ignores another report's detail and a report saved before headers existed", () => {
        expect(coverModel(report, detail({ id: 'other' }), 'w1')).toMatchObject({ template: '', engines: [], enginesText: '' })
        expect(coverModel(report, { id: 'r1', data: null }, 'w1')).toMatchObject({ template: '', engines: [] })
        expect(coverModel(report, { id: 'r1', data: { header: null } }, 'w1').template).toBe('')
        // An unknown template id names nothing.
        const odd = detail()
        odd.data.template = 'made_up'
        odd.data.header.template = { id: 'made_up', name: 'Made up' }
        expect(coverModel(report, odd, 'w1').template).toBe('')
    })

    it('has no version, date or link it was not given', () => {
        const [bare] = reportsList([row({ latest_version: null, updated_at: null, created_at: null })])
        expect(coverModel(bare, null, '')).toMatchObject({ version: '', date: '', to: null })
        expect(coverModel(null)).toBeNull()
        expect(coverModel({})).toBeNull()
    })
})

describe('locations and earlier reports', () => {
    it('links a report to its page and the block to the Reports page', () => {
        expect(reportLocation(5, 9)).toEqual({ name: 'agent-artifact', params: { websiteId: '5', artifactId: '9' } })
        expect(reportLocation('', 'r1')).toBeNull()
        expect(reportLocation('w1', '')).toBeNull()
        expect(reportsLocation('w1')).toEqual({ name: 'agent-reports', params: { websiteId: 'w1' } })
        expect(reportsLocation('')).toBeNull()
    })

    it('lists the reports after the newest, numbered from 02, up to the limit', () => {
        const list = reportsList(['a', 'b', 'c', 'd'].map((id, i) => row({ id, updated_at: `2026-11-0${9 - i}T00:00:00Z` })))
        const earlier = earlierReports(list, 'w1')
        expect(earlier.map((r) => [r.index, r.id])).toEqual([['02', 'b'], ['03', 'c'], ['04', 'd']])
        expect(earlier[0].to).toEqual({ name: 'agent-artifact', params: { websiteId: 'w1', artifactId: 'b' } })
        expect(earlierReports(list, 'w1', 1).map((r) => r.id)).toEqual(['b'])
        expect(earlierReports(list, 'w1', 0)).toEqual([])
        expect(earlierReports(list.slice(0, 1), 'w1')).toEqual([])
        expect(earlierReports(null, 'w1')).toEqual([])
    })
})
