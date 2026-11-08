import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '..'

enableAutoUnmount(afterEach)

describe('TooltipContent', () => {
  it('uses the shared dark tooltip surface, not bg-primary (white in the dark theme)', async () => {
    mount(
      {
        render: () =>
          h(TooltipProvider, null, () =>
            h(Tooltip, { open: true }, () => [
              h(TooltipTrigger, { asChild: true }, () => h('button', { type: 'button' }, 'x')),
              h(TooltipContent, { class: 'max-w-72' }, () => 'Why this is off'),
            ]),
          ),
      },
      { attachTo: document.body },
    )
    await flushPromises()
    const tip = document.body.querySelector('.cs-tooltip')
    expect(tip).not.toBeNull()
    expect(tip.textContent).toContain('Why this is off')
    expect(tip.className).not.toMatch(/bg-primary|text-primary-foreground|z-50/)
    expect(tip.classList.contains('max-w-72')).toBe(true)
  })
})
