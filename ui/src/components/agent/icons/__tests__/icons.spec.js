import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { AGENT_ICONS, IconContext, IconRecentChat } from '../index.js'

describe('agent icons', () => {
  it.each(Object.entries(AGENT_ICONS))('%s renders a decorative 16px svg on the 24 grid', (_, Icon) => {
    const svg = mount(Icon).find('svg')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('width')).toBe('16')
    expect(svg.attributes('height')).toBe('16')
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('focusable')).toBe('false')
    expect(svg.element.children.length).toBeGreaterThan(0)
  })

  it('takes size, stroke width and classes like lucide icons', () => {
    const svg = mount(IconRecentChat, { props: { size: 20, strokeWidth: 1.5 }, attrs: { class: 'x' } }).find('svg')
    expect(svg.attributes('width')).toBe('20')
    expect(svg.attributes('stroke-width')).toBe('1.5')
    expect(svg.attributes('stroke')).toBe('currentColor')
    expect(svg.classes()).toContain('x')
    expect(svg.findAll('path')).toHaveLength(2)
  })

  it('draws the context glyph as nine filled dots', () => {
    const svg = mount(IconContext).find('svg')
    expect(svg.attributes('fill')).toBe('currentColor')
    expect(svg.findAll('circle')).toHaveLength(9)
  })

  it('exposes the icon to assistive tech only when labelled', () => {
    const svg = mount(IconRecentChat, { attrs: { 'aria-label': 'Chat', role: 'img' } }).find('svg')
    expect(svg.attributes('aria-hidden')).toBeUndefined()
    expect(svg.attributes('aria-label')).toBe('Chat')
  })
})
