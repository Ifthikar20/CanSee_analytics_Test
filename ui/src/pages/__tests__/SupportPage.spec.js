import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { featuredFaqs } from '@/lib/help/faq'
import { useAuthStore } from '@/stores/auth'
import { useHelpStore } from '@/stores/help'

vi.mock('/images/cansee-logo.png', () => ({ default: '/images/cansee-logo.png' }))
const { default: SupportPage } = await import('../SupportPage.vue')
const supportSource = (await import('../SupportPage.vue?raw')).default

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function render(path = '/support', { signedIn = false } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (signedIn) useAuthStore().accessToken = 'token'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: Blank },
      { path: '/dashboard', name: 'dashboard', component: Blank },
      { path: '/docs', name: 'docs', component: Blank },
      { path: '/support', name: 'support', component: SupportPage },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(SupportPage, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  await nextTick()
  return { wrapper, router, help: useHelpStore() }
}

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
  localStorage.clear()
  window.history.replaceState(null, '')
})

describe('SupportPage', () => {
  it('shows the help center\'s featured questions, with none of the stale copy', async () => {
    const { wrapper } = await render()
    const questions = wrapper.findAll('.sp-faq-item dt').map((dt) => dt.text())
    expect(questions).toEqual(featuredFaqs('support').map((f) => f.q))
    const text = wrapper.text()
    expect(text).not.toMatch(/trial button/i)
    expect(text).not.toMatch(/Overview/)
    expect(text).toContain('Choose your plan again')
    expect(text).toContain('20 prompt runs a month')
  })

  it('opens the help center from its buttons', async () => {
    const { wrapper, help } = await render()
    const open = wrapper.findAll('button').find((b) => b.text() === 'Open help center')
    expect(open.attributes('aria-haspopup')).toBe('dialog')
    await open.trigger('click')
    await flushPromises()
    expect(help.isOpen).toBe(true)
    expect(document.body.querySelector('.help-drawer')).not.toBeNull()

    help.close()
    await flushPromises()
    await wrapper.findAll('button').find((b) => b.text() === 'See all questions').trigger('click')
    expect(help.isOpen).toBe(true)
  })

  it('opens the drawer at the question named by ?faq=', async () => {
    const { help } = await render('/support?faq=ts-paid')
    expect(help.isOpen).toBe(true)
    await flushPromises()
    await nextTick()
    const trigger = document.getElementById('help-plans-ts-paid')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(trigger)
  })

  it('ignores an unknown ?faq=', async () => {
    const { help } = await render('/support?faq=nope')
    expect(help.isOpen).toBe(false)
  })

  it('emails support with the subject filled in', async () => {
    const { wrapper } = await render()
    expect(wrapper.find('a.sp-cta').attributes('href')).toBe(
      `mailto:support@cansee.ai?subject=${encodeURIComponent('Cansee support request')}`,
    )
  })

  it('goes Back to the app for a signed-in user with no page before this one', async () => {
    const { wrapper, router } = await render('/support', { signedIn: true })
    await wrapper.find('button.sp-back').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/dashboard')
  })

  it('goes Back to the home page for a visitor with no page before this one', async () => {
    const { wrapper, router } = await render('/support')
    await wrapper.find('button.sp-back').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('goes Back to the page before when there is one', async () => {
    const { wrapper, router } = await render('/support', { signedIn: true })
    window.history.replaceState({ back: '/docs' }, '')
    const back = vi.spyOn(router, 'back')
    await wrapper.find('button.sp-back').trigger('click')
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('uses the theme tokens, not a fixed light palette', () => {
    const style = supportSource.slice(supportSource.indexOf('<style'))
    expect(style).toMatch(/--sp-bg: var\(--card\)/)
    expect(style).toMatch(/--sp-fg: var\(--foreground\)/)
    expect(style).toMatch(/--sp-muted: var\(--muted-foreground\)/)
    expect(style).not.toMatch(/--sp-bg: #fff/i)
    expect(style).not.toMatch(/--sp-fg: #0a0a0a/i)
    // No literal colour at all: the accent and the page come from tokens.
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(style).not.toMatch(/rgba?\(/)
    expect(style).toMatch(/--sp-accent: var\(--signal-text\)/)
  })

  it('sits on the flat paper page, with no film behind it', () => {
    expect(supportSource).not.toMatch(/WatercolorBackdrop|<video/)
    const style = supportSource.slice(supportSource.indexOf('<style'))
    expect(style).toMatch(/background: var\(--background\)/)
  })
})
