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
  research_agents: { key: 'research_agents', name: 'Research Agents', entryAgent: 'gap_analyst', description: 'A team of agents.' },
  gap_analyst: { key: 'gap_analyst', name: 'Gap Analyst', description: 'Compares Google and AI answers.' },
  landing_page: { key: 'landing_page', name: 'Landing Page Agent', description: 'Drafts a landing page.' },
  aeo_article: { key: 'aeo_article', name: 'AEO Article Agent', description: 'Writes an answer-first article.' },
  ad_campaign: { key: 'ad_campaign', name: 'Ad Campaign Agent', description: 'Builds a Google Search campaign.' },
}

let router

async function open(key, { status = STATUS, website = WEBSITE, template = '', websiteId = 'w1' } = {}) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent/agents', name: 'agent-agents', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/settings/project', name: 'settings-project', component: Blank },
    ],
  })
  await router.push('/projects/w1/agent/agents')
  await router.isReady()
  const wrapper = mount(AgentTaskDialog, {
    props: { open: true, agent: AGENTS[key], websiteId, website, status, template },
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

  it('never shows a free account dollars', async () => {
    const free = { ...STATUS, allowance: { ...STATUS.allowance, show_usd: false } }
    await open('page_optimizer', { status: free })
    expect(dialog().textContent).toContain("The Page Optimizer draws on this month's free AI allowance.")
    expect(dialog().textContent).not.toContain('$')
  })

  it('says a free writer cannot start without dollars', async () => {
    await open('pr_writer', { status: { ...STATUS, allowance: { ...STATUS.allowance, show_usd: false } } })
    expect(dialog().textContent).toContain("Needs more of this month's free AI allowance than is left.")
    expect(dialog().textContent).not.toContain('$')
    expect(openButton().disabled).toBe(true)
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

describe('AgentTaskDialog task templates', () => {
  const ENGINES = ['chatgpt', 'claude', 'gemini', 'grok', 'perplexity'].map((key) => ({ key, label: key, configured: true }))
  const RESEARCH_STATUS = {
    ...STATUS,
    configured: true,
    live_available: true,
    engines: ENGINES,
    google: { configured: true, key_settings: [] },
    allowance: { cap_usd: '29.25', spent_usd: '3.00', exceeded: false, show_usd: true },
    swarm: { enabled: true, max_agents: 30 },
    research: { available: true, reason: null, message: '' },
    writers: {
      ...STATUS.writers,
      landing_page: { available: true, max_usd: '1.41' },
      aeo_article: { available: true, max_usd: '0.59' },
      ad_campaign: { available: true, max_usd: '0.59' },
    },
  }
  const radios = () => [...dialog().querySelectorAll('input[type="radio"]')]
  const radioLabels = () => radios().map((r) => r.closest('label').querySelector('.ag-atd-template-name').textContent.trim())
  const pick = async (label) => {
    radios()[radioLabels().indexOf(label)].click()
    await flushPromises()
  }
  const preview = () => dialog().querySelector('.ag-atd-preview-text')?.textContent || ''
  const competitorBoxes = () => [...dialog().querySelectorAll('input[type="checkbox"]')]

  it('starts a research preset as a Gap Analyst chat with the tracked competitors and the prompt count', async () => {
    await open('research_agents', { status: RESEARCH_STATUS, template: 'competitors' })
    expect(dialog().querySelector('[role="dialog"] h2, .ag-dialog-title').textContent).toBe('Research Agents')
    expect(radioLabels()).toEqual(['Google vs AI gap', 'Competitor check', 'Sources audit', 'Check one prompt'])
    expect(radios()[1].checked).toBe(true)
    // Every tracked competitor is ticked to start with.
    expect(competitorBoxes().map((b) => [b.parentElement.textContent.trim(), b.checked])).toEqual([
      ['Evernote', true],
      ['Coda', true],
    ])
    expect(preview()).toBe(
      'Run the research agents to compare us with Evernote (evernote.com) and Coda (coda.io) on our tracked prompts.\nRead 2 competitor pages per prompt and list what their pages do that ours do not.\nUse up to 2 of our tracked prompts.'
    )
    expect(dialog().textContent).toContain('Nothing runs until you send it.')
    competitorBoxes()[1].click()
    await flushPromises()
    await submit()
    expect(askAgent).toHaveBeenCalledWith(router, {
      websiteId: 'w1',
      agent: 'gap_analyst',
      from: 'agents',
      text: 'Run the research agents to compare us with Evernote (evernote.com) on our tracked prompts.\nRead 2 competitor pages per prompt and list what their pages do that ours do not.\nUse up to 2 of our tracked prompts.',
    })
    expect(agentApi.sendMessage).not.toHaveBeenCalled()
  })

  it('needs at least one competitor for a competitor check', async () => {
    await open('research_agents', { status: RESEARCH_STATUS, template: 'competitors' })
    for (const b of competitorBoxes()) {
      b.click()
      await flushPromises()
    }
    expect(openButton().disabled).toBe(true)
    await submit()
    expect(askAgent).not.toHaveBeenCalled()
  })

  it('asks to track competitors first when there are none', async () => {
    await open('research_agents', { status: RESEARCH_STATUS, template: 'competitors', website: { ...WEBSITE, competitors: [] } })
    expect(dialog().textContent).toContain('Track competitors in Project settings first.')
    expect(openButton().disabled).toBe(true)
    // Another preset needs none.
    await pick('Sources audit')
    expect(openButton().disabled).toBe(false)
  })

  it('checks one prompt picked from the tracked prompts', async () => {
    await open('research_agents', { status: RESEARCH_STATUS })
    // No template asked for: the first one.
    expect(radios()[0].checked).toBe(true)
    expect(openButton().disabled).toBe(false)
    await pick('Check one prompt')
    expect(agentApi.trackedPrompts).toHaveBeenCalledWith('w1')
    expect(byLabel('Prompt')).not.toBeNull()
    expect([...dialog().querySelectorAll('datalist option')].map((o) => o.value)).toEqual(['notion pricing'])
    expect(dialog().textContent).toContain('Pick one of your tracked prompts or type another.')
    expect(openButton().disabled).toBe(true)
    await type(byLabel('Prompt'), 'notion pricing')
    await type(byLabel('Focus (optional)'), 'Teams plan')
    await submit()
    expect(askAgent.mock.calls[0][1]).toMatchObject({
      agent: 'gap_analyst',
      text: 'Run the research agents on one prompt: "notion pricing".\nCompare where Google ranks us with how each AI engine answers it.\nFocus: Teams plan',
    })
  })

  it('leaves out the prompt count when the server does not state a ceiling', async () => {
    await open('research_agents', { status: { ...RESEARCH_STATUS, swarm: { enabled: true } }, template: 'gap' })
    expect(preview()).toBe(
      'Run the research agents on our tracked prompts and compare where Google ranks us with how each AI engine answers.'
    )
  })

  it('says why the research agents cannot run, and what to do', async () => {
    vi.stubEnv('DEV', false)
    try {
      await open('research_agents', {
        status: {
          ...RESEARCH_STATUS,
          swarm: { enabled: false, max_agents: 30 },
          research: { available: false, reason: 'research_disabled', message: 'The research agents are turned off on this workspace.' },
        },
      })
      const why = dialog().querySelector('.ag-atd-unavailable')
      expect(why.getAttribute('role')).toBe('status')
      expect(why.textContent).toContain('The research agents are turned off on this workspace.')
      expect(why.textContent).toContain('Ask your workspace admin to turn them on.')
      expect(why.textContent).not.toContain('AGENT_SWARM_ENABLED')
      expect(openButton().disabled).toBe(true)
      // No way around it.
      expect([...dialog().querySelectorAll('a')].some((a) => a.textContent.trim() === 'Blank chat')).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('words research costs as free prompt runs for a free account and the reply ceiling for a paid one', async () => {
    const free = {
      ...RESEARCH_STATUS,
      allowance: { cap_usd: '3.00', spent_usd: '1.00', exceeded: false, show_usd: false },
      prompt_runs: { unlimited: false, limit: 20, used: 7, reserved: 0, remaining: 13 },
    }
    const first = await open('research_agents', { status: free })
    const text = dialog().textContent
    expect(text).toContain('Each prompt answered by one AI engine uses one free prompt run. Up to 2 prompts × 5 AI engines = 10 free prompt runs; 13 left this month.')
    // The Gap Analyst plans its own research: the runs left, without a total.
    first.unmount()
    const second = await open('gap_analyst', { status: free })
    expect(dialog().textContent).toContain('Each prompt answered by one AI engine uses one free prompt run. 13 free prompt runs left this month.')
    expect(dialog().textContent).not.toContain('×')
    expect(text).not.toMatch(/\$/)
    expect(dialog().textContent).not.toMatch(/\$/)
    second.unmount()
    await open('gap_analyst', { status: RESEARCH_STATUS })
    expect(dialog().textContent).toContain('The whole reply, research included, stops at $3.00.')
  })

  it('counts the competitor check with its 2 competitor pages a prompt', async () => {
    // Ceiling 50, Google and 5 engines: 11 agents a prompt for the competitor
    // check (4 prompts), 10 for the other presets (5 prompts).
    await open('research_agents', { status: { ...RESEARCH_STATUS, swarm: { enabled: true, max_agents: 50 } }, template: 'competitors' })
    expect(preview()).toContain('Use up to 4 of our tracked prompts.')
    await pick('Google vs AI gap')
    expect(preview()).toContain('Use up to 5 of our tracked prompts.')
    await pick('Competitor check')
    expect(preview()).toContain('Use up to 4 of our tracked prompts.')
  })

  describe('on a free account', () => {
    const free = (runs, over = {}) => ({
      ...RESEARCH_STATUS,
      swarm: { enabled: true, max_agents: 50 },
      allowance: { cap_usd: '3.00', spent_usd: '0.00', exceeded: false, show_usd: false },
      prompt_runs: { unlimited: false, limit: 20, used: 0, reserved: 0, ...runs },
      ...over,
    })
    const cost = () => [...dialog().querySelectorAll('.ag-atd-cost')].map((p) => p.textContent.trim()).join(' ')

    it('drafts no more prompts than the free prompt runs left pay for, and states the total', async () => {
      // A new account: 20 runs, 5 engines: 4 prompts (20 runs), not 5 (25).
      await open('research_agents', { status: free({ remaining: 20 }), template: 'gap' })
      expect(preview()).toContain('Use up to 4 of our tracked prompts.')
      expect(cost()).toBe(
        'Each prompt answered by one AI engine uses one free prompt run. Up to 4 prompts × 5 AI engines = 20 free prompt runs; 20 left this month.'
      )
      expect(dialog().textContent).not.toMatch(/\$/)
      await pick('Sources audit')
      expect(preview()).toContain('Use up to 4 of our tracked prompts.')
      // The one-prompt preset takes one prompt's runs.
      await pick('Check one prompt')
      expect(cost()).toContain('Up to 1 prompt × 5 AI engines = 5 free prompt runs; 20 left this month.')
    })

    it('fits 13 runs left into 2 prompts', async () => {
      await open('research_agents', { status: free({ remaining: 13 }), template: 'competitors' })
      expect(preview()).toContain('Use up to 2 of our tracked prompts.')
      expect(cost()).toContain('Up to 2 prompts × 5 AI engines = 10 free prompt runs; 13 left this month.')
    })

    it('leaves out the prompt count and asks for fewer engines when one prompt does not fit', async () => {
      await open('research_agents', { status: free({ remaining: 3 }), template: 'gap' })
      expect(preview()).toBe(
        'Run the research agents on our tracked prompts and compare where Google ranks us with how each AI engine answers.'
      )
      expect(cost()).toBe(
        'Each prompt answered by one AI engine uses one free prompt run. 3 free prompt runs left: one prompt asks all 5 AI engines set up here, so ask for fewer engines.'
      )
    })

    it('says no free prompt runs are left', async () => {
      await open('research_agents', { status: free({ remaining: 0 }), template: 'sources' })
      expect(preview()).not.toContain('Use up to')
      expect(cost()).toBe(
        'Each prompt answered by one AI engine uses one free prompt run. No free prompt runs are left this month, so a research cannot ask the AI engines until they renew.'
      )
    })

    it('keeps the plain line when the engines set up are not listed', async () => {
      await open('research_agents', { status: free({ remaining: 13 }, { engines: undefined }), template: 'gap' })
      // Unknown engines count as five for the count, but no total is guessed.
      expect(preview()).toContain('Use up to 2 of our tracked prompts.')
      expect(cost()).toBe('Each prompt answered by one AI engine uses one free prompt run. 13 free prompt runs left this month.')
    })

    it('follows a new status (the runs left change) while open', async () => {
      const w = await open('research_agents', { status: free({ remaining: 20 }), template: 'gap' })
      expect(preview()).toContain('Use up to 4 of our tracked prompts.')
      await w.setProps({ status: free({ remaining: 6 }) })
      await flushPromises()
      expect(preview()).toContain('Use up to 1 of our tracked prompts.')
      expect(cost()).toContain('Up to 1 prompt × 5 AI engines = 5 free prompt runs; 6 left this month.')
    })
  })

  it('drafts the Gap Analyst templates', async () => {
    await open('gap_analyst', { status: RESEARCH_STATUS })
    expect(radioLabels()).toEqual(['Tracked prompts', 'One prompt', 'Against competitors'])
    expect(openButton().disabled).toBe(false)
    await submit()
    expect(askAgent.mock.calls[0][1]).toMatchObject({
      agent: 'gap_analyst',
      text: 'Research how we rank on Google and in AI answers for our tracked prompts, and compare the two.',
    })
  })

  it('needs the search for a landing page, and leaves out fields of another template', async () => {
    await open('landing_page', { status: RESEARCH_STATUS })
    expect(radioLabels()).toEqual(['For one search', 'Where we are missing most', 'For one offering'])
    expect(byLabel('Search or prompt')).not.toBeNull()
    expect(byLabel('Offering (optional)')).not.toBeNull()
    expect(byLabel('Call to action (optional)')).not.toBeNull()
    expect(openButton().disabled).toBe(true)
    await type(byLabel('Search or prompt'), 'team wiki')
    await type(byLabel('Offering (optional)'), 'Notion Teams')
    expect(preview()).toBe('Draft a landing page for the search "team wiki".\nOffering: Notion Teams')
    await pick('Where we are missing most')
    // The search field is gone, and so is its value from the draft.
    expect(byLabel('Search or prompt')).toBeNull()
    expect(preview()).toBe('Draft a landing page for the tracked prompt where we are missing the most.\nOffering: Notion Teams')
    await pick('For one offering')
    expect(byLabel('Offering')).not.toBeNull()
    await submit()
    expect(askAgent.mock.calls[0][1]).toMatchObject({ agent: 'landing_page', text: 'Draft a landing page for our offering: Notion Teams.' })
  })

  it('shows the writer cost line for a general writer', async () => {
    await open('landing_page', { status: RESEARCH_STATUS })
    expect(dialog().textContent).toContain("The Landing Page Agent's own request costs at most $1.41 for a new draft")
  })

  it('drafts an AEO article for a question', async () => {
    await open('aeo_article', { status: RESEARCH_STATUS, template: 'question' })
    await type(byLabel('Question'), 'What is a team wiki?')
    await type(byLabel('Audience (optional)'), 'IT leads')
    await submit()
    expect(askAgent.mock.calls[0][1]).toMatchObject({
      agent: 'aeo_article',
      text: 'Write an answer-first article for the question "What is a team wiki?".\nAudience: IT leads',
    })
  })

  it('checks the ad campaign landing page is on the site', async () => {
    await open('ad_campaign', { status: RESEARCH_STATUS })
    await type(byLabel('Offering'), 'Notion AI')
    await type(byLabel('Landing page (optional)'), 'https://evernote.com/ai')
    await submit()
    expect(askAgent).not.toHaveBeenCalled()
    const hint = dialog().querySelector('.ag-atd-hint.is-error')
    expect(hint.textContent.trim()).toBe('Use a page of notion.so.')
    expect(byLabel('Landing page (optional)').getAttribute('aria-invalid')).toBe('true')
    await type(byLabel('Landing page (optional)'), '/ai')
    await type(byLabel('Region (optional)'), 'United States')
    await submit()
    expect(askAgent.mock.calls[0][1].text).toBe(
      'Build a Google Search ad campaign for Notion AI.\nRegion: United States\nLanding page: https://notion.so/ai'
    )
  })

  it('offers a blank chat with the agent picked, only for template agents', async () => {
    const first = await open('landing_page', { status: RESEARCH_STATUS })
    const blank = [...dialog().querySelectorAll('a')].find((a) => a.textContent.trim() === 'Blank chat')
    expect(blank.getAttribute('href')).toBe('/projects/w1/agent?agent=landing_page')
    first.unmount()
    const second = await open('research_agents', { status: RESEARCH_STATUS })
    expect([...dialog().querySelectorAll('a')].find((a) => a.textContent.trim() === 'Blank chat').getAttribute('href')).toBe(
      '/projects/w1/agent?agent=gap_analyst'
    )
    second.unmount()
    await open('page_optimizer')
    expect([...dialog().querySelectorAll('a')].some((a) => a.textContent.trim() === 'Blank chat')).toBe(false)
  })

  it('says when the tracked prompts cannot load, keeps free entry and retries', async () => {
    agentApi.trackedPrompts.mockRejectedValueOnce(new Error('down'))
    await open('gap_analyst', { status: RESEARCH_STATUS, template: 'prompt' })
    expect(dialog().textContent).toContain("Couldn't load your tracked prompts.")
    await type(byLabel('Prompt'), 'my own prompt')
    expect(openButton().disabled).toBe(false)
    ;[...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Try again').click()
    await flushPromises()
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(2)
    expect([...dialog().querySelectorAll('datalist option')].map((o) => o.value)).toEqual(['notion pricing'])
  })

  it('starts over on a project switch and drops the old project list when it answers late', async () => {
    let resolveOld
    agentApi.trackedPrompts.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
    agentApi.trackedPrompts.mockImplementationOnce(async () => ok({ prompts: [{ prompt_id: 'p2', text: 'acme pricing' }] }))
    const wrapper = await open('gap_analyst', { status: RESEARCH_STATUS, template: 'prompt' })
    await type(byLabel('Prompt'), 'typed for w1')
    await wrapper.setProps({ websiteId: 'w2', website: { id: 'w2', name: 'Acme', url: 'https://acme.io', competitors: [] } })
    await flushPromises()
    expect(agentApi.trackedPrompts).toHaveBeenLastCalledWith('w2')
    // The old project's answer arrives after the new one.
    resolveOld(ok({ prompts: [{ prompt_id: 'p1', text: 'notion pricing' }] }))
    await flushPromises()
    expect([...dialog().querySelectorAll('datalist option')].map((o) => o.value)).toEqual(['acme pricing'])
    // What was typed for the old project is gone.
    expect(byLabel('Prompt').value).toBe('')
    await type(byLabel('Prompt'), 'acme pricing')
    await submit()
    expect(askAgent.mock.calls[0][1]).toMatchObject({ websiteId: 'w2', agent: 'gap_analyst' })
  })

  it('never hands a task over while the agent cannot run, even when the form is submitted with Enter', async () => {
    const blocked = {
      ...RESEARCH_STATUS,
      research: { available: false, reason: 'research_disabled', message: 'The research agents are turned off on this workspace.' },
    }
    await open('research_agents', { status: blocked, template: 'gap' })
    expect(openButton().disabled).toBe(true)
    dialog().querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(askAgent).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
  })

  it('never hands a writer task over when the agent process is down', async () => {
    await open('landing_page', { status: { ...RESEARCH_STATUS, live_available: false } })
    expect(dialog().textContent).toContain("The AI agent isn't running right now.")
    await type(byLabel('Search or prompt'), 'notion pricing')
    dialog().querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(askAgent).not.toHaveBeenCalled()
  })

  it('cannot open without a project', async () => {
    await open('gap_analyst', { status: RESEARCH_STATUS, websiteId: null })
    expect(openButton().disabled).toBe(true)
    expect(agentApi.trackedPrompts).not.toHaveBeenCalled()
  })
})
