import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import Composer from '@/components/agent/composer/Composer.vue'
import PlusMenu from '@/components/agent/composer/PlusMenu.vue'
import SendStopButton from '@/components/agent/composer/SendStopButton.vue'
import TemplateChip from '@/components/agent/composer/TemplateChip.vue'
import { fallbackTemplates, normalizeTemplate } from '@/lib/agent/reportTemplates'
import { useAgentUiStore } from '@/stores/agentUi'

enableAutoUnmount(afterEach)

const Passthrough = defineComponent({
  inheritAttrs: false,
  setup(_, { slots }) {
    return () => slots.default?.()
  },
})

const PlusStub = defineComponent({
  name: 'PlusMenu',
  props: ['agents', 'agent', 'templates', 'template', 'disabled'],
  emits: ['select-agent', 'select-template', 'open-page'],
  setup: () => () => null,
})

const UNAVAILABLE = normalizeTemplate({
  id: 'brand_accuracy',
  name: 'Brand accuracy',
  available: false,
  unavailable: { code: 'insights_off', message: "Brand accuracy needs the Sentiment and Fact check analysis, which isn't turned on for this workspace." },
})

function templates(extra = []) {
  return [...fallbackTemplates().filter((t) => t.id !== 'brand_accuracy'), ...extra]
}

function mountComposer(props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(Composer, {
    props: { modelValue: '', agents: [], templates: templates(), ...props },
    attachTo: document.body,
    global: { plugins: [pinia], stubs: { PlusMenu: PlusStub, DictationButton: true, AgTooltip: Passthrough } },
  })
}

beforeEach(() => {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })
})

describe('TemplateChip', () => {
  it('names the template and removes it with a labelled button', async () => {
    const wrapper = mount(TemplateChip, { props: { template: 'change_log', templates: fallbackTemplates() } })
    expect(wrapper.text()).toBe('Template: Change log since the last run')
    const remove = wrapper.find('button')
    expect(remove.attributes('aria-label')).toBe('Stop using the Change log since the last run template')
    await remove.trigger('click')
    expect(wrapper.emitted('remove')).toHaveLength(1)
  })

  it('names it from the local copy before the catalog loads', () => {
    const wrapper = mount(TemplateChip, { props: { template: 'executive_summary', templates: null } })
    expect(wrapper.text()).toBe('Template: Executive summary')
    const fixed = mount(TemplateChip, { props: { template: 'executive_summary', removable: false } })
    expect(fixed.find('button').exists()).toBe(false)
  })
})

describe('Composer: report template for the next reply', () => {
  it('shows the template chip and removes it, announcing and refocusing', async () => {
    const wrapper = mountComposer({ modelValue: 'Write it', template: 'executive_summary' })
    const ui = useAgentUiStore()
    const announce = vi.spyOn(ui, 'announce')
    expect(wrapper.find('.ag-template-chip').text()).toBe('Template: Executive summary')
    expect(wrapper.find('form').classes()).toContain('has-agent')
    await wrapper.find('.ag-template-chip button').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:template')).toEqual([[null]])
    expect(announce).toHaveBeenCalledWith('Report template removed.')
    expect(document.activeElement).toBe(wrapper.find('textarea').element)
  })

  it('shows both chips when an agent and a template are picked', () => {
    const wrapper = mountComposer({ agent: 'gap_analyst', template: 'google_ai_gap' })
    expect(wrapper.findAll('.ag-agent-chip')).toHaveLength(2)
    expect(wrapper.text()).toContain('Template: Google vs AI gap')
  })

  it('shows no chip without a template', () => {
    const wrapper = mountComposer()
    expect(wrapper.find('.ag-template-chip').exists()).toBe(false)
    expect(wrapper.find('.ag-composer-agent').exists()).toBe(false)
  })

  it('passes the templates to the + menu and applies the one picked there', async () => {
    const wrapper = mountComposer()
    const ui = useAgentUiStore()
    const announce = vi.spyOn(ui, 'announce')
    const plus = wrapper.findComponent(PlusStub)
    expect(plus.props('templates').map((t) => t.id)).toContain('change_log')
    expect(plus.props('template')).toBe('')
    plus.vm.$emit('select-template', 'change_log')
    await flushPromises()
    expect(wrapper.emitted('update:template')).toEqual([['change_log']])
    expect(announce).toHaveBeenCalledWith('The next reply follows the Change log since the last run template.')
    await wrapper.setProps({ template: 'change_log' })
    expect(wrapper.findComponent(PlusStub).props('template')).toBe('change_log')
  })

  it('submits with a runnable template', async () => {
    const wrapper = mountComposer({ modelValue: 'Write it', template: 'executive_summary' })
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([['Write it']])
  })

  it('holds Send for a template the workspace cannot run, says why and announces it', async () => {
    const wrapper = mountComposer({ modelValue: 'Write it', template: 'brand_accuracy', templates: templates([UNAVAILABLE]) })
    const ui = useAgentUiStore()
    const announce = vi.spyOn(ui, 'announce')
    const why = "Brand accuracy needs the Sentiment and Fact check analysis, which isn't turned on for this workspace."
    expect(wrapper.find('.ag-composer-agent-why').text()).toBe(why)
    expect(wrapper.findComponent(SendStopButton).props('disabled')).toBe(true)
    // The screen reader hint carries the reason too.
    expect(wrapper.find(`#${wrapper.find('textarea').attributes('aria-describedby')}`).text()).toContain(why)
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(announce).toHaveBeenCalledWith(why, 'assertive')
    // Removing the template lets it send.
    await wrapper.setProps({ template: null })
    expect(wrapper.findComponent(SendStopButton).props('disabled')).toBe(false)
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([['Write it']])
  })

  it('sends a template from the local copy (availability unknown) and lets the server decide', async () => {
    const wrapper = mountComposer({ modelValue: 'Go', template: 'brand_accuracy', templates: [] })
    expect(wrapper.find('.ag-composer-agent-why').exists()).toBe(false)
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([['Go']])
  })
})

describe('PlusMenu: report templates', () => {
  it('lists the templates under their own submenu, with the reason a template cannot run', async () => {
    const wrapper = mount(PlusMenu, {
      props: { agents: [], templates: templates([UNAVAILABLE]), template: 'change_log' },
      attachTo: document.body,
    })
    const trigger = wrapper.find('button')
    expect(trigger.attributes('aria-label')).toBe('Add an agent, a report template or a page')
    trigger.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const menuText = document.body.textContent
    expect(menuText).toContain('Use a report template')
    expect(menuText).toContain('Use an agent')

    const sub = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Use a report template'))
    sub.focus()
    sub.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    const items = [...document.body.querySelectorAll('[role="menuitem"]')]
    const byName = (name) => items.find((el) => el.textContent.trim().startsWith(name))
    const blocked = byName('Brand accuracy')
    expect(blocked.textContent).toContain("isn't turned on for this workspace.")
    expect(blocked.hasAttribute('data-disabled')).toBe(true)
    // The picked one carries a check mark.
    expect(byName('Change log since the last run').querySelectorAll('svg')).toHaveLength(2)
    expect(byName('Executive summary').querySelectorAll('svg')).toHaveLength(1)
    byName('Executive summary').click()
    await flushPromises()
    expect(wrapper.emitted('select-template')).toEqual([['executive_summary']])
  })

  it('has no template submenu without templates', async () => {
    const wrapper = mount(PlusMenu, { props: { agents: [], templates: [] }, attachTo: document.body })
    const trigger = wrapper.find('button')
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(document.body.textContent).toContain('Use an agent')
    expect(document.body.textContent).not.toContain('Use a report template')
  })
})

