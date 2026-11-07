import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const askAgent = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/agent/askAgent', () => ({ askAgent }))
const insightsApi = vi.hoisted(() => ({ pages: vi.fn(), factCheck: vi.fn() }))
vi.mock('@/api/insights', () => ({ default: insightsApi }))
const agentApi = vi.hoisted(() => ({ trackedPrompts: vi.fn(), listArtifacts: vi.fn(), sendMessage: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: agentApi }))

const { default: AgentTaskDialog } = await import('../AgentTaskDialog.vue')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })
const ok = (data) => ({ success: true, data })
const WEBSITE = {
  id: 'w1',
  name: 'Notion',
  url: 'https://www.notion.so',
  competitors: [
    { name: 'Evernote', domain: 'evernote.com' },
    { name: 'Coda', domain: 'coda.io' },
  ],
}
const STATUS = {
  enabled: true,
  limits: { run_cost_usd: '3.00' },
  allowance: { cap_usd: '5.00', spent_usd: '0.92' },
  writers: {
    page_optimizer: { available: true, needs_usd: '0.32', max_usd: '0.59' },
    pr_writer: { available: false, needs_usd: '0.32', max_usd: '0.43' },
    social_posts: { available: true, max_usd: '0.27' },
  },
}
const AGENTS = {
  page_optimizer: { key: 'page_optimizer', name: 'Page Optimizer', description: 'Rewrites one page of your site.' },
  comparison_page: { key: 'comparison_page', name: 'Comparison Page Agent', description: 'Writes a comparison page.' },
  social_posts: { key: 'social_posts', name: 'Social Posts Agent', description: 'Turns a draft into posts.' },
  pr_writer: { key: 'pr_writer', name: 'PR Agent', description: 'Drafts a press release.' },
  llms_txt: { key: 'llms_txt', name: 'llms.txt Agent', description: 'Drafts an llms.txt file.' },
  messaging_brief: { key: 'messaging_brief', name: 'Messaging Agent', description: 'Writes a messaging brief.' },
}

let router

async function open(key, { status = STATUS, website = WEBSITE } = {}) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent/agents', name: 'agent-agents', component: Blank },
      { path: '/settings/project', name: 'settings-project', component: Blank },
    ],
  })
  await router.push('/projects/w1/agent/agents')
  await router.isReady()
  const wrapper = mount(AgentTaskDialog, {
    props: { open: true, agent: AGENTS[key], websiteId: 'w1', website, status },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const byLabel = (text) => {
  const label = [...dialog().querySelectorAll('label, legend')].find((l) => l.textContent.trim().startsWith(text))
  const id = label?.getAttribute('for')
  return id ? dialog().querySelector(`#${CSS.escape(id)}`) : null
}
const openButton = () => [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open in chat')

async function type(el, value) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await flushPromises()
}

async function submit() {
  openButton().click()
  await flushPromises()
}

beforeEach(() => {
  askAgent.mockClear()
  insightsApi.pages.mockReset()
  insightsApi.factCheck.mockReset()
  agentApi.trackedPrompts.mockReset()
  agentApi.listArtifacts.mockReset()
  insightsApi.pages.mockResolvedValue(
    ok({ pages: [{ url: 'https://notion.so/pricing', path: '/pricing' }, { url: 'https://notion.so/about', path: '/about' }] })
  )
  agentApi.trackedPrompts.mockResolvedValue(ok({ prompts: [{ prompt_id: 'p1', text: 'notion pricing' }] }))
  agentApi.listArtifacts.mockResolvedValue(ok([{ id: 'a9', kind: 'document', title: 'Wiki guide' }]))
  insightsApi.factCheck.mockResolvedValue(
    ok({
      claims: [
        {
          key: '9f2c|contradicted',
          text: "Notion's Plus plan costs $8 per user per month",
          verdict: 'contradicted',
          evidence: { kind: 'page', url: 'https://notion.so/pricing', quote: 'Plus $10 per seat/month' },
        },
      ],
    })
  )
})

describe('AgentTaskDialog', () => {
  it('drafts a Page Optimizer task from a page of the site and hands it to a new chat', async () => {
    await open('page_optimizer')
    expect(insightsApi.pages).toHaveBeenCalledWith('w1', { period: '30d', filter: 'all' })
    expect(agentApi.trackedPrompts).toHaveBeenCalledWith('w1')
    expect(dialog().querySelector('[id$="pages"]').querySelectorAll('option')).toHaveLength(2)
    expect(dialog().textContent).toContain('Use a page of notion.so.')
    expect(dialog().textContent).toContain(
      "The Page Optimizer's own request costs at most $0.59 for a new draft; the whole reply, the agent's requests included, stops at $3.00. $4.08 of AI allowance left this month."
    )
    expect(openButton().disabled).toBe(true)
    await type(byLabel('Page'), '/pricing')
    await type(byLabel('Target prompt (optional)'), 'notion pricing')
    await type(byLabel('Focus (optional)'), 'Answer the price first')
    await submit()
    expect(askAgent).toHaveBeenCalledWith(router, {
      websiteId: 'w1',
      agent: 'page_optimizer',
      from: 'agents',
      text: 'Optimize https://notion.so/pricing so AI engines read and cite it.\nTarget prompt: "notion pricing".\nFocus: Answer the price first',
    })
    // The dialog drafts; it never sends.
    expect(agentApi.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses a page of another site', async () => {
    await open('page_optimizer')
    await type(byLabel('Page'), 'https://evernote.com/pricing')
    await submit()
    expect(askAgent).not.toHaveBeenCalled()
    expect(dialog().querySelector('.ag-atd-hint.is-error').textContent.trim()).toBe('Use a page of notion.so.')
  })

  it('keeps free entry when a list cannot load', async () => {
    insightsApi.pages.mockRejectedValue(new Error('down'))
    await open('page_optimizer')
    expect(dialog().textContent).toContain("Couldn't load this list.")
    await type(byLabel('Page'), 'https://notion.so/teams')
    await submit()
    expect(askAgent.mock.calls[0][1].text).toBe('Optimize https://notion.so/teams so AI engines read and cite it.')
  })

  it('drafts a comparison with a tracked competitor and checks their page', async () => {
    await open('comparison_page')
    expect([...byLabel('Competitor').querySelectorAll('option')].map((o) => o.textContent.trim())).toEqual(['Evernote', 'Coda'])
    await type(byLabel('A page of theirs to read (optional)'), 'https://notion.so/pricing')
    await submit()
    expect(askAgent).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('Use a page of evernote.com.')
    await type(byLabel('A page of theirs to read (optional)'), 'https://evernote.com/compare')
    await submit()
    expect(askAgent.mock.calls[0][1].text).toBe(
      'Write a comparison page: Notion compared with Evernote (evernote.com).\nAlso read their page https://evernote.com/compare.'
    )
  })

  it('asks to track competitors first when there are none', async () => {
    await open('comparison_page', { website: { ...WEBSITE, competitors: [] } })
    expect(dialog().textContent).toContain('Track competitors in Project settings first.')
    expect(openButton().disabled).toBe(true)
  })

  it('needs a channel, and a topic without a draft, for social posts', async () => {
    await open('social_posts')
    expect(agentApi.listArtifacts).toHaveBeenCalledWith('w1', { kinds: ['document', 'page', 'report'] }, { _silentError: true })
    const boxes = [...dialog().querySelectorAll('input[type="checkbox"]')]
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false])
    expect(openButton().disabled).toBe(true)
    await type(byLabel('Topic'), 'Our new AI add-on')
    expect(openButton().disabled).toBe(false)
    for (const b of boxes.filter((x) => x.checked)) {
      b.click()
      await flushPromises()
    }
    expect(openButton().disabled).toBe(true)
    boxes[2].click()
    await flushPromises()
    await submit()
    expect(askAgent.mock.calls[0][1].text).toBe('Write an X thread about: Our new AI add-on')
  })

  it('promotes a saved draft with an optional focus', async () => {
    await open('social_posts')
    const boxes = [...dialog().querySelectorAll('input[type="checkbox"]')]
    boxes[1].click()
    await flushPromises()
    boxes[2].click()
    await flushPromises()
    await type(byLabel('Promote a draft (optional)'), 'a9')
    await type(byLabel('Topic'), '')
    await submit()
    expect(askAgent.mock.calls[0][1].text).toBe('Write LinkedIn posts and an X thread that promote "Wiki guide" (artifact a9).')
  })

  it('drafts correction requests for a contradicted claim, and says the writer cannot start', async () => {
    await open('pr_writer')
    expect(insightsApi.factCheck).toHaveBeenCalledWith('w1', { period: '90d', verdict: 'contradicted' })
    // The allowance left cannot start this writer: the reason shows and the button is off.
    expect(dialog().textContent).toContain('Needs at least $0.32 of AI allowance; $4.08 left this month.')
    expect(openButton().disabled).toBe(true)
  })

  it('drafts a press release about the given topic', async () => {
    await open('pr_writer', { status: { ...STATUS, writers: { pr_writer: { available: true, max_usd: '0.43' } } } })
    const radios = [...dialog().querySelectorAll('input[type="radio"]')]
    expect(radios.map((r) => r.parentElement.textContent.trim())).toEqual(['Press release', 'Media pitch', 'Correction requests'])
    expect(openButton().disabled).toBe(true)
    await type(byLabel('About'), 'Our Series C')
    await submit()
    expect(askAgent.mock.calls[0][1].text).toBe('Write a press release about: Our Series C')
    // Handed over: the dialog closes.
    expect(dialog()).toBeNull()
  })

  it('writes the correction text when the writer can start', async () => {
    await open('pr_writer', { status: { ...STATUS, writers: { pr_writer: { available: true, max_usd: '0.43' } } } })
    const radios = [...dialog().querySelectorAll('input[type="radio"]')]
    radios[2].click()
    await flushPromises()
    await type(byLabel('Claim'), '9f2c|contradicted')
    await submit()
    expect(askAgent.mock.calls[0][1]).toMatchObject({
      agent: 'pr_writer',
      from: 'agents',
      text: 'Draft correction requests to the publishers whose pages repeat this claim: "Notion\'s Plus plan costs $8 per user per month" (Fact check claim 9f2c|contradicted).\nOur evidence (https://notion.so/pricing): "Plus $10 per seat/month"',
    })
  })

  it('says when the Fact check has no contradicted claim', async () => {
    insightsApi.factCheck.mockResolvedValue(ok({ claims: [] }))
    await open('pr_writer', { status: { ...STATUS, writers: { pr_writer: { available: true, max_usd: '0.43' } } } })
    ;[...dialog().querySelectorAll('input[type="radio"]')][2].click()
    await flushPromises()
    expect(dialog().textContent).toContain('The Fact check found no contradicted claims in the last 90 days.')
    expect(openButton().disabled).toBe(true)
  })

  it('drafts the llms.txt and messaging tasks, and leaves out the allowance with no cap', async () => {
    const first = await open('llms_txt', {
      status: { ...STATUS, allowance: { cap_usd: 0, spent_usd: 0 }, writers: { llms_txt: { available: true, max_usd: '0.27' } } },
    })
    expect(dialog().textContent).toContain("The llms.txt Agent's own request costs at most $0.27 for a new draft")
    expect(dialog().textContent).not.toContain('left this month')
    await submit()
    expect(askAgent.mock.calls[0][1].text).toBe('Draft an llms.txt file for notion.so.')

    askAgent.mockClear()
    first.unmount()
    await open('messaging_brief')
    await type(byLabel('Focus (optional)'), 'Teams')
    await submit()
    expect(askAgent.mock.calls[0][1].text).toBe('Write a messaging brief for Notion.\nFocus: Teams')
  })
})
