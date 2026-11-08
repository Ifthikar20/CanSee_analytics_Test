import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useHelpStore } from '@/stores/help'
import HelpDrawer from '../HelpDrawer.vue'

const Blank = defineComponent({ render: () => h('div') })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/docs', name: 'docs', component: Blank },
      { path: '/support', name: 'support', component: Blank },
      {
        path: '/projects/:websiteId',
        meta: { section: 'analytics' },
        children: [{ path: 'analytics', name: 'analytics', component: Blank }],
      },
      {
        path: '/projects/:websiteId/agent',
        meta: { section: 'agent' },
        children: [{ path: 'findings', name: 'agent-findings', component: Blank, meta: { title: 'Findings' } }],
      },
    ],
  })
}

const mounted = []

async function setup(path = '/projects/w1/analytics', props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = makeRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(HelpDrawer, { props, global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, router, help: useHelpStore() }
}

async function openDrawer(help, options) {
  help.open(options)
  await flushPromises()
  await nextTick()
}

const drawer = () => document.body.querySelector('.help-drawer')
const search = () => document.getElementById('help-search-input')
const count = () => document.getElementById('help-search-count')
const triggers = (root = drawer()) => [...root.querySelectorAll('.help-faq-trigger')]
const footRows = () => [...drawer().querySelectorAll('.help-foot .help-foot-row')]
const footRow = (text) => footRows().find((el) => el.textContent.trim() === text)
const groupTitled = (title) =>
  [...drawer().querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent.trim() === title)

async function type(value) {
  const input = search()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function escape(target = document.activeElement) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('HelpDrawer', () => {
  it('opens as a labelled dialog with focus in the search field', async () => {
    const { help } = await setup()
    expect(drawer()).toBeNull()
    await openDrawer(help)

    const el = drawer()
    expect(el.getAttribute('role')).toBe('dialog')
    expect(document.getElementById(el.getAttribute('aria-labelledby')).textContent).toBe('Help')
    expect(document.getElementById(el.getAttribute('aria-describedby')).textContent).toMatch(/common questions/)
    expect(document.activeElement).toBe(search())
    expect(search().type).toBe('search')
    expect(document.querySelector('label[for="help-search-input"]').textContent).toBe('Search help')
    expect(el.querySelector('[aria-label="Close help"]')).not.toBeNull()
  })

  it('lists every group, and the questions for the panel in view', async () => {
    const { help } = await setup('/projects/w1/analytics?widget=citations')
    await openDrawer(help)
    const page = groupTitled('On this page')
    expect(triggers(page).map((t) => t.textContent.trim())).toEqual(['What do retrievals and citation rate mean?'])
    expect(groupTitled('Getting started')).toBeTruthy()
    expect(groupTitled('Plans and prompt runs')).toBeTruthy()
  })

  it('shows the Findings questions on the Findings page', async () => {
    const { help } = await setup('/projects/w1/agent/findings')
    await openDrawer(help)
    expect(triggers(groupTitled('On this page')).map((t) => t.textContent.trim())).toEqual([
      'What are Findings, and who sees them?',
    ])
  })

  it('has no page list on Support, and no link to the page it is on', async () => {
    const { help } = await setup('/support')
    await openDrawer(help)
    expect(groupTitled('On this page')).toBeUndefined()
    expect(footRow('Support')).toBeUndefined()
    expect(footRow('Docs').getAttribute('href')).toBe('/docs')
  })

  it('expands a question to show its answer as text', async () => {
    const { help } = await setup()
    await openDrawer(help)
    const trigger = triggers(groupTitled('Plans and prompt runs'))[0]
    expect(trigger.textContent).toContain('What does the Free plan include?')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.click()
    await flushPromises()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const panel = document.getElementById(trigger.getAttribute('aria-controls'))
    expect(panel.textContent).toContain('20 prompt runs a month')
    expect(panel.querySelector('script, [innerHTML]')).toBeNull()
    const docs = panel.querySelector('.help-faq-docs')
    expect([docs.getAttribute('href'), docs.getAttribute('target')]).toEqual(['/docs#billing', '_blank'])
  })

  it('filters as you type, counts the answers, and says when none match', async () => {
    const { help } = await setup()
    await openDrawer(help)
    expect(count().getAttribute('aria-live')).toBe('polite')

    await type('paywall')
    expect(count().textContent.trim()).toBe('1 answer')
    expect(groupTitled('On this page')).toBeUndefined()
    expect(triggers().map((t) => t.textContent.trim())).toEqual(['I paid, but I still see the plans screen.'])

    await type('engines')
    expect(count().textContent.trim()).toMatch(/^\d+ answers$/)

    await type('zebra quantum')
    expect(count().textContent.trim()).toBe('No answers match')
    expect(triggers()).toHaveLength(0)
    const empty = drawer().querySelector('.help-empty')
    expect(empty.textContent).toContain('No answers match "zebra quantum".')
    expect(empty.querySelector('a').getAttribute('href')).toMatch(/^mailto:support@cansee\.ai/)
  })

  it('clears the search on the first Escape and closes on the second', async () => {
    const { help } = await setup()
    await openDrawer(help)
    await type('paywall')
    escape(search())
    await flushPromises()
    expect(help.isOpen).toBe(true)
    expect(help.query).toBe('')
    expect(document.activeElement).toBe(search())

    escape(search())
    await flushPromises()
    expect(help.isOpen).toBe(false)
    expect(drawer()).toBeNull()
  })

  it('opens at one question, expanded and focused', async () => {
    const { help } = await setup()
    await openDrawer(help, { faqId: 'ts-paid' })
    await nextTick()
    const trigger = document.getElementById('help-plans-ts-paid')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(trigger)
    expect(help.focusId).toBeNull()
  })

  it('links Email support with the page in the subject, and Docs and Support in a new tab', async () => {
    const { help } = await setup('/projects/w1/agent/findings')
    await openDrawer(help)
    const mail = footRow('Email support').getAttribute('href')
    expect(mail).toBe(`mailto:support@cansee.ai?subject=${encodeURIComponent('Cansee support request (Findings)')}`)
    expect([footRow('Docs').getAttribute('href'), footRow('Docs').getAttribute('target')]).toEqual(['/docs', '_blank'])
    expect([footRow('Support').getAttribute('href'), footRow('Support').getAttribute('target')]).toEqual([
      '/support',
      '_blank',
    ])
    expect(drawer().querySelector('nav.help-foot').getAttribute('aria-label')).toBe('More help')
  })

  it('hides Send feedback, Keyboard shortcuts and Show tips again when nothing provides them', async () => {
    const { help } = await setup()
    await openDrawer(help)
    expect(footRows().map((el) => el.textContent.trim())).toEqual(['Email support', 'Docs', 'Support'])
  })

  it('closes first, then opens the shortcuts, the tips or the feedback dialog', async () => {
    const openShortcuts = vi.fn()
    const resetTips = vi.fn()
    const openFeedback = vi.fn()
    const { help } = await setup('/projects/w1/analytics', { openShortcuts, resetTips })
    help.setFeedbackOpener(openFeedback)
    await openDrawer(help)
    expect(footRows().map((el) => el.textContent.trim())).toEqual([
      'Email support',
      'Send feedback',
      'Keyboard shortcuts',
      'Show tips again',
      'Docs',
      'Support',
    ])

    footRow('Keyboard shortcuts').click()
    await flushPromises()
    expect(help.isOpen).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(openShortcuts).toHaveBeenCalledTimes(1)

    await openDrawer(help)
    footRow('Show tips again').click()
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resetTips).toHaveBeenCalledTimes(1)

    await openDrawer(help)
    footRow('Send feedback').click()
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(help.isOpen).toBe(false)
    expect(openFeedback).toHaveBeenCalledTimes(1)
    expect(openShortcuts).toHaveBeenCalledTimes(1)
  })

  it('closes on a new page but not on a panel or hash change', async () => {
    const { help, router } = await setup()
    await openDrawer(help)
    await router.push('/projects/w1/analytics?widget=prompts')
    await flushPromises()
    expect(help.isOpen).toBe(true)
    await router.push('/projects/w1/agent/findings')
    await flushPromises()
    expect(help.isOpen).toBe(false)
  })

  it('links "Read more" to the same page on Docs and closes', async () => {
    const section = document.createElement('section')
    section.id = 'billing'
    document.body.appendChild(section)
    const scrolled = vi.spyOn(section, 'scrollIntoView')
    const { help } = await setup('/docs')
    await openDrawer(help, { faqId: 'plan-free' })
    const link = document.getElementById('help-plans-plan-free').closest('.help-faq-item').querySelector('.help-faq-docs')
    expect(link.getAttribute('href')).toBe('#billing')
    expect(link.hasAttribute('target')).toBe(false)
    link.click()
    await flushPromises()
    expect(help.isOpen).toBe(false)
    expect(scrolled).toHaveBeenCalled()
  })
})
