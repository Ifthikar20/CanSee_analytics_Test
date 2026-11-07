import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ArtifactCard from '@/components/agent/message/ArtifactCard.vue'

const base = { artifactId: 'a1', title: 'Spring landing page', kind: 'page', projectName: 'Wrenfield', live: true }

describe('ArtifactCard', () => {
  it('shows the planning line while the sub-agent plans, then drafting', async () => {
    const wrapper = mount(ArtifactCard, { props: { ...base, status: 'planning', progress: '  Outlining the hero  ' } })
    expect(wrapper.find('.ag-card-sub').text()).toBe('Outlining the hero')
    await wrapper.setProps({ status: 'drafting' })
    expect(wrapper.find('.ag-card-sub').text()).toBe('Drafting…')
    await wrapper.setProps({ status: 'planning', progress: '' })
    expect(wrapper.find('.ag-card-sub').text()).toBe('Drafting…')
  })

  it('names no kind before the call names its agent', async () => {
    const wrapper = mount(ArtifactCard, { props: { status: 'preparing', live: true } })
    expect(wrapper.find('.ag-card-title').text()).toBe('Preparing an agent')
    expect(wrapper.find('.ag-card-sub').text()).toBe('Writing the brief…')
    expect(wrapper.text()).not.toContain('Landing page')
    expect(wrapper.find('button').exists()).toBe(false)
    await wrapper.setProps({ status: 'error', live: false, error: 'Not run: the request moved to a fallback model.' })
    expect(wrapper.find('.ag-card-title').text()).toBe('Agent not started')
    expect(wrapper.find('.ag-card-sub').text()).toBe('Not finished: Not run: the request moved to a fallback model.')
  })

  it('reads a stopped call as not finished and offers Open only when something was saved', async () => {
    const wrapper = mount(ArtifactCard, { props: { ...base, status: 'cancelled', live: false } })
    expect(wrapper.find('.ag-card').classes()).toContain('is-error')
    expect(wrapper.find('.ag-card-sub').text()).toBe('Not finished: Stopped')
    // No version and nothing saved before the call: there is nothing to open.
    expect(wrapper.find('.ag-card-open').exists()).toBe(false)
    await wrapper.setProps({ status: 'error', error: 'Not finished' })
    expect(wrapper.find('.ag-card-open').exists()).toBe(false)
    // A failed revision leaves the version saved before it, which still opens.
    await wrapper.setProps({ baseVersion: 2 })
    expect(wrapper.find('.ag-card-open').exists()).toBe(true)
    await wrapper.setProps({ baseVersion: null, status: 'cancelled', error: null, version: 3 })
    expect(wrapper.find('.ag-card-open').exists()).toBe(true)
    expect(wrapper.find('.ag-card-sub').text()).toBe('Not finished: Stopped')
  })

  it('names the project once done and reads string errors', async () => {
    const wrapper = mount(ArtifactCard, { props: { ...base, status: 'done', live: false, version: 2 } })
    expect(wrapper.find('.ag-card-sub').text()).toBe('Wrenfield website · v2')
    await wrapper.setProps({ status: 'error', error: 'Stopped' })
    expect(wrapper.find('.ag-card-sub').text()).toBe('Not finished: Stopped')
  })
})
