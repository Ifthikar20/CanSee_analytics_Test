import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useComposerDraft } from '@/composables/agent/useComposerDraft'
import { formatDuration, useElapsed } from '@/composables/agent/useElapsed'

const KEY = (cid) => `cs-agent-draft-v1:7:3:${cid || 'new'}`

let scope

function setup(initial = { uid: '7', wid: '3', cid: null }) {
  const where = ref(initial)
  const text = ref('')
  scope = effectScope()
  const api = scope.run(() => useComposerDraft(() => where.value, text, { delay: 300 }))
  return { where, text, ...api }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  scope?.stop()
  scope = null
  vi.useRealTimers()
})

describe('useComposerDraft', () => {
  it('loads the stored draft for the chat', () => {
    localStorage.setItem(KEY('c1'), 'half a question')
    const t = setup({ uid: '7', wid: '3', cid: 'c1' })
    expect(t.text.value).toBe('half a question')
  })

  it('saves after a pause and removes an emptied draft', async () => {
    const t = setup()
    t.text.value = 'research turonote'
    await nextTick()
    expect(localStorage.getItem(KEY(null))).toBeNull()
    vi.advanceTimersByTime(300)
    expect(localStorage.getItem(KEY(null))).toBe('research turonote')
    t.text.value = '   '
    await nextTick()
    vi.advanceTimersByTime(300)
    expect(localStorage.getItem(KEY(null))).toBeNull()
  })

  it('keeps each chat draft when switching chats', async () => {
    const t = setup({ uid: '7', wid: '3', cid: 'c1' })
    t.text.value = 'for chat one'
    await nextTick()
    t.where.value = { uid: '7', wid: '3', cid: 'c2' }
    await nextTick()
    expect(localStorage.getItem(KEY('c1'))).toBe('for chat one')
    expect(t.text.value).toBe('')
    t.where.value = { uid: '7', wid: '3', cid: 'c1' }
    await nextTick()
    expect(t.text.value).toBe('for chat one')
  })

  it('clear() drops the draft at once', async () => {
    const t = setup()
    t.text.value = 'sent text'
    await nextTick()
    vi.advanceTimersByTime(300)
    t.clear()
    expect(localStorage.getItem(KEY(null))).toBeNull()
  })

  it('does nothing without a user or project', async () => {
    const t = setup(null)
    t.text.value = 'typed'
    await nextTick()
    vi.advanceTimersByTime(1000)
    expect(localStorage.length).toBe(0)
  })
})

describe('useElapsed', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(10_000)).toBe('10s')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(3_840_000)).toBe('1h 4m')
  })

  it('ticks while running and settles on the final duration', async () => {
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'))
    const running = ref(true)
    const final = ref(null)
    scope = effectScope()
    const t = scope.run(() => useElapsed(() => '2026-11-02T09:59:57Z', running, final))
    expect(t.label.value).toBe('3s')
    vi.advanceTimersByTime(2000)
    expect(t.label.value).toBe('5s')
    final.value = 10_000
    running.value = false
    await nextTick()
    expect(t.label.value).toBe('10s')
  })
})
