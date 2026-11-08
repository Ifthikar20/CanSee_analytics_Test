import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

// The dialog has its own tests; here it records what it was opened with.
vi.mock('../ReportTemplateDialog.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'ReportTemplateDialog',
      props: ['open', 'template', 'websiteId', 'website', 'promptRuns'],
      emits: ['update:open'],
      setup: (props) => () =>
        vue.h('div', { class: 'dialog-stub', 'data-open': String(Boolean(props.open)), 'data-template': props.template?.id || '' }),
    }),
  }
})

const { default: ReportTemplateGallery } = await import('../ReportTemplateGallery.vue')
const { fallbackTemplates, normalizeTemplate, templatesFromCatalog } = await import('@/lib/agent/reportTemplates')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

function catalogItems(overrides = {}) {
  return fallbackTemplates().map((t) => ({ ...t, ...(overrides[t.id] || {}) }))
}

function setStore({ items = templatesFromCatalog(catalogItems()), source = 'catalog', loading = false, error = null, status = null } = {}) {
  for (const key of Object.keys(fakeAgent)) delete fakeAgent[key]
  Object.assign(fakeAgent, {
    status,
    reportTemplates: { items, source, loading, error },
    loadReportTemplates: vi.fn(async () => items),
  })
}

async function render(props = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Blank }] })
  await router.push('/')
  const wrapper = mount(ReportTemplateGallery, {
    props: { websiteId: 'w1', website: { name: 'Notion', url: 'https://notion.so' }, ...props },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const cards = (wrapper) => wrapper.findAll('article.ag-rtg-card')
const card = (wrapper, name) => cards(wrapper).find((c) => c.find('.ag-rtg-name').text() === name)
const useButton = (c) => c.findAll('button').find((b) => b.text() === 'Use template')

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  setStore()
})

describe('ReportTemplateGallery', () => {
  it('loads the catalog once mounted and lists its seven templates as labelled cards', async () => {
    const wrapper = await render()
    expect(fakeAgent.loadReportTemplates).toHaveBeenCalledWith({ force: false })
    expect(wrapper.find('h2').text()).toContain('Report templates')
    expect(cards(wrapper).map((c) => c.find('.ag-rtg-name').text())).toEqual([
      'Executive summary',
      'Google vs AI gap',
      'Competitor comparison',
      'Prompt deep dive',
      'Sources and citations',
      'Brand accuracy',
      'Change log since the last run',
    ])
    const first = cards(wrapper)[0]
    const nameId = first.find('.ag-rtg-name').attributes('id')
    const purposeId = first.find('.ag-rtg-purpose').attributes('id')
    expect(first.attributes('aria-labelledby')).toBe(nameId)
    expect(first.attributes('aria-describedby')).toBe(purposeId)
    expect(wrapper.find('ul.ag-rtg-grid').attributes('role')).toBe('list')
  })

  it('gives each card a live preview, its purpose, what it needs and the sections in words', async () => {
    const wrapper = await render()
    const deepDive = card(wrapper, 'Prompt deep dive')
    expect(deepDive.find('.ag-rtp header.ag-rh').exists()).toBe(true)
    expect(deepDive.find('.ag-rtp-badge').text()).toBe('Sample')
    expect(deepDive.find('.ag-rtg-purpose').text()).toBe('One tracked prompt, end to end: Google, every engine, the sources and the fixes.')
    expect(deepDive.findAll('.ag-rtg-badge').map((b) => b.text())).toEqual(['Needs Google results', 'Saved engine answers'])
    expect(deepDive.find('.ag-rtg-badges').attributes('aria-label')).toBe('What Prompt deep dive needs')
    expect(deepDive.find('.ag-sr-only').text()).toBe(
      'Preview with sample data. Sections: Verdict and gap, Google results and AI Overview, What each engine said, Sources cited, On-page check, Fixes, Method.',
    )
    const gap = card(wrapper, 'Google vs AI gap')
    expect(gap.find('.ag-sr-only').text()).toContain('one section per prompt')
  })

  it('opens the dialog for the template with Use template, by mouse or keyboard', async () => {
    const wrapper = await render()
    expect(wrapper.find('.dialog-stub').attributes('data-open')).toBe('false')
    const button = useButton(card(wrapper, 'Change log since the last run'))
    expect(button.attributes('aria-label')).toBe('Use template: Change log since the last run')
    button.element.focus()
    expect(document.activeElement).toBe(button.element)
    await button.trigger('click')
    expect(wrapper.find('.dialog-stub').attributes('data-open')).toBe('true')
    expect(wrapper.find('.dialog-stub').attributes('data-template')).toBe('change_log')
  })

  it('disables a template the workspace cannot run, with the plain reason tied to the button', async () => {
    setStore({
      items: templatesFromCatalog(
        catalogItems({
          brand_accuracy: {
            available: false,
            unavailable: {
              code: 'insights_off',
              message: "Brand accuracy needs the Sentiment and Fact check analysis, which isn't turned on for this workspace.",
            },
          },
        }),
      ),
    })
    const wrapper = await render()
    const c = card(wrapper, 'Brand accuracy')
    expect(c.classes()).toContain('is-unavailable')
    const why = c.find('.ag-rtg-why')
    expect(why.text()).toBe("Brand accuracy needs the Sentiment and Fact check analysis, which isn't turned on for this workspace.")
    expect(why.text()).not.toContain('INSIGHTS_ENABLED')
    const button = useButton(c)
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-describedby')).toBe(why.attributes('id'))
    await button.trigger('click')
    expect(wrapper.find('.dialog-stub').attributes('data-open')).toBe('false')
    // The other cards stay usable.
    expect(useButton(card(wrapper, 'Executive summary')).attributes('disabled')).toBeUndefined()
  })

  it('shows staff the setting behind a reason or a limitation', async () => {
    setStore({
      items: templatesFromCatalog(
        catalogItems({
          prompt_deep_dive: {
            available: false,
            unavailable: { code: 'google_not_configured', message: "Google search isn't set up on this workspace.", setting: 'SERPAPI_KEY' },
          },
          google_ai_gap: {
            limitations: [{ code: 'engine_not_configured', message: "Grok isn't set up on this workspace.", setting: 'XAI_API_KEY' }],
          },
        }),
      ),
    })
    const wrapper = await render()
    expect(card(wrapper, 'Prompt deep dive').find('.ag-rtg-why').text()).toContain('Setting: SERPAPI_KEY')
    expect(card(wrapper, 'Google vs AI gap').find('.ag-rtg-limits').text()).toBe("Grok isn't set up on this workspace. Setting: XAI_API_KEY")
  })

  it('tells free users how many prompt runs are left on templates that ask the engines', async () => {
    setStore({ status: { prompt_runs: { unlimited: false, limit: 20, remaining: 4 } } })
    const wrapper = await render()
    const line = 'Each AI engine answer uses a free prompt run. 4 free prompt runs left.'
    expect(card(wrapper, 'Google vs AI gap').find('.ag-rtg-meta').text()).toBe(line)
    expect(card(wrapper, 'Competitor comparison').find('.ag-rtg-meta').text()).toBe(line)
    expect(card(wrapper, 'Executive summary').find('.ag-rtg-meta').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/\$/)
  })

  it('shows no prompt runs line on a paid plan', async () => {
    setStore({ status: { prompt_runs: { unlimited: true, limit: null, remaining: null } } })
    const wrapper = await render()
    expect(wrapper.find('.ag-rtg-meta').exists()).toBe(false)
  })

  it('keeps listing the templates when the catalog fails, says so and tries again', async () => {
    setStore({ items: fallbackTemplates(), source: 'fallback', error: { code: 'network', message: 'Offline' } })
    const wrapper = await render()
    expect(cards(wrapper)).toHaveLength(7)
    const notice = wrapper.find('.ag-rtg-notice')
    expect(notice.text()).toContain("Couldn't check which templates this workspace can run.")
    expect(notice.attributes('role')).toBe('status')
    // Availability is unknown, so nothing is disabled.
    expect(cards(wrapper).every((c) => useButton(c).attributes('disabled') === undefined)).toBe(true)
    await notice.find('button').trigger('click')
    expect(fakeAgent.loadReportTemplates).toHaveBeenLastCalledWith({ force: true })
  })

  it('shows placeholders while the first load runs', async () => {
    setStore({ items: [], source: '', loading: true })
    const wrapper = await render()
    expect(wrapper.find('.ag-rtg-card.is-skeleton').exists()).toBe(true)
    expect(wrapper.find('ul.ag-rtg-grid').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('[role="status"]').text()).toBe('Loading report templates')
    expect(cards(wrapper).filter((c) => !c.classes('is-skeleton'))).toHaveLength(0)
  })

  it('shows one card when the catalog has one template', async () => {
    setStore({ items: [normalizeTemplate({ id: 'sources_citations', name: 'Sources and citations', available: true })] })
    const wrapper = await render()
    expect(cards(wrapper).map((c) => c.find('.ag-rtg-name').text())).toEqual(['Sources and citations'])
    expect(wrapper.find('.ag-rtg-notice').exists()).toBe(false)
  })

  it('uses the local copy with a store that cannot load templates', async () => {
    for (const key of Object.keys(fakeAgent)) delete fakeAgent[key]
    const wrapper = await render()
    expect(cards(wrapper)).toHaveLength(7)
    expect(wrapper.find('.ag-rtg-notice').text()).toContain("Couldn't check")
    expect(wrapper.find('.ag-rtg-notice button').exists()).toBe(false)
  })

  it('needs a project to start a template', async () => {
    const wrapper = await render({ websiteId: null })
    expect(cards(wrapper).every((c) => useButton(c).attributes('disabled') !== undefined)).toBe(true)
  })

  it('hides and shows the templates and remembers the choice', async () => {
    const wrapper = await render()
    const toggle = wrapper.find('.ag-rtg-toggle')
    const body = wrapper.find(`#${toggle.attributes('aria-controls')}`)
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.text()).toBe('Hide templates')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.text()).toBe('Show templates')
    expect(body.isVisible()).toBe(false)
    wrapper.unmount()
    const again = await render()
    expect(again.find('.ag-rtg-toggle').attributes('aria-expanded')).toBe('false')
    await again.find('.ag-rtg-toggle').trigger('click')
    expect(again.find('.ag-rtg-toggle').attributes('aria-expanded')).toBe('true')
  })

  it('has a help tip on the heading', async () => {
    const wrapper = await render()
    const tip = wrapper.find('h2 .cs-helptip')
    expect(tip.exists()).toBe(true)
    expect(tip.attributes('aria-label')).toBe('About report templates')
  })
})
