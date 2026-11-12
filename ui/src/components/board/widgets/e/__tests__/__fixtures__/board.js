// Test fixtures only. A stand-in for useBoardSource (its frozen return
// shape, board_ownership.md 2), driven per source key by the spec; a fake
// board context to provide as BOARD_CONTEXT; and a mount helper with Pinia
// and a router that has the routes group E links to. What a card tells
// its frame (the chip) is collected in `reported`.
import { computed, defineComponent, h, reactive } from 'vue'
import { vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT, CARD_STATUS, IN_PANEL } from '@/lib/board/context'
import { useAgentStore } from '@/stores/agent'
import { useAuthStore } from '@/stores/auth'

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
            { path: '/projects/:websiteId/agent/reports', name: 'agent-reports', component: Blank },
            { path: '/projects/:websiteId/agent/artifacts/:artifactId', name: 'agent-artifact', component: Blank },
            { path: '/settings', name: 'settings', component: Blank },
            { path: '/settings/autopilot', name: 'settings-autopilot', component: Blank },
            { path: '/billing', name: 'billing', component: Blank },
        ],
    })
}

/**
 * Mount a card on a board: Pinia (the agent store's loadStatus replaced by
 * a spy; `stores({agent, auth})` runs before the mount to put a status or
 * a session in place), the fake board context, a router on the board's
 * route and the frame's status line. Returns {wrapper, board, router,
 * agent, auth, reported, last()}.
 */
export async function mountOnBoard(component, { props = {}, board = fakeBoard(), panel = false, stores = null } = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const agent = useAgentStore()
    const auth = useAuthStore()
    agent.loadStatus = vi.fn(() => Promise.resolve(agent.status))
    if (stores) stores({ agent, auth })
    const router = testRouter()
    await router.push('/projects/w1/analytics')
    await router.isReady()
    const reported = []
    const provide = { [BOARD_CONTEXT]: board, [CARD_STATUS]: (status) => reported.push(status) }
    if (panel) provide[IN_PANEL] = true
    const wrapper = mount(component, {
        props: { websiteId: 'w1', ...props },
        global: { plugins: [router, pinia], provide },
        attachTo: document.body,
    })
    await flushPromises()
    return { wrapper, board, router, agent, auth, reported, last: () => reported.at(-1) }
}
