import { describe, expect, it } from 'vitest'
import { normalizeVizSpec } from '@/lib/charts/spec'
import { datasetToken } from '@/lib/charts/palette'
import {
    NO_PROMPTS,
    brandItems,
    citationLead,
    citationsEmpty,
    crawlerLines,
    domainItems,
    engineItems,
    factCheckEmpty,
    fanoutLines,
    ideaLines,
    leaderboardItems,
    loadFailure,
    noIdeas,
    pageItems,
    productLines,
    themeLine,
    tileProps,
    toneItems,
    topContradicted,
    verdictItems,
    visibilityAll,
    visibilityEmpty,
    visibilityTile,
    voiceItems,
    voiceTile,
} from '../specs'
import {
    competitorsPayload,
    crawlerAccessPayload,
    factCheckPayload,
    fanOutsPayload,
    notAnalyzedFactCheck,
    overviewPayload,
    pagesPayload,
    productsPayload,
    promptIdeasPayload,
    sentimentPayload,
    visibilityPayload,
} from './__fixtures__/boardPayloads'

const emphasized = (items) => items.filter((i) => i.emphasis).map((i) => i.key)

describe('states', () => {
    it('names the widget in a load error, and says when Insights are off', () => {
        expect(loadFailure({ status: 500, code: 'error', message: '' }, 'Sentiment')).toEqual({
            kind: 'error',
            title: "We couldn't load Sentiment.",
            action: { label: 'Try again', retry: true },
        })
        expect(loadFailure({ status: 503, code: 'insights_disabled', message: '' }, 'Sentiment')).toEqual({
            kind: 'disabled',
            title: 'Insights are turned off on this server.',
        })
    })

    it('maps the visibility family empty reasons to their copy', () => {
        expect(visibilityEmpty(visibilityPayload({ has_data: false, empty_reason: 'no_prompts' }))).toBe(NO_PROMPTS)
        expect(NO_PROMPTS).toEqual({ title: 'Track a prompt first.', action: { label: 'Add prompts', open: ['prompts', { add: '1' }] } })
        expect(visibilityEmpty(visibilityPayload({ has_data: false, empty_reason: 'no_engines' }))).toEqual({
            kind: 'not_connected',
            title: 'No AI engine is connected yet.',
        })
        expect(visibilityEmpty(visibilityPayload({ has_data: false, empty_reason: 'no_answers' }))).toEqual({
            title: 'No AI answers in the last 30 days.',
        })
        // has_data false without a reason reads as no answers too.
        expect(visibilityEmpty(visibilityPayload({ has_data: false, empty_reason: null })).title).toBe(
            'No AI answers in the last 30 days.',
        )
        expect(visibilityEmpty(visibilityPayload())).toBeNull()
    })

    it('maps the fact check states', () => {
        expect(factCheckEmpty(factCheckPayload({ empty_reason: 'no_answers' })).title).toBe(
            "The engines didn't name you in the last 30 days.",
        )
        expect(factCheckEmpty(notAnalyzedFactCheck())).toEqual({
            title: 'No answers analyzed yet.',
            action: { label: 'Analyze answers', panel: true },
        })
        expect(factCheckEmpty(factCheckPayload({ empty_reason: 'no_claims' })).title).toBe(
            'The analyzed answers make no checkable claims about you.',
        )
        expect(factCheckEmpty(factCheckPayload())).toBeNull()
    })

    it('says when no cited source was recorded', () => {
        const none = visibilityPayload({ citations: { has_data: false, totals: null, series: {}, top_domains: [] } })
        expect(citationsEmpty(none)).toEqual({
            title: 'No cited sources yet.',
            body: 'Engines that answer without sources leave this empty.',
        })
        expect(citationsEmpty(visibilityPayload({ has_data: false, empty_reason: 'no_prompts' }))).toBe(NO_PROMPTS)
        expect(citationsEmpty(visibilityPayload())).toBeNull()
    })

    it('strips the key and the identity dot from a tile', () => {
        expect(tileProps([{ key: 'a', label: 'A', value: 1, tone: 'var(--x)' }], 'a')).toEqual({ label: 'A', value: 1 })
        expect(tileProps([], 'a')).toBeNull()
    })
})

describe('the visibility family', () => {
    it('draws every engine together as one accent line, keeping empty days as gaps', () => {
        const spec = visibilityAll(visibilityPayload())
        expect(spec).toMatchObject({
            id: 'board.visibility',
            x: 'time',
            value: 'percent',
            labels: ['2026-11-03', '2026-11-04'],
            palette: 'emphasis',
            emphasis: 'all',
            missing_label: 'No answers',
        })
        expect(spec.datasets).toEqual([{ key: 'all', label: 'All engines', data: [35, null] }])
        const norm = normalizeVizSpec(spec)
        expect(datasetToken(norm, norm.datasets[0], 0)).toBe('--viz-cat-1')
    })

    it('reads the visibility tile with its change and no identity dot', () => {
        expect(visibilityTile(visibilityPayload())).toEqual({
            label: 'AI visibility',
            value: 34.2,
            kind: 'percent',
            stateText: 'No answers',
            delta: { value: 4.1, unit: 'pts', label: 'vs previous 30 days', goodWhen: 'up' },
        })
    })

    it('lists each engine as you (accent), with a measured 0% and the words of the others', () => {
        const items = engineItems(visibilityPayload())
        expect(items.map((i) => [i.label, i.value, i.text])).toEqual([
            ['ChatGPT', 40, '40%'],
            ['Claude', 0, '0%'],
        ])
        expect(emphasized(items)).toEqual(['chatgpt', 'claude'])
        // An engine that has answers but is not configured any more reads its word.
        const payload = visibilityPayload()
        payload.by_engine[2].answers = 3
        expect(engineItems(payload).find((i) => i.key === 'gemini')).toMatchObject({ value: null, text: 'Not configured' })
    })

    it('shows the four largest shares of voice with you as the only accent', () => {
        const items = voiceItems(visibilityPayload())
        expect(items.map((i) => [i.label, i.text])).toEqual([
            ['Evernote', '27%'],
            ['Obsidian', '23%'],
            ['Coda', '21%'],
            ['Notion', '18%'],
        ])
        expect(emphasized(items)).toEqual(['you'])
        expect(voiceTile(visibilityPayload())).toMatchObject({ label: 'Share of voice', value: 18.2, stateText: 'No brands named' })
    })

    it('adds your row when you are not among the four', () => {
        const payload = visibilityPayload()
        payload.share_of_voice.brands.splice(4, 0, { key: 'b4', name: 'Bear', is_you: false, mentions: 48, share_pct: 21.8 })
        const items = voiceItems(payload)
        expect(items.map((i) => i.key)).toEqual(['b1', 'b2', 'b4', 'b3', 'you'])
        expect(emphasized(items)).toEqual(['you'])
    })
})

describe('who AI recommends', () => {
    it('takes the top five brands, you as the accent', () => {
        const items = leaderboardItems(overviewPayload().leaderboard)
        expect(items.map((i) => [i.label, i.text])).toEqual([
            ['Evernote', '62%'],
            ['Obsidian', '50%'],
            ['Coda', '38%'],
            ['Notion', '25%'],
            ['Bear', '13%'],
        ])
        expect(emphasized(items)).toEqual(['Notion'])
    })

    it('appends your own row when you rank lower, and keeps a measured 0%', () => {
        const board = overviewPayload().leaderboard
        const you = board.splice(3, 1)[0]
        board.push({ ...you, visibility_pct: 0 })
        const items = leaderboardItems(board)
        expect(items.map((i) => i.label)).toEqual(['Evernote', 'Obsidian', 'Coda', 'Bear', 'Roam', 'Notion'])
        expect(items.at(-1)).toMatchObject({ value: 0, text: '0%', emphasis: true })
        expect(leaderboardItems([])).toEqual([])
    })
})

describe('sentiment and fact check', () => {
    it('counts the three tones in gray, a measured zero as 0', () => {
        const items = toneItems(sentimentPayload())
        expect(items.map((i) => [i.label, i.value, i.text])).toEqual([
            ['Positive', 30, '30'],
            ['Neutral', 15, '15'],
            ['Negative', 0, '0'],
        ])
        expect(emphasized(items)).toEqual([])
    })

    it('names the most repeated theme', () => {
        expect(themeLine(sentimentPayload())).toBe('Most repeated: "easy to set up" (positive, 9 answers)')
        const one = sentimentPayload({ themes: [{ key: 'k', label: 'pricey', tone: 'negative', answers: 1 }] })
        expect(themeLine(one)).toBe('Most repeated: "pricey" (negative, 1 answer)')
        expect(themeLine(sentimentPayload({ themes: [] }))).toBe('')
    })

    it('counts claims by verdict in gray, and only lists unfinished checks when there are some', () => {
        const items = verdictItems(factCheckPayload())
        expect(items.map((i) => [i.label, i.text])).toEqual([
            ['Contradicted', '4'],
            ['Not verifiable', '21'],
            ['Supported', '30'],
            ['Not checked', '2'],
        ])
        expect(emphasized(items)).toEqual([])
        const done = factCheckPayload({ totals: { claims: 5, supported: 5, contradicted: 0, not_verifiable: 0, unchecked: 0 } })
        expect(verdictItems(done).map((i) => i.text)).toEqual(['0', '0', '5'])
        // Before any analysis the counts are words, never 0.
        expect(verdictItems(notAnalyzedFactCheck()).map((i) => i.text)).toEqual(['Not analyzed', 'Not analyzed', 'Not analyzed'])
    })

    it('picks the contradicted claim repeated in the most answers', () => {
        expect(topContradicted(factCheckPayload())).toBe("Notion's Plus plan costs $8 per user per month")
        expect(topContradicted(factCheckPayload({ claims: [] }))).toBe('')
    })
})

describe('citations', () => {
    it('says how many citations point to your site and lists five domains, yours as the accent', () => {
        expect(citationLead(visibilityPayload())).toBe('12 of 340 citations point to your site')
        const items = domainItems(visibilityPayload())
        expect(items.map((i) => [i.label, i.text, i.hint])).toEqual([
            ['g2.com', '18', ''],
            ['notion.so', '12', 'Your site'],
            ['evernote.com', '7', 'Competitor'],
            ['reddit.com', '6', ''],
            ['zapier.com', '4', ''],
        ])
        expect(emphasized(items)).toEqual(['notion.so'])
        expect(citationLead(visibilityPayload({ citations: { has_data: false, totals: null, top_domains: [] } }))).toBe('')
    })
})

describe('crawler access and pages', () => {
    it('reads the three lines of the latest audit, words where nothing was measured', () => {
        expect(crawlerLines(crawlerAccessPayload())).toEqual([
            { key: 'search_bots', label: 'AI search bots allowed', text: '2 of 3', measured: true },
            { key: 'robots', label: 'robots.txt', text: 'Found', measured: true },
            { key: 'llms', label: 'llms.txt', text: 'Missing', measured: true },
        ])
        const payload = crawlerAccessPayload()
        payload.you.robots.state = 'failed'
        payload.you.bots[1].home = 'unknown'
        expect(crawlerLines(payload)[0]).toEqual({ key: 'search_bots', label: 'AI search bots allowed', text: 'Unknown', measured: false })
    })

    it('ranks your pages by AI citations, all of them you', () => {
        const items = pageItems(pagesPayload())
        expect(items.map((i) => [i.label, i.text])).toEqual([
            ['/ai', '9 citations'],
            ['/pricing', '6 citations'],
            ['/docs', '3 citations'],
            ['/', '2 citations'],
            ['/blog/x', '1 citation'],
        ])
        expect(items.every((i) => i.emphasis)).toBe(true)
    })

    it('reads the citations source state while it is off, never 0', () => {
        const payload = pagesPayload()
        payload.sources.citations = { state: 'no_data', answers_with_sources: 0 }
        const items = pageItems(payload)
        expect(items.map((i) => i.label)).toEqual(['/', '/pricing', '/blog/x', '/teams', '/ai'])
        expect(items.every((i) => i.value === null && i.text === 'None recorded')).toBe(true)
    })
})

describe('fan-outs, prompt research, competitors and products', () => {
    it('lists the searches run in the most answers with their Google place', () => {
        expect(fanoutLines(fanOutsPayload())).toEqual([
            { key: 'p1|best note apps 2026', label: 'best note apps 2026', text: '#4', measured: true },
            { key: 'p2|notion pricing for teams', label: 'notion pricing for teams', text: 'Not checked', measured: false },
            { key: 'p1|evernote vs notion', label: 'evernote vs notion', text: 'Not on page one', measured: false },
        ])
        expect(fanoutLines(fanOutsPayload({ prompts: [] }))).toEqual([])
    })

    it('lists three new ideas with their sources, never a volume', () => {
        expect(ideaLines(promptIdeasPayload())).toEqual([
            { key: 'e1', label: 'is notion free for teams', text: 'People also ask, Engine search', measured: false },
            { key: 'e2', label: 'notion vs evernote for students', text: 'Related search', measured: false },
            { key: 'e3', label: 'how to share a notion page', text: 'Predicted sub-query', measured: false },
        ])
        expect(noIdeas(promptIdeasPayload())).toBe(false)
        expect(noIdeas(promptIdeasPayload({ counts: { new: 0, tracked: 0, dismissed: 0, by_source: {} }, ideas: [] }))).toBe(true)
    })

    it('shows each brand with its AI visibility, you as the only accent', () => {
        const items = brandItems(competitorsPayload())
        expect(items.map((i) => [i.label, i.text])).toEqual([
            ['Notion', '33%'],
            ['Evernote', '42%'],
            ['Obsidian', '0%'],
        ])
        expect(emphasized(items)).toEqual(['you'])
        const none = competitorsPayload({ ai: { answers: 0, brands: {} } })
        expect(brandItems(none).map((i) => i.text)).toEqual(['No answers', 'No answers', 'No answers'])
    })

    it('reads each product in Google Shopping, words before a check', () => {
        expect(productLines(productsPayload())).toEqual([
            { key: 'pr1', label: 'Acme X200 running shoe', text: '#3 of 40 results', measured: true },
            { key: 'pr2', label: 'Acme trail sock', text: 'Not in the 40 results', measured: false },
            { key: 'pr3', label: 'Acme rain jacket', text: 'Not checked yet', measured: false },
        ])
        const failed = productsPayload()
        failed.products[0].latest.google = { state: 'failed' }
        expect(productLines(failed)[0].text).toBe('Failed')
    })
})
