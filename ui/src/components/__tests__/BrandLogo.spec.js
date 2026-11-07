import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const client = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client }))

const { default: BrandLogo } = await import('../BrandLogo.vue')

const mounted = []

function logo(props) {
  const wrapper = mount(BrandLogo, { props })
  mounted.push(wrapper)
  return wrapper
}

const src = (wrapper) => (wrapper.find('img').exists() ? wrapper.find('img').attributes('src') : null)

let fetchSpy

beforeEach(() => {
  localStorage.clear()
  client.get.mockReset()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.unstubAllGlobals()
})

describe('BrandLogo', () => {
  it('crawls the domain, then guesses by name, then shows the initial', async () => {
    client.get.mockResolvedValue({ data: { logo: 'https://acme.io/icon.png' } })
    fetchSpy.mockResolvedValue({ ok: true, json: async () => [{ domain: 'acme.com' }] })
    const wrapper = logo({ name: 'Acme', domain: 'acme.io' })
    await flushPromises()
    expect(client.get).toHaveBeenCalledWith('/prompt-library/logo/', { params: { domain: 'acme.io' }, _silentError: true })
    expect(src(wrapper)).toBe('https://acme.io/icon.png')

    await wrapper.find('img').trigger('error')
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(src(wrapper)).toBe('https://logo.clearbit.com/acme.com')

    await wrapper.find('img').trigger('error')
    expect(src(wrapper)).toBe('https://www.google.com/s2/favicons?domain=acme.com&sz=64')

    await wrapper.find('img').trigger('error')
    expect(src(wrapper)).toBeNull()
    expect(wrapper.find('.brand-logo-badge').text()).toBe('A')
  })

  it('tries a given src first and skips a crawl that returns the same broken address', async () => {
    client.get.mockResolvedValue({ data: { logo: 'https://acme.io/favicon.ico' } })
    const wrapper = logo({ name: 'Acme', domain: 'acme.io', src: 'https://acme.io/favicon.ico', guess: false })
    expect(src(wrapper)).toBe('https://acme.io/favicon.ico')
    expect(client.get).not.toHaveBeenCalled()

    await wrapper.find('img').trigger('error')
    await flushPromises()
    expect(client.get).toHaveBeenCalledTimes(1)
    expect(src(wrapper)).toBeNull()
    expect(wrapper.find('.brand-logo-badge').text()).toBe('A')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shows the initial without guessing when the crawl fails and guessing is off', async () => {
    client.get.mockRejectedValue(new Error('offline'))
    const wrapper = logo({ name: 'tutornote', domain: 'tutornote.ai', guess: false })
    await flushPromises()
    expect(src(wrapper)).toBeNull()
    expect(wrapper.find('.brand-logo-badge').text()).toBe('T')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('drops a crawl answer that arrives after the domain changed', async () => {
    let answerOld
    client.get
      .mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve }))
      .mockResolvedValueOnce({ data: { logo: 'https://new.io/logo.png' } })
    const wrapper = logo({ name: 'Acme', domain: 'old.io', guess: false })
    await wrapper.setProps({ domain: 'new.io' })
    await flushPromises()
    expect(src(wrapper)).toBe('https://new.io/logo.png')

    answerOld({ data: { logo: 'https://old.io/logo.png' } })
    await flushPromises()
    expect(src(wrapper)).toBe('https://new.io/logo.png')
  })
})
