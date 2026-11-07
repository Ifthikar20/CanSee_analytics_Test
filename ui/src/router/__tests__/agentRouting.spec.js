import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('@/api/client', () => ({
    default: { get: vi.fn(), post: vi.fn() },
    authHeaders: () => ({}),
    refreshAccessToken: async () => '',
}))
vi.mock('@/api/websites', () => ({ default: { list: vi.fn() } }))
vi.mock('@/api/agent', () => ({ default: { getChat: vi.fn() } }))

import websitesApi from '@/api/websites'
import agentApi from '@/api/agent'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { savePaneState, setLastChat, setLastProject } from '@/lib/agent/storage'
import { resolveAgentEntry, resolveChatLink } from '../agentGuards'
import { agentRoutes } from '../agentRoutes'

const SITES = [
    { id: 1, name: 'Wrenfield' },
    { id: 2, name: 'Turonote' },
    { id: 3, name: 'Third' },
]
const route = (overrides = {}) => ({ params: {}, query: {}, hash: '', ...overrides })
const notFound = () => Object.assign(new Error('404'), { response: { status: 404 } })

beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    websitesApi.list.mockReset()
    agentApi.getChat.mockReset()
    websitesApi.list.mockResolvedValue({ success: true, data: SITES })
    useAuthStore().user = { id: 7 }
})

describe('agent routes', () => {
    const workspace = agentRoutes.find((r) => r.path === '/projects/:websiteId/agent')
    const child = (name) => workspace.children.find((c) => c.name === name)

    it('shares one chat page component between the new-chat and chat URLs', () => {
        expect(child('agent-home').component).toBe(child('agent-chat').component)
    })

    it('marks every agent route as signed-in and in the agent section of AppShell', () => {
        for (const r of agentRoutes) {
            expect(r.meta).toEqual({ requiresAuth: true, section: 'agent' })
            expect(String(r.component)).toContain('layouts/AppShell.vue')
        }
    })

    it('passes the artifact kinds per list page', () => {
        const props = (name) => child(name).props({ params: { websiteId: '2' } })
        expect(props('agent-reports')).toEqual({ websiteId: '2', kinds: ['report'] })
        expect(props('agent-documents').kinds).toEqual(['document', 'page'])
        expect(props('agent-sheets').kinds).toEqual(['sheet'])
    })

    it('resolves the Findings page under the project, lazily, with its title', () => {
        const router = createRouter({ history: createMemoryHistory(), routes: agentRoutes })
        const target = router.resolve({ name: 'agent-findings', params: { websiteId: '2' } })
        expect(target.path).toBe('/projects/2/agent/findings')
        expect(target.params).toEqual({ websiteId: '2' })
        expect(target.meta).toEqual({ requiresAuth: true, section: 'agent', title: 'Findings' })
        expect(router.resolve('/projects/2/agent/findings').name).toBe('agent-findings')

        const findings = child('agent-findings')
        expect(findings.props).toBe(true)
        // A lazy component: a loader function, never the page module itself.
        expect(typeof findings.component).toBe('function')
        expect(findings.component).not.toBe(child('agent-home').component)
    })

    it('resolves the Reviews page under the project, lazily, with its title', async () => {
        const router = createRouter({ history: createMemoryHistory(), routes: agentRoutes })
        const target = router.resolve({ name: 'agent-reviews', params: { websiteId: '2' }, query: { box: 'mine' } })
        expect(target.fullPath).toBe('/projects/2/agent/reviews?box=mine')
        expect(target.meta).toEqual({ requiresAuth: true, section: 'agent', title: 'Reviews' })
        expect(router.resolve('/projects/2/agent/reviews').name).toBe('agent-reviews')

        const reviews = child('agent-reviews')
        expect(reviews.props).toBe(true)
        expect(typeof reviews.component).toBe('function')
        const page = await reviews.component()
        expect(page.default).toBeTruthy()
        // Findings comes first in the sidebar order, then Reviews, then the lists.
        const names = workspace.children.map((c) => c.name)
        expect(names.indexOf('agent-reviews')).toBe(names.indexOf('agent-findings') + 1)
    })
})

describe('resolveAgentEntry', () => {
    it('sends users without projects to the dashboard', async () => {
        websitesApi.list.mockResolvedValue({ success: true, data: [] })
        expect(await resolveAgentEntry(route())).toEqual({ name: 'dashboard' })
    })

    it('sends a failed project list to the projects page, not the dashboard', async () => {
        websitesApi.list.mockRejectedValue(Object.assign(new Error('500'), { response: { status: 500 } }))
        expect(await resolveAgentEntry(route())).toEqual({ name: 'agent-projects' })
    })

    it('prefers the project already active in this session', async () => {
        const app = useAppStore()
        app.setWebsites(SITES)
        app.setActiveWebsite(SITES[2])
        setLastProject(7, 2)
        expect(await resolveAgentEntry(route())).toMatchObject({ name: 'agent-home', params: { websiteId: '3' } })
    })

    it('falls back to the stored last project and opens its last chat', async () => {
        setLastProject(7, 2)
        setLastChat(7, 2, 'chat-9')
        expect(await resolveAgentEntry(route())).toMatchObject({
            name: 'agent-chat',
            params: { websiteId: '2', chatId: 'chat-9' },
        })
    })

    it('starts a new chat when ?agent= is given, keeping the query', async () => {
        setLastProject(7, 2)
        setLastChat(7, 2, 'chat-9')
        expect(await resolveAgentEntry(route({ query: { agent: 'landing_page' } }))).toEqual({
            name: 'agent-home',
            params: { websiteId: '2' },
            query: { agent: 'landing_page' },
            hash: '',
        })
    })

    it('ignores a stored project the user no longer has', async () => {
        setLastProject(7, 99)
        expect(await resolveAgentEntry(route())).toMatchObject({ name: 'agent-home', params: { websiteId: '1' } })
    })
})

describe('resolveChatLink', () => {
    it('uses the project this browser has seen the chat in, without a request', async () => {
        savePaneState(7, 3, 'chat-5', { tabs: [] })
        expect(await resolveChatLink(route({ params: { chatId: 'chat-5' } }))).toMatchObject({
            name: 'agent-chat',
            params: { websiteId: '3', chatId: 'chat-5' },
        })
        expect(agentApi.getChat).not.toHaveBeenCalled()
    })

    it('asks each project in turn, last project first', async () => {
        setLastProject(7, 2)
        agentApi.getChat.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ success: true, data: { id: 'chat-5' } })
        const target = await resolveChatLink(route({ params: { chatId: 'chat-5' } }))
        expect(agentApi.getChat.mock.calls.map((c) => c[0])).toEqual(['2', '1'])
        expect(target).toMatchObject({ name: 'agent-chat', params: { websiteId: '1', chatId: 'chat-5' } })
    })

    it('stops asking on an error other than 404 and lands on /agent', async () => {
        agentApi.getChat.mockRejectedValueOnce(Object.assign(new Error('503'), { response: { status: 503 } }))
        const target = await resolveChatLink(route({ params: { chatId: 'chat-5' } }))
        expect(agentApi.getChat).toHaveBeenCalledTimes(1)
        expect(target).toEqual({ name: 'agent', query: {} })
    })

    it('lands on /agent when no project has the chat', async () => {
        agentApi.getChat.mockRejectedValue(notFound())
        expect(await resolveChatLink(route({ params: { chatId: 'gone' } }))).toEqual({ name: 'agent', query: {} })
        expect(agentApi.getChat).toHaveBeenCalledTimes(3)
    })
})
