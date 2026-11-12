import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { BOARD_CONTEXT } from '@/lib/board/context'
import CardReading from '../CardReading.vue'
import CardShell from '../widgets/a/CardShell.vue'
import CardFrame from '../widgets/b/CardFrame.vue'
import BlockFrame from '../widgets/d/BlockFrame.vue'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/reports', name: 'reports', component: { template: '<div />' } },
      { path: '/dashboard', name: 'dashboard', component: { template: '<div />' } },
      { path: '/analytics/:websiteId', name: 'analytics', component: { template: '<div />' } },
    ],
  })
}

function board() {
  return { websiteId: { value: 'w1' }, open: vi.fn(), close: vi.fn(), invalidate: vi.fn(), revalidate: vi.fn() }
}

async function mountReading(reading, ctx = board()) {
  const router = makeRouter()
  router.push('/')
  await router.isReady()
  const wrapper = mount(CardReading, {
    props: { reading },
    global: { plugins: [router], provide: { [BOARD_CONTEXT]: ctx } },
  })
  return { wrapper, ctx }
}

describe('CardReading', () => {
  it('shows the sentence alone when there is no next step', async () => {
    const { wrapper } = await mountReading({ line: 'AI names you in 38% of answers.' })
    expect(wrapper.find('.bd-reading-line').text()).toBe('AI names you in 38% of answers.')
    expect(wrapper.find('[data-testid="card-reading-next"]').exists()).toBe(false)
  })

  it('renders nothing without a sentence', async () => {
    for (const reading of [null, {}, { line: '' }, { line: 'Up NaN points.' }]) {
      const { wrapper } = await mountReading(reading)
      expect(wrapper.find('[data-testid="card-reading"]').exists()).toBe(false)
      expect(wrapper.text()).toBe('')
    }
  })

  it('opens the named block with its query from the next step', async () => {
    const { wrapper, ctx } = await mountReading({
      line: 'You are missing from 6 prompts.',
      next: { label: 'Open those prompts', widget: 'prompts', query: { filter: 'missing' } },
    })
    const next = wrapper.find('[data-testid="card-reading-next"]')
    expect(next.element.tagName).toBe('BUTTON')
    expect(next.attributes('type')).toBe('button')
    expect(next.find('.bd-reading-label').text()).toBe('Open those prompts')
    await next.trigger('click')
    expect(ctx.open).toHaveBeenCalledTimes(1)
    expect(ctx.open).toHaveBeenCalledWith('prompts', { filter: 'missing' })
  })

  it('links to a page when the next step is a route, and opens no panel', async () => {
    const { wrapper, ctx } = await mountReading({ line: 'Nothing saved yet.', next: { label: 'Make a report', to: { name: 'reports' } } })
    const next = wrapper.find('[data-testid="card-reading-next"]')
    expect(next.element.tagName).toBe('A')
    expect(next.attributes('href')).toBe('/reports')
    await next.trigger('click')
    expect(ctx.open).not.toHaveBeenCalled()
  })

  it('marks the tag as decoration so the step reads as its label', async () => {
    const { wrapper } = await mountReading({ line: 'x.', next: { label: 'Open', widget: 'prompts' } })
    expect(wrapper.find('.bd-reading-tag').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('.bd-reading-tag').text()).toBe('Next')
  })
})

describe('the frames draw the reading only with the numbers', () => {
  const reading = { line: 'AI names you in 38% of answers.' }
  const global = { provide: { [BOARD_CONTEXT]: board() } }

  it('CardShell: with content, not while loading, failed or empty', () => {
    const ready = mount(CardShell, { props: { widget: 'summary', phase: 'ready', reading }, slots: { default: '<p class="body">numbers</p>' }, global })
    expect(ready.find('[data-testid="card-reading"]').exists()).toBe(true)
    expect(ready.html().indexOf('bd-reading')).toBeLessThan(ready.html().indexOf('class="body"'))
    for (const props of [
      { phase: 'loading' },
      { phase: 'failed', failure: { kind: 'error' } },
      { phase: 'ready', empty: { title: 'Nothing yet' } },
    ]) {
      const wrapper = mount(CardShell, { props: { widget: 'summary', reading, ...props }, slots: { default: '<p>numbers</p>' }, global })
      expect(wrapper.find('[data-testid="card-reading"]').exists(), JSON.stringify(props)).toBe(false)
    }
  })

  it('CardFrame: with data, not while loading, failed or empty', () => {
    const ready = mount(CardFrame, { props: { widget: 'sentiment', data: { a: 1 }, reading }, slots: { default: '<p class="body">numbers</p>' }, global })
    expect(ready.find('[data-testid="card-reading"]').exists()).toBe(true)
    expect(ready.html().indexOf('bd-reading')).toBeLessThan(ready.html().indexOf('class="body"'))
    for (const props of [{}, { error: 'failed' }, { data: { a: 1 }, empty: { title: 'Nothing yet' } }]) {
      const wrapper = mount(CardFrame, { props: { widget: 'sentiment', reading, ...props }, slots: { default: '<p>numbers</p>' }, global })
      expect(wrapper.find('[data-testid="card-reading"]').exists(), JSON.stringify(props)).toBe(false)
    }
  })

  it('BlockFrame: with data, not while loading, failed or empty', () => {
    const ready = mount(BlockFrame, { props: { widget: 'watch', data: { a: 1 }, reading }, slots: { default: '<p class="body">numbers</p>' }, global })
    expect(ready.find('[data-testid="card-reading"]').exists()).toBe(true)
    expect(ready.html().indexOf('bd-reading')).toBeLessThan(ready.html().indexOf('class="body"'))
    for (const props of [{}, { error: 'failed' }, { data: { a: 1 }, empty: { title: 'Nothing yet' } }]) {
      const wrapper = mount(BlockFrame, { props: { widget: 'watch', reading, ...props }, slots: { default: '<p>numbers</p>' }, global })
      expect(wrapper.find('[data-testid="card-reading"]').exists(), JSON.stringify(props)).toBe(false)
    }
  })

  it('a frame without a reading is unchanged', () => {
    const wrapper = mount(CardFrame, { props: { widget: 'sentiment', data: { a: 1 } }, slots: { default: '<p>numbers</p>' }, global })
    expect(wrapper.find('[data-testid="card-reading"]').exists()).toBe(false)
  })
})
