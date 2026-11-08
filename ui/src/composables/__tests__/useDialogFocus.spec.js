import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { useDialogFocus } from '../useDialogFocus'

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

function dialog(name, open, onEscape) {
  return defineComponent({
    setup() {
      const el = ref(null)
      useDialogFocus(el, open, { onEscape })
      return () => (open.value ? h('div', { ref: el, role: 'dialog', tabindex: '-1', 'data-name': name }, [h('button', name)]) : null)
    },
  })
}

const escape = () =>
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

describe('useDialogFocus', () => {
  it('sends Escape to the dialog opened last only', async () => {
    const first = ref(false)
    const second = ref(false)
    const closeFirst = vi.fn(() => (first.value = false))
    const closeSecond = vi.fn(() => (second.value = false))
    const A = dialog('a', first, closeFirst)
    const B = dialog('b', second, closeSecond)
    const wrapper = mount(defineComponent({ render: () => h('div', [h(A), h(B)]) }), { attachTo: document.body })
    mounted.push(wrapper)
    first.value = true
    await flushPromises()
    second.value = true
    await flushPromises()

    escape()
    await flushPromises()
    expect(closeSecond).toHaveBeenCalledTimes(1)
    expect(closeFirst).not.toHaveBeenCalled()

    escape()
    await flushPromises()
    expect(closeFirst).toHaveBeenCalledTimes(1)
  })

  it('stops listening for Escape once every dialog is closed or unmounted', async () => {
    const open = ref(true)
    const onEscape = vi.fn()
    const wrapper = mount(dialog('a', open, onEscape), { attachTo: document.body })
    await flushPromises()
    wrapper.unmount()
    escape()
    expect(onEscape).not.toHaveBeenCalled()
  })
})
