import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { useHelpStore } from '@/stores/help'
import { AGENT_SHORTCUTS } from '@/composables/agent/useAgentHotkeys'
import { isHelpShortcut, useHelpShortcut } from '../useHelpShortcut'

const mounted = []

function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const Host = defineComponent({
    setup() {
      useHelpShortcut()
      return () => h('div', [h('input', { id: 'field' }), h('textarea', { id: 'area' }), h('button', { id: 'btn' })])
    },
  })
  const wrapper = mount(Host, { global: { plugins: [pinia] }, attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, help: useHelpStore() }
}

function press(target, init = {}) {
  const event = new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('isHelpShortcut', () => {
  it('is a bare "?" outside fields', () => {
    const div = document.createElement('div')
    const input = document.createElement('input')
    expect(isHelpShortcut({ key: '?', shiftKey: true, target: div })).toBe(true)
    expect(isHelpShortcut({ key: '?', shiftKey: true, target: input })).toBe(false)
    expect(isHelpShortcut({ key: '?', ctrlKey: true, target: div })).toBe(false)
    expect(isHelpShortcut({ key: '?', metaKey: true, target: div })).toBe(false)
    expect(isHelpShortcut({ key: '?', altKey: true, target: div })).toBe(false)
    expect(isHelpShortcut({ key: '/', target: div })).toBe(false)
    expect(isHelpShortcut({ key: '?', isComposing: true, target: div })).toBe(false)
    expect(isHelpShortcut({ key: '?', defaultPrevented: true, target: div })).toBe(false)
  })
})

describe('useHelpShortcut', () => {
  it('toggles the help drawer with Shift+? outside text fields', () => {
    const { help } = setup()
    const event = press(document.getElementById('btn'))
    expect(event.defaultPrevented).toBe(true)
    expect(help.isOpen).toBe(true)
    press(document.body)
    expect(help.isOpen).toBe(false)
  })

  it('leaves the key to text fields', () => {
    const { help } = setup()
    expect(press(document.getElementById('field')).defaultPrevented).toBe(false)
    expect(press(document.getElementById('area')).defaultPrevented).toBe(false)
    expect(help.isOpen).toBe(false)
  })

  it('does not open help over another open dialog or menu', () => {
    const { help } = setup()
    const layer = document.createElement('div')
    layer.setAttribute('data-dismissable-layer', '')
    document.body.appendChild(layer)
    expect(press(document.body).defaultPrevented).toBe(false)
    expect(help.isOpen).toBe(false)
    layer.remove()
    press(document.body)
    expect(help.isOpen).toBe(true)
  })

  it('is not blocked by an open tooltip, but still is by a dialog', () => {
    const { help } = setup()
    // reka TooltipContent: a dismissable layer holding a role="tooltip" node.
    const tooltip = document.createElement('div')
    tooltip.setAttribute('data-dismissable-layer', '')
    const label = document.createElement('span')
    label.setAttribute('role', 'tooltip')
    label.textContent = 'Help, docs and shortcuts'
    tooltip.appendChild(label)
    document.body.appendChild(tooltip)
    expect(press(document.getElementById('btn')).defaultPrevented).toBe(true)
    expect(help.isOpen).toBe(true)
    help.close()

    const dialog = document.createElement('div')
    dialog.setAttribute('data-dismissable-layer', '')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    expect(press(document.getElementById('btn')).defaultPrevented).toBe(false)
    expect(help.isOpen).toBe(false)
  })

  it('stops listening when its scope ends', () => {
    const { wrapper, help } = setup()
    mounted.pop()
    wrapper.unmount()
    press(document.body)
    expect(help.isOpen).toBe(false)
  })

  it('is listed in the keyboard shortcuts dialog', () => {
    expect(AGENT_SHORTCUTS.find((s) => s.id === 'help')).toMatchObject({ keys: 'shift+?', label: 'Open help' })
  })
})

describe('help store', () => {
  it('opens at a known question only, and clears the search for it', () => {
    setActivePinia(createPinia())
    const help = useHelpStore()
    help.setQuery('billing')
    help.open({ faqId: 'nope' })
    expect([help.isOpen, help.focusId, help.query]).toEqual([true, null, 'billing'])
    help.close()
    help.open({ faqId: 'ts-paid' })
    expect([help.isOpen, help.focusId, help.query]).toEqual([true, 'ts-paid', ''])
  })

  it('keeps one feedback opener, and unregisters only its own', () => {
    setActivePinia(createPinia())
    const help = useHelpStore()
    const first = () => {}
    const second = () => {}
    const dropFirst = help.setFeedbackOpener(first)
    const dropSecond = help.setFeedbackOpener(second)
    dropFirst()
    expect(help.feedbackOpener).toBe(second)
    dropSecond()
    expect(help.feedbackOpener).toBeNull()
  })
})
