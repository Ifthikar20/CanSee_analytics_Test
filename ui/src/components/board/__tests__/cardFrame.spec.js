// What the cards' shared shells tell the board's frame (the chip in a
// card's corner), and the pieces a card is built from.
import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT, CARD_STATUS, useCardStatus } from '@/lib/board/context'
import { PREVIEW_KINDS, previewShapes } from '@/lib/board/previews'
import BlockPreview from '../BlockPreview.vue'
import CardFoot from '../CardFoot.vue'
import ComingUp from '../ComingUp.vue'
import CardShell from '../widgets/a/CardShell.vue'
import CardFrame from '../widgets/b/CardFrame.vue'

enableAutoUnmount(afterEach)

const board = { websiteId: ref('w1'), open() {}, close() {}, invalidate() {}, revalidate() {} }

async function mountFramed(component, props = {}, slots = {}) {
  const reported = []
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
  await router.push('/')
  const wrapper = mount(component, {
    props,
    slots,
    global: { plugins: [router], provide: { [BOARD_CONTEXT]: board, [CARD_STATUS]: (status) => reported.push(status) } },
  })
  return { wrapper, reported, last: () => reported.at(-1) }
}

describe('useCardStatus', () => {
  const Card = (status) =>
    defineComponent({
      setup() {
        useCardStatus(status)
        return () => h('p', 'card')
      },
    })

  it('reports a value, a ref and a getter, and follows a change', async () => {
    const status = ref('loading')
    const reported = []
    const wrapper = mount(Card(status), { global: { provide: { [CARD_STATUS]: (s) => reported.push(s) } } })
    expect(reported).toEqual(['loading'])
    status.value = 'live'
    await nextTick()
    expect(reported).toEqual(['loading', 'live'])
    wrapper.unmount()
    // Withdrawn with the card, so a frame never keeps a stale "live".
    expect(reported).toEqual(['loading', 'live', null])

    const fixed = []
    mount(Card('ready'), { global: { provide: { [CARD_STATUS]: (s) => fixed.push(s) } } })
    expect(fixed).toEqual(['ready'])
    const got = []
    mount(Card(() => 'empty'), { global: { provide: { [CARD_STATUS]: (s) => got.push(s) } } })
    expect(got).toEqual(['empty'])
  })

  it('reports nothing as null, and does nothing outside a board card', () => {
    const reported = []
    mount(Card(() => ''), { global: { provide: { [CARD_STATUS]: (s) => reported.push(s) } } })
    expect(reported).toEqual([null])
    // No frame around it (a panel, a page): no error.
    expect(() => mount(Card('live'))).not.toThrow()
    // Something that is not a reporter is ignored.
    expect(() => mount(Card('live'), { global: { provide: { [CARD_STATUS]: 'nope' } } })).not.toThrow()
  })
})

describe("group A's card shell", () => {
  const render = (props) => mountFramed(CardShell, { widget: 'traffic', ...props }, { default: '<p class="numbers">1,240</p>' })

  it('is loading, then live with numbers, stale after a failed refresh', async () => {
    const { wrapper, last } = await render({ phase: 'loading' })
    expect(last()).toBe('loading')
    await wrapper.setProps({ phase: 'ready' })
    expect(wrapper.find('.numbers').exists()).toBe(true)
    expect(last()).toBe('live')
    await wrapper.setProps({ stale: true })
    expect(last()).toBe('stale')
  })

  it('never calls an empty state live', async () => {
    const { wrapper, last } = await render({ phase: 'ready', empty: { title: 'No visits yet.' } })
    expect(wrapper.find('.numbers').exists()).toBe(false)
    expect(last()).toBe('empty')
    await wrapper.setProps({ empty: { kind: 'not_connected', title: 'Connect a source.' } })
    expect(last()).toBe('setup')
    await wrapper.setProps({ empty: { kind: 'not_available', title: 'Not available yet.' } })
    expect(last()).toBe('setup')
    await wrapper.setProps({ empty: { kind: 'error', title: 'Broken.' } })
    expect(last()).toBe('error')
    // An empty card whose refresh failed is still empty, not stale numbers.
    await wrapper.setProps({ empty: { title: 'No visits yet.' }, stale: true })
    expect(last()).toBe('empty')
  })

  it('reads a failed load as an error, and Insights turned off as setup', async () => {
    const { wrapper, last } = await render({ phase: 'failed', failure: { status: 500, code: 'error', message: 'x' } })
    expect(last()).toBe('error')
    await wrapper.setProps({ failure: { status: 503, code: 'insights_disabled', message: '' } })
    expect(wrapper.text()).toContain('Insights are turned off')
    expect(last()).toBe('setup')
  })
})

describe("group B's card frame", () => {
  const render = (props) => mountFramed(CardFrame, { widget: 'sentiment', ...props }, { default: '<p class="numbers">52</p>' })

  it('is loading until the source answers, then live, then stale', async () => {
    const { wrapper, last } = await render({})
    expect(last()).toBe('loading')
    await wrapper.setProps({ data: { answers: 52 } })
    expect(wrapper.find('.numbers').exists()).toBe(true)
    expect(last()).toBe('live')
    await wrapper.setProps({ stale: true, error: 'x', failure: { status: 500, code: 'error' } })
    expect(last()).toBe('stale')
  })

  it('never calls an empty state live', async () => {
    const { wrapper, last } = await render({ data: {}, empty: { title: 'No AI answers in the last 30 days.' } })
    expect(wrapper.find('.numbers').exists()).toBe(false)
    expect(last()).toBe('empty')
    await wrapper.setProps({ empty: { kind: 'not_connected', title: 'No AI engine is connected yet.' } })
    expect(last()).toBe('setup')
  })

  it('reads a failed load as an error, and Insights turned off as setup', async () => {
    const { wrapper, last } = await render({ error: 'x', failure: { status: 500, code: 'error' } })
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(last()).toBe('error')
    await wrapper.setProps({ failure: { status: 503, code: 'insights_disabled' } })
    expect(last()).toBe('setup')
  })
})

describe('ComingUp and the cards that wait for their blocks', () => {
  it('says what the block will show, with no figure, and reports no data', async () => {
    const { wrapper, reported } = await mountFramed(ComingUp, { text: 'The brands AI names in recent answers.' })
    expect(wrapper.find('.bd-soon-label').text()).toBe('Coming up')
    expect(wrapper.find('.bd-soon-text').text()).toBe('The brands AI names in recent answers.')
    expect(wrapper.text()).not.toMatch(/\d/)
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(reported).toEqual(['empty'])
  })

  it('leaves the sentence out when there is none', async () => {
    const { wrapper } = await mountFramed(ComingUp)
    expect(wrapper.find('.bd-soon-text').exists()).toBe(false)
    expect(wrapper.find('.bd-soon-label').exists()).toBe(true)
  })
})

describe('CardFoot', () => {
  it('shows the source line and, when given, a link on the right', () => {
    const plain = mount(CardFoot, { slots: { default: 'Last 30 days.' } })
    expect(plain.find('footer .bd-foot-text').text()).toBe('Last 30 days.')
    expect(plain.find('.bd-foot-link').exists()).toBe(false)
    const linked = mount(CardFoot, { slots: { default: 'Last 7 days.', link: '<a href="/x">All prompts</a>' } })
    expect(linked.find('.bd-foot-link a').text()).toBe('All prompts')
  })
})

describe('BlockPreview', () => {
  it('draws every shape of its kind, hidden from screen readers', () => {
    for (const kind of PREVIEW_KINDS) {
      const wrapper = mount(BlockPreview, { props: { kind } })
      const svg = wrapper.find('svg')
      expect(svg.attributes('viewBox'), kind).toBe('0 0 160 100')
      expect(svg.attributes('aria-hidden'), kind).toBe('true')
      expect(svg.attributes('data-preview'), kind).toBe(kind)
      expect(svg.element.children.length, kind).toBe(previewShapes(kind).length)
      // The accent once, as a class the stylesheet paints from a token.
      expect(wrapper.findAll('.is-you'), kind).toHaveLength(1)
      expect(wrapper.html(), kind).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|fill="/i)
      wrapper.unmount()
    }
  })

  it('draws rects, lines, outlines, dots and text as their own elements', () => {
    const tags = (kind) => [...mount(BlockPreview, { props: { kind } }).find('svg').element.children].map((el) => el.tagName)
    expect(tags('eye')).toEqual(['path', 'path', 'circle', 'circle'])
    expect(tags('numeral')).toEqual(['text', 'text', 'polyline', 'circle'])
    const numeral = mount(BlockPreview, { props: { kind: 'numeral' } })
    expect(numeral.findAll('text').map((t) => t.text())).toEqual(['74', '/ 100'])
    expect(numeral.find('polyline').classes()).toContain('is-stroke')
  })

  it('draws an empty box for a kind it does not know', () => {
    for (const kind of ['', 'nope']) {
      const wrapper = mount(BlockPreview, { props: { kind } })
      expect(wrapper.find('svg').element.children.length).toBe(0)
    }
    expect(mount(BlockPreview).find('svg').exists()).toBe(true)
  })
})
