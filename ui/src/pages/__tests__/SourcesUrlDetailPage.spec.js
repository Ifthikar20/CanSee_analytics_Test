import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const client = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/client', () => ({ default: client }))

const { default: SourcesUrlDetailPage } = await import('../SourcesUrlDetailPage.vue')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })
const ChatViewer = defineComponent({
  name: 'ChatDetailModal',
  props: ['websiteId', 'resultId', 'open', 'hasPrev', 'hasNext'],
  render() {
    return h('div', { class: 'stub-chat', 'data-open': String(this.open), 'data-result': this.resultId })
  },
})

const DETAIL = {
  metrics: { title: 'Best note apps' },
  chats: [
    { result_id: 'r1', prompt: 'best note app', response_preview: 'Notion leads.', brand_mentioned: true, models: ['gpt4'], sources: [] },
    { result_id: 'r2', prompt: 'notion alternatives', response_preview: 'Obsidian.', brand_mentioned: false, models: ['claude'], sources: [] },
  ],
}

async function mountPage() {
  client.get.mockReset().mockResolvedValue({ data: DETAIL })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/sources/urls/detail', name: 'sources-url-detail', component: Blank },
      { path: '/projects/:websiteId/sources/urls', name: 'sources-urls', component: Blank },
      { path: '/projects/:websiteId/analytics', name: 'analytics', component: Blank },
    ],
  })
  await router.push({ name: 'sources-url-detail', params: { websiteId: 'w1' }, query: { url: 'g2.com/best-note-apps' } })
  await router.isReady()
  const wrapper = mount(SourcesUrlDetailPage, {
    global: { plugins: [router], stubs: { ChatDetailModal: ChatViewer, VizChart: true, MetricInfo: true } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

describe('SourcesUrlDetailPage: recent chats', () => {
  it('gives each chat a button that opens its answer, reachable from the keyboard', async () => {
    const wrapper = await mountPage()
    const buttons = wrapper.findAll('[data-open-chat]')
    expect(buttons).toHaveLength(2)
    expect(buttons[1].element.tagName).toBe('BUTTON')
    expect(buttons[1].attributes('type')).toBe('button')
    expect(buttons[1].text()).toContain('notion alternatives')

    await buttons[1].trigger('click')
    const viewer = wrapper.find('.stub-chat')
    expect(viewer.attributes('data-open')).toBe('true')
    expect(viewer.attributes('data-result')).toBe('r2')
  })

  it('still opens the answer on a click anywhere on the row', async () => {
    const wrapper = await mountPage()
    await wrapper.findAll('tbody tr.cursor-pointer')[0].trigger('click')
    expect(wrapper.find('.stub-chat').attributes('data-result')).toBe('r1')
    expect(wrapper.find('.stub-chat').attributes('data-open')).toBe('true')
  })
})
