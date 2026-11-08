import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterLinkStub, enableAutoUnmount, mount } from '@vue/test-utils'
import AgButton from '../AgButton.vue'

enableAutoUnmount(afterEach)

describe('AgButton', () => {
  it('keeps an aria-disabled button focusable and clickable, so a tooltip can say why', async () => {
    const onClick = vi.fn()
    const w = mount(AgButton, { attrs: { 'aria-disabled': 'true', onClick }, slots: { default: 'Re-run' } })
    const button = w.find('button')
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    // The caller decides; AgButton does not swallow the click.
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('still marks a disabled link aria-disabled, and leaves a normal button alone', () => {
    const link = mount(AgButton, { props: { to: '/x', disabled: true }, global: { stubs: { RouterLink: RouterLinkStub } } })
    expect(link.attributes('aria-disabled')).toBe('true')
    const plain = mount(AgButton, { slots: { default: 'Go' } })
    expect(plain.find('button').attributes('aria-disabled')).toBeUndefined()
  })
})
