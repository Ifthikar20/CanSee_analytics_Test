import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useThrottledSrcdoc } from '../useThrottledSrcdoc'

const build = (html) => `built:${html}`

describe('useThrottledSrcdoc', () => {
  let scope

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })

  it('applies settled content at once into the visible frame', () => {
    const html = ref('<h1>v1</h1>')
    const live = ref(false)
    const s = scope.run(() => useThrottledSrcdoc(html, { live, build }))
    expect(s.docs.value[s.front.value]).toBe('built:<h1>v1</h1>')
    expect(s.pending.value).toBe(-1)
  })

  it('throttles a streaming draft to one build per interval into the hidden frame', async () => {
    const html = ref('<h1>')
    const live = ref(true)
    const calls = []
    const s = scope.run(() =>
      useThrottledSrcdoc(html, {
        live,
        interval: 700,
        build: (value) => {
          calls.push(value)
          return build(value)
        },
      })
    )
    vi.advanceTimersByTime(0)
    expect(calls).toEqual(['<h1>'])
    expect(s.front.value).toBe(0)

    for (const chunk of ['M', 'o', 'r', 'e']) {
      html.value += chunk
      await nextTick()
      vi.advanceTimersByTime(100)
    }
    expect(calls).toHaveLength(1)

    vi.advanceTimersByTime(700)
    expect(calls).toEqual(['<h1>', '<h1>More'])
    expect(s.pending.value).toBe(1)
    expect(s.front.value).toBe(0)
    expect(s.docs.value[1]).toBe('built:<h1>More')

    s.onLoad(0)
    expect(s.front.value).toBe(0)
    s.onLoad(1)
    expect(s.front.value).toBe(1)
    expect(s.pending.value).toBe(-1)
  })

  it('flushes the final document as soon as drafting ends', async () => {
    const html = ref('<p>a')
    const live = ref(true)
    const s = scope.run(() => useThrottledSrcdoc(html, { live, build }))
    vi.advanceTimersByTime(0)
    html.value = '<p>abc</p>'
    await nextTick()
    live.value = false
    await nextTick()
    expect(s.docs.value[s.pending.value === -1 ? s.front.value : s.pending.value]).toBe('built:<p>abc</p>')
  })
})
