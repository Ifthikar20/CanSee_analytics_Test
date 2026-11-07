import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => ({
    default: {
        get: vi.fn(async () => ({ data: { next_route: 'app' } })),
        post: vi.fn(),
        put: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
    },
    authHeaders: () => ({}),
    refreshAccessToken: async () => '',
}))
vi.mock('@/api/websites', () => ({ default: { list: vi.fn() } }))

// The shell and every page are stand-ins: these tests check which module
// each route loads and where every old address lands, not the pages.
const stub = (name) => ({ default: { name, render: () => null } })
vi.mock('@/layouts/AppShell.vue', () => stub('AppShell'))
vi.mock('@/pages/board/AnalyticsBoardPage.vue', () => stub('AnalyticsBoardPage'))
vi.mock('@/pages/board/AnalyticsEntryPage.vue', () => stub('AnalyticsEntryPage'))
vi.mock('@/pages/SettingsPage.vue', () => stub('SettingsPage'))
vi.mock('@/pages/settings/ProjectSettings.vue', () => stub('ProjectSettings'))
vi.mock('@/pages/settings/AutopilotSettings.vue', () => stub('AutopilotSettings'))
vi.mock('@/pages/settings/ConnectionsPage.vue', () => stub('ConnectionsPage'))
vi.mock('@/pages/settings/BrandFactsSettings.vue', () => stub('BrandFactsSettings'))
vi.mock('@/pages/settings/CommandCenterPage.vue', () => stub('CommandCenterPage'))
vi.mock('@/pages/BillingPage.vue', () => stub('BillingPage'))

const { default: websitesApi } = await import('@/api/websites')
const { default: router } = await import('@/router')
const { analyticsRoutes, settingsRoutes } = await import('../analyticsRoutes')
const { resolveAnalyticsEntry } = await import('../analyticsEntry')
const { SECTIONS } = await import('@/lib/shell/nav')
const { useAppStore } = await import('@/stores/app')
const { useAuthStore } = await import('@/stores/auth')
const { setLastProject } = await import('@/lib/agent/storage')

const SITES = [
    { id: 'w1', name: 'Wrenfield' },
    { id: 'w2', name: 'Acme' },
]

// [old path, where it lands]: board_contract.md 2, row by row.
const REDIRECTS = [
    ['/projects/w1', '/projects/w1/analytics'],
    ['/projects/w1/prompts/p9', '/projects/w1/analytics?prompt=p9&widget=prompts'],
    ['/projects/w1/competitors', '/projects/w1/analytics?widget=competitors'],
    ['/projects/w1/countries', '/projects/w1/analytics?widget=countries'],
    ['/projects/w1/visibility', '/projects/w1/analytics?widget=visibility'],
    ['/projects/w1/sentiment', '/projects/w1/analytics?widget=sentiment'],
    ['/projects/w1/fact-check', '/projects/w1/analytics?widget=fact-check'],
    ['/projects/w1/fan-outs', '/projects/w1/analytics?widget=fan-outs'],
    ['/projects/w1/prompt-research', '/projects/w1/analytics?widget=prompt-research'],
    ['/projects/w1/crawler-access', '/projects/w1/analytics?widget=crawler-access'],
    ['/projects/w1/ai-traffic', '/projects/w1/analytics?widget=ai-traffic'],
    ['/projects/w1/traffic', '/projects/w1/analytics?widget=traffic'],
    ['/projects/w1/products', '/projects/w1/analytics?widget=products'],
    ['/projects/w1/sources', '/projects/w1/analytics?widget=citations'],
    [
        '/projects/w1/sources/detail?url=https%3A%2F%2Fa.test%2Fx&topic=pricing&provider=gpt4',
        '/projects/w1/analytics?url=https://a.test/x&topic=pricing&provider=gpt4&widget=citations',
    ],
    ['/projects/w1/pages', '/projects/w1/analytics?widget=pages'],
    ['/analytics/w1', '/projects/w1/analytics'],
    ['/llm-ranking/w1/prompt-library?tab=x', '/projects/w1/analytics?tab=x'],
    ['/llm-ranking/w1/brand-research/deep/path', '/projects/w1/analytics'],
    // The three named llm-ranking redirects chain into the board.
    ['/llm-ranking/w1/prompts/p9/detail', '/projects/w1/analytics?prompt=p9&widget=prompts'],
    ['/llm-ranking/w1/urls?topic=pricing', '/projects/w1/analytics?topic=pricing&widget=citations'],
    ['/llm-ranking/w1/urls/detail?url=https%3A%2F%2Fa.test%2F', '/projects/w1/analytics?url=https://a.test/&widget=citations'],
]

// The route names on the redirect records, as RouterLinks and pushes use them.
const NAMED = [
    ['competitors', 'competitors'],
    ['countries', 'countries'],
    ['visibility', 'visibility'],
    ['sentiment', 'sentiment'],
    ['fact-check', 'fact-check'],
    ['fan-outs', 'fan-outs'],
    ['prompt-research', 'prompt-research'],
    ['crawler-access', 'crawler-access'],
    ['ai-traffic', 'ai-traffic'],
    ['traffic', 'traffic'],
    ['products', 'products'],
    ['sources-urls', 'citations'],
    ['sources-url-detail', 'citations'],
    ['site-pages', 'pages'],
]

// [name, path, page module, tab title]
const SETTINGS_PAGES = [
    ['settings', '/settings', 'SettingsPage', 'Settings'],
    ['settings-project', '/settings/project', 'ProjectSettings', 'Project settings'],
    ['settings-autopilot', '/settings/autopilot', 'AutopilotSettings', 'Autopilot'],
    ['settings-connections', '/settings/connections', 'ConnectionsPage', 'Connections'],
    ['settings-brand-facts', '/settings/brand-facts', 'BrandFactsSettings', 'Brand facts'],
    ['settings-command-center', '/settings/usage-dashboard', 'CommandCenterPage', 'Usage dashboard'],
    ['billing', '/billing', 'BillingPage', 'Billing'],
]

// A record's component is AppShell's loader, or the stub it resolved to once
// a navigation loaded it.
const isAppShell = (component) =>
    component?.name === 'AppShell' || String(component || '').includes('layouts/AppShell.vue')

async function loaded(record) {
    const component = record.components.default
    expect(component).toBeTypeOf('function')
    const mod = await component()
    return (mod.default || mod).name
}

beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    const auth = useAuthStore()
    auth.accessToken = 'token'
    auth.user = { id: 7 }
    auth.session = { next_route: 'app', onboarding: { needs_onboarding: false } }
    useAppStore().setWebsites(SITES)
    websitesApi.list.mockReset()
    websitesApi.list.mockResolvedValue({ data: SITES })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('the board route', () => {
    it('renders the board of a project in AppShell, in the analytics section, untitled', async () => {
        const target = router.resolve({ name: 'analytics', params: { websiteId: 'w1' } })
        expect(target.path).toBe('/projects/w1/analytics')
        expect(router.resolve('/projects/w1/analytics').name).toBe('analytics')
        expect(target.meta).toEqual({ requiresAuth: true, section: 'analytics' })
        const record = target.matched.at(-1)
        expect(record.props.default).toBe(true)
        expect(await loaded(record)).toBe('AnalyticsBoardPage')
        expect(await loaded(target.matched[0])).toBe('AppShell')
    })

    it('renders the entry page at /dashboard in the analytics section, behind its guard', async () => {
        const target = router.resolve({ name: 'dashboard' })
        expect(target.path).toBe('/dashboard')
        expect(target.meta).toEqual({ requiresAuth: true, section: 'analytics', title: 'Analytics' })
        const record = target.matched.at(-1)
        expect(record.beforeEnter).toBe(resolveAnalyticsEntry)
        expect(await loaded(record)).toBe('AnalyticsEntryPage')
        expect(await loaded(target.matched[0])).toBe('AppShell')
    })
})

describe('old analytics addresses', () => {
    it.each(REDIRECTS)('%s lands on %s', async (from, to) => {
        await router.push(from)
        expect(router.currentRoute.value.fullPath).toBe(to)
        expect(router.currentRoute.value.name).toBe('analytics')
    })

    it('keeps the query and the hash, and sets widget last', async () => {
        await router.push('/projects/w1/visibility?period=90d&widget=nope#trend')
        expect(router.currentRoute.value.fullPath).toBe('/projects/w1/analytics?period=90d&widget=visibility#trend')
        await router.push('/projects/w2/prompts/p4?from=email#top')
        expect(router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?from=email&prompt=p4&widget=prompts#top')
    })

    it('passes only the project on from the llm-ranking catch-all (the query stays, as every redirect keeps it)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        await router.push('/llm-ranking/w2/a/b/c?x=1')
        expect(router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?x=1')
        expect(router.currentRoute.value.params).toEqual({ websiteId: 'w2' })
        expect(warn).not.toHaveBeenCalled()
    })

    it.each(NAMED)('keeps the name %s, which now opens the %s panel', async (name, widget) => {
        const resolved = router.resolve({ name, params: { websiteId: 'w1' } })
        expect(resolved.name).toBe(name)
        await router.push({ name, params: { websiteId: 'w1' }, query: { prompt: 'p1', check: '1' } })
        expect(router.currentRoute.value.query).toEqual({ prompt: 'p1', check: '1', widget })
    })

    it('opens a prompt by its old route name', async () => {
        expect(router.resolve({ name: 'prompt', params: { websiteId: 'w1', promptId: 'p1' } }).path).toBe('/projects/w1/prompts/p1')
        await router.push({ name: 'prompt', params: { websiteId: 'w1', promptId: 'p1' } })
        expect(router.currentRoute.value.fullPath).toBe('/projects/w1/analytics?prompt=p1&widget=prompts')
    })

    it('opens the board from /dashboard, keeping the query and the hash', async () => {
        useAppStore().setActiveWebsite(SITES[1])
        await router.push('/dashboard?widget=prompts&add=1#x')
        expect(router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?widget=prompts&add=1#x')
    })
})

describe('resolveAnalyticsEntry', () => {
    const to = (overrides = {}) => ({ params: {}, query: {}, hash: '', ...overrides })

    it('renders the entry page during onboarding, without asking for projects', async () => {
        useAuthStore().session = { onboarding: { needs_onboarding: true } }
        useAppStore().setWebsites([])
        await expect(resolveAnalyticsEntry(to())).resolves.toBe(true)
        expect(websitesApi.list).not.toHaveBeenCalled()
    })

    it('renders the entry page without projects or when the list fails', async () => {
        useAppStore().setWebsites([])
        websitesApi.list.mockResolvedValue({ data: [] })
        await expect(resolveAnalyticsEntry(to())).resolves.toBe(true)
        websitesApi.list.mockRejectedValue(Object.assign(new Error('500'), { response: { status: 500 } }))
        await expect(resolveAnalyticsEntry(to())).resolves.toBe(true)
    })

    it('opens the active project, else the last project, else the first', async () => {
        const app = useAppStore()
        app.setActiveWebsite(SITES[1])
        await expect(resolveAnalyticsEntry(to({ query: { widget: 'traffic' }, hash: '#h' }))).resolves.toEqual({
            name: 'analytics',
            params: { websiteId: 'w2' },
            query: { widget: 'traffic' },
            hash: '#h',
        })

        // A cold load: nothing active yet, the list loads, the last project wins.
        setActivePinia(createPinia())
        useAuthStore().user = { id: 7 }
        setLastProject(7, 'w2')
        expect((await resolveAnalyticsEntry(to())).params).toEqual({ websiteId: 'w2' })

        setActivePinia(createPinia())
        useAuthStore().user = { id: 7 }
        setLastProject(7, 'gone')
        expect((await resolveAnalyticsEntry(to())).params).toEqual({ websiteId: 'w1' })
    })
})

describe('settings routes', () => {
    it.each(SETTINGS_PAGES)('%s is a page of the settings section in AppShell', async (name, path, page, title) => {
        const target = router.resolve({ name })
        expect(target.path).toBe(path)
        expect(router.resolve(path).name).toBe(name)
        expect(target.meta).toEqual({ requiresAuth: true, section: 'settings', title })
        expect(await loaded(target.matched.at(-1))).toBe(page)
        expect(await loaded(target.matched[0])).toBe('AppShell')
    })

    it('renders every analytics and settings page in AppShell, the only signed-in layout', async () => {
        const parents = [...analyticsRoutes, ...settingsRoutes]
        for (const record of parents) expect(await loaded({ components: { default: record.component } })).toBe('AppShell')
        for (const route of router.getRoutes()) {
            const source = String(route.components?.default || '')
            if (source.includes('/layouts/')) expect(source).toContain('/layouts/AppShell.vue')
        }
    })

    it('gives every AppShell record a section, which picks its layout and current link', () => {
        const shells = router.getRoutes().filter((r) => isAppShell(r.components?.default))
        expect(shells.map((r) => r.path).sort()).toEqual([
            '/agent',
            '/agent/c/:chatId',
            '/agent/projects',
            '/billing',
            '/dashboard',
            '/projects/:websiteId',
            '/projects/:websiteId/agent',
            '/settings',
        ])
        for (const record of shells) expect(SECTIONS).toContain(record.meta.section)
        // The pages outside the frame have no section.
        for (const name of ['paywall', 'run-link', 'docs', 'login', 'not-found']) {
            expect(router.getRoutes().find((r) => r.name === name).meta.section).toBeUndefined()
        }
    })

    it('sends old Google Analytics returns to Connections, and the rest to project settings', () => {
        const record = router.getRoutes().find((r) => r.path === '/websites/:id')
        const from = (query) => ({ params: { id: 'w9' }, query })
        expect(record.redirect(from({ ga4: 'connected' }))).toEqual({
            name: 'settings-connections',
            query: { ga4: 'connected', website: 'w9' },
        })
        expect(record.redirect(from({}))).toEqual({ name: 'settings-project' })
    })
})
