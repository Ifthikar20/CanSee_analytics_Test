import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('@/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() }, authHeaders: () => ({}), refreshAccessToken: async () => '' }))

const { default: SettingsShell } = await import('../SettingsShell.vue')

const Blank = defineComponent({ render: () => h('div') })

async function render(active) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/settings/usage-dashboard', name: 'settings-command-center', component: Blank },
            { path: '/:any(.*)*', component: Blank },
        ],
    })
    await router.push('/settings/autopilot')
    const wrapper = mount(SettingsShell, { props: { active }, global: { plugins: [pinia, router] } })
    await flushPromises()
    return wrapper
}

describe('SettingsShell: Autopilot', () => {
    it('sits in the Project group, after Project', async () => {
        const wrapper = await render('autopilot')
        const nav = wrapper.find('aside.ss-nav')
        const groups = nav.findAll('.ss-nav-group').map((g) => g.text())
        expect(groups).toEqual(['General', 'Project', 'Application', 'Support'])
        const items = nav.findAll('.ss-nav-item').map((a) => a.text())
        expect(items.slice(3, 7)).toEqual(['Project', 'Autopilot', 'Connections', 'Brand facts'])
        const autopilot = nav.findAll('.ss-nav-item').find((a) => a.text() === 'Autopilot')
        expect(autopilot.attributes('href')).toBe('/settings/autopilot')
        expect(autopilot.attributes('aria-current')).toBe('page')
        expect(autopilot.find('svg').attributes('aria-hidden')).toBe('true')
        expect(autopilot.findAll('path').map((p) => p.attributes('d'))).toEqual([
            'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
            'M12 6v6l4 2',
        ])
        expect(wrapper.find('.ss-crumb-current').text()).toBe('Autopilot')
    })
})

describe('SettingsShell: help', () => {
    it('says what Autopilot, Connections and Brand facts hold, in side tooltips', async () => {
        const pinia = createPinia()
        setActivePinia(pinia)
        const router = createRouter({
            history: createMemoryHistory(),
            routes: [
                { path: '/settings/usage-dashboard', name: 'settings-command-center', component: Blank },
                { path: '/:any(.*)*', component: Blank },
            ],
        })
        await router.push('/settings/autopilot')
        const wrapper = mount(SettingsShell, { props: { active: 'autopilot' }, global: { plugins: [pinia, router] }, attachTo: document.body })
        await flushPromises()
        const tipOf = async (label) => {
            const link = wrapper.find('aside.ss-nav').findAll('.ss-nav-item').find((a) => a.text() === label)
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
            link.element.focus()
            await flushPromises()
            return document.body.querySelector('.ag-tooltip')?.textContent || ''
        }
        expect(await tipOf('Autopilot')).toContain('The daily run of your tracked prompts')
        expect(await tipOf('Connections')).toContain('Search Console, your traffic source')
        expect(await tipOf('Brand facts')).toContain('Fact check tests AI answers against them')
        wrapper.unmount()
    })
})
