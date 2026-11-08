import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

// The template's public image compiles to an import; node has no /images.
vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))

const { default: LandingPage } = await import('../LandingPage.vue')

const Blank = defineComponent({ render: () => h('div') })

async function render() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: Blank }] })
    await router.push('/')
    return mount(LandingPage, { global: { plugins: [pinia, router] } })
}

describe('LandingPage: Pricing', () => {
    it('links Pricing beside Sign in, in the menu sheet and in the footer', async () => {
        const wrapper = await render()
        const actions = wrapper.findAll('.lp-actions a').map((a) => [a.text(), a.attributes('href')])
        expect(actions).toEqual([
            ['Pricing', '/pricing'],
            ['Sign in', '/login'],
        ])
        const sheet = wrapper.findAll('.lp-sheet a').map((a) => a.text())
        expect(sheet.slice(-2)).toEqual(['Pricing', 'Sign in'])
        const footer = wrapper.findAll('.lp-foot-links a').map((a) => [a.text(), a.attributes('href')])
        expect(footer[0]).toEqual(['Pricing', '/pricing'])
    })
})

describe('LandingPage: Blog', () => {
    it('links the blog from the Resources menu, the menu sheet and the footer', async () => {
        const wrapper = await render()
        const resources = wrapper.findAll('#lp-menu-resources a').map((a) => [a.find('.lp-dd-label').text(), a.attributes('href')])
        expect(resources[0]).toEqual(['Blog', '/blog'])
        const sheet = wrapper.findAll('.lp-sheet a').map((a) => [a.text(), a.attributes('href')])
        expect(sheet).toContainEqual(['Blog', '/blog'])
        const footer = wrapper.findAll('.lp-foot-links a').map((a) => [a.text(), a.attributes('href')])
        expect(footer[1]).toEqual(['Blog', '/blog'])
    })
})
