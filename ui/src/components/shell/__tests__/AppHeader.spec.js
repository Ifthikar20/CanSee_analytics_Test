import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { setLastChat } from '@/lib/agent/storage'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { SITES, makeShellRouter } from './__fixtures__/shellRouter'

const feedback = vi.hoisted(() => ({ enabled: false, real: false }))

// The logo is a public asset; outside a dev server the SFC compiler turns its
// absolute URL into an import, which the test resolver cannot find.
vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))
// The feedback button exists only in builds with a feedback service. With no
// tickets in this browser the real widget never calls the service.
vi.mock('@/api/feedbackClient', () => ({
  get FEEDBACK_ENABLED() {
    return feedback.enabled
  },
  loadTokens: () => [],
  rememberToken: () => {},
  default: {},
}))
// A stub, or the real widget where a case needs its dialog.
vi.mock('@/components/feedback/FeedbackWidget.vue', async (importOriginal) => {
  const vue = await import('vue')
  const { default: FeedbackWidget } = await importOriginal()
  return {
    default: vue.defineComponent({
      render: () =>
        feedback.real
          ? vue.h(FeedbackWidget)
          : vue.h('button', { type: 'button', class: 'stub-feedback', title: 'Help & feedback' }),
    }),
  }
})

const { default: AppHeader } = await import('../AppHeader.vue')

const mounted = []

async function setup(path = '/projects/w1/analytics', { sites = SITES, websiteId } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = useAppStore()
  app.setWebsites(sites.map((s) => ({ ...s })))
  const auth = useAuthStore()
  auth.user = { id: 7, full_name: 'Farah Chen', email: 'farah@wrenfield.test' }
  const router = makeShellRouter()
  await router.push(path)
  await router.isReady()
  // AppShell passes the URL's project, else the active one.
  const wid = websiteId !== undefined ? websiteId : (router.currentRoute.value.params.websiteId ?? app.activeWebsite?.id ?? null)
  const wrapper = mount(AppHeader, {
    props: { websiteId: wid === null ? null : String(wid) },
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router, app, auth, ui: useAgentUiStore() }
}

const navLinks = (wrapper) => wrapper.findAll('.shell-nav a')
const sheetOf = (wrapper) => wrapper.find('#shell-sheet')

function menuItem(text) {
  const menu = document.body.querySelector('.ag-portal.ag-menu')
  return [...menu.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes(text))
}

function escape(target) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

// onClickOutside takes one click per task.
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

async function press(el) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true }))
  el.click()
  await nextTick()
  await nextTask()
}

// jsdom has no matchMedia; this one can change a query's answer.
let media = null
function stubMatchMedia() {
  const real = window.matchMedia
  const lists = []
  window.matchMedia = (query) => {
    const listeners = new Set()
    const list = {
      matches: false,
      media: query,
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
      addListener() {},
      removeListener() {},
      fire: (matches) => listeners.forEach((fn) => fn({ matches, media: query })),
    }
    lists.push(list)
    return list
  }
  media = {
    change: (query, matches) => lists.filter((l) => l.media === query).forEach((l) => l.fire(matches)),
    restore: () => {
      if (real) window.matchMedia = real
      else delete window.matchMedia
    },
  }
  return media
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  feedback.enabled = false
  feedback.real = false
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  media?.restore()
  media = null
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

describe('AppHeader links', () => {
  it('links Analytics to the board with no panel, Agent to the last chat, and Settings', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics?widget=countries')
    expect(navLinks(wrapper).map((a) => a.text())).toEqual(['Analytics', 'Agent', 'Settings'])
    expect(navLinks(wrapper).map((a) => a.attributes('href'))).toEqual([
      '/projects/w1/analytics',
      '/projects/w1/agent',
      '/settings',
    ])
    expect(wrapper.find('a.shell-home').attributes('href')).toBe('/projects/w1/analytics')

    // The last chat lives in storage: the link reads it again on the next navigation.
    setLastChat(7, 'w1', 'c42')
    await router.push('/projects/w1/analytics')
    await flushPromises()
    expect(navLinks(wrapper)[1].attributes('href')).toBe('/projects/w1/agent/c/c42')
  })

  it('goes to /dashboard and /agent without a project', async () => {
    const { wrapper } = await setup('/settings', { sites: [] })
    expect(navLinks(wrapper).map((a) => a.attributes('href'))).toEqual(['/dashboard', '/agent', '/settings'])
    expect(wrapper.find('a.shell-home').attributes('href')).toBe('/dashboard')
    expect(wrapper.find('button.shell-chip').attributes('aria-label')).toBe('Project: No project')
  })

  it('marks the current section, never the logo', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics')
    const current = () => wrapper.findAll('.shell-nav [aria-current="page"]').map((a) => a.text())
    expect(current()).toEqual(['Analytics'])
    expect(wrapper.find('.shell-nav a.is-active').text()).toBe('Analytics')
    expect(wrapper.find('a.shell-home').attributes('aria-current')).toBeUndefined()

    await router.push('/projects/w1/agent/reports')
    await flushPromises()
    expect(current()).toEqual(['Agent'])
    await router.push('/billing')
    await flushPromises()
    expect(current()).toEqual(['Settings'])
  })
})

describe('AppHeader phone sheet', () => {
  it('lists the links, help and the theme behind the menu button', async () => {
    const { wrapper, router } = await setup('/projects/w1/agent')
    const burger = wrapper.find('button.shell-burger')
    expect(burger.attributes('aria-label')).toBe('Open menu')
    expect(burger.attributes('aria-controls')).toBe('shell-sheet')
    expect(burger.attributes('aria-expanded')).toBe('false')
    expect(sheetOf(wrapper).isVisible()).toBe(false)

    await burger.trigger('click')
    expect(burger.attributes('aria-expanded')).toBe('true')
    expect(burger.attributes('aria-label')).toBe('Close menu')
    const sheet = sheetOf(wrapper)
    expect(sheet.isVisible()).toBe(true)
    expect(sheet.element.tagName).toBe('NAV')
    expect(sheet.attributes('aria-label')).toBe('Main')
    expect(sheet.findAll('a').map((a) => a.text())).toEqual(['Analytics', 'Agent', 'Settings', 'Docs', 'Support'])
    expect(sheet.findAll('button').map((b) => b.text())).toEqual(['Keyboard shortcuts', 'Switch to dark theme'])
    expect(sheet.findAll('[aria-current="page"]').map((a) => a.text())).toEqual(['Agent'])
    const docs = sheet.findAll('a')[3]
    expect([docs.attributes('href'), docs.attributes('target')]).toEqual(['/docs', '_blank'])

    // The theme row keeps the sheet open; a link closes it.
    await sheet.findAll('button')[1].trigger('click')
    expect(sheet.isVisible()).toBe(true)
    expect(sheet.findAll('button')[1].text()).toBe('Switch to light theme')
    await sheet.findAll('a')[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w1/analytics')
    expect(sheet.isVisible()).toBe(false)
    expect(burger.attributes('aria-expanded')).toBe('false')
  })

  it('closes on navigation', async () => {
    const { wrapper, router } = await setup('/projects/w1/analytics')
    await wrapper.find('button.shell-burger').trigger('click')
    expect(sheetOf(wrapper).isVisible()).toBe(true)
    await router.push('/settings')
    await flushPromises()
    expect(sheetOf(wrapper).isVisible()).toBe(false)
  })

  it('closes on Escape and gives focus back to the menu button', async () => {
    const { wrapper } = await setup('/projects/w1/analytics')
    const burger = wrapper.find('button.shell-burger')
    await burger.trigger('click')
    const link = sheetOf(wrapper).find('a').element
    link.focus()
    expect(document.activeElement).toBe(link)

    const event = escape(link)
    await nextTick()
    // Taken, so the same key does not also stop a running chat.
    expect(event.defaultPrevented).toBe(true)
    expect(sheetOf(wrapper).isVisible()).toBe(false)
    expect(document.activeElement).toBe(burger.element)

    // Closed, Escape is left to others.
    expect(escape(document.body).defaultPrevented).toBe(false)
  })

  it('opens the keyboard shortcuts and closes, with focus on the menu button', async () => {
    const { wrapper, ui } = await setup('/projects/w1/analytics')
    const burger = wrapper.find('button.shell-burger')
    await burger.trigger('click')
    const row = sheetOf(wrapper)
      .findAll('button')
      .find((b) => b.text() === 'Keyboard shortcuts')
    row.element.focus()
    await row.trigger('click')
    expect(ui.shortcutsOpen).toBe(true)
    expect(sheetOf(wrapper).isVisible()).toBe(false)
    // Before the dialog opens, so closing it hands focus back here, not to the hidden row.
    expect(document.activeElement).toBe(burger.element)
  })

  it('leaves focus on the menu button when a link closes the sheet', async () => {
    const { wrapper, router } = await setup('/projects/w1/agent')
    const burger = wrapper.find('button.shell-burger')
    await burger.trigger('click')
    const link = sheetOf(wrapper)
      .findAll('a')
      .find((a) => a.text() === 'Settings')
    link.element.focus()
    await link.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/settings')
    expect(sheetOf(wrapper).isVisible()).toBe(false)
    expect(document.activeElement).toBe(burger.element)
  })

  it('closes on a click outside it, and the menu button closes it once', async () => {
    const { wrapper } = await setup('/projects/w1/analytics')
    const burger = wrapper.find('button.shell-burger')
    await press(burger.element)
    expect(sheetOf(wrapper).isVisible()).toBe(true)
    // A click inside keeps it open.
    await press(sheetOf(wrapper).find('.shell-sheet-sep').element)
    expect(sheetOf(wrapper).isVisible()).toBe(true)

    await press(document.body)
    expect(sheetOf(wrapper).isVisible()).toBe(false)
    expect(burger.attributes('aria-expanded')).toBe('false')

    await press(burger.element)
    expect(sheetOf(wrapper).isVisible()).toBe(true)
    // The outside-click handler leaves the button to its own toggle.
    await press(burger.element)
    expect(sheetOf(wrapper).isVisible()).toBe(false)
    expect(burger.attributes('aria-expanded')).toBe('false')
  })

  it('closes when the window widens past 900px', async () => {
    const queries = stubMatchMedia()
    const { wrapper } = await setup('/projects/w1/analytics')
    await wrapper.find('button.shell-burger').trigger('click')
    expect(sheetOf(wrapper).isVisible()).toBe(true)
    queries.change('(min-width: 901px)', true)
    await nextTick()
    expect(sheetOf(wrapper).isVisible()).toBe(false)
  })

  it('opens Help & feedback from the sheet when the build has feedback', async () => {
    feedback.enabled = true
    feedback.real = true
    const { wrapper } = await setup('/projects/w1/agent')
    const burger = wrapper.find('button.shell-burger')
    await burger.trigger('click')
    const rows = () => sheetOf(wrapper).findAll('button')
    expect(rows().map((b) => b.text())).toEqual(['Help & feedback', 'Keyboard shortcuts', 'Switch to dark theme'])
    expect(document.body.querySelector('.fw-card')).toBeNull()

    rows()[0].element.focus()
    await rows()[0].trigger('click')
    await flushPromises()
    // The bar's one widget opens its dialog; its own button is hidden at this width.
    expect(document.body.querySelector('.fw-card h2').textContent).toBe('Help & feedback')
    expect(wrapper.findAll('button[title="Help & feedback"]')).toHaveLength(1)
    expect(sheetOf(wrapper).isVisible()).toBe(false)
    expect(document.activeElement).toBe(burger.element)
  })
})

describe('AppHeader controls', () => {
  it('switches between the light and dark theme', async () => {
    const { wrapper, app } = await setup()
    const button = wrapper.find('button.shell-theme')
    expect(button.attributes('aria-label')).toBe('Switch to dark theme')
    await button.trigger('click')
    expect(app.theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(button.attributes('aria-label')).toBe('Switch to light theme')
    app.setTheme('light')
  })

  it('opens the keyboard shortcuts, Docs and Support from the help menu', async () => {
    const { wrapper, ui } = await setup()
    await wrapper.find('button[aria-label="Help"]').trigger('click')
    await flushPromises()
    const docs = menuItem('Docs')
    const support = menuItem('Support')
    expect(docs.tagName).toBe('A')
    expect([docs.getAttribute('href'), docs.getAttribute('target')]).toEqual(['/docs', '_blank'])
    expect([support.getAttribute('href'), support.getAttribute('target')]).toEqual(['/support', '_blank'])
    expect(menuItem('Keyboard shortcuts').querySelector('.ag-kbd')).not.toBeNull()

    menuItem('Keyboard shortcuts').click()
    await flushPromises()
    expect(ui.shortcutsOpen).toBe(true)
  })

  it('shows the organization chip only for organization sessions', async () => {
    const { wrapper, auth, router } = await setup()
    expect(wrapper.find('.shell-org').exists()).toBe(false)

    auth.session = { org: { name: 'Acme Group', role: 'member' } }
    await nextTick()
    const chips = () => wrapper.findAll('.shell-context button.shell-chip')
    expect(chips().map((b) => b.attributes('aria-label'))).toEqual(['Organization: Acme Group', 'Project: Wrenfield'])
    const org = chips()[0]
    expect(org.find('.shell-org-mark').text()).toBe('A')
    expect(org.find('.shell-role').text()).toBe('Member')

    await org.trigger('click')
    await flushPromises()
    expect(menuItem('Team members')).toBeTruthy()
    expect(menuItem('Domains and SSO')).toBeUndefined()
    menuItem('Team members').click()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/settings?section=team')

    auth.session = { org: { name: 'Acme Group', role: 'admin' } }
    await nextTick()
    expect(wrapper.find('.shell-role').text()).toBe('Admin')
    await chips()[0].trigger('click')
    await flushPromises()
    expect(menuItem('Domains and SSO')).toBeTruthy()
  })

  it("holds the screenshot's controls and no inbox", async () => {
    const { wrapper } = await setup()
    const bar = wrapper.find('.shell-bar-inner')
    const controls = bar.findAll('a, button').map((el) => el.attributes('aria-label') || el.text())
    expect(controls).toEqual([
      'Cansee home',
      'Project: Wrenfield',
      'Analytics',
      'Agent',
      'Settings',
      'Help',
      'Switch to dark theme',
      'Account menu',
      'Open menu',
    ])
    expect(wrapper.find('button[aria-label^="Activity"]').exists()).toBe(false)
    expect(wrapper.find('.stub-feedback').exists()).toBe(false)
    expect(wrapper.find('img.shell-logo').attributes('alt')).toBe('')
    expect(wrapper.find('.shell-rule').attributes('aria-hidden')).toBe('true')
  })

  it('puts the feedback button before help when the build has feedback', async () => {
    feedback.enabled = true
    const { wrapper } = await setup()
    const tools = wrapper.find('.shell-tools').findAll('button')
    expect(tools.map((b) => b.attributes('aria-label') || b.attributes('title'))).toEqual(['Help & feedback', 'Help'])
  })
})
