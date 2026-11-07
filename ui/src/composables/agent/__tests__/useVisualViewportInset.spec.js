import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useVisualViewportInset } from '../useVisualViewportInset'

class FakeViewport extends EventTarget {
  constructor() {
    super()
    this.height = 800
    this.offsetTop = 0
    this.scale = 1
  }
}

let vv
const root = document.documentElement

beforeEach(() => {
  vi.useFakeTimers()
  vv = new FakeViewport()
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
  root.removeAttribute('style')
})

describe('useVisualViewportInset', () => {
  it('writes the visual viewport size and the keyboard inset', async () => {
    const scope = effectScope()
    const state = scope.run(() => useVisualViewportInset())
    expect(root.style.getPropertyValue('--ag-vv-height')).toBe('800px')
    expect(root.style.getPropertyValue('--ag-vv-inset')).toBe('0px')

    vv.height = 480
    vv.offsetTop = 20
    vv.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(20)
    expect(root.style.getPropertyValue('--ag-vv-height')).toBe('480px')
    expect(root.style.getPropertyValue('--ag-vv-top')).toBe('20px')
    expect(root.style.getPropertyValue('--ag-vv-inset')).toBe('300px')
    expect(state.inset.value).toBe(300)
    scope.stop()
  })

  it('backs off while pinch-zoomed and cleans up on dispose', () => {
    const scope = effectScope()
    scope.run(() => useVisualViewportInset())
    vv.scale = 2
    vv.height = 400
    vv.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(20)
    expect(root.style.getPropertyValue('--ag-vv-height')).toBe('')

    vv.scale = 1
    vv.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(20)
    expect(root.style.getPropertyValue('--ag-vv-height')).toBe('400px')
    scope.stop()
    expect(root.style.getPropertyValue('--ag-vv-height')).toBe('')
  })

  it('does nothing without visualViewport', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    const state = useVisualViewportInset()
    expect(state.height.value).toBeNull()
    expect(root.style.getPropertyValue('--ag-vv-height')).toBe('')
  })
})
