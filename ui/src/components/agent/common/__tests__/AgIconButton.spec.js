import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import AgIconButton from '../AgIconButton.vue'
import AgMenuContent from '../AgMenuContent.vue'
import AgMenuItem from '../AgMenuItem.vue'
import AgTooltip from '../AgTooltip.vue'

// Unmounting also removes what the menus and tooltips teleported to <body>.
enableAutoUnmount(afterEach)

describe('AgIconButton', () => {
  it('is a labelled button that forwards attributes and clicks', async () => {
    const onClick = vi.fn()
    const w = mount(AgIconButton, {
      props: { label: 'Copy', shortcut: 'mod+c', size: 28 },
      attrs: { class: 'extra', onClick, 'data-x': '1' },
      slots: { default: () => h('svg') },
      attachTo: document.body,
    })
    const button = w.find('button')
    expect(button.attributes('aria-label')).toBe('Copy')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-keyshortcuts')).toMatch(/^(Control|Meta)\+C$/)
    expect(button.attributes('data-x')).toBe('1')
    expect(button.classes()).toEqual(expect.arrayContaining(['ag-icon-btn', 'extra', 'is-ghost']))
    expect(button.attributes('style')).toContain('--ag-ib-size: 28px')
    expect(button.attributes('style')).toContain('--ag-ib-radius: 6px')
    await button.trigger('click')
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('exposes toggle state with aria-pressed and honours disabled', () => {
    const w = mount(AgIconButton, { props: { label: 'Search chats', pressed: true, disabled: true, tooltip: false } })
    const button = w.find('button')
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.classes()).toContain('is-active')
  })

  it('keeps the same button element when the tooltip is switched off', async () => {
    const w = mount(AgIconButton, { props: { label: 'Activity', tooltip: 'Activity' }, attachTo: document.body })
    const before = w.find('button').element
    await w.setProps({ tooltip: false })
    expect(w.find('button').element).toBe(before)
    await w.setProps({ disabled: true })
    expect(w.find('button').element).toBe(before)
  })

  it('accepts named sizes and a circle shape', () => {
    const w = mount(AgIconButton, { props: { label: 'Send', size: 'md', shape: 'circle', tooltip: false } })
    const style = w.find('button').attributes('style')
    expect(style).toContain('--ag-ib-size: 32px')
    expect(style).toContain('--ag-ib-radius: 999px')
  })

  it('works as an as-child menu trigger', async () => {
    const onSelect = vi.fn()
    const Host = defineComponent({
      setup() {
        return () =>
          h(DropdownMenuRoot, null, {
            default: () => [
              h(DropdownMenuTrigger, { asChild: true }, { default: () => h(AgIconButton, { label: 'More' }) }),
              h(AgMenuContent, { align: 'end' }, { default: () => [h(AgMenuItem, { onSelect }, () => 'Rename')] }),
            ],
          })
      },
    })
    const w = mount(Host, { attachTo: document.body })
    const button = w.find('button')
    expect(button.attributes('aria-haspopup')).toBe('menu')
    expect(button.attributes('aria-label')).toBe('More')
    await button.trigger('click')
    await flushPromises()
    await nextTick()
    const menu = document.body.querySelector('.ag-portal.ag-menu')
    expect(menu).not.toBeNull()
    expect(button.attributes('aria-expanded')).toBe('true')
    const item = menu.querySelector('[role="menuitem"]')
    expect(item.textContent).toContain('Rename')
    item.click()
    await flushPromises()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})

describe('AgTooltip', () => {
  it('renders text and platform shortcut keys in a portal when open', async () => {
    mount(AgTooltip, {
      props: { text: 'New chat', shortcut: 'mod+shift+o', open: true },
      slots: { default: () => h('button', { type: 'button' }, 'x') },
      attachTo: document.body,
    })
    await flushPromises()
    const tip = document.body.querySelector('.ag-portal.ag-tooltip')
    expect(tip).not.toBeNull()
    expect(tip.textContent).toContain('New chat')
    expect(tip.querySelector('.ag-tooltip-keys').textContent).toMatch(/O/)
  })

  it('renders only the trigger when disabled or empty', () => {
    const w = mount(AgTooltip, {
      props: { text: '', open: true },
      slots: { default: () => h('button', { type: 'button' }, 'x') },
      attachTo: document.body,
    })
    expect(w.find('button').exists()).toBe(true)
    expect(document.body.querySelector('.ag-tooltip')).toBeNull()
  })
})
