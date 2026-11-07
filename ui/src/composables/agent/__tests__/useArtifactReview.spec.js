import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { TEAM, inReview, review } from '@/components/agent/review/__tests__/__fixtures__/review'

const agentApi = vi.hoisted(() => ({ getReview: vi.fn(), team: vi.fn(), reviewAction: vi.fn(), addReviewComment: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: agentApi }))

const { useArtifactReview } = await import('../useArtifactReview')

const ok = (data) => ({ success: true, data })
const conflict = (code, message) => ({ response: { status: 409, data: { error: { code, message } } } })

function setup(options = {}) {
  const scope = effectScope()
  const wid = ref('w1')
  const aid = ref('a1')
  const r = scope.run(() => useArtifactReview(wid, aid, options))
  return { r, wid, aid, scope }
}

beforeEach(() => {
  for (const fn of Object.values(agentApi)) fn.mockReset()
})

describe('useArtifactReview', () => {
  it('loads the review and the team that can be asked', async () => {
    agentApi.getReview.mockResolvedValue(ok(review()))
    agentApi.team.mockResolvedValue(ok(TEAM))
    const { r } = setup()
    await r.reload()
    expect(agentApi.getReview).toHaveBeenCalledWith('w1', 'a1')
    expect(r.review.value.state).toBe('draft')
    await r.loadTeam()
    expect(r.team.value).toHaveLength(3)
    expect(r.teamState.value).toBe('ready')
  })

  it('a viewer gets no team and asks nobody', async () => {
    agentApi.team.mockRejectedValue({ response: { status: 403, data: { error: { code: 'permission_denied', message: 'No.' } } } })
    const { r } = setup()
    await r.loadTeam()
    expect(r.team.value).toEqual([])
    expect(r.teamState.value).toBe('error')
  })

  it('sends each action with the revision and reports the new summary', async () => {
    const onChange = vi.fn()
    agentApi.getReview.mockResolvedValue(ok(review({ revision: 4 })))
    agentApi.reviewAction.mockResolvedValue(ok(inReview({ revision: 5 })))
    const { r } = setup({ onChange })
    await r.reload()
    expect(await r.act('request', { reviewer_id: 'u2', note: 'Please check' })).toBe(true)
    expect(agentApi.reviewAction).toHaveBeenCalledWith('w1', 'a1', {
      action: 'request',
      revision: 4,
      reviewer_id: 'u2',
      note: 'Please check',
    })
    expect(r.review.value.revision).toBe(5)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'in_review', effective_state: 'in_review', version: 2, reviewer_name: 'Ana Lopez' })
    )

    agentApi.reviewAction.mockResolvedValue(ok(inReview({ state: 'approved', effective_state: 'approved', revision: 6 })))
    await r.act('approve')
    expect(agentApi.reviewAction).toHaveBeenLastCalledWith('w1', 'a1', { action: 'approve', revision: 5 })
  })

  it('reloads and keeps the message when someone else changed the review', async () => {
    agentApi.getReview.mockResolvedValueOnce(ok(inReview()))
    const { r } = setup()
    await r.reload()
    agentApi.reviewAction.mockRejectedValue(conflict('revision_conflict', 'Someone else changed this review. Reload to see it.'))
    agentApi.getReview.mockResolvedValueOnce(ok(inReview({ state: 'approved', effective_state: 'approved', revision: 7 })))
    expect(await r.act('withdraw')).toBe(false)
    expect(agentApi.getReview).toHaveBeenCalledTimes(2)
    expect(r.review.value.state).toBe('approved')
    expect(r.error.value).toBe('Someone else changed this review. Reload to see it.')

    agentApi.reviewAction.mockRejectedValue(conflict('review_state', 'This draft is approved now. Reload to see the latest.'))
    agentApi.getReview.mockResolvedValueOnce(ok(inReview({ state: 'approved', effective_state: 'approved', revision: 7 })))
    await r.act('approve')
    expect(r.error.value).toBe('This draft is approved now. Reload to see the latest.')
  })

  it('adds a comment to the history', async () => {
    agentApi.getReview.mockResolvedValue(ok(inReview()))
    agentApi.addReviewComment.mockResolvedValue(
      ok({ id: 'ev2', kind: 'comment', actor_name: 'Ana Lopez', body: 'Looks good', email: '', created_at: new Date().toISOString() })
    )
    const { r } = setup()
    await r.reload()
    expect(await r.comment('  Looks good ')).toBe(true)
    expect(agentApi.addReviewComment).toHaveBeenCalledWith('w1', 'a1', { body: 'Looks good' })
    expect(r.review.value.events.map((e) => e.kind)).toEqual(['requested', 'comment'])
    expect(await r.comment('   ')).toBe(false)
  })

  it('drops one draft review when the pane shows another', async () => {
    agentApi.getReview.mockResolvedValue(ok(inReview()))
    const { r, aid } = setup()
    await r.reload()
    aid.value = 'a2'
    await nextTick()
    expect(r.review.value).toBeNull()
  })
})
