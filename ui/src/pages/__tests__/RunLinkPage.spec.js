import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client }))

const { default: RunLinkPage } = await import('../RunLinkPage.vue')

const Blank = defineComponent({ render: () => h('div') })

async function render(code = 'k3v9x2qa') {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/r/:code', name: 'run-link', component: Blank },
            { path: '/dashboard', name: 'dashboard', component: Blank },
            { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
        ],
    })
    await router.push(`/r/${code}`)
    await router.isReady()
    const wrapper = mount(RunLinkPage, { global: { plugins: [router] } })
    await flushPromises()
    return { wrapper, router }
}

beforeEach(() => {
    client.get.mockReset()
})

describe('RunLinkPage', () => {
    it("opens the project's Prompt ranking", async () => {
        client.get.mockResolvedValue({ data: { website_id: 'w1', run_id: 'run-1', local_date: '2026-11-04' } })
        const { router } = await render()
        expect(client.get).toHaveBeenCalledWith('/autopilot/links/k3v9x2qa/', { _silentError: true })
        expect(router.currentRoute.value.fullPath).toBe('/projects/w1/analytics?widget=ranking')
    })

    it("says the link isn't available on a 404, and offers Analytics", async () => {
        client.get.mockRejectedValue({ response: { status: 404 } })
        const { wrapper, router } = await render()
        expect(wrapper.find('.rl-text').text()).toBe("This link isn't available. It may belong to a project you can't open.")
        const link = wrapper.find('a')
        expect(link.text()).toBe('Go to Analytics')
        await link.trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.name).toBe('dashboard')
    })

    it('offers a retry when the link could not be read', async () => {
        client.get.mockRejectedValueOnce({ response: { status: 500 } })
        const { wrapper, router } = await render()
        expect(wrapper.find('.rl-text').text()).toBe("We couldn't open this link.")
        client.get.mockResolvedValue({ data: { website_id: 'w2' } })
        await wrapper.find('button').trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?widget=ranking')
    })
})
