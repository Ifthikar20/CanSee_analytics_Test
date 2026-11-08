import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAgentUiStore } from '@/stores/agentUi'
import { useAppStore } from '@/stores/app'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
const listWebsites = vi.fn()
vi.mock('@/api/websites', () => ({ default: { list: (...args) => listWebsites(...args) } }))

const { default: AgentProjectsPage } = await import('../AgentProjectsPage.vue')
const { default: AgentAgentsPage } = await import('../AgentAgentsPage.vue')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })
// The Starts from links open a widget's panel on the Analytics board.
const ANALYTICS_STUBS = [
  { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
  { path: '/dashboard', name: 'dashboard', component: Blank },
]

async function setup(component, path, { websites = null, props = {} } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (websites) useAppStore().setWebsites(websites)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/agent/projects', name: 'agent-projects', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/agents', name: 'agent-agents', component: Blank },
      { path: '/settings/project', name: 'settings-project', component: Blank },
      ...ANALYTICS_STUBS,
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(component, { props, global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router, ui: useAgentUiStore(), app: useAppStore() }
}

beforeEach(() => {
  listWebsites.mockReset()
  Object.assign(fakeAgent, {
    websiteId: 'w1',
    catalog: [],
    status: null,
    loadCatalog: vi.fn(async () => fakeAgent.catalog),
  })
})

describe('AgentProjectsPage', () => {
  it('waits for the website list before saying there are no projects', async () => {
    let resolve
    listWebsites.mockReturnValue(new Promise((r) => (resolve = r)))
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/agent/projects', name: 'agent-projects', component: Blank }],
    })
    await router.push('/agent/projects')
    const wrapper = mount(AgentProjectsPage, { global: { plugins: [pinia, router] } })
    expect(wrapper.text()).toContain('Loading projects')
    expect(wrapper.text()).not.toContain('No projects yet.')
    resolve({ data: [] })
    await flushPromises()
    expect(wrapper.text()).toContain('No projects yet.')
  })

  it('says the list failed to load instead of "No projects yet", and retries', async () => {
    listWebsites.mockRejectedValueOnce(Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status: 500, data: {} } }))
    const { wrapper } = await setup(AgentProjectsPage, '/agent/projects')
    expect(wrapper.text()).toContain("Couldn't load your projects.")
    expect(wrapper.text()).not.toContain('No projects yet.')

    listWebsites.mockResolvedValueOnce({ data: [{ id: 'w1', name: 'Wrenfield' }] })
    await wrapper.findAll('button').find((b) => b.text() === 'Try again').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('li.ag-project')).toHaveLength(1)
  })

  it('lists projects with the current one marked and opens one', async () => {
    const { wrapper, router, app } = await setup(AgentProjectsPage, '/agent/projects', {
      websites: [
        { id: 'w1', name: 'Wrenfield', url: 'https://www.wrenfield.com', industry: 'E-bikes' },
        { id: 'w2', name: 'Acme', url: 'acme.io' },
      ],
    })
    const cards = wrapper.findAll('li.ag-project')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('Wrenfield')
    expect(cards[0].text()).toContain('Current')
    expect(cards[0].text()).toContain('wrenfield.com')
    expect(cards[0].text()).toContain('E-bikes')
    expect(cards[1].text()).not.toContain('Current')
    await cards[1].find('button[aria-label="Open Acme"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/projects/w2/agent')
    expect(app.activeWebsite.id).toBe('w2')
  })

  it('opens the add project dialog', async () => {
    const { wrapper, ui } = await setup(AgentProjectsPage, '/agent/projects', { websites: [{ id: 'w1', name: 'One' }] })
    await wrapper.findAll('button').find((b) => b.text() === 'Add project').trigger('click')
    expect(ui.addProjectOpen).toBe(true)
  })
})

describe('AgentAgentsPage', () => {
  const CATALOG = [
    {
      key: 'gap_analyst',
      name: 'Gap Analyst',
      description: 'Compares Google and AI answers.',
      output_kind: 'report',
      starter: 'Research our brand',
      teams: [
        { key: 'aeo_seo', label: 'AEO and SEO' },
        { key: 'growth', label: 'Growth' },
      ],
    },
    {
      key: 'page_optimizer',
      name: 'Page Optimizer',
      description: 'Rewrites one page of your site.',
      output_kind: 'document',
      starter: 'Optimize our page that engines retrieve but never cite.',
      teams: [
        { key: 'aeo_seo', label: 'AEO and SEO' },
        { key: 'content', label: 'Content' },
      ],
    },
    { key: 'landing_page', name: 'Landing Page Agent', description: 'Builds a page.', output_kind: 'page', starter: '' },
    {
      key: 'social_posts',
      name: 'Social Posts Agent',
      description: 'Turns a draft into posts.',
      output_kind: 'document',
      starter: '',
      teams: [
        { key: 'social', label: 'Social' },
        { key: 'content', label: 'Content' },
      ],
    },
  ]

  const cardNames = (wrapper) => wrapper.findAll('[role="tabpanel"] li.ag-agent').map((li) => li.find('h2').text())

  it('renders a card per agent with its teams, deliverable and Use opening its task dialog', async () => {
    fakeAgent.catalog = CATALOG
    const { wrapper } = await setup(AgentAgentsPage, '/projects/w1/agent/agents', { props: { websiteId: 'w1' } })
    expect(wrapper.find('.ag-page-intro').text()).toBe(
      "Specialists the agent hands work to, by team. Each one works from your context and Cansee's measurements and saves a draft for review."
    )
    expect(cardNames(wrapper)).toEqual(['Gap Analyst', 'Page Optimizer', 'Landing Page Agent', 'Social Posts Agent'])
    const cards = wrapper.findAll('li.ag-agent')
    expect(cards[0].findAll('.ag-agent-team').map((t) => t.text())).toEqual(['AEO and SEO', 'Growth'])
    expect(cards[0].text()).toContain('Compares Google and AI answers.')
    expect(cards[0].text()).toContain('Writes a report you can save to Reports')
    expect(cards[0].text()).toContain('Research our brand')
    // A catalog entry without teams falls back to the contract's.
    expect(cards[2].findAll('.ag-agent-team').map((t) => t.text())).toEqual(['Growth', 'Product marketing'])
    expect(cards[1].text()).toContain('A revised page with every change listed')
    // Every agent takes its inputs first: Use is a button, never a bare link to an empty chat.
    expect(wrapper.find('li.ag-agent a[aria-label^="Use "]').exists()).toBe(false)
    for (const name of ['Gap Analyst', 'Page Optimizer', 'Landing Page Agent', 'Social Posts Agent']) {
      expect(wrapper.find(`li.ag-agent button[aria-label="Use ${name}"]`).exists()).toBe(true)
    }
  })

  it('links the board widgets whose drafts start each agent, in catalog order', async () => {
    fakeAgent.catalog = CATALOG
    const { wrapper } = await setup(AgentAgentsPage, '/projects/w1/agent/agents', { props: { websiteId: 'w1' } })
    const cards = wrapper.findAll('li.ag-agent')
    const links = (card) => card.findAll('.ag-agent-from a').map((a) => [a.text(), a.attributes('href')])
    expect(cards[0].find('.ag-agent-from').text()).toContain('Starts from')
    expect(links(cards[0])).toEqual([
      ['Sentiment', '/projects/w1/analytics?widget=sentiment'],
      ['Competitors', '/projects/w1/analytics?widget=competitors'],
    ])
    expect(links(cards[1])).toEqual([
      ['Fact check', '/projects/w1/analytics?widget=fact-check'],
      ['Crawler access', '/projects/w1/analytics?widget=crawler-access'],
      ['Pages', '/projects/w1/analytics?widget=pages'],
      ['Products', '/projects/w1/analytics?widget=products'],
    ])
    // No template names the Landing Page Agent: no line.
    expect(cards[2].find('.ag-agent-from').exists()).toBe(false)
  })

  it('filters by team with the team in the query', async () => {
    fakeAgent.catalog = CATALOG
    const { wrapper, router } = await setup(AgentAgentsPage, '/projects/w1/agent/agents', { props: { websiteId: 'w1' } })
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map((t) => t.text())).toEqual([
      'All agents',
      'AEO and SEO',
      'Content',
      'Social',
      'Growth',
      'PR and comms',
      'Product marketing',
      'Brand',
    ])
    await tabs[2].trigger('mousedown')
    await tabs[2].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.team).toBe('content')
    expect(cardNames(wrapper)).toEqual(['Page Optimizer', 'Social Posts Agent'])

    await router.replace({ query: { team: 'growth' } })
    await flushPromises()
    expect(cardNames(wrapper)).toEqual(['Gap Analyst', 'Landing Page Agent'])

    await router.replace({ query: { team: 'nonsense' } })
    await flushPromises()
    expect(cardNames(wrapper)).toHaveLength(4)
  })

  it('opens a team tab from the address', async () => {
    fakeAgent.catalog = CATALOG
    const { wrapper } = await setup(AgentAgentsPage, '/projects/w1/agent/agents?team=social', { props: { websiteId: 'w1' } })
    expect(wrapper.find('[role="tab"][data-state="active"]').text()).toBe('Social')
    expect(cardNames(wrapper)).toEqual(['Social Posts Agent'])
  })

  it('turns every Use off with the reason when the agent is switched off', async () => {
    fakeAgent.catalog = CATALOG
    fakeAgent.status = { enabled: false }
    const { wrapper } = await setup(AgentAgentsPage, '/projects/w1/agent/agents', { props: { websiteId: 'w1' } })
    const uses = wrapper.findAll('li.ag-agent [aria-label^="Use "], li.ag-research [aria-label^="Use "]')
    expect(uses).toHaveLength(5)
    expect(uses.every((u) => u.attributes('aria-disabled') === 'true' && u.element.tagName === 'BUTTON')).toBe(true)
    for (const u of uses) {
      expect(wrapper.find(`#${u.attributes('aria-describedby')}`).text()).toBe('The AI agent is turned off on this workspace.')
    }
    expect(wrapper.find('li.ag-agent a[aria-label^="Use "]').exists()).toBe(false)
    expect(wrapper.findAll('li.ag-agent [title], li.ag-research [title]')).toHaveLength(0)
    // Clicking does not open the dialog.
    await uses[1].trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('loads the catalog when it is empty and says when there are none', async () => {
    const { wrapper } = await setup(AgentAgentsPage, '/projects/w1/agent/agents', { props: { websiteId: 'w1' } })
    expect(fakeAgent.loadCatalog).toHaveBeenCalled()
    expect(wrapper.text()).toContain('No agents are available.')
  })

  it('shows a load error with a retry', async () => {
    fakeAgent.loadCatalog = vi.fn(async () => {
      throw Object.assign(new Error('x'), { name: 'AgentError', message: 'The agent is temporarily unavailable.' })
    })
    const { wrapper } = await setup(AgentAgentsPage, '/projects/w1/agent/agents', { props: { websiteId: 'w1' } })
    expect(wrapper.text()).toContain("Couldn't load the agents.")
    fakeAgent.loadCatalog = vi.fn(async () => {
      fakeAgent.catalog = CATALOG
      return CATALOG
    })
    await wrapper.find('.ag-empty button').trigger('click')
    await flushPromises()
    expect(fakeAgent.loadCatalog).toHaveBeenCalledWith({ force: true })
    expect(wrapper.findAll('li.ag-agent')).toHaveLength(4)
  })
})

describe('AgentAgentsPage research agents and availability', () => {
  const CATALOG = [
    { key: 'gap_analyst', name: 'Gap Analyst', description: 'Compares Google and AI answers.', output_kind: 'report', starter: '' },
    { key: 'landing_page', name: 'Landing Page Agent', description: 'Builds a page.', output_kind: 'page', starter: '' },
    { key: 'social_posts', name: 'Social Posts Agent', description: 'Turns a draft into posts.', output_kind: 'document', starter: '' },
  ]
  const ENGINES = [
    { key: 'chatgpt', label: 'ChatGPT', configured: true, key_setting: '' },
    { key: 'claude', label: 'Claude', configured: true, key_setting: '' },
    { key: 'gemini', label: 'Gemini', configured: false, key_setting: '' },
  ]
  const STATUS = {
    enabled: true,
    configured: true,
    live_available: true,
    engines: ENGINES,
    google: { configured: false, key_settings: [], reliable_pages: 0 },
    serp_configured: false,
    allowance: { cap_usd: '3.00', spent_usd: '1.00', exceeded: false, show_usd: false },
    prompt_runs: { unlimited: false, limit: 20, used: 7, reserved: 0, remaining: 13 },
    research: { available: true, reason: null, message: '' },
    setup: { ready: true, issues: [] },
    writers: { landing_page: { available: true, max_usd: '1.41' }, social_posts: { available: true, max_usd: '0.27' } },
    limits: { run_cost_usd: '3.00' },
    swarm: { enabled: true, max_agents: 50 },
  }

  beforeEach(() => {
    vi.stubEnv('DEV', false)
    fakeAgent.catalog = CATALOG
    fakeAgent.status = STATUS
    fakeAgent.statusLoading = false
    fakeAgent.loadStatus = vi.fn(async () => fakeAgent.status)
  })
  afterEach(() => vi.unstubAllEnvs())

  const open = () => setup(AgentAgentsPage, '/projects/w1/agent/agents', {
    props: { websiteId: 'w1' },
    websites: [{ id: 'w1', name: 'Notion', url: 'https://notion.so', competitors: [{ name: 'Evernote', domain: 'evernote.com' }] }],
  })

  it('shows the research agents card first, in All and in AEO and SEO only', async () => {
    const { wrapper, router } = await open()
    const grid = () => wrapper.find('[role="tabpanel"] ul.ag-agents')
    expect(grid().element.firstElementChild.classList.contains('ag-research')).toBe(true)
    expect(wrapper.find('li.ag-research h2').text()).toBe('Research Agents')
    expect(wrapper.find('li.ag-research').text()).toContain('Up to 50 agents per research')
    await router.replace({ query: { team: 'aeo_seo' } })
    await flushPromises()
    expect(wrapper.find('li.ag-research').exists()).toBe(true)
    await router.replace({ query: { team: 'social' } })
    await flushPromises()
    expect(wrapper.find('li.ag-research').exists()).toBe(false)
  })

  it('opens the task dialog on the preset picked, as a research request', async () => {
    const { wrapper } = await open()
    const preset = wrapper.findAll('li.ag-research button.ag-research-preset').find((b) => b.text().startsWith('Competitor check'))
    await preset.trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog.querySelector('.ag-dialog-title').textContent).toBe('Research Agents')
    const checked = [...dialog.querySelectorAll('input[type="radio"]')].find((r) => r.checked)
    expect(checked.closest('label').textContent).toContain('Competitor check')
    expect(dialog.querySelector('.ag-atd-preview-text').textContent).toContain('compare us with Evernote (evernote.com)')
  })

  it('opens a general agent on its templates', async () => {
    const { wrapper } = await open()
    await wrapper.find('button[aria-label="Use Landing Page Agent"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')
    expect([...dialog.querySelectorAll('.ag-atd-template-name')].map((n) => n.textContent.trim())).toEqual([
      'For one search',
      'Where we are missing most',
      'For one offering',
    ])
  })

  it('shows what is set up, with free prompt runs and no dollars', async () => {
    const { wrapper } = await open()
    const strip = wrapper.find('section.ag-setup')
    expect(strip.text()).toContain('Google results')
    expect(strip.text()).toContain('Not set up')
    expect(strip.text()).toContain('ChatGPT and Claude')
    expect(strip.text()).toContain('Not set up: Gemini')
    expect(strip.text()).toContain('13 free prompt runs left this month')
    expect(strip.text()).not.toMatch(/\$|_KEY/)
    expect(strip.find('.ag-setup-block').exists()).toBe(false)
  })

  it('turns only the research agents off when they are switched off, saying why', async () => {
    fakeAgent.status = {
      ...STATUS,
      swarm: { enabled: false, max_agents: 50 },
      research: { available: false, reason: 'research_disabled', message: 'The research agents are turned off on this workspace.' },
    }
    const { wrapper } = await open()
    const card = wrapper.find('li.ag-research')
    expect(card.text()).toContain('The research agents are turned off on this workspace.')
    expect(card.find('button[aria-label="Use Research Agents"]').attributes('aria-disabled')).toBe('true')
    expect(wrapper.find('button[aria-label="Use Gap Analyst"]').attributes('aria-disabled')).toBeUndefined()
    expect(wrapper.find('button[aria-label="Use Landing Page Agent"]').attributes('aria-disabled')).toBeUndefined()
    // Customers never see the setting.
    expect(wrapper.text()).not.toContain('AGENT_SWARM_ENABLED')
  })

  it('stops a writer the allowance cannot start, and only that one', async () => {
    fakeAgent.status = { ...STATUS, writers: { ...STATUS.writers, landing_page: { available: false, needs_usd: '0.32' } } }
    const { wrapper } = await open()
    const landing = wrapper.findAll('li.ag-agent').find((li) => li.find('h2').text() === 'Landing Page Agent')
    expect(landing.find('.ag-agent-why').exists()).toBe(true)
    expect(landing.find('button[aria-label="Use Landing Page Agent"]').attributes('aria-disabled')).toBe('true')
    expect(wrapper.find('button[aria-label="Use Social Posts Agent"]').attributes('aria-disabled')).toBeUndefined()
    expect(wrapper.find('button[aria-label="Use Gap Analyst"]').attributes('aria-disabled')).toBeUndefined()
  })

  it('says when the agent process is down and checks again', async () => {
    fakeAgent.status = { ...STATUS, live_available: false }
    const { wrapper } = await open()
    const notice = wrapper.find('.ag-setup-block')
    expect(notice.text()).toContain("The AI agent isn't running right now.")
    for (const b of wrapper.findAll('li [aria-label^="Use "]')) expect(b.attributes('aria-disabled')).toBe('true')
    await notice.find('button').trigger('click')
    expect(fakeAgent.loadStatus).toHaveBeenCalledTimes(1)
    // Running again: every Use comes back.
    fakeAgent.status = STATUS
    await flushPromises()
    expect(wrapper.find('.ag-setup-block').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Use Gap Analyst"]').attributes('aria-disabled')).toBeUndefined()
  })

  it('names the setting for staff', async () => {
    fakeAgent.status = {
      ...STATUS,
      enabled: false,
      setup: { ready: false, issues: [{ code: 'agent_disabled', severity: 'blocking', setting: 'AGENT_ENABLED', title: '', action: '' }] },
    }
    const { wrapper } = await open()
    expect(wrapper.find('.ag-setup-block').text()).toContain('Setting: AGENT_ENABLED.')
  })

  it('blocks nothing while the status is unknown', async () => {
    fakeAgent.status = null
    const { wrapper } = await open()
    expect(wrapper.find('section.ag-setup').exists()).toBe(false)
    for (const b of wrapper.findAll('li [aria-label^="Use "]')) expect(b.attributes('aria-disabled')).toBeUndefined()
    expect(wrapper.find('li.ag-research .ag-research-meta').exists()).toBe(false)
  })

  it('without a project, every Use says to pick one', async () => {
    const { wrapper } = await setup(AgentAgentsPage, '/agent/projects', { props: {} })
    for (const b of wrapper.findAll('li [aria-label^="Use "]')) {
      expect(b.attributes('aria-disabled')).toBe('true')
      expect(wrapper.find(`#${b.attributes('aria-describedby')}`).text()).toBe('Pick a project first.')
    }
  })
})
