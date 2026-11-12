// What each group D card shows in each state, and what it tells its frame
// (the chip): loading, a failed load, a refresh that failed, real data,
// nothing tracked, nothing answered, nothing set up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CardSkeleton from '@/components/board/CardSkeleton.vue'
import { fakeSource, mountCard } from './__fixtures__/harness'
import { ANSWERED, ENGINES, WAITING, cell, failure, overviewPayload, promptRow, visibilityPayload } from './__fixtures__/payloads'

const sources = vi.hoisted(() => ({}))
vi.mock('@/composables/board/useBoardSource', () => ({ useBoardSource: (key) => sources[key] }))

const { default: WatchCard } = await import('../WatchCard.vue')
const { default: AskedAnsweredCard } = await import('../AskedAnsweredCard.vue')
const { default: AnswerRankCard } = await import('../AnswerRankCard.vue')
const { default: VisibilityScoreCard } = await import('../VisibilityScoreCard.vue')

const mounted = []

async function show(component, key, source, options) {
    sources[key] = source
    const wrapper = await mountCard(component, options)
    mounted.push(wrapper)
    return wrapper
}

const texts = (wrapper, selector) => wrapper.findAll(selector).map((el) => el.text())
const stateTitle = (wrapper) => wrapper.find('.wb-state-title').text()
const button = (wrapper, label) => wrapper.findAll('button').find((b) => b.text() === label)
const NO_ENGINES = ENGINES.map((e) => ({ ...e, configured: false }))

beforeEach(() => {
    for (const key of Object.keys(sources)) delete sources[key]
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe.each([
    ['WatchCard', WatchCard, 'overview', 'Watch', overviewPayload],
    ['AskedAnsweredCard', AskedAnsweredCard, 'overview', 'Asked and answered', overviewPayload],
    ['AnswerRankCard', AnswerRankCard, 'overview', 'Rank in AI answers', overviewPayload],
    ['VisibilityScoreCard', VisibilityScoreCard, 'visibility', 'Visibility score', visibilityPayload],
])('%s in every load state', (_name, component, key, title, payload) => {
    it('shows a skeleton and no figure until its source answers', async () => {
        const wrapper = await show(component, key, fakeSource())
        expect(wrapper.findComponent(CardSkeleton).exists()).toBe(true)
        expect(wrapper.text()).toBe('')
        expect(wrapper.find('svg').exists()).toBe(false)
        expect(wrapper.statuses).toEqual(['loading'])
    })

    it('says it could not load, and tries again on request', async () => {
        const source = fakeSource({ failure: failure() })
        const wrapper = await show(component, key, source)
        expect(wrapper.find('[role="alert"]').exists()).toBe(true)
        expect(stateTitle(wrapper)).toBe(`We couldn't load ${title}.`)
        expect(wrapper.text()).not.toMatch(/\d/)
        expect(wrapper.status()).toBe('error')
        await button(wrapper, 'Try again').trigger('click')
        expect(source.reload).toHaveBeenCalledTimes(1)
    })

    it('keeps the last numbers when a refresh fails, and says so', async () => {
        const wrapper = await show(component, key, fakeSource({ data: payload(), failure: failure(), stale: true }))
        expect(wrapper.find('[role="alert"]').exists()).toBe(false)
        expect(wrapper.find('.bd-foot').text()).toContain("Couldn't refresh.")
        expect(wrapper.status()).toBe('stale')
        expect(wrapper.statuses).not.toContain('live')
    })

    it('reports live only once real data is on screen', async () => {
        const source = fakeSource()
        const wrapper = await show(component, key, source)
        expect(wrapper.statuses).not.toContain('live')
        source.data.value = payload()
        await wrapper.vm.$nextTick()
        expect(wrapper.status()).toBe('live')
        expect(wrapper.findComponent(CardSkeleton).exists()).toBe(false)
    })

    it('takes the board props', () => {
        expect(component.props.websiteId.required).toBe(true)
        expect(component.props.size.default).toBe('third')
    })
})

describe('WatchCard', () => {
    it('draws the eye and says what it watches, in real counts', async () => {
        const wrapper = await show(WatchCard, 'overview', fakeSource({ data: overviewPayload() }))
        const eye = wrapper.find('svg.wd-eye')
        expect(eye.attributes('aria-hidden')).toBe('true')
        expect(eye.findAll('.wd-eye-iris')).toHaveLength(1)
        expect(texts(wrapper, '.wd-watch-line span')).toEqual(['3 prompts tracked', '3 of 5 engines'])
        expect(wrapper.find('.wd-watch-facts .sr-only').text()).toBe(
            'Cansee is watching 3 prompts on 3 of 5 AI engines: ChatGPT, Claude and Gemini. Not set up: Grok and Perplexity.',
        )
        expect(wrapper.find('.wd-watch-gaze').text()).toBe('Looking straight ahead')
        expect(wrapper.status()).toBe('live')
        expect(button(wrapper, 'Add prompts')).toBeUndefined()
    })

    it('lists every engine with its state, for the wide card and the panel', async () => {
        const wrapper = await show(WatchCard, 'overview', fakeSource({ data: overviewPayload() }), { props: { size: 'full' }, panel: true })
        expect(texts(wrapper, '.wd-watch-engine')).toEqual(['01ChatGPTSet up', '02ClaudeSet up', '03GeminiSet up', '04GrokNot set up', '05PerplexityNot set up'])
        expect(wrapper.findAll('.wd-watch-engine.is-off')).toHaveLength(2)
        // The words are in the sentence; the list is the drawing's legend.
        expect(wrapper.find('.wd-watch-engines').attributes('aria-hidden')).toBe('true')
    })

    it('says so when nothing is tracked, offers to add a prompt and never reads live', async () => {
        const wrapper = await show(WatchCard, 'overview', fakeSource({ data: overviewPayload({ prompts: [], kpis: { prompts: 0 }, leaderboard: [] }) }))
        expect(wrapper.find('svg.wd-eye').exists()).toBe(true)
        expect(wrapper.find('.wd-watch-line').text()).toContain('No prompts tracked yet')
        expect(wrapper.find('.wd-watch-facts .sr-only').text()).toBe('Nothing is tracked yet.')
        expect(wrapper.status()).toBe('empty')
        expect(wrapper.statuses).not.toContain('live')
        await button(wrapper, 'Add prompts').trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('prompts', { add: '1' })
    })

    it('asks for setup when prompts are tracked and no engine can ask them', async () => {
        const wrapper = await show(WatchCard, 'overview', fakeSource({ data: overviewPayload({ engines: NO_ENGINES }) }))
        expect(texts(wrapper, '.wd-watch-line span')).toEqual(['3 prompts tracked', '0 of 5 engines'])
        expect(wrapper.status()).toBe('setup')
        expect(button(wrapper, 'Add prompts')).toBeUndefined()
    })

    it('leaves the engine count out when the payload lists no engine', async () => {
        const wrapper = await show(WatchCard, 'overview', fakeSource({ data: overviewPayload({ engines: [] }) }))
        expect(texts(wrapper, '.wd-watch-line span')).toEqual(['3 prompts tracked'])
        expect(wrapper.find('.wd-watch-engines').exists()).toBe(false)
    })
})

describe('AskedAnsweredCard', () => {
    it('asks the newest prompt and shows who named you, engine by engine', async () => {
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload() }))
        expect(wrapper.find('.wd-qa-question').text()).toBe('Which tools should a small team shortlist?')
        expect(texts(wrapper, '.wd-qa-engine')).toEqual(['ChatGPT', 'Claude', 'Gemini'])
        expect(texts(wrapper, '.wd-qa-value')).toEqual(['#2', 'Not named', '#4'])
        expect(texts(wrapper, '.wd-qa-row > .sr-only')).toEqual([
            'ChatGPT named you, at number 2 of the brands in its answer.',
            'Claude did not name you.',
            'Gemini named you, at number 4 of the brands in its answer.',
        ])
        expect(wrapper.find('.wd-qa-label .cs-label--signal').text()).toBe('You in 2 of 3')
        expect(wrapper.find('.wd-qa-part:last-child > .sr-only').text()).toBe('ChatGPT and Gemini named you. Claude did not.')
        expect(wrapper.find('.bd-foot').text()).toBe('Your newest prompt. Latest answers.')
        expect(wrapper.status()).toBe('live')
    })

    it('paints the accent only where an answer named you, and tags it once', async () => {
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload() }))
        const rows = wrapper.findAll('.wd-qa-row')
        expect(rows.map((row) => row.find('.wd-qa-you').exists())).toEqual([true, false, true])
        expect(rows.map((row) => row.classes().find((c) => c.startsWith('is-')))).toEqual(['is-named', 'is-absent', 'is-named'])
        expect(texts(wrapper, '.wd-qa-tag')).toEqual(['You'])
        const [second, fourth] = wrapper.findAll('.wd-qa-you').map((el) => parseFloat(el.element.style.left))
        expect(second).toBeLessThan(fourth)
        // The bars are a drawing: the sentences carry the facts.
        for (const track of wrapper.findAll('.wd-qa-track')) expect(track.attributes('aria-hidden')).toBe('true')
    })

    it('opens the prompt from the question, with the keyboard too', async () => {
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload() }))
        const open = wrapper.find('.wd-qa-question button')
        expect(open.attributes('type')).toBe('button')
        await open.trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('prompts', { prompt: 'p3' })
    })

    it('shows the location only when the prompt has one', async () => {
        const local = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload() }))
        expect(local.find('.wd-qa-label').text()).toBe('AskedLocation US')
        const global = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload({ prompts: [promptRow('p9', 'q', ANSWERED, { location: '' })] }) }))
        expect(global.find('.wd-qa-label').text()).toBe('Asked')
    })

    it('steps back to the newest prompt with answers and says which it is', async () => {
        const prompts = [promptRow('p1', 'older question'), promptRow('p2', 'brand new question', WAITING)]
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload({ prompts }) }))
        expect(wrapper.find('.wd-qa-question').text()).toBe('older question')
        expect(wrapper.find('.bd-foot').text()).toBe('Your newest prompt with answers.')
        expect(wrapper.status()).toBe('live')
    })

    it('shows the question and waits when no engine has answered, without reading live', async () => {
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload({ prompts: [promptRow('p1', 'a new question', WAITING)] }) }))
        expect(wrapper.find('.wd-qa-question').text()).toBe('a new question')
        expect(wrapper.find('.wd-qa-gap').text()).toBe('No engine has answered this yet. Answers arrive with the next run.')
        expect(wrapper.find('.wd-qa-rows').exists()).toBe(false)
        expect(wrapper.find('.wd-qa-you').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('You in')
        expect(wrapper.find('.bd-foot').exists()).toBe(false)
        expect(wrapper.status()).toBe('empty')
        expect(wrapper.statuses).not.toContain('live')
    })

    it('shows a hairline for an engine that is still to answer', async () => {
        const engines = { ...ANSWERED, gemini: cell({ answers: 0 }) }
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload({ prompts: [promptRow('p1', 'q', engines)] }) }))
        expect(texts(wrapper, '.wd-qa-value')).toEqual(['#2', 'Not named', 'No answer yet'])
        expect(wrapper.findAll('.wd-qa-row')[2].classes()).toContain('is-waiting')
        expect(wrapper.find('.wd-qa-label .cs-label--signal').text()).toBe('You in 1 of 2')
    })

    it('asks for setup when no engine is set up', async () => {
        const off = Object.fromEntries(ENGINES.map((e) => [e.key, cell({ configured: false, answers: 0 })]))
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload({ engines: NO_ENGINES, prompts: [promptRow('p1', 'q', off)] }) }))
        expect(wrapper.find('.wd-qa-gap').text()).toBe('No AI engine is set up to answer yet.')
        expect(wrapper.status()).toBe('setup')
    })

    it('asks for a prompt when none is tracked', async () => {
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload({ prompts: [], leaderboard: [] }) }))
        expect(stateTitle(wrapper)).toBe('Track a prompt first.')
        expect(wrapper.find('.wd-qa').exists()).toBe(false)
        expect(wrapper.status()).toBe('empty')
        await button(wrapper, 'Add prompts').trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('prompts', { add: '1' })
    })

    it('keeps a very long question whole for the reader and the screen reader', async () => {
        const long = `${'which project tool is best for a team that '.repeat(8)}ships weekly?`
        const wrapper = await show(AskedAnsweredCard, 'overview', fakeSource({ data: overviewPayload({ prompts: [promptRow('p1', long)] }) }))
        expect(wrapper.find('.wd-qa-question button').text()).toBe(long)
    })
})

describe('AnswerRankCard', () => {
    it('numbers the brands AI names and marks your row', async () => {
        const wrapper = await show(AnswerRankCard, 'overview', fakeSource({ data: overviewPayload() }))
        expect(texts(wrapper, '.wd-rank-index')).toEqual(['01', '02', '03', '04', '05', ''])
        expect(texts(wrapper, '.wd-rank-name')).toEqual(['Evernote', 'Obsidian', 'Coda', 'You', 'Bear', 'Roam'])
        expect(texts(wrapper, '.wd-rank-value')).toEqual(['62%', '50%', '38%', '25%', '13%', 'Not named'])
        const you = wrapper.findAll('.wd-rank-row.is-you')
        expect(you).toHaveLength(1)
        expect(you[0].find('.cs-mark').exists()).toBe(true)
        expect(wrapper.findAll('.cs-mark')).toHaveLength(1)
        expect(you[0].find('.wd-rank-name').attributes('title')).toBe('Notion')
        expect(wrapper.find('.bd-foot').text()).toBe("Each prompt's latest answers.")
        expect(wrapper.status()).toBe('live')
    })

    it('sizes each bar by its share of the leader, and draws none for a brand that was not named', async () => {
        const wrapper = await show(AnswerRankCard, 'overview', fakeSource({ data: overviewPayload() }))
        const widths = wrapper.findAll('.wd-rank-bar').map((bar) => parseFloat(bar.element.style.width))
        expect(widths).toHaveLength(5)
        expect(widths[0]).toBe(100)
        expect(widths[3]).toBeCloseTo((25 / 62) * 100, 3)
        expect([...widths].sort((a, b) => b - a)).toEqual(widths)
        expect(wrapper.findAll('.wd-rank-row').at(-1).classes()).toContain('is-unplaced')
    })

    it('says the same in words for screen readers', async () => {
        const wrapper = await show(AnswerRankCard, 'overview', fakeSource({ data: overviewPayload() }))
        expect(wrapper.find('.wd-rank > .sr-only').text()).toBe('You are number 4 of the brands AI names.')
        expect(texts(wrapper, '.wd-rank-row > .sr-only').slice(3, 6)).toEqual([
            'Number 4: Notion (you), named in 25% of answers.',
            'Number 5: Bear, named in 13% of answers.',
            'Roam: not named in these answers.',
        ])
        expect(wrapper.find('ol').attributes('aria-label')).toBe('Brands AI names, in order')
        for (const el of wrapper.findAll('.wd-rank-track, .wd-rank-index, .wd-rank-name, .wd-rank-value')) expect(el.attributes('aria-hidden')).toBe('true')
    })

    it('gives you the last row, with your real place, when you rank below the rows shown', async () => {
        const leaderboard = [
            ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name, i) => ({ name, is_you: false, visibility_pct: 90 - i * 10 })),
            { name: 'Notion', is_you: true, visibility_pct: 20 },
        ]
        const wrapper = await show(AnswerRankCard, 'overview', fakeSource({ data: overviewPayload({ leaderboard }) }))
        expect(texts(wrapper, '.wd-rank-name')).toEqual(['A', 'B', 'C', 'D', 'E', 'You'])
        expect(texts(wrapper, '.wd-rank-index').at(-1)).toBe('08')
    })

    it('shows no movement: the overview carries no earlier ranking', async () => {
        const wrapper = await show(AnswerRankCard, 'overview', fakeSource({ data: overviewPayload() }))
        expect(wrapper.text()).not.toMatch(/\b(up|down|new)\b/i)
        expect(wrapper.find('.cs-label--signal').exists()).toBe(false)
    })

    it('asks for a prompt, or waits for answers, without a figure', async () => {
        const none = await show(AnswerRankCard, 'overview', fakeSource({ data: overviewPayload({ prompts: [], leaderboard: [] }) }))
        expect(stateTitle(none)).toBe('Track a prompt first.')
        expect(none.status()).toBe('empty')
        const waiting = await show(AnswerRankCard, 'overview', fakeSource({ data: overviewPayload({ leaderboard: [] }) }))
        expect(stateTitle(waiting)).toBe('Brands appear here once the engines have answered your prompts.')
        expect(waiting.text()).not.toMatch(/\d/)
        expect(waiting.find('.wd-rank').exists()).toBe(false)
        expect(waiting.status()).toBe('empty')
        expect(waiting.statuses).not.toContain('live')
    })
})

describe('VisibilityScoreCard', () => {
    it('shows the dashboard headline as one number, with its unit and its change', async () => {
        const wrapper = await show(VisibilityScoreCard, 'visibility', fakeSource({ data: visibilityPayload() }))
        expect(wrapper.find('.wd-score-num').text()).toBe('34')
        expect(wrapper.find('.wd-score-unit').text()).toBe('% of answers')
        expect(wrapper.find('.wd-score-change').text()).toBe('+4.1 pts vs previous 30 days')
        expect(texts(wrapper, '.wd-score-axis span')).toEqual(['Nov 01', 'Last 30 days', 'Nov 05'])
        expect(wrapper.status()).toBe('live')
    })

    it('draws the daily line and ends it in the one accent dot', async () => {
        const wrapper = await show(VisibilityScoreCard, 'visibility', fakeSource({ data: visibilityPayload() }))
        expect(wrapper.findAll('.wd-score-line').map((p) => p.attributes('d'))).toEqual(['M0 75 L25 50 L50 0 L75 25 L100 50'])
        const end = wrapper.findAll('.wd-score-end')
        expect(end).toHaveLength(1)
        expect(end[0].element.style.left).toBe('100%')
        expect(end[0].element.style.top).toBe('50%')
        expect(wrapper.find('.wd-score-chart').attributes('aria-hidden')).toBe('true')
        expect(wrapper.find('.wd-score-figure').attributes('aria-hidden')).toBe('true')
        expect(wrapper.find('.wd-score > .sr-only').text()).toBe(
            'AI named you in 34% of answers over the last 30 days, up 4.1 points on the period before. Between Nov 01 and Nov 05 it ranged from 10% to 40%; the latest reading is 20% on Nov 05.',
        )
    })

    it('breaks the line where a day has no answers', async () => {
        const data = visibilityPayload({ visibility: { all: { visibility_pct: [10, null, 20, 30, null] } } })
        const wrapper = await show(VisibilityScoreCard, 'visibility', fakeSource({ data }))
        expect(wrapper.findAll('.wd-score-line').map((p) => p.attributes('d'))).toEqual(['M50 33.33 L75 0'])
        expect(wrapper.findAll('.wd-score-single')).toHaveLength(1)
        expect(wrapper.find('.wd-score-end').element.style.left).toBe('75%')
    })

    it('shows the number alone when no day was measured, and no change without an earlier period', async () => {
        const data = visibilityPayload({ headline: { visibility_pct: 6.5, visibility_prev_pct: null }, visibility: { all: { visibility_pct: [] } } })
        const wrapper = await show(VisibilityScoreCard, 'visibility', fakeSource({ data }))
        expect(wrapper.find('.wd-score-num').text()).toBe('6.5')
        expect(wrapper.find('.wd-score-change').exists()).toBe(false)
        expect(wrapper.find('.wd-score-plot').exists()).toBe(false)
        expect(wrapper.find('.wd-score-end').exists()).toBe(false)
        expect(texts(wrapper, '.wd-score-axis span')).toEqual(['', 'Last 30 days', ''])
        expect(wrapper.status()).toBe('live')
    })

    it('sets a three-character figure smaller, so the unit stays beside it', async () => {
        const wide = async (visibility_pct) => {
            const wrapper = await show(VisibilityScoreCard, 'visibility', fakeSource({ data: visibilityPayload({ headline: { visibility_pct } }) }))
            return [wrapper.find('.wd-score-num').text(), wrapper.find('.wd-score-num').classes().includes('is-wide')]
        }
        expect(await wide(34.2)).toEqual(['34', false])
        expect(await wide(7)).toEqual(['7', false])
        expect(await wide(100)).toEqual(['100', true])
        expect(await wide(6.5)).toEqual(['6.5', true])
    })

    it('shows a measured zero as 0, not as an empty card', async () => {
        const data = visibilityPayload({ headline: { visibility_pct: 0, visibility_prev_pct: 0 }, visibility: { all: { visibility_pct: [0, 0, 0, 0, 0] } } })
        const wrapper = await show(VisibilityScoreCard, 'visibility', fakeSource({ data }))
        expect(wrapper.find('.wd-score-num').text()).toBe('0')
        expect(wrapper.find('.wd-score-end').element.style.top).toBe('100%')
        expect(wrapper.status()).toBe('live')
    })

    it.each([
        ['no_prompts', 'Track a prompt first.', 'empty'],
        ['no_engines', 'No AI engine is connected yet.', 'setup'],
        ['no_answers', 'No AI answers in the last 30 days.', 'empty'],
    ])('says why there is no number (%s)', async (reason, title, status) => {
        const wrapper = await show(VisibilityScoreCard, 'visibility', fakeSource({ data: visibilityPayload({ has_data: false, empty_reason: reason }) }))
        expect(stateTitle(wrapper)).toBe(title)
        expect(wrapper.find('.wd-score').exists()).toBe(false)
        expect(wrapper.text()).not.toMatch(/\d{2}%|\bpts\b/)
        expect(wrapper.status()).toBe(status)
        expect(wrapper.statuses).not.toContain('live')
    })

    it('never invents a number when the headline has none', async () => {
        const wrapper = await show(VisibilityScoreCard, 'visibility', fakeSource({ data: visibilityPayload({ headline: { answers: 0, visibility_pct: null } }) }))
        expect(stateTitle(wrapper)).toBe('No AI answers in the last 30 days.')
        expect(wrapper.find('.wd-score-num').exists()).toBe(false)
        expect(wrapper.status()).toBe('empty')
    })
})
