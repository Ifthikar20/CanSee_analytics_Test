import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useSmoothText } from '@/composables/agent/useSmoothText'

let scopes = []

function setup(initial = '', live = true, options = {}) {
  const source = ref(initial)
  const streaming = ref(live)
  const scope = effectScope()
  scopes.push(scope)
  const api = scope.run(() => useSmoothText(source, streaming, { reducedMotion: false, ...options }))
  return { source, streaming, scope, ...api }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  scopes.forEach((s) => s.stop())
  scopes = []
  vi.useRealTimers()
})

describe('useSmoothText', () => {
  it('shows text that exists at start without animating', () => {
    expect(setup('Already here', true).text.value).toBe('Already here')
    expect(setup('Finished reply', false).text.value).toBe('Finished reply')
  })

  it('reveals streamed growth gradually and catches up', async () => {
    const t = setup('Hello', true)
    const full = 'Hello' + ' world'.repeat(60)
    t.source.value = full
    await nextTick()
    expect(t.text.value).toBe('Hello')
    expect(t.catchingUp.value).toBe(true)

    vi.advanceTimersByTime(16)
    const first = t.text.value.length
    expect(first).toBeGreaterThan(5)
    expect(first).toBeLessThan(full.length)

    vi.advanceTimersByTime(100)
    expect(t.text.value.length).toBeGreaterThan(first)
    expect(full.startsWith(t.text.value)).toBe(true)

    vi.advanceTimersByTime(3000)
    expect(t.text.value).toBe(full)
    expect(t.catchingUp.value).toBe(false)
  })

  it('stops at word boundaries when one is close', async () => {
    const t = setup('', true)
    const full = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho'
    t.source.value = full
    await nextTick()
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(16)
      const shown = t.text.value
      if (shown.length < full.length && shown.length > 0) {
        expect(full[shown.length]).toBe(' ')
      }
    }
  })

  it('never reveals more slowly than the minimum rate', async () => {
    const t = setup('', true)
    t.source.value = 'abcdefghij'
    await nextTick()
    vi.advanceTimersByTime(200)
    expect(t.text.value).toBe('abcdefghij')
  })

  it('shows finished text at once when nothing is animating', async () => {
    const t = setup('', false)
    t.source.value = 'Loaded from history'
    await nextTick()
    expect(t.text.value).toBe('Loaded from history')
  })

  it('drains the remainder quickly after the stream ends', async () => {
    const t = setup('', true)
    const full = 'word '.repeat(400)
    t.source.value = full
    await nextTick()
    vi.advanceTimersByTime(32)
    expect(t.text.value.length).toBeLessThan(full.length)
    t.streaming.value = false
    await nextTick()
    vi.advanceTimersByTime(1500)
    expect(t.text.value).toBe(full)
  })

  it('falls back to the common prefix when the text is replaced', async () => {
    const t = setup('Alpha beta gamma', true)
    t.source.value = 'Alpha delta and more'
    await nextTick()
    expect('Alpha delta and more'.startsWith(t.text.value)).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(t.text.value).toBe('Alpha delta and more')
  })

  it('does not animate with reduced motion', async () => {
    const t = setup('', true, { reducedMotion: true })
    t.source.value = 'Hello world, all at once'
    await nextTick()
    expect(t.text.value).toBe('Hello world, all at once')
  })

  it('flush() reveals everything immediately', async () => {
    const t = setup('', true)
    t.source.value = 'x'.repeat(500)
    await nextTick()
    vi.advanceTimersByTime(16)
    t.flush()
    expect(t.text.value).toBe('x'.repeat(500))
  })

  it('stops scheduling frames once disposed', async () => {
    const t = setup('', true)
    t.source.value = 'x '.repeat(300)
    await nextTick()
    vi.advanceTimersByTime(16)
    const shown = t.text.value
    t.scope.stop()
    vi.advanceTimersByTime(1000)
    expect(t.text.value).toBe(shown)
  })
})
