// Test fixtures only. What a group B card needs around it in a spec: the
// board's context (BOARD_CONTEXT with fake open and close), a router with
// the routes the cards link to, and fake board sources in place of
// useBoardSource (the spec mocks '@/composables/board/useBoardSource' with
// `boardSourceMock` and sets `sources[key]` before mounting).
import { computed, defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'
import { BOARD_CONTEXT, IN_PANEL } from '@/lib/board/context'
import { VizChartStub } from '@/pages/__tests__/__fixtures__/vizStub'

const Blank = defineComponent({ render: () => h('div') })

/** A source as useBoardSource returns it: {data, loading, error, failure, stale, reload}. */
export function fakeSource({ data = null, failure = null, stale = false } = {}) {
    const failed = ref(failure)
    const isStale = ref(stale)
    return {
        data: ref(data),
        loading: ref(false),
        failure: failed,
        error: computed(() => (failed.value ? failed.value.message || 'error' : '')),
        stale: computed(() => isStale.value),
        reload: vi.fn(),
    }
}

/** The board's context with spies for open and close. */
export function fakeBoard(websiteId = 'w1') {
    return {
        websiteId: computed(() => websiteId),
        open: vi.fn(),
        close: vi.fn(),
        invalidate: vi.fn(),
        revalidate: vi.fn(),
    }
}

export function testRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/', component: Blank },
            { path: '/dashboard', name: 'dashboard', component: Blank },
            { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
            { path: '/projects/:websiteId/competitors', name: 'competitors', component: Blank },
            { path: '/settings/project', name: 'settings-project', component: Blank },
        ],
    })
}

/**
 * Mount a card (or panel) inside a fake board. `panel` also provides
 * IN_PANEL. Returns the wrapper, with `board` and `router` on it.
 */
export async function mountInBoard(component, { props = {}, board = fakeBoard(), panel = false, path = '/projects/w1/analytics' } = {}) {
    const router = testRouter()
    await router.push(path)
    await router.isReady()
    const provide = { [BOARD_CONTEXT]: board }
    if (panel) provide[IN_PANEL] = true
    const wrapper = mount(component, {
        props: { websiteId: 'w1', ...props },
        global: { plugins: [router], provide, stubs: { VizChart: VizChartStub } },
        attachTo: document.body,
    })
    wrapper.board = board
    wrapper.router = router
    return wrapper
}
