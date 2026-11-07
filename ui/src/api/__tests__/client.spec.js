import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import axios, { AxiosError } from 'axios'
import { createPinia, setActivePinia } from 'pinia'

const routerMock = vi.hoisted(() => ({ currentRoute: { value: { name: 'dashboard' } }, push: vi.fn() }))
vi.mock('@/router', () => ({ default: routerMock }))
vi.mock('@/composables/useToast', () => ({
    useToast: () => ({ error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

let client
let auth

function respond(config, status, data = {}) {
    const response = { status, statusText: String(status), data, headers: {}, config }
    if (status >= 200 && status < 300) return response
    throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, null, response)
}

beforeEach(async () => {
    vi.resetModules()
    setActivePinia(createPinia())
    localStorage.clear()
    routerMock.push.mockReset()
    client = await import('@/api/client')
    const { useAuthStore } = await import('@/stores/auth')
    auth = useAuthStore()
    auth.accessToken = 'old'
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('authHeaders', () => {
    it('carries the bearer token and tracing ids', () => {
        const headers = client.authHeaders()
        expect(headers.Authorization).toBe('Bearer old')
        expect(headers['X-Request-ID']).toEqual(expect.any(String))
        expect(headers['X-Client-Id']).toMatch(/^web-/)
        expect(client.authHeaders()['X-Request-ID']).not.toBe(headers['X-Request-ID'])
    })

    it('omits Authorization when signed out', () => {
        auth.accessToken = null
        expect(client.authHeaders()).not.toHaveProperty('Authorization')
    })
})

describe('refresh', () => {
    it('shares one refresh between concurrent 401s and retries each request once', async () => {
        const api = client.default
        api.defaults.adapter = vi.fn(async (config) =>
            config.headers.Authorization === 'Bearer fresh' ? respond(config, 200, { success: true, data: config.url }) : respond(config, 401)
        )
        const refresh = vi.spyOn(axios, 'post').mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 5))
            return { data: { success: true, data: { access: 'fresh' } } }
        })
        const [a, b] = await Promise.all([api.get('/a/'), api.get('/b/')])
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(refresh.mock.calls[0][0]).toBe('/api/v1/auth/refresh/')
        expect([a.data, b.data]).toEqual(['/a/', '/b/'])
        expect(auth.accessToken).toBe('fresh')
        expect(api.defaults.adapter).toHaveBeenCalledTimes(4)
    })

    it('refreshAccessToken is single-flight for direct callers too', async () => {
        const refresh = vi.spyOn(axios, 'post').mockResolvedValue({ data: { access: 'fresh' } })
        const [x, y] = await Promise.all([client.refreshAccessToken(), client.refreshAccessToken()])
        expect([x, y]).toEqual(['fresh', 'fresh'])
        expect(refresh).toHaveBeenCalledTimes(1)
    })

    it('a refused refresh signs out once and stops further refreshes', async () => {
        const api = client.default
        api.defaults.adapter = vi.fn(async (config) => respond(config, 401))
        const refresh = vi.spyOn(axios, 'post').mockImplementation(async () => {
            throw new AxiosError('HTTP 401', 'ERR_BAD_REQUEST', {}, null, { status: 401, data: {}, headers: {} })
        })
        await expect(api.get('/a/')).rejects.toMatchObject({ response: { status: 401 } })
        expect(auth.accessToken).toBeNull()
        expect(routerMock.push).toHaveBeenCalledWith({ name: 'login' })
        await expect(client.refreshAccessToken()).rejects.toThrow('Session expired')
        await expect(api.get('/b/')).rejects.toMatchObject({ response: { status: 401 } })
        expect(refresh).toHaveBeenCalledTimes(1)
    })

    it('a network failure during refresh keeps the user signed in', async () => {
        vi.spyOn(axios, 'post').mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'))
        await expect(client.refreshAccessToken()).rejects.toThrow('Network Error')
        expect(auth.accessToken).toBe('old')
        expect(routerMock.push).not.toHaveBeenCalled()
    })
})

describe('429', () => {
    it('never re-sends a request marked _noRetry429', async () => {
        const api = client.default
        api.defaults.adapter = vi.fn(async (config) =>
            respond(config, 429, { success: false, error: { code: 'agent_busy', message: 'You already have a run in progress.' } })
        )
        const err = await api.post('/agent/live/x/', {}, { _noRetry429: true, _silentError: true }).catch((e) => e)
        expect(err.response.status).toBe(429)
        expect(err.displayMessage).toBe('You already have a run in progress.')
        expect(api.defaults.adapter).toHaveBeenCalledTimes(1)
    })

    it('still retries other requests twice', async () => {
        vi.useFakeTimers()
        const api = client.default
        api.defaults.adapter = vi.fn(async (config) => respond(config, 429))
        const pending = api.get('/x/', { _silentError: true }).catch((e) => e)
        await vi.advanceTimersByTimeAsync(2000)
        await vi.advanceTimersByTimeAsync(4000)
        const err = await pending
        expect(err.response.status).toBe(429)
        expect(api.defaults.adapter).toHaveBeenCalledTimes(3)
    })
})
