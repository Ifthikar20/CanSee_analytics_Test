import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentArtifactView from '@/components/agent/browser/views/DocumentArtifactView.vue'
import { loadHighlighter } from '@/lib/agent/markdown/renderer'
import { useAgentPaneStore } from '@/stores/agentPane'

// Clicks a link and reports whether the view prevented its navigation; the
// listener on document runs after the view's own and stops jsdom navigating.
function clickLink(link) {
  let prevented = null
  const after = (event) => {
    prevented = event.defaultPrevented
    event.preventDefault()
  }
  document.addEventListener('click', after)
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  document.removeEventListener('click', after)
  return prevented
}

describe('DocumentArtifactView', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('opens web links as pane tabs inside the browser pane, and as browser tabs elsewhere', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const pane = useAgentPaneStore()
    const markdown = 'See [the guide](https://shop.test/guide).'

    // The full-page artifact view has no browser pane.
    const page = mount(DocumentArtifactView, { props: { markdown }, global: { plugins: [pinia] }, attachTo: document.body })
    const link = page.find('a').element
    expect(link.getAttribute('target')).toBe('_blank')
    expect(clickLink(link)).toBe(false)
    expect(pane.tabs).toHaveLength(0)
    page.unmount()

    const inPane = mount(DocumentArtifactView, {
      props: { markdown },
      global: { plugins: [pinia], provide: { agInBrowserPane: true } },
      attachTo: document.body,
    })
    expect(clickLink(inPane.find('a').element)).toBe(true)
    expect(pane.activeTab.url).toBe('https://shop.test/guide')
    inPane.unmount()
  })

  it('renders code plain first and highlights it when the highlighter arrives', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(DocumentArtifactView, {
      props: { markdown: '# Setup\n\n```js\nconst a = 1\n```\n', live: false, title: 'Setup' },
      global: { plugins: [pinia] },
    })
    expect(wrapper.find('h1').text()).toBe('Setup')
    expect(wrapper.find('code .hljs-keyword').exists()).toBe(false)

    expect(await loadHighlighter()).toBe(true)
    await flushPromises()
    expect(wrapper.find('code .hljs-keyword').exists()).toBe(true)
    expect(wrapper.find('code').text()).toBe('const a = 1')
    wrapper.unmount()
  })
})
