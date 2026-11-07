import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useStickToBottom } from '@/composables/agent/useStickToBottom'

class FakeResizeObserver {
  static instances = []
  constructor(callback) {
    this.callback = callback
    this.targets = []
    FakeResizeObserver.instances.push(this)
  }
  observe(target) {
    this.targets.push(target)
  }
  unobserve() {}
  disconnect() {
    this.targets = []
  }
}

function resize() {
  for (const observer of FakeResizeObserver.instances) {
    if (observer.targets.length) observer.callback([])
  }
}

// jsdom has no layout: give the scroller explicit geometry.
function makeScroller({ viewport = 400, content = 1000 } = {}) {
  const el = document.createElement('div')
  const state = { viewport, content, top: 0 }
  const max = () => Math.max(0, Math.max(state.content, state.viewport) - state.viewport)
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => state.viewport })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => Math.max(state.content, state.viewport) })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (v) => {
      state.top = Math.max(0, Math.min(Number(v) || 0, max()))
    },
  })
  document.body.appendChild(el)
  return { el, state }
}

function userScrollTo(el, top) {
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

let scope

function setup(geometry) {
  const { el, state } = makeScroller(geometry)
  scope = effectScope()
  const api = scope.run(() => useStickToBottom(el))
  return { el, state, ...api }
}

beforeEach(() => {
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  scope?.stop()
  scope = null
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('useStickToBottom', () => {
  it('starts pinned at the bottom', () => {
    const t = setup()
    expect(t.el.scrollTop).toBe(600)
    expect(t.isPinned.value).toBe(true)
    expect(t.isAtBottom.value).toBe(true)
  })

  it('follows growing content while pinned', () => {
    const t = setup()
    t.state.content = 1400
    resize()
    expect(t.el.scrollTop).toBe(1000)
    // The scroll event our own write causes does not unpin.
    t.el.dispatchEvent(new Event('scroll'))
    expect(t.isPinned.value).toBe(true)
  })

  it('lets go when the user wheels up and stays put as content grows', () => {
    const t = setup()
    t.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    expect(t.isPinned.value).toBe(false)
    userScrollTo(t.el, 300)
    expect(t.isAtBottom.value).toBe(false)
    t.state.content = 1600
    resize()
    expect(t.el.scrollTop).toBe(300)
    expect(t.isAtBottom.value).toBe(false)
  })

  it('lets go when the scrollbar is dragged up', () => {
    const t = setup()
    userScrollTo(t.el, 200)
    expect(t.isPinned.value).toBe(false)
    t.state.content = 1200
    resize()
    expect(t.el.scrollTop).toBe(200)
  })

  it('lets go on keyboard scrolling up', () => {
    const t = setup()
    t.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
    expect(t.isPinned.value).toBe(false)
  })

  it('lets go when a touch drags the content down', () => {
    const t = setup()
    t.el.dispatchEvent(Object.assign(new Event('touchstart'), { touches: [{ clientY: 100 }] }))
    t.el.dispatchEvent(Object.assign(new Event('touchmove'), { touches: [{ clientY: 160 }] }))
    expect(t.isPinned.value).toBe(false)
  })

  it('pins again when the user returns to the bottom', () => {
    const t = setup()
    userScrollTo(t.el, 100)
    expect(t.isPinned.value).toBe(false)
    userScrollTo(t.el, 590)
    expect(t.isAtBottom.value).toBe(true)
    expect(t.isPinned.value).toBe(true)
    t.state.content = 1300
    resize()
    expect(t.el.scrollTop).toBe(900)
  })

  it('scrollToBottom() pins and jumps', () => {
    const t = setup()
    userScrollTo(t.el, 0)
    t.state.content = 2000
    t.scrollToBottom()
    expect(t.isPinned.value).toBe(true)
    expect(t.el.scrollTop).toBe(1600)
  })

  it('ignores wheel-up when there is nothing to scroll', () => {
    const t = setup({ viewport: 400, content: 300 })
    t.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    expect(t.isPinned.value).toBe(true)
  })

  it('removes its listeners when disposed', () => {
    const t = setup()
    scope.stop()
    scope = null
    userScrollTo(t.el, 0)
    expect(t.isPinned.value).toBe(true)
  })
})
