import { describe, expect, it } from 'vitest'
import { defaultRepresentation, normalizeVizSpec, representationsFor, tableModel } from '@/lib/charts/spec'
import {
    aiByPrompt,
    biggestGaps,
    brandTiles,
    citationClasses,
    citationEngines,
    citationTiles,
    compareBrands,
    googleByPrompt,
    googleState,
    headToHeadRows,
    siteRows,
    visibilityByBrand,
} from '../benchmarkSpecs'
import { citationsPayload, competitorsPayload } from '@/pages/analytics/__tests__/__fixtures__/measurementPayloads'

const offered = (spec, picked = null) => representationsFor(normalizeVizSpec(spec), { picked })
const dataset = (spec, key) => spec.datasets.find((d) => d.key === key)

describe('brandTiles', () => {
    it('gives each brand its visibility, how often it was named and its colour', () => {
        const tiles = brandTiles(competitorsPayload())
        expect(tiles.map((t) => [t.label, t.value, t.hint, t.tone])).toEqual([
            ['Notion', 33.3, 'Named in 40 of 120 answers', 'var(--viz-cat-1)'],
            ['Evernote', 41.7, 'Named in 50 of 120 answers', 'var(--viz-cat-2)'],
            ['Obsidian', 5, 'Named in 6 of 120 answers', 'var(--viz-cat-3)'],
        ])
        expect(tiles[0]).toMatchObject({ kind: 'percent', stateText: 'No answers' })
    })

    it('reads No answers without answers in the window', () => {
        const payload = competitorsPayload({
            ai: { answers: 0, brands: { you: { named: 0, visibility_pct: null, avg_rank: null, first_place: 0, series: [null, null] } } },
        })
        const [you] = brandTiles(payload)
        expect(you).toMatchObject({ value: null, stateText: 'No answers', hint: '' })
    })
})

describe('visibilityByBrand', () => {
    it('draws one line per brand in its brand colour, with the matching footnote', () => {
        const spec = visibilityByBrand(competitorsPayload())
        expect(spec).toMatchObject({
            id: 'competitors.visibility',
            title: 'AI visibility by brand',
            subtitle: 'Share of engine answers that name each brand.',
            x: 'time',
            value: 'percent',
            type: 'line',
            footnote:
                "A competitor counts as named when an answer lists its name or its domain name; its rank is its place in the answer's list.",
        })
        expect(spec.datasets.map((d) => [d.key, d.entity, d.data])).toEqual([
            ['you', 'brand:you', [40, null]],
            ['b1', 'brand:b1', [45, null]],
            ['b2', 'brand:b2', [5, null]],
        ])
        expect(offered(spec)).toEqual(['line', 'area', 'bar', 'heatmap', 'table'])
    })
})

describe('compareBrands', () => {
    it('offers six measures one at a time', () => {
        const spec = compareBrands(competitorsPayload())
        expect(spec).toMatchObject({ id: 'competitors.compare', title: 'This period by brand', pick_one: true, type: 'bar' })
        expect(spec.label_names).toEqual({ you: 'Notion', b1: 'Evernote', b2: 'Obsidian' })
        expect(spec.datasets.map((d) => [d.label, d.value])).toEqual([
            ['AI visibility', 'percent'],
            ['Answers naming them', 'count'],
            ['Ranked first', 'count'],
            ['Avg. rank when named', 'rank'],
            ['Citations', 'count'],
            ['Prompts on Google page one', 'count'],
        ])
        expect(dataset(spec, 'named').data).toEqual([40, 50, 6])
        expect(dataset(spec, 'first_place').data).toEqual([12, 20, 0])
        // Obsidian was named, but never with a place in a list.
        expect(dataset(spec, 'avg_rank').data).toEqual([2.4, 1.8, null])
        expect(dataset(spec, 'avg_rank').states).toEqual([null, null, 'named'])
        expect(dataset(spec, 'citations').data).toEqual([12, 20, 0])
        expect(dataset(spec, 'google_page_one').data).toEqual([1, 2, 0])
        expect(offered(spec, 'visibility')).toEqual(['bar', 'table'])
        expect(offered(spec, 'avg_rank')).toEqual(['table'])
    })

    it('marks citations and Google as not measured, never 0', () => {
        const spec = compareBrands(
            competitorsPayload({
                citations: { has_data: false, brands: null },
                google: { configured: false, prompts_checked: 0, oldest_check_at: null, brands: null },
            }),
        )
        expect(dataset(spec, 'citations').states).toEqual(['not_measured', 'not_measured', 'not_measured'])
        expect(dataset(spec, 'citations').data).toEqual([null, null, null])
        expect(dataset(spec, 'google_page_one').states).toEqual(['not_configured', 'not_configured', 'not_configured'])
        const unchecked = compareBrands(
            competitorsPayload({ google: { configured: true, prompts_checked: 0, oldest_check_at: null, brands: null } }),
        )
        expect(dataset(unchecked, 'google_page_one').states).toEqual(['not_checked', 'not_checked', 'not_checked'])
    })

    it('reads the Google state of the whole comparison', () => {
        expect(googleState(competitorsPayload())).toBe('ok')
        expect(googleState(competitorsPayload({ google: { configured: false } }))).toBe('not_configured')
        expect(googleState(competitorsPayload({ google: { configured: true, prompts_checked: 0, brands: null } }))).toBe(
            'not_checked',
        )
    })
})

describe('by prompt views', () => {
    it('shows AI visibility per prompt; prompts without answers are Not checked', () => {
        const spec = aiByPrompt(competitorsPayload())
        // Calm default: the table first, the heatmap still offered.
        expect(spec).toMatchObject({ id: 'competitors.ai_by_prompt', title: 'AI visibility by prompt', type: 'table' })
        expect(defaultRepresentation(normalizeVizSpec(spec))).toBe('table')
        expect(spec.label_names.p3).toBe('note app with offline mode')
        expect(dataset(spec, 'you').data).toEqual([25, null, 16.7])
        expect(dataset(spec, 'you').states).toEqual([null, 'not_checked', null])
        // A measured 0% stays 0.
        expect(dataset(spec, 'b2').data).toEqual([0, null, 66.7])
        expect(offered(spec)).toEqual(['heatmap', 'table'])
    })

    it('shows Google positions with misses, failures and prompts never checked', () => {
        const spec = googleByPrompt(competitorsPayload())
        expect(spec).toMatchObject({
            id: 'competitors.google_by_prompt',
            title: 'Google position by prompt',
            value: 'rank',
            type: 'table',
            state_labels: { not_found: 'Not on page one' },
            footnote: "From each prompt's latest Google check. Competitors are seen only on page one.",
        })
        expect(defaultRepresentation(normalizeVizSpec(spec))).toBe('table')
        expect(dataset(spec, 'you').data).toEqual([14, null, null])
        expect(dataset(spec, 'you').states).toEqual([null, 'not_checked', 'failed'])
        expect(dataset(spec, 'b1').states).toEqual(['not_found', 'not_checked', 'failed'])
        expect(dataset(spec, 'b2').data).toEqual([3, null, null])
        const table = tableModel(spec)
        expect(table.rows[0].cells.map((c) => c.text)).toEqual(['#14', 'Not on page one', '#3'])
        expect(table.rows[2].cells.map((c) => c.text)).toEqual(['Failed', 'Failed', 'Failed'])
        expect(offered(spec)).toEqual(['heatmap', 'table'])
    })
})

describe('biggestGaps', () => {
    it('lists the prompts where a competitor is named most above you', () => {
        const gaps = biggestGaps(competitorsPayload())
        expect(gaps.map((g) => g.text)).toEqual([
            'note app with offline mode: Obsidian 67%, you 17%',
            'best note taking app for teams: Evernote 50%, you 25%',
        ])
        expect(gaps[1].values).toEqual({
            prompt: 'best note taking app for teams',
            competitor: 'Evernote',
            their_pct: 50,
            our_pct: 25,
            our_google: '#14',
            their_google: 'not on page one',
        })
        // A failed Google check leaves the Google words out.
        expect(gaps[0].values.our_google).toBeNull()
        expect(gaps[0].values.their_google).toBeNull()
    })

    it('keeps at most five', () => {
        const payload = competitorsPayload()
        payload.by_prompt = Array.from({ length: 8 }, (_, i) => ({
            prompt_id: `q${i}`,
            text: `prompt ${i}`,
            answers: 4,
            ai: { you: 0, b1: 10 * (i + 1), b2: 0 },
            google_state: 'not_checked',
            google: null,
        }))
        const gaps = biggestGaps(payload)
        expect(gaps).toHaveLength(5)
        expect(gaps[0].promptId).toBe('q7')
    })
})

describe('tables', () => {
    it('lists head to head per competitor', () => {
        expect(headToHeadRows(competitorsPayload())).toEqual([
            { key: 'b1', name: 'Evernote', color: 'var(--viz-cat-2)', both: 25, youAhead: 10, theyAhead: 13, noOrder: 2 },
            { key: 'b2', name: 'Obsidian', color: 'var(--viz-cat-3)', both: 4, youAhead: 3, theyAhead: 0, noOrder: 1 },
        ])
    })

    it('reads each brand\'s home page audit, or Not audited', () => {
        expect(siteRows(competitorsPayload()).map((r) => [r.name, r.checks, r.aiSearch])).toEqual([
            ['Notion', '7 of 9', 'Yes'],
            ['Evernote', 'Not audited', 'Not audited'],
            ['Obsidian', '6 of 9', 'No'],
        ])
    })
})

describe('citation analytics', () => {
    it('builds the four tiles from the totals', () => {
        expect(citationTiles(citationsPayload()).map((t) => [t.label, t.value])).toEqual([
            ['Answers with sources', '80 of 120'],
            ['Sources listed', 340],
            ['Cited in the answer text', '210 of 340'],
            ['Your pages cited', 31],
        ])
        const empty = citationTiles(citationsPayload({ has_data: false, totals: null }))
        expect(empty.every((t) => t.value === null && t.stateText === 'Not recorded')).toBe(true)
    })

    it('draws sources by type as parts of the whole, with a donut for six types or fewer', () => {
        const spec = citationClasses(citationsPayload())
        expect(spec).toMatchObject({ id: 'citations.classes', title: 'Sources by type', stacked: true, type: 'hbar' })
        expect(spec.label_names).toEqual({ reddit: 'Reddit', your_site: 'Your Site', competitor_site: 'Competitor' })
        expect(spec.datasets[0]).toMatchObject({ label: 'Sources listed', data: [40, 31, 25] })
        expect(offered(spec)).toEqual(['hbar', 'doughnut', 'table'])
        const many = citationsPayload({
            by_class: Array.from({ length: 7 }, (_, i) => ({ key: `c${i}`, label: `Class ${i}`, citations: i + 1 })),
        })
        expect(offered(citationClasses(many))).toEqual(['hbar', 'table'])
    })

    it('draws sources by engine one measure at a time', () => {
        const spec = citationEngines(citationsPayload())
        expect(spec).toMatchObject({ id: 'citations.engines', title: 'Sources by engine', pick_one: true, type: 'bar' })
        expect(spec.datasets.map((d) => [d.label, d.data])).toEqual([
            ['Answers with sources', [40, 40]],
            ['Sources listed', [160, 180]],
            ['Your pages listed', [5, 0]],
        ])
        expect(offered(spec)).toEqual(['bar', 'table'])
    })
})
