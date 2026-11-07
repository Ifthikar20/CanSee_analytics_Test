// Test fixtures only. A stand-in for useBoardSource (its frozen return
// shape, board_ownership.md 2), driven per source key by the spec; a fake
// board context to provide as BOARD_CONTEXT, with spies for open, close and
// invalidate; and a mount helper with a router that has the routes group C
// links to.
import { computed, defineComponent, h, reactive } from 'vue'
import { vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT, IN_PANEL } from '@/lib/board/context'

const store = reactive({})
const reloads = {}

/** What source `key` holds: {data, failure, stale}; unset sources are loading. */
export function setSource(key, { data = null, failure = null, stale = false } = {}) {
    store[key] = { data, failure, stale }
}

export function resetSources() {
    for (const key of Object.keys(store)) delete store[key]
    for (const key of Object.keys(reloads)) delete reloads[key]
}

/** The reload spy of a source. */
export function reloadOf(key) {
    reloads[key] ||= vi.fn()
    return reloads[key]
}

export function useBoardSource(key) {
    const current = () => store[key] || { data: null, failure: null, stale: false }
    return {
        data: computed(() => current().data),
        loading: computed(() => !current().data && !current().failure),
        failure: computed(() => current().failure),
        error: computed(() => (current().failure ? current().failure.message || 'error' : '')),
        stale: computed(() => current().stale),
        reload: reloadOf(key),
    }
}

export function invalidate() {}
export function revalidate() {}
export function resetBoardSources() {}

/** A fresh fake board context for one mount. */
export function fakeBoard(websiteId = 'w1') {
    return {
        websiteId: computed(() => websiteId),
        open: vi.fn(),
        close: vi.fn(),
        invalidate: vi.fn(),
        revalidate: vi.fn(),
    }
}

const Blank = defineComponent({ render: () => h('div') })

export function testRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
            { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
            { path: '/settings/autopilot', name: 'settings-autopilot', component: Blank },
            { path: '/billing', name: 'billing', component: Blank },
            { path: '/dashboard', name: 'dashboard', component: Blank },
        ],
    })
}

/**
 * Mount a card or panel on a board: the fake context provided (and
 * IN_PANEL with `panel`), a router on the board's route, a fresh Pinia.
 * Returns {wrapper, board, router}.
 */
export async function mountOnBoard(
    component,
    { props = {}, board = fakeBoard(), panel = false, path = '/projects/w1/analytics', stubs = {} } = {},
) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = testRouter()
    await router.push(path)
    await router.isReady()
    const provide = { [BOARD_CONTEXT]: board }
    if (panel) provide[IN_PANEL] = true
    const wrapper = mount(component, {
        props: { websiteId: 'w1', ...props },
        global: { plugins: [router, pinia], provide, stubs },
        attachTo: document.body,
    })
    await flushPromises()
    return { wrapper, board, router }
}
