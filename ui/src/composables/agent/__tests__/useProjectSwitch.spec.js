import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { PROJECT_QUERY_KEYS, projectTarget, useProjectSwitch } from '../useProjectSwitch'

const Blank = defineComponent({ render: () => h('div') })

// As in the app: AppShell's parents carry the section, children their title.
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/agent/projects',
        meta: { section: 'agent' },
        children: [{ path: '', name: 'agent-projects', component: Blank, meta: { title: 'Projects' } }],
      },
      {
        path: '/projects/:websiteId/agent',
        meta: { section: 'agent' },
        children: [
          { path: '', name: 'agent-home', component: Blank },
          { path: 'c/:chatId', name: 'agent-chat', component: Blank },
          { path: 'context', name: 'agent-context', component: Blank, meta: { title: 'Context' } },
          { path: 'findings', name: 'agent-findings', component: Blank, meta: { title: 'Findings' } },
          { path: 'reviews', name: 'agent-reviews', component: Blank, meta: { title: 'Reviews' } },
          { path: 'reports', name: 'agent-reports', component: Blank, meta: { title: 'Reports' } },
          { path: 'artifacts/:artifactId', name: 'agent-artifact', component: Blank },
        ],
      },
      {
        path: '/projects/:websiteId',
        meta: { section: 'analytics' },
        children: [{ path: 'analytics', name: 'analytics', component: Blank }],
      },
      {
        path: '/dashboard',
        meta: { section: 'analytics' },
        children: [{ path: '', name: 'dashboard', component: Blank, meta: { title: 'Analytics' } }],
      },
      {
        path: '/settings',
        meta: { section: 'settings' },
        children: [
          { path: '', name: 'settings', component: Blank, meta: { title: 'Settings' } },
          { path: 'project', name: 'settings-project', component: Blank, meta: { title: 'Project settings' } },
          { path: 'autopilot', name: 'settings-autopilot', component: Blank, meta: { title: 'Autopilot' } },
        ],
      },
      {
        path: '/billing',
        meta: { section: 'settings' },
        children: [{ path: '', name: 'billing', component: Blank, meta: { title: 'Billing' } }],
      },
    ],
  })
}

async function setup(path) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = useAppStore()
  app.setWebsites([
    { id: 'w1', name: 'One' },
    { id: 'w2', name: 'Two' },
  ])
  const router = makeRouter()
  await router.push(path)
  await router.isReady()
  let api
  mount(
    defineComponent({
      setup() {
        api = useProjectSwitch()
        return () => h('div')
      },
    }),
    { global: { plugins: [pinia, router] } },
  )
  return { api, router, app }
}

describe('projectTarget', () => {
  it('keeps list sections and sends chats and artifacts home', () => {
    expect(projectTarget('agent-reports', 'w2')).toEqual({ name: 'agent-reports', params: { websiteId: 'w2' } })
    expect(projectTarget('agent-context', 'w2')).toEqual({ name: 'agent-context', params: { websiteId: 'w2' } })
    expect(projectTarget('agent-findings', 'w2')).toEqual({ name: 'agent-findings', params: { websiteId: 'w2' } })
    expect(projectTarget('agent-reviews', 'w2')).toEqual({ name: 'agent-reviews', params: { websiteId: 'w2' } })
    expect(projectTarget('agent-chat', 'w2')).toEqual({ name: 'agent-home', params: { websiteId: 'w2' } })
    expect(projectTarget('agent-artifact', 'w2')).toEqual({ name: 'agent-home', params: { websiteId: 'w2' } })
    expect(projectTarget('agent-projects', 'w2')).toEqual({ name: 'agent-home', params: { websiteId: 'w2' } })
  })

  it('keeps the board, its panel and filters, and drops the keys that name records', () => {
    const params = { websiteId: 'w2' }
    expect(PROJECT_QUERY_KEYS).toEqual(['prompt', 'check', 'product', 'verdict', 'topic', 'filter', 'url', 'run'])
    expect(projectTarget('analytics', 'w2', { widget: 'pages', filter: 'cited', period: '90d' })).toEqual({
      name: 'analytics',
      params,
      query: { widget: 'pages', period: '90d' },
    })
    expect(
      projectTarget('analytics', 'w2', { widget: 'fact-check', verdict: 'contradicted', topic: 'pricing', engine: 'claude', prompt: 'p1' }),
    ).toEqual({ name: 'analytics', params, query: { widget: 'fact-check', engine: 'claude' } })
    expect(projectTarget('analytics', 'w2', { widget: 'countries', prompt: 'p1', check: '1' })).toEqual({
      name: 'analytics',
      params,
      query: { widget: 'countries' },
    })
    expect(projectTarget('analytics', 'w2', { widget: 'citations', url: 'https://a.test/', provider: 'gpt4' })).toEqual({
      name: 'analytics',
      params,
      query: { widget: 'citations', provider: 'gpt4' },
    })
    expect(projectTarget('analytics', 'w2', { widget: 'products', product: 'p1' })).toEqual({
      name: 'analytics',
      params,
      query: { widget: 'products' },
    })
    // An Ask AI run belongs to one project; Prompt ranking's order is a filter.
    expect(projectTarget('analytics', 'w2', { widget: 'prompt-box', run: 'r1' })).toEqual({
      name: 'analytics',
      params,
      query: { widget: 'prompt-box' },
    })
    expect(projectTarget('analytics', 'w2', { widget: 'ranking', order: 'weakest' })).toEqual({
      name: 'analytics',
      params,
      query: { widget: 'ranking', order: 'weakest' },
    })
    expect(projectTarget('analytics', 'w2')).toEqual({ name: 'analytics', params, query: {} })
  })

  it('leaves the Analytics entry, Settings and Billing where they are', () => {
    const names = [
      'dashboard',
      'settings',
      'settings-project',
      'settings-autopilot',
      'settings-connections',
      'settings-brand-facts',
      'settings-command-center',
      'billing',
    ]
    for (const name of names) expect(projectTarget(name, 'w2')).toBeNull()
  })
})

describe('useProjectSwitch', () => {
  it('moves a list page to the same section of the other project', async () => {
    const ctx = await setup('/projects/w1/agent/reports')
    await expect(ctx.api.switchProject('w2')).resolves.toBe(true)
    expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w2/agent/reports')
    expect(ctx.app.activeWebsite.id).toBe('w2')

    for (const section of ['findings', 'reviews']) {
      const list = await setup(`/projects/w1/agent/${section}`)
      await list.api.switchProject('w2')
      expect(list.router.currentRoute.value.fullPath).toBe(`/projects/w2/agent/${section}`)
    }
  })

  it('opens the project home from a chat or the projects list', async () => {
    let ctx = await setup('/projects/w1/agent/c/c1')
    await ctx.api.switchProject('w2')
    expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w2/agent')

    ctx = await setup('/agent/projects')
    await expect(ctx.api.switchProject('w1')).resolves.toBe(true)
    expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w1/agent')
  })

  it('ignores unknown ids and the project already open', async () => {
    const ctx = await setup('/projects/w1/agent/context')
    await expect(ctx.api.switchProject('nope')).resolves.toBe(false)
    await expect(ctx.api.switchProject('w1')).resolves.toBe(false)
    expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w1/agent/context')
  })

  it("keeps the board's panel and filters when switching there", async () => {
    let ctx = await setup('/projects/w1/analytics?widget=pages&filter=cited&period=7d')
    await expect(ctx.api.switchProject('w2')).resolves.toBe(true)
    expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?widget=pages&period=7d')
    expect(ctx.app.activeWebsite.id).toBe('w2')

    ctx = await setup('/projects/w1/analytics?widget=prompts&prompt=p1')
    await ctx.api.switchProject('w2')
    expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?widget=prompts')
  })

  it('changes the project in place on the Analytics entry and Settings', async () => {
    for (const path of ['/dashboard', '/settings', '/settings/project', '/settings/autopilot', '/billing']) {
      const ctx = await setup(path)
      ctx.app.setActiveWebsite(ctx.app.websites[0])
      await expect(ctx.api.switchProject('w2')).resolves.toBe(true)
      expect(ctx.router.currentRoute.value.fullPath).toBe(path)
      expect(ctx.app.activeWebsite.id).toBe('w2')
      // The project already active: nothing to do.
      await expect(ctx.api.switchProject('w2')).resolves.toBe(false)
    }
  })

  it('leaves everything in place when a guard cancels the navigation', async () => {
    const ctx = await setup('/projects/w1/agent/context')
    ctx.app.setActiveWebsite(ctx.app.websites[0])
    ctx.router.beforeEach(() => false)
    await expect(ctx.api.switchProject('w2')).resolves.toBe(false)
    expect(ctx.app.activeWebsite.id).toBe('w1')
    expect(ctx.router.currentRoute.value.params.websiteId).toBe('w1')
  })
})

beforeEach(() => {
  localStorage.clear()
})
