// Test fixtures only. A stand-in for FE-board's useBoardSource (its frozen
// return shape, board_ownership.md 2), driven per source key by the spec,
// a fake board context to provide as BOARD_CONTEXT, and a mount helper.
import { computed, defineComponent, h, reactive } from 'vue'
import { vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT } from '@/lib/board/context'

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

/**
 * Mount a card or panel on a board: the fake context provided, a router
 * with the board's route. Returns {wrapper, board, router}.
 */
export async function mountOnBoard(component, { props = {}, board = fakeBoard(), stubs = {}, path = '/projects/w1/analytics' } = {}) {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
            { path: '/settings/connections', name: 'settings-connections', component: Blank },
            { path: '/dashboard', name: 'dashboard', component: Blank },
        ],
    })
    await router.push(path)
    await router.isReady()
    const wrapper = mount(component, {
        props: { websiteId: 'w1', ...props },
        global: { plugins: [router], provide: { [BOARD_CONTEXT]: board }, stubs },
        attachTo: document.body,
    })
    await flushPromises()
    return { wrapper, board, router }
}

/** A stand-in for VizChart (its props and slots) that prints the spec's title. */
export const VizChartStub = defineComponent({
    name: 'VizChart',
    props: {
        spec: { type: Object, required: true },
        loading: { type: Boolean, default: false },
        error: { type: String, default: '' },
        empty: { type: Object, default: null },
        height: { type: Number, default: 240 },
        compact: { type: Boolean, default: false },
        hideSwitcher: { type: Boolean, default: false },
        headingLevel: { type: Number, default: 3 },
        selected: { type: String, default: '' },
    },
    emits: ['select', 'retry'],
    setup(props, { slots }) {
        return () =>
            h('figure', { class: 'viz-stub', 'data-id': props.spec?.id || '' }, [
                h('p', { class: 'viz-stub-title' }, props.spec?.title || ''),
                slots.actions?.(),
                slots.custom?.({ spec: props.spec, representation: 'custom' }),
            ])
    },
})
