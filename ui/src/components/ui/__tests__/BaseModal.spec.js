import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import BaseModal from '../BaseModal.vue'

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

// A page with an opener button and a BaseModal it controls.
function host({ title = 'Add a project', subtitle = '', body = 'field', header = null, ariaLabel = '' } = {}) {
  const open = ref(false)
  const closes = vi.fn()
  const Host = defineComponent({
    setup() {
      return () =>
        h('div', [
          h('button', { id: 'opener', onClick: () => (open.value = true) }, 'Open'),
          h(
            BaseModal,
            {
              modelValue: open.value,
              title,
              subtitle,
              ariaLabel,
              'onUpdate:modelValue': (v) => (open.value = v),
              onClose: closes,
            },
            {
              default: () =>
                body === 'field'
                  ? [h('label', { for: 'f' }, 'Website'), h('input', { id: 'f' })]
                  : [h('p', 'Remove this member?')],
              footer: () => [h('button', { id: 'cancel' }, 'Cancel'), h('button', { id: 'confirm' }, 'Remove')],
              ...(header ? { header } : {}),
            }
          ),
        ])
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, open, closes }
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const tab = (shiftKey = false) =>
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }))

async function openFromButton(open) {
  document.getElementById('opener').focus()
  open.value = true
  await flushPromises()
  await nextTick()
}

describe('BaseModal', () => {
  it('is named by its title and described by its subtitle', async () => {
    const { open } = host({ subtitle: 'Track another site.' })
    await openFromButton(open)
    const el = dialog()
    expect(el.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(el.getAttribute('aria-labelledby')).textContent).toBe('Add a project')
    expect(document.getElementById(el.getAttribute('aria-describedby')).textContent).toBe('Track another site.')
  })

  it('is named by a custom header slot', async () => {
    const { open } = host({ title: '', header: () => [h('h3', 'Connect Slack')] })
    await openFromButton(open)
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')).textContent).toBe('Connect Slack')
  })

  it('takes an aria-label when it shows no title', async () => {
    const { open } = host({ title: '', ariaLabel: 'Connect a channel' })
    await openFromButton(open)
    expect(dialog().getAttribute('aria-label')).toBe('Connect a channel')
    expect(dialog().hasAttribute('aria-labelledby')).toBe(false)
  })

  it('moves focus to the first field when it opens', async () => {
    const { open } = host()
    await openFromButton(open)
    expect(document.activeElement.id).toBe('f')
  })

  it('focuses the dialog itself, not its confirm button, when it has no field', async () => {
    const { open } = host({ title: 'Remove member', body: 'text' })
    await openFromButton(open)
    expect(document.activeElement).toBe(dialog())
  })

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const { open } = host()
    await openFromButton(open)
    document.getElementById('confirm').focus()
    tab()
    expect(document.activeElement.getAttribute('aria-label')).toBe('Close')
    tab(true)
    expect(document.activeElement.id).toBe('confirm')
  })

  it('gives focus back to the opener when it closes', async () => {
    const { open } = host()
    await openFromButton(open)
    expect(document.activeElement.id).toBe('f')
    document.body.querySelector('[aria-label="Close"]').click()
    await flushPromises()
    expect(open.value).toBe(false)
    expect(document.activeElement.id).toBe('opener')
  })

  it('closes on Escape and claims the key so a panel underneath stays open', async () => {
    const { open, closes } = host()
    const panelEscape = vi.fn((e) => {
      if (!e.defaultPrevented) panelEscape.closedPanel = true
    })
    window.addEventListener('keydown', panelEscape)
    await openFromButton(open)
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    window.removeEventListener('keydown', panelEscape)
    expect(closes).toHaveBeenCalledTimes(1)
    expect(open.value).toBe(false)
    expect(panelEscape).toHaveBeenCalled()
    expect(panelEscape.closedPanel).toBeUndefined()
  })

  it('ignores Escape while closed', async () => {
    const { closes } = host()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(closes).not.toHaveBeenCalled()
  })
})
