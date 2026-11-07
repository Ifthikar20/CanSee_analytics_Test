import { describe, expect, it } from 'vitest'
import { describeSubscription, paidPlanId } from '../plan'

const NOW = new Date('2026-11-05T12:00:00Z')

describe('describeSubscription: the two monthly plans', () => {
    it.each([
        ['prompts_100', '100 prompts'],
        ['prompts_200', '200 prompts'],
    ])('names %s "%s", never "%s plan"', (plan, name) => {
        // The session's subscription block.
        const session = describeSubscription({ status: 'active', plan, tier: plan, is_paying: true, is_trialing: false }, NOW)
        expect(session.tier).toBe(plan)
        expect(session.tierName).toBe(name)
        expect(session.title).toBe(name)
        expect(session.tierLabel).toBe(name)
        expect(session.planLabel).toBe(name)
        expect(session.badge).toEqual({ text: name, tone: 'gold' })
        expect(session.statusLabel).toBe('Active')

        // The billing overview.
        const overview = describeSubscription({ subscription_status: 'active', subscription_plan: plan, tier: plan }, NOW)
        expect(overview.title).toBe(name)
    })

    it('keeps the plan name through a payment issue and a cancellation', () => {
        const pastDue = describeSubscription({ subscription_status: 'past_due', subscription_plan: 'prompts_200', tier: 'prompts_200' }, NOW)
        expect(pastDue.title).toBe('200 prompts')
        expect(pastDue.planLabel).toBe('200 prompts · payment issue')
        expect(pastDue.badge).toEqual({ text: '200 prompts', tone: 'warn' })

        const ending = describeSubscription(
            { status: 'active', tier: 'prompts_100', cancel_at_period_end: true, current_period_end: '2026-12-01T12:00:00Z' },
            NOW,
        )
        expect(ending.planLabel).toBe('100 prompts · ends Dec 1')
    })

    it('still says Pro plan and Business plan', () => {
        expect(describeSubscription({ status: 'active', tier: 'pro' }, NOW).title).toBe('Pro plan')
        expect(describeSubscription({ status: 'active', tier: 'individual' }, NOW).title).toBe('Pro plan')
        expect(describeSubscription({ status: 'active', tier: 'business' }, NOW).title).toBe('Business plan')
        expect(describeSubscription({ source: 'organization', tier: 'business' }, NOW).title).toBe('Business plan')
        expect(describeSubscription(null, NOW).title).toBe('Free plan')
    })
})

describe('paidPlanId', () => {
    it('reads the paid plan from either payload', () => {
        expect(paidPlanId({ status: 'active', plan: 'prompts_100' })).toBe('prompts_100')
        expect(paidPlanId({ subscription_status: 'active', plan: 'prompts_200' })).toBe('prompts_200')
        expect(paidPlanId({ subscription_status: 'trialing', plan: 'pro' })).toBe('pro')
        expect(paidPlanId({ subscription_status: 'active', plan: 'enterprise' })).toBe('business')
    })

    it('keeps a past-due plan and gives null for Free', () => {
        expect(paidPlanId({ subscription_status: 'past_due', plan: 'free', subscription_plan: 'prompts_200' })).toBe('prompts_200')
        expect(paidPlanId({ status: 'past_due', plan: 'free', tier: 'prompts_100' })).toBe('prompts_100')
        expect(paidPlanId({ subscription_status: 'past_due', plan: 'free', subscription_plan: 'scale' })).toBe('business')
        expect(paidPlanId({ subscription_status: 'active', plan: 'free' })).toBeNull()
        expect(paidPlanId({ subscription_status: 'canceled', plan: 'free', subscription_plan: 'prompts_100' })).toBeNull()
        expect(paidPlanId({ subscription_status: 'none' })).toBeNull()
        expect(paidPlanId(null)).toBeNull()
    })
})
