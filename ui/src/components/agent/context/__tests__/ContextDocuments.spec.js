import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import ContextDocuments from '../ContextDocuments.vue'

enableAutoUnmount(afterEach)

describe('ContextDocuments', () => {
  it('lists documents with their size and citations, editable for members', async () => {
    const docs = [
      { id: 'd1', title: 'Positioning notes', chars: 5200, cited_by: 2 },
      { id: 'd2', title: 'Style guide', chars: 1, cited_by: 1 },
      { id: 'd3', title: 'Product sheet', chars: 800, cited_by: 0 },
    ]
    const wrapper = mount(ContextDocuments, { props: { documents: docs, canEdit: true } })
    expect(wrapper.find('h2').text()).toBe('Documents')
    const rows = wrapper.findAll('.ag-cd-row')
    expect(rows.map((r) => r.find('.ag-cd-meta').text())).toEqual([
      '5,200 characters · Cited by 2 entries',
      '1 character · Cited by 1 entry',
      '800 characters · Not cited yet',
    ])
    await rows[0].findAll('button').find((b) => b.text() === 'Edit').trigger('click')
    await rows[2].findAll('button').find((b) => b.text() === 'Delete').trigger('click')
    expect(wrapper.emitted('edit')[0][0].id).toBe('d1')
    expect(wrapper.emitted('delete')[0][0].id).toBe('d3')
  })

  it('says when there are none and hides edits from viewers', () => {
    const empty = mount(ContextDocuments, { props: { documents: [], canEdit: true } })
    expect(empty.text()).toContain('No documents yet.')
    const viewer = mount(ContextDocuments, { props: { documents: [{ id: 'd1', title: 'Notes', chars: 10, cited_by: 0 }], canEdit: false } })
    expect(viewer.find('button').exists()).toBe(false)
  })
})
