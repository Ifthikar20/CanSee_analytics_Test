import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const { agentState, authState } = vi.hoisted(() => ({
  agentState: { websiteId: 'w1', messages: {}, chatState: {}, swarms: {}, artifacts: {}, visiblePath: () => [] },
  authState: { user: { id: 'u1' }, session: null, accessToken: null },
}))

vi.mock('../../../../stores/agent', () => ({ useAgentStore: () => agentState }))
vi.mock('../../../../stores/auth', () => ({ useAuthStore: () => authState }))

const { useAgentPaneStore } = await import('../../../../stores/agentPane')
const { default: FindBar } = await import('../FindBar.vue')

let pane
let id
let wrapper

function mountBar(props = {}) {
  const tab = pane.tabs.find((t) => t.id === id)
  wrapper = mount(FindBar, { props: { tab, mode: 'reader', ...props }, attachTo: document.body })
  return wrapper
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  setActivePinia(createPinia())
  pane = useAgentPaneStore()
  id = pane.openUrl('https://example.com/')
  pane.openFind(id)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('FindBar', () => {
  it('applies typed text after a short pause', async () => {
    mountBar()
    await wrapper.find('input').setValue('pricing')
    expect(pane.findOf(id).text).toBe('')
    vi.advanceTimersByTime(150)
    expect(pane.findOf(id).text).toBe('pricing')
  })

  it('goes to the first match on Enter right after typing, then steps', async () => {
    mountBar({ count: 3 })
    const input = wrapper.find('input')
    await input.setValue('pricing')
    await input.trigger('keydown', { key: 'Enter' })
    expect(pane.findOf(id)).toMatchObject({ text: 'pricing', index: 0 })
    pane.setFindCount(id, 3)
    await input.trigger('keydown', { key: 'Enter' })
    expect(pane.findOf(id).index).toBe(1)
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(pane.findOf(id).index).toBe(0)
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(pane.findOf(id).index).toBe(2)
  })

  it('closes on Escape without letting the key reach the workspace', async () => {
    const outside = vi.fn()
    document.body.addEventListener('keydown', outside)
    mountBar()
    await wrapper.find('input').trigger('keydown', { key: 'Escape' })
    expect(pane.findOf(id)).toBeNull()
    expect(outside).not.toHaveBeenCalled()
    document.body.removeEventListener('keydown', outside)
  })

  it('announces the match position and empty results', async () => {
    mountBar({ count: 0 })
    pane.setFindText(id, 'pricing')
    await wrapper.vm.$nextTick()
    const status = wrapper.find('[role="status"]')
    expect(status.attributes('aria-live')).toBe('polite')
    expect(status.text()).toBe('No matches')
    pane.setFindCount(id, 4)
    pane.stepFind(id, 1)
    await wrapper.setProps({ count: 4 })
    expect(status.text()).toBe('2 of 4')
    await wrapper.setProps({ capped: true })
    expect(status.text()).toBe('2 of 4, first 1000 shown')
  })

  it('reports the position among keyword highlights, so steps are announced', async () => {
    pane.setKeywordHighlight({ keyword: 'crm', brand: ['Acme'], competitors: [] })
    mountBar({ count: 0, total: 0 })
    const status = wrapper.find('[role="status"]')
    expect(status.text()).toBe('Not on this page')
    pane.setFindCount(id, 3)
    await wrapper.setProps({ count: 3, total: 3 })
    expect(status.text()).toBe('1 of 3 highlights')
    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    expect(status.text()).toBe('2 of 3 highlights')
  })

  it('steps on Enter when edits put the text back as it was', async () => {
    pane.setFindText(id, 'cat')
    pane.setFindCount(id, 5)
    mountBar({ count: 5 })
    const input = wrapper.find('input')
    await input.setValue('cats')
    await input.setValue('cat')
    await input.trigger('keydown', { key: 'Enter' })
    expect(pane.findOf(id).index).toBe(1)
  })

  it('closes on Escape from any control in the bar', async () => {
    const outside = vi.fn()
    document.body.addEventListener('keydown', outside)
    mountBar({ count: 2 })
    const next = wrapper.findAll('button').find((b) => b.attributes('aria-label') === 'Next match')
    await next.trigger('keydown', { key: 'Escape' })
    expect(pane.findOf(id)).toBeNull()
    expect(outside).not.toHaveBeenCalled()
    document.body.removeEventListener('keydown', outside)
  })

  it('closes on Escape in live mode too', async () => {
    mountBar({ mode: 'live' })
    const button = wrapper.findAll('button.ag-find-link').find((b) => b.text() === 'Switch to reader')
    await button.trigger('keydown', { key: 'Escape' })
    expect(pane.findOf(id)).toBeNull()
  })

  it('leaves Enter and Escape to an IME that is composing', async () => {
    pane.setFindText(id, 'cat')
    pane.setFindCount(id, 5)
    mountBar({ count: 5 })
    const input = wrapper.find('input')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    await input.trigger('keydown', { key: 'Enter', keyCode: 229 })
    expect(pane.findOf(id).index).toBe(0)
    await input.trigger('keydown', { key: 'Escape', isComposing: true })
    expect(pane.findOf(id)).not.toBeNull()
  })

  it('keeps focus in the bar after clearing the keyword', async () => {
    pane.setKeywordHighlight({ keyword: 'crm', brand: [], competitors: [] })
    mountBar()
    const clear = wrapper.findAll('button.ag-find-link').find((b) => b.text().startsWith('Clear'))
    clear.element.focus()
    await clear.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.find('button.ag-find-pick').element)
  })

  it('moves focus to the find input after switching to the reader view', async () => {
    mountBar({ mode: 'live', onReader: () => wrapper.setProps({ mode: 'reader' }) })
    const button = wrapper.findAll('button.ag-find-link').find((b) => b.text() === 'Switch to reader')
    await button.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.find('input').element)
  })

  it('shows the keyword legend and clears it', async () => {
    pane.setKeywordHighlight({ keyword: 'crm', brand: ['Acme'], competitors: [] })
    mountBar()
    const legend = wrapper.find('.ag-find-legend')
    expect(legend.find('mark.is-keyword').exists()).toBe(true)
    expect(legend.find('mark.is-brand').exists()).toBe(true)
    expect(legend.find('mark.is-competitor').exists()).toBe(false)
    const clear = wrapper.findAll('button.ag-find-link').find((b) => b.text().startsWith('Clear'))
    await clear.trigger('click')
    expect(pane.keywordHighlight).toBeNull()
  })

  it('explains live mode and offers the reader view', async () => {
    mountBar({ mode: 'live' })
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.text()).toContain('Highlighting works in the reader view.')
    const button = wrapper.findAll('button.ag-find-link').find((b) => b.text() === 'Switch to reader')
    await button.trigger('click')
    expect(wrapper.emitted('reader')).toHaveLength(1)
  })

  it('keeps text typed just before the bar unmounts', async () => {
    mountBar()
    await wrapper.find('input').setValue('pricing')
    wrapper.unmount()
    wrapper = null
    expect(pane.findOf(id).text).toBe('pricing')
  })
})

describe('FindBar keyword picker', () => {
  beforeEach(() => {
    vi.useRealTimers()
    agentState.messages = {
      m1: {
        id: 'm1',
        role: 'assistant',
        research: {
          serp: {
            a: {
              capture_id: 'a',
              query: 'best crm',
              page: 1,
              prompt_id: 'P1',
              results: [{ position: 2, is_competitor: true, competitor_name: 'Globex' }],
              brand_positions: [4],
              brand: { name: 'Acme' },
              ai_overview: { shown: true, content_captured: true, mentions_you: true, cites_you: false },
            },
            b: { capture_id: 'b', query: 'crm pricing', page: 1, results: [], brand_positions: [] },
          },
        },
      },
    }
    agentState.visiblePath = () => ['m1']
    pane.bindChat('c1')
    id = pane.openUrl('https://example.com/')
    pane.openFind(id)
  })

  afterEach(() => {
    agentState.messages = {}
    agentState.visiblePath = () => []
  })

  async function openMenu() {
    await wrapper.find('button.ag-find-pick').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    return document.body.querySelector('.ag-portal.ag-menu')
  }

  it('lists the ranked searches first and the other searches after, without repeats', async () => {
    mountBar()
    const menu = await openMenu()
    const text = menu.textContent
    const rankedAt = text.indexOf('Searched in this chat · ranked by your Google position')
    const othersAt = text.indexOf('Other searches in this chat')
    expect(rankedAt).toBeGreaterThan(-1)
    expect(othersAt).toBeGreaterThan(rankedAt)
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')]
    expect(items.map((el) => el.querySelector('.ag-menu-text').textContent.trim())).toEqual(['best crm', 'crm pricing'])
    expect(items[0].getAttribute('aria-label')).toBe('best crm, #4 on Google, AI Overview: Names you')
    expect(items[0].textContent).toContain('#4')
  })

  it('highlights a ranked search with its brand and competitor names', async () => {
    mountBar()
    const menu = await openMenu()
    menu.querySelector('[role="menuitemradio"]').click()
    await flushPromises()
    expect(pane.keywordHighlight).toMatchObject({ keyword: 'best crm', brand: ['Acme'], competitors: ['Globex'] })
  })

  it('highlights a ranked keyword with the names its other searches found too', async () => {
    agentState.messages.m1.research.serp.d = {
      capture_id: 'd',
      query: 'best crm',
      page: 2,
      results: [{ position: 15, is_competitor: true, competitor_name: 'Zoho' }],
      brand_positions: [],
    }
    mountBar()
    const menu = await openMenu()
    menu.querySelector('[role="menuitemradio"]').click()
    await flushPromises()
    expect(pane.keywordHighlight.competitors).toEqual(['Globex', 'Zoho'])
  })

  it('offers two tracked prompts of the same text once, the better ranked one', async () => {
    agentState.messages.m1.research.serp.c = {
      capture_id: 'c',
      query: 'Best CRM',
      page: 1,
      prompt_id: 'P2',
      results: [],
      brand_positions: [9],
    }
    mountBar()
    const menu = await openMenu()
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')]
    expect(items.map((el) => el.querySelector('.ag-menu-text').textContent.trim())).toEqual(['best crm', 'crm pricing'])
    expect(items[0].getAttribute('aria-label')).toBe('best crm, #4 on Google, AI Overview: Names you')
  })
})
