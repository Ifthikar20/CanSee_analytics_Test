import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT, IN_PANEL } from '@/lib/board/context'
import { VizChartStub } from '@/pages/__tests__/__fixtures__/vizStub'
import { fakeBoard } from './__fixtures__/harness'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const insights = vi.hoisted(() => ({ citations: vi.fn() }))

vi.mock('@/api/client', () => ({ default: client, authHeaders: () => ({}), refreshAccessToken: async () => '' }))
vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/lib/agent/askAgent', () => ({ askAgent: vi.fn(async () => true) }))

const { default: CitationsPanel } = await import('../CitationsPanel.vue')
const { default: SourcesUrlDetailPage } = await import('@/pages/SourcesUrlDetailPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

const URLS = {
    period_start: '2026-11-01',
    period_end: '2026-11-03',
    total_retrievals: 0,
    unique_urls: 0,
    topics: [],
    overview: { labels: [], series: [] },
    movers: { Top: [], New: [], Trending: [], Losing: [] },
    url_types: [],
    urls: [],
    traffic_summary: null,
    opportunities: null,
}

const DETAIL = {
    metrics: { title: 'Best note apps', url: 'https://www.g2.com/best-note-apps', url_type: 'Listicle', domain_type: 'Reference' },
    real_traffic: null,
    brands_mentioned: [],
    chats: [],
    prompts: [],
    retrievals_over_time: { labels: [], current: [], previous: [] },
    retrievals_by_model: [],
}

async function mountWith(component, path, { panel = true, board = fakeBoard() } = {}) {
    setActivePinia(createPinia())
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/dashboard', name: 'dashboard', component: Blank },
            { path: '/settings/connections', component: Blank },
            { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
            { path: '/projects/:websiteId/sources', name: 'sources-urls', component: Blank },
            { path: '/projects/:websiteId/sources/detail', name: 'sources-url-detail', component: Blank },
        ],
    })
    await router.push(path)
    await router.isReady()
    const provide = panel ? { [IN_PANEL]: true, [BOARD_CONTEXT]: board } : {}
    const wrapper = mount(component, {
        props: component === CitationsPanel ? { websiteId: 'w1' } : {},
        global: { plugins: [router], provide, stubs: { VizChart: VizChartStub, MetricInfo: true } },
        attachTo: document.body,
    })
    mounted.push(wrapper)
    await flushPromises()
    wrapper.router = router
    wrapper.board = board
    return wrapper
}

beforeEach(() => {
    client.get.mockReset()
    client.get.mockImplementation(async (url) => ({ data: url.endsWith('/urls/detail/') ? DETAIL : URLS }))
    insights.citations.mockReset()
    insights.citations.mockResolvedValue({ data: { has_data: false, totals: null, by_class: [], by_engine: [], your_pages: [], competitor_pages: [], gaps: [] } })
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe('CitationsPanel', () => {
    it('shows the sources list without its breadcrumb while no URL is named', async () => {
        const wrapper = await mountWith(CitationsPanel, '/projects/w1/analytics?widget=citations')
        expect(wrapper.text()).toContain('AI answer sources')
        expect(wrapper.text()).not.toContain('SourcesURLs')
        expect(client.get).toHaveBeenCalledWith('/citations/websites/w1/urls/', expect.anything())
    })

    it("shows a URL's detail with a way back to every citation, keeping the list's filters", async () => {
        const wrapper = await mountWith(
            CitationsPanel,
            '/projects/w1/analytics?widget=citations&url=g2.com%2Fbest-note-apps&topic=Pricing&provider=claude',
        )
        expect(client.get).toHaveBeenCalledWith('/citations/websites/w1/urls/detail/', {
            params: { url: 'g2.com/best-note-apps', topic: 'Pricing', provider: 'claude' },
            _silentError: true,
        })
        // The breadcrumb became the way back.
        expect(wrapper.text()).not.toContain('SourcesURLs')
        const back = wrapper.findAll('a').find((a) => a.text() === 'All citations')
        expect(back.attributes('href')).toBe('/projects/w1/analytics?topic=Pricing&provider=claude&widget=citations')
        await back.trigger('click')
        expect(wrapper.board.open).toHaveBeenCalledWith('citations', { topic: 'Pricing', provider: 'claude' })
    })

    it('follows the panel query between the list and a detail', async () => {
        const wrapper = await mountWith(CitationsPanel, '/projects/w1/analytics?widget=citations&url=g2.com%2Fbest-note-apps')
        expect(wrapper.text()).toContain('All citations')
        await wrapper.router.replace({ query: { widget: 'citations' } })
        await flushPromises()
        expect(wrapper.text()).not.toContain('All citations')
        expect(wrapper.text()).toContain('AI answer sources')
    })
})

describe('SourcesUrlDetailPage on its own', () => {
    it('keeps its Sources > URLs breadcrumb, whose URLs goes back to the list route', async () => {
        const wrapper = await mountWith(SourcesUrlDetailPage, '/projects/w1/sources/detail?url=g2.com%2Fbest-note-apps', {
            panel: false,
        })
        expect(wrapper.text()).toContain('SourcesURLsBest note apps')
        expect(wrapper.text()).not.toContain('All citations')
        await wrapper.findAll('button').find((b) => b.text() === 'URLs').trigger('click')
        await flushPromises()
        expect(wrapper.router.currentRoute.value.name).toBe('sources-urls')
    })
})
