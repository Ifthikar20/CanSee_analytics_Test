// Where the Watch block's eye looks: toward a mouse or pen, straight ahead
// for touch, for the keyboard, when the pointer leaves, and always under
// reduced motion.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { fakeSource, mountCard, nextFrame } from './__fixtures__/harness'
import { overviewPayload } from './__fixtures__/payloads'
import WatchEye from '../WatchEye.vue'
import WatchPreview from '../WatchPreview.vue'
import { useGaze } from '../useGaze'

const sources = vi.hoisted(() => ({}))
vi.mock('@/composables/board/useBoardSource', () => ({ useBoardSource: (key) => sources[key] }))

const { default: WatchCard } = await import('../WatchCard.vue')

const mounted = []
let reduced = false

function move(x, y, pointerType) {
    const event = new MouseEvent('pointermove', { clientX: x, clientY: y })
    if (pointerType) Object.defineProperty(event, 'pointerType', { value: pointerType })
    window.dispatchEvent(event)
}

async function watchCard() {
    sources.overview = fakeSource({ data: overviewPayload() })
    const wrapper = await mountCard(WatchCard)
    mounted.push(wrapper)
    // jsdom lays nothing out: put the eye's centre at 200, 150.
    wrapper.find('.wd-watch-eye').element.getBoundingClientRect = () => ({ left: 100, top: 100, width: 200, height: 100 })
    return wrapper
}

const gazeLine = (wrapper) => wrapper.find('.wd-watch-gaze').text()
const pupil = (wrapper) => wrapper.find('.wd-eye-pupil').element.style.transform

beforeEach(() => {
    reduced = false
    window.matchMedia = vi.fn((query) => ({ matches: reduced && /reduce/.test(query), media: query, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
    delete window.matchMedia
})

describe('the Watch card follows the pointer', () => {
    it('looks straight ahead until a pointer moves', async () => {
        const wrapper = await watchCard()
        expect(gazeLine(wrapper)).toBe('Looking straight ahead')
        expect(pupil(wrapper)).toBe('translate(0px, 0px)')
    })

    it('turns the pupil toward the mouse and prints where it looks', async () => {
        const wrapper = await watchCard()
        move(290, 150)
        await nextFrame()
        expect(gazeLine(wrapper)).toBe('Looking at +0.25, +0.00')
        expect(pupil(wrapper)).toBe('translate(5px, 0px)')
        move(200, 60)
        await nextFrame()
        expect(gazeLine(wrapper)).toBe('Looking at +0.00, -0.25')
        expect(pupil(wrapper)).toBe('translate(0px, -5px)')
        // The readout is the drawing's caption, not content.
        expect(wrapper.find('.wd-watch-gaze').attributes('aria-hidden')).toBe('true')
    })

    it('follows the latest of several moves in one frame', async () => {
        const wrapper = await watchCard()
        move(290, 150)
        move(110, 150)
        await nextFrame()
        expect(gazeLine(wrapper)).toBe('Looking at -0.25, +0.00')
    })

    it('does not follow a finger', async () => {
        const wrapper = await watchCard()
        move(290, 150, 'touch')
        await nextFrame()
        expect(gazeLine(wrapper)).toBe('Looking straight ahead')
        // A touch after a mouse sends it back to the middle.
        move(290, 150, 'mouse')
        await nextFrame()
        expect(gazeLine(wrapper)).toBe('Looking at +0.25, +0.00')
        move(290, 150, 'touch')
        await nextFrame()
        expect(gazeLine(wrapper)).toBe('Looking straight ahead')
        expect(pupil(wrapper)).toBe('translate(0px, 0px)')
    })

    it('looks straight ahead again for the keyboard, when the pointer leaves and when the window loses focus', async () => {
        const wrapper = await watchCard()
        for (const leave of [
            () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })),
            () => document.documentElement.dispatchEvent(new MouseEvent('pointerleave')),
            () => window.dispatchEvent(new Event('blur')),
        ]) {
            move(290, 150)
            await nextFrame()
            expect(gazeLine(wrapper)).toBe('Looking at +0.25, +0.00')
            leave()
            await nextFrame()
            expect(gazeLine(wrapper)).toBe('Looking straight ahead')
            expect(pupil(wrapper)).toBe('translate(0px, 0px)')
        }
    })

    it('holds still for people who ask for reduced motion', async () => {
        reduced = true
        const wrapper = await watchCard()
        move(290, 150)
        await nextFrame()
        expect(gazeLine(wrapper)).toBe('Looking straight ahead')
        expect(pupil(wrapper)).toBe('translate(0px, 0px)')
    })

    it('stops listening when the card goes away', async () => {
        const added = vi.spyOn(window, 'addEventListener')
        const removed = vi.spyOn(window, 'removeEventListener')
        const wrapper = await watchCard()
        const names = (spy) => spy.mock.calls.map((call) => call[0]).filter((name) => ['pointermove', 'keydown', 'blur'].includes(name)).sort()
        expect(names(added)).toEqual(['blur', 'keydown', 'pointermove'])
        mounted.pop()
        wrapper.unmount()
        expect(names(removed)).toEqual(['blur', 'keydown', 'pointermove'])
        // A move after that changes nothing and throws nothing.
        expect(() => move(290, 150)).not.toThrow()
        added.mockRestore()
        removed.mockRestore()
    })
})

describe('useGaze without an element', () => {
    it('stays ahead when the eye is not on the page', async () => {
        let api
        const Host = defineComponent({
            setup() {
                api = useGaze(ref(null))
                return () => h('div')
            },
        })
        const wrapper = mount(Host)
        move(10, 10)
        await nextFrame()
        expect(api.look.value).toEqual({ x: 0, y: 0 })
        expect(api.following.value).toBe(false)
        wrapper.unmount()
    })
})

describe('WatchEye', () => {
    const style = (wrapper, selector) => wrapper.find(selector).element.style.transform

    it('is a drawing: hidden from screen readers, one accent, no colour of its own', () => {
        const wrapper = mount(WatchEye)
        const svg = wrapper.find('svg')
        expect(svg.attributes('aria-hidden')).toBe('true')
        expect(svg.attributes('viewBox')).toBe('0 0 440 210')
        expect(wrapper.findAll('.wd-eye-iris')).toHaveLength(1)
        expect(wrapper.findAll('.wd-eye-tick')).toHaveLength(48)
        expect(wrapper.html()).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|fill="|stroke="/i)
    })

    it('moves the pupil further than the lines around it, and keeps both inside the ring', () => {
        const wrapper = mount(WatchEye, { props: { look: { x: 1, y: -1 } } })
        expect(style(wrapper, '.wd-eye-pupil')).toBe('translate(20px, -20px)')
        expect(style(wrapper, '.wd-eye-move:not(.wd-eye-pupil)')).toBe('translate(8px, -8px)')
    })

    it('clamps a gaze that is out of range and ignores one that is not a number', () => {
        expect(style(mount(WatchEye, { props: { look: { x: 9, y: -9 } } }), '.wd-eye-pupil')).toBe('translate(20px, -20px)')
        expect(style(mount(WatchEye, { props: { look: { x: NaN, y: 'a' } } }), '.wd-eye-pupil')).toBe('translate(0px, 0px)')
        expect(style(mount(WatchEye, { props: { look: null } }), '.wd-eye-pupil')).toBe('translate(0px, 0px)')
    })
})

describe('WatchPreview', () => {
    it('is the same eye in the catalog tile, in the tile\'s 160 by 100 frame', () => {
        const wrapper = mount(WatchPreview)
        const svg = wrapper.find('svg')
        expect(svg.attributes('aria-hidden')).toBe('true')
        const [, , width, height] = svg.attributes('viewBox').split(' ').map(Number)
        expect(width / height).toBeCloseTo(160 / 100)
        expect(wrapper.findAll('.wd-eye-iris')).toHaveLength(1)
        expect(wrapper.text()).toBe('')
    })
})
