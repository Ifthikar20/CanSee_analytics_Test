import { describe, expect, it } from 'vitest'
import { defaultRepresentation, normalizeVizSpec, representationsFor, tableModel } from '@/lib/charts/spec'
import {
    factCheckTiles,
    sentimentByEngine,
    sentimentByPrompt,
    sentimentTiles,
    themesChart,
    toneOverTime,
    verdictsByEngine,
    verdictsByTopic,
    verdictsOverTime,
} from '../answerSpecs'
import { factCheckPayload, sentimentPayload } from '@/pages/analytics/__tests__/__fixtures__/measurementPayloads'

const offered = (spec, picked = null) => representationsFor(normalizeVizSpec(spec), { picked })
const tile = (tiles, key) => tiles.find((t) => t.key === key)

describe('sentimentTiles', () => {
    it('counts named answers, tones and themes, with the analyzed share', () => {
        const tiles = sentimentTiles(sentimentPayload())
        expect(tiles.map((t) => t.label)).toEqual([
            'Answers that name you',
            'Positive',
            'Negative',
            'Themes found',
            'Answers analyzed',
        ])
        expect(tile(tiles, 'named')).toMatchObject({ value: 52, kind: 'count' })
        expect(tile(tiles, 'positive')).toMatchObject({ value: 30, hint: 'of 52 answers that name you' })
        expect(tile(tiles, 'negative')).toMatchObject({ value: 4, hint: 'of 52 answers that name you' })
        expect(tile(tiles, 'themes').value).toBe(3)
        expect(tile(tiles, 'analyzed').value).toBe('40 of 52')
    })

    it('reads Not analyzed for themes before any analysis, and 0 for a measured zero', () => {
        const tiles = sentimentTiles(
            sentimentPayload({
                coverage: { named_answers: 52, analyzed: 0, not_analyzed: 52, failed: 0 },
                themes: [],
                tone: { positive: 0, neutral: 52, negative: 0, series: {} },
            }),
        )
        expect(tile(tiles, 'themes')).toMatchObject({ value: null, stateText: 'Not analyzed' })
        expect(tile(tiles, 'positive').value).toBe(0)
        expect(tile(tiles, 'analyzed').value).toBe('0 of 52')
    })
})

describe('toneOverTime', () => {
    it('stacks the stored tone per bucket with sentiment colours', () => {
        const spec = toneOverTime(sentimentPayload())
        expect(spec).toMatchObject({
            id: 'sentiment.tone',
            title: 'Tone of answers that name you',
            subtitle: 'From every answer that names you; no analysis needed.',
            x: 'time',
            time_unit: 'day',
            value: 'count',
            labels: ['2026-11-04', '2026-11-05'],
            stacked: true,
            type: 'stacked_bar',
        })
        expect(spec.datasets.map((d) => [d.key, d.label, d.entity, d.data])).toEqual([
            ['negative', 'Negative', 'sentiment:negative', [0, 1]],
            ['neutral', 'Neutral', 'sentiment:neutral', [1, 0]],
            ['positive', 'Positive', 'sentiment:positive', [2, 1]],
        ])
        expect(offered(spec)).toEqual(['line', 'area', 'bar', 'stacked_bar', 'heatmap', 'table'])
    })

    it('uses weeks for a weekly window', () => {
        const spec = toneOverTime(sentimentPayload({ window: { interval: 'week', buckets: ['2026-08-03'] } }))
        expect(spec.time_unit).toBe('week')
        expect(spec.datasets[0].data).toEqual([0])
    })
})

describe('themesChart', () => {
    it('draws the top themes of one tone as bars with its sentiment colour', () => {
        const spec = themesChart(sentimentPayload(), 'positive')
        expect(spec).toMatchObject({
            id: 'sentiment.themes_positive',
            title: 'Positive themes',
            subtitle: 'Answers that describe you this way.',
            labels: ['easy to set up|positive', 'flexible|positive'],
            label_names: { 'easy to set up|positive': 'easy to set up', 'flexible|positive': 'flexible' },
            type: 'hbar',
        })
        expect(spec.datasets).toEqual([
            { key: 'answers', label: 'Answers', value: 'count', entity: 'sentiment:positive', data: [9, 5] },
        ])
        expect(offered(spec)).toEqual(['hbar', 'table'])
        const negative = themesChart(sentimentPayload(), 'negative')
        expect(negative.title).toBe('Negative themes')
        expect(negative.datasets[0].entity).toBe('sentiment:negative')
    })

    it('keeps at most ten themes', () => {
        const themes = Array.from({ length: 12 }, (_, i) => ({ key: `t${i}|positive`, label: `t${i}`, tone: 'positive', answers: i }))
        const spec = themesChart(sentimentPayload({ themes }), 'positive')
        expect(spec.labels).toHaveLength(10)
        expect(spec.labels[0]).toBe('t11|positive')
    })

    it('has nothing to draw without themes of that tone', () => {
        expect(normalizeVizSpec(themesChart(sentimentPayload({ themes: [] }), 'negative'))).toBeNull()
    })
})

describe('sentimentByEngine and sentimentByPrompt', () => {
    it('stacks tone per engine and lists theme counts, Not analyzed when null', () => {
        const spec = sentimentByEngine(sentimentPayload())
        expect(spec).toMatchObject({ id: 'sentiment.by_engine', x: 'category', stacked: true, type: 'stacked_bar' })
        expect(spec.label_names).toEqual({ chatgpt: 'ChatGPT', claude: 'Claude' })
        expect(offered(spec)).toEqual(['bar', 'stacked_bar', 'heatmap', 'table'])
        const table = tableModel(spec)
        expect(table.columns.map((c) => c.label)).toEqual(['Negative', 'Neutral', 'Positive', 'Positive themes', 'Negative themes'])
        expect(table.rows[0].cells.map((c) => c.text)).toEqual(['2', '6', '12', '14', '3'])
        expect(table.rows[1].cells.slice(3).map((c) => c.text)).toEqual(['Not analyzed', 'Not analyzed'])
    })

    it('shows tone per prompt as a table named by prompt text, with the heatmap one switch away', () => {
        const spec = sentimentByPrompt(sentimentPayload())
        expect(spec).toMatchObject({
            id: 'sentiment.by_prompt',
            type: 'table',
            labels: ['p1', 'p2'],
            label_names: { p1: 'best note taking app for teams', p2: 'notion alternatives for small startups' },
        })
        expect(spec.datasets.map((d) => d.data)).toEqual([
            [1, 0],
            [2, 3],
            [5, 0],
        ])
        expect(offered(spec)).toContain('heatmap')
        expect(defaultRepresentation(normalizeVizSpec(spec))).toBe('table')
    })
})

describe('factCheckTiles', () => {
    it('counts checked claims and each verdict against them', () => {
        const tiles = factCheckTiles(factCheckPayload())
        expect(tiles.map((t) => t.label)).toEqual([
            'Claims checked',
            'Supported',
            'Contradicted',
            'Not verifiable',
            'Answers analyzed',
        ])
        expect(tile(tiles, 'checked').value).toBe(55)
        expect(tile(tiles, 'supported')).toMatchObject({ value: 30, hint: 'of 55 claims checked' })
        expect(tile(tiles, 'contradicted').value).toBe(4)
        expect(tile(tiles, 'not_verifiable').value).toBe(21)
        expect(tile(tiles, 'analyzed').value).toBe('40 of 52')
    })

    it('reads Not analyzed, never 0, when nothing was analyzed', () => {
        const tiles = factCheckTiles(
            factCheckPayload({
                coverage: { named_answers: 52, analyzed: 0, not_analyzed: 52, failed: 0 },
                totals: null,
                series: null,
                by_topic: null,
                by_engine: null,
            }),
        )
        for (const key of ['checked', 'supported', 'contradicted', 'not_verifiable']) {
            expect(tile(tiles, key)).toMatchObject({ value: null, stateText: 'Not analyzed' })
            expect(tile(tiles, key).hint || '').toBe('')
        }
        expect(tile(tiles, 'analyzed').value).toBe('0 of 52')
    })
})

describe('verdict charts', () => {
    it('draws claims over time with status colours named in the legend', () => {
        const spec = verdictsOverTime(factCheckPayload())
        expect(spec).toMatchObject({
            id: 'factcheck.verdicts',
            title: 'Claims over time',
            subtitle: 'Claims in analyzed answers, by what your evidence says.',
            x: 'time',
            stacked: true,
            type: 'stacked_bar',
        })
        expect(spec.datasets.map((d) => [d.key, d.label, d.entity, d.data])).toEqual([
            ['contradicted', 'Contradicted', 'status:critical', [0, 1]],
            ['not_verifiable', 'Not verifiable', 'muted', [2, 0]],
            ['supported', 'Supported', 'status:good', [3, 1]],
        ])
    })

    it('draws topics and engines with the same three verdicts', () => {
        const topics = verdictsByTopic(factCheckPayload())
        expect(topics).toMatchObject({ id: 'factcheck.topics', labels: ['pricing', 'company'], type: 'stacked_bar' })
        expect(topics.label_names).toEqual({ pricing: 'Pricing', company: 'Company' })
        expect(topics.datasets.map((d) => d.data)).toEqual([
            [3, 0],
            [4, 4],
            [5, 2],
        ])
        expect(offered(topics)).toEqual(['bar', 'stacked_bar', 'heatmap', 'table'])
        const engines = verdictsByEngine(factCheckPayload())
        expect(engines).toMatchObject({ id: 'factcheck.engines', labels: ['chatgpt', 'claude'] })
        expect(engines.label_names).toEqual({ chatgpt: 'ChatGPT', claude: 'Claude' })
    })

    it('has nothing to draw before any analysis', () => {
        const payload = factCheckPayload({ series: null, by_topic: null, by_engine: null })
        expect(normalizeVizSpec(verdictsOverTime(payload))).toBeNull()
        expect(normalizeVizSpec(verdictsByTopic(payload))).toBeNull()
        expect(normalizeVizSpec(verdictsByEngine(payload))).toBeNull()
    })
})
