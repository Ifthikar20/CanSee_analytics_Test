import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { BOARD_CONTEXT } from '@/lib/board/context'

const SOURCES = vi.hoisted(() => ({ overview: vi.fn(), traffic: vi.fn(), sentiment: vi.fn() }))
vi.mock('@/lib/board/sources', () => ({ SOURCES }))

const { FRESH_MS, invalidate, resetBoardSources, revalidate, useBoardSource } = await import('../useBoardSource')

const websiteId = ref('w1')
const mounted = []

function consumer(key) {
  let state
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useBoardSource(key)
        return () => h('div')
      },
    }),
    { global: { provide: { [BOARD_CONTEXT]: { websiteId, open: vi.fn(), close: vi.fn(), invalidate: vi.fn(), revalidate: vi.fn() } } } },
  )
  mounted.push(wrapper)
  return { wrapper, state }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const httpError = (status, error, displayMessage) =>
  Object.assign(new Error(String(status)), { response: { status, data: { success: false, error } }, displayMessage })

beforeEach(() => {
  vi.useFakeTimers()
  resetBoardSources()
  websiteId.value = 'w1'
  Object.values(SOURCES).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
})

describe('useBoardSource', () => {
  it('shares one request between the cards on a source', async () => {
    const answer = deferred()
    SOURCES.overview.mockReturnValue(answer.promise)
    const a = consumer('overview')
    const b = consumer('overview')
    await flushPromises()
    expect(SOURCES.overview).toHaveBeenCalledTimes(1)
    expect(SOURCES.overview).toHaveBeenCalledWith('w1')
    expect(a.state.loading.value).toBe(true)
    expect(a.state.data.value).toBeNull()

    answer.resolve({ kpis: { prompts: 3 } })
    await flushPromises()
    expect(a.state.data.value).toEqual({ kpis: { prompts: 3 } })
    expect(b.state.data.value).toEqual({ kpis: { prompts: 3 } })
    expect(a.state.loading.value).toBe(false)
    expect(a.state.failure.value).toBeNull()
    expect(a.state.error.value).toBe('')
  })

  it('serves a fresh entry for 60 seconds, then shows the old payload while it refetches', async () => {
    SOURCES.traffic.mockResolvedValueOnce({ total: 10 })
    consumer('traffic').wrapper.unmount()
    mounted.pop()
    await flushPromises()

    const fresh = consumer('traffic')
    await flushPromises()
    expect(SOURCES.traffic).toHaveBeenCalledTimes(1)
    expect(fresh.state.data.value).toEqual({ total: 10 })

    vi.advanceTimersByTime(FRESH_MS)
    const answer = deferred()
    SOURCES.traffic.mockReturnValueOnce(answer.promise)
    const later = consumer('traffic')
    await flushPromises()
    expect(SOURCES.traffic).toHaveBeenCalledTimes(2)
    expect(later.state.data.value).toEqual({ total: 10 })
    expect(later.state.loading.value).toBe(true)
    answer.resolve({ total: 12 })
    await flushPromises()
    expect(later.state.data.value).toEqual({ total: 12 })
    expect(fresh.state.data.value).toEqual({ total: 12 })
  })

  it('refetches an entry in use on invalidate, and an unused one on its next use', async () => {
    SOURCES.overview.mockResolvedValue({ n: 1 })
    SOURCES.sentiment.mockResolvedValue({ s: 1 })
    const card = consumer('overview')
    consumer('sentiment').wrapper.unmount()
    mounted.pop()
    await flushPromises()

    SOURCES.overview.mockResolvedValue({ n: 2 })
    invalidate('w1', 'overview')
    await flushPromises()
    expect(SOURCES.overview).toHaveBeenCalledTimes(2)
    expect(card.state.data.value).toEqual({ n: 2 })

    invalidate('w1', 'sentiment')
    await flushPromises()
    expect(SOURCES.sentiment).toHaveBeenCalledTimes(1)
    consumer('sentiment')
    await flushPromises()
    expect(SOURCES.sentiment).toHaveBeenCalledTimes(2)

    // Another project's entries are not touched.
    invalidate('w2', 'overview')
    await flushPromises()
    expect(SOURCES.overview).toHaveBeenCalledTimes(2)
  })

  it('drops an answer that a newer request replaced', async () => {
    const first = deferred()
    SOURCES.overview.mockReturnValueOnce(first.promise)
    const card = consumer('overview')
    await flushPromises()
    SOURCES.overview.mockResolvedValueOnce({ n: 'new' })
    invalidate('w1', 'overview')
    await flushPromises()
    first.resolve({ n: 'old' })
    await flushPromises()
    expect(card.state.data.value).toEqual({ n: 'new' })
  })

  it('revalidates only the stale entries in use', async () => {
    SOURCES.overview.mockResolvedValue({ n: 1 })
    consumer('overview')
    await flushPromises()
    revalidate('w1')
    await flushPromises()
    expect(SOURCES.overview).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FRESH_MS + 1)
    revalidate('w1')
    await flushPromises()
    expect(SOURCES.overview).toHaveBeenCalledTimes(2)
  })

  it("follows the board's project and never shows another project's payload", async () => {
    const late = deferred()
    SOURCES.overview.mockReturnValueOnce(late.promise)
    const card = consumer('overview')
    await flushPromises()

    SOURCES.overview.mockResolvedValueOnce({ project: 'w2' })
    websiteId.value = 'w2'
    await nextTick()
    expect(card.state.data.value).toBeNull()
    await flushPromises()
    expect(SOURCES.overview).toHaveBeenLastCalledWith('w2')
    expect(card.state.data.value).toEqual({ project: 'w2' })

    // The first project's late answer lands in its own entry only.
    late.resolve({ project: 'w1' })
    await flushPromises()
    expect(card.state.data.value).toEqual({ project: 'w2' })

    // Back to the first project: its payload shows at once.
    websiteId.value = 'w1'
    await nextTick()
    expect(card.state.data.value).toEqual({ project: 'w1' })
  })

  it('reports failures as {status, code, message}, and a failed refetch as stale', async () => {
    SOURCES.sentiment.mockRejectedValueOnce(
      httpError(503, { code: 'insights_disabled', message: 'Insights are turned off on this server.' }),
    )
    const card = consumer('sentiment')
    await flushPromises()
    expect(card.state.failure.value).toEqual({
      status: 503,
      code: 'insights_disabled',
      message: 'Insights are turned off on this server.',
    })
    expect(card.state.error.value).toBe('Insights are turned off on this server.')
    expect(card.state.stale.value).toBe(false)

    SOURCES.sentiment.mockResolvedValueOnce({ named: 4 })
    await card.state.reload()
    await flushPromises()
    expect(card.state.data.value).toEqual({ named: 4 })
    expect(card.state.failure.value).toBeNull()

    SOURCES.sentiment.mockRejectedValueOnce(httpError(500, 'server_error', 'Something went wrong on our end.'))
    await card.state.reload()
    await flushPromises()
    expect(card.state.failure.value).toEqual({ status: 500, code: 'server_error', message: 'Something went wrong on our end.' })
    expect(card.state.stale.value).toBe(true)
    expect(card.state.data.value).toEqual({ named: 4 })

    SOURCES.sentiment.mockRejectedValueOnce(new Error('Network Error'))
    await card.state.reload()
    await flushPromises()
    expect(card.state.failure.value).toEqual({ status: 0, code: '', message: '' })
    expect(card.state.error.value).toBe('error')
  })

  it('asks for nothing without a project or for an unknown source', async () => {
    websiteId.value = null
    const none = consumer('overview')
    const unknown = consumer('nope')
    await flushPromises()
    expect(SOURCES.overview).not.toHaveBeenCalled()
    expect(none.state.data.value).toBeNull()
    expect(unknown.state.loading.value).toBe(false)
  })
})
