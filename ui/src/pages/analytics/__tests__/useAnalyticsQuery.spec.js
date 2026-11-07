import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useAnalyticsQuery } from '@/composables/analytics/useAnalyticsQuery'
import { apiError } from './__fixtures__/analyticsPayloads'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAnalyticsQuery', () => {
  it('loads, keeps the data while reloading and ignores late answers', async () => {
    const period = ref('30d')
    const calls = []
    const q = useAnalyticsQuery(
      () => {
        const d = deferred()
        calls.push({ period: period.value, ...d })
        return d.promise
      },
      () => [period.value],
    )
    expect(q.loading.value).toBe(true)
    calls[0].resolve({ n: 30 })
    await flushPromises()
    expect(q.data.value).toEqual({ n: 30 })
    expect(q.loading.value).toBe(false)

    period.value = '7d'
    await nextTick()
    period.value = '90d'
    await nextTick()
    expect(calls.map((c) => c.period)).toEqual(['30d', '7d', '90d'])
    // The previous numbers stay on screen while the new ones load.
    expect(q.data.value).toEqual({ n: 30 })
    calls[2].resolve({ n: 90 })
    await flushPromises()
    calls[1].resolve({ n: 7 })
    await flushPromises()
    expect(q.data.value).toEqual({ n: 90 })
  })

  it('reports a failed refresh as stale data, and clears data from another project', async () => {
    const project = ref('w1')
    // The first request goes out as soon as the query is created.
    const answers = [{ site: 'w1' }]
    const q = useAnalyticsQuery(
      () => {
        const next = answers.shift()
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
      },
      () => [project.value],
      { resetOn: () => project.value },
    )
    await flushPromises()
    expect(q.data.value).toEqual({ site: 'w1' })

    answers.push(apiError(503, 'unavailable', 'Try later.'))
    q.reload()
    await flushPromises()
    expect(q.stale.value).toBe(true)
    expect(q.error.value).toBe('Try later.')
    expect(q.failure.value).toEqual({ status: 503, code: 'unavailable', message: 'Try later.' })
    expect(q.data.value).toEqual({ site: 'w1' })

    answers.push(apiError(500))
    project.value = 'w2'
    await flushPromises()
    expect(q.data.value).toBeNull()
    expect(q.stale.value).toBe(false)
    expect(q.error.value).not.toBe('')
  })
})
