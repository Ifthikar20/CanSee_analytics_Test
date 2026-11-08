import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client }))
vi.mock('@/api/websites', () => ({ default: { delete: vi.fn(), list: vi.fn() } }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: ProjectSettings } = await import('../ProjectSettings.vue')
const { useAppStore } = await import('@/stores/app')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })
const ShellStub = defineComponent({ name: 'SettingsShell', setup: (_, { slots }) => () => h('div', slots.default?.()) })

const SITE = { id: 'w1', name: 'Notion', url: 'https://notion.so' }
const PROJECT = {
  id: 'w1',
  name: 'Notion',
  url: 'https://notion.so',
  industry: 'SaaS',
  description: '',
  competitors: [{ name: 'Coda', domain: 'coda.io' }],
}

async function mountPage() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = useAppStore()
  app.setWebsites([SITE])
  app.setActiveWebsite(SITE)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'dashboard', component: Blank }] })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(ProjectSettings, { global: { plugins: [pinia, router], stubs: { SettingsShell: ShellStub } } })
  await flushPromises()
  return wrapper
}

const saveCompetitorsButton = (wrapper) => wrapper.findAll('button').find((b) => b.text() === 'Save competitors')
const notes = (wrapper) => wrapper.findAll('.ps-note').map((n) => n.text())

beforeEach(() => {
  client.get.mockReset().mockResolvedValue({ data: PROJECT })
  client.put.mockReset()
})

describe('ProjectSettings: competitors', () => {
  it('confirms a successful save with Saved', async () => {
    const wrapper = await mountPage()
    await wrapper.find('input[aria-label="Competitor 1 domain"]').setValue('coda.com')
    client.put.mockResolvedValue({ data: { ...PROJECT, competitors: [{ name: 'Coda', domain: 'coda.com' }] } })
    await saveCompetitorsButton(wrapper).trigger('click')
    await flushPromises()
    expect(client.put).toHaveBeenCalledWith('/websites/w1/', { competitors: [{ name: 'Coda', domain: 'coda.com' }] }, { _silentError: true })
    expect(notes(wrapper)).toEqual(['Saved'])
  })

  it('hides Saved again once the list is edited', async () => {
    const wrapper = await mountPage()
    client.put.mockResolvedValue({ data: PROJECT })
    await saveCompetitorsButton(wrapper).trigger('click')
    await flushPromises()
    expect(notes(wrapper)).toEqual(['Saved'])
    await wrapper.find('input[aria-label="Competitor 1 name"]').setValue('Coda Inc')
    expect(notes(wrapper)).toEqual([])
  })

  it('says so when the save fails', async () => {
    const wrapper = await mountPage()
    client.put.mockRejectedValue(new Error('500'))
    await saveCompetitorsButton(wrapper).trigger('click')
    await flushPromises()
    expect(notes(wrapper)).toEqual(["Couldn't save. Try again."])
  })
})
