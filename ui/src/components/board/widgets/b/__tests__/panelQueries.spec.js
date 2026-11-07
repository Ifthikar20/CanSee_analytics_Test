import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The pages group B widgets expand to render only in the board's side
// panel, so their layout follows the panel body (container bd-panel), not
// the viewport (board_frontend.md 12). Checked on the sources themselves.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const source = (path) => readFileSync(resolve(SRC, path), 'utf8')

const PANEL_FILES = [
    'pages/analytics/VisibilityPage.vue',
    'pages/analytics/SentimentPage.vue',
    'pages/analytics/FactCheckPage.vue',
    'pages/analytics/CompetitorsPage.vue',
    'pages/analytics/FanoutsPage.vue',
    'pages/analytics/PromptResearchPage.vue',
    'pages/analytics/SitePagesPage.vue',
    'pages/analytics/CrawlerAccessPage.vue',
    'pages/analytics/ProductsPage.vue',
    'components/analytics/CitationAnalytics.vue',
    'components/analytics/ClaimsTable.vue',
    'components/analytics/FanoutPromptCard.vue',
    'components/analytics/IdeasTable.vue',
    'components/analytics/ThemesTable.vue',
]

// 1100px -> 760px, 767px -> 560px, 640px -> 480px.
const MAPPED = /^@container bd-panel \(max-width: (760|560|480)px\)\s*$/

describe('panel container queries', () => {
    it.each(PANEL_FILES)('%s follows the panel width, not the viewport', (path) => {
        const text = source(path)
        expect(text).not.toMatch(/@media \(max-width/)
        const rules = text.match(/@container [^{]*/g) || []
        expect(rules.length).toBeGreaterThan(0)
        expect(rules.filter((rule) => !MAPPED.test(rule))).toEqual([])
    })

    it('keeps the viewport rule of AnSelect beside its panel rule, for Settings and the run dialogs', () => {
        const text = source('components/analytics/AnSelect.vue')
        expect(text).toContain('@media (max-width: 640px)')
        expect(text).toContain('@container bd-panel (max-width: 480px)')
    })

    it.each(['pages/SourcesUrlsPage.vue', 'pages/SourcesUrlDetailPage.vue'])(
        '%s uses container breakpoints instead of the viewport ones',
        (path) => {
            const text = source(path)
            expect(text).not.toMatch(/\s(sm|lg):/)
            expect(text).toMatch(/@3xl:/)
        },
    )
})
