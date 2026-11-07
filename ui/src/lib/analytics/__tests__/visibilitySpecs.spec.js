import { describe, expect, it } from 'vitest'
import { defaultRepresentation, normalizeVizSpec, representationsFor } from '@/lib/charts/spec'
import {
    byEngine,
    byPromptHeatmap,
    citationsOverTime,
    hasBrandMentions,
    hasSentiment,
    headlineTiles,
    periodDays,
    sentimentOverTime,
    shareOfVoiceOverTime,
    shareOfVoiceTotal,
    topDomains,
    visibilityOverTime,
} from '../visibilitySpecs'
import { visibilityPayload } from '@/pages/analytics/__tests__/__fixtures__/analyticsPayloads'

const offered = (spec, picked = null) => representationsFor(normalizeVizSpec(spec), { picked })

describe('visibilityOverTime', () => {
    it('draws one line per engine, keeping empty days as gaps', () => {
        const spec = visibilityOverTime(visibilityPayload())
        expect(spec).toMatchObject({
            id: 'visibility.engines',
            title: 'Visibility over time',
            subtitle: 'Share of answers that name you, by engine.',
            x: 'time',
            time_unit: 'day',
            value: 'percent',
            labels: ['2026-10-06', '2026-10-07'],
            type: 'line',
            footnote: "Each point is the share of that day's answers that name you. Days without answers are gaps.",
        })
        expect(spec.datasets).toEqual([
            { key: 'chatgpt', label: 'ChatGPT', entity: 'engine:chatgpt', data: [40, null] },
            { key: 'claude', label: 'Claude', entity: 'engine:claude', data: [28.6, null] },
        ])
        expect(offered(spec)).toEqual(['line', 'area', 'bar', 'heatmap', 'table'])
    })

    it('takes the caller id and title, and names weeks', () => {
        const payload = visibilityPayload({ window: { period: '90d', interval: 'week', buckets: ['2026-08-03'] } })
        const spec = visibilityOverTime(payload, { id: 'overview.trend', title: 'AI visibility over time' })
        expect(spec.id).toBe('overview.trend')
        expect(spec.title).toBe('AI visibility over time')
        expect(spec.time_unit).toBe('week')
        expect(spec.footnote).toContain("that week's answers")
        expect(spec.datasets[0].data).toEqual([40])
    })

    it('copes with an empty payload', () => {
        const spec = visibilityOverTime(null)
        expect(spec.labels).toEqual([])
        expect(spec.datasets).toEqual([])
        expect(normalizeVizSpec(spec)).toBeNull()
    })
})

describe('byPromptHeatmap', () => {
    it('puts prompts on rows and configured engines on columns, with states for no answers', () => {
        const spec = byPromptHeatmap(visibilityPayload())
        expect(spec.labels).toEqual(['p1', 'p2'])
        expect(spec.label_names).toEqual({
            p1: 'best note taking app for teams',
            p2: 'notion alternatives for small startups',
        })
        expect(spec.datasets.map((d) => d.key)).toEqual(['chatgpt', 'claude'])
        // A measured 0% stays 0; an engine with no answer reads "Not checked".
        expect(spec.datasets[0].data).toEqual([66.7, 0])
        expect(spec.datasets[0].states).toEqual([null, null])
        expect(spec.datasets[1].data).toEqual([25, null])
        expect(spec.datasets[1].states).toEqual([null, 'not_checked'])
        // Calm default: the table first, the heatmap still offered.
        expect(spec.type).toBe('table')
        expect(offered(spec)).toEqual(['heatmap', 'table'])
        expect(defaultRepresentation(normalizeVizSpec(spec))).toBe('table')
    })

    it('keeps the heatmap with one engine and marks unconfigured engines', () => {
        const filtered = byPromptHeatmap(visibilityPayload({ filters: { engine: 'chatgpt', prompt_id: null } }))
        expect(filtered.datasets.map((d) => d.key)).toEqual(['chatgpt'])
        expect(offered(filtered)).toEqual(['heatmap', 'table'])

        const payload = visibilityPayload({ filters: { engine: 'gemini', prompt_id: null } })
        const spec = byPromptHeatmap(payload)
        expect(spec.datasets[0].states).toEqual(['not_configured', 'not_configured'])
        expect(spec.datasets[0].data).toEqual([null, null])
    })
})

describe('share of voice', () => {
    it('stacks brand shares over time in the brand color order', () => {
        const spec = shareOfVoiceOverTime(visibilityPayload())
        expect(spec.datasets.map((d) => [d.key, d.label, d.entity])).toEqual([
            ['you', 'Notion', 'brand:you'],
            ['b1', 'Evernote', 'brand:b1'],
            ['other', 'Other brands', 'brand:other'],
        ])
        expect(spec.stacked).toBe(true)
        expect(spec.type).toBe('line')
        expect(offered(spec)).toEqual(['line', 'area', 'stacked_bar', 'table'])
    })

    it('totals the period as bars, with a donut while there are at most six brands', () => {
        const spec = shareOfVoiceTotal(visibilityPayload())
        expect(spec.labels).toEqual(['you', 'b1', 'other'])
        expect(spec.label_names.you).toBe('Notion')
        expect(spec.label_entities).toEqual({ you: 'brand:you', b1: 'brand:b1', other: 'brand:other' })
        expect(spec.datasets[0].data).toEqual([18.2, 27.3, 13.6])
        expect(offered(spec)).toEqual(['hbar', 'doughnut', 'table'])

        const many = visibilityPayload()
        many.share_of_voice.brands = ['you', 'b1', 'b2', 'b3', 'b4', 'b5', 'other'].map((key) => ({
            key, name: key, mentions: 1, share_pct: 14.3,
        }))
        expect(offered(shareOfVoiceTotal(many))).toEqual(['hbar', 'table'])
    })

    it('knows when no brand was named', () => {
        expect(hasBrandMentions(visibilityPayload())).toBe(true)
        const none = visibilityPayload()
        none.share_of_voice.brands = []
        expect(hasBrandMentions(none)).toBe(false)
    })
})

describe('sentiment and citations', () => {
    it('stacks the tone of named answers, negative first', () => {
        const spec = sentimentOverTime(visibilityPayload())
        expect(spec.datasets.map((d) => d.entity)).toEqual([
            'sentiment:negative',
            'sentiment:neutral',
            'sentiment:positive',
        ])
        expect(spec.datasets[2].data).toEqual([2, 0])
        expect(spec.value).toBe('count')
        expect(offered(spec)).toEqual(['stacked_bar', 'line', 'table'])
        expect(hasSentiment(visibilityPayload())).toBe(true)
        expect(hasSentiment(visibilityPayload({ sentiment: { totals: { positive: 0, neutral: 0, negative: 0 } } }))).toBe(false)
    })

    it('splits citations into yours, competitors and other', () => {
        const spec = citationsOverTime(visibilityPayload())
        expect(spec.datasets.map((d) => [d.label, d.entity])).toEqual([
            ['Yours', 'brand:you'],
            ['Competitors', 'brand:b1'],
            ['Other', 'muted'],
        ])
        expect(offered(spec)).toEqual(['stacked_bar', 'line', 'area', 'table'])
    })

    it('names your and competitor domains, one measure at a time', () => {
        const spec = topDomains(visibilityPayload())
        expect(spec.label_names).toEqual({
            'g2.com': 'g2.com',
            'notion.so': 'notion.so (yours)',
            'evernote.com': 'evernote.com (competitor)',
        })
        expect(spec.pick_one).toBe(true)
        expect(spec.datasets.map((d) => d.label)).toEqual(['Citations', 'Answers citing it'])
        expect(offered(spec)).toEqual(['hbar', 'table'])
    })
})

describe('byEngine', () => {
    it('offers bars for visibility and answers, and only the table for rank', () => {
        const spec = byEngine(visibilityPayload())
        // Gemini is not configured and has no answers: left out.
        expect(spec.labels).toEqual(['chatgpt', 'claude'])
        const [visibility, answers, rank] = spec.datasets
        expect(visibility.data).toEqual([40, 28.6])
        expect(answers.data).toEqual([5, 7])
        // Claude names you without a position: "Named", never 0.
        expect(rank.data).toEqual([2, null])
        expect(rank.states).toEqual([null, 'named'])
        expect(offered(spec, 'visibility')).toEqual(['bar', 'table'])
        expect(offered(spec, 'answers')).toEqual(['bar', 'table'])
        expect(offered(spec, 'avg_rank')).toEqual(['table'])
    })

    it('says "No answers" and "Not named" instead of zeros', () => {
        const payload = visibilityPayload()
        payload.by_engine[1] = { ...payload.by_engine[1], answers: 0, mentioned: 0, visibility_pct: null, avg_rank: null }
        payload.by_engine[0] = { ...payload.by_engine[0], mentioned: 0, visibility_pct: 0, avg_rank: null }
        const spec = byEngine(payload)
        expect(spec.datasets[0].data).toEqual([0, null])
        expect(spec.datasets[0].states).toEqual([null, 'not_measured'])
        expect(spec.datasets[1].data).toEqual([5, 0])
        expect(spec.datasets[2].states).toEqual(['not_found', 'not_measured'])
        expect(spec.state_labels).toEqual({ not_measured: 'No answers', not_found: 'Not named' })
    })
})

describe('headlineTiles', () => {
    it('builds the five tiles with deltas against the previous window', () => {
        const tiles = headlineTiles(visibilityPayload())
        expect(tiles.map((t) => t.label)).toEqual([
            'AI visibility',
            'Share of voice',
            'Avg. rank when named',
            'Answers collected',
            'Your citations',
        ])
        expect(tiles[0]).toMatchObject({
            value: 34.2,
            kind: 'percent',
            delta: { value: 4.1, unit: 'pts', label: 'vs previous 30 days', goodWhen: 'up' },
        })
        // No previous share of voice: no delta rather than a made-up one.
        expect(tiles[1].delta).toBeNull()
        expect(tiles[2].delta).toEqual({ value: -0.6, unit: 'rank', label: 'vs previous 30 days', goodWhen: 'down' })
        expect(tiles[3]).toMatchObject({ value: 12, kind: 'count', delta: { value: 50, unit: 'pct' } })
        expect(tiles[4].value).toBe('12 of 340')
    })

    it('shows the state words for nulls, and a measured zero as 0', () => {
        const payload = visibilityPayload({
            headline: {
                answers: 0, answers_prev: null, visibility_pct: null, visibility_prev_pct: null,
                avg_rank: null, avg_rank_prev: null, share_of_voice_pct: null, share_of_voice_prev_pct: null,
                citations: null, your_citations: null,
            },
            citations: { has_data: false, totals: null, series: {}, top_domains: [] },
        })
        const tiles = headlineTiles(payload, { period: '7d' })
        expect(tiles.map((t) => [t.value, t.stateText])).toEqual([
            [null, 'No answers'],
            [null, 'No brands named'],
            [null, 'Not named'],
            [0, 'Not measured'],
            [null, 'Not recorded'],
        ])
        expect(tiles.every((t) => t.delta === null)).toBe(true)
    })

    it('reads period days', () => {
        expect(periodDays('7d')).toBe(7)
        expect(periodDays('90d')).toBe(90)
        expect(periodDays('x')).toBe(30)
    })
})
