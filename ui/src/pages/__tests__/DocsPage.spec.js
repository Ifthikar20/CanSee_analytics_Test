import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import DocsPage from '@/pages/DocsPage.vue'

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })

async function render() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/docs', name: 'docs', component: DocsPage },
    ],
  })
  await router.push('/docs')
  await router.isReady()
  const wrapper = mount(DocsPage, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

// The docs describe screens that exist (the page's own rule). The Overview
// and the Sources page became the Analytics board, its widgets and the side
// panel; Google's "AI Overview" is a different thing and stays.
describe('DocsPage', () => {
  it('describes Analytics as one board, not the Overview or the old top bar', async () => {
    const wrapper = await render()
    const text = wrapper.text().replace(/AI Overview/g, '')
    expect(text).not.toMatch(/Overview/)
    expect(text).not.toMatch(/top bar/)
    expect(text).not.toMatch(/Prompt page|prompt page/)

    const nav = wrapper.findAll('nav button, nav a').map((b) => b.text())
    expect(nav).toEqual(expect.arrayContaining(['Analytics', 'Prompt detail', 'Citations']))

    // Older links into the docs still land on their sections.
    expect(wrapper.find('section#overview h2').text()).toBe('Analytics')
    expect(wrapper.find('section#prompt h2').text()).toBe('Prompt detail')
    expect(wrapper.find('section#sources h2').text()).toBe('Citations')
    expect(wrapper.find('section#overview').text()).toContain('The board starts with Ask AI and Prompt ranking.')
    expect(wrapper.find('section#quickstart').text()).toContain('On Analytics, choose Add prompts in Prompts')
  })
})
