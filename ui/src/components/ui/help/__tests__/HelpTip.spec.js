import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { h, nextTick } from 'vue'
import { TooltipProvider } from 'reka-ui'
import HelpTip from '../HelpTip.vue'

// Unmounting also removes what the tip teleported to <body>.
enableAutoUnmount(afterEach)

const TEXT = 'How many times each engine gets the question.'

const tip = () => document.body.querySelector('.cs-tooltip')

async function settle() {
  await flushPromises()
  await nextTick()
}

function mountTip(props = {}, options = {}) {
  return mount(HelpTip, { props: { text: TEXT, label: 'About Times per engine', ...props }, attachTo: document.body, ...options })
}

async function pressOutside() {
  // reka registers its outside-press listener a tick after opening.
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
  await settle()
}

describe('HelpTip', () => {
  it('is a labelled icon button whose text is always in its description', async () => {
    const w = mountTip()
    const button = w.find('button')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('About Times per engine')
    expect(button.classes()).toContain('cs-helptip')
    expect(button.find('svg').attributes('aria-hidden')).toBe('true')
    // Closed, the description is still there (reka adds its own only while open).
    expect(tip()).toBeNull()
    const id = button.attributes('aria-describedby')
    expect(id).toBeTruthy()
    const desc = document.getElementById(id)
    expect(desc.textContent).toBe(TEXT)
    expect(desc.hidden).toBe(true)
    // It lives under <body>, outside the surrounding copy.
    expect(w.text()).toBe('')
  })

  it('opens on keyboard focus and closes on blur', async () => {
    const w = mountTip()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    w.find('button').element.focus()
    await settle()
    expect(tip().textContent).toContain(TEXT)
    w.find('button').element.blur()
    await settle()
    expect(tip()).toBeNull()
  })

  it('toggles on click or tap, so it works on touch screens', async () => {
    const w = mountTip()
    const button = w.find('button')
    // A tap: reka's trigger ignores touch pointers, the click opens it.
    await button.trigger('pointerdown', { pointerType: 'touch' })
    await button.trigger('click')
    await settle()
    expect(tip().textContent).toContain(TEXT)
    // A second press on the trigger closes it, not the outside-press rule.
    await button.trigger('pointerdown', { pointerType: 'touch' })
    await button.trigger('click')
    await settle()
    expect(tip()).toBeNull()
  })

  it('closes on Escape and on a press outside', async () => {
    const w = mountTip()
    await w.find('button').trigger('click')
    await settle()
    expect(tip()).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(tip()).toBeNull()

    await w.find('button').trigger('click')
    await settle()
    expect(tip()).not.toBeNull()
    await pressOutside()
    expect(tip()).toBeNull()
  })

  it('renders on the shared tooltip surface, above onboarding and dialogs', async () => {
    const w = mountTip({ side: 'bottom' })
    await w.find('button').trigger('click')
    await settle()
    expect(tip().classList.contains('cs-helptip-content')).toBe(true)
    expect(tip().getAttribute('data-side')).toBe('bottom')
  })

  it('takes slot text as its trigger, named by that text', async () => {
    const w = mountTip({}, { slots: { default: () => 'AI ahead' } })
    const button = w.find('button')
    expect(button.text()).toBe('AI ahead')
    expect(button.attributes('aria-label')).toBeUndefined()
    expect(button.classes()).toContain('has-text')
    expect(document.getElementById(button.attributes('aria-describedby')).textContent).toBe(TEXT)
  })

  it('works inside the app tooltip provider too', async () => {
    const w = mount(
      { render: () => h(TooltipProvider, { delayDuration: 400 }, () => h(HelpTip, { text: TEXT })) },
      { attachTo: document.body },
    )
    expect(w.find('button').attributes('aria-label')).toBe('More about this')
    await w.find('button').trigger('click')
    await settle()
    expect(tip().textContent).toContain(TEXT)
  })
})

describe('HelpTip pinned by a click', () => {
  async function hoverAway(button) {
    button.element.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse', clientX: 500, clientY: 500 }))
    // reka starts tracking the pointer on the next tick.
    await settle()
    document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 900, clientY: 900 }))
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await settle()
  }

  it('closes when the pointer leaves a tip opened by hovering', async () => {
    const w = mountTip()
    const button = w.find('button')
    await button.trigger('pointermove', { pointerType: 'mouse' })
    await new Promise((resolve) => setTimeout(resolve, 450))
    await settle()
    expect(tip()).not.toBeNull()
    await hoverAway(button)
    expect(tip()).toBeNull()
  })

  it('stays open when the pointer leaves a tip opened by a click', async () => {
    const w = mountTip()
    const button = w.find('button')
    await button.trigger('pointermove', { pointerType: 'mouse' })
    await button.trigger('click')
    await settle()
    expect(tip()).not.toBeNull()
    await hoverAway(button)
    expect(tip()).not.toBeNull()
    expect(tip().textContent).toContain(TEXT)
  })
})
