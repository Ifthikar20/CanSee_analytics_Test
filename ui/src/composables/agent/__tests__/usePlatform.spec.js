import { describe, expect, it } from 'vitest'
import {
  ariaShortcut,
  detectMac,
  formatShortcut,
  isModEvent,
  shortcutKeys,
  shortcutLabels,
} from '../usePlatform'

describe('detectMac', () => {
  it('reads userAgentData, then platform, then the user agent', () => {
    expect(detectMac({ userAgentData: { platform: 'macOS' } })).toBe(true)
    expect(detectMac({ platform: 'MacIntel' })).toBe(true)
    expect(detectMac({ platform: 'iPad' })).toBe(true)
    expect(detectMac({ platform: 'Win32' })).toBe(false)
    expect(detectMac({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe(false)
    expect(detectMac(null)).toBe(false)
  })
})

describe('shortcut formatting', () => {
  it('splits strings and arrays', () => {
    expect(shortcutKeys('mod+shift+o')).toEqual(['mod', 'shift', 'o'])
    expect(shortcutKeys(['mod', 'k'])).toEqual(['mod', 'k'])
    expect(shortcutKeys('mod+\\')).toEqual(['mod', '\\'])
    expect(shortcutKeys('')).toEqual([])
  })

  it('uses symbols on a Mac and words elsewhere', () => {
    expect(shortcutLabels('mod+shift+o', true)).toEqual(['⌘', '⇧', 'O'])
    expect(shortcutLabels('mod+shift+o', false)).toEqual(['Ctrl', 'Shift', 'O'])
    expect(formatShortcut('mod+k', true)).toBe('⌘K')
    expect(formatShortcut('mod+k', false)).toBe('Ctrl+K')
    expect(formatShortcut('esc', false)).toBe('Esc')
    expect(formatShortcut('up', false)).toBe('↑')
    expect(formatShortcut('shift+enter', false)).toBe('Shift+Enter')
  })

  it('builds aria-keyshortcuts values', () => {
    expect(ariaShortcut('mod+b', true)).toBe('Meta+B')
    expect(ariaShortcut('mod+b', false)).toBe('Control+B')
    expect(ariaShortcut('mod+shift+o', false)).toBe('Control+Shift+O')
  })
})

describe('isModEvent', () => {
  it('accepts only the platform modifier', () => {
    expect(isModEvent({ ctrlKey: true }, false)).toBe(true)
    expect(isModEvent({ metaKey: true }, false)).toBe(false)
    expect(isModEvent({ metaKey: true }, true)).toBe(true)
    expect(isModEvent({ ctrlKey: true }, true)).toBe(false)
    expect(isModEvent({ ctrlKey: true, altKey: true }, false)).toBe(false)
    expect(isModEvent({ ctrlKey: true, shiftKey: true }, false)).toBe(true)
  })
})
