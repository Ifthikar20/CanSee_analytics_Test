import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { commandCenter, mineOnly } from '@/lib/analytics/__tests__/__fixtures__/commandCenter'

const agentApi = vi.hoisted(() => ({ commandCenter: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: agentApi }))

const { default: CommandCenterPage } = await import('../CommandCenterPage.vue')

const Blank = defineComponent({ render: () => h('div') })
const mounted = []
const ok = (data) => ({ success: true, data })
const apiError = (status, code, message) => ({ response: { status, data: { error: { code, message } } }, displayMessage: message })

async function mountPage(path = '/settings/usage-dashboard') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/agent', name: 'agent', component: Blank },
      { path: '/settings', name: 'settings', component: Blank },
      { path: '/settings/usage-dashboard', name: 'settings-command-center', component: CommandCenterPage },
      { path: '/settings/:rest(.*)', component: Blank },
      { path: '/billing', name: 'billing', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router], stubs: { VizChart: true } } })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

const charts = (wrapper) => wrapper.findAllComponents({ name: 'VizChart' })
const chartIds = (wrapper) => charts(wrapper).map((c) => c.props('spec').id)
const select = (wrapper, label) => wrapper.findAll('label.an-select').find((l) => l.find('.an-select-label').text() === label)

beforeEach(() => {
  localStorage.clear()
  agentApi.commandCenter.mockReset()
  agentApi.commandCenter.mockResolvedValue(ok(commandCenter()))
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
})

describe('CommandCenterPage', () => {
  it('shows the organization by default for an admin, with tiles, charts and top users', async () => {
    const { wrapper } = await mountPage()
    expect(agentApi.commandCenter).toHaveBeenCalledWith({ period: '30d' })
    expect(wrapper.find('.ss-nav-item.is-active').text()).toBe('Usage dashboard')
    expect(wrapper.find('h1').text()).toBe('Usage dashboard')
    expect(wrapper.find('.an-eyebrow').text()).toBe('Workspace')
    expect(wrapper.find('.an-sub').text()).toBe('How Acme uses the agents and the AI allowance, from recorded runs and usage.')
    expect(wrapper.text()).not.toContain('Command Center')

    const tiles = wrapper.findAll('.viz-stat')
    expect(tiles.map((t) => t.find('.viz-stat-label').text())).toEqual(['Agent runs', 'Active users', 'Drafts saved', 'AI spend', 'Failed runs'])
    expect(tiles[0].text()).toContain('120')
    expect(tiles[0].text()).toContain('+22.4% vs previous 7 days')
    expect(tiles[3].text()).toContain('$12.35')
    expect(tiles[4].text()).toContain('6 of 120')

    expect(chartIds(wrapper)).toEqual(['command.runs', 'command.users', 'command.teams', 'command.spend', 'command.agents'])
    const users = wrapper.find('.cc-users')
    expect(users.find('h2').text()).toBe('Top users')
    expect(users.findAll('thead th').map((t) => t.text())).toEqual(['Name', 'Role', 'Runs', 'Active days', 'AI spend', 'Last active'])
    const rows = users.findAll('tbody tr')
    expect(rows[0].text()).toContain('Site Owner')
    expect(rows[0].text()).toContain('owner@example.com')
    expect(rows[0].text()).toContain('Owner')
    expect(rows[1].text()).toContain('Lee (former member)')
  })

  it('sends the scope, project and period from the query', async () => {
    const { wrapper, router } = await mountPage()
    const scope = select(wrapper, 'Scope')
    expect(scope.findAll('option').map((o) => o.text())).toEqual(['Your activity', 'Acme'])
    expect(scope.find('select').element.value).toBe('org')

    agentApi.commandCenter.mockResolvedValue(ok(mineOnly({ scopes: commandCenter().scopes })))
    await scope.find('select').setValue('me')
    await flushPromises()
    expect(router.currentRoute.value.query.scope).toBe('me')
    expect(agentApi.commandCenter).toHaveBeenLastCalledWith({ period: '30d', scope: 'me' })
    expect(wrapper.find('.an-sub').text()).toBe('How you use the agents and the AI allowance, from recorded runs and usage.')
    expect(wrapper.find('.cc-users').exists()).toBe(false)

    const project = select(wrapper, 'Project')
    expect(project.findAll('option').map((o) => o.text())).toEqual(['All projects', 'Notion', 'Acme shop'])
    await project.find('select').setValue('c9')
    await flushPromises()
    expect(agentApi.commandCenter).toHaveBeenLastCalledWith({ period: '30d', scope: 'me', website_id: 'c9' })

    await select(wrapper, 'Period').find('select').setValue('90d')
    await flushPromises()
    expect(agentApi.commandCenter).toHaveBeenLastCalledWith({ period: '90d', scope: 'me', website_id: 'c9' })
  })

  it('hides the scope choice when there is only your own', async () => {
    agentApi.commandCenter.mockResolvedValue(ok(mineOnly()))
    const { wrapper } = await mountPage()
    expect(select(wrapper, 'Scope')).toBeUndefined()
    expect(wrapper.find('.cc-users').exists()).toBe(false)
  })

  it('drops a scope the user may not see and a project outside the scope', async () => {
    agentApi.commandCenter.mockImplementation(async (params) => {
      if (params.scope === 'org') throw apiError(403, 'permission_denied', 'Only organization owners and admins can see the whole organization.')
      if (params.website_id === 'zz') throw apiError(404, 'not_found', 'Not found.')
      return ok(mineOnly())
    })
    const { router } = await mountPage('/settings/usage-dashboard?scope=org')
    await flushPromises()
    expect(router.currentRoute.value.query.scope).toBeUndefined()
    const again = await mountPage('/settings/usage-dashboard?project=zz')
    await flushPromises()
    expect(again.router.currentRoute.value.query.project).toBeUndefined()
  })

  it('says when nothing ran in the window', async () => {
    agentApi.commandCenter.mockResolvedValue(ok(mineOnly({ empty_reason: 'no_activity' })))
    const { wrapper } = await mountPage('/settings/usage-dashboard?period=7d')
    const state = wrapper.find('.viz-state')
    expect(state.text()).toContain('No agent runs or AI use in the last 7 days.')
    expect(state.text()).toContain('Runs and AI spend show up here when someone uses the agent or checks prompts.')
    expect(state.find('a').text()).toBe('Open the agent')
    expect(wrapper.findAll('.viz-stat')).toHaveLength(0)
  })

  it('shows a load error with a retry', async () => {
    agentApi.commandCenter.mockRejectedValueOnce(apiError(500, 'server_error', 'Down.'))
    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain("We couldn't load the usage dashboard.")
    agentApi.commandCenter.mockResolvedValueOnce(ok(commandCenter()))
    await wrapper.find('.viz-state button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.viz-stat')).toHaveLength(5)
  })
})
