import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import BarList from '@/components/board/BarList.vue'
import CardSkeleton from '@/components/board/CardSkeleton.vue'
import { VizChartStub } from '@/pages/__tests__/__fixtures__/vizStub'
import { fakeSource, mountInBoard } from './__fixtures__/harness'
import {
    competitorsPayload,
    crawlerAccessPayload,
    factCheckPayload,
    failure,
    fanOutsPayload,
    notAnalyzedFactCheck,
    overviewPayload,
    pagesPayload,
    productsPayload,
    promptIdeasPayload,
    sentimentPayload,
    visibilityPayload,
} from './__fixtures__/boardPayloads'

// The board's sources, by key; each test sets the ones its card reads.
const sources = vi.hoisted(() => ({}))
vi.mock('@/composables/board/useBoardSource', () => ({ useBoardSource: (key) => sources[key] }))

const { default: VisibilityCard } = await import('../VisibilityCard.vue')
const { default: ByEngineCard } = await import('../ByEngineCard.vue')
const { default: WhoRecommendsCard } = await import('../WhoRecommendsCard.vue')
const { default: ShareOfVoiceCard } = await import('../ShareOfVoiceCard.vue')
const { default: SentimentCard } = await import('../SentimentCard.vue')
const { default: FactCheckCard } = await import('../FactCheckCard.vue')
const { default: CitationsCard } = await import('../CitationsCard.vue')
const { default: CrawlerAccessCard } = await import('../CrawlerAccessCard.vue')
const { default: PagesCard } = await import('../PagesCard.vue')
const { default: FanoutsCard } = await import('../FanoutsCard.vue')
const { default: PromptResearchCard } = await import('../PromptResearchCard.vue')
const { default: CompetitorsCard } = await import('../CompetitorsCard.vue')
const { default: ProductsCard } = await import('../ProductsCard.vue')

const mounted = []

async function mountCard(component, key, source, options = {}) {
    sources[key] = source
    const wrapper = await mountInBoard(component, options)
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
}

const bars = (wrapper) => wrapper.findComponent(BarList).props('items')
const accent = (wrapper) => bars(wrapper).filter((i) => i.emphasis).map((i) => i.key)
const stateTitle = (wrapper) => wrapper.find('.wb-state-title').text()
const foot = (wrapper) => wrapper.find('.bd-foot').text()

beforeEach(() => {
    for (const key of Object.keys(sources)) delete sources[key]
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

// Every card: the skeleton first, the load error with Try again, Insights
// off for the insights sources, and "Couldn't refresh." over the last numbers.
describe.each([
    ['VisibilityCard', VisibilityCard, 'visibility', 'AI visibility over time', visibilityPayload, false],
    ['ByEngineCard', ByEngineCard, 'visibility', 'AI visibility by engine', visibilityPayload, false],
    ['WhoRecommendsCard', WhoRecommendsCard, 'overview', 'Who AI recommends', overviewPayload, false],
    ['ShareOfVoiceCard', ShareOfVoiceCard, 'visibility', 'Share of voice', visibilityPayload, false],
    ['SentimentCard', SentimentCard, 'sentiment', 'Sentiment', sentimentPayload, true],
    ['FactCheckCard', FactCheckCard, 'factCheck', 'Fact check', factCheckPayload, true],
    ['CitationsCard', CitationsCard, 'visibility', 'Citations', visibilityPayload, false],
    ['CrawlerAccessCard', CrawlerAccessCard, 'crawlerAccess', 'Crawler access', crawlerAccessPayload, true],
    ['PagesCard', PagesCard, 'pages', 'Pages', pagesPayload, true],
    ['FanoutsCard', FanoutsCard, 'fanOuts', 'Query fan-outs', fanOutsPayload, true],
    ['PromptResearchCard', PromptResearchCard, 'promptIdeas', 'Prompt research', promptIdeasPayload, true],
    ['CompetitorsCard', CompetitorsCard, 'competitors', 'Competitors', competitorsPayload, true],
    ['ProductsCard', ProductsCard, 'products', 'Products', productsPayload, true],
])('%s, common states', (_name, component, key, title, payload, insights) => {
    it('shows a skeleton until the source first answers', async () => {
        const wrapper = await mountCard(component, key, fakeSource())
        expect(wrapper.findComponent(CardSkeleton).exists()).toBe(true)
        expect(wrapper.find('.wb-state').exists()).toBe(false)
    })

    it('says it could not load, and Try again reloads the source', async () => {
        const source = fakeSource({ failure: failure(500) })
        const wrapper = await mountCard(component, key, source)
        expect(stateTitle(wrapper)).toBe(`We couldn't load ${title}.`)
        expect(wrapper.find('.wb-state').attributes('role')).toBe('alert')
        await wrapper.find('.wb-state button').trigger('click')
        expect(source.reload).toHaveBeenCalledTimes(1)
    })

    if (insights) {
        it('says when Insights are turned off on the server', async () => {
            const wrapper = await mountCard(component, key, fakeSource({ failure: failure(503, 'insights_disabled') }))
            expect(stateTitle(wrapper)).toBe('Insights are turned off on this server.')
            expect(wrapper.find('.wb-state button').exists()).toBe(false)
        })
    }

    it("keeps the last numbers when a refetch fails, with Couldn't refresh. in the foot", async () => {
        const wrapper = await mountCard(component, key, fakeSource({ data: payload(), failure: failure(500), stale: true }))
        expect(wrapper.find('.wb-state').exists()).toBe(false)
        expect(foot(wrapper)).toContain("Couldn't refresh.")
    })
})

describe('VisibilityCard', () => {
    it('shows the visibility tile with its change and one accent line for every engine', async () => {
        const wrapper = await mountCard(VisibilityCard, 'visibility', fakeSource({ data: visibilityPayload() }), {
            props: { size: 'half' },
        })
        const tile = wrapper.find('.viz-stat').text()
        expect(tile).toContain('AI visibility')
        expect(tile).toContain('34%')
        expect(tile).toContain('+4.1 pts vs previous 30 days')
        expect(wrapper.find('.viz-stat-dot').exists()).toBe(false)
        const chart = wrapper.findComponent(VizChartStub)
        expect(chart.props('spec')).toMatchObject({ id: 'board.visibility', palette: 'emphasis', emphasis: 'all' })
        expect(chart.props('compact')).toBe(true)
        expect(chart.props('height')).toBe(120)
        expect(chart.attributes('hide-switcher')).toBeDefined()
        expect(foot(wrapper)).toBe('Last 30 days.')
    })

    it('draws a taller line at full width', async () => {
        const wrapper = await mountCard(VisibilityCard, 'visibility', fakeSource({ data: visibilityPayload() }), {
            props: { size: 'full' },
        })
        expect(wrapper.findComponent(VizChartStub).props('height')).toBe(160)
    })

    it('asks for a prompt first, and Add prompts opens Prompts with its dialog', async () => {
        const wrapper = await mountCard(
            VisibilityCard,
            'visibility',
            fakeSource({ data: visibilityPayload({ has_data: false, empty_reason: 'no_prompts' }) }),
        )
        expect(stateTitle(wrapper)).toBe('Track a prompt first.')
        await wrapper.find('.wb-state button').trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('prompts', { add: '1' })
        expect(wrapper.find('.bd-foot').exists()).toBe(false)
    })

    it.each([
        ['no_engines', 'No AI engine is connected yet.'],
        ['no_answers', 'No AI answers in the last 30 days.'],
    ])('reads the %s state without an action', async (reason, title) => {
        const wrapper = await mountCard(
            VisibilityCard,
            'visibility',
            fakeSource({ data: visibilityPayload({ has_data: false, empty_reason: reason }) }),
        )
        expect(stateTitle(wrapper)).toBe(title)
        expect(wrapper.find('.wb-state button').exists()).toBe(false)
        expect(wrapper.findComponent(VizChartStub).exists()).toBe(false)
    })
})

describe('ByEngineCard', () => {
    it('lists each engine as the accent on a 100% scale, a measured 0% as 0%', async () => {
        const wrapper = await mountCard(ByEngineCard, 'visibility', fakeSource({ data: visibilityPayload() }))
        const list = wrapper.findComponent(BarList)
        expect(list.props('max')).toBe(100)
        expect(bars(wrapper).map((i) => [i.label, i.text])).toEqual([
            ['ChatGPT', '40%'],
            ['Claude', '0%'],
        ])
        expect(accent(wrapper)).toEqual(['chatgpt', 'claude'])
        // No listener: the rows are not buttons.
        expect(wrapper.find('.bd-bars button').exists()).toBe(false)
    })

    it('asks for a prompt first', async () => {
        const wrapper = await mountCard(
            ByEngineCard,
            'visibility',
            fakeSource({ data: visibilityPayload({ has_data: false, empty_reason: 'no_prompts' }) }),
        )
        expect(stateTitle(wrapper)).toBe('Track a prompt first.')
    })
})

describe('WhoRecommendsCard', () => {
    it('lists the top five brands with you as the only accent', async () => {
        const wrapper = await mountCard(WhoRecommendsCard, 'overview', fakeSource({ data: overviewPayload() }))
        expect(bars(wrapper).map((i) => i.label)).toEqual(['Evernote', 'Obsidian', 'Coda', 'Notion', 'Bear'])
        expect(accent(wrapper)).toEqual(['Notion'])
        expect(wrapper.findComponent(BarList).props('max')).toBe(100)
    })

    it('says brands appear once the engines answer', async () => {
        const wrapper = await mountCard(WhoRecommendsCard, 'overview', fakeSource({ data: overviewPayload({ leaderboard: [] }) }))
        expect(stateTitle(wrapper)).toBe('Brands appear here once the engines have answered your prompts.')
    })

    it('asks for a prompt first when none is tracked', async () => {
        const wrapper = await mountCard(
            WhoRecommendsCard,
            'overview',
            fakeSource({ data: overviewPayload({ prompts: [], leaderboard: [] }) }),
        )
        expect(stateTitle(wrapper)).toBe('Track a prompt first.')
        await wrapper.find('.wb-state button').trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('prompts', { add: '1' })
    })
})

describe('ShareOfVoiceCard', () => {
    it('shows your share with its change and the four largest shares, you as the accent', async () => {
        const wrapper = await mountCard(ShareOfVoiceCard, 'visibility', fakeSource({ data: visibilityPayload() }))
        const tile = wrapper.find('.viz-stat').text()
        expect(tile).toContain('Share of voice')
        expect(tile).toContain('18%')
        expect(tile).toContain('+3.2 pts vs previous 30 days')
        expect(bars(wrapper)).toHaveLength(4)
        expect(accent(wrapper)).toEqual(['you'])
    })

    it('says when no brand was named', async () => {
        const payload = visibilityPayload()
        payload.share_of_voice.brands = payload.share_of_voice.brands.map((b) => ({ ...b, mentions: 0, share_pct: null }))
        payload.headline.share_of_voice_pct = null
        const wrapper = await mountCard(ShareOfVoiceCard, 'visibility', fakeSource({ data: payload }))
        expect(wrapper.find('.viz-stat').text()).toContain('No brands named')
        expect(wrapper.find('.wb-note').text()).toBe('No brand was named in these answers.')
        expect(wrapper.findComponent(BarList).exists()).toBe(false)
    })
})

describe('SentimentCard', () => {
    it('counts the answers that name you, their tones in gray and the most repeated theme', async () => {
        const wrapper = await mountCard(SentimentCard, 'sentiment', fakeSource({ data: sentimentPayload() }))
        expect(wrapper.find('.viz-stat').text()).toContain('Answers that name you52')
        expect(bars(wrapper).map((i) => [i.label, i.text])).toEqual([
            ['Positive', '30'],
            ['Neutral', '15'],
            ['Negative', '0'],
        ])
        expect(accent(wrapper)).toEqual([])
        expect(wrapper.find('.wb-line').text()).toBe('Most repeated: "easy to set up" (positive, 9 answers)')
    })

    it("says when the engines didn't name you", async () => {
        const wrapper = await mountCard(SentimentCard, 'sentiment', fakeSource({ data: sentimentPayload({ empty_reason: 'no_answers' }) }))
        expect(stateTitle(wrapper)).toBe("The engines didn't name you in the last 30 days.")
        expect(wrapper.findComponent(BarList).exists()).toBe(false)
    })

    it('keeps the stored tones before any analysis and offers Analyze answers in the panel', async () => {
        const payload = sentimentPayload({ coverage: { named_answers: 52, analyzed: 0, not_analyzed: 52, failed: 0 }, themes: [] })
        const wrapper = await mountCard(SentimentCard, 'sentiment', fakeSource({ data: payload }))
        expect(bars(wrapper)).toHaveLength(3)
        expect(stateTitle(wrapper)).toBe('No answers analyzed yet.')
        await wrapper.find('.wb-state button').trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('sentiment')
    })

    it('says when the analyzed answers repeat no theme', async () => {
        const wrapper = await mountCard(SentimentCard, 'sentiment', fakeSource({ data: sentimentPayload({ themes: [] }) }))
        expect(wrapper.find('.wb-line').text()).toBe("The analyzed answers don't describe you in a way that repeats.")
    })
})

describe('FactCheckCard', () => {
    it('counts claims checked and by verdict in gray, with the top contradicted claim', async () => {
        const wrapper = await mountCard(FactCheckCard, 'factCheck', fakeSource({ data: factCheckPayload() }))
        expect(wrapper.find('.viz-stat').text()).toContain('Claims checked55')
        expect(bars(wrapper).map((i) => i.label)).toEqual(['Contradicted', 'Not verifiable', 'Supported', 'Not checked'])
        expect(accent(wrapper)).toEqual([])
        expect(wrapper.find('.wb-line').text()).toBe('Contradicted: "Notion\'s Plus plan costs $8 per user per month"')
    })

    it('offers Analyze answers in the panel before any analysis', async () => {
        const wrapper = await mountCard(FactCheckCard, 'factCheck', fakeSource({ data: notAnalyzedFactCheck() }))
        expect(stateTitle(wrapper)).toBe('No answers analyzed yet.')
        expect(wrapper.find('.viz-stat').exists()).toBe(false)
        await wrapper.find('.wb-state button').trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('fact-check')
    })

    it.each([
        ['no_answers', "The engines didn't name you in the last 30 days."],
        ['no_claims', 'The analyzed answers make no checkable claims about you.'],
    ])('reads the %s state', async (reason, title) => {
        const wrapper = await mountCard(FactCheckCard, 'factCheck', fakeSource({ data: factCheckPayload({ empty_reason: reason }) }))
        expect(stateTitle(wrapper)).toBe(title)
        expect(wrapper.find('.wb-state button').exists()).toBe(false)
    })
})

describe('CitationsCard', () => {
    it('says how many citations point to your site, with the five top domains', async () => {
        const wrapper = await mountCard(CitationsCard, 'visibility', fakeSource({ data: visibilityPayload() }))
        expect(wrapper.find('.wb-sentence').text()).toBe('12 of 340 citations point to your site')
        expect(bars(wrapper)).toHaveLength(5)
        expect(accent(wrapper)).toEqual(['notion.so'])
    })

    it('says when no cited source was recorded', async () => {
        const payload = visibilityPayload({ citations: { has_data: false, totals: null, series: {}, top_domains: [] } })
        const wrapper = await mountCard(CitationsCard, 'visibility', fakeSource({ data: payload }))
        expect(stateTitle(wrapper)).toBe('No cited sources yet.')
        expect(wrapper.find('.wb-state-body').text()).toBe('Engines that answer without sources leave this empty.')
    })
})

describe('CrawlerAccessCard', () => {
    it('reads three lines from the latest audit, with when it ran', async () => {
        const wrapper = await mountCard(CrawlerAccessCard, 'crawlerAccess', fakeSource({ data: crawlerAccessPayload() }))
        expect(wrapper.findAll('.wb-lines-row').map((r) => r.text())).toEqual([
            'AI search bots allowed2 of 3',
            'robots.txtFound',
            'llms.txtMissing',
        ])
        expect(foot(wrapper)).toMatch(/^Last audited .+\.$/)
    })

    it('offers an audit in the panel before the first one', async () => {
        const wrapper = await mountCard(CrawlerAccessCard, 'crawlerAccess', fakeSource({ data: crawlerAccessPayload({ you: null }) }))
        expect(stateTitle(wrapper)).toBe('No audit yet.')
        const button = wrapper.find('.wb-state button')
        expect(button.text()).toBe('Run an audit')
        await button.trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('crawler-access')
    })
})

describe('PagesCard', () => {
    it('lists your five most cited pages, all of them the accent', async () => {
        const wrapper = await mountCard(PagesCard, 'pages', fakeSource({ data: pagesPayload() }))
        expect(bars(wrapper).map((i) => [i.label, i.text])).toEqual([
            ['/ai', '9 citations'],
            ['/pricing', '6 citations'],
            ['/docs', '3 citations'],
            ['/', '2 citations'],
            ['/blog/x', '1 citation'],
        ])
        expect(bars(wrapper).every((i) => i.emphasis)).toBe(true)
    })

    it('says when no page was measured', async () => {
        const wrapper = await mountCard(PagesCard, 'pages', fakeSource({ data: pagesPayload({ pages: [] }) }))
        expect(stateTitle(wrapper)).toBe('No pages measured yet.')
    })
})

describe('FanoutsCard', () => {
    it('counts the searches run and lists three with their Google place', async () => {
        const wrapper = await mountCard(FanoutsCard, 'fanOuts', fakeSource({ data: fanOutsPayload() }))
        expect(wrapper.find('.viz-stat').text()).toContain('Searches run61')
        expect(wrapper.find('.wb-lines-head').text()).toBe('SearchGoogle')
        expect(wrapper.findAll('.wb-lines-row').map((r) => r.text())).toEqual([
            'best note apps 2026#4',
            'notion pricing for teamsNot checked',
            'evernote vs notionNot on page one',
        ])
    })

    it.each([
        ['web_search_off', "The engines aren't searching the web on this server."],
        ['none_recorded', 'No searches recorded yet.'],
        ['no_answers', 'No AI answers in the last 30 days.'],
    ])('reads the %s copy without an action', async (reason, title) => {
        const wrapper = await mountCard(FanoutsCard, 'fanOuts', fakeSource({ data: fanOutsPayload({ empty_reason: reason }) }))
        expect(stateTitle(wrapper)).toBe(title)
        expect(wrapper.find('.wb-state button').exists()).toBe(false)
        expect(wrapper.find('.wb-state a').exists()).toBe(false)
    })
})

describe('PromptResearchCard', () => {
    it('counts the new ideas and lists three with their sources', async () => {
        const wrapper = await mountCard(PromptResearchCard, 'promptIdeas', fakeSource({ data: promptIdeasPayload() }))
        expect(wrapper.find('.viz-stat').text()).toContain('New ideas20')
        expect(wrapper.findAll('.wb-lines-row')).toHaveLength(3)
        expect(wrapper.find('.wb-lines-row').text()).toBe('is notion free for teamsPeople also ask, Engine search')
    })

    it('offers Find ideas in the panel when there is none yet', async () => {
        const payload = promptIdeasPayload({ counts: { new: 0, tracked: 0, dismissed: 0, by_source: {} }, ideas: [] })
        const wrapper = await mountCard(PromptResearchCard, 'promptIdeas', fakeSource({ data: payload }))
        expect(stateTitle(wrapper)).toBe('No ideas yet.')
        const button = wrapper.find('.wb-state button')
        expect(button.text()).toBe('Find ideas')
        await button.trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('prompt-research')
    })
})

describe('CompetitorsCard', () => {
    it('shows the AI visibility of each brand, you as the only accent', async () => {
        const wrapper = await mountCard(CompetitorsCard, 'competitors', fakeSource({ data: competitorsPayload() }))
        expect(bars(wrapper).map((i) => [i.label, i.text])).toEqual([
            ['Notion', '33%'],
            ['Evernote', '42%'],
            ['Obsidian', '0%'],
        ])
        expect(accent(wrapper)).toEqual(['you'])
        expect(wrapper.findComponent(BarList).props('max')).toBe(100)
    })

    it('links to project settings when no competitor is tracked', async () => {
        const wrapper = await mountCard(
            CompetitorsCard,
            'competitors',
            fakeSource({ data: competitorsPayload({ empty_reason: 'no_competitors' }) }),
        )
        expect(stateTitle(wrapper)).toBe("You aren't tracking any competitors yet.")
        const link = wrapper.find('.wb-state a')
        expect(link.text()).toBe('Open project settings')
        expect(link.attributes('href')).toBe('/settings/project')
    })
})

describe('ProductsCard', () => {
    it('counts the products and reads each one in Google Shopping', async () => {
        const wrapper = await mountCard(ProductsCard, 'products', fakeSource({ data: productsPayload() }))
        expect(wrapper.find('.viz-stat').text()).toContain('Products3')
        expect(wrapper.find('.wb-lines-head').text()).toBe('ProductGoogle Shopping')
        expect(wrapper.findAll('.wb-lines-row').map((r) => r.text())).toEqual([
            'Acme X200 running shoe#3 of 40 results',
            'Acme trail sockNot in the 40 results',
            'Acme rain jacketNot checked yet',
        ])
        expect(wrapper.find('.bd-foot').exists()).toBe(false)
    })

    it('offers Add a product in the panel when none is tracked', async () => {
        const wrapper = await mountCard(ProductsCard, 'products', fakeSource({ data: productsPayload({ products: [] }) }))
        expect(stateTitle(wrapper)).toBe('No products tracked yet.')
        await wrapper.find('.wb-state button').trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('products')
    })

    it('says when Google Shopping is not configured', async () => {
        const payload = productsPayload({ shopping: { configured: false, provider_label: '', credits_per_page: 0 } })
        const wrapper = await mountCard(ProductsCard, 'products', fakeSource({ data: payload }))
        expect(foot(wrapper)).toBe('Google Shopping results need ScraperAPI on this server. Engine answers still work.')
    })
})
