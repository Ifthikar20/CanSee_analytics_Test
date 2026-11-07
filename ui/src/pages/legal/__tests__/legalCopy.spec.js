import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

// The template's public image compiles to an import; node has no /images.
vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))

const { default: TermsPage } = await import('../TermsPage.vue')
const { default: PrivacyPage } = await import('../PrivacyPage.vue')

const Blank = defineComponent({ render: () => h('div') })

async function render(page) {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: Blank }] })
    await router.push('/')
    return mount(page, { global: { plugins: [router] } })
}

const squash = (text) => text.replace(/\s+/g, ' ').trim()

describe('TermsPage: plans and text messages', () => {
    it('describes the two monthly plans, billed by Polar', async () => {
        const wrapper = await render(TermsPage)
        const plans = wrapper.find('#plans')
        expect(plans.findAll('h3')[0].text()).toBe('4.1 Monthly plans')
        expect(squash(plans.findAll('p')[0].text())).toContain(
            'The 100 prompts plan is $80 a month and the 200 prompts plan is $140 a month, billed in advance by Polar. Each includes the tracked prompts its name says, the AI usage shown on the pricing page and daily checks.',
        )
        expect(wrapper.text()).not.toContain('Stripe')
        expect(plans.text()).not.toMatch(/\$14\b|Individual Plan/)
        expect(squash(plans.text())).toContain('All payments are processed securely by Polar.')
    })

    it('replaces the free trial with the Free plan', async () => {
        const wrapper = await render(TermsPage)
        const free = wrapper.find('#trial')
        expect(free.find('h2').text()).toBe('5. Free plan')
        expect(squash(free.find('p').text())).toBe('The Free plan stays free with its limits. The 100 and 200 prompt plans have no free trial.')
        expect(wrapper.text()).not.toMatch(/7-day free trial/i)
    })

    it('has the text message terms the consent box links to', async () => {
        const wrapper = await render(TermsPage)
        const sms = wrapper.find('section#sms')
        expect(sms.exists()).toBe(true)
        expect(sms.find('h2').text()).toBe('16. Text messages')
        const text = squash(sms.text())
        expect(text).toContain('Cansee Autopilot texts')
        expect(text).toContain('one text a day per project you turn on in Autopilot, plus the verification codes and replies you ask for')
        expect(text).toContain('Msg & data rates may apply. Reply STOP to cancel, HELP for help.')
        expect(text).toContain('Carriers are not liable for delayed or undelivered messages.')
        expect(text).toContain('not a condition of purchase')
        expect(wrapper.find('.legal-toc a[href="#sms"]').text()).toBe('Text messages')
        expect(wrapper.find('#contact h2').text()).toBe('17. Contact Information')
    })
})

describe('PrivacyPage: mobile numbers', () => {
    it('says what mobile numbers and consent are used for', async () => {
        const wrapper = await render(PrivacyPage)
        expect(squash(wrapper.find('#sms').text())).toBe(
            'Mobile numbers and text message consent are used only to send the texts you ask for. They are never shared with third parties or affiliates for marketing.',
        )
    })
})
