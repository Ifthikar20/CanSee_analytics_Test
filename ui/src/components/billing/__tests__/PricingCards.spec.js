import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PricingCards from '../PricingCards.vue'
import { plansPayload } from './__fixtures__/plans'

const FOOTNOTE =
    'Prices in US dollars, billed monthly through Polar. Cancel anytime; your plan stays on until the end of the month you paid for.'

function render(props = {}) {
    return mount(PricingCards, { props: { plans: plansPayload(), signedIn: true, ...props } })
}

const cards = (wrapper) => wrapper.findAll('article.pc-card')
const buttons = (wrapper) => wrapper.findAll('button.pc-btn')
const words = (wrapper) => buttons(wrapper).map((b) => b.text())

describe('PricingCards', () => {
    it('shows only the self-serve plans, in API order: two cards', () => {
        const wrapper = render()
        expect(cards(wrapper)).toHaveLength(2)
        expect(cards(wrapper).map((c) => c.find('h3').text())).toEqual(['100 prompts', '200 prompts'])
        expect(cards(wrapper).map((c) => c.find('.pc-amount').text())).toEqual(['$80', '$140'])
        expect(cards(wrapper).map((c) => c.find('.pc-period').text())).toEqual(['/month', '/month'])
        expect(cards(wrapper)[0].findAll('.pc-features li').map((li) => li.text())).toEqual([
            '100 tracked prompts',
            'ChatGPT and Claude, asked every day',
            'Google page one, checked every day',
            'One text a day with your results',
            '$52 of AI usage a month',
            '5 projects',
        ])
        // The check icons are decoration.
        expect(cards(wrapper)[0].find('.pc-check').attributes('aria-hidden')).toBe('true')
        expect(wrapper.text()).not.toMatch(/most popular|free trial/i)
    })

    it('words each button for who is looking', () => {
        expect(words(render({ signedIn: false }))).toEqual(['Get started', 'Get started'])
        expect(words(render({ current: null }))).toEqual(['Choose 100 prompts', 'Choose 200 prompts'])
        expect(words(render({ current: 'pro' }))).toEqual(['Move to 100 prompts', 'Move to 200 prompts'])

        const onHundred = render({ current: 'prompts_100' })
        expect(words(onHundred)).toEqual(['Current plan', 'Move to 200 prompts'])
        expect(buttons(onHundred)[0].attributes('disabled')).toBeDefined()
        expect(buttons(onHundred)[1].attributes('disabled')).toBeUndefined()
    })

    it('names the plan each button is for', () => {
        const wrapper = render({ signedIn: false })
        const [first] = buttons(wrapper)
        const nameId = first.attributes('aria-describedby')
        expect(wrapper.find(`#${nameId}`).text()).toBe('100 prompts')
    })

    it('says the checkout is opening and holds every button meanwhile', () => {
        const wrapper = render({ busy: 'prompts_200' })
        expect(words(wrapper)).toEqual(['Choose 100 prompts', 'Opening checkout...'])
        expect(buttons(wrapper).every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    })

    it('disables every button until checkout is set up', () => {
        const wrapper = render({ billingReady: false })
        expect(buttons(wrapper).every((b) => b.attributes('disabled') !== undefined)).toBe(true)
        expect(wrapper.find('.pc-note').text()).toBe("Checkout isn't set up yet.")
        expect(render().find('.pc-note').exists()).toBe(false)
    })

    it('emits the plan chosen', async () => {
        const wrapper = render({ current: null })
        await buttons(wrapper)[1].trigger('click')
        expect(wrapper.emitted('choose')).toEqual([['prompts_200']])
    })

    it('ends with the footnote, and the sales line only when a custom plan is listed', () => {
        const wrapper = render()
        const foot = wrapper.findAll('.pc-foot').map((p) => p.text())
        expect(foot).toEqual([FOOTNOTE, 'Need more? Email sales@cansee.ai.'])
        expect(wrapper.find('.pc-foot a').attributes('href')).toBe('mailto:sales@cansee.ai')

        const noCustom = render({ plans: plansPayload().filter((p) => p.id !== 'business') })
        expect(noCustom.findAll('.pc-foot').map((p) => p.text())).toEqual([FOOTNOTE])
    })
})
