import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAuthStore } from '@/stores/auth'
import AccountMenu from '../AccountMenu.vue'
import { makeShellRouter } from './__fixtures__/shellRouter'

const mounted = []

async function setup({ user = { id: 7, full_name: 'Farah Chen', email: 'farah@wrenfield.test' } } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.user = user
  const router = makeShellRouter()
  await router.push('/projects/w1/agent/reports')
  await router.isReady()
  const wrapper = mount(AccountMenu, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, router, auth, ui: useAgentUiStore() }
}

async function openMenu(wrapper) {
  await wrapper.find('button.shell-avatar').trigger('click')
  await flushPromises()
  return document.body.querySelector('.ag-portal.ag-menu')
}

const item = (menu, text) => [...menu.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes(text))

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('AccountMenu', () => {
  it('shows the initials, then the name and email', async () => {
    const { wrapper } = await setup()
    const avatar = wrapper.find('button.shell-avatar')
    expect(avatar.attributes('aria-label')).toBe('Account menu')
    expect(avatar.text()).toBe('FC')

    const menu = await openMenu(wrapper)
    const label = menu.querySelector('.ag-menu-label.shell-account')
    expect(label.querySelector('.shell-account-name').textContent).toBe('Farah Chen')
    expect(label.querySelector('.shell-account-email').textContent).toBe('farah@wrenfield.test')
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim())).toEqual([
      'Account',
      'Usage dashboard',
      'Billing',
      'Sign out',
    ])
  })

  it('shows ? and Account until the user loads', async () => {
    const { wrapper } = await setup({ user: null })
    expect(wrapper.find('button.shell-avatar').text()).toBe('?')
    const menu = await openMenu(wrapper)
    expect(menu.querySelector('.shell-account-name').textContent).toBe('Account')
    expect(menu.querySelector('.shell-account-email')).toBeNull()
  })

  it('opens Account, the usage dashboard and Billing', async () => {
    const { wrapper, router } = await setup()
    for (const [text, path] of [
      ['Account', '/settings'],
      ['Usage dashboard', '/settings/usage-dashboard'],
      ['Billing', '/billing'],
    ]) {
      const menu = await openMenu(wrapper)
      // "Command Center" is the design's working name only.
      expect(menu.textContent).not.toContain('Command Center')
      expect(item(menu, text).querySelector('svg')).not.toBeNull()
      item(menu, text).click()
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(path))
    }
  })

  it('signs out, resets the agent UI and goes to login', async () => {
    const { wrapper, router, auth, ui } = await setup()
    const logout = vi.spyOn(auth, 'logout').mockResolvedValue()
    ui.markUnseen('c1')
    ui.openShortcuts()
    const menu = await openMenu(wrapper)
    item(menu, 'Sign out').click()
    await flushPromises()
    expect(logout).toHaveBeenCalled()
    expect(ui.isUnseen('c1')).toBe(false)
    expect(ui.shortcutsOpen).toBe(false)
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/login'))
  })
})
