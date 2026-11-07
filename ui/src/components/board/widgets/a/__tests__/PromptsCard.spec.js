import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const searchGap = vi.hoisted(() => ({ checkGoogle: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))
vi.mock('@/api/searchGap', () => ({ default: searchGap }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { mountOnBoard, reloadOf, resetSources, setSource } = await import('./__fixtures__/board')
const { failureOf, overviewPayload, overviewRow } = await import('./__fixtures__/payloads')
const { default: PromptsCard } = await import('../PromptsCard.vue')

// Add prompts' own behaviour has its spec; here only what the card hands it.
const DialogStub = defineComponent({
  name: 'AddPromptsDialog',
  props: { open: Boolean, websiteId: String, engineCount: { type: Number, default: null } },
  emits: ['update:open', 'added'],
  render() {
    return this.open ? h('div', { class: 'dialog-stub' }) : null
  },
})

const mounted = []

async function render(props = {}) {
  const out = await mountOnBoard(PromptsCard, { props: { size: 'full', ...props }, stubs: { AddPromptsDialog: DialogStub } })
  mounted.push(out.wrapper)
  return out
}

const rows = (wrapper) =>
  wrapper.findAll('.pc-row').map((row) => [row.find('.pc-text').text(), ...row.findAll('.pc-cell').map((c) => c.text())])
const button = (wrapper, label) => wrapper.findAll('button').find((b) => b.text() === label)

beforeEach(() => {
  resetSources()
  searchGap.checkGoogle.mockReset()
  Object.values(toast).forEach((fn) => fn.mockClear())
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('PromptsCard', () => {
  it('lists the biggest gaps in API order: Google, the engines and the gap in words', async () => {
    setSource('overview', { data: overviewPayload() })
    const { wrapper } = await render()
    expect(rows(wrapper)).toEqual([
      ['best note taking app for teams', 'Google #4', 'Named by 1 of 2 engines', 'AI ahead'],
      ['notion alternatives for startups', "Not in Google's top 10", 'Named by 0 of 2 engines', 'Not definite'],
      ['team wiki software', 'Google not checked', 'No AI answers yet', 'Not checked'],
    ])
    // Plain words: no badges or dots on the board.
    expect(wrapper.find('.gap-badge').exists()).toBe(false)
  })

  it('shows six rows at most', async () => {
    const prompts = Array.from({ length: 8 }, (_, i) => overviewRow(`x${i}`, { text: `prompt ${i}` }))
    setSource('overview', { data: overviewPayload({ prompts }) })
    const { wrapper } = await render()
    expect(wrapper.findAll('.pc-row')).toHaveLength(6)
    expect(button(wrapper, 'See all 8 prompts')).toBeTruthy()
  })

  it('opens a prompt, and the full list', async () => {
    setSource('overview', { data: overviewPayload() })
    const { wrapper, board } = await render()
    await wrapper.findAll('.pc-row')[1].trigger('click')
    expect(board.open).toHaveBeenCalledWith('prompts', { prompt: 'p-2' })
    await button(wrapper, 'See all 3 prompts').trigger('click')
    expect(board.open).toHaveBeenLastCalledWith('prompts')
  })

  it('adds prompts with the engine count, then refetches the overview and visibility', async () => {
    setSource('overview', { data: overviewPayload() })
    const { wrapper, board } = await render()
    await button(wrapper, 'Add prompts').trigger('click')
    const dialog = wrapper.findComponent(DialogStub)
    expect(dialog.props('open')).toBe(true)
    expect(dialog.props('engineCount')).toBe(2)
    dialog.vm.$emit('added')
    expect(board.invalidate).toHaveBeenCalledWith('overview')
    expect(board.invalidate).toHaveBeenCalledWith('visibility')
  })

  it('checks Google for the prompts that have no check yet', async () => {
    setSource('overview', { data: overviewPayload() })
    searchGap.checkGoogle.mockResolvedValue({})
    const { wrapper, board } = await render()
    await button(wrapper, 'Check Google for 1').trigger('click')
    await flushPromises()
    expect(searchGap.checkGoogle).toHaveBeenCalledTimes(1)
    expect(searchGap.checkGoogle).toHaveBeenCalledWith('w1', 'p-3')
    expect(toast.success).toHaveBeenCalledWith('Google checks queued for 1 prompt.')
    expect(board.invalidate).toHaveBeenCalledWith('overview')
  })

  it("turns the Overview's alerts into foot lines", async () => {
    const overview = overviewPayload()
    setSource('overview', {
      data: { ...overview, serp_configured: false, engines: overview.engines.map((e) => ({ ...e, configured: false })) },
    })
    const { wrapper } = await render()
    expect(wrapper.find('.bd-foot-text').text()).toBe("Google rank checks aren't available yet. AI engines aren't available yet.")
    // Without Google there is nothing to check.
    expect(wrapper.findAll('button').some((b) => b.text().startsWith('Check Google'))).toBe(false)
  })

  it('starts with the questions buyers ask', async () => {
    setSource('overview', { data: overviewPayload({ prompts: [] }) })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe('Start with the questions your buyers ask.')
    expect(wrapper.find('.wa-state-body').text()).toBe(
      'Add a few. Cansee checks where Google ranks you for each one and asks each AI engine the same question.',
    )
    expect(button(wrapper, 'See all 0 prompts')).toBeUndefined()
    await button(wrapper, 'Add prompts').trigger('click')
    expect(wrapper.findComponent(DialogStub).props('open')).toBe(true)
  })

  it('shows the load failure, and the stale note', async () => {
    setSource('overview', { failure: failureOf(500) })
    const failed = await render()
    expect(failed.wrapper.find('.wa-state-title').text()).toBe("We couldn't load Prompts.")
    await failed.wrapper.find('.wa-state button').trigger('click')
    expect(reloadOf('overview')).toHaveBeenCalled()

    setSource('overview', { data: overviewPayload(), failure: failureOf(502), stale: true })
    const stale = await render()
    expect(stale.wrapper.find('.bd-foot-text').text()).toBe("Couldn't refresh.")
  })
})
