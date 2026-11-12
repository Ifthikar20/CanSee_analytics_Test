import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import DocsPage from '@/pages/DocsPage.vue'
import { featuredFaqs } from '@/lib/help/faq'
import { useAuthStore } from '@/stores/auth'
import { useHelpStore } from '@/stores/help'

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
  localStorage.clear()
})

async function render({ signedIn = false } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (signedIn) useAuthStore().accessToken = 'token'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/login', component: Blank },
      { path: '/dashboard', component: Blank },
      { path: '/support', name: 'support', component: Blank },
      { path: '/docs', name: 'docs', component: DocsPage },
    ],
  })
  await router.push('/docs')
  await router.isReady()
  const wrapper = mount(DocsPage, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

// The docs describe screens that exist (the page's own rule). The Overview
// and the Sources page became the Analytics board, its widgets and the side
// panel; Google's "AI Overview" is a different thing and stays.
describe('DocsPage', () => {
  it('describes Analytics as one board, not the Overview or the old top bar', async () => {
    const wrapper = await render()
    const text = wrapper.text().replace(/AI Overview/g, '')
    expect(text).not.toMatch(/Overview/)
    expect(text).not.toMatch(/top bar/)
    expect(text).not.toMatch(/Prompt page|prompt page/)

    const nav = wrapper.findAll('nav button, nav a').map((b) => b.text())
    expect(nav).toEqual(expect.arrayContaining(['Analytics', 'Prompt detail', 'Citations']))

    // Older links into the docs still land on their sections.
    expect(wrapper.find('section#overview h2').text()).toBe('Analytics')
    expect(wrapper.find('section#prompt h2').text()).toBe('Prompt detail')
    expect(wrapper.find('section#sources h2').text()).toBe('Citations')
    expect(wrapper.find('section#overview').text()).toContain(
      'The board starts with a row of four small cards (Watch, Asked and answered, Rank in AI answers and Visibility score), then Ask AI and Prompt ranking.',
    )
    expect(wrapper.find('section#quickstart').text()).toContain('On Analytics, choose Add prompts in Prompts')
  })
})

describe('DocsPage help', () => {
  it('shows the help center\'s featured questions in the rail, and opens all of them in the drawer', async () => {
    const wrapper = await render()
    const rail = wrapper.find('.dx-rail')
    expect(rail.findAll('details.faq summary').map((s) => s.text())).toEqual(featuredFaqs('docs').map((f) => f.q))
    const all = rail.find('button.dx-rail-all')
    expect(all.text()).toBe('All questions')
    await all.trigger('click')
    await flushPromises()
    expect(useHelpStore().isOpen).toBe(true)
    expect(document.body.querySelector('.help-drawer [role="dialog"], .help-drawer')).not.toBeNull()
  })

  it('has the sections the help answers link to', async () => {
    const wrapper = await render()
    for (const id of ['ask-ai', 'agent', 'research', 'findings', 'reports']) {
      expect(wrapper.find(`section#${id} h2`).exists(), id).toBe(true)
    }
    expect(wrapper.find('#autopilot h3').text()).toBe('Autopilot')
    expect(wrapper.find('#billing').text()).toContain('20 prompt runs a month')
    expect(wrapper.find('section#reports').text()).toContain('Change log since the last run')
  })

  it('offers Sign in to visitors and Open app to signed-in users', async () => {
    let wrapper = await render()
    expect(wrapper.find('.dx-cta').text()).toBe('Sign in')
    expect(wrapper.find('.dx-cta').attributes('href')).toBe('/login')
    while (mounted.length) mounted.pop().unmount()
    localStorage.clear()
    wrapper = await render({ signedIn: true })
    expect(wrapper.find('.dx-cta').text()).toBe('Open app')
    expect(wrapper.find('.dx-cta').attributes('href')).toBe('/dashboard')
  })
})
