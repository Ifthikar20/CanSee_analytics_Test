import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, WIDGETS } from '@/lib/board/widgets'
import { WIDGET_COMPONENTS } from '@/components/board/widgetComponents'
import widgetsC from '../index.js'

describe('group C widgets', () => {
    it('covers Ask AI and Prompt ranking, the first two catalog keys and the default board', () => {
        expect(Object.keys(widgetsC)).toEqual(['prompt-box', 'ranking'])
        expect(WIDGETS.slice(0, 2).map((w) => w.key)).toEqual(['prompt-box', 'ranking'])
        expect(DEFAULT_LAYOUT.map((w) => w.key)).toEqual(['prompt-box', 'ranking'])
        // The board finds them with every other widget.
        expect(WIDGET_COMPONENTS['prompt-box']).toBe(widgetsC['prompt-box'])
        expect(WIDGET_COMPONENTS.ranking).toBe(widgetsC.ranking)
        expect(Object.keys(WIDGET_COMPONENTS).sort()).toEqual(WIDGETS.map((w) => w.key).sort())
    })

    it('lazy-loads a card and a panel for each key, with the board props', async () => {
        for (const [key, entry] of Object.entries(widgetsC)) {
            const [card, panel] = await Promise.all([entry.card(), entry.panel()])
            expect(card.default.props.websiteId.required, key).toBe(true)
            expect(card.default.props.size, key).toBeTruthy()
            expect(panel.default.props.websiteId, key).toBeTruthy()
            expect(entry.panelProps, key).toBeUndefined()
        }
        expect((await widgetsC['prompt-box'].card()).default.__name).toBe('PromptBoxCard')
        expect((await widgetsC['prompt-box'].panel()).default.__name).toBe('PromptBoxPanel')
        expect((await widgetsC.ranking.card()).default.__name).toBe('RankingCard')
        expect((await widgetsC.ranking.panel()).default.__name).toBe('RankingPanel')
    }, 30_000)
})
