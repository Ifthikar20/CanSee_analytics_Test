import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const agentApi = vi.hoisted(() => ({ trackedPrompts: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: agentApi }))
const fakeAuth = vi.hoisted(() => ({ user: { id: 7 } }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => fakeAuth }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: ReportTemplateDialog } = await import('../ReportTemplateDialog.vue')
const { findTemplate, normalizeTemplate } = await import('@/lib/agent/reportTemplates')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })
const ok = (data) => ({ success: true, data })
const draftKey = 'cs-agent-draft-v1:7:w1:new'
const WEBSITE = {
  id: 'w1',
  name: 'Notion',
  url: 'https://www.notion.so',
  competitors: [
    { name: 'Evernote', domain: 'evernote.com' },
    { name: 'Coda', domain: 'coda.io' },
    { name: 'Obsidian', domain: 'obsidian.md' },
    { name: 'Roam', domain: 'roamresearch.com' },
  ],
}
const PROMPTS = [
  { prompt_id: 'p1', text: 'best notes app for teams', location: 'us' },
  { prompt_id: 'p2', text: 'notion alternatives', location: '' },
  { prompt_id: 'p3', text: 'wiki for startups', location: 'gb' },
  { prompt_id: 'p4', text: 'docs and tasks in one app', location: '' },
  { prompt_id: 'p5', text: 'team knowledge base', location: '' },
]

let router

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function open(key, { template = null, website = WEBSITE, websiteId = 'w1', promptRuns = null } = {}) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent/reports', name: 'agent-reports', component: Blank },
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
    ],
  })
  await router.push(`/projects/${websiteId || 'w1'}/agent/reports`)
  await router.isReady()
  const wrapper = mount(ReportTemplateDialog, {
    props: { open: true, template: template || findTemplate(key), websiteId, website, promptRuns },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const openButton = () => [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open in chat')
const choices = (legend) => {
  const fieldset = [...dialog().querySelectorAll('fieldset')].find((f) => f.querySelector('legend').textContent.trim() === legend)
  return fieldset ? [...fieldset.querySelectorAll('input')] : null
}
async function check(input, value = true) {
  input.checked = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await flushPromises()
}
async function submit() {
  openButton().click()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  fakeAuth.user = { id: 7 }
  agentApi.trackedPrompts.mockReset()
  agentApi.trackedPrompts.mockResolvedValue(ok({ prompts: PROMPTS }))
  Object.values(toast).forEach((fn) => fn.mockReset())
})

describe('ReportTemplateDialog', () => {
  it('lists the sections in order, the requirement note and asks for no prompt for the executive summary', async () => {
    await open('executive_summary')
    expect(dialog().querySelector('h2, [id]').textContent).toBeTruthy()
    expect(dialog().textContent).toContain('Executive summary')
    const sections = [...dialog().querySelectorAll('.ag-rtd-section-title')].map((el) => el.textContent.trim())
    expect(sections).toEqual(['Key numbers', 'Gap mix', 'Who AI recommends', 'Biggest gaps', 'Top fixes', 'Method'])
    expect(dialog().textContent).toContain('Uses data already measured. Runs no new Google searches or AI engine questions.')
    expect(choices('Prompts')).toBeNull()
    expect(agentApi.trackedPrompts).not.toHaveBeenCalled()
    expect(openButton().disabled).toBe(false)
  })

  it('opens a new chat with the template, the research agent and the drafted request, sending nothing', async () => {
    const wrapper = await open('executive_summary')
    await submit()
    const route = router.currentRoute.value
    expect(route.name).toBe('agent-home')
    expect(route.params).toEqual({ websiteId: 'w1' })
    expect(route.query).toEqual({ agent: 'gap_analyst', from: 'reports', template: 'executive_summary' })
    expect(localStorage.getItem(draftKey)).toBe('Write an executive summary report for Notion.')
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('names a per-prompt section as such', async () => {
    await open('google_ai_gap')
    const sections = [...dialog().querySelectorAll('.ag-rtd-section-title')].map((el) => el.textContent.trim())
    expect(sections).toContain('One section per prompt')
  })

  it('offers up to four tracked prompts for the gap report and drafts them in order of picking', async () => {
    await open('google_ai_gap')
    expect(agentApi.trackedPrompts).toHaveBeenCalledWith('w1')
    const boxes = choices('Prompts')
    expect(boxes).toHaveLength(5)
    expect(boxes.every((b) => b.type === 'checkbox')).toBe(true)
    expect(dialog().textContent).toContain('Pick up to 4. With none picked, the agent picks from your tracked prompts.')
    expect(dialog().textContent).toContain('best notes app for teams · United States')
    await check(boxes[2])
    await check(boxes[0])
    await check(boxes[1])
    await check(boxes[3])
    // The fifth is disabled once four are picked.
    expect(choices('Prompts')[4].disabled).toBe(true)
    await check(boxes[1], false)
    expect(choices('Prompts')[4].disabled).toBe(false)
    await submit()
    expect(localStorage.getItem(draftKey)).toBe(
      'Write a Google vs AI gap report for Notion.\nResearch these prompts:\n1. "wiki for startups"\n2. "best notes app for teams"\n3. "docs and tasks in one app"',
    )
    expect(router.currentRoute.value.query.template).toBe('google_ai_gap')
  })

  it('never keeps more than four prompts, even if a disabled box reports a change', async () => {
    await open('google_ai_gap')
    const boxes = choices('Prompts')
    for (const i of [0, 1, 2, 3]) await check(boxes[i])
    expect(boxes[4].disabled).toBe(true)
    // A change event on the disabled fifth box is ignored.
    await check(boxes[4])
    await check(boxes[0], false)
    await submit()
    expect(localStorage.getItem(draftKey)).toBe(
      'Write a Google vs AI gap report for Notion.\nResearch these prompts:\n1. "notion alternatives"\n2. "wiki for startups"\n3. "docs and tasks in one app"',
    )
  })

  it('lets the gap report open with no prompt picked', async () => {
    await open('google_ai_gap')
    expect(openButton().disabled).toBe(false)
    await submit()
    expect(localStorage.getItem(draftKey)).toBe('Write a Google vs AI gap report for Notion.')
  })

  it('needs one prompt for the deep dive, picked with radio buttons', async () => {
    await open('prompt_deep_dive')
    const radios = choices('Prompt')
    expect(radios.every((r) => r.type === 'radio')).toBe(true)
    expect(dialog().textContent).toContain('Pick the prompt this report covers.')
    expect(openButton().disabled).toBe(true)
    await check(radios[1])
    expect(openButton().disabled).toBe(false)
    await check(radios[3])
    await submit()
    expect(localStorage.getItem(draftKey)).toBe(
      'Write a prompt deep dive report for Notion.\nThe tracked prompt:\n1. "docs and tasks in one app"',
    )
  })

  it('cannot start the deep dive on a project with no tracked prompts, and says why', async () => {
    agentApi.trackedPrompts.mockResolvedValue(ok({ prompts: [] }))
    await open('prompt_deep_dive')
    expect(dialog().textContent).toContain('This project has no tracked prompts yet.')
    expect(dialog().querySelector('.ag-rtd-unavailable').textContent).toContain(
      'Track a prompt first: this report covers one tracked prompt.',
    )
    expect(openButton().disabled).toBe(true)
  })

  it('keeps Open in chat off while the prompts load', async () => {
    const pending = deferred()
    agentApi.trackedPrompts.mockReturnValue(pending.promise)
    await open('google_ai_gap')
    expect(dialog().textContent).toContain('Loading your prompts')
    expect(openButton().disabled).toBe(true)
    pending.resolve(ok({ prompts: PROMPTS }))
    await flushPromises()
    expect(openButton().disabled).toBe(false)
  })

  it('lets the deep dive go on when the prompts fail to load (the agent asks), and retries', async () => {
    agentApi.trackedPrompts.mockRejectedValueOnce(new Error('offline'))
    await open('prompt_deep_dive')
    expect(dialog().textContent).toContain("Couldn't load your tracked prompts. The agent asks which prompt to cover.")
    expect(openButton().disabled).toBe(false)
    const retry = [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Try again')
    retry.click()
    await flushPromises()
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(2)
    expect(choices('Prompt')).toHaveLength(5)
    expect(openButton().disabled).toBe(true)
  })

  it('drops a prompts reply that arrives after the project changed', async () => {
    const first = deferred()
    const second = deferred()
    agentApi.trackedPrompts.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = await open('google_ai_gap')
    await wrapper.setProps({ websiteId: 'w2', website: { id: 'w2', name: 'Coda', url: 'https://coda.io' } })
    expect(agentApi.trackedPrompts).toHaveBeenLastCalledWith('w2')
    second.resolve(ok({ prompts: [{ prompt_id: 'q1', text: 'coda prompt' }] }))
    await flushPromises()
    first.resolve(ok({ prompts: PROMPTS }))
    await flushPromises()
    const labels = [...dialog().querySelectorAll('.ag-rtd-check')].map((l) => l.textContent.trim())
    expect(labels).toEqual(['coda prompt'])
  })

  it('clears the picks when it opens again', async () => {
    const wrapper = await open('google_ai_gap')
    await check(choices('Prompts')[0])
    await wrapper.setProps({ open: false })
    await flushPromises()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(choices('Prompts').some((b) => b.checked)).toBe(false)
    expect(agentApi.trackedPrompts).toHaveBeenCalledTimes(2)
  })

  it('offers up to three tracked competitors for the comparison', async () => {
    await open('competitor_comparison')
    const boxes = choices('Competitors')
    expect(boxes).toHaveLength(4)
    await check(boxes[0])
    await check(boxes[2])
    await check(boxes[3])
    expect(choices('Competitors')[1].disabled).toBe(true)
    await check(choices('Prompts')[0])
    await submit()
    expect(localStorage.getItem(draftKey)).toBe(
      'Write a competitor comparison report for Notion.\nCompare with Evernote (evernote.com), Obsidian (obsidian.md) and Roam (roamresearch.com).\nResearch these prompts:\n1. "best notes app for teams"',
    )
  })

  it('says when the project tracks no competitors, and still opens', async () => {
    await open('competitor_comparison', { website: { ...WEBSITE, competitors: [] } })
    expect(dialog().textContent).toContain('This project tracks no competitors yet. Add them in Project settings.')
    expect(choices('Competitors')).toHaveLength(0)
    expect(openButton().disabled).toBe(false)
  })

  it('shows no competitor picker for other templates', async () => {
    await open('sources_citations')
    expect(choices('Competitors')).toBeNull()
    expect(choices('Prompts')).toHaveLength(5)
  })

  it('names the brand by its domain when the project has no name, and this project without either', async () => {
    const first = await open('brand_accuracy', { website: { url: 'https://www.notion.so' } })
    await submit()
    expect(localStorage.getItem(draftKey)).toBe('Write a brand accuracy report for notion.so.')
    first.unmount()
    localStorage.clear()
    await open('brand_accuracy', { website: null })
    await submit()
    expect(localStorage.getItem(draftKey)).toBe('Write a brand accuracy report for this project.')
  })

  it('cannot start a template the workspace cannot run, and gives the plain reason', async () => {
    const template = normalizeTemplate({
      id: 'brand_accuracy',
      name: 'Brand accuracy',
      available: false,
      unavailable: {
        code: 'insights_off',
        message: "Brand accuracy needs the Sentiment and Fact check analysis, which isn't turned on for this workspace.",
      },
    })
    await open('brand_accuracy', { template })
    expect(dialog().querySelector('.ag-rtd-unavailable').textContent).toContain(
      "Brand accuracy needs the Sentiment and Fact check analysis, which isn't turned on for this workspace.",
    )
    expect(dialog().textContent).not.toContain('INSIGHTS_ENABLED')
    expect(openButton().disabled).toBe(true)
    await submit()
    expect(router.currentRoute.value.name).toBe('agent-reports')
  })

  it('shows staff the setting to change', async () => {
    const template = normalizeTemplate({
      id: 'prompt_deep_dive',
      available: false,
      unavailable: { code: 'google_not_configured', message: "Google search isn't set up on this workspace.", setting: 'SERPAPI_KEY' },
    })
    await open('prompt_deep_dive', { template })
    expect(dialog().querySelector('.ag-rtd-unavailable').textContent).toContain('Setting: SERPAPI_KEY')
  })

  it('lists what the report will show as not set up', async () => {
    const template = normalizeTemplate({
      id: 'google_ai_gap',
      available: true,
      limitations: [
        { code: 'engine_not_configured', message: "Grok isn't set up on this workspace." },
        { code: 'research_agents_off', message: 'The research agents are turned off.', setting: 'AGENT_SWARM_ENABLED' },
      ],
    })
    await open('google_ai_gap', { template })
    const items = [...dialog().querySelectorAll('.ag-rtd-limits li')].map((li) => li.textContent.trim())
    expect(items).toEqual(["Grok isn't set up on this workspace.", 'The research agents are turned off. Setting: AGENT_SWARM_ENABLED'])
  })

  it('tells a free plan how many prompt runs are left, never in dollars', async () => {
    const free = await open('google_ai_gap', { promptRuns: { unlimited: false, limit: 20, remaining: 9 } })
    expect(dialog().textContent).toContain('Each AI engine answer uses a free prompt run. 9 free prompt runs left.')
    expect(dialog().textContent).not.toMatch(/\$/)
    free.unmount()
    await open('google_ai_gap', { promptRuns: { unlimited: true, limit: null, remaining: null } })
    expect(dialog().textContent).not.toContain('prompt run')
  })

  it('needs a project', async () => {
    await open('executive_summary', { websiteId: null })
    expect(dialog().querySelector('.ag-rtd-unavailable').textContent).toContain('Pick a project first.')
    expect(openButton().disabled).toBe(true)
  })

  it('stays open when the draft cannot be handed over', async () => {
    fakeAuth.user = null
    const wrapper = await open('executive_summary')
    await submit()
    expect(router.currentRoute.value.name).toBe('agent-reports')
    expect(wrapper.emitted('update:open')).toBeUndefined()
    expect(openButton().disabled).toBe(false)
  })

  it('closes with Cancel and Escape', async () => {
    const wrapper = await open('executive_summary')
    const cancel = [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel')
    cancel.click()
    await flushPromises()
    expect(wrapper.emitted('update:open')).toEqual([[false]])

    const again = await open('executive_summary')
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(again.emitted('update:open')).toEqual([[false]])
  })
})
