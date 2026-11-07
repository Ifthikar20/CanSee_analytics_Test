import { describe, expect, it } from 'vitest'
import {
    benchmarkBrands,
    benchmarkRows,
    benchmarkSpec,
    botGroups,
    checksSpec,
    crawlerNotices,
    crawlerTiles,
    homePage,
    llmsLine,
    pageAuditRows,
    pagesEmpty,
    pagesSourceStates,
    pagesTiles,
    pagesTopSpec,
    pathOf,
    searchBotsAllowed,
    sitePageRows,
} from '../siteSpecs'
import { representationsFor } from '@/lib/charts/spec'
import { timeAgo } from '@/utils/timeAgo'
import { BOTS, CHECKS, TRACKED, competitorAudit, crawlerAccess, pagesPayload, youAudit } from './__fixtures__/sitePayloads'

describe('crawler access', () => {
    it('reads the tiles from the audit, and "Not audited" before the first one', () => {
        expect(crawlerTiles(crawlerAccess()).map((t) => [t.label, t.value])).toEqual([
            ['Checks passed', '14 of 19'],
            ['AI search bots allowed', '2 of 3'],
            ['robots.txt', 'Found'],
            ['llms.txt', 'Found'],
        ])
        const none = crawlerTiles(crawlerAccess({ you: null }))
        expect(none.map((t) => t.value)).toEqual([null, null, null, null])
        expect(none.map((t) => t.stateText)).toEqual(['Not audited', 'Not audited', 'Not audited', 'Not audited'])
    })

    it('counts the AI search bots allowed, unknown when robots.txt could not be fetched', () => {
        expect(searchBotsAllowed(youAudit())).toBe(2)
        const failed = youAudit({ bots: youAudit().bots.map((b) => ({ ...b, home: 'unknown', pages_blocked: null })) })
        expect(searchBotsAllowed(failed)).toBeNull()
        expect(crawlerTiles(crawlerAccess({ you: failed }))[1]).toMatchObject({ value: null, stateText: 'Unknown' })
        expect(searchBotsAllowed(null)).toBeNull()
    })

    it('says what robots.txt and llms.txt states mean', () => {
        expect(crawlerNotices(youAudit())).toEqual([])
        const texts = (you) => crawlerNotices(you).map((n) => n.text)
        expect(texts(youAudit({ robots: { state: 'missing' }, llms_txt: { state: 'missing' } }))).toEqual([
            'No robots.txt. Crawlers may read every page.',
            'No llms.txt. It is an optional file that points AI tools to your most useful pages.',
        ])
        expect(texts(youAudit({ robots: { state: 'unreachable' }, llms_txt: { state: 'invalid' } }))).toEqual([
            "robots.txt didn't respond. Crawlers that follow the standard treat your whole site as blocked until it does.",
            'llms.txt has no title line (# Name), the one required part.',
        ])
        expect(crawlerNotices(null)).toEqual([])
    })

    it('reads the llms.txt panel line', () => {
        expect(llmsLine(youAudit().llms_txt)).toBe('llms.txt: "Notion", 3 sections, 18 links. llms-full.txt: Missing.')
        expect(llmsLine({ state: 'found', title: 'Acme', sections: 1, links: 1, full: 'found' })).toBe(
            'llms.txt: "Acme", 1 section, 1 link. llms-full.txt: Found.',
        )
        expect(llmsLine({ state: 'missing' })).toBe('')
    })

    it('groups the bots by operator with rule, home page, pages blocked and the robots.txt word', () => {
        const groups = botGroups(crawlerAccess())
        expect(groups.map((g) => g.operator)).toEqual(['OpenAI', 'Anthropic', 'Perplexity', 'Google'])
        const [gpt, search, user] = groups[0].rows
        expect(gpt).toMatchObject({
            token: 'GPTBot',
            purpose: 'Model training',
            rule: 'Disallow: / from group GPTBot',
            home: 'Blocked',
            blocked: '2 of 3',
            follows: 'Yes',
            followsNote: 'Follows robots.txt',
        })
        expect(search).toMatchObject({ rule: 'No rule', home: 'Allowed', blocked: '0 of 3' })
        expect(user).toMatchObject({ follows: 'Not always', followsNote: 'robots.txt may not apply to fetches a user asks for' })
        // A control token that is blocked has opted out.
        expect(groups[3].rows[0]).toMatchObject({ token: 'Google-Extended', home: 'Opted out', follows: 'Control token' })

        const missing = botGroups(crawlerAccess({ you: youAudit({ robots: { state: 'missing' } }) }))
        expect(missing[0].rows[0].rule).toBe('No robots.txt')
        const failed = botGroups(
            crawlerAccess({ you: youAudit({ robots: { state: 'failed' }, bots: BOTS.map((b) => ({ key: b.key, home: 'unknown', pages_blocked: null })) }) }),
        )
        expect(failed[0].rows[0]).toMatchObject({ home: 'Unknown', blocked: 'Unknown' })
    })

    it('builds the checks chart with measured counts, a check without data as not checked', () => {
        const spec = checksSpec(youAudit(), CHECKS)
        expect(spec).toMatchObject({ id: 'crawler.checks', title: 'Pages passing each check', stacked: true, type: 'stacked_bar' })
        expect(spec.footnote).toBe("Pages that didn't load are left out of the other checks.")
        expect(spec.label_names.meta_description).toBe('Has a meta description')
        expect(spec.datasets.map((d) => [d.key, d.entity])).toEqual([
            ['passed', 'status:good'],
            ['failed', 'status:critical'],
        ])
        const i = spec.labels.indexOf('ai_search_allowed')
        expect(spec.datasets[0].data[i]).toBe(0)
        expect(spec.datasets[1].data[i]).toBe(2)
        const partial = checksSpec(youAudit({ summary: { by_check: { status_ok: { passed: 1, failed: 0 } } } }), CHECKS)
        expect(partial.datasets[0].states.filter((s) => s === 'not_checked')).toHaveLength(8)
        expect(representationsFor(spec)).toContain('stacked_bar')
    })

    it('lists the audited pages, fewest checks passed first, with failures in words', () => {
        const rows = pageAuditRows(youAudit(), { checks: CHECKS, bots: BOTS })
        expect(rows.map((r) => r.path)).toEqual(['/old', '/pricing', '/'])
        expect(rows[0]).toMatchObject({ status: 'The page took too long to load.', words: 'Not checked', checks: '0 of 1' })
        expect(rows[1]).toMatchObject({
            status: '200',
            words: '120',
            wordsText: '120 words readable without JavaScript',
            needsJs: true,
            checks: '6 of 9',
            failedLabels: ['Has a meta description', 'Text without JavaScript', 'Open to AI search bots'],
            blockedFor: ['GPTBot', 'PerplexityBot'],
        })
        expect(rows[2].needsJs).toBe(false)
        expect(pathOf('https://notion.so/')).toBe('/')
    })

    it('compares home pages with every tracked competitor, never audited ones as Not audited', () => {
        const brands = benchmarkBrands(crawlerAccess(), TRACKED)
        expect(brands.map((b) => [b.key, b.name, Boolean(b.audit)])).toEqual([
            ['you', 'Notion', true],
            ['b1', 'Evernote', true],
            ['b2', 'Obsidian', false],
        ])
        const spec = benchmarkSpec(brands)
        expect(spec).toMatchObject({ id: 'crawler.benchmark', title: 'Home pages compared', pick_one: true, type: 'bar' })
        expect(spec.state_labels).toEqual({ not_checked: 'Not audited' })
        expect(spec.datasets[0]).toMatchObject({ label: 'Checks passed', data: [8, 9, null], states: [null, null, 'not_checked'] })
        expect(spec.datasets[1]).toMatchObject({ label: 'AI search bots allowed', data: [2, 3, null] })
        expect(spec.label_names).toEqual({ you: 'Notion', b1: 'Evernote', b2: 'Obsidian' })

        const rows = benchmarkRows(brands, BOTS)
        expect(rows[0]).toMatchObject({ robots: 'Found', llms: 'Found', checks: '8 of 9' })
        expect(rows[0].bots).toMatchObject({ gptbot: 'Blocked', perplexitybot: 'Blocked', 'google-extended': 'Opted out', claudebot: 'Allowed' })
        expect(rows[1]).toMatchObject({ robots: 'Missing', llms: 'Missing', checks: '9 of 9' })
        expect(rows[2]).toMatchObject({ robots: 'Not audited', llms: 'Not audited', checks: 'Not audited' })
        expect(Object.values(rows[2].bots)).toEqual(Array(6).fill('Not audited'))
    })

    it('finds the home page by its path, whatever order the pages were fetched in', () => {
        const pages = [{ url: 'https://notion.so/pricing' }, { url: 'https://notion.so/' }]
        expect(homePage({ pages })).toBe(pages[1])
        expect(homePage({ pages: [pages[0]] })).toBe(pages[0])
        expect(homePage(null)).toBeNull()
    })

    it('matches competitor audits by apex domain, not by stored key', () => {
        const audits = [competitorAudit({ brand_key: 'b3', domain: 'www.evernote.com' })]
        const brands = benchmarkBrands(crawlerAccess({ competitors: audits }), TRACKED)
        expect(brands[1]).toMatchObject({ key: 'b1' })
        expect(brands[1].audit).not.toBeNull()
        // Without the tracked list, the audited competitors.
        expect(benchmarkBrands(crawlerAccess(), []).map((b) => b.key)).toEqual(['you', 'b1'])
    })
})

describe('pages', () => {
    it('names each source state, with the pixel label and the audit time when on', () => {
        const items = pagesSourceStates(pagesPayload())
        expect(items.map((i) => [i.label, i.ok])).toEqual([
            ['Google rankings', true],
            ['AI citations', true],
            ['AI visits', true],
            ['AI crawlers', false],
            ['Audit', true],
        ])
        expect(items[2].word).toBe('Cansee pixel')
        expect(items[3].word).toBe('Not connected')
        expect(items[4].word).toBe(timeAgo('2026-11-05T10:05:00Z'))
        const off = pagesSourceStates(
            pagesPayload({
                sources: {
                    google: { state: 'not_configured' },
                    citations: { state: 'no_data' },
                    ai_visits: { state: 'source_error' },
                    crawlers: { state: 'plan_unsupported' },
                    audit: { state: 'not_run' },
                },
            }),
        )
        expect(off.map((i) => i.word)).toEqual(['Not configured', 'None recorded', "Couldn't reach it", 'Not on this plan', 'Not run'])
    })

    it('reads the tiles, a total of a source that is off as its state word', () => {
        expect(pagesTiles(pagesPayload()).map((t) => [t.label, t.value, t.stateText])).toEqual([
            ['Pages seen', 2, 'Not measured'],
            ['Ranking on Google', 1, 'On'],
            ['Cited by AI', 1, 'On'],
            ['Visited from AI', 1, 'On'],
            ['Crawled by AI bots', null, 'Not connected'],
        ])
    })

    it('charts the first 15 pages one signal at a time, a source that is off as its state', () => {
        const spec = pagesTopSpec(pagesPayload())
        expect(spec).toMatchObject({ id: 'pages.top', title: 'Pages by signal', pick_one: true, type: 'hbar' })
        expect(spec.label_names).toEqual({ 'https://notion.so/pricing': '/pricing', 'https://notion.so/about': '/about' })
        const [citations, visits, crawler, google] = spec.datasets
        expect(citations).toMatchObject({ label: 'AI citations', data: [6, 0], states: [null, null] })
        expect(visits).toMatchObject({ label: 'AI visits', data: [12, 0] })
        expect(crawler).toMatchObject({ label: 'Crawler requests', data: [null, null], states: ['not_connected', 'not_connected'] })
        expect(google).toMatchObject({ label: 'Best Google position', value: 'rank', data: [3, null], states: [null, 'not_found'] })
        expect(spec.state_labels).toEqual({ not_found: 'Not ranking' })
        // The rank measure offers the table only.
        expect(representationsFor(spec, { picked: 'google' })).toEqual(['table'])
        expect(representationsFor(spec, { picked: 'citations' })).toEqual(['hbar', 'table'])

        const many = pagesPayload({ pages: Array.from({ length: 20 }, (_, i) => ({ ...pagesPayload().pages[0], url: `https://notion.so/p${i}`, path: `/p${i}` })) })
        expect(pagesTopSpec(many).labels).toHaveLength(15)
    })

    it('reads each table cell in words', () => {
        const [pricing, about] = sitePageRows(pagesPayload())
        expect(pricing).toMatchObject({
            path: '/pricing',
            google: { text: '#3', sub: '1 prompt' },
            citations: { text: '6', sub: '0 in answer text', retrievedOnly: true },
            visits: '12',
            crawler: 'Not connected',
            audit: { text: '7 of 9', failing: ['Has a meta description', 'Text without JavaScript'] },
        })
        expect(about).toMatchObject({
            google: { text: 'Not ranking' },
            citations: { text: '0', retrievedOnly: false },
            visits: '0',
            audit: { text: 'Not audited', failing: [] },
        })
        const crawled = pagesPayload({
            sources: { ...pagesPayload().sources, crawlers: { state: 'ok', window_days: 7 }, audit: { state: 'not_run' } },
            pages: [
                { ...pagesPayload().pages[0], crawler_requests: { requests: 40 } },
                { ...pagesPayload().pages[1], crawler_requests: { requests: null, state: 'not_in_top' } },
            ],
        })
        const rows = sitePageRows(crawled)
        expect(rows.map((r) => r.crawler)).toEqual(['40', 'Not in the top 50'])
        expect(rows[0].audit.text).toBe('Not run')
    })

    it('says why there are no pages: none seen yet, or none for this filter', () => {
        expect(pagesEmpty(pagesPayload())).toBeNull()
        expect(pagesEmpty(pagesPayload({ pages: [] }), 'all')).toMatchObject({
            title: 'No pages seen yet.',
            body: 'Pages appear when Google ranks them for your prompts, an engine cites them, an AI assistant sends a visit, a crawler fetches them, or an audit reads them.',
            action: { label: 'Run audit' },
        })
        expect(pagesEmpty(pagesPayload({ pages: [] }), 'cited')).toMatchObject({
            title: 'No pages match this filter.',
            action: { label: 'Show all pages' },
        })
    })
})
