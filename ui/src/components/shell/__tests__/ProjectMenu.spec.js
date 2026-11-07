import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAppStore } from '@/stores/app'
import ProjectMenu from '../ProjectMenu.vue'
import { SITES, makeShellRouter } from './__fixtures__/shellRouter'

const mounted = []

async function setup(path, { sites = SITES } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = useAppStore()
  app.setWebsites(sites.map((s) => ({ ...s })))
  const router = makeShellRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(ProjectMenu, {
    props: { website: app.activeWebsite },
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  return { wrapper, router, app, ui: useAgentUiStore() }
}

async function openMenu(wrapper) {
  await wrapper.find('button.shell-chip').trigger('click')
  await flushPromises()
  return document.body.querySelector('.ag-portal.ag-menu')
}

const item = (menu, text) => [...menu.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes(text))

async function choose(wrapper, text) {
  const menu = await openMenu(wrapper)
  item(menu, text).click()
  await flushPromises()
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('ProjectMenu', () => {
  it('shows the project and lists every project, the current one marked', async () => {
    const { wrapper } = await setup('/projects/w1/analytics')
    const chip = wrapper.find('button.shell-chip')
    expect(chip.attributes('aria-label')).toBe('Project: Wrenfield')
    expect(chip.find('.shell-chip-text').text()).toBe('Wrenfield')
    expect(chip.find('svg.shell-chip-caret').exists()).toBe(true)

    const menu = await openMenu(wrapper)
    expect(menu.querySelector('.ag-menu-label').textContent).toBe('Projects')
    expect(item(menu, 'Wrenfield').textContent).toContain('(current)')
    expect(item(menu, 'Acme').textContent).not.toContain('(current)')
    expect(item(menu, 'Add project')).toBeTruthy()
    expect(item(menu, 'Project settings')).toBeTruthy()
  })

  it('reads No project without one, and offers only Add project', async () => {
    const { wrapper } = await setup('/settings', { sites: [] })
    expect(wrapper.find('button.shell-chip').attributes('aria-label')).toBe('Project: No project')
    const menu = await openMenu(wrapper)
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim())).toEqual(['Add project'])
  })

  it('keeps an agent list in its section and sends a chat to the agent home', async () => {
    let ctx = await setup('/projects/w1/agent/reports')
    await choose(ctx.wrapper, 'Acme')
    await vi.waitFor(() => expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w2/agent/reports'))

    ctx = await setup('/projects/w1/agent/c/c1')
    await choose(ctx.wrapper, 'Acme')
    await vi.waitFor(() => expect(ctx.router.currentRoute.value.fullPath).toBe('/projects/w2/agent'))
  })

  it("keeps the board and its panel, and drops the old project's records", async () => {
    const { wrapper, router, app } = await setup('/projects/w1/analytics?widget=countries&prompt=p1&check=1&engine=google')
    await choose(wrapper, 'Acme')
    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/projects/w2/analytics?widget=countries&engine=google'),
    )
    expect(app.activeWebsite.id).toBe('w2')
  })

  it('changes the project in place on a settings page', async () => {
    const { wrapper, router, app } = await setup('/settings/project')
    expect(app.activeWebsite.id).toBe('w1')
    await choose(wrapper, 'Acme')
    expect(router.currentRoute.value.fullPath).toBe('/settings/project')
    expect(app.activeWebsite.id).toBe('w2')
  })

  it('opens Add project and the project settings', async () => {
    const { wrapper, router, ui } = await setup('/projects/w1/analytics')
    await choose(wrapper, 'Add project')
    expect(ui.addProjectOpen).toBe(true)

    await choose(wrapper, 'Project settings')
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings/project'))
  })
})
