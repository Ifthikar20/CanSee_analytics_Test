import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount, RouterLinkStub } from '@vue/test-utils'
import { CircleAlert, CircleSlash, Inbox, PlugZap, Power } from '@lucide/vue'
import VizState from '@/components/charts/VizState.vue'

enableAutoUnmount(afterEach)

const render = (props) => mount(VizState, { props, global: { stubs: { RouterLink: RouterLinkStub } } })

describe('VizState', () => {
  it('shows the title and the body', () => {
    const wrapper = render({ kind: 'empty', title: 'No prompts tracked yet.', body: 'Add the questions your buyers ask.' })
    expect(wrapper.find('.viz-state-title').text()).toBe('No prompts tracked yet.')
    expect(wrapper.find('.viz-state-body').text()).toBe('Add the questions your buyers ask.')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('picks an icon per kind', () => {
    const cases = [
      ['empty', Inbox],
      ['not_connected', PlugZap],
      ['not_available', CircleSlash],
      ['error', CircleAlert],
      ['disabled', Power],
    ]
    for (const [kind, icon] of cases) {
      expect(render({ kind, title: 'T' }).findComponent(icon).exists()).toBe(true)
    }
  })

  it('links an action with a destination', () => {
    const wrapper = render({ kind: 'not_connected', title: 'No traffic source is connected.', action: { label: 'Connect a source', to: { name: 'settings-connections' } } })
    const link = wrapper.findComponent(RouterLinkStub)
    expect(link.text()).toBe('Connect a source')
    expect(link.props('to')).toEqual({ name: 'settings-connections' })
  })

  it('emits action from a button without a destination', async () => {
    const wrapper = render({ kind: 'error', title: "We couldn't load visibility.", action: { label: 'Try again' } })
    const button = wrapper.find('button')
    expect(button.text()).toBe('Try again')
    await button.trigger('click')
    expect(wrapper.emitted('action')).toHaveLength(1)
  })

  it('has a compact form', () => {
    expect(render({ title: 'T', compact: true }).classes()).toContain('is-compact')
  })
})
