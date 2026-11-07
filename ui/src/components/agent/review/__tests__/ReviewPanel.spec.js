import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { CAN_NOTHING, TEAM, inReview, review } from './__fixtures__/review'

const agentApi = vi.hoisted(() => ({ getReview: vi.fn(), team: vi.fn(), reviewAction: vi.fn(), addReviewComment: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: agentApi }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
const fakeAgent = reactive({ setArtifactReview: vi.fn(), loadReviewsWaiting: vi.fn(async () => 0) })
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

const { default: ReviewPanel } = await import('../ReviewPanel.vue')

enableAutoUnmount(afterEach)

const ok = (data) => ({ success: true, data })

async function setup(payload) {
  agentApi.getReview.mockResolvedValue(ok(payload))
  const wrapper = mount(ReviewPanel, { props: { websiteId: 'w1', artifactId: 'a1' } })
  await flushPromises()
  return wrapper
}

const buttons = (wrapper) => wrapper.findAll('.ag-rp-actions button').map((b) => b.text())
const button = (wrapper, text) => wrapper.findAll('button').find((b) => b.text() === text)

beforeEach(() => {
  for (const fn of Object.values(agentApi)) fn.mockReset()
  toast.success.mockReset()
  fakeAgent.setArtifactReview.mockReset()
  fakeAgent.loadReviewsWaiting.mockClear()
  agentApi.team.mockResolvedValue(ok(TEAM))
})

describe('ReviewPanel', () => {
  it('says a draft was never reviewed and offers only what the server allows', async () => {
    const wrapper = await setup(review())
    expect(wrapper.find('.ag-rp-title').text()).toBe('Review')
    expect(wrapper.find('.ag-rp-status').text()).toBe('Not reviewed yet.')
    expect(buttons(wrapper)).toEqual(['Request review'])
    expect(wrapper.find('.ag-rp-foot').text()).toBe("Approving doesn't publish anything. Export the draft to use it.")
  })

  it('asks a teammate, never you, with an optional note', async () => {
    const wrapper = await setup(review({ revision: 2 }))
    agentApi.reviewAction.mockResolvedValue(ok(inReview()))
    await button(wrapper, 'Request review').trigger('click')
    await flushPromises()
    expect(agentApi.team).toHaveBeenCalledWith('w1')
    const options = wrapper.findAll('#ag-rsel-reviewer option').map((o) => o.text().trim())
    expect(options).toEqual(['Ana Lopez · Member', 'Ben Ito · Admin'])
    await wrapper.find('#ag-rsel-reviewer').setValue('u3')
    await wrapper.find('#ag-rsel-note').setValue('Check the table')
    await wrapper.find('.ag-rsel-form').trigger('submit')
    await flushPromises()
    expect(agentApi.reviewAction).toHaveBeenCalledWith('w1', 'a1', { action: 'request', revision: 2, reviewer_id: 'u3', note: 'Check the table' })
    expect(toast.success).toHaveBeenCalledWith('Review requested from Ben Ito.')
    expect(fakeAgent.setArtifactReview).toHaveBeenCalledWith('a1', expect.objectContaining({ state: 'in_review' }))
    expect(fakeAgent.loadReviewsWaiting).toHaveBeenCalled()
  })

  it('says when there is nobody to ask', async () => {
    agentApi.team.mockResolvedValue(ok([TEAM[0]]))
    const wrapper = await setup(review())
    await button(wrapper, 'Request review').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Add a teammate to this project to ask for a review.')
  })

  it('shows who asked whom, and that the draft changed since', async () => {
    const wrapper = await setup(inReview({ updated_since_request: true, latest_version: 3 }))
    expect(wrapper.find('.ag-rp-status').text()).toBe(
      'Site Owner asked Ana Lopez to review version 2 5 min ago. It changed to version 3 since then.'
    )
    expect(buttons(wrapper)).toEqual(['Approve', 'Request changes', 'Withdraw request'])
    const history = wrapper.find('.ag-rtl')
    expect(history.text()).toContain('Site Owner asked Ana Lopez to review version 2.')
    expect(history.text()).toContain('Email sent.')
    expect(history.text()).toContain('Check the pricing table.')
  })

  it('approves, withdraws and reopens with their toasts', async () => {
    const wrapper = await setup(inReview())
    agentApi.reviewAction.mockResolvedValue(ok(inReview({ state: 'approved', effective_state: 'approved', decided_by: { id: 'u2', name: 'Ana Lopez' }, decided_at: new Date().toISOString(), can: { ...CAN_NOTHING, reopen: true, comment: true } })))
    await button(wrapper, 'Approve').trigger('click')
    await flushPromises()
    expect(agentApi.reviewAction).toHaveBeenLastCalledWith('w1', 'a1', { action: 'approve', revision: 3 })
    expect(toast.success).toHaveBeenLastCalledWith('Approved.')
    expect(wrapper.find('.ag-rp-status').text()).toBe('Ana Lopez approved version 2 just now.')
    expect(buttons(wrapper)).toEqual(['Reopen'])

    agentApi.reviewAction.mockResolvedValue(ok(review({ can: { ...CAN_NOTHING, request: true } })))
    await button(wrapper, 'Reopen').trigger('click')
    await flushPromises()
    expect(toast.success).toHaveBeenLastCalledWith('Reopened.')

    const again = await setup(inReview())
    agentApi.reviewAction.mockResolvedValue(ok(review()))
    await button(again, 'Withdraw request').trigger('click')
    await flushPromises()
    expect(agentApi.reviewAction).toHaveBeenLastCalledWith('w1', 'a1', { action: 'withdraw', revision: 3 })
    expect(toast.success).toHaveBeenLastCalledWith('Request withdrawn.')
  })

  it('asks what should change before requesting changes', async () => {
    const wrapper = await setup(inReview())
    await button(wrapper, 'Request changes').trigger('click')
    expect(wrapper.find('#ag-rp-changes-note').attributes('placeholder')).toBe('What should change?')
    await wrapper.find('.ag-rp-changes').trigger('submit')
    expect(wrapper.text()).toContain('Say what should change.')
    expect(agentApi.reviewAction).not.toHaveBeenCalled()
    agentApi.reviewAction.mockResolvedValue(
      ok(inReview({ state: 'changes_requested', effective_state: 'changes_requested', decided_by: { id: 'u2', name: 'Ana Lopez' }, decided_at: new Date().toISOString() }))
    )
    await wrapper.find('#ag-rp-changes-note').setValue('Fix the price')
    await wrapper.find('.ag-rp-changes').trigger('submit')
    await flushPromises()
    expect(agentApi.reviewAction).toHaveBeenCalledWith('w1', 'a1', { action: 'request_changes', revision: 3, note: 'Fix the price' })
    expect(toast.success).toHaveBeenCalledWith('Changes requested.')
    expect(wrapper.find('.ag-rp-status').text()).toBe('Ana Lopez asked for changes just now.')
  })

  it('lets the only member approve a draft and says why', async () => {
    const wrapper = await setup(review({ sole_writer: true, can: { ...CAN_NOTHING, approve: true, comment: true } }))
    expect(wrapper.find('.ag-rp-sole').text()).toBe("You're the only member of this project, so you can approve it yourself.")
    expect(buttons(wrapper)).toEqual(['Approve'])
  })

  it('says a new version has not been reviewed after an approval', async () => {
    const wrapper = await setup(review({ state: 'approved', effective_state: 'draft', version: 2, latest_version: 3 }))
    expect(wrapper.find('.ag-rp-status').text()).toBe("Version 2 was approved. Version 3 hasn't been reviewed.")
  })

  it('reloads with the message when someone else acted first', async () => {
    const wrapper = await setup(inReview())
    agentApi.reviewAction.mockRejectedValue({
      response: { status: 409, data: { error: { code: 'revision_conflict', message: 'Someone else changed this review. Reload to see it.' } } },
    })
    agentApi.getReview.mockResolvedValue(ok(inReview({ state: 'approved', effective_state: 'approved', revision: 9, decided_by: { name: 'Ben Ito' }, decided_at: new Date().toISOString() })))
    await button(wrapper, 'Approve').trigger('click')
    await flushPromises()
    expect(wrapper.find('.ag-rp-error').text()).toBe('Someone else changed this review. Reload to see it.')
    expect(wrapper.find('.ag-rp-status').text()).toBe('Ben Ito approved version 2 just now.')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('adds a comment', async () => {
    const wrapper = await setup(inReview())
    agentApi.addReviewComment.mockResolvedValue(ok({ id: 'ev9', kind: 'comment', actor_name: 'Ana Lopez', body: 'One typo', email: '', created_at: new Date().toISOString() }))
    await wrapper.find('#ag-rp-comment').setValue('One typo')
    await wrapper.find('.ag-rp-comment').trigger('submit')
    await flushPromises()
    expect(agentApi.addReviewComment).toHaveBeenCalledWith('w1', 'a1', { body: 'One typo' })
    expect(toast.success).toHaveBeenCalledWith('Comment added.')
    expect(wrapper.find('.ag-rtl').text()).toContain('One typo')
  })

  it('shows no write control to someone who can only read', async () => {
    const wrapper = await setup(review({ can: CAN_NOTHING }))
    expect(buttons(wrapper)).toEqual([])
    expect(wrapper.find('.ag-rp-comment').exists()).toBe(false)
  })
})
