import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT, IN_PANEL, SETUP_POINTER } from '@/lib/board/context'
import SetupPointer from '../SetupPointer.vue'
import CardStateA from '../widgets/a/CardState.vue'
import CardStateB from '../widgets/b/CardState.vue'

const TEXT = 'Your first research is still running. Its progress is in Setup at the top of this page.'

function router() {
  return createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
}

function mountWith(component, props = {}, { pointer = null, inPanel = false } = {}) {
  const Host = defineComponent({
    setup() {
      return () => h(component, props)
    },
  })
  const provide = {
    [BOARD_CONTEXT]: { websiteId: ref('w1'), open: vi.fn(), close: vi.fn(), invalidate: vi.fn(), revalidate: vi.fn() },
  }
  if (pointer) provide[SETUP_POINTER] = pointer
  if (inPanel) provide[IN_PANEL] = true
  return mount(Host, { global: { provide, plugins: [router()] } })
}

describe('SetupPointer', () => {
  it('renders nothing outside a board page', () => {
    const wrapper = mountWith(SetupPointer)
    expect(wrapper.find('.bd-setup-pointer').exists()).toBe(false)
  })

  it('renders nothing while the setup panel is hidden', () => {
    const wrapper = mountWith(SetupPointer, {}, { pointer: { text: ref(''), show: vi.fn() } })
    expect(wrapper.find('.bd-setup-pointer').exists()).toBe(false)
  })

  it('says why the card may be empty and takes the user to Setup', async () => {
    const show = vi.fn()
    const text = ref(TEXT)
    const wrapper = mountWith(SetupPointer, {}, { pointer: { text, show } })
    expect(wrapper.find('.bd-setup-pointer span').text()).toBe(TEXT)
    const button = wrapper.find('button')
    expect(button.attributes('type')).toBe('button')
    expect(button.text()).toBe('Show setup')
    await button.trigger('click')
    expect(show).toHaveBeenCalledTimes(1)

    text.value = ''
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bd-setup-pointer').exists()).toBe(false)
  })

  it('stays out of the side panel, where the board is out of reach', () => {
    const wrapper = mountWith(SetupPointer, {}, { pointer: { text: ref(TEXT), show: vi.fn() }, inPanel: true })
    expect(wrapper.find('.bd-setup-pointer').exists()).toBe(false)
  })

  it('shows under an empty or not-available group A card, not under an error or a missing connection', () => {
    const pointer = { text: ref(TEXT), show: vi.fn() }
    for (const kind of ['empty', 'not_available']) {
      const wrapper = mountWith(CardStateA, { title: 'No data yet.', kind }, { pointer })
      expect(wrapper.find('.bd-setup-pointer').text()).toContain(TEXT)
    }
    for (const kind of ['error', 'not_connected', 'disabled']) {
      const wrapper = mountWith(CardStateA, { title: 'Nope.', kind }, { pointer })
      expect(wrapper.find('.bd-setup-pointer').exists()).toBe(false)
    }
  })

  it('shows under an empty group B card only', () => {
    const pointer = { text: ref(TEXT), show: vi.fn() }
    expect(mountWith(CardStateB, { title: 'No answers yet.', kind: 'empty' }, { pointer }).find('.bd-setup-pointer').exists()).toBe(true)
    for (const kind of ['error', 'not_connected', 'disabled']) {
      expect(mountWith(CardStateB, { title: 'Nope.', kind }, { pointer }).find('.bd-setup-pointer').exists()).toBe(false)
    }
  })
})
