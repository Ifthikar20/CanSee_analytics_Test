import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

// The panel loads on first open; a stand-in keeps the chip spec off the API.
vi.mock('../ReviewPanel.vue', () => ({
  default: defineComponent({
    name: 'ReviewPanel',
    props: ['websiteId', 'artifactId', 'fluid'],
    setup: (props) => () => h('div', { class: 'panel-stub', 'data-artifact': props.artifactId }, 'Review'),
  }),
}))

const { default: ReviewChip } = await import('../ReviewChip.vue')

enableAutoUnmount(afterEach)

describe('ReviewChip', () => {
  it.each([
    [null, 'Draft', 'is-draft'],
    [{ state: 'in_review', effective_state: 'in_review', version: 2 }, 'In review', 'is-in_review'],
    [{ state: 'changes_requested', effective_state: 'changes_requested', version: 2 }, 'Changes requested', 'is-changes_requested'],
    [{ state: 'approved', effective_state: 'approved', version: 4 }, 'Approved v4', 'is-approved'],
    // A newer version never inherits the approval.
    [{ state: 'approved', effective_state: 'draft', version: 3 }, 'Draft', 'is-draft'],
  ])('words %o as %s with its icon', (review, word, cls) => {
    const wrapper = mount(ReviewChip, { props: { review, plain: true } })
    expect(wrapper.text()).toBe(word)
    expect(wrapper.classes()).toContain(cls)
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('opens the review panel from the pane header', async () => {
    const wrapper = mount(ReviewChip, {
      props: { review: { state: 'in_review', effective_state: 'in_review', version: 2 }, websiteId: 'w1', artifactId: 'a1' },
      attachTo: document.body,
    })
    const button = wrapper.find('button.ag-rchip')
    expect(button.attributes('aria-haspopup')).toBe('dialog')
    expect(document.body.querySelector('.panel-stub')).toBeNull()
    await button.trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(document.body.querySelector('.panel-stub')).not.toBeNull())
    expect(document.body.querySelector('.panel-stub').dataset.artifact).toBe('a1')
    wrapper.unmount()
    document.body.innerHTML = ''
  })
})
