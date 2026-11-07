import { beforeEach, describe, expect, it } from 'vitest'
import { setLastChat } from '@/lib/agent/storage'
import { HELP_LINKS, SECTIONS, agentLocation, analyticsLocation, navItems, sectionOf } from '../nav'

const at = (section) => ({ meta: section === undefined ? {} : { section } })

beforeEach(() => {
    localStorage.clear()
})

describe('sectionOf', () => {
    it('reads meta.section and knows only the three sections', () => {
        expect(SECTIONS).toEqual(['analytics', 'agent', 'settings'])
        for (const section of SECTIONS) expect(sectionOf(at(section))).toBe(section)
        expect(sectionOf(at('board'))).toBeNull()
        expect(sectionOf(at())).toBeNull()
        expect(sectionOf({})).toBeNull()
        expect(sectionOf(null)).toBeNull()
    })
})

describe('agentLocation', () => {
    it("returns to the project's last chat, else its new chat, else the agent picker", () => {
        expect(agentLocation('w1', 7)).toEqual({ name: 'agent-home', params: { websiteId: 'w1' } })
        setLastChat(7, 'w1', 'chat-9')
        expect(agentLocation('w1', 7)).toEqual({ name: 'agent-chat', params: { websiteId: 'w1', chatId: 'chat-9' } })
        // The last chat is per user: no user, no chat.
        expect(agentLocation('w1', null)).toEqual({ name: 'agent-home', params: { websiteId: 'w1' } })
        expect(agentLocation('w1', 8)).toEqual({ name: 'agent-home', params: { websiteId: 'w1' } })
        expect(agentLocation(null, 7)).toEqual({ name: 'agent' })
        expect(agentLocation('', 7)).toEqual({ name: 'agent' })
    })

    it('takes numeric ids', () => {
        setLastChat(7, 3, 'chat-1')
        expect(agentLocation(3, '7')).toEqual({ name: 'agent-chat', params: { websiteId: '3', chatId: 'chat-1' } })
    })
})

describe('analyticsLocation', () => {
    it('opens the board with no panel, or /dashboard without a project', () => {
        expect(analyticsLocation('w1')).toEqual({ name: 'analytics', params: { websiteId: 'w1' }, query: {} })
        expect(analyticsLocation(4)).toEqual({ name: 'analytics', params: { websiteId: '4' }, query: {} })
        expect(analyticsLocation(null)).toEqual({ name: 'dashboard', query: {} })
        expect(analyticsLocation('')).toEqual({ name: 'dashboard', query: {} })
    })
})

describe('navItems', () => {
    it('lists Analytics, Agent and Settings, marking the current section only', () => {
        for (const section of SECTIONS) {
            const items = navItems(at(section), { websiteId: 'w1', userId: 7 })
            expect(items.map((i) => i.label)).toEqual(['Analytics', 'Agent', 'Settings'])
            expect(items.map((i) => i.key)).toEqual(SECTIONS)
            expect(items.filter((i) => i.active).map((i) => i.key)).toEqual([section])
        }
    })

    it('marks nothing for a route without a section', () => {
        expect(navItems(at(), { websiteId: 'w1' }).some((i) => i.active)).toBe(false)
        expect(navItems(undefined).some((i) => i.active)).toBe(false)
    })

    it("links to the project's board, its agent and Settings", () => {
        setLastChat(7, 'w1', 'c42')
        const [analytics, agent, settings] = navItems(at('agent'), { websiteId: 'w1', userId: 7 })
        expect(analytics.to).toEqual({ name: 'analytics', params: { websiteId: 'w1' }, query: {} })
        expect(agent.to).toEqual({ name: 'agent-chat', params: { websiteId: 'w1', chatId: 'c42' } })
        expect(settings.to).toEqual({ name: 'settings' })

        const [noBoard, noAgent] = navItems(at('settings'))
        expect(noBoard.to).toEqual({ name: 'dashboard', query: {} })
        expect(noAgent.to).toEqual({ name: 'agent' })
    })
})

describe('HELP_LINKS', () => {
    it('names Docs and Support, in that order', () => {
        expect(HELP_LINKS.map((l) => [l.label, l.name])).toEqual([
            ['Docs', 'docs'],
            ['Support', 'support'],
        ])
        expect(Object.isFrozen(HELP_LINKS)).toBe(true)
        expect(Object.isFrozen(HELP_LINKS[0])).toBe(true)
    })
})
