import { describe, expect, it } from 'vitest'
import {
    GAP_MAP_CLASSES,
    aiUsageSpec,
    gapMapSpec,
    googleHistorySpec,
    isoDays,
    leaderboardSpec,
    overviewTiles,
    retrievalsSpec,
    urlModelsSpec,
    urlRetrievalsSpec,
    urlTypesSpec,
    yourBrand,
} from '../polishSpecs'
import { normalizeVizSpec, pointText, representationsFor, tableModel } from '@/lib/charts/spec'
import { stableSlots } from '@/lib/charts/palette'

// Overview rows as GET /search-gap/websites/<id>/overview/ returns them.
function row(id, fields = {}) {
    return {
        prompt_id: id,
        brand_prompt_id: `bp-${id}`,
        text: `prompt ${id}`,
        location: 'us',
        google: { status: 'ok', position: 4, page: 1, depth: 100, checked_at: '2026-11-01T10:00:00Z', error: '' },
        engines: {
            chatgpt: { configured: true, answers: 3, mentioned: true, rank: 2, visibility_pct: 67, score: 70, class: 'even' },
            claude: { configured: true, answers: 0, mentioned: false, rank: null, visibility_pct: null, score: null, class: 'no_data' },
            gemini: { configured: false, answers: 0, mentioned: false, rank: null, visibility_pct: null, score: null, class: 'no_data' },
        },
        gap: { ai_score: 70, search_score: 80, value: -10, class: 'even' },
        top_action: null,
        ...fields,
    }
}

const norm = (spec) => normalizeVizSpec(spec)

describe('overviewTiles', () => {
    const kpis = {
        prompts: 12,
        ai_visibility_pct: 34,
        avg_google_position: 5.3,
        google_checked: 10,
        not_in_google: 0,
        ai_ahead: 3,
        google_ahead: 0,
        strong_both: 2,
        invisible_both: 1,
    }

    it('keeps the five tiles and hints, with a measured zero as 0 and no colour', () => {
        const tiles = overviewTiles(kpis)
        expect(tiles.map((t) => [t.label, t.value, t.kind, t.hint])).toEqual([
            ['AI visibility', 34, 'percent', 'Share of recent AI answers that name you'],
            ['Avg. Google position', 5.3, 'rank', '10 of 12 checked'],
            ['AI ahead', 3, 'count', 'AI ranks you higher than Google'],
            ['Google ahead', 0, 'count', 'Google ranks you higher than AI'],
            ['Invisible in both', 1, 'count', 'Neither surfaces you'],
        ])
        expect(tiles.some((t) => 'tone' in t)).toBe(false)
        expect(tiles[0].delta).toBeNull()
    })

    it('reads nulls as state words and counts the prompts Google did not rank', () => {
        const unchecked = overviewTiles({ ...kpis, ai_visibility_pct: null, avg_google_position: null, google_checked: 0 })
        expect(unchecked[0]).toMatchObject({ value: null, stateText: 'No answers yet' })
        expect(unchecked[1]).toMatchObject({ value: null, stateText: 'Not checked', hint: '0 of 12 checked' })
        // No Google check yet: the gap classes are unknown, never 0.
        expect(unchecked.slice(2).map((t) => [t.value, t.stateText])).toEqual([
            [null, 'Not checked'],
            [null, 'Not checked'],
            [null, 'Not checked'],
        ])
        // Checked, and every check missed you: measured, not "Not checked".
        // The hint claims only the depth Google was searched to.
        const missedRows = [
            row('a', { google: { status: 'ok', position: null, depth: 30 } }),
            row('b', { google: { status: 'ok', position: null, depth: 50 } }),
            row('c', { google: { status: 'error', position: null, depth: 10 } }),
            row('d'),
        ]
        const missed = overviewTiles({ ...kpis, avg_google_position: null, not_in_google: 2 }, null, missedRows)
        expect(missed[1]).toMatchObject({ value: null, stateText: 'Not found', hint: '2 not in the top 30' })
        expect(overviewTiles({ ...kpis, not_in_google: 4 })[1].hint).toBe('4 not found on Google')
        // A count the payload does not carry is not measured, not zero.
        expect(overviewTiles({})[2].value).toBeNull()
    })

    it('adds the change in points only when both windows have a visibility', () => {
        const [tile] = overviewTiles(kpis, { visibility_pct: 34.2, visibility_prev_pct: 30.1 })
        expect(tile.delta).toEqual({ value: 4.1, unit: 'pts', label: 'vs previous 30 days', goodWhen: 'up' })
        expect(overviewTiles(kpis, { visibility_pct: 34.2, visibility_prev_pct: null })[0].delta).toBeNull()
        expect(overviewTiles(kpis, { visibility_pct: null, visibility_prev_pct: 30 })[0].delta).toBeNull()
    })
})

describe('gapMapSpec', () => {
    const rows = [
        row('a'),
        row('b', { google: { status: 'ok', position: null, page: null, depth: 50 }, gap: { ai_score: 90, value: 90, class: 'ai_ahead' } }),
        row('c', { google: { status: 'error', position: null, depth: 100, error: 'timeout' }, gap: { ai_score: null, value: null, class: 'no_data' } }),
        row('d', { google: { status: 'not_checked', position: null, depth: 100 }, gap: { ai_score: 20, value: null, class: 'no_data' } }),
    ]

    it('offers the map and the table, and names every row by its prompt', () => {
        const spec = norm(gapMapSpec(rows))
        expect(representationsFor(spec)).toEqual(['custom', 'table'])
        expect(spec.custom_label).toBe('Map')
        const table = tableModel(spec)
        expect(table.labelHeader).toBe('Prompt')
        expect(table.columns.map((c) => c.label)).toEqual(['Google', 'AI score', 'Gap'])
        expect(table.rows.map((r) => r.label)).toEqual(['prompt a', 'prompt b', 'prompt c', 'prompt d'])
    })

    it('prints Google as the gap table does and never a zero for what was not measured', () => {
        const spec = norm(gapMapSpec(rows))
        expect([0, 1, 2, 3].map((j) => pointText(spec, 0, j))).toEqual(['#4', 'Not in top 50', 'Check failed', 'Not checked'])
        expect([0, 1, 2, 3].map((j) => pointText(spec, 1, j))).toEqual(['70', '90', 'No answers yet', '20'])
        expect([0, 1, 2, 3].map((j) => pointText(spec, 2, j))).toEqual(['Even (-10)', 'AI ahead (+90)', 'Not checked', 'Not checked'])
    })

    it('lists the five classes the legend explains', () => {
        expect(GAP_MAP_CLASSES).toEqual(['ai_ahead', 'google_ahead', 'strong_both', 'invisible_both', 'even'])
    })
})

describe('leaderboardSpec', () => {
    const brands = [
        { name: 'Evernote', is_you: false, visibility_pct: 60 },
        { name: 'Notion', is_you: true, visibility_pct: 25 },
        { name: 'OneNote', is_you: false, visibility_pct: 0 },
    ]

    it('offers the list, horizontal bars and the table, in percent', () => {
        const spec = norm(leaderboardSpec(brands))
        expect(representationsFor(spec)).toEqual(['custom', 'hbar', 'table'])
        expect(spec.custom_label).toBe('List')
        expect([0, 1, 2].map((j) => pointText(spec, 0, j))).toEqual(['60%', '25%', '0%'])
        expect(yourBrand(brands)).toBe('Notion')
        expect(yourBrand([])).toBe('')
    })
})

describe('googleHistorySpec', () => {
    const history = [
        { checked_at: '2026-10-08T09:00:00Z', position: 7, depth: 100, page: 1, location: 'us', error: '' },
        { checked_at: '2026-10-09T09:00:00Z', position: null, depth: 100, page: null, location: 'gb', error: '' },
        { checked_at: '2026-10-15T09:00:00Z', position: null, depth: 20, page: null, location: 'us', error: '' },
        { checked_at: '2026-10-20T09:00:00Z', position: null, depth: 100, page: null, location: 'US', error: 'timeout' },
        { checked_at: '2026-10-27T09:00:00Z', position: 3, depth: 100, page: 1, location: 'us', error: '' },
    ]

    it('keeps the checks from the prompt\'s own location, oldest first', () => {
        const spec = norm(googleHistorySpec(history, { location: 'us' }))
        expect(spec.labels).toEqual(['2026-10-08T09:00:00Z', '2026-10-15T09:00:00Z', '2026-10-20T09:00:00Z', '2026-10-27T09:00:00Z'])
        expect([0, 1, 2, 3].map((j) => pointText(spec, 0, j))).toEqual(['#7', 'Not in top 20', 'Failed', '#3'])
        expect(representationsFor(spec)).toEqual(['line', 'table'])
        expect(tableModel(spec).rows[0].label).toBe('8 Oct')
    })

    it('matches a Global prompt to checks without a location, and gives nothing for none', () => {
        const global = [{ checked_at: '2026-10-08T09:00:00Z', position: 2, depth: 100, location: '', error: '' }]
        expect(googleHistorySpec(global, { location: '' }).labels).toHaveLength(1)
        expect(norm(googleHistorySpec([], { location: 'us' }))).toBeNull()
        expect(norm(googleHistorySpec(null))).toBeNull()
    })
})

describe('isoDays', () => {
    const today = new Date('2026-11-03T15:00:00Z')

    it('rebuilds consecutive days from the period start', () => {
        expect(isoDays(['Oct 30', 'Oct 31', 'Nov 01'], { start: '2026-10-30' })).toEqual(['2026-10-30', '2026-10-31', '2026-11-01'])
    })

    it('ends on the day near today that the last label names, across a year end', () => {
        expect(isoDays(['Nov 01', 'Nov 02', 'Nov 03'], { today })).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
        // The server's day can be one ahead of this clock.
        expect(isoDays(['Nov 03', 'Nov 04'], { today })).toEqual(['2026-11-03', '2026-11-04'])
        const newYear = new Date('2027-01-01T01:00:00Z')
        expect(isoDays(['Dec 31', 'Jan 01'], { today: newYear })).toEqual(['2026-12-31', '2027-01-01'])
    })

    it('gives up when any label is not the next day', () => {
        expect(isoDays(['Oct 30', 'Nov 01'], { start: '2026-10-30' })).toBeNull()
        expect(isoDays(['Jul 04'], { today })).toBeNull()
        expect(isoDays([], { today })).toBeNull()
    })
})

describe('Sources specs', () => {
    const overview = {
        labels: ['Nov 01', 'Nov 02', 'Nov 03'],
        series: [
            { key: 'g2.com', label: 'g2.com', color: '#475569', data: [1, 0, 2] },
            { key: 'reddit.com', label: 'reddit.com', color: '#8b5cf6', data: [0, 3, 1] },
        ],
    }

    it('colours each domain by its stable slot, kept across a filter change', () => {
        const memory = new Map()
        const first = retrievalsSpec(overview, stableSlots(['g2.com', 'reddit.com'], memory), { start: '2026-11-01' })
        expect(first.datasets.map((d) => [d.key, d.entity])).toEqual([
            ['g2.com', 'slot:1'],
            ['reddit.com', 'slot:2'],
        ])
        expect(first).toMatchObject({ x: 'time', labels: ['2026-11-01', '2026-11-02', '2026-11-03'], value: 'count' })

        // A filter drops g2.com and brings a new domain: reddit.com keeps its colour.
        const filtered = { ...overview, series: [overview.series[1], { key: 'zapier.com', label: 'zapier.com', data: [1, 1, 1] }] }
        const second = retrievalsSpec(filtered, stableSlots(['reddit.com', 'zapier.com'], memory), { start: '2026-11-01' })
        expect(second.datasets.map((d) => [d.key, d.entity])).toEqual([
            ['reddit.com', 'slot:2'],
            ['zapier.com', 'slot:3'],
        ])
        expect(representationsFor(norm(second))).toEqual(['line', 'area', 'stacked_bar', 'heatmap', 'table'])
    })

    it('keeps the server\'s labels as categories when they are not consecutive days', () => {
        const spec = retrievalsSpec({ ...overview, labels: ['a', 'b', 'c'] }, new Map())
        expect(spec).toMatchObject({ x: 'category', labels: ['a', 'b', 'c'] })
        expect(spec.datasets[0].entity).toBe('slot:other')
    })

    it('offers bars and a donut for URL types', () => {
        const spec = norm(urlTypesSpec([{ type: 'Listicle', pct: 60 }, { type: 'Comparison', pct: 40 }]))
        expect(representationsFor(spec)).toEqual(['bar', 'doughnut', 'table'])
        expect(pointText(spec, 0, 0)).toBe('60%')
        expect(norm(urlTypesSpec([]))).toBeNull()
    })

    it('compares a URL\'s retrievals with the previous period in grey', () => {
        const spec = norm(
            urlRetrievalsSpec({ labels: ['Nov 02', 'Nov 03'], current: [2, 1], previous: [0, 4] })
        )
        expect(spec.datasets.map((d) => [d.label, d.entity])).toEqual([
            ['This period', 'slot:1'],
            ['Previous period', 'muted'],
        ])
        expect(representationsFor(spec)).toEqual(['bar', 'line', 'table'])
    })

    it('colours retrievals by model by engine, one period at a time', () => {
        const spec = norm(
            urlModelsSpec([
                { model: 'gpt4', current: 5, previous: 2 },
                { model: 'claude', current: 3, previous: 0 },
            ])
        )
        expect(spec.labels).toEqual(['chatgpt', 'claude'])
        expect(spec.label_names).toEqual({ chatgpt: 'ChatGPT', claude: 'Claude' })
        expect(spec.label_entities).toEqual({ chatgpt: 'engine:chatgpt', claude: 'engine:claude' })
        expect(representationsFor(spec)).toEqual(['bar', 'doughnut', 'table'])
        expect(tableModel(spec).columns.map((c) => c.label)).toEqual(['This period', 'Previous period'])
    })
})

describe('aiUsageSpec', () => {
    it('draws the daily spend in dollars', () => {
        const spec = norm(
            aiUsageSpec(
                [
                    { day: '2026-11-01', calls: 4, tokens: 1200, cost: 0.0123 },
                    { day: '2026-11-02', calls: 9, tokens: 5100, cost: 0.42 },
                ],
                { subtitle: 'Nov 1 – Nov 30' }
            )
        )
        expect(spec).toMatchObject({ id: 'settings.ai_usage', x: 'time', value: 'usd', subtitle: 'Nov 1 – Nov 30' })
        expect(representationsFor(spec)).toEqual(['bar', 'line', 'table'])
        expect([0, 1].map((j) => pointText(spec, 0, j))).toEqual(['$0.01', '$0.42'])
    })
})
