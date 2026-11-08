import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const rag = vi.hoisted(() => ({ setAgentCrawl: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client }))
vi.mock('@/api/rag', () => ({ default: rag }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: BrandInputPage } = await import('../BrandInputPage.vue')
const { useAppStore } = await import('@/stores/app')

enableAutoUnmount(afterEach)

const A = { id: 'a', name: 'Alpha' }
const B = { id: 'b', name: 'Beta' }

// The sources list, one stub per group, showing the titles it was given.
const SourceGroupStub = defineComponent({
  name: 'SourceGroup',
  props: { group: { type: Object, required: true } },
  render() {
    return h('ul', { class: 'stub-group' }, this.group.sources.map((s) => h('li', s.title)))
  },
})

function deferred() {
  let resolve
  const promise = new Promise((res) => (resolve = res))
  return { promise, resolve }
}

const STATS = { total: 1, ready: 1, ingesting: 0, pending: 0, failed: 0 }
const sourcesOf = (title) => ({ data: [{ id: title, title, status: 'ready', kind: 'homepage', url: `https://${title}.test` }], meta: { count: 1, stats: STATS } })

let pending

function route(url) {
  const hit = pending.find((p) => url.startsWith(p.prefix))
  if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`))
  return hit.deferred.promise
}

async function mountPage() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = useAppStore()
  app.setWebsites([A, B])
  app.setActiveWebsite(A)
  const wrapper = mount(BrandInputPage, {
    global: { plugins: [pinia], stubs: { SourceGroup: SourceGroupStub, FilterBar: true, SourceDetailDrawer: true } },
  })
  return { wrapper, app }
}

function expect_(prefix) {
  const d = deferred()
  pending.push({ prefix, deferred: d })
  return d
}

const titles = (wrapper) => wrapper.findAll('.stub-group li').map((li) => li.text())
const crawlSwitch = (wrapper) => wrapper.find('button[role="switch"]')

beforeEach(() => {
  pending = []
  client.get.mockReset().mockImplementation((url) => route(url))
  rag.setAgentCrawl.mockReset()
})

describe('BrandInputPage after a quick project switch', () => {
  it("never shows the previous project's sources when its answer lands late", async () => {
    const aSources = expect_('/rag/a/sources/')
    expect_('/rag/a/agent-crawl/')
    const { wrapper, app } = await mountPage()
    await flushPromises()

    const bSources = expect_('/rag/b/sources/')
    expect_('/rag/b/agent-crawl/')
    app.setActiveWebsite(B)
    await flushPromises()
    bSources.resolve(sourcesOf('beta-home'))
    await flushPromises()
    expect(titles(wrapper)).toContain('beta-home')

    aSources.resolve(sourcesOf('alpha-home'))
    await flushPromises()
    expect(titles(wrapper)).not.toContain('alpha-home')
    expect(titles(wrapper)).toContain('beta-home')
  })

  it("never shows the previous project's agent-crawl consent", async () => {
    expect_('/rag/a/sources/').resolve(sourcesOf('alpha-home'))
    const aCrawl = expect_('/rag/a/agent-crawl/')
    const { wrapper, app } = await mountPage()
    await flushPromises()

    expect_('/rag/b/sources/').resolve(sourcesOf('beta-home'))
    const bCrawl = expect_('/rag/b/agent-crawl/')
    app.setActiveWebsite(B)
    await flushPromises()
    bCrawl.resolve({ data: { enabled: false, enabled_at: null, last_seeded_at: null } })
    await flushPromises()
    aCrawl.resolve({ data: { enabled: true, enabled_at: '2026-11-01T00:00:00Z', last_seeded_at: null } })
    await flushPromises()

    expect(crawlSwitch(wrapper).attributes('aria-checked')).toBe('false')
    expect(crawlSwitch(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('keeps the newest list when two loads of the same project answer out of order', async () => {
    const first = expect_('/rag/a/sources/')
    expect_('/rag/a/agent-crawl/').resolve({ data: { enabled: false } })
    const { wrapper } = await mountPage()
    await flushPromises()
    pending = pending.filter((p) => p.deferred !== first)
    const second = expect_('/rag/a/sources/')
    await wrapper.findAll('button').find((b) => b.text().includes('Refresh')).trigger('click')
    second.resolve(sourcesOf('newest'))
    await flushPromises()
    first.resolve(sourcesOf('stale'))
    await flushPromises()
    expect(titles(wrapper)).toContain('newest')
    expect(titles(wrapper)).not.toContain('stale')
  })
})
