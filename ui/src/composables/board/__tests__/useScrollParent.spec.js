import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useScrollParent } from '../useScrollParent'

// jsdom has no layout: an element's clientHeight is its data-height here,
// and the observer is called by hand.
let observers = []
const RealResizeObserver = window.ResizeObserver
const mounted = []

function mountIn(wrap) {
  let found
  const Probe = defineComponent({
    setup() {
      const el = ref(null)
      found = useScrollParent(el)
      return () => h('div', { ref: el, class: 'probe' })
    },
  })
  const wrapper = mount(defineComponent({ setup: () => () => wrap(h(Probe)) }), { attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, found }
}

beforeEach(() => {
  observers = []
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return Number(this.dataset?.height) || 0
    },
  })
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      this.disconnected = false
      observers.push(this)
    }
    observe(target) {
      this.targets.push(target)
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true
    }
  }
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  delete HTMLElement.prototype.clientHeight
  delete document.scrollingElement
  window.ResizeObserver = RealResizeObserver
  document.body.innerHTML = ''
})

describe('useScrollParent', () => {
  it('finds the nearest ancestor that scrolls, past ones that do not', () => {
    const { wrapper, found } = mountIn((probe) =>
      h('main', { style: 'overflow-y: auto' }, [
        h('section', { class: 'inner', style: 'overflow-y: scroll' }, [
          h('div', { style: 'overflow-y: hidden' }, [h('div', { style: 'overflow-y: visible' }, [probe])]),
        ]),
      ]),
    )
    expect(found.el.value).toBe(wrapper.find('section.inner').element)

    const outer = mountIn((probe) => h('main', { class: 'outer', style: 'overflow-y: auto' }, [h('div', [probe])]))
    expect(outer.found.el.value).toBe(outer.wrapper.find('main.outer').element)
  })

  it('falls back to the document scroller', () => {
    Object.defineProperty(document, 'scrollingElement', { configurable: true, get: () => document.documentElement })
    const { found } = mountIn((probe) => h('div', [probe]))
    expect(found.el.value).toBe(document.scrollingElement)
  })

  it("reports the ancestor's height and follows it through the observer, until unmounted", async () => {
    const { wrapper, found } = mountIn((probe) => h('main', { 'data-height': '640', style: 'overflow-y: auto' }, [probe]))
    const main = wrapper.find('main').element
    expect(found.height.value).toBe(640)
    expect(observers).toHaveLength(1)
    expect(observers[0].targets).toEqual([main])

    main.dataset.height = '720'
    observers[0].callback([])
    await nextTick()
    expect(found.height.value).toBe(720)

    mounted.pop().unmount()
    expect(observers[0].disconnected).toBe(true)
  })
})
