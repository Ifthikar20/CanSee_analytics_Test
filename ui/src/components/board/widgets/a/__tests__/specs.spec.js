import { describe, expect, it } from 'vitest'
import { binsFor } from '@/lib/charts/scales'
import { normalizeVizSpec } from '@/lib/charts/spec'
import {
    aiCell,
    assistantBars,
    countriesCardSpec,
    countriesFoot,
    countriesState,
    countryBars,
    countryMeasures,
    crawlerBars,
    engineCount,
    failureState,
    googleCell,
    pathBars,
    promptRows,
    promptsNotes,
    summaryHeadline,
    summarySubline,
    summaryTiles,
    topCountriesLine,
    trafficCardEmpty,
    trafficCardSeries,
    trafficFoot,
    trafficLead,
    trafficSourceLine,
} from '../specs'
import {
    aiTrafficPayload,
    cloudflareTraffic,
    countryMatrix,
    emptyMatrix,
    emptyTraffic,
    overviewPayload,
    trafficPayload,
    visibilityPayload,
} from './__fixtures__/payloads'

describe('failureState', () => {
    it('names the widget, or says Insights are off', () => {
        expect(failureState('traffic', { status: 500 })).toEqual({
            kind: 'error',
            title: "We couldn't load Traffic.",
            body: '',
            action: { label: 'Try again' },
        })
        expect(failureState('ai-crawlers', null).title).toBe("We couldn't load AI crawlers.")
        expect(failureState('summary', { status: 503, code: 'insights_disabled' })).toMatchObject({
            kind: 'disabled',
            title: 'Insights are turned off on this server.',
            action: null,
        })
    })
})

describe('Summary', () => {
    it('keeps the Overview headline', () => {
        const { kpis } = overviewPayload()
        expect(summaryHeadline(kpis)).toBe('AI ranks you higher than Google on 1 prompt. Google ranks you higher on 0.')
        expect(summaryHeadline({ ...kpis, google_checked: 0 })).toBe('Tracking 3 prompts. Check Google to see the gap.')
        expect(summaryHeadline({ ...kpis, ai_ahead: 0, even: 1 })).toBe('Google and the AI engines agree on every checked prompt.')
    })

    it('never says they agree while a checked prompt is not definite', () => {
        const { kpis } = overviewPayload()
        // Both checked prompts missed Google's top 10, and the AI score sits
        // inside the range that leaves: no class, so no agreement either.
        const unsure = { ...kpis, ai_ahead: 0, strong_both: 0, not_definite: 2, no_data: 3 }
        expect(summaryHeadline(unsure)).toBe('Neither Google nor the AI engines rank you clearly higher on any checked prompt.')
        expect(summaryHeadline({ ...unsure, not_definite: 1, invisible_both: 1, no_data: 2 })).toBe(
            'Neither Google nor the AI engines rank you clearly higher on any checked prompt.',
        )
        expect(summaryHeadline({ ...unsure, not_definite: 0, invisible_both: 1, even: 1, no_data: 1 })).toBe(
            'Google and the AI engines agree on every checked prompt.',
        )
    })

    it('says the other classes, and nothing before a Google check', () => {
        const { kpis, prompts } = overviewPayload()
        expect(summarySubline(kpis, prompts)).toBe('1 strong in both, 0 invisible in both, out of 3 tracked prompts.')
        expect(summarySubline({ ...kpis, not_definite: 1 }, prompts)).toBe(
            '1 strong in both, 0 invisible in both, 1 not definite (Google was read to the top 10), out of 3 tracked prompts.',
        )
        expect(summarySubline({ ...kpis, google_checked: 0 }, prompts)).toBe('')
    })

    it('shows four tiles without colour, the gap counts "Not checked" before any Google check', () => {
        const { kpis, prompts } = overviewPayload()
        const tiles = summaryTiles(kpis, visibilityPayload().headline, prompts)
        expect(tiles.map((t) => [t.key, t.value])).toEqual([
            ['ai_visibility', 34],
            ['avg_google_position', 5.3],
            ['ai_ahead', 1],
            ['google_ahead', 0],
        ])
        expect(tiles[0].delta).toMatchObject({ value: 4.1, unit: 'pts', label: 'vs previous 30 days' })
        expect(tiles.some((t) => t.tone)).toBe(false)
        const unchecked = summaryTiles({ ...kpis, google_checked: 0, ai_ahead: 0, google_ahead: 0 })
        expect(unchecked.slice(2).map((t) => [t.value, t.stateText])).toEqual([
            [null, 'Not checked'],
            [null, 'Not checked'],
        ])
    })
})

describe('Prompts', () => {
    it('reads Google, the engines that answered and the gap in words', () => {
        expect(googleCell({ status: 'ok', position: 4 })).toBe('Google #4')
        expect(googleCell({ status: 'ok', position: null, depth: 10 })).toBe("Not in Google's top 10")
        expect(googleCell({ status: 'error' })).toBe('Google check failed')
        expect(googleCell({ status: 'not_checked' })).toBe('Google not checked')
        expect(googleCell(null)).toBe('Google not checked')
        expect(aiCell(overviewPayload().prompts[0].engines)).toBe('Named by 1 of 2 engines')
        expect(aiCell({ chatgpt: { answers: 1, mentioned: true } })).toBe('Named by 1 of 1 engine')
        expect(aiCell({ chatgpt: { answers: 0 } })).toBe('No AI answers yet')
    })

    it('keeps the API order and at most six rows', () => {
        const rows = promptRows(overviewPayload().prompts)
        expect(rows).toEqual([
            { id: 'p-1', text: 'best note taking app for teams', google: 'Google #4', ai: 'Named by 1 of 2 engines', gap: 'AI ahead' },
            { id: 'p-2', text: 'notion alternatives for startups', google: "Not in Google's top 10", ai: 'Named by 0 of 2 engines', gap: 'Not definite' },
            { id: 'p-3', text: 'team wiki software', google: 'Google not checked', ai: 'No AI answers yet', gap: 'Not checked' },
        ])
        const first = overviewPayload().prompts[0]
        const many = Array.from({ length: 9 }, (_, i) => ({ ...first, prompt_id: `x${i}` }))
        expect(promptRows(many).map((r) => r.id)).toEqual(['x0', 'x1', 'x2', 'x3', 'x4', 'x5'])
    })

    it('counts the configured engines, and turns the alerts into foot lines', () => {
        const overview = overviewPayload()
        expect(engineCount(overview.engines)).toBe(2)
        expect(engineCount([])).toBe(0)
        expect(engineCount(undefined)).toBeNull()
        expect(promptsNotes(overview)).toEqual([])
        expect(
            promptsNotes({ ...overview, serp_configured: false, engines: overview.engines.map((e) => ({ ...e, configured: false })) }),
        ).toEqual(["Google rank checks aren't available yet.", "AI engines aren't available yet."])
        expect(promptsNotes(null)).toEqual([])
    })
})

describe('Countries', () => {
    it('offers AI and Google with checks, and the traffic measure by its own name', () => {
        expect(countryMeasures(countryMatrix(), trafficPayload())).toEqual([
            { value: 'ai', label: 'AI' },
            { value: 'google', label: 'Google' },
            { value: 'traffic', label: 'Unique visitors' },
        ])
        expect(countryMeasures(emptyMatrix(), cloudflareTraffic())).toEqual([{ value: 'traffic', label: 'Requests' }])
        expect(countryMeasures(countryMatrix(), emptyTraffic('no_source'))).toHaveLength(2)
        expect(countryMeasures(null, null)).toEqual([])
    })

    it('maps one measure, traffic on decade bins', () => {
        const ai = normalizeVizSpec(countriesCardSpec('ai', countryMatrix(), null))
        expect(ai).toMatchObject({ id: 'board.countries.ai', title: 'AI visibility by country', x: 'country', palette: 'emphasis' })
        expect(ai.datasets.map((d) => d.key)).toEqual(['ai'])
        const google = normalizeVizSpec(countriesCardSpec('google', countryMatrix(), null))
        expect(google.title).toBe('Google position by country')
        expect(google.datasets[0].value).toBe('rank')
        const traffic = normalizeVizSpec(countriesCardSpec('traffic', null, cloudflareTraffic()))
        expect(traffic).toMatchObject({ id: 'board.countries.traffic', title: 'Requests by country', scale: 'log', footnote: '' })
        expect(binsFor(traffic, traffic.datasets[0]).map((b) => b.label)).toEqual([
            '1-9',
            '10-99',
            '100-999',
            '1,000-9,999',
            '10,000-30,000',
        ])
    })

    it('lists the top five: values for AI and traffic, words for Google', () => {
        // Your visibility and your traffic in each country: every bar is you, the accent.
        expect(countryBars('ai', countryMatrix(), null)).toEqual([
            { key: 'DE', label: 'Germany', value: 80, text: '80%', emphasis: true },
            { key: 'SG', label: 'Singapore', value: 60, text: '60%', emphasis: true },
            { key: 'GB', label: 'United Kingdom', value: 35, text: '35%', emphasis: true },
            { key: 'CA', label: 'Canada', value: 20, text: '20%', emphasis: true },
            // A measured zero is 0.
            { key: 'AU', label: 'Australia', value: 0, text: '0%', emphasis: true },
        ])
        expect(countryBars('google', countryMatrix(), null)).toEqual([
            { key: 'IN', label: 'India', value: null, text: '#2', emphasis: true },
            { key: 'GB', label: 'United Kingdom', value: null, text: '#5.3', emphasis: true },
            { key: 'SG', label: 'Singapore', value: null, text: '#8', emphasis: true },
            { key: 'DE', label: 'Germany', value: null, text: 'Not in top 10', emphasis: true },
            { key: 'AU', label: 'Australia', value: null, text: 'Failed', emphasis: true },
        ])
        expect(countryBars('traffic', null, trafficPayload()).every((b) => b.emphasis)).toBe(true)
        expect(countryBars('traffic', null, trafficPayload()).map((b) => [b.label, b.text])).toEqual([
            ['United States', '600'],
            ['Germany', '90'],
            ['India', '40'],
            ['United Kingdom', '30'],
        ])
    })

    it('names the source in the foot', () => {
        expect(countriesFoot('ai', null)).toBe('From your latest country checks.')
        expect(countriesFoot('traffic', trafficPayload())).toBe('Unique visitors from Cansee pixel, last 30 days.')
        expect(countriesFoot('traffic', cloudflareTraffic())).toBe('Requests from Cloudflare, last 30 days. Bots included.')
    })

    it('needs both sources before it says there is nothing', () => {
        expect(countriesState({ matrix: countryMatrix(), traffic: null })).toBe('ready')
        expect(countriesState({ matrix: null, traffic: cloudflareTraffic() })).toBe('ready')
        expect(countriesState({ matrix: emptyMatrix(), traffic: null })).toBe('loading')
        expect(countriesState({ matrix: emptyMatrix(), traffic: emptyTraffic('no_source') })).toBe('empty')
        expect(countriesState({ matrix: null, matrixFailed: true, traffic: emptyTraffic('no_source') })).toBe('error')
        expect(countriesState({ matrix: emptyMatrix(), traffic: null, trafficFailed: true })).toBe('error')
        expect(countriesState({ matrix: emptyMatrix(), traffic: emptyTraffic('source_error') })).toBe('error')
    })
})

describe('Traffic', () => {
    it('says where the numbers come from, Cloudflare with its bots', () => {
        expect(trafficSourceLine(cloudflareTraffic())).toBe('Cloudflare · last 30 days · requests, bots included')
        expect(trafficSourceLine(trafficPayload())).toBe('Cansee pixel · last 30 days')
        const lead = trafficLead(cloudflareTraffic())
        expect(lead).toMatchObject({ label: 'Requests', value: 48210, hint: 'Cloudflare · last 30 days · requests, bots included' })
        expect(lead.delta).toMatchObject({ value: -4.2, unit: 'pct', label: 'vs previous 30 days' })
    })

    it('draws the metric alone, one line in the accent', () => {
        const spec = normalizeVizSpec(trafficCardSeries(cloudflareTraffic()))
        expect(spec).toMatchObject({ id: 'board.traffic.series', title: 'Requests per day', pick_one: false, palette: 'emphasis', emphasis: 'visitors' })
        expect(spec.datasets.map((d) => [d.key, d.data])).toEqual([['visitors', [2600, 2800]]])
    })

    it('lists five paths, or null when the breakdown failed', () => {
        expect(pathBars(trafficPayload()).map((p) => [p.label, p.text])).toEqual([
            ['/pricing', '410'],
            ['/', '300'],
            ['/blog/how-to', '120'],
            ['/docs', '60'],
            ['/about', '12'],
        ])
        expect(pathBars(trafficPayload()).every((p) => p.emphasis)).toBe(true)
        expect(pathBars(cloudflareTraffic({ pages: null }))).toBeNull()
        expect(pathBars(trafficPayload({ pages: [] }))).toEqual([])
    })

    it('names the top three countries by share', () => {
        expect(topCountriesLine(trafficPayload())).toBe('Top countries: United States 62%, Germany 9.3%, India 4.1%')
        expect(topCountriesLine(trafficPayload({ countries: [] }))).toBe('')
    })

    it("tells Cloudflare's sampled paths and their window", () => {
        expect(trafficFoot(cloudflareTraffic())).toBe('Top paths are sampled.')
        expect(trafficFoot(cloudflareTraffic({ breakdown_hours: 24 }))).toBe('Top paths are sampled. They cover the last 24 hours.')
        expect(trafficFoot(cloudflareTraffic({ pages: null, breakdown_hours: 24 }))).toBe('')
        expect(trafficFoot(trafficPayload())).toBe('')
    })

    it('has its own words without a source, else the Traffic page words', () => {
        expect(trafficCardEmpty(emptyTraffic('no_source'))).toEqual({
            kind: 'not_connected',
            title: 'Connect a traffic source to see real traffic.',
            body: 'Cloudflare counts every request to your site, bots included. Google Analytics 4 and the Cansee pixel count visitors.',
            action: { label: 'Open Connections', to: { name: 'settings-connections' } },
        })
        expect(trafficCardEmpty(emptyTraffic('source_error', { source: 'cloudflare', source_label: 'Cloudflare' }))).toMatchObject({
            kind: 'error',
            title: "We couldn't reach Cloudflare just now.",
            action: { label: 'Try again' },
        })
        expect(trafficCardEmpty(trafficPayload())).toBeNull()
    })
})

describe('AI traffic and AI crawlers', () => {
    it('lists the top three assistants and crawlers, in gray: they are not you', () => {
        const { referrals, crawlers } = aiTrafficPayload()
        expect(assistantBars(referrals).some((b) => b.emphasis)).toBe(false)
        expect(crawlerBars(crawlers).some((b) => b.emphasis)).toBe(false)
        expect(assistantBars(referrals).map((b) => [b.label, b.text])).toEqual([
            ['ChatGPT', '30'],
            ['Perplexity', '8'],
            ['Claude', '3'],
        ])
        expect(crawlerBars(crawlers).map((b) => [b.label, b.text])).toEqual([
            ['GPTBot · OpenAI', '2,100'],
            ['ClaudeBot · Anthropic', '1,800'],
            ['PerplexityBot · Perplexity', '900'],
        ])
    })
})
