// The shared button, badge and card: one system, drawn from the tokens.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { Button, buttonVariants } from '../button'
import { Badge, badgeVariants } from '../badge'
import { Card } from '../card'

const classes = (text) => text.split(/\s+/)

describe('Button', () => {
  it('is ink on paper by default and inverts on hover', () => {
    const c = classes(buttonVariants())
    expect(c).toEqual(expect.arrayContaining(['bg-primary', 'text-primary-foreground', 'border-primary', 'hover:bg-transparent', 'hover:text-primary']))
  })

  it('is square, flat and leaves focus to the global ring in every variant and size', () => {
    for (const variant of ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']) {
      for (const size of ['default', 'sm', 'lg', 'icon']) {
        const text = buttonVariants({ variant, size })
        expect(text, `${variant}/${size}`).toContain('rounded-[var(--radius)]')
        expect(text, `${variant}/${size}`).not.toMatch(/rounded-(?:md|lg|xl|full)|shadow|ring-|outline-none|gradient/)
        expect(text, `${variant}/${size}`).toContain('disabled:opacity-50')
      }
    }
  })

  it('keeps the outline variant visible at rest and stronger on hover', () => {
    const c = classes(buttonVariants({ variant: 'outline' }))
    expect(c).toEqual(expect.arrayContaining(['border-input', 'bg-transparent', 'hover:border-foreground']))
  })

  it('renders a button whose variant border wins over the base one', () => {
    const w = mount(Button, { props: { variant: 'outline' }, slots: { default: 'Cancel' } })
    const button = w.find('button')
    expect(button.text()).toBe('Cancel')
    // tailwind-merge drops the base `border-transparent` for the variant's colour.
    expect(button.classes()).toContain('border-input')
    expect(button.classes()).not.toContain('border-transparent')
    expect(mount(Button, { slots: { default: 'Go' } }).find('button').classes()).toContain('border-primary')
  })

  it('lets a caller class override the variant', () => {
    const w = mount(Button, { props: { class: 'h-12' }, slots: { default: 'Go' } })
    expect(w.find('button').classes()).toContain('h-12')
    expect(w.find('button').classes()).not.toContain('h-9')
  })
})

describe('Badge', () => {
  it('is a square monospace uppercase label', () => {
    const c = classes(badgeVariants())
    expect(c).toEqual(expect.arrayContaining(['font-mono', 'uppercase', 'border']))
    expect(badgeVariants()).not.toMatch(/rounded/)
  })

  it('carries state by weight and the accent, never by a hue of its own', () => {
    expect(classes(badgeVariants({ variant: 'success' }))).toEqual(expect.arrayContaining(['border-foreground', 'text-foreground']))
    expect(classes(badgeVariants({ variant: 'warning' }))).toEqual(expect.arrayContaining(['bg-signal-soft', 'text-signal-text']))
    expect(classes(badgeVariants({ variant: 'destructive' }))).toEqual(expect.arrayContaining(['bg-destructive', 'text-destructive-foreground']))
    for (const variant of ['default', 'secondary', 'destructive', 'outline', 'success', 'warning']) {
      expect(badgeVariants({ variant }), variant).not.toMatch(/chart-|green|amber|red-|blue/)
    }
  })

  it('renders its label', () => {
    const w = mount(Badge, { props: { variant: 'warning' }, slots: { default: 'Needs attention' } })
    expect(w.text()).toBe('Needs attention')
    expect(w.classes()).toContain('text-signal-text')
  })
})

describe('Card', () => {
  it('is a flat surface: the card tone, the radius token, no border and no shadow', () => {
    const w = mount(Card, { slots: { default: 'Body' } })
    expect(w.classes()).toEqual(expect.arrayContaining(['bg-card', 'text-card-foreground', 'rounded-[var(--radius)]']))
    expect(w.classes().join(' ')).not.toMatch(/shadow|border/)
    expect(w.text()).toBe('Body')
  })
})
