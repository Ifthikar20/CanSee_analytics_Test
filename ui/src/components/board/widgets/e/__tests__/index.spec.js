import { describe, expect, it } from 'vitest'
import { WIDGETS } from '@/lib/board/widgets'
import { WIDGET_COMPONENTS } from '@/components/board/widgetComponents'
import widgetsE from '../index.js'

const SLOW = 30_000

describe('group E blocks', () => {
    it('covers the account and project blocks, the last three of the catalog', () => {
        expect(Object.keys(widgetsE)).toEqual(['prompt-runs', 'next-steps', 'latest-report'])
        expect(WIDGETS.slice(-3).map((w) => w.key)).toEqual(Object.keys(widgetsE))
        for (const key of Object.keys(widgetsE)) expect(WIDGET_COMPONENTS[key], key).toBe(widgetsE[key])
    })

    it('keeps each card in its own file, with the board props at its default size', async () => {
        const names = { 'prompt-runs': 'PromptRunsCard', 'next-steps': 'NextStepsCard', 'latest-report': 'LatestReportCard' }
        for (const [key, entry] of Object.entries(widgetsE)) {
            const card = (await entry.card()).default
            expect(card.__name, key).toBe(names[key])
            expect(card.props.websiteId.required, key).toBe(true)
            expect(card.props.size.default, key).toBe(WIDGETS.find((w) => w.key === key).size)
        }
    }, SLOW)

    it("opens each block's own card at full size as its panel", () => {
        for (const [key, entry] of Object.entries(widgetsE)) {
            expect(entry.panel, key).toBe(entry.card)
            expect(entry.panelProps, key).toEqual({ size: 'full' })
        }
    })
})
