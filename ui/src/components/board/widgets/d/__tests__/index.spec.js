import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { DEFAULT_LAYOUT, WIDGETS } from '@/lib/board/widgets'
import { WIDGET_COMPONENTS } from '@/components/board/widgetComponents'
import widgetsD from '../index.js'

const SLOW = 30_000

describe('group D blocks', () => {
    it('covers the four blocks that open a new board, the first four of the catalog', () => {
        expect(Object.keys(widgetsD)).toEqual(['watch', 'asked-answered', 'answer-rank', 'visibility-score'])
        expect(WIDGETS.slice(0, 4).map((w) => w.key)).toEqual(Object.keys(widgetsD))
        expect(DEFAULT_LAYOUT.slice(0, 4).map((w) => w.key)).toEqual(Object.keys(widgetsD))
        // The board finds them with every other block.
        for (const key of Object.keys(widgetsD)) expect(WIDGET_COMPONENTS[key], key).toBe(widgetsD[key])
        expect(Object.keys(WIDGET_COMPONENTS).sort()).toEqual(WIDGETS.map((w) => w.key).sort())
    })

    it('keeps each card in its own file, with the board props', async () => {
        const names = {
            watch: 'WatchCard',
            'asked-answered': 'AskedAnsweredCard',
            'answer-rank': 'AnswerRankCard',
            'visibility-score': 'VisibilityScoreCard',
        }
        for (const [key, entry] of Object.entries(widgetsD)) {
            expect(typeof entry.card, key).toBe('function')
            const card = (await entry.card()).default
            expect(card.__name, key).toBe(names[key])
            expect(card.props.websiteId.required, key).toBe(true)
            expect(card.props.size.default, key).toBe('third')
        }
    }, SLOW)

    it('opens a view of the same data from each title', async () => {
        // The watch has no detail of its own: its panel is the card at full size.
        expect(widgetsD.watch.panel).toBe(widgetsD.watch.card)
        expect(widgetsD.watch.panelProps).toEqual({ size: 'full' })
        expect((await widgetsD['asked-answered'].panel()).default.__name).toBe('PromptsPanel')
        expect((await widgetsD['answer-rank'].panel()).default.__name).toBe('LeaderboardPanel')
        expect(widgetsD['visibility-score'].panelProps).toEqual({ focus: 'over-time' })
        const page = (await widgetsD['visibility-score'].panel()).default
        expect(page.props).toHaveProperty('focus')
        for (const [key, entry] of Object.entries(widgetsD)) {
            expect((await entry.panel()).default.props.websiteId, key).toBeTruthy()
        }
    }, SLOW)

    it('draws its own catalog tile for the watch and the visibility score', async () => {
        expect(Object.keys(widgetsD).filter((key) => widgetsD[key].preview)).toEqual(['watch', 'visibility-score'])
        for (const key of ['watch', 'visibility-score']) {
            const wrapper = mount((await widgetsD[key].preview()).default)
            const svg = wrapper.find('svg')
            // A drawing under the catalog's "Sample data" chip: hidden from
            // screen readers, in the tile's proportions, the accent once,
            // painted from tokens only.
            expect(svg.attributes('aria-hidden'), key).toBe('true')
            const [, , width, height] = svg.attributes('viewBox').split(' ').map(Number)
            expect(width / height, key).toBeCloseTo(1.6)
            expect(wrapper.findAll('.is-you, .wd-eye-iris'), key).toHaveLength(1)
            expect(wrapper.html(), key).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|fill="|stroke="/i)
            wrapper.unmount()
        }
    }, SLOW)

    it('sketches the visibility score in the unit the block really shows', async () => {
        const wrapper = mount((await widgetsD['visibility-score'].preview()).default)
        expect(wrapper.text()).toContain('% OF ANSWERS')
        expect(wrapper.text()).not.toContain('/ 100')
        expect(wrapper.findAll('polyline')).toHaveLength(1)
    }, SLOW)
})
