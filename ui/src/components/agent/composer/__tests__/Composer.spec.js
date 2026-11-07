import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import Composer from '@/components/agent/composer/Composer.vue'
import { useAgentUiStore } from '@/stores/agentUi'

const Passthrough = defineComponent({
  inheritAttrs: false,
  setup(_, { slots }) {
    return () => slots.default?.()
  },
})

let coarse = false
const realMatchMedia = window.matchMedia

function mountComposer(props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(Composer, {
    props: { modelValue: '', agents: [], ...props },
    attachTo: document.body,
    global: {
      plugins: [pinia],
      stubs: {
        PlusMenu: true,
        DictationButton: true,
        AgTooltip: Passthrough,
      },
    },
  })
}

function key(el, init, extra = {}) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  for (const [name, value] of Object.entries(extra)) {
    Object.defineProperty(event, name, { get: () => value })
  }
  el.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.useFakeTimers()
  coarse = false
  window.matchMedia = (query) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })
})

afterEach(() => {
  vi.useRealTimers()
  window.matchMedia = realMatchMedia
  document.body.innerHTML = ''
})

describe('Composer keyboard and IME', () => {
  it('sends the trimmed text on Enter', () => {
    const w = mountComposer({ modelValue: '  research turonote  ' })
    const event = key(w.find('textarea').element, { key: 'Enter' })
    expect(event.defaultPrevented).toBe(true)
    expect(w.emitted('submit')).toEqual([['research turonote']])
  })

  it('keeps Shift+Enter as a newline', () => {
    const w = mountComposer({ modelValue: 'line one' })
    const event = key(w.find('textarea').element, { key: 'Enter', shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('ignores Enter while an input method is composing', async () => {
    const w = mountComposer({ modelValue: 'にほん' })
    const area = w.find('textarea')
    await area.trigger('compositionstart')
    const event = key(area.element, { key: 'Enter' })
    expect(event.defaultPrevented).toBe(false)
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('ignores Enter flagged isComposing', () => {
    const w = mountComposer({ modelValue: '中文' })
    key(w.find('textarea').element, { key: 'Enter', isComposing: true })
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('ignores Enter with keyCode 229', () => {
    const w = mountComposer({ modelValue: '한국어' })
    key(w.find('textarea').element, { key: 'Enter' }, { keyCode: 229 })
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('ignores the Enter that arrives right after compositionend, then sends', async () => {
    const w = mountComposer({ modelValue: '日本語の質問' })
    const area = w.find('textarea')
    await area.trigger('compositionstart')
    await area.trigger('compositionend')
    key(area.element, { key: 'Enter' })
    expect(w.emitted('submit')).toBeUndefined()
    vi.advanceTimersByTime(40)
    key(area.element, { key: 'Enter' })
    expect(w.emitted('submit')).toEqual([['日本語の質問']])
  })

  it('sends with Ctrl+Enter and Cmd+Enter', () => {
    const w = mountComposer({ modelValue: 'hello' })
    key(w.find('textarea').element, { key: 'Enter', ctrlKey: true })
    key(w.find('textarea').element, { key: 'Enter', metaKey: true })
    expect(w.emitted('submit')).toHaveLength(2)
  })

  it('does not send an empty or blank message', () => {
    const w = mountComposer({ modelValue: '   \n ' })
    key(w.find('textarea').element, { key: 'Enter' })
    expect(w.emitted('submit')).toBeUndefined()
    expect(w.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('on touch keyboards Enter adds a newline and Ctrl+Enter still sends', () => {
    coarse = true
    const w = mountComposer({ modelValue: 'draft' })
    const enter = key(w.find('textarea').element, { key: 'Enter' })
    expect(enter.defaultPrevented).toBe(false)
    expect(w.emitted('submit')).toBeUndefined()
    key(w.find('textarea').element, { key: 'Enter', ctrlKey: true })
    expect(w.emitted('submit')).toEqual([['draft']])
  })

  it('does not send while the agent is working and offers Stop', async () => {
    const w = mountComposer({ modelValue: 'next question', busy: true })
    key(w.find('textarea').element, { key: 'Enter' })
    expect(w.emitted('submit')).toBeUndefined()
    const stop = w.find('button[aria-label="Stop the agent"]')
    expect(stop.exists()).toBe(true)
    await stop.trigger('click')
    expect(w.emitted('stop')).toHaveLength(1)
  })

  it('sends from the round button', async () => {
    const w = mountComposer({ modelValue: 'compare us with notion' })
    await w.find('form').trigger('submit')
    expect(w.emitted('submit')).toEqual([['compare us with notion']])
  })

  it('edits the last message on ArrowUp in an empty composer', () => {
    const w = mountComposer({ modelValue: '', canEditLast: true })
    const event = key(w.find('textarea').element, { key: 'ArrowUp' })
    expect(event.defaultPrevented).toBe(true)
    expect(w.emitted('edit-last')).toHaveLength(1)
  })

  it('leaves ArrowUp alone when there is text or nothing to edit', () => {
    const typed = mountComposer({ modelValue: 'text', canEditLast: true })
    key(typed.find('textarea').element, { key: 'ArrowUp' })
    expect(typed.emitted('edit-last')).toBeUndefined()
    const none = mountComposer({ modelValue: '', canEditLast: false })
    key(none.find('textarea').element, { key: 'ArrowUp' })
    expect(none.emitted('edit-last')).toBeUndefined()
  })

  it('cannot send when sending is blocked', () => {
    const w = mountComposer({ modelValue: 'hello', blocked: true })
    expect(w.find('textarea').attributes('readonly')).toBeDefined()
    key(w.find('textarea').element, { key: 'Enter' })
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('labels the field and uses the agent starter as placeholder', () => {
    const w = mountComposer({
      agent: 'landing_page',
      catalog: [{ key: 'landing_page', name: 'Landing Page Agent', starter: 'Describe the page to build' }],
    })
    const area = w.find('textarea')
    expect(w.find(`label[for="${area.attributes('id')}"]`).exists()).toBe(true)
    expect(area.attributes('placeholder')).toBe('Describe the page to build')
    expect(w.find('form').classes()).toContain('ag-composer')
  })

  it('emits typed text', async () => {
    const w = mountComposer()
    await w.find('textarea').setValue('typed')
    expect(w.emitted('update:modelValue')).toEqual([['typed']])
  })
})

describe('Composer length limit', () => {
  it('shows no counter for an ordinary message', () => {
    const w = mountComposer({ modelValue: 'research turonote' })
    expect(w.find('.ag-composer-count').exists()).toBe(false)
  })

  it('shows the count as the message nears the limit, and still sends', () => {
    const w = mountComposer({ modelValue: 'a'.repeat(18500) })
    expect(w.find('.ag-composer-count').text()).toBe(`${(18500).toLocaleString()} / ${(20000).toLocaleString()}`)
    expect(w.find(`#${w.find('textarea').attributes('aria-describedby')}`).text()).toContain('characters used')
    key(w.find('textarea').element, { key: 'Enter' })
    expect(w.emitted('submit')).toHaveLength(1)
  })

  it('does not send a message over the limit and says why', () => {
    const w = mountComposer({ modelValue: 'a'.repeat(25000) })
    const count = w.find('.ag-composer-count')
    expect(count.classes()).toContain('is-over')
    expect(count.text()).toContain('Too long')
    expect(w.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(w.find(`#${w.find('textarea').attributes('aria-describedby')}`).text()).toContain('too long to send')
    const event = key(w.find('textarea').element, { key: 'Enter' })
    expect(event.defaultPrevented).toBe(true)
    expect(w.emitted('submit')).toBeUndefined()
    expect(useAgentUiStore().assertiveAnnouncement.text).toContain('too long to send')
  })
})

describe('Composer agent chip', () => {
  it('removes the selected agent', async () => {
    const w = mountComposer({ agent: 'gap_analyst' })
    expect(w.text()).toContain('Gap Analyst')
    await w.find('button[aria-label="Stop using Gap Analyst"]').trigger('click')
    expect(w.emitted('update:agent')).toEqual([[null]])
  })

  it('does not send with a picked writing agent the allowance cannot start, and says why', async () => {
    const why = 'Needs at least $0.32 of AI allowance; $0.20 left this month.'
    const w = mountComposer({
      modelValue: 'build a page for the spring sale',
      agent: 'landing_page',
      agents: [{ key: 'landing_page', name: 'Landing Page Agent', unavailable: why }],
    })
    expect(w.find('.ag-composer-agent-why').text()).toBe(why)
    expect(w.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(w.find(`#${w.find('textarea').attributes('aria-describedby')}`).text()).toContain(why)
    const event = key(w.find('textarea').element, { key: 'Enter' })
    expect(event.defaultPrevented).toBe(true)
    expect(w.emitted('submit')).toBeUndefined()
    expect(useAgentUiStore().assertiveAnnouncement.text).toBe(why)

    // Without the agent the message can go.
    await w.setProps({ agent: null })
    expect(w.find('.ag-composer-agent-why').exists()).toBe(false)
    key(w.find('textarea').element, { key: 'Enter' })
    expect(w.emitted('submit')).toEqual([['build a page for the spring sale']])
  })
})

