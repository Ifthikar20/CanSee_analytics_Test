import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const fakeAuth = { user: { id: 7 } }
vi.mock('@/stores/auth', () => ({ useAuthStore: () => fakeAuth }))

const { ASK_FROM_LABELS, ASK_TEXT_MAX, askAgent } = await import('../askAgent')

const Blank = defineComponent({ render: () => h('div') })
const draftKey = 'cs-agent-draft-v1:7:w1:new'

async function makeRouter(path = '/projects/w1/pages') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/pages', name: 'site-pages', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  return router
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  fakeAuth.user = { id: 7 }
  Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('askAgent', () => {
  it('saves the text as the new-chat draft and opens the new chat with the agent and the tab', async () => {
    const router = await makeRouter()
    localStorage.setItem(draftKey, 'an unsent draft the user typed')
    await expect(
      askAgent(router, { websiteId: 'w1', agent: 'page_optimizer', from: 'pages', text: 'Optimize https://a.test/x' }),
    ).resolves.toBe(true)
    expect(localStorage.getItem(draftKey)).toBe('Optimize https://a.test/x')
    const route = router.currentRoute.value
    expect(route.name).toBe('agent-home')
    expect(route.params).toEqual({ websiteId: 'w1' })
    expect(route.query).toEqual({ agent: 'page_optimizer', from: 'pages' })
    // No free text in the URL.
    expect(route.fullPath).not.toContain('Optimize')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('drops an agent outside the ten keys and an unknown tab', async () => {
    const router = await makeRouter()
    await askAgent(router, { websiteId: 'w1', agent: 'evil_agent', from: 'nowhere', text: 'Hello' })
    expect(router.currentRoute.value.query).toEqual({})
    await askAgent(router, { websiteId: 'w1', agent: 'pr_writer', from: 'agents', text: 'Hello' })
    expect(router.currentRoute.value.query).toEqual({ agent: 'pr_writer', from: 'agents' })
  })

  it('clips the text to 2,000 characters', async () => {
    const router = await makeRouter()
    await askAgent(router, { websiteId: 'w1', agent: 'aeo_article', from: 'fan-outs', text: 'x'.repeat(2500) })
    expect(ASK_TEXT_MAX).toBe(2000)
    expect(localStorage.getItem(draftKey)).toHaveLength(2000)
  })

  it('keeps the user in place with a toast when the browser blocks saving the draft', async () => {
    const router = await makeRouter()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await expect(askAgent(router, { websiteId: 'w1', agent: 'aeo_article', from: 'pages', text: 'Hi' })).resolves.toBe(false)
    expect(router.currentRoute.value.name).toBe('site-pages')
    expect(toast.error).toHaveBeenCalledWith(
      "Your browser blocked saving the draft, so it can't be handed to the agent. Allow site storage and try again.",
    )
  })

  it('does nothing without a user, a project or text', async () => {
    const router = await makeRouter()
    await expect(askAgent(router, { websiteId: '', agent: 'aeo_article', from: 'pages', text: 'Hi' })).resolves.toBe(false)
    await expect(askAgent(router, { websiteId: 'w1', agent: 'aeo_article', from: 'pages', text: '  ' })).resolves.toBe(false)
    fakeAuth.user = null
    await expect(askAgent(router, { websiteId: 'w1', agent: 'aeo_article', from: 'pages', text: 'Hi' })).resolves.toBe(false)
    expect(router.currentRoute.value.name).toBe('site-pages')
    expect(localStorage.getItem(draftKey)).toBeNull()
  })

  it("labels every board widget by its title, the Agents page and the old Citations tab's key", () => {
    expect(ASK_FROM_LABELS).toMatchObject({
      'prompt-box': 'Ask AI',
      ranking: 'Prompt ranking',
      summary: 'Summary',
      prompts: 'Prompts',
      visibility: 'AI visibility over time',
      competitors: 'Competitors',
      'fact-check': 'Fact check',
      citations: 'Citations',
      'fan-outs': 'Query fan-outs',
      'prompt-research': 'Prompt research',
      pages: 'Pages',
      'crawler-access': 'Crawler access',
      'ai-crawlers': 'AI crawlers',
      products: 'Products',
      agents: 'Agents',
      sources: 'Citations',
    })
    // 21 widgets, the Agents page and the legacy key; the Overview is gone.
    expect(Object.keys(ASK_FROM_LABELS)).toHaveLength(23)
    expect(ASK_FROM_LABELS.overview).toBeUndefined()
  })

  it('carries the widget a draft came from', async () => {
    const router = await makeRouter()
    await askAgent(router, { websiteId: 'w1', agent: 'aeo_article', from: 'citations', text: 'Hi' })
    expect(router.currentRoute.value.query).toEqual({ agent: 'aeo_article', from: 'citations' })
    // Ask AI's request notice hands its question over with no agent preset.
    await askAgent(router, { websiteId: 'w1', from: 'prompt-box', text: 'how is my visibility doing' })
    expect(router.currentRoute.value.query).toEqual({ from: 'prompt-box' })
    expect(localStorage.getItem(draftKey)).toBe('how is my visibility doing')
  })
})
