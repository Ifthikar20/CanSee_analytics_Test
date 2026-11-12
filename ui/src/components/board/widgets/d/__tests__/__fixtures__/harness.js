// Test fixtures only. What a group D card needs around it in a spec: the
// board's context with spies, the card's line to its frame (every status
// it reports is recorded), a router, and fake sources in place of
// useBoardSource (the spec mocks '@/composables/board/useBoardSource' and
// sets `sources[key]` before mounting).
import { computed, defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'
import { BOARD_CONTEXT, CARD_STATUS, IN_PANEL } from '@/lib/board/context'

const Blank = defineComponent({ render: () => h('div') })

/** A source as useBoardSource returns it. */
export function fakeSource({ data = null, failure = null, stale = false } = {}) {
    const failed = ref(failure)
    return {
        data: ref(data),
        loading: ref(false),
        failure: failed,
        error: computed(() => (failed.value ? failed.value.message || 'error' : '')),
        stale: ref(stale),
        reload: vi.fn(),
    }
}

/**
 * Mount a card inside a fake board card. Returns the wrapper with `board`
 * (spies) and `statuses` (what the card told its frame, in order; the
 * last one is the chip).
 */
export async function mountCard(component, { props = {}, panel = false } = {}) {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: Blank }] })
    await router.push('/projects/w1/analytics')
    await router.isReady()
    const board = { websiteId: computed(() => 'w1'), open: vi.fn(), close: vi.fn(), invalidate: vi.fn(), revalidate: vi.fn() }
    const statuses = []
    const provide = { [BOARD_CONTEXT]: board, [CARD_STATUS]: (status) => statuses.push(status) }
    if (panel) provide[IN_PANEL] = true
    const wrapper = mount(component, { props: { websiteId: 'w1', ...props }, global: { plugins: [router], provide }, attachTo: document.body })
    wrapper.board = board
    wrapper.statuses = statuses
    wrapper.status = () => statuses.at(-1)
    await flushPromises()
    return wrapper
}

/** One animation frame, then Vue's own flush. */
export async function nextFrame() {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()))
    await flushPromises()
}
