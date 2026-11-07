import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const searchGap = vi.hoisted(() => ({ checkGoogle: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))
vi.mock('@/api/searchGap', () => ({ default: searchGap }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { mountOnBoard, resetSources, setSource } = await import('./__fixtures__/board')
const { overviewPayload, visibilityPayload } = await import('./__fixtures__/payloads')
const { default: PromptsPanel } = await import('../PromptsPanel.vue')

const DialogStub = defineComponent({
  name: 'AddPromptsDialog',
  props: { open: Boolean, websiteId: String, engineCount: { type: Number, default: null } },
  emits: ['update:open', 'added'],
  render() {
    return this.open ? h('div', { class: 'dialog-stub' }) : null
  },
})
const PromptPageStub = defineComponent({
  name: 'PromptPage',
  props: { websiteId: String, promptId: String },
  render: () => h('div', { class: 'prompt-page-stub' }),
})

const mounted = []

async function render(path = '/projects/w1/analytics?widget=prompts') {
  const out = await mountOnBoard(PromptsPanel, { path, stubs: { AddPromptsDialog: DialogStub, PromptPage: PromptPageStub } })
  mounted.push(out.wrapper)
  return out
}

beforeEach(() => {
  resetSources()
  setSource('overview', { data: overviewPayload() })
  setSource('visibility', { data: visibilityPayload() })
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('PromptsPanel', () => {
  it('lists every prompt in the gap table, with Add prompts and Check Google', async () => {
    const { wrapper } = await render()
    expect(wrapper.find('.ppn-count').text()).toBe('3 prompts tracked.')
    expect(wrapper.findAll('.gt-row')).toHaveLength(3)
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(expect.arrayContaining(['Add prompts', 'Check Google for 1']))
    // "Newest" follows the order the visibility source lists them in.
    expect(wrapper.findComponent({ name: 'GapTable' }).props('order')).toEqual(['p-3', 'p-1', 'p-2'])
    expect(wrapper.find('.prompt-page-stub').exists()).toBe(false)
  })

  it('keeps the table calm: classes in words, no coloured dots', async () => {
    const { wrapper } = await render()
    expect(wrapper.findAll('.gt-chip').map((c) => c.text().replace(/\s+/g, ' '))).toEqual([
      'All 3',
      'AI ahead 1',
      'Not definite 1',
      'Not checked 1',
    ])
    expect(wrapper.findAll('.gt-table thead th').map((th) => th.text())).toEqual(['Prompt', 'Google', 'ChatGPT', 'Claude', 'Gemini', 'Gap', 'Top fix'])
    expect(wrapper.find('[class*="-dot"]').exists()).toBe(false)
    expect(wrapper.find('.gap-badge').attributes('style')).toBeUndefined()
    expect(wrapper.find('.gt-row .gap-badge').text()).toBe('AI ahead +70')
  })

  it('opens a prompt through the board', async () => {
    const { wrapper, board } = await render()
    await wrapper.findAll('.gt-row')[0].trigger('click')
    expect(board.open).toHaveBeenCalledWith('prompts', { prompt: 'p-1' })
  })

  it('shows the prompt named in the query', async () => {
    const { wrapper } = await render('/projects/w1/analytics?widget=prompts&prompt=p-2')
    const page = wrapper.findComponent(PromptPageStub)
    expect(page.props()).toEqual({ websiteId: 'w1', promptId: 'p-2' })
    expect(wrapper.find('.gt-row').exists()).toBe(false)
  })

  it('opens Add prompts once for ?add=1 and takes it out of the URL', async () => {
    const { wrapper, router, board } = await render('/projects/w1/analytics?widget=prompts&add=1')
    await flushPromises()
    expect(wrapper.findComponent(DialogStub).props('open')).toBe(true)
    expect(wrapper.findComponent(DialogStub).props('engineCount')).toBe(2)
    expect(router.currentRoute.value.query).toEqual({ widget: 'prompts' })
    wrapper.findComponent(DialogStub).vm.$emit('added')
    expect(board.invalidate).toHaveBeenCalledWith('overview')
    expect(board.invalidate).toHaveBeenCalledWith('visibility')
  })

  it('starts with the questions buyers ask', async () => {
    setSource('overview', { data: overviewPayload({ prompts: [] }) })
    const { wrapper } = await render()
    expect(wrapper.find('.wa-state-title').text()).toBe('Start with the questions your buyers ask.')
    await wrapper.find('.wa-state button').trigger('click')
    expect(wrapper.findComponent(DialogStub).props('open')).toBe(true)
  })
})
