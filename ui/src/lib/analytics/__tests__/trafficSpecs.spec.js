import { describe, expect, it } from 'vitest'
import { normalizeVizSpec, representationsFor } from '@/lib/charts/spec'
import {
    aiCountries,
    aiVisitsSeries,
    byAssistant,
    countriesMap,
    crawlerBots,
    crawlerFootnotes,
    crawlerRows,
    crawlerSeries,
    crawlerSourceLine,
    crawlersEmpty,
    crawlerTiles,
    devicesSpec,
    landingPages,
    pagesSpec,
    purposesSpec,
    referralTiles,
    referralsEmpty,
    referrersSpec,
    trafficEmpty,
    trafficSeries,
    trafficTiles,
} from '../trafficSpecs'
import {
    aiTrafficPayload,
    cloudflareTraffic,
    emptyTraffic,
    trafficCountries,
    trafficPayload,
} from '@/pages/analytics/__tests__/__fixtures__/analyticsPayloads'

const offered = (spec, picked = null) => representationsFor(normalizeVizSpec(spec), { picked })

describe('website traffic', () => {
    it('maps visitors by country, with the unknown count as a footnote', () => {
        const spec = countriesMap(trafficCountries())
        expect(spec).toMatchObject({ id: 'traffic.countries', x: 'country', value: 'count', type: 'map' })
        expect(spec.title).toBe('Visitors by country')
        expect(spec.labels).toEqual(['US', 'GB', 'DE'])
        expect(spec.datasets[0]).toMatchObject({ label: 'Unique visitors', data: [30, 8, 3] })
        expect(spec.footnote).toBe('3 without a known country.')
        expect(offered(spec)).toEqual(['map', 'hbar', 'table'])
        // One country dominates: decade bins, and no visit is "None recorded".
        expect(spec).toMatchObject({ scale: 'log', missing_label: 'None recorded' })
        expect(normalizeVizSpec(spec).scale).toBe('log')

        const own = countriesMap(trafficCountries({ countries_unknown: null }), {
            id: 'countries.visitors',
            subtitle: 'Cansee pixel · last 30 days',
            footnote: 'A note.',
        })
        expect(own).toMatchObject({ id: 'countries.visitors', subtitle: 'Cansee pixel · last 30 days', footnote: 'A note.' })
        expect(countriesMap(trafficCountries({ countries_unknown: 0 })).footnote).toBeUndefined()
    })

    it('calls Cloudflare requests requests, never visitors', () => {
        const spec = countriesMap(cloudflareTraffic())
        expect(spec.title).toBe('Requests by country')
        expect(spec.datasets[0].label).toBe('Requests')
        expect(countriesMap(cloudflareTraffic({ metric_label: null })).datasets[0].label).toBe('Requests')
        expect(countriesMap(cloudflareTraffic(), { title: 'Own title' }).title).toBe('Own title')
    })

    it('draws one measure at a time, with days before the pixel started as not measured', () => {
        const spec = trafficSeries(trafficPayload())
        expect(spec.pick_one).toBe(true)
        expect(spec.datasets.map((d) => d.label)).toEqual(['Unique visitors', 'Page views', 'Sessions'])
        expect(spec.datasets[0].data).toEqual([null, 41])
        expect(spec.datasets[0].states).toEqual(['not_measured', null])
        expect(spec.footnote).toBe('The Cansee pixel started recording on 2026-10-07; earlier days are not measured.')
        expect(offered(spec)).toEqual(['line', 'area', 'bar', 'table'])
    })

    it('drops what Cloudflare cannot measure instead of drawing zeros', () => {
        const spec = trafficSeries(cloudflareTraffic())
        expect(spec.datasets[0].states).toEqual([null, null])
        // Sessions are all null without states: the chart leaves them out.
        expect(normalizeVizSpec(spec).datasets.map((d) => d.key)).toEqual(['visitors', 'pageviews'])
        expect(spec.footnote).toBeUndefined()
        expect(pagesSpec(cloudflareTraffic()).datasets[0].label).toBe('Requests')
    })

    it('builds the three tiles with "Not measured by" for nulls', () => {
        const tiles = trafficTiles(cloudflareTraffic(), { period: '7d' })
        expect(tiles.map((t) => [t.label, t.value])).toEqual([
            ['Requests', 5400],
            ['Page views', 3010],
            ['Sessions', null],
        ])
        expect(tiles[0].delta).toEqual({ value: 12.7, unit: 'pct', label: 'vs previous 7 days', goodWhen: 'up' })
        expect(tiles[1].delta.value).toBe(-4.2)
        expect(tiles[2].stateText).toBe('Not measured by Cloudflare')
        expect(tiles[2].delta).toBeNull()
        // An unknown change is no delta, never 0%.
        expect(trafficTiles(trafficPayload())[0].delta).toBeNull()
    })

    it('labels referrers, pages and devices', () => {
        const referrers = referrersSpec(trafficPayload())
        expect(Object.values(referrers.label_names)).toEqual(['google · organic', 'chatgpt.com · referral (AI)'])
        expect(offered(referrers)).toEqual(['hbar', 'table'])
        expect(pagesSpec(trafficPayload()).labels).toEqual(['/pricing', '/'])
        const devices = devicesSpec(trafficPayload())
        expect(offered(devices)).toEqual(['bar', 'doughnut', 'table'])
    })

    it('gives every empty reason its copy', () => {
        expect(trafficEmpty(trafficPayload())).toBeNull()
        expect(trafficEmpty(emptyTraffic('no_source'))).toMatchObject({
            kind: 'not_connected',
            title: 'No traffic source is connected.',
            body: 'Connect the Cansee pixel, Google Analytics 4 or Cloudflare to see who visits your site and from where.',
            action: { label: 'Connect a source', to: { name: 'settings-connections' } },
        })
        expect(trafficEmpty(emptyTraffic('not_connected', { source: 'ga4', source_label: 'Google Analytics 4' }))).toMatchObject({
            title: "Google Analytics 4 isn't connected.",
            body: 'Connect it in Settings, or choose another source above.',
            action: { label: 'Open Connections' },
        })
        expect(trafficEmpty(emptyTraffic('no_data'))).toMatchObject({
            title: "The Cansee pixel hasn't recorded a visit yet.",
            body: 'Check that the snippet is on every page. Visits appear within a minute.',
            action: { label: 'Open Connections' },
        })
        expect(trafficEmpty(emptyTraffic('no_data', { source: 'cloudflare', source_label: 'Cloudflare' }))).toMatchObject({
            title: 'Cloudflare has no data for this period.',
            action: null,
        })
        expect(trafficEmpty(emptyTraffic('source_error', { source: 'ga4', source_label: 'Google Analytics 4' }))).toEqual({
            kind: 'error',
            title: "We couldn't reach Google Analytics 4 just now.",
            body: 'Try again in a minute.',
            action: { label: 'Try again' },
        })
    })
})

describe('AI visits', () => {
    it('stacks visits by assistant and keeps their colors', () => {
        const { referrals } = aiTrafficPayload()
        const spec = aiVisitsSeries(referrals)
        expect(spec.datasets.map((d) => [d.key, d.entity])).toEqual([
            ['chatgpt', 'assistant:chatgpt'],
            ['perplexity', 'assistant:perplexity'],
        ])
        expect(spec.datasets[0].data).toEqual([null, 3])
        expect(spec.datasets[0].states).toEqual(['not_measured', null])
        expect(offered(spec)).toEqual(['stacked_bar', 'line', 'area', 'table'])
    })

    it('folds assistants without a color of their own into Other', () => {
        const { referrals } = aiTrafficPayload({
            referrals: {
                assistants: [
                    { key: 'chatgpt', label: 'ChatGPT', sessions: 3 },
                    { key: 'poe', label: 'Poe', sessions: 2 },
                    { key: 'you', label: 'You.com', sessions: 1 },
                ],
                series: { labels: ['2026-10-07'], by_assistant: { chatgpt: [3], poe: [2], you: [1] } },
            },
        })
        expect(aiVisitsSeries(referrals).datasets.map((d) => [d.label, d.data])).toEqual([
            ['ChatGPT', [3]],
            ['Other assistants', [3]],
        ])
        const total = byAssistant(referrals)
        expect(total.labels).toEqual(['chatgpt', 'other'])
        expect(total.label_entities).toEqual({ chatgpt: 'assistant:chatgpt', other: 'other' })
        expect(total.datasets[0].data).toEqual([3, 3])
    })

    it('offers bars, a donut and the table by assistant; a map by country', () => {
        const { referrals } = aiTrafficPayload()
        expect(offered(byAssistant(referrals))).toEqual(['hbar', 'doughnut', 'table'])
        expect(offered(aiCountries(referrals))).toEqual(['map', 'hbar', 'table'])
        expect(aiCountries(referrals)).toMatchObject({ scale: 'log', missing_label: 'None recorded' })
    })

    it('lists landing pages per assistant, drawing one at a time', () => {
        const { referrals } = aiTrafficPayload()
        const spec = landingPages(referrals)
        expect(spec.datasets.map((d) => [d.label, d.data])).toEqual([
            ['All assistants', [3]],
            ['ChatGPT', [2]],
            ['Perplexity', [1]],
        ])
        expect(offered(spec)).toEqual(['hbar', 'table'])
    })

    it('builds tiles, with a measured zero shown as 0', () => {
        const { referrals } = aiTrafficPayload()
        expect(referralTiles(referrals).map((t) => t.value)).toEqual([4, 7.8, 'ChatGPT'])
        const zero = aiTrafficPayload({ referrals: { ai_sessions: 0, ai_share_pct: 0, assistants: [] } }).referrals
        expect(referralTiles(zero).map((t) => [t.value, t.stateText])).toEqual([
            [0, 'Not measured'],
            [0, 'No sessions'],
            [null, 'None yet'],
        ])
        const noSessions = aiTrafficPayload({ referrals: { total_sessions: 0, ai_sessions: 0, ai_share_pct: null } }).referrals
        expect(referralTiles(noSessions)[1].value).toBeNull()
    })

    it('gives every unavailable reason its copy', () => {
        const r = (referrals) => referralsEmpty(aiTrafficPayload({ referrals }).referrals)
        expect(r({})).toBeNull()
        const noSource = r({ available: false, reason: 'no_source' })
        expect(noSource).toMatchObject({
            title: 'No traffic source can show AI visits yet.',
            body: 'AI visits are counted by the Cansee pixel or Google Analytics 4. Connect one of them.',
            action: { label: 'Connect a source' },
        })
        expect(r({ available: false, reason: 'not_connected' }).title).toBe(noSource.title)
        expect(r({ available: false, reason: 'no_data' }).title).toBe('No visits recorded in this period.')
        expect(r({ available: false, reason: 'source_error', source_label: 'Google Analytics 4' })).toMatchObject({
            title: "We couldn't reach Google Analytics 4 just now.",
            action: { label: 'Try again' },
        })
        expect(r({ ai_sessions: 0 })).toMatchObject({
            title: 'No visits from AI assistants in this period.',
            body: 'A visit counts as AI-referred when it arrives from ChatGPT, Claude, Gemini, Perplexity, Copilot, Meta AI, Poe or You.com.',
        })
    })
})

describe('AI crawlers', () => {
    it('gives every crawler reason its copy', () => {
        const c = (crawlers) => crawlersEmpty(aiTrafficPayload({ crawlers }).crawlers)
        expect(c({})).toBeNull()
        expect(c({ available: false, reason: 'no_cloudflare' })).toMatchObject({
            title: 'Not available: connect Cloudflare.',
            body: "AI crawlers don't run JavaScript, so the Cansee pixel and Google Analytics never see them. Cloudflare sees every request to your site; connect it to count crawler visits.",
            action: { label: 'Connect Cloudflare' },
        })
        expect(c({ available: false, reason: 'plan_unsupported' })).toMatchObject({
            title: 'Not available on this Cloudflare plan.',
            body: "Cloudflare refused the user-agent query for this zone, so crawler requests can't be counted.",
        })
        expect(c({ available: false, reason: 'source_error' })).toMatchObject({
            title: "We couldn't reach Cloudflare just now.",
            action: { label: 'Try again' },
        })
        expect(c({ available: false, reason: 'disabled' }).title).toBe("Cloudflare traffic isn't available on this server.")
        expect(c({ total_requests: 0, bots: [] })).toMatchObject({
            title: 'No AI crawler requests in the last 7 days.',
            body: "Counted from Cloudflare's requests for this zone.",
        })
    })

    it('builds the source line, tiles and footnotes', () => {
        const { crawlers } = aiTrafficPayload()
        expect(crawlerSourceLine(crawlers)).toBe('From Cloudflare · last 7 days · sampled · counted by user agent')
        expect(crawlerSourceLine({ ...crawlers, sampled: false })).toBe('From Cloudflare · last 7 days · counted by user agent')
        expect(crawlerTiles(crawlers).map((t) => [t.value, t.hint])).toEqual([
            [2500, 'last 7 days'],
            [4, ''],
            ['GPTBot', 'OpenAI'],
        ])
        expect(crawlerFootnotes(crawlers)).toEqual([
            'Counted from user-agent strings, which bots can fake. Cloudflare samples these numbers.',
            "Verified-bot detection needs Cloudflare Bot Management, so a request that fakes a crawler's name is counted as that crawler.",
        ])
    })

    it('draws requests per crawler with a Details view of operator and purpose', () => {
        const { crawlers } = aiTrafficPayload()
        const spec = crawlerBots(crawlers)
        expect(spec.label_names.gptbot).toBe('GPTBot (OpenAI)')
        expect(offered(spec)).toEqual(['hbar', 'custom', 'table'])
        expect(spec.custom_label).toBe('Details')
        expect(crawlerRows(crawlers)[0]).toEqual({
            key: 'gptbot',
            name: 'GPTBot',
            operator: 'OpenAI',
            purpose: 'Model training',
            requests: 2100,
            share: 84,
        })
    })

    it('stacks requests per day by operator, folding operators without a color', () => {
        const { crawlers } = aiTrafficPayload()
        const spec = crawlerSeries(crawlers)
        expect(spec.datasets.map((d) => [d.label, d.entity, d.data])).toEqual([
            ['OpenAI', 'operator:openai', [1000, 1100]],
            ['Anthropic', 'operator:anthropic', [100, 200]],
            ['Other operators', 'operator:other', [30, 70]],
        ])
        expect(offered(spec)).toEqual(['stacked_bar', 'line', 'table'])
    })

    it('shows why crawlers came', () => {
        const spec = purposesSpec(aiTrafficPayload().crawlers)
        expect(spec.label_names).toEqual({ training: 'Model training', search: 'AI search index' })
        // Labels over 14 characters turn the bars horizontal (contract 8b).
        expect(offered(spec)).toEqual(['hbar', 'doughnut', 'table'])
    })
})
