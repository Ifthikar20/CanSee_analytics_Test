import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const agentApi = vi.hoisted(() => ({ listReviews: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: agentApi }))
const fakeAgent = reactive({ websiteId: 'w1', reviewsWaiting: null })
vi.mock('@/stores/agent', () => ({ useAgentStore: () => fakeAgent }))

const { default: AgentReviewsPage } = await import('../AgentReviewsPage.vue')

enableAutoUnmount(afterEach)

const Blank = defineComponent({ render: () => h('div') })
const ok = (data) => ({ success: true, data })
const ago = (h_) => new Date(Date.now() - h_ * 3600 * 1000).toISOString()

function summary(overrides = {}) {
  return {
    id: 'a1',
    kind: 'document',
    title: 'Pricing page',
    agent_key: 'page_optimizer',
    latest_version: 3,
    created_at: ago(30),
    updated_at: ago(2),
    created_by_name: 'Site Owner',
    source_chat_id: null,
    review: { state: 'in_review', effective_state: 'in_review', version: 3, reviewer_name: 'Ana Lopez', updated_at: ago(2) },
    ...overrides,
  }
}

async function setup(path = '/projects/w1/agent/reviews') {
  setActivePinia(createPinia())
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:websiteId/agent/reviews', name: 'agent-reviews', component: Blank },
      { path: '/projects/:websiteId/agent/artifacts/:artifactId', name: 'agent-artifact', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AgentReviewsPage, { props: { websiteId: 'w1' }, global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  agentApi.listReviews.mockReset()
  fakeAgent.reviewsWaiting = null
})

describe('AgentReviewsPage', () => {
  it('lists the drafts waiting for you by default', async () => {
    agentApi.listReviews.mockResolvedValue(ok([summary({ review: { ...summary().review, requested_by_name: 'Site Owner' } })]))
    const { wrapper } = await setup()
    expect(wrapper.find('.ag-page-intro').text()).toBe(
      'Drafts waiting for your review, the reviews you asked for, and what was approved.'
    )
    expect(wrapper.findAll('[role="tab"]').map((t) => t.text())).toEqual(['Waiting for you', 'Your requests', 'Approved'])
    expect(agentApi.listReviews).toHaveBeenCalledWith('w1', 'waiting')
    const row = wrapper.find('.ag-rev')
    expect(row.find('a').attributes('href')).toBe('/projects/w1/agent/artifacts/a1')
    expect(row.find('.ag-rev-title').text()).toBe('Pricing page')
    expect(row.find('.ag-rev-meta').text()).toBe('Document · version 3 · Asked by Site Owner')
    expect(row.find('.ag-rchip').text()).toBe('In review')
    expect(row.find('.ag-rev-time').text()).toBe('2 hours ago')
    // The sidebar count follows the list, without a second request.
    expect(fakeAgent.reviewsWaiting).toBe(1)
    expect(agentApi.listReviews).toHaveBeenCalledTimes(1)
  })

  it('switches boxes through the query', async () => {
    agentApi.listReviews.mockResolvedValue(ok([summary()]))
    const { wrapper, router } = await setup('/projects/w1/agent/reviews?box=mine')
    expect(agentApi.listReviews).toHaveBeenLastCalledWith('w1', 'mine')
    expect(wrapper.find('.ag-rev-meta').text()).toBe('Document · version 3 · Reviewer: Ana Lopez')
    const tabs = wrapper.findAll('[role="tab"]')
    await tabs[2].trigger('mousedown')
    await tabs[2].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.box).toBe('approved')
    expect(agentApi.listReviews).toHaveBeenLastCalledWith('w1', 'approved')
  })

  it.each([
    ['waiting', 'Nothing is waiting for your review.'],
    ['mine', "You haven't asked for any reviews."],
    ['approved', 'Nothing was approved in the last 90 days.'],
  ])('says so when the %s box is empty', async (box, copy) => {
    agentApi.listReviews.mockResolvedValue(ok([]))
    const { wrapper } = await setup(`/projects/w1/agent/reviews?box=${box}`)
    expect(wrapper.find('.ag-empty').text()).toContain(copy)
  })

  it('shows a load error with a retry', async () => {
    agentApi.listReviews.mockRejectedValueOnce({ response: { status: 500, data: { error: { message: 'Down.' } } } })
    const { wrapper } = await setup()
    expect(wrapper.text()).toContain("Couldn't load reviews.")
    agentApi.listReviews.mockResolvedValueOnce(ok([summary()]))
    await wrapper.find('.ag-empty button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.ag-rev')).toHaveLength(1)
  })
})
