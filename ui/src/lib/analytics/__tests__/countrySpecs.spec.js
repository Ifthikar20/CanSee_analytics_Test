import { describe, expect, it } from 'vitest'
import { defaultRepresentation, normalizeVizSpec, representationsFor } from '@/lib/charts/spec'
import {
    aiOverviewText,
    cellText,
    costLine,
    countriesMap,
    durationText,
    engineSummary,
    gapBadges,
    googleSummary,
    localizationRows,
    matrixEngines,
    money,
    progressSummary,
    promptCountryRows,
    promptsByCountry,
    runTitle,
    visitorSuggestions,
} from '../countrySpecs'
import {
    countryMatrix,
    countryOptions,
    countryRun,
    finishedRun,
} from '@/pages/analytics/__tests__/__fixtures__/analyticsPayloads'

const offered = (spec, picked = null) => representationsFor(normalizeVizSpec(spec), { picked })
const google = (overrides) => ({ engine: 'google', ...overrides })
const engine = (overrides) => ({ engine: 'chatgpt', ...overrides })

describe('cellText', () => {
    it('reads every state in words', () => {
        expect(cellText(google({ state: 'ok', position: 4, depth: 10 }))).toBe('#4')
        expect(cellText(engine({ state: 'ok', rank: 2 }))).toBe('Named #2')
        expect(cellText(engine({ state: 'ok', rank: null }))).toBe('Named')
        expect(cellText(engine({ state: 'not_found' }))).toBe('Not named')
        expect(cellText(google({ state: 'not_found', depth: 10 }))).toBe('Not in top 10')
        expect(cellText(google({ state: 'not_found', depth: null }), { depth: 20 })).toBe('Not in top 20')
        expect(cellText(google({ state: 'failed' }))).toBe('Failed')
        expect(cellText(engine({ state: 'skipped' }))).toBe('Skipped')
        expect(cellText(engine({ state: 'cancelled' }))).toBe('Stopped')
        expect(cellText(engine({ state: 'queued' }))).toBe('Waiting')
        expect(cellText(engine({ state: 'running' }))).toBe('Checking')
        expect(cellText(engine({ state: 'not_checked' }))).toBe('Not checked')
        expect(cellText(null)).toBe('Not checked')
    })
})

describe('promptCountryRows', () => {
    it('lists the countries a prompt was checked in, with its cells and gap', () => {
        const rows = promptCountryRows(countryMatrix(), 'p1')
        expect(rows.map((r) => [r.country, r.name])).toEqual([
            ['de', 'Germany'],
            ['gb', 'United Kingdom'],
        ])
        const gb = rows[1]
        expect(gb.google.id).toBe('c1')
        expect(gb.engines).toEqual({ chatgpt: expect.objectContaining({ id: 'c2' }), claude: null })
        expect(gb.gap).toMatchObject({ class: 'ai_ahead', definite: true })
        expect(rows[0].engines.chatgpt.state).toBe('failed')
    })

    it('is empty for a prompt never checked abroad', () => {
        expect(promptCountryRows(countryMatrix(), 'p2')).toEqual([])
        expect(promptCountryRows(null, 'p1')).toEqual([])
    })
})

describe('matrixEngines', () => {
    it('shows configured engines (and any with results), or the filtered one', () => {
        expect(matrixEngines(countryMatrix()).map((e) => e.key)).toEqual(['chatgpt', 'claude'])
        expect(matrixEngines(countryMatrix(), { engine: 'google' })).toEqual([])
        expect(matrixEngines(countryMatrix(), { engine: 'claude' }).map((e) => e.key)).toEqual(['claude'])
    })
})

describe('countriesMap', () => {
    it('draws AI visibility or Google position per country, one at a time', () => {
        const spec = countriesMap(countryMatrix())
        expect(spec).toMatchObject({ id: 'countries.map', x: 'country', pick_one: true, type: 'map' })
        expect(spec.labels).toEqual(['de', 'gb'])
        expect(spec.label_names).toEqual({ de: 'Germany', gb: 'United Kingdom' })
        const [ai, pos] = spec.datasets
        expect(ai).toMatchObject({ key: 'ai', label: 'AI visibility', value: 'percent', data: [null, 100] })
        expect(ai.states).toEqual(['not_checked', null])
        // Germany was searched and you were not in the top 10: a state, not a position.
        expect(pos).toMatchObject({ key: 'google', value: 'rank', data: [null, 4], states: ['not_found', null] })
        expect(spec.state_labels).toEqual({ not_found: 'Not in top 10' })
        expect(spec.footnote).toBe(
            'Google: Google set to each country, US connection where shown. Engines: see How each result was localized below.',
        )
        expect(offered(spec, 'ai')).toEqual(['map', 'hbar', 'table'])
        expect(offered(spec, 'google')).toEqual(['map', 'table'])
    })

    it('follows the engine filter', () => {
        const google = countriesMap(countryMatrix(), { engine: 'google' })
        expect(google.datasets.map((d) => d.key)).toEqual(['google'])
        expect(google.footnote).toBe('Google: Google set to each country, US connection where shown.')

        const chatgpt = countriesMap(countryMatrix(), { engine: 'chatgpt' })
        expect(chatgpt.datasets.map((d) => d.key)).toEqual(['ai'])
        expect(chatgpt.datasets[0]).toMatchObject({ label: 'ChatGPT visibility', data: [null, 100], states: ['failed', null] })
    })
})

describe('promptsByCountry', () => {
    it('shows the AI score of each prompt and country for all engines', () => {
        const spec = promptsByCountry(countryMatrix())
        // Only prompts and countries that were checked.
        expect(spec.labels).toEqual(['p1'])
        expect(spec.datasets.map((d) => d.key)).toEqual(['de', 'gb'])
        expect(spec.value).toBe('number')
        expect(spec.max).toBe(100)
        expect(spec.datasets[0]).toMatchObject({ data: [null], states: ['not_checked'] })
        expect(spec.datasets[1]).toMatchObject({ data: [85], states: [null] })
        expect(offered(spec)).toEqual(['heatmap', 'table'])
        // Calm by default: the table first, the heatmap one click away.
        expect(defaultRepresentation(spec)).toBe('table')
    })

    it('shows positions for Google and ranks for an engine', () => {
        const g = promptsByCountry(countryMatrix(), { engine: 'google' })
        expect(g.value).toBe('rank')
        expect(g.datasets[0]).toMatchObject({ data: [null], states: ['not_found'] })
        expect(g.datasets[1]).toMatchObject({ data: [4], states: [null] })
        expect(g.state_labels).toEqual({ not_found: 'Not in top 10' })

        const e = promptsByCountry(countryMatrix(), { engine: 'chatgpt' })
        expect(e.datasets[0]).toMatchObject({ data: [null], states: ['failed'] })
        expect(e.datasets[1]).toMatchObject({ data: [2], states: [null] })
        expect(e.state_labels).toEqual({ not_found: 'Not named' })
        // A one-country matrix keeps the heatmap.
        expect(offered(e)).toEqual(['heatmap', 'table'])

        const c = promptsByCountry(countryMatrix(), { engine: 'claude' })
        expect(c.datasets.every((d) => d.states[0] === 'not_checked')).toBe(true)
    })
})

describe('table words', () => {
    it('summarises Google per country', () => {
        const [de, gb] = countryMatrix().countries
        expect(googleSummary(gb.google)).toEqual({ text: '#4 avg', sub: '1 of 1 found', measured: true })
        expect(googleSummary(de.google)).toEqual({ text: 'Not in top 10', sub: '0 of 1 found', measured: true })
        expect(googleSummary({ ...gb.google, avg_position: 5.33 }).text).toBe('#5.3 avg')
        expect(googleSummary({ state: 'failed' }).text).toBe('Failed')
        expect(googleSummary({ state: 'not_configured' }).text).toBe('Not configured')
        expect(googleSummary(null).text).toBe('Not checked')
    })

    it('summarises an engine per country', () => {
        const [de, gb] = countryMatrix().countries
        expect(engineSummary(gb.engines.chatgpt)).toEqual({ text: '100%', sub: '1 of 1 named', measured: true })
        expect(engineSummary({ state: 'ok', visibility_pct: 4.5, mentioned: 1, answered: 22 }).text).toBe('4.5%')
        expect(engineSummary({ state: 'ok', visibility_pct: 0, mentioned: 0, answered: 3 }).text).toBe('0%')
        expect(engineSummary(de.engines.chatgpt).text).toBe('Failed')
        expect(engineSummary(de.engines.claude).text).toBe('Not checked')
        expect(engineSummary({ state: 'not_configured' }).text).toBe('Not configured')
    })

    it('lists gap badges without zero counts', () => {
        expect(gapBadges({ ai_ahead: 1, google_ahead: 2, no_data: 1, strong_both: 3 })).toEqual([
            { cls: 'ai_ahead', count: 1, text: '1 AI ahead' },
            { cls: 'google_ahead', count: 2, text: '2 Google ahead' },
            { cls: 'no_data', count: 1, text: '1 not definite' },
        ])
        expect(gapBadges({ ai_ahead: 0, google_ahead: 0, no_data: 0 })).toEqual([])
        expect(gapBadges(null)).toEqual([])
    })
})

describe('localizationRows', () => {
    it('lists Google per method and every configured engine with its note', () => {
        const rows = localizationRows(countryOptions())
        expect(rows.map((r) => [r.name, r.label])).toEqual([
            ['Google (ScraperAPI)', 'Searched from US'],
            ['Google (ScraperAPI)', 'Google set to DE / FR / GB, US connection'],
            ['ChatGPT', 'Asked to answer for each country'],
            ['Claude', 'Asked to answer for each country'],
        ])
        expect(rows[0].note).toBe('Cansee searched Google through a connection in this country.')
        expect(rows[2].note).toBe('This engine has no location setting here, so it was asked to answer for this country.')
        expect(localizationRows(countryOptions({ google: { configured: false } })).map((r) => r.name)).toEqual([
            'ChatGPT',
            'Claude',
        ])
    })

    it('describes only the checked countries once there are results, naming a few', () => {
        const options = countryOptions({
            countries: [
                { country: 'gb', name: 'United Kingdom', google_method: 'proxy', google_method_label: 'Searched from GB' },
                { country: 'de', name: 'Germany', google_method: 'proxy', google_method_label: 'Searched from DE' },
                { country: 'kz', name: 'Kazakhstan', google_method: 'google_setting', google_method_label: 'Google set to KZ, US connection' },
            ],
        })
        const google = (rows) => rows.filter((r) => r.key.startsWith('google:')).map((r) => r.label)
        expect(google(localizationRows(options, { countries: ['gb', 'de'] }))).toEqual(['Searched from DE / GB'])
        expect(google(localizationRows(options))).toEqual(['Searched from DE / GB', 'Google set to KZ, US connection'])
    })
})

describe('visitorSuggestions', () => {
    it('suggests the top visitor countries that can be checked and are not chosen', () => {
        const traffic = [{ code: 'US' }, { code: 'UK' }, { code: 'JP' }, { code: 'DE' }, { code: 'FR' }]
        expect(visitorSuggestions(traffic, countryOptions(), ['us'])).toEqual([
            { country: 'gb', name: 'United Kingdom' },
            { country: 'de', name: 'Germany' },
            { country: 'fr', name: 'France' },
        ])
        expect(visitorSuggestions([], countryOptions())).toEqual([])
    })
})

describe('run words', () => {
    it('titles a run by its status', () => {
        expect(runTitle(countryRun())).toBe('Checking 2 countries')
        expect(runTitle(finishedRun())).toBe('Checked 2 countries in 1 min 12 s')
        expect(runTitle(finishedRun({ status: 'partial', duration_ms: 45000 }))).toBe('Checked 2 countries in 45 s')
        expect(runTitle(countryRun({ status: 'failed' }))).toBe('The check could not finish')
        expect(
            runTitle(countryRun({ status: 'cancelled', progress: { total: 12, done: 3, failed: 1, skipped: 0, cancelled: 8 } })),
        ).toBe('Stopped after 4 of 12 checks')
        expect(
            runTitle(countryRun({ status: 'interrupted', progress: { total: 12, done: 3, failed: 9, skipped: 0, cancelled: 0 } })),
        ).toBe('Interrupted after 3 of 12 checks')
    })

    it('counts interrupted results apart from real failures when the results are known', () => {
        const results = [
            { status: 'done' },
            { status: 'failed', error: { code: 'timeout' } },
            { status: 'failed', error: { code: 'interrupted' } },
            { status: 'failed', error: { code: 'interrupted' } },
        ]
        expect(runTitle(countryRun({ status: 'interrupted', results, progress: { total: 4 } }))).toBe(
            'Interrupted after 2 of 4 checks',
        )
    })

    it('summarises progress, leaving out zero counts except done', () => {
        expect(progressSummary({ done: 12, failed: 0, skipped: 0, cancelled: 0 })).toBe('12 done')
        expect(progressSummary({ done: 0, failed: 1, skipped: 2, cancelled: 3 })).toBe(
            '0 done · 1 failed · 2 skipped · 3 stopped',
        )
    })

    it('says what a run used, per provider', () => {
        expect(costLine(finishedRun())).toBe(
            'Used 4 Google pages (about 100 ScraperAPI credits) and $0.09 of AI allowance.',
        )
        expect(
            costLine(finishedRun({ provider: 'serpapi', cost: { google_pages_fetched: 1, scraperapi_credits: null, google_usd: '0.0150', ai_usd: '0.0060' } })),
        ).toBe('Used 1 Google page ($0.02) and $0.0060 of AI allowance.')
        expect(costLine(finishedRun({ include_google: false }))).toBe('Used $0.09 of AI allowance.')
        expect(
            costLine(finishedRun({ engines: [], confirmed: { google_pages: 4, engine_answers: 0, ai_usd_max: '0.0000' } })),
        ).toBe('Used 4 Google pages (about 100 ScraperAPI credits).')
    })

    it('formats money and durations', () => {
        expect(money('0.4000')).toBe('$0.40')
        expect(money('0.0060')).toBe('$0.0060')
        expect(money('0')).toBe('$0.00')
        expect(money(null)).toBe('$0.00')
        expect(durationText(4000)).toBe('4 s')
        expect(durationText(120000)).toBe('2 min')
        expect(durationText(3_780_000)).toBe('1 h 3 min')
        expect(durationText(null)).toBe('')
    })
})

describe('aiOverviewText', () => {
    it('says what is known about the AI Overview, and nothing that is not', () => {
        expect(aiOverviewText({ shown: false })).toBe('Google showed no AI Overview for this search.')
        expect(aiOverviewText({ shown: true, content_captured: false, mentions_you: null, cites_you: null })).toBe(
            'Google showed an AI Overview, but its content was not captured.',
        )
        expect(aiOverviewText({ shown: true, content_captured: true, mentions_you: true, cites_you: false })).toBe(
            'Google showed an AI Overview. It names you and does not cite your site.',
        )
        expect(aiOverviewText({ shown: true, content_captured: true, mentions_you: true, cites_you: null })).toBe(
            'Google showed an AI Overview. It names you.',
        )
        expect(aiOverviewText({})).toBe('')
    })
})
