import { afterEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'
import { useHideUsd, useSessionRuns } from '@/composables/useHideUsd'
import { useAuthStore } from '@/stores/auth'

const FREE = { unlimited: false, limit: 20, used: 2, reserved: 0, remaining: 18 }
const PAID = { unlimited: true, limit: null, remaining: null }

let scope
function run(fn) {
  scope = effectScope()
  return scope.run(fn)
}

afterEach(() => {
  scope?.stop()
  setActivePinia(undefined)
})

describe('useHideUsd', () => {
  it('follows the session: free hides dollars, paid shows them', () => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    const hide = run(() => useHideUsd())
    expect(hide.value).toBe(false)
    auth.session = { limits: { prompt_runs: FREE } }
    expect(hide.value).toBe(true)
    auth.session = { limits: { prompt_runs: PAID } }
    expect(hide.value).toBe(false)
  })

  it('lets a payload the screen has decide too', () => {
    setActivePinia(createPinia())
    const estimate = ref(null)
    const hide = run(() => useHideUsd(() => estimate.value))
    expect(hide.value).toBe(false)
    estimate.value = { prompt_runs: { needed: 2, remaining: 4, limit: 20, unlimited: false } }
    expect(hide.value).toBe(true)
    estimate.value = { allowance: { show_usd: false } }
    expect(hide.value).toBe(true)
    estimate.value = { allowance: { show_usd: true }, prompt_runs: PAID }
    expect(hide.value).toBe(false)
  })

  it('works without Pinia, from the payloads alone, and survives a getter that throws', () => {
    const hide = run(() =>
      useHideUsd(
        () => {
          throw new Error('boom')
        },
        () => ({ prompt_runs: FREE }),
      ),
    )
    expect(hide.value).toBe(true)
    expect(run(() => useHideUsd()).value).toBe(false)
  })
})

describe('useSessionRuns', () => {
  it('gives the session runs of a free account, else null', () => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    const runs = run(() => useSessionRuns())
    expect(runs.value).toBeNull()
    auth.session = { limits: { prompt_runs: FREE } }
    expect(runs.value).toMatchObject({ limit: 20, remaining: 18 })
    auth.session = { limits: { prompt_runs: PAID } }
    expect(runs.value).toBeNull()
  })

  it('is null without Pinia', () => {
    expect(run(() => useSessionRuns()).value).toBeNull()
  })
})
