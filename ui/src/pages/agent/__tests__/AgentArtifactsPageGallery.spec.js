import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const fakeAgent = reactive({})
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))
const fakeApp = reactive({ activeWebsite: null, websites: [] })
vi.mock('@/stores/app', () => ({ useAppStore: () => fakeApp }))

vi.mock('@/components/agent/reports/ReportTemplateGallery.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'ReportTemplateGallery',
      props: ['websiteId', 'website'],
      setup: (props) => () => vue.h('section', { class: 'gallery-stub', 'data-wid': props.websiteId || '', 'data-name': props.website?.name || '' }),
    }),
  }
})

const { default: AgentArtifactsPage } = await import('../AgentArtifactsPage.vue')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

async function setup(name, kinds, websiteId = 'w1') {
  setActivePinia(createPinia())
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent', name: 'agent-home', component: Blank },
      { path: '/projects/:websiteId/agent/reports', name: 'agent-reports', component: Blank },
      { path: '/projects/:websiteId/agent/documents', name: 'agent-documents', component: Blank },
      { path: '/projects/:websiteId/agent/sheets', name: 'agent-sheets', component: Blank },
      { path: '/projects/:websiteId/agent/artifacts/:artifactId', name: 'agent-artifact', component: Blank },
      { path: '/projects/:websiteId/agent/c/:chatId', name: 'agent-chat', component: Blank },
    ],
  })
  await router.push({ name, params: { websiteId } })
  await router.isReady()
  const wrapper = mount(AgentArtifactsPage, { props: { websiteId, kinds }, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  for (const key of Object.keys(fakeAgent)) delete fakeAgent[key]
  Object.assign(fakeAgent, { websiteId: 'w1', loadArtifacts: vi.fn(async () => []) })
  fakeApp.activeWebsite = { id: 'w1', name: 'Notion', url: 'https://notion.so', competitors: [] }
  fakeApp.websites = [fakeApp.activeWebsite, { id: 'w2', name: 'Coda', url: 'https://coda.io' }]
})

describe('AgentArtifactsPage: report template gallery', () => {
  it('shows the gallery above the reports for the project', async () => {
    const wrapper = await setup('agent-reports', ['report'])
    const gallery = wrapper.find('.gallery-stub')
    expect(gallery.exists()).toBe(true)
    expect(gallery.attributes('data-wid')).toBe('w1')
    expect(gallery.attributes('data-name')).toBe('Notion')
    // Before the search field and the list.
    const html = wrapper.html()
    expect(html.indexOf('gallery-stub')).toBeLessThan(html.indexOf('ag-arts-search'))
    // The empty state still shows below it.
    expect(wrapper.text()).toContain('No reports yet.')
  })

  it('finds a project that is not the active one', async () => {
    const wrapper = await setup('agent-reports', ['report'], 'w2')
    expect(wrapper.find('.gallery-stub').attributes('data-name')).toBe('Coda')
  })

  it('passes no project it cannot find', async () => {
    const wrapper = await setup('agent-reports', ['report'], 'w9')
    expect(wrapper.find('.gallery-stub').attributes('data-name')).toBe('')
  })

  it.each([
    ['agent-documents', ['document', 'page']],
    ['agent-sheets', ['sheet']],
  ])('has no gallery on %s', async (name, kinds) => {
    const wrapper = await setup(name, kinds)
    expect(wrapper.find('.gallery-stub').exists()).toBe(false)
  })
})
