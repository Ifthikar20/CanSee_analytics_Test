import { describe, expect, it } from 'vitest'
import { WIDGETS } from '@/lib/board/widgets'
import widgetsB from '../index.js'

// Group A's keys (board_ownership.md 2) and group C's (Ask AI and Prompt
// ranking, autopilot_frontend.md 6b); every other catalog key is group B's.
const GROUP_A = ['summary', 'prompts', 'countries', 'traffic', 'ai-traffic', 'ai-crawlers']
const GROUP_C = ['prompt-box', 'ranking']

// Loading every page module cold takes a while in a full run.
const SLOW = 30_000

describe('group B widgets', () => {
    it('covers the other thirteen catalog keys, in catalog order', () => {
        expect(Object.keys(widgetsB)).toEqual(
            WIDGETS.map((w) => w.key).filter((key) => !GROUP_A.includes(key) && !GROUP_C.includes(key)),
        )
        expect(Object.keys(widgetsB)).toHaveLength(13)
    })

    it('lazy-loads a card and a panel for each key', async () => {
        for (const [key, entry] of Object.entries(widgetsB)) {
            expect(typeof entry.card, key).toBe('function')
            expect(typeof entry.panel, key).toBe('function')
            const [card, panel] = await Promise.all([entry.card(), entry.panel()])
            expect(card.default, key).toBeTruthy()
            expect(panel.default, key).toBeTruthy()
            // A card takes the project and its size; a panel the project.
            expect(card.default.props.websiteId.required, key).toBe(true)
            expect(card.default.props.size, key).toBeTruthy()
            expect(panel.default.props.websiteId, key).toBeTruthy()
        }
    }, SLOW)

    it('opens the three visibility widgets on their own section of the Visibility page', async () => {
        const page = (await import('@/pages/analytics/VisibilityPage.vue')).default
        expect(widgetsB.visibility.panelProps).toEqual({ focus: 'over-time' })
        expect(widgetsB['by-engine'].panelProps).toEqual({ focus: 'by-engine' })
        expect(widgetsB['share-of-voice'].panelProps).toEqual({ focus: 'share-of-voice' })
        for (const key of ['visibility', 'by-engine', 'share-of-voice']) {
            expect((await widgetsB[key].panel()).default).toBe(page)
        }
        // The other widgets need no panel props.
        const others = Object.entries(widgetsB).filter(([key]) => !['visibility', 'by-engine', 'share-of-voice'].includes(key))
        expect(others.every(([, entry]) => entry.panelProps === undefined)).toBe(true)
    }, SLOW)

    it('expands Pages to the site pages page and the rest to their own pages', async () => {
        const name = async (key) => (await widgetsB[key].panel()).default.__name
        expect(await name('pages')).toBe('SitePagesPage')
        expect(await name('sentiment')).toBe('SentimentPage')
        expect(await name('fact-check')).toBe('FactCheckPage')
        expect(await name('crawler-access')).toBe('CrawlerAccessPage')
        expect(await name('fan-outs')).toBe('FanoutsPage')
        expect(await name('prompt-research')).toBe('PromptResearchPage')
        expect(await name('competitors')).toBe('CompetitorsPage')
        expect(await name('products')).toBe('ProductsPage')
        expect(await name('who-recommends')).toBe('LeaderboardPanel')
        expect(await name('citations')).toBe('CitationsPanel')
    }, SLOW)
})
