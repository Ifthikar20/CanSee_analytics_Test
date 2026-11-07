import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { useFirstResearch } from '@/composables/agent/useFirstResearch'

const post = vi.fn()
const get = vi.fn()
vi.mock('@/api/client', () => ({ default: { post: (...args) => post(...args), get: (...args) => get(...args) } }))

const agentApi = { status: vi.fn(), getContext: vi.fn(), createContextEntry: vi.fn() }
vi.mock('@/api/agent', () => ({ default: agentApi }))

const websitesApi = { list: vi.fn() }
vi.mock('@/api/websites', () => ({ default: websitesApi }))

const toast = { warning: vi.fn(), error: vi.fn(), success: vi.fn() }
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const auth = reactive({ session: { next_route: 'dashboard' }, fetchSession: vi.fn() })
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

const app = { setWebsites: vi.fn() }
vi.mock('@/stores/app', () => ({ useAppStore: () => app }))

const { firstResearchText, provideOnboardingFlow, SCAN_SETTLE_MS } = await import('../useOnboardingFlow')
const { default: RunStep } = await import('../steps/RunStep.vue')
const { default: WebsiteStep } = await import('../steps/WebsiteStep.vue')
const { default: BrandStep } = await import('../steps/BrandStep.vue')
const { default: CompetitorsStep } = await import('../steps/CompetitorsStep.vue')
const { default: PromptsStep } = await import('../steps/PromptsStep.vue')

const SCAN = {
  url: 'https://notion.so',
  success: true,
  error: null,
  business_name: 'Notion',
  domain: 'notion.so',
  industry: 'Software',
  description_short: 'Notion is one workspace for docs, wikis and projects.',
  description_raw: 'The connected workspace.',
  products: ['Docs', 'Wikis', 'Projects', 'docs'],
  features: [],
  selling_points: [],
  topics: [
    'best note taking app for teams',
    'notion alternatives for startups',
    'how to organize team documentation',
    'best wiki software for small teams',
    'project management with docs',
    'team knowledge base tools',
  ],
  topics_source: 'ai',
  missing_keys: [],
  topic_brands: [],
  competitors: [
    { name: 'Evernote', domain: 'evernote.com' },
    { name: 'Coda', domain: 'https://www.coda.io/' },
    { name: 'Confluence', domain: 'atlassian.com' },
    { name: 'Obsidian', domain: 'obsidian.md' },
    { name: 'ClickUp', domain: 'clickup.com' },
    { name: 'Craft', domain: 'craft.do' },
    { name: 'Coda again', domain: 'coda.io' },
  ],
}

const STATUS = {
  enabled: true,
  live_available: true,
  configured: true,
  serp_configured: true,
  engines: [
    { key: 'chatgpt', label: 'ChatGPT', configured: true },
    { key: 'claude', label: 'Claude', configured: true },
    { key: 'gemini', label: 'Gemini', configured: false },
  ],
  allowance: { cap_usd: 10, spent_usd: 2.5, exceeded: false, warning: false },
  swarm: { enabled: true, max_agents: 30, worker_model: 'claude-haiku-5-5' },
}

const mounted = []

function host(child = null, onComplete = vi.fn()) {
  let flow
  const Host = defineComponent({
    setup() {
      flow = provideOnboardingFlow({ onComplete })
      return () => (child ? h(child) : h('div'))
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  mounted.push(wrapper)
  return { flow, wrapper, onComplete }
}

async function scanned(child = null) {
  post.mockImplementation((url) =>
    url === '/onboarding/scan/' ? Promise.resolve({ data: { ...SCAN } }) : Promise.resolve({ data: {} }),
  )
  const ctx = host(child)
  ctx.flow.urlInput.value = 'notion.so'
  await ctx.flow.startScan()
  vi.advanceTimersByTime(SCAN_SETTLE_MS)
  await nextTick()
  return ctx
}

/** A flow at the last step with a reviewed form and the agent's status. */
async function atRunStep({ status = STATUS, child = null } = {}) {
  agentApi.status.mockResolvedValue({ data: status })
  const ctx = await scanned(child)
  const { flow } = ctx
  flow.form.value.audience = 'Operations leads at 50 to 500 person companies'
  flow.form.value.voice = 'Plain, confident, no jargon'
  flow.form.value.location = 'gb'
  flow.goTo(4)
  await flushPromises()
  post.mockReset()
  return ctx
}

function finishMocks({ entries = 0, suggested = 0 } = {}) {
  post.mockImplementation((url) =>
    Promise.resolve(url === '/onboarding/save/' ? { data: { website_id: 'w1', name: 'Notion' } } : { data: { created_count: 3 } }),
  )
  agentApi.getContext.mockResolvedValue({ data: { entries: [], totals: { entries, suggested, references: 0 } } })
  agentApi.createContextEntry.mockReset()
  agentApi.createContextEntry.mockImplementation(async (wid, body) => ({ data: { id: `e-${body.title}`, ...body } }))
  websitesApi.list.mockResolvedValue({ data: [{ id: 'w1', name: 'Notion' }] })
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  post.mockReset()
  get.mockReset()
  push.mockReset()
  Object.values(agentApi).forEach((fn) => fn.mockReset())
  websitesApi.list.mockReset()
  Object.values(toast).forEach((fn) => fn.mockReset())
  app.setWebsites.mockReset()
  auth.session = { next_route: 'dashboard' }
  auth.fetchSession = vi.fn(async () => auth.session)
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('onboarding: website and scan', () => {
  it('fills the form from the scan and moves to the brand step once the rows resolve', async () => {
    post.mockResolvedValue({ data: { ...SCAN } })
    const { flow } = host()
    flow.urlInput.value = '  notion.so '
    await flow.startScan()

    expect(post).toHaveBeenCalledWith('/onboarding/scan/', { url: 'https://notion.so' }, { _silentError: true, _noRetry429: true })
    const form = flow.form.value
    expect(form.url).toBe('https://notion.so')
    expect(form.business_name).toBe('Notion')
    expect(form.industry).toBe('Software')
    expect(form.description).toBe('Notion is one workspace for docs, wikis and projects.')
    expect(form.offerings).toEqual(['Docs', 'Wikis', 'Projects'])
    expect(form.audience).toBe('')
    expect(form.voice).toBe('')
    expect(form.competitors.map((c) => [c.name, c.domain, c.selected, c.custom])).toEqual([
      ['Evernote', 'evernote.com', true, false],
      ['Coda', 'coda.io', true, false],
      ['Confluence', 'atlassian.com', true, false],
      ['Obsidian', 'obsidian.md', true, false],
      ['ClickUp', 'clickup.com', true, false],
      ['Craft', 'craft.do', false, false],
    ])
    expect(form.prompts.filter((p) => p.selected).map((p) => p.text)).toEqual(SCAN.topics.slice(0, 3))
    expect(form.prompts).toHaveLength(6)
    expect(form.location).toBe('us')
    expect(form.scan).toEqual({ products: 3, topics: 6, competitors: 6, topics_source: 'ai', missing_keys: [] })

    // The rows resolve from the data; the brand step follows a moment later.
    expect(flow.scanState.value).toBe('resolved')
    expect(flow.scanRows.value.map((r) => [r.state, r.text])).toEqual([
      ['found', '3 offerings found'],
      ['found', '6 prompts drafted'],
      ['found', '6 competitors found'],
    ])
    expect(flow.step.value).toBe(0)
    vi.advanceTimersByTime(SCAN_SETTLE_MS)
    expect(flow.step.value).toBe(1)
    expect(flow.displayStep.value).toBe(2)
  })

  it('says what the scan could not find', async () => {
    post.mockResolvedValue({
      data: { ...SCAN, products: [], topics: [], competitors: [], topics_source: 'unavailable', missing_keys: ['ANTHROPIC_API_KEY'] },
    })
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    expect(flow.scanRows.value.map((r) => [r.state, r.text])).toEqual([
      ['missing', 'Not found on your homepage'],
      ['missing', "Couldn't draft prompts"],
      ['missing', 'None found'],
    ])
    expect(flow.form.value.scan.topics_source).toBe('unavailable')
    expect(flow.form.value.scan.missing_keys).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('shows the scanner failure and fills in by hand from the address alone', async () => {
    post.mockResolvedValue({ data: { url: 'https://notion.so', success: false, error: 'Could not scan this domain.' } })
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    expect(flow.scanState.value).toBe('idle')
    expect(flow.scanError.value).toBe('Could not scan this domain.')
    expect(flow.step.value).toBe(0)

    flow.fillByHand()
    expect(flow.step.value).toBe(1)
    expect(flow.form.value.url).toBe('https://notion.so')
    expect(flow.form.value.business_name).toBe('')
    expect(flow.form.value.prompts).toEqual([])
    expect(flow.form.value.competitors).toEqual([])
    expect(flow.form.value.offerings).toEqual([])
  })

  it('falls back to a plain message when the scan request fails', async () => {
    post.mockRejectedValue(Object.assign(new Error('Network Error'), { isAxiosError: true }))
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    expect(flow.scanError.value).toBe("We couldn't read this site.")
  })

  it('asks the user to wait after too many scans', async () => {
    post.mockRejectedValue({ response: { status: 429, data: { error: 'Slow down — too many scans.' } } })
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    expect(flow.scanError.value).toBe('Too many scans in a row. Wait a minute and try again.')
  })

  it('shows a refused address without offering to scan it again', async () => {
    post.mockRejectedValue({ response: { status: 400, data: { success: false, error: { code: 'validation_error', message: 'Enter a valid URL.' } } } })
    const { flow } = host()
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    expect(flow.urlError.value).toBe('Enter a valid URL.')
    expect(flow.scanError.value).toBe('')
  })

  it('never scans something that is not a web address', async () => {
    const { flow } = host()
    flow.urlInput.value = 'notion'
    await flow.startScan()
    expect(post).not.toHaveBeenCalled()
    expect(flow.urlError.value).toBe('Enter your website address, like yourcompany.com.')
    flow.fillByHand()
    expect(flow.step.value).toBe(0)
  })

  it('keeps the reviewed form when the same address is continued again', async () => {
    const { flow } = await scanned()
    flow.form.value.business_name = 'Notion Labs'
    flow.goTo(0)
    expect(flow.scanState.value).toBe('idle')
    await flow.startScan()
    expect(post).toHaveBeenCalledTimes(1)
    expect(flow.step.value).toBe(1)
    expect(flow.form.value.business_name).toBe('Notion Labs')
  })

  it('renders the scan rows, then the error with its two ways out', async () => {
    let resolveScan
    post.mockImplementation(() => new Promise((resolve) => (resolveScan = resolve)))
    const { flow, wrapper } = host(WebsiteStep)
    await wrapper.find('input.ob-input').setValue('notion.so')
    await wrapper.find('form').trigger('submit')
    await nextTick()
    expect(wrapper.find('h1').text()).toBe('Reading notion.so')
    expect(wrapper.find('.ob-sub').text()).toBe('This takes 10 to 30 seconds.')
    expect(wrapper.findAll('.ob-scan-row.is-pending')).toHaveLength(3)
    expect(wrapper.findAll('.ob-scan-spinner')).toHaveLength(1)

    resolveScan({ data: { success: false, error: 'Could not scan this domain.' } })
    await flushPromises()
    expect(flow.scanState.value).toBe('idle')
    expect(wrapper.find('.ob-error').text()).toBe('Could not scan this domain.')
    const buttons = wrapper.findAll('.ob-error-actions button').map((b) => b.text())
    expect(buttons).toEqual(['Try again', 'Fill in by hand'])
  })
})

describe('onboarding: review steps', () => {
  it('keeps at most five competitors selected and dedupes the ones added', async () => {
    const { flow } = await scanned()
    expect(flow.selectedCompetitors.value).toHaveLength(5)
    expect(flow.competitorCapReached.value).toBe(true)
    expect(flow.setCompetitorSelected(5, true)).toBe(false)
    expect(flow.form.value.competitors[5].selected).toBe(false)
    flow.setCompetitorSelected(0, false)
    expect(flow.setCompetitorSelected(5, true)).toBe(true)

    // Same domain as Coda, written differently: not added.
    flow.newCompetitorName.value = 'Coda Inc'
    flow.newCompetitorDomain.value = 'https://www.coda.io/pricing'
    expect(flow.addCompetitor()).toBe(false)
    // New, at the cap: added but not selected.
    flow.newCompetitorName.value = 'Slite'
    flow.newCompetitorDomain.value = 'slite.com'
    expect(flow.addCompetitor()).toBe(true)
    const slite = flow.form.value.competitors.at(-1)
    expect(slite).toEqual({ name: 'Slite', domain: 'slite.com', selected: false, custom: true })
    // Without a domain, the name decides.
    flow.newCompetitorName.value = 'slite'
    expect(flow.addCompetitor()).toBe(false)
    expect(flow.newCompetitorName.value).toBe('')

    flow.removeCompetitor(0)
    expect(flow.form.value.competitors[0].name).toBe('Evernote')
    flow.removeCompetitor(flow.form.value.competitors.length - 1)
    expect(flow.form.value.competitors.some((c) => c.name === 'Slite')).toBe(false)
  })

  it('keeps one to five prompts selected and takes the user’s own', async () => {
    const { flow } = await scanned()
    expect(flow.selectedPrompts.value).toHaveLength(3)

    flow.newPrompt.value = 'ab'
    expect(flow.addPrompt()).toBe(false)
    expect(flow.form.value.prompts).toHaveLength(6)

    // A drafted prompt typed again (any case) is selected, not duplicated.
    flow.newPrompt.value = 'BEST WIKI SOFTWARE FOR SMALL TEAMS'
    expect(flow.addPrompt()).toBe(false)
    expect(flow.form.value.prompts).toHaveLength(6)
    expect(flow.form.value.prompts[3].selected).toBe(true)

    flow.newPrompt.value = '  which   tool replaces confluence  '
    expect(flow.addPrompt()).toBe(true)
    expect(flow.form.value.prompts.at(-1)).toEqual({ text: 'which tool replaces confluence', selected: true, custom: true })
    expect(flow.promptCapReached.value).toBe(true)

    expect(flow.setPromptSelected(4, true)).toBe(false)
    flow.newPrompt.value = 'is notion good for wikis'
    expect(flow.addPrompt()).toBe(true)
    expect(flow.form.value.prompts.at(-1).selected).toBe(false)

    flow.newPrompt.value = 'x'.repeat(400)
    flow.addPrompt()
    expect(flow.form.value.prompts.at(-1).text).toHaveLength(300)
  })

  it('marks empty brand fields as missing instead of filling them in', async () => {
    const { flow, wrapper } = await scanned(BrandStep)
    const missing = () =>
      wrapper.findAll('.ob-label-row').filter((r) => r.find('.ob-missing').exists()).map((r) => r.find('.ob-label').text())
    expect(missing()).toEqual(['Who you sell to', 'Voice'])
    expect(wrapper.find('.ob-readonly-value').text()).toBe('notion.so')
    expect(wrapper.findAll('.ob-chip-text').map((c) => c.text())).toEqual(['Docs', 'Wikis', 'Projects'])

    flow.form.value.offerings = []
    flow.form.value.industry = ''
    await nextTick()
    expect(missing()).toEqual(['Industry', 'Offerings', 'Who you sell to', 'Voice'])
    expect(wrapper.text()).toContain("We didn't find product names on your homepage. Add what you sell.")

    await wrapper.find('#ob-brand-offering').setValue('Notion AI')
    await wrapper.find('#ob-brand-offering').trigger('keydown', { key: 'Enter' })
    expect(flow.form.value.offerings).toEqual(['Notion AI'])
    expect(flow.step.value).toBe(1)

    await wrapper.find('#ob-brand-name').setValue('')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('#ob-brand-name-error').exists()).toBe(true)

    await wrapper.findAll('button').find((b) => b.text() === 'Change').trigger('click')
    expect(flow.step.value).toBe(0)
  })

  it('locks the other competitors at five and offers to skip when none is kept', async () => {
    const { flow, wrapper } = await scanned(CompetitorsStep)
    flow.goTo(2)
    await nextTick()
    expect(wrapper.find('.ob-note').text()).toBe('Unselect one to add another.')
    const boxes = wrapper.findAll('input.ob-check')
    expect(boxes.map((b) => b.element.disabled)).toEqual([false, false, false, false, false, true])
    expect(boxes[5].attributes('aria-describedby')).toBe('ob-competitor-cap')
    expect(wrapper.findAll('.ob-monogram').map((m) => m.text())).toEqual(['E', 'C', 'C', 'O', 'C', 'C'])
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('button[type="submit"]').text()).toBe('Continue')

    flow.form.value.competitors.forEach((c) => (c.selected = false))
    await nextTick()
    expect(wrapper.find('.ob-note').exists()).toBe(false)
    expect(wrapper.find('button[type="submit"]').text()).toBe('Skip competitors')

    flow.form.value.competitors = []
    await nextTick()
    expect(wrapper.text()).toContain("We couldn't find competitors automatically. Add the companies you lose deals to.")
  })

  it('explains why there are no drafted prompts and searches from the chosen country', async () => {
    post.mockResolvedValue({ data: { ...SCAN, topics: [], topics_source: 'unavailable' } })
    const { flow, wrapper } = host(PromptsStep)
    flow.urlInput.value = 'notion.so'
    await flow.startScan()
    flow.goTo(3)
    await nextTick()
    expect(wrapper.find('.ob-empty-note').text()).toBe(
      "Drafting prompts needs the AI service, which isn't configured here. Write 1 to 5 questions your buyers ask.",
    )
    const select = wrapper.find('#ob-prompt-location')
    expect(select.findAll('option').map((o) => [o.attributes('value'), o.text()])).toEqual([
      ['us', 'United States'],
      ['gb', 'United Kingdom'],
      ['ca', 'Canada'],
      ['au', 'Australia'],
      ['in', 'India'],
      ['de', 'Germany'],
      ['fr', 'France'],
      ['', 'Global'],
    ])
    await select.setValue('')
    expect(flow.form.value.location).toBe('')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()

    await wrapper.find('input[aria-label="Add your own prompt"]').setValue('which wiki do startups use')
    await wrapper.findAll('button').find((b) => b.text() === 'Add').trigger('click')
    // The user's own prompt keeps the note: none was drafted.
    expect(wrapper.find('.ob-empty-note').exists()).toBe(true)
    expect(wrapper.findAll('.ob-prompt-text').map((p) => p.text())).toEqual(['which wiki do startups use'])
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined()

    flow.form.value.scan.topics_source = 'failed'
    await nextTick()
    expect(wrapper.find('.ob-empty-note').text()).toBe(
      "We couldn't draft prompts from your homepage. Write 1 to 5 questions your buyers ask.",
    )
  })

  it('lets each step continue only when it is complete', async () => {
    const { flow } = await scanned()
    expect(flow.step.value).toBe(1)
    flow.form.value.business_name = '   '
    expect(flow.canContinue.value).toBe(false)
    expect(flow.next()).toBe(false)
    expect(flow.step.value).toBe(1)
    flow.form.value.business_name = 'Notion'
    expect(flow.next()).toBe(true)
    expect(flow.step.value).toBe(2)

    // Competitors are optional.
    flow.form.value.competitors.forEach((c) => (c.selected = false))
    expect(flow.next()).toBe(true)
    expect(flow.step.value).toBe(3)

    flow.form.value.prompts.forEach((p) => (p.selected = false))
    expect(flow.next()).toBe(false)
    flow.setPromptSelected(0, true)
    expect(flow.next()).toBe(true)
    expect(flow.step.value).toBe(4)

    // The last step finishes through its own buttons, and the first through the scan.
    expect(flow.next()).toBe(false)
    flow.goTo(0)
    expect(flow.next()).toBe(false)
  })
})

describe('onboarding: first research', () => {
  it('writes the first message exactly', () => {
    expect(
      firstResearchText({
        brand: 'Notion',
        host: 'notion.so',
        prompts: ['best note taking app for teams', 'notion alternatives for startups'],
        location: 'us',
        competitors: [{ name: 'Evernote', domain: 'evernote.com' }, { name: 'Craft', domain: '' }],
      }),
    ).toBe(
      [
        'Research Notion (notion.so) on Google and the AI engines for these prompts:',
        '1. best note taking app for teams',
        '2. notion alternatives for startups',
        'Search from United States (us).',
        'Competitors to compare: Evernote (evernote.com), Craft.',
      ].join('\n'),
    )
    expect(
      firstResearchText({ brand: 'Notion', host: 'notion.so', prompts: ['best wiki'], location: '', competitors: [] }),
    ).toBe(
      'Research Notion (notion.so) on Google and the AI engines for these prompts:\n1. best wiki\nSearch without a country (global).',
    )
  })

  it('saves the project, fills an empty context, stashes the research and opens the agent', async () => {
    const { flow, onComplete } = await atRunStep()
    expect(agentApi.status).toHaveBeenCalledWith({ _silentError: true })
    expect(flow.availability.value).toBe('available')
    finishMocks()

    await flow.startResearch()

    expect(post.mock.calls[0]).toEqual([
      '/onboarding/save/',
      {
        url: 'https://notion.so',
        business_name: 'Notion',
        industry: 'Software',
        description: 'Notion is one workspace for docs, wikis and projects.',
        keywords: SCAN.topics.slice(0, 3),
        competitors: [
          { name: 'Evernote', domain: 'evernote.com' },
          { name: 'Coda', domain: 'coda.io' },
          { name: 'Confluence', domain: 'atlassian.com' },
          { name: 'Obsidian', domain: 'obsidian.md' },
          { name: 'ClickUp', domain: 'clickup.com' },
        ],
      },
      { _silentError: true },
    ])
    // The research tracks its prompts itself: nothing goes to the prompt library.
    expect(post).toHaveBeenCalledTimes(1)
    expect(agentApi.getContext).toHaveBeenCalledWith('w1', { _silentError: true })
    // The contract 11d mapping: Audience, Execution titled Voice, one Offerings entry each.
    expect(agentApi.createContextEntry.mock.calls).toEqual([
      ['w1', { section: 'audience', title: 'Audience', body: 'Operations leads at 50 to 500 person companies', references: [] }],
      ['w1', { section: 'execution', title: 'Voice', body: 'Plain, confident, no jargon', references: [] }],
      ['w1', { section: 'offerings', title: 'Docs', body: '', references: [] }],
      ['w1', { section: 'offerings', title: 'Wikis', body: '', references: [] }],
      ['w1', { section: 'offerings', title: 'Projects', body: '', references: [] }],
    ])
    expect(app.setWebsites).toHaveBeenCalledWith([{ id: 'w1', name: 'Notion' }])
    expect(useFirstResearch().take('w1').text).toBe(
      [
        'Research Notion (notion.so) on Google and the AI engines for these prompts:',
        '1. best note taking app for teams',
        '2. notion alternatives for startups',
        '3. how to organize team documentation',
        'Search from United Kingdom (gb).',
        'Competitors to compare: Evernote (evernote.com), Coda (coda.io), Confluence (atlassian.com), Obsidian (obsidian.md), ClickUp (clickup.com).',
      ].join('\n'),
    )
    expect(auth.fetchSession).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith({ name: 'agent-home', params: { websiteId: 'w1' }, query: { start: 'first-research' } })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sessionStorage.getItem('cs-onb-summary'))).toMatchObject({ domain: 'notion.so', competitors: 5, topics: 3 })
    expect(flow.finishing.value).toBe('')
  })

  it('leaves a context someone already started alone', async () => {
    let ctx = await atRunStep()
    finishMocks({ entries: 2 })
    await ctx.flow.startResearch()
    expect(agentApi.getContext).toHaveBeenCalled()
    expect(agentApi.createContextEntry).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent-home' }))

    // Suggestions built from the site wait for review: still not empty.
    while (mounted.length) mounted.pop().unmount()
    ctx = await atRunStep()
    finishMocks({ suggested: 3 })
    await ctx.flow.startResearch()
    expect(agentApi.createContextEntry).not.toHaveBeenCalled()
  })

  it('writes no context when there is nothing to write, or when the agent is switched off', async () => {
    let ctx = await atRunStep()
    finishMocks()
    ctx.flow.form.value.audience = ''
    ctx.flow.form.value.voice = ''
    ctx.flow.form.value.offerings = []
    await ctx.flow.startResearch()
    expect(agentApi.getContext).not.toHaveBeenCalled()
    expect(agentApi.createContextEntry).not.toHaveBeenCalled()

    while (mounted.length) mounted.pop().unmount()
    agentApi.getContext.mockReset()
    ctx = await atRunStep({ status: { ...STATUS, enabled: false } })
    finishMocks()
    await ctx.flow.skipResearch()
    expect(agentApi.getContext).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith('/prompt-library/websites/w1/prompts/', expect.any(Object), { _silentError: true })
  })

  it('carries on when the context cannot be written', async () => {
    const { flow } = await atRunStep()
    finishMocks()
    agentApi.createContextEntry.mockRejectedValue({ response: { status: 403 } })
    await flow.startResearch()
    expect(toast.error).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent-home' }))
  })

  it('clips the project topics to what the save endpoint takes', async () => {
    const { flow } = await atRunStep()
    finishMocks()
    flow.form.value.prompts.forEach((p) => (p.selected = false))
    flow.form.value.prompts.push({ text: `which ${'very '.repeat(30)}good tool`, selected: true, custom: true })
    await flow.startResearch()
    const keywords = post.mock.calls[0][1].keywords
    expect(keywords).toHaveLength(1)
    expect(keywords[0].length).toBeLessThanOrEqual(100)
    // The research itself keeps the full prompt.
    expect(useFirstResearch().take('w1').text).toContain(`which ${'very '.repeat(30)}good tool`)
  })

  it('puts the research in the new chat composer when session storage refuses it', async () => {
    const { flow } = await atRunStep()
    finishMocks()
    auth.user = { id: 7 }
    localStorage.clear()
    const original = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === window.sessionStorage) throw new Error('SecurityError')
      return original.call(this, key, value)
    })
    try {
      await flow.startResearch()
    } finally {
      spy.mockRestore()
      delete auth.user
    }
    expect(useFirstResearch().peek('w1')).toBeNull()
    expect(localStorage.getItem('cs-agent-draft-v1:7:w1:new')).toBe(flow.firstMessage.value)
    expect(push).toHaveBeenCalledWith({ name: 'agent-home', params: { websiteId: 'w1' }, query: { agent: 'gap_analyst' } })
  })

  it('sends a paywalled user to the paywall and keeps the research waiting', async () => {
    const { flow, onComplete } = await atRunStep()
    finishMocks()
    auth.fetchSession = vi.fn(async () => {
      auth.session = { next_route: 'paywall' }
      return auth.session
    })
    await flow.startResearch()
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('/paywall')
    expect(useFirstResearch().peek('w1')).not.toBeNull()
    expect(onComplete).toHaveBeenCalled()
  })

  it('skips the research and tracks the prompts with the chosen location', async () => {
    const { flow, onComplete } = await atRunStep()
    finishMocks()
    await flow.skipResearch()
    expect(post).toHaveBeenCalledWith(
      '/prompt-library/websites/w1/prompts/',
      { text: SCAN.topics.slice(0, 3).join('\n'), location: 'gb' },
      { _silentError: true },
    )
    expect(useFirstResearch().peek('w1')).toBeNull()
    expect(push).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('says so when the skipped prompts cannot be tracked', async () => {
    const { flow } = await atRunStep()
    finishMocks()
    post.mockImplementation((url) =>
      url === '/onboarding/save/' ? Promise.resolve({ data: { website_id: 'w1' } }) : Promise.reject(new Error('boom')),
    )
    await flow.skipResearch()
    expect(toast.warning).toHaveBeenCalledWith(
      "Your project is saved, but we couldn't add its starter prompts. Add them from Prompts on Analytics.",
    )
    expect(auth.fetchSession).toHaveBeenCalled()
  })

  it('stays on the last step when the project cannot be saved', async () => {
    const { flow, onComplete } = await atRunStep()
    post.mockRejectedValue(Object.assign(new Error('x'), { displayMessage: 'Your plan allows up to 1 project. Upgrade to add more.' }))
    await flow.startResearch()
    expect(toast.error).toHaveBeenCalledWith('Your plan allows up to 1 project. Upgrade to add more.')
    expect(push).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
    expect(flow.finishing.value).toBe('')
    expect(useFirstResearch().peek('w1')).toBeNull()
  })

  it('shows the summary and both ways to finish when the agent is available', async () => {
    const { wrapper } = await atRunStep({ child: RunStep })
    const rows = Object.fromEntries(
      wrapper.findAll('.ob-summary-row').map((row) => [row.find('dt').text(), row.find('dd').text().replace(/\s+/g, ' ')]),
    )
    expect(rows.Website).toBe('notion.so')
    expect(rows.Brand).toBe('Notion')
    expect(rows.Competitors).toBe('Evernote, Coda, Confluence, Obsidian, ClickUp')
    expect(wrapper.findAll('.ob-summary-list li').map((li) => li.text())).toEqual(SCAN.topics.slice(0, 3))
    expect(rows['Google results']).toBe('Available')
    expect(rows['AI engines']).toBe('ChatGPT, Claude Not configured: Gemini')
    expect(rows['AI allowance']).toBe('$7.50 of $10.00 left this month')
    const buttons = wrapper.findAll('.ob-step-actions button').map((b) => b.text())
    expect(buttons).toEqual(['Back', 'Skip for now', 'Start research'])
    expect(wrapper.find('.ob-run-note').text()).toBe('You can run research any time from the Agent.')
  })

  it.each([
    ['the agent is off', { ...STATUS, enabled: false }, "The research agent isn't available on this workspace yet. Your project will still be set up."],
    ['the agent has no key', { ...STATUS, configured: false }, "The research agent isn't available on this workspace yet. Your project will still be set up."],
    ['the agent process is down', { ...STATUS, live_available: false }, "The research agent isn't available on this workspace yet. Your project will still be set up."],
    ['the research agents are off', { ...STATUS, swarm: { enabled: false } }, "The research agent isn't available on this workspace yet. Your project will still be set up."],
    ['the allowance is used up', { ...STATUS, allowance: { cap_usd: 10, spent_usd: 10, exceeded: true } }, "You've used this month's AI allowance, so research can't start now."],
  ])('offers Finish setup when %s', async (_, status, notice) => {
    const { wrapper, flow } = await atRunStep({ status, child: RunStep })
    expect(wrapper.find('.ob-notice').text()).toBe(notice)
    const buttons = wrapper.findAll('.ob-step-actions button').map((b) => b.text())
    expect(buttons).toEqual(['Back', 'Finish setup'])
    finishMocks()
    await wrapper.findAll('.ob-step-actions button')[1].trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledWith('/prompt-library/websites/w1/prompts/', expect.any(Object), { _silentError: true })
    expect(useFirstResearch().peek('w1')).toBeNull()
    expect(flow.availability.value).not.toBe('available')
  })

  it('shows no monthly limit for an uncapped allowance', async () => {
    const { wrapper } = await atRunStep({ status: { ...STATUS, allowance: { cap_usd: 0, spent_usd: 3, exceeded: false } }, child: RunStep })
    const row = wrapper.findAll('.ob-summary-row').find((r) => r.find('dt').text() === 'AI allowance')
    expect(row.find('dd').text()).toBe('No monthly limit')
  })

  it('still lets the research start when the status cannot be read', async () => {
    agentApi.status.mockRejectedValueOnce(new Error('offline'))
    const ctx = await scanned(RunStep)
    ctx.flow.goTo(4)
    await flushPromises()
    expect(ctx.flow.availability.value).toBe('unknown')
    expect(ctx.wrapper.find('.ob-notice').text()).toContain("We couldn't check whether the research agent is available.")
    const buttons = ctx.wrapper.findAll('.ob-step-actions button').map((b) => b.text())
    expect(buttons).toEqual(['Back', 'Skip for now', 'Start research'])

    agentApi.status.mockResolvedValueOnce({ data: STATUS })
    await ctx.wrapper.find('.ob-notice button').trigger('click')
    await flushPromises()
    expect(ctx.flow.availability.value).toBe('available')
  })
})
