import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { DialogTrigger } from 'reka-ui'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

function mountSheet({ side } = {}) {
  const open = ref(false)
  const Host = defineComponent({
    setup() {
      return () =>
        h('div', [
          h('button', { id: 'before', type: 'button' }, 'Before'),
          h(
            Sheet,
            { open: open.value, 'onUpdate:open': (v) => (open.value = v) },
            {
              default: () => [
                h(DialogTrigger, { id: 'opener' }, { default: () => 'Open' }),
                h(
                  SheetContent,
                  { side, class: 'test-sheet' },
                  {
                    default: () => [
                      h(SheetHeader, null, {
                        default: () => [
                          h(SheetTitle, null, { default: () => 'Help' }),
                          h(SheetDescription, null, { default: () => 'Answers and contact.' }),
                          h(SheetClose, { label: 'Close help' }),
                        ],
                      }),
                      h('input', { id: 'inside', 'aria-label': 'Inside' }),
                    ],
                  },
                ),
              ],
            },
          ),
        ])
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, open }
}

const panel = () => document.body.querySelector('.test-sheet')

describe('Sheet', () => {
  it('opens a labelled modal dialog on the right, over an overlay', async () => {
    const { wrapper } = mountSheet()
    expect(panel()).toBeNull()
    await wrapper.get('#opener').trigger('click')
    await flushPromises()

    const el = panel()
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.getAttribute('data-side')).toBe('right')
    expect(el.className).toContain('right-0')
    expect(el.className).toContain('z-[96]')
    expect(document.body.querySelector('.sheet-overlay').className).toContain('z-[95]')

    const title = document.getElementById(el.getAttribute('aria-labelledby'))
    const description = document.getElementById(el.getAttribute('aria-describedby'))
    expect(title.textContent).toBe('Help')
    expect(title.tagName).toBe('H2')
    expect(description.textContent).toBe('Answers and contact.')
    expect(el.querySelector('[aria-label="Close help"]')).not.toBeNull()
  })

  it('opens from the left when asked', async () => {
    const { wrapper } = mountSheet({ side: 'left' })
    await wrapper.get('#opener').trigger('click')
    await flushPromises()
    expect(panel().getAttribute('data-side')).toBe('left')
    expect(panel().className).toContain('left-0')
    expect(panel().className).not.toContain('right-0')
  })

  it('moves focus in, closes on Escape and the close button, and hands focus back', async () => {
    const { wrapper, open } = mountSheet()
    const opener = wrapper.get('#opener').element
    opener.focus()
    await wrapper.get('#opener').trigger('click')
    await flushPromises()
    expect(panel().contains(document.activeElement)).toBe(true)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(open.value).toBe(false)
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(opener)

    await wrapper.get('#opener').trigger('click')
    await flushPromises()
    panel().querySelector('[aria-label="Close help"]').click()
    await flushPromises()
    await nextTick()
    expect(open.value).toBe(false)
    expect(document.activeElement).toBe(opener)
  })
})
