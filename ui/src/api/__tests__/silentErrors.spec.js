import { beforeEach, describe, expect, it, vi } from 'vitest'

// Requests whose failure the calling screen shows itself. Without
// _silentError the client interceptor would also toast (or queue a toast
// that no container on that screen shows).
const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client }))

const { default: billingApi } = await import('@/api/billing')

beforeEach(() => {
  Object.values(client).forEach((fn) => fn.mockReset().mockResolvedValue({ data: {} }))
})

describe('silent requests', () => {
  it('dismissing the paywall reports its failure on the paywall, not through a toast', async () => {
    await billingApi.dismissPaywall()
    expect(client.post).toHaveBeenCalledWith('/billing/paywall/dismiss/', {}, { _silentError: true })
  })
})
