import { describe, expect, it } from 'vitest'
import { normalizeVizSpec, representationsFor, tableModel } from '@/lib/charts/spec'
import {
    evidenceText,
    fanoutEngines,
    fanoutGoogleText,
    fanoutGoogleWord,
    fanoutTiles,
    fanoutsEmpty,
    ideaSourceLabel,
    ideaTiles,
    ideasBySource,
    reportingEngines,
    seenText,
    unreportedSearches,
} from '../researchSpecs'
import { fanOutsPayload, promptIdeasPayload } from '@/pages/analytics/__tests__/__fixtures__/measurementPayloads'

const offered = (spec, picked = null) => representationsFor(normalizeVizSpec(spec), { picked })

describe('ideaTiles', () => {
    it('reads every tile from counts; a source never read shows its state word', () => {
        const tiles = ideaTiles(promptIdeasPayload())
        expect(tiles.map((t) => [t.label, t.value, t.value === null ? t.stateText : null])).toEqual([
            ['New ideas', 20, null],
            ['From People also ask', 9, null],
            // Google showed no related searches: a measured zero.
            ['From related searches', 0, null],
            ['From engine searches', null, 'No web search'],
            ['AI suggestions', null, 'Not run'],
            ['Tracked', 3, null],
        ])
    })

    it('shows the count whenever ideas exist, whatever the state', () => {
        const payload = promptIdeasPayload()
        payload.sources.paa.state = 'no_checks'
        payload.counts.by_source.paa = 2
        expect(ideaTiles(payload)[1].value).toBe(2)
        payload.counts.by_source.paa = 0
        expect(ideaTiles(payload)[1]).toMatchObject({ value: null, stateText: 'No checks yet' })
    })
})

describe('ideasBySource', () => {
    it('draws ideas per source as bars, unread sources as their word', () => {
        const spec = ideasBySource(promptIdeasPayload())
        expect(spec).toMatchObject({ id: 'prompts.sources', title: 'Ideas by source', type: 'hbar' })
        expect(spec.stacked).toBeUndefined()
        expect(spec.label_names).toEqual({
            paa: 'People also ask',
            related_search: 'Related search',
            fanout: 'Engine search',
            ai_suggestion: 'AI suggestion',
            sub_query: 'Predicted sub-query',
        })
        expect(spec.datasets[0].data).toEqual([9, 0, null, null, 4])
        expect(spec.datasets[0].states).toEqual([null, null, 'not_measured', 'not_measured', null])
        expect(tableModel(spec).rows.map((r) => r.cells[0].text)).toEqual(['9', '0', 'No web search', 'Not run', '4'])
        expect(offered(spec)).toEqual(['hbar', 'table'])
    })
})

describe('idea words', () => {
    it('names sources, how often ideas were seen and their evidence', () => {
        expect(ideaSourceLabel('related_search')).toBe('Related search')
        expect(seenText({ prompts: 2, engines: 1, times: 3 })).toBe('2 prompts · 1 engine')
        expect(seenText({ prompts: 1, engines: 0 })).toBe('1 prompt')
        expect(evidenceText({ source: 'paa', prompt_text: 'best note app' })).toBe('People also ask on "best note app"')
        expect(evidenceText({ source: 'related_search', prompt_text: 'x' })).toBe('Related search on "x"')
        expect(evidenceText({ source: 'fanout', engine: 'chatgpt', prompt_text: 'x' })).toBe(
            'ChatGPT searched it while answering "x"',
        )
        expect(evidenceText({ source: 'ai_suggestion', why: 'Your audience is small teams.' })).toBe(
            'AI suggestion: Your audience is small teams.',
        )
        expect(evidenceText({ source: 'sub_query', prompt_text: 'x' })).toBe('Predicted sub-query of "x"')
    })
})

describe('fan-outs', () => {
    it('builds the four tiles from the totals', () => {
        expect(fanoutTiles(fanOutsPayload()).map((t) => [t.label, t.value])).toEqual([
            ['Answers that searched', '22 of 30'],
            ['Searches run', 61],
            ['Search texts reported', 58],
            ['Unique searches', 45],
        ])
    })

    it('draws searches for the engines that report them, one measure at a time', () => {
        const spec = fanoutEngines(fanOutsPayload())
        expect(reportingEngines(fanOutsPayload())).toEqual(['chatgpt', 'claude'])
        expect(spec).toMatchObject({
            id: 'fanouts.engines',
            title: 'Searches by engine',
            labels: ['chatgpt', 'claude'],
            pick_one: true,
            type: 'bar',
            footnote: "Gemini, Grok and Perplexity don't report their searches, so they are not shown.",
        })
        expect(spec.datasets.map((d) => [d.label, d.value, d.data])).toEqual([
            ['Answers that searched', 'count', [14, 8]],
            ['Searches', 'count', [30, 31]],
            ['Average searches per answer', 'number', [1.5, 3.1]],
        ])
        expect(offered(spec)).toEqual(['bar', 'table'])
    })

    it('reads Not recorded for an engine without recorded answers', () => {
        const payload = fanOutsPayload()
        payload.by_engine = [{ key: 'chatgpt', answers: 4, recorded: 0, searched: 0, searches: 0, queries: 0 }]
        const spec = fanoutEngines(payload)
        expect(spec.datasets[0].states).toEqual(['not_measured', 'not_measured'])
        expect(tableModel(spec).rows[0].cells[0].text).toBe('Not recorded')
    })

    it('says where each search stands on Google', () => {
        const when = () => '2h ago'
        expect(fanoutGoogleText({ state: 'found', position: 4, checked_at: 'x' }, when)).toEqual({
            text: '#4',
            sub: 'Checked 2h ago',
            measured: true,
        })
        expect(fanoutGoogleText({ state: 'not_found', checked_at: 'x' }, when).text).toBe('Not on page one')
        expect(fanoutGoogleText({ state: 'failed' }).text).toBe('Failed')
        expect(fanoutGoogleText({ state: 'not_checked' }).text).toBe('Not checked')
        expect(fanoutGoogleText(null).text).toBe('Not checked')
        expect(fanoutGoogleWord({ state: 'found', position: 4 })).toBe('#4')
        expect(fanoutGoogleWord({ state: 'not_found' })).toBe('not on page one')
        expect(fanoutGoogleWord({ state: 'not_checked' })).toBeNull()
    })

    it('counts searches that sent no text', () => {
        expect(unreportedSearches({ searches: 61, queries: 58 })).toBe(3)
        expect(unreportedSearches({ searches: 4, queries: 6 })).toBe(0)
        expect(unreportedSearches(null)).toBe(0)
    })

    it('sends the empty states to Prompts on the board, by project when one is given', () => {
        const toBoard = { name: 'analytics', params: { websiteId: 'w1' }, query: { widget: 'prompts' } }
        expect(fanoutsEmpty(fanOutsPayload({ empty_reason: 'none_recorded' }), { websiteId: 'w1' })).toEqual({
            kind: 'empty',
            title: 'No searches recorded yet.',
            body: 'Searches are recorded from answers collected after web search was turned on. Check a prompt now to record some.',
            action: { label: 'Open prompts', to: toBoard },
        })
        expect(fanoutsEmpty(fanOutsPayload({ empty_reason: 'no_answers' }), { days: 7, websiteId: 'w1' })).toEqual({
            kind: 'empty',
            title: 'No AI answers in the last 7 days.',
            action: { label: 'Open prompts', to: toBoard },
        })
        // Without a project, /dashboard picks one and keeps the widget.
        expect(fanoutsEmpty(fanOutsPayload({ empty_reason: 'no_answers' })).action.to).toEqual({
            name: 'dashboard',
            query: { widget: 'prompts' },
        })
        expect(fanoutsEmpty(fanOutsPayload({ empty_reason: 'web_search_off' })).action).toBeUndefined()
        expect(fanoutsEmpty(fanOutsPayload())).toBeNull()
    })
})
