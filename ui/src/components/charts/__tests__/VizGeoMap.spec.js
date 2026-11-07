import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('@/lib/charts/geo/world', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, loadWorld: vi.fn(real.loadWorld) }
})

const { loadWorld } = await import('@/lib/charts/geo/world')
const { default: VizGeoMap } = await import('@/components/charts/VizGeoMap.vue')
const { binsFor } = await import('@/lib/charts/scales')
const { normalizeVizSpec } = await import('@/lib/charts/spec')

enableAutoUnmount(afterEach)

const spec = normalizeVizSpec({
  title: 'AI visibility by country',
  x: 'country',
  value: 'percent',
  labels: ['gb', 'de', 'us', 'li', 'xk', 'fr', 'sg'],
  label_names: { gb: 'United Kingdom', li: 'Liechtenstein' },
  state_labels: { not_found: 'Not in top 10' },
  datasets: [
    {
      key: 'ai',
      label: 'AI visibility',
      data: [85, 10, null, 30, null, null, 40],
      states: [null, null, 'not_checked', null, 'not_checked', 'not_found', null],
    },
  ],
})

async function render(props = {}, s = spec) {
  const wrapper = mount(VizGeoMap, {
    props: { spec: s, dataset: s.datasets[0], bins: binsFor(s, s.datasets[0]), title: s.title, ...props },
    attachTo: document.body,
  })
  await flushPromises()
  await vi.waitFor(() => expect(wrapper.find('svg.viz-geo-svg').exists()).toBe(true))
  return wrapper
}

const mark = (wrapper, code) => wrapper.find(`[data-code="${code}"]`)
const tabbable = (wrapper) =>
  wrapper.findAll('[data-code]').filter((el) => el.attributes('tabindex') === '0').map((el) => el.attributes('data-code'))

describe('VizGeoMap', () => {
  it('shows a block of the map size until the geometry has loaded', () => {
    const wrapper = mount(VizGeoMap, { props: { spec, dataset: spec.datasets[0], bins: binsFor(spec) } })
    expect(wrapper.find('.viz-geo-loading').exists()).toBe(true)
    expect(wrapper.find('svg').exists()).toBe(false)
  })

  it('draws every country and labels the measured ones with their name and value', async () => {
    const wrapper = await render()
    const svg = wrapper.find('svg')
    expect(svg.attributes('role')).toBe('group')
    expect(svg.attributes('aria-label')).toBe('AI visibility by country')
    expect(wrapper.findAll('path.viz-geo-country')).toHaveLength(176)
    expect(mark(wrapper, 'GB').attributes('aria-label')).toBe('United Kingdom: 85%')
    expect(mark(wrapper, 'GB').attributes('role')).toBe('button')
    expect(mark(wrapper, 'GB').classes()).toContain('is-bin')
    expect(mark(wrapper, 'GB').attributes('style')).toContain('var(--viz-seq-5)')
    expect(mark(wrapper, 'DE').attributes('aria-label')).toBe('Germany: 10%')
    // Measured, absent: a mark on the surface with a ring.
    expect(mark(wrapper, 'FR').attributes('aria-label')).toBe('France: Not in top 10')
    expect(mark(wrapper, 'FR').classes()).toContain('is-absent')
  })

  it('keeps one tab stop, on measured countries only', async () => {
    const wrapper = await render()
    expect(tabbable(wrapper)).toEqual(['GB'])
    expect(wrapper.findAll('[data-code]').map((el) => el.attributes('data-code')).sort()).toEqual(['DE', 'FR', 'GB', 'SG'])
    // Not checked, never in the spec, or not a country: hidden and unfocusable.
    const hidden = wrapper.findAll('path.viz-geo-country').filter((p) => p.attributes('aria-hidden') === 'true')
    expect(hidden).toHaveLength(176 - 3)
    expect(hidden.every((p) => p.attributes('tabindex') === undefined)).toBe(true)
  })

  it('has no tab stop when nothing was measured; the table beside it still lists every row', async () => {
    const unmeasured = normalizeVizSpec({
      title: 'Google position by country',
      x: 'country',
      value: 'rank',
      labels: ['gb', 'de'],
      datasets: [{ key: 'google', label: 'Google position', data: [null, null], states: ['not_checked', 'failed'] }],
    })
    const wrapper = await render({}, unmeasured)
    expect(wrapper.findAll('[tabindex]')).toHaveLength(0)
    expect(wrapper.findAll('path.viz-geo-country').every((p) => p.attributes('aria-hidden') === 'true')).toBe(true)
  })

  it('starts the tab stop on the selected country', async () => {
    const wrapper = await render({ selected: 'fr' })
    expect(tabbable(wrapper)).toEqual(['FR'])
    expect(wrapper.find('.viz-geo-selected').exists()).toBe(true)
  })

  it('moves with the arrow keys, Home and End', async () => {
    const wrapper = await render()
    mark(wrapper, 'GB').element.focus()
    await mark(wrapper, 'GB').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(mark(wrapper, 'FR').element)
    await nextTick()
    expect(tabbable(wrapper)).toEqual(['FR'])
    await mark(wrapper, 'FR').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(mark(wrapper, 'DE').element)
    await mark(wrapper, 'DE').trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(mark(wrapper, 'SG').element)
    await mark(wrapper, 'SG').trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(mark(wrapper, 'GB').element)
  })

  it('draws the catalog countries too small for a polygon as dots', async () => {
    const wrapper = await render()
    const sg = mark(wrapper, 'SG')
    expect(sg.element.tagName.toLowerCase()).toBe('circle')
    expect(sg.attributes('aria-label')).toBe('Singapore: 40%')
    // An unmeasured dot is not drawn.
    expect(wrapper.find('[data-code="HK"]').exists()).toBe(false)
  })

  it('shows the tooltip on focus and hides it on blur', async () => {
    const wrapper = await render()
    mark(wrapper, 'FR').element.focus()
    await nextTick()
    expect(wrapper.find('.viz-tip').text()).toBe('France · Not in top 10')
    // Moving between marks keeps one tooltip, on the newly focused one.
    mark(wrapper, 'SG').element.focus()
    await nextTick()
    expect(wrapper.findAll('.viz-tip')).toHaveLength(1)
    expect(wrapper.find('.viz-tip').text()).toBe('Singapore · 40%')
    mark(wrapper, 'SG').element.blur()
    await nextTick()
    expect(wrapper.find('.viz-tip').exists()).toBe(false)
  })

  // Chrome makes an SVG shape with a focus listener focusable, so a listener
  // on every country put all 176 of them, aria-hidden ones included, in the
  // tab order. Focus is followed from the map's frame instead.
  it('puts no focus listener on a shape, so only the marks are focusable', async () => {
    const focusTypes = new Set(['focus', 'blur', 'focusin', 'focusout'])
    const real = EventTarget.prototype.addEventListener
    const svgTargets = []
    const spy = vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (type, ...rest) {
      if (focusTypes.has(type) && this instanceof SVGElement) svgTargets.push(`${this.tagName}:${type}`)
      return real.call(this, type, ...rest)
    })
    try {
      const wrapper = await render({ selectable: true })
      expect(wrapper.findAll('path.viz-geo-country')).toHaveLength(176)
      expect(svgTargets).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('shows the tooltip on hover, unmeasured countries included, never for what is not a country', async () => {
    const wrapper = await render()
    const { shapes } = await loadWorld()
    const shapeOf = (pick) => {
      const d = shapes.find(pick).d
      return wrapper.findAll('path.viz-geo-country').find((p) => p.attributes('d') === d)
    }
    const us = shapeOf((s) => s.code === 'US')
    expect(us.attributes('aria-hidden')).toBe('true')
    await us.trigger('mouseenter', { clientX: 10, clientY: 10 })
    expect(wrapper.find('.viz-tip').text()).toBe('United States · Not checked')
    expect(wrapper.find('.viz-geo-hover').exists()).toBe(true)
    await us.trigger('mouseleave')
    expect(wrapper.find('.viz-tip').exists()).toBe(false)
    await shapeOf((s) => s.code === 'JP').trigger('mouseenter')
    expect(wrapper.find('.viz-tip').text()).toBe('Japan · No data')
    await shapeOf((s) => s.name === 'Somaliland').trigger('mouseenter')
    expect(wrapper.find('.viz-tip').text()).toBe('Japan · No data')
  })

  it('emits select only when someone listens', async () => {
    const quiet = await render()
    await mark(quiet, 'DE').trigger('click')
    await mark(quiet, 'DE').trigger('keydown', { key: 'Enter' })
    expect(quiet.emitted('select')).toBe(undefined)

    const wrapper = await render({ selectable: true })
    await mark(wrapper, 'DE').trigger('click')
    await mark(wrapper, 'FR').trigger('keydown', { key: 'Enter' })
    await mark(wrapper, 'SG').trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('select')).toEqual([
      [{ label: 'DE', labelIndex: 1, datasetKey: 'ai', value: 10, state: null }],
      [{ label: 'FR', labelIndex: 5, datasetKey: 'ai', value: null, state: 'not_found' }],
      [{ label: 'SG', labelIndex: 6, datasetKey: 'ai', value: 40, state: null }],
    ])
  })

  it('lists measured countries the map cannot draw', async () => {
    const wrapper = await render()
    expect(wrapper.find('.viz-map-also').text()).toBe('Also measured: Liechtenstein 30%')
  })

  it('names only the three largest off the map when compact', async () => {
    const counts = normalizeVizSpec({
      title: 'Requests by country',
      x: 'country',
      value: 'count',
      labels: ['us', 'mv', 'mc', 'ad', 'mu', 'je'],
      datasets: [{ key: 'value', label: 'Requests', data: [900, 12, 340, 5, 61, null] }],
    })
    const full = await render({}, counts)
    expect(full.find('.viz-map-also').text()).toBe('Also measured: Maldives 12, Monaco 340, Andorra 5, Mauritius 61')
    const compact = await render({ compact: true }, counts)
    expect(compact.find('.viz-map-also').text()).toBe('Also measured: Monaco 340, Mauritius 61, Maldives 12 and 1 more')
  })

  it('falls back to the table when the map cannot load', async () => {
    loadWorld.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mount(VizGeoMap, { props: { spec, dataset: spec.datasets[0], bins: binsFor(spec), title: spec.title } })
    await flushPromises()
    expect(wrapper.find('.viz-geo-note').text()).toBe("The map couldn't load. Showing the table.")
    expect(wrapper.find('table.viz-table').exists()).toBe(true)
    expect(wrapper.find('svg').exists()).toBe(false)
  })
})
