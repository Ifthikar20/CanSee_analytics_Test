import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { h, nextTick, ref } from 'vue'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import HintCallout from '../HintCallout.vue'
import TipButton from '../TipButton.vue'
import { useAuthStore } from '@/stores/auth'
import { useAgentUiStore } from '@/stores/agentUi'
import { useHintsStore } from '@/stores/hints'
import { hintOf, loadHintState } from '@/lib/help/hints'

enableAutoUnmount(afterEach)

const callout = () => document.body.querySelector('.cs-hint')

async function settle() {
  await flushPromises()
  await nextTick()
}

function signIn(role = '') {
  const auth = useAuthStore()
  auth.user = { id: 7 }
  auth.session = { user: { id: 7 }, org: role ? { name: 'Acme', role } : null, onboarding: { needs_onboarding: false } }
}

function mountHint(props = {}) {
  const when = ref(props.when ?? true)
  const w = mount(
    {
      setup: () => () =>
        h(HintCallout, { hint: 'board.ask-ai', ...props, when: when.value }, () =>
          h('textarea', { 'aria-label': 'Question', class: 'target' }),
        ),
    },
    { attachTo: document.body },
  )
  return { w, when }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('HintCallout', () => {
  it('points at its target once, with the hint, Got it and Skip tips, and never takes focus', async () => {
    signIn()
    const announce = vi.spyOn(useAgentUiStore(), 'announce')
    const { w } = mountHint()
    w.find('textarea').element.focus()
    await settle()

    const el = callout()
    expect(el).not.toBeNull()
    const meta = hintOf('board.ask-ai')
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.getAttribute('aria-label')).toBe(meta.title)
    expect(document.getElementById(el.getAttribute('aria-describedby')).textContent).toBe(meta.body)
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Skip tips', 'Got it'])
    expect(document.activeElement).toBe(w.find('textarea').element)
    expect(announce).toHaveBeenCalledWith(`Tip: ${meta.title}. ${meta.body} Press Escape to dismiss.`)

    ;[...el.querySelectorAll('button')].find((b) => b.textContent === 'Got it').click()
    await settle()
    expect(callout()).toBeNull()
    expect(loadHintState('7').seen).toEqual(['board.ask-ai'])
  })

  it('Skip tips turns every hint off', async () => {
    signIn()
    mountHint()
    await settle()
    ;[...callout().querySelectorAll('button')].find((b) => b.textContent === 'Skip tips').click()
    await settle()
    expect(callout()).toBeNull()
    expect(useHintsStore().skipped).toBe(true)
    expect(loadHintState('7').skipped).toBe(true)
  })

  it('dismisses on Escape', async () => {
    signIn()
    mountHint()
    await settle()
    expect(callout()).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(callout()).toBeNull()
    expect(loadHintState('7').seen).toEqual(['board.ask-ai'])
  })

  it('waits until its target is ready, and stays away for a viewer', async () => {
    signIn()
    const { w, when } = mountHint({ when: false })
    await settle()
    expect(callout()).toBeNull()
    when.value = true
    await settle()
    expect(callout()).not.toBeNull()
    w.unmount()
    await settle()
    expect(callout()).toBeNull()
    // Unmounted before it was dismissed: it shows again next time.
    expect(loadHintState('7').seen).toEqual([])

    setActivePinia(createPinia())
    signIn('viewer')
    mountHint()
    await settle()
    expect(callout()).toBeNull()
  })

  it('wraps a menu root without taking the menu trigger’s anchor', async () => {
    signIn()
    const w = mount(
      {
        render: () =>
          h(HintCallout, { hint: 'board.ask-ai' }, () =>
            h(DropdownMenuRoot, null, () => [
              h(DropdownMenuTrigger, { asChild: true }, () => h(TipButton, { tip: 'Switch projects', class: 'chip' }, () => 'Acme')),
              h(DropdownMenuPortal, null, () => h(DropdownMenuContent, { class: 'probe-menu' }, () => h(DropdownMenuItem, null, () => 'Add project'))),
            ]),
          ),
      },
      { attachTo: document.body },
    )
    await settle()
    expect(callout()).not.toBeNull()
    const button = w.find('button.chip')
    expect(button.attributes('aria-haspopup')).toBe('menu')
    await button.trigger('keydown', { key: 'Enter' })
    await settle()
    const menu = document.body.querySelector('.probe-menu')
    expect(menu).not.toBeNull()
    // An anchored menu is positioned; one without an anchor stays at -200%.
    expect(menu.parentElement.getAttribute('style')).not.toContain('-200%')
  })
})
