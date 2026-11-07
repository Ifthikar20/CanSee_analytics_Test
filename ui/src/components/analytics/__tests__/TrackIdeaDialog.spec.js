import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { promptIdeasPayload } from '@/pages/analytics/__tests__/__fixtures__/measurementPayloads'
import { apiError } from '@/pages/analytics/__tests__/__fixtures__/measurementPayloads'

const insights = vi.hoisted(() => ({ trackIdea: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/api/insights', () => ({ default: insights }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: TrackIdeaDialog } = await import('../TrackIdeaDialog.vue')

const mounted = []
const body = () => new DOMWrapper(document.body)
const button = (text) => body().findAll('button').find((b) => b.text() === text)

function mountDialog({ track = promptIdeasPayload().track } = {}) {
  const idea = promptIdeasPayload().ideas[0]
  const wrapper = mount(TrackIdeaDialog, {
    props: { websiteId: 'w1', idea, track, open: true, 'onUpdate:open': (v) => wrapper.setProps({ open: v }) },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {
  insights.trackIdea.mockReset()
  for (const fn of Object.values(toast)) fn.mockReset()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('TrackIdeaDialog', () => {
  it('states what tracking does and what it can cost', async () => {
    mountDialog()
    await flushPromises()
    expect(body().text()).toContain('Track this prompt?')
    expect(body().text()).toContain(
      'Cansee adds "is notion free for teams" to your tracked prompts and asks ChatGPT and Claude now: up to $0.04 of your AI allowance ($4.08 left this month).',
    )
    expect(button('Cancel')).toBeTruthy()
  })

  it('leaves the allowance out when it is unlimited', async () => {
    const track = { ...promptIdeasPayload().track, allowance: { unlimited: true } }
    mountDialog({ track })
    await flushPromises()
    expect(body().text()).toContain('now: up to $0.04 of your AI allowance.')
    expect(body().text()).not.toContain('left this month')
  })

  it('sends the amount shown as the confirm and closes on success', async () => {
    insights.trackIdea.mockResolvedValue({ data: { idea: { id: 'e5' }, prompt_id: 'p9', scan_audit_id: 'a9' } })
    const wrapper = mountDialog()
    await flushPromises()
    await button('Track and check').trigger('click')
    await flushPromises()
    expect(insights.trackIdea).toHaveBeenCalledWith('w1', 'e5', { confirm: { ai_usd_max: '0.0400' } })
    expect(toast.success).toHaveBeenCalledWith('Tracking "is notion free for teams". The AI engines are being asked now.')
    expect(wrapper.emitted('tracked')[0][0]).toMatchObject({ prompt_id: 'p9' })
    expect(wrapper.props('open')).toBe(false)
  })

  it('shows the new amount when the cost changed and waits for a second confirm', async () => {
    const newer = { ...promptIdeasPayload().track, usd_max_per_prompt: '0.1600' }
    insights.trackIdea.mockRejectedValueOnce(apiError(409, 'estimate_changed', 'The cost changed.', { track: newer }))
    const wrapper = mountDialog()
    await flushPromises()
    await button('Track and check').trigger('click')
    await flushPromises()
    expect(body().text()).toContain('up to $0.16 of your AI allowance')
    expect(body().text()).toContain('The cost changed. Check the new amount and confirm again.')
    expect(wrapper.emitted('tracked')).toBeUndefined()

    insights.trackIdea.mockResolvedValue({ data: { idea: { id: 'e5' }, prompt_id: 'p9' } })
    await button('Track and check').trigger('click')
    await flushPromises()
    expect(insights.trackIdea).toHaveBeenLastCalledWith('w1', 'e5', { confirm: { ai_usd_max: '0.1600' } })
  })

  it('shows any other error in the dialog', async () => {
    insights.trackIdea.mockRejectedValue(apiError(409, 'already_tracked', 'This idea is already a tracked prompt.'))
    const wrapper = mountDialog()
    await flushPromises()
    await button('Track and check').trigger('click')
    await flushPromises()
    expect(body().find('[role="alert"]').text()).toBe('This idea is already a tracked prompt.')
    expect(wrapper.props('open')).toBe(true)
  })
})
