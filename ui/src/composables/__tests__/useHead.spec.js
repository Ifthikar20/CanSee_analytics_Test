import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useHead } from '../useHead.js'

const DEFAULT_TITLE = 'Cansee — Brand Intelligence'
const DEFAULT_DESC = 'Default description.'

function resetHead() {
    document.head.innerHTML = `<title>${DEFAULT_TITLE}</title><meta name="description" content="${DEFAULT_DESC}">`
}

const spec = (title) => ({
    title,
    description: `${title} description`,
    canonical: `https://cansee.ai/blog/${title.toLowerCase()}`,
    meta: [{ property: 'og:title', content: title }],
    jsonLd: [{ '@type': 'BlogPosting', headline: title }],
})

function mountWith(source) {
    const Page = defineComponent({
        setup() {
            useHead(source)
            return () => h('div')
        },
    })
    return mount(Page)
}

const canonical = () => [...document.head.querySelectorAll('link[rel="canonical"]')].map((l) => l.getAttribute('href'))
const description = () => document.head.querySelector('meta[name="description"]').getAttribute('content')

beforeEach(resetHead)
afterEach(resetHead)

describe('useHead', () => {
    it('applies the spec on setup', () => {
        const wrapper = mountWith(spec('First'))
        expect(document.title).toBe('First')
        expect(description()).toBe('First description')
        expect(canonical()).toEqual(['https://cansee.ai/blog/first'])
        expect(document.head.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1)
        wrapper.unmount()
    })

    it('follows a reactive source without piling up tags', async () => {
        const source = ref(spec('First'))
        const wrapper = mountWith(source)
        source.value = spec('Second')
        await nextTick()
        expect(document.title).toBe('Second')
        expect(canonical()).toEqual(['https://cansee.ai/blog/second'])
        expect(document.head.querySelectorAll('[data-head]')).toHaveLength(3)
        wrapper.unmount()
    })

    it('accepts a getter', async () => {
        const name = ref('Getter')
        const wrapper = mountWith(() => spec(name.value))
        expect(document.title).toBe('Getter')
        name.value = 'Changed'
        await nextTick()
        expect(document.title).toBe('Changed')
        wrapper.unmount()
    })

    it('puts the index.html head back on unmount', () => {
        const wrapper = mountWith(spec('First'))
        wrapper.unmount()
        expect(document.title).toBe(DEFAULT_TITLE)
        expect(description()).toBe(DEFAULT_DESC)
        expect(document.head.querySelectorAll('[data-head]')).toHaveLength(0)
    })

    it('leaves the head alone for a null spec', () => {
        const wrapper = mountWith(() => null)
        expect(document.title).toBe(DEFAULT_TITLE)
        wrapper.unmount()
        expect(document.title).toBe(DEFAULT_TITLE)
    })
})
